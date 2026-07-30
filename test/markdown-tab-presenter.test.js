import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createLocalization } from '../src/i18n/localization.js';
import { MarkdownTabPresenter } from '../src/ui/markdown-tab-presenter.js';

function createMainWindow(document = {}) {
    const added = [];
    const selected = [];
    const renamed = [];
    const closed = [];
    let nextID = 1;

    const Zotero_Tabs = {
        add(options) {
            const children = [];
            const tab = {
                id: `tab-${nextID++}`,
                options,
                children,
                container: {
                    appendChild(child) {
                        children.push(child);
                    },
                },
            };
            added.push(tab);
            return { id: tab.id, container: tab.container };
        },
        select(tabID) {
            selected.push(tabID);
        },
        rename(tabID, title) {
            renamed.push({ tabID, title });
        },
        getState() {
            return [
                { type: 'library', data: {} },
                { type: 'mktero', data: { mkteroItemID: 42 } },
                { type: 'other', data: {} },
            ];
        },
        close(tabIDs) {
            for (const tabID of Array.isArray(tabIDs) ? tabIDs : [tabIDs]) {
                closed.push(tabID);
                added.find(tab => tab.id === tabID)?.options.onClose?.();
            }
        },
    };

    return {
        document,
        Zotero_Tabs,
        added,
        selected,
        renamed,
        closed,
    };
}

function createViewHarness() {
    const views = [];
    const calls = [];
    return {
        views,
        calls,
        createView(options) {
            calls.push(options);
            const renderCalls = [];
            const root = { kind: 'inline-markdown-view' };
            const view = {
                root,
                renderCalls,
                destroyCalls: 0,
                render(model) {
                    renderCalls.push({ ...model });
                },
                destroy() {
                    this.destroyCalls++;
                },
            };
            views.push(view);
            return view;
        },
    };
}

function createPresenter(mainWindow, harness, zoteroOverrides = {}) {
    const zotero = {
        getMainWindow: () => mainWindow,
        ...zoteroOverrides,
    };
    return new MarkdownTabPresenter({
        zotero,
        rootURI: 'jar:file:///profile/extensions/mktero.xpi!/',
        createView: harness.createView.bind(harness),
    });
}

test('opens Markdown directly in a Zotero tab and reuses it for the same PDF', () => {
    const mainWindow = createMainWindow();
    const harness = createViewHarness();
    const presenter = createPresenter(mainWindow, harness);

    const first = presenter.open(42);
    const second = presenter.open(42);

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(mainWindow.added.length, 1);
    assert.equal(mainWindow.added[0].options.type, 'mktero');
    assert.equal(mainWindow.added[0].options.title, 'Converting PDF…');
    assert.equal(mainWindow.added[0].options.data.mkteroItemID, 42);
    assert.equal(mainWindow.added[0].options.data.icon, 'markdown');
    assert.equal(mainWindow.added[0].children[0], first.view.root);
    assert.equal(harness.calls[0].document, mainWindow.document);
    assert.equal(
        harness.calls[0].rootURI,
        'jar:file:///profile/extensions/mktero.xpi!/'
    );
    assert.deepEqual(mainWindow.selected, [first.tabID]);
    assert.deepEqual(mainWindow.Zotero_Tabs.getState().map(tab => tab.type), [
        'library',
        'other',
    ]);
});

test('installs the custom Markdown tab icon stylesheet in the Zotero window', () => {
    const { document } = parseHTML('<html><body></body></html>');
    const mainWindow = createMainWindow(document);
    const harness = createViewHarness();
    const presenter = createPresenter(mainWindow, harness);

    presenter.open(42);

    const style = document.querySelector('#mktero-markdown-tab-icon-style');
    assert.ok(style);
    assert.match(style.textContent, /data-item-type="markdown"/);
    assert.match(
        style.textContent,
        /jar:file:\/\/\/profile\/extensions\/mktero\.xpi!\/ui\/icons\/mktero\.svg/
    );

    presenter.dispose();
    assert.equal(document.querySelector('#mktero-markdown-tab-icon-style'), null);
});

