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
                readerFontCalls: [],
                readerFontSizeCalls: [],
                render(model) {
                    renderCalls.push({ ...model });
                },
                setReaderFontSize(size) {
                    this.readerFontSizeCalls.push(size);
                },
                setReaderFont(font) {
                    this.readerFontCalls.push(font);
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

test('persists reader font size changes across Markdown tabs and sessions', () => {
    const mainWindow = createMainWindow();
    const stored = new Map([['extensions.mktero.readerFontSize', 20]]);
    const preferenceObservers = new Map();
    const unregisteredObservers = [];
    const zoteroOverrides = {
        Prefs: {
            get: key => stored.get(key),
            set: (key, value) => {
                stored.set(key, value);
                preferenceObservers.get(key)?.(value);
            },
            registerObserver(key, observer, global) {
                assert.equal(global, true);
                preferenceObservers.set(key, observer);
                return `${key}-observer`;
            },
            unregisterObserver: observer => unregisteredObservers.push(observer),
        },
    };
    const harness = createViewHarness();
    const presenter = createPresenter(mainWindow, harness, zoteroOverrides);

    presenter.open(42);
    presenter.open(43);
    assert.equal(harness.calls[0].readerFontSize, 20);
    assert.equal(harness.calls[1].readerFontSize, 20);

    harness.calls[0].onReaderFontSizeChange(21);

    assert.equal(stored.get('extensions.mktero.readerFontSize'), 21);
    assert.deepEqual(harness.views[0].readerFontSizeCalls, [21]);
    assert.deepEqual(harness.views[1].readerFontSizeCalls, [21]);

    stored.set('extensions.mktero.readerFontSize', 22);
    preferenceObservers.get('extensions.mktero.readerFontSize')(22);
    assert.deepEqual(harness.views[0].readerFontSizeCalls, [21, 22]);
    assert.deepEqual(harness.views[1].readerFontSizeCalls, [21, 22]);

    presenter.dispose();
    assert.deepEqual(unregisteredObservers, [
        'extensions.mktero.readerFont-observer',
        'extensions.mktero.readerFontSize-observer',
    ]);
    const nextHarness = createViewHarness();
    const nextPresenter = createPresenter(
        createMainWindow(),
        nextHarness,
        zoteroOverrides
    );
    nextPresenter.open(44);

    assert.equal(nextHarness.calls[0].readerFontSize, 22);
    nextPresenter.dispose();
});

test('persists reader font changes across Markdown tabs and sessions', () => {
    const mainWindow = createMainWindow();
    const stored = new Map([['extensions.mktero.readerFont', 'cambria']]);
    const preferenceObservers = new Map();
    const unregisteredObservers = [];
    const zoteroOverrides = {
        Prefs: {
            get: key => stored.get(key),
            set: (key, value) => {
                stored.set(key, value);
                preferenceObservers.get(key)?.(value);
            },
            registerObserver(key, observer, global) {
                assert.equal(global, true);
                preferenceObservers.set(key, observer);
                return `${key}-observer`;
            },
            unregisterObserver: observer => unregisteredObservers.push(observer),
        },
    };
    const harness = createViewHarness();
    const presenter = createPresenter(mainWindow, harness, zoteroOverrides);

    presenter.open(42);
    presenter.open(43);
    assert.equal(harness.calls[0].readerFont, 'cambria');
    assert.equal(harness.calls[1].readerFont, 'cambria');

    harness.calls[0].onReaderFontChange('times-new-roman');

    assert.equal(stored.get('extensions.mktero.readerFont'), 'times-new-roman');
    assert.deepEqual(harness.views[0].readerFontCalls, ['times-new-roman']);
    assert.deepEqual(harness.views[1].readerFontCalls, ['times-new-roman']);

    stored.set('extensions.mktero.readerFont', 'system-serif');
    preferenceObservers.get('extensions.mktero.readerFont')('system-serif');
    assert.deepEqual(harness.views[0].readerFontCalls, [
        'times-new-roman',
        'system-serif',
    ]);
    assert.deepEqual(harness.views[1].readerFontCalls, [
        'times-new-roman',
        'system-serif',
    ]);

    presenter.dispose();
    assert.deepEqual(unregisteredObservers, [
        'extensions.mktero.readerFont-observer',
        'extensions.mktero.readerFontSize-observer',
    ]);
});

test('synchronizes reader typography across Zotero windows and cleans up', () => {
    const firstWindow = createMainWindow({ id: 'first-document' });
    const secondWindow = createMainWindow({ id: 'second-document' });
    let activeWindow = firstWindow;
    const preferenceObservers = new Map();
    const unregisteredObservers = [];
    const harness = createViewHarness();
    const presenter = createPresenter(firstWindow, harness, {
        getMainWindow: () => activeWindow,
        Prefs: {
            get: () => 18,
            registerObserver(key, observer) {
                preferenceObservers.set(key, observer);
                return `multi-window-${key}-observer`;
            },
            unregisterObserver: observer => unregisteredObservers.push(observer),
        },
    });

    const first = presenter.open(42);
    activeWindow = secondWindow;
    const second = presenter.open(43);

    assert.equal(harness.calls[0].document, firstWindow.document);
    assert.equal(harness.calls[1].document, secondWindow.document);
    preferenceObservers.get('extensions.mktero.readerFont')('cambria');
    assert.deepEqual(first.view.readerFontCalls, ['cambria']);
    assert.deepEqual(second.view.readerFontCalls, ['cambria']);
    preferenceObservers.get('extensions.mktero.readerFontSize')(20);
    assert.deepEqual(first.view.readerFontSizeCalls, [20]);
    assert.deepEqual(second.view.readerFontSizeCalls, [20]);

    presenter.dispose();
    assert.deepEqual(firstWindow.closed, [first.tabID]);
    assert.deepEqual(secondWindow.closed, [second.tabID]);
    assert.deepEqual(unregisteredObservers, [
        'multi-window-extensions.mktero.readerFont-observer',
        'multi-window-extensions.mktero.readerFontSize-observer',
    ]);
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

test('closes another Mktero tab for the same source PDF', () => {
    const mainWindow = createMainWindow();
    const harness = createViewHarness();
    const presenter = createPresenter(mainWindow, harness);
    const pdf = presenter.open(42, { sourceItemID: 42 });
    const savedNote = presenter.open(900, { sourceItemID: 42 });

    assert.equal(presenter.get(42), null);
    assert.equal(presenter.get(900).closed, false);
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
        onOpenAnnotationInPDF: () => calls.push('stale-open'),
        onOpenSourceInPDF: () => calls.push('stale-source'),
        onCopySourcedMarkdown: () => calls.push('stale-copy'),
    });
    const second = presenter.open(42, {
        onChangeAnnotationColor: (id, color) => calls.push({ id, color }),
        onUpdateAnnotationComment: (id, comment) => calls.push({ id, comment }),
        onDeleteAnnotation: id => calls.push({ deleted: id }),
        onOpenAnnotationInPDF: id => calls.push({ opened: id }),
        onOpenSourceInPDF: location => calls.push({ source: location }),
        onCopySourcedMarkdown: target => calls.push({ copied: target }),
    });

    await second.model.onChangeAnnotationColor('ANN00001', '#ff6666');
    await second.model.onUpdateAnnotationComment('ANN00001', 'Review this');
    await second.model.onDeleteAnnotation('ANN00001');
    await second.model.onOpenAnnotationInPDF('ANN00001');
    await second.model.onOpenSourceInPDF({
        pageIndex: 2,
        bbox: [100, 200, 900, 300],
    });
    await second.model.onCopySourcedMarkdown({
        kind: 'block',
        from: 0,
        to: 16,
    });

    assert.equal(first.model, second.model);
    assert.deepEqual(calls, [
        { id: 'ANN00001', color: '#ff6666' },
        { id: 'ANN00001', comment: 'Review this' },
        { deleted: 'ANN00001' },
        { opened: 'ANN00001' },
        {
            source: {
                pageIndex: 2,
                bbox: [100, 200, 900, 300],
            },
        },
        { copied: { kind: 'block', from: 0, to: 16 } },
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
        onRetryMarkdownAnnotationSynchronization: () => (
            calls.push('stale-retry')
        ),
    });
    const second = presenter.open(42, {
        onCreateMarkdownAnnotation: draft => calls.push({ draft }),
        onUpdateMarkdownAnnotation: (id, changes) => calls.push({ id, changes }),
        onDeleteMarkdownAnnotation: id => calls.push({ deleted: id }),
        onRetryMarkdownAnnotationSynchronization: id => (
            calls.push({ retried: id })
        ),
    });
    const draft = { text: 'Selected', ranges: [{ from: 0, to: 8 }] };

    await second.model.onCreateMarkdownAnnotation(draft);
    await second.model.onUpdateMarkdownAnnotation(
        'mktero-local-1',
        { comment: 'Review this' }
    );
    await second.model.onDeleteMarkdownAnnotation('mktero-local-1');
    await second.model.onRetryMarkdownAnnotationSynchronization(
        'mktero-local-2'
    );

    assert.equal(first.model, second.model);
    assert.deepEqual(calls, [
        { draft },
        { id: 'mktero-local-1', changes: { comment: 'Review this' } },
        { deleted: 'mktero-local-1' },
        { retried: 'mktero-local-2' },
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

test('reports a user close reason once', () => {
    const mainWindow = createMainWindow();
    const harness = createViewHarness();
    const closeReasons = [];
    const presenter = createPresenter(mainWindow, harness);
    presenter.open(42, {
        onClose: ({ reason }) => closeReasons.push(reason),
    });

    mainWindow.added[0].options.onClose();
    mainWindow.added[0].options.onClose();

    assert.equal(presenter.get(42), null);
    assert.deepEqual(closeReasons, ['user']);
});

test('classifies replacement and shutdown closes separately', () => {
    const mainWindow = createMainWindow();
    const harness = createViewHarness();
    const closeReasons = [];
    const presenter = createPresenter(mainWindow, harness);

    presenter.open(42, {
        sourceItemID: 42,
        onClose: ({ reason }) => closeReasons.push(['pdf', reason]),
    });
    presenter.open(900, {
        sourceItemID: 42,
        onClose: ({ reason }) => closeReasons.push(['note', reason]),
    });
    presenter.dispose();

    assert.deepEqual(closeReasons, [
        ['pdf', 'replacement'],
        ['note', 'shutdown'],
    ]);
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