test('renders model updates immediately without a browser load boundary or watchdog', () => {
    const mainWindow = createMainWindow();
    const harness = createViewHarness();
    const presenter = createPresenter(mainWindow, harness);
    const presentation = presenter.open(42);

    presenter.update(presentation, { status: 'loading', progress: 10 });
    presenter.update(presentation, {
        status: 'ready',
        markdown: '# Loaded without waiting',
        cacheHit: true,
    });

    assert.equal('browser' in presentation, false);
    assert.equal('loadTimeoutID' in presentation, false);
    assert.deepEqual(
        presentation.view.renderCalls.map(call => [call.status, call.progress]),
        [
            ['loading', 0],
            ['loading', 10],
            ['ready', 10],
        ]
    );
    assert.equal(
        presentation.view.renderCalls.at(-1).markdown,
        '# Loaded without waiting'
    );
});

test('does not create a Zotero tab when the inline view cannot be initialized', () => {
    const mainWindow = createMainWindow();
    const presenter = new MarkdownTabPresenter({
        zotero: { getMainWindow: () => mainWindow },
        rootURI: 'resource://mktero/',
        createView() {
            throw new Error('Shadow DOM unavailable');
        },
    });

    assert.throws(() => presenter.open(42), /Shadow DOM unavailable/);
    assert.equal(mainWindow.added.length, 0);
});

test('rolls back the Zotero tab when mounting the inline view fails', () => {
    const mainWindow = createMainWindow();
    const harness = createViewHarness();
    const originalAdd = mainWindow.Zotero_Tabs.add;
    mainWindow.Zotero_Tabs.add = options => {
        const result = originalAdd(options);
        result.container.appendChild = () => {
            throw new Error('Mount failed');
        };
        return result;
    };
    const presenter = createPresenter(mainWindow, harness);

    assert.throws(() => presenter.open(42), /Mount failed/);
    assert.equal(harness.views[0].destroyCalls, 1);
    assert.deepEqual(mainWindow.closed, ['tab-1']);
});

test('exposes and refreshes the reparse action on the tab model', async () => {
    const mainWindow = createMainWindow();
    const harness = createViewHarness();
    const calls = [];
    const presenter = createPresenter(mainWindow, harness);
    const first = presenter.open(42, {
        onReparse: () => calls.push('first'),
    });
    const second = presenter.open(42, {
        onReparse: () => calls.push('second'),
    });

    await second.model.onReparse();

    assert.equal(first.model, second.model);
    assert.deepEqual(calls, ['second']);
    assert.equal(second.model.cacheHit, false);
    assert.equal(second.model.cacheKey, null);
});

test('exposes and refreshes PDF annotation actions on the tab model', async () => {
    const mainWindow = createMainWindow();
    const harness = createViewHarness();
    const calls = [];
    const presenter = createPresenter(mainWindow, harness);
    const first = presenter.open(42, {
        onChangeAnnotationColor: () => calls.push('stale-color'),
        onUpdateAnnotationComment: () => calls.push('stale-comment'),
        onDeleteAnnotation: () => calls.push('stale-delete'),
    });
    const second = presenter.open(42, {
        onChangeAnnotationColor: (id, color) => calls.push({ id, color }),
        onUpdateAnnotationComment: (id, comment) => calls.push({ id, comment }),
        onDeleteAnnotation: id => calls.push({ deleted: id }),
    });

    await second.model.onChangeAnnotationColor('ANN00001', '#ff6666');
    await second.model.onUpdateAnnotationComment('ANN00001', 'Review this');
    await second.model.onDeleteAnnotation('ANN00001');

    assert.equal(first.model, second.model);
    assert.deepEqual(calls, [
        { id: 'ANN00001', color: '#ff6666' },
        { id: 'ANN00001', comment: 'Review this' },
        { deleted: 'ANN00001' },
    ]);
});

test('exposes and refreshes local Markdown annotation actions', async () => {
    const mainWindow = createMainWindow();
    const harness = createViewHarness();
    const calls = [];
    const presenter = createPresenter(mainWindow, harness);
    const first = presenter.open(42, {
        onCreateMarkdownAnnotation: () => calls.push('stale-create'),
        onUpdateMarkdownAnnotation: () => calls.push('stale-update'),
        onDeleteMarkdownAnnotation: () => calls.push('stale-delete'),
    });
    const second = presenter.open(42, {
        onCreateMarkdownAnnotation: draft => calls.push({ draft }),
        onUpdateMarkdownAnnotation: (id, changes) => calls.push({ id, changes }),
        onDeleteMarkdownAnnotation: id => calls.push({ deleted: id }),
    });
    const draft = { text: 'Selected', ranges: [{ from: 0, to: 8 }] };

    await second.model.onCreateMarkdownAnnotation(draft);
    await second.model.onUpdateMarkdownAnnotation(
        'mktero-local-1',
        { comment: 'Review this' }
    );
    await second.model.onDeleteMarkdownAnnotation('mktero-local-1');

    assert.equal(first.model, second.model);
    assert.deepEqual(calls, [
        { draft },
        { id: 'mktero-local-1', changes: { comment: 'Review this' } },
        { deleted: 'mktero-local-1' },
    ]);
});

test('removes stale Mktero tabs before Zotero restores the previous session', () => {
    const mainWindow = createMainWindow();
    const harness = createViewHarness();
    const state = {
        windows: [{
            type: 'pane',
            tabs: [
                { type: 'library', data: {} },
                { type: 'mktero', data: { mkteroItemID: 42 } },
                { type: 'reader', data: { itemID: 42 } },
            ],
        }],
    };

    createPresenter(mainWindow, harness, { Session: { state } });

    assert.deepEqual(state.windows[0].tabs.map(tab => tab.type), ['library', 'reader']);
});

test('updates, destroys, and closes the owned Markdown tab', () => {
    const mainWindow = createMainWindow();
    const harness = createViewHarness();
    let closeCalls = 0;
    const presenter = createPresenter(mainWindow, harness);
    const presentation = presenter.open(42, {
        onClose: () => closeCalls++,
    });

    presenter.update(presentation, {
        title: 'Example Paper',
        status: 'ready',
        markdown: '# Example Paper',
    });
    presenter.closeAll();

    assert.equal(presentation.model.status, 'ready');
    assert.equal(presentation.model.markdown, '# Example Paper');
    assert.deepEqual(mainWindow.renamed, [{
        tabID: presentation.tabID,
        title: 'Example Paper',
    }]);
    assert.equal(presentation.view.destroyCalls, 1);
    assert.equal(closeCalls, 1);
    assert.deepEqual(mainWindow.closed, [presentation.tabID]);
});

test('ignores conversion updates after the Markdown tab is closed', () => {
    const mainWindow = createMainWindow();
    const harness = createViewHarness();
    const presenter = createPresenter(mainWindow, harness);
    const presentation = presenter.open(42);

    mainWindow.added[0].options.onClose();
    presenter.update(presentation, {
        title: 'Late Result',
        status: 'ready',
        markdown: '# Late Result',
    });

    assert.equal(presentation.model.status, 'loading');
    assert.equal(presentation.model.markdown, '');
    assert.deepEqual(mainWindow.renamed, []);
    assert.equal(presentation.view.renderCalls.length, 1);
});

test('localizes new loading tabs from the Zotero locale', () => {
    const mainWindow = createMainWindow();
    const harness = createViewHarness();
    const localization = createLocalization({ zoteroLocale: 'zh-CN' });
    const presenter = new MarkdownTabPresenter({
        zotero: { getMainWindow: () => mainWindow },
        rootURI: 'resource://mktero/',
        createView: harness.createView.bind(harness),
        localization,
    });

    const presentation = presenter.open(42);
    assert.equal(mainWindow.added[0].options.title, '正在转换 PDF…');
    assert.equal(harness.calls[0].localization, localization);

    assert.equal(presentation.view.renderCalls.length, 1);
});
