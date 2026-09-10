import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createLocalization } from '../src/i18n/localization.js';
import {
    TranslationRequestTracker,
} from '../src/ai/translation-request-tracker.js';
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
                readerLineHeightCalls: [],
                readerWidthCalls: [],
                readerAlignmentCalls: [],
                readerSourcePeekCalls: [],
                render(model) {
                    renderCalls.push({ ...model });
                },
                setReaderFontSize(size) {
                    this.readerFontSizeCalls.push(size);
                },
                setReaderFont(font) {
                    this.readerFontCalls.push(font);
                },
                setReaderLineHeight(value) {
                    this.readerLineHeightCalls.push(value);
                },
                setReaderWidth(value) {
                    this.readerWidthCalls.push(value);
                },
                setReaderAlignment(value) {
                    this.readerAlignmentCalls.push(value);
                },
                setReaderSourcePeek(enabled) {
                    this.readerSourcePeekCalls.push(enabled);
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

test('passes the citation graph action to the Markdown reader model', () => {
    const mainWindow = createMainWindow();
    const harness = createViewHarness();
    const presenter = createPresenter(mainWindow, harness);
    const onOpenCitationGraph = () => {};

    const presentation = presenter.open(42, { onOpenCitationGraph });

    assert.equal(presentation.model.onOpenCitationGraph, onOpenCitationGraph);
    presenter.dispose();
});

test('passes the Markdown export action to new and reused reader models', () => {
    const mainWindow = createMainWindow();
    const harness = createViewHarness();
    const presenter = createPresenter(mainWindow, harness);
    const firstExport = () => ({ status: 'exported' });
    const presentation = presenter.open(42, {
        onExportMarkdown: firstExport,
    });

    assert.equal(presentation.model.onExportMarkdown, firstExport);

    const secondExport = () => ({ status: 'cancelled' });
    presenter.open(42, { onExportMarkdown: secondExport });
    assert.equal(presentation.model.onExportMarkdown, secondExport);
    presenter.dispose();
});

test('passes reference library actions to the Markdown reader model and refreshes reuse', () => {
    const mainWindow = createMainWindow();
    const harness = createViewHarness();
    const presenter = createPresenter(mainWindow, harness);
    const firstLibraries = () => [];
    const firstStatus = () => ({ state: 'unknown' });
    const firstSearch = () => ({ status: 'unresolved' });
    const firstImport = () => null;
    const firstOpen = () => null;
    const presentation = presenter.open(42, {
        onListReferenceLibraries: firstLibraries,
        onGetReferenceStatus: firstStatus,
        onSearchReferenceMetadata: firstSearch,
        onImportReference: firstImport,
        onOpenReferenceMatch: firstOpen,
    });
    assert.equal(presentation.model.onListReferenceLibraries, firstLibraries);
    assert.equal(presentation.model.onGetReferenceStatus, firstStatus);
    assert.equal(presentation.model.onSearchReferenceMetadata, firstSearch);
    assert.equal(presentation.model.onImportReference, firstImport);
    assert.equal(presentation.model.onOpenReferenceMatch, firstOpen);

    const secondStatus = () => ({ state: 'present' });
    presenter.open(42, { onGetReferenceStatus: secondStatus });
    assert.equal(presentation.model.onGetReferenceStatus, secondStatus);
    presenter.dispose();
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
        'extensions.mktero.readerLineHeight-observer',
        'extensions.mktero.readerWidth-observer',
        'extensions.mktero.readerAlignment-observer',
        'extensions.mktero.readerSourcePeek-observer',
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
    harness.calls[0].onReaderLineHeightChange('loose');
    harness.calls[0].onReaderWidthChange('narrow');
    harness.calls[0].onReaderAlignmentChange('justify');

    assert.equal(stored.get('extensions.mktero.readerFont'), 'times-new-roman');
    assert.equal(stored.get('extensions.mktero.readerLineHeight'), 'loose');
    assert.equal(stored.get('extensions.mktero.readerWidth'), 'narrow');
    assert.equal(stored.get('extensions.mktero.readerAlignment'), 'justify');
    assert.deepEqual(harness.views[0].readerFontCalls, ['times-new-roman']);
    assert.deepEqual(harness.views[1].readerFontCalls, ['times-new-roman']);
    assert.deepEqual(harness.views[0].readerLineHeightCalls, ['loose']);
    assert.deepEqual(harness.views[1].readerLineHeightCalls, ['loose']);
    assert.deepEqual(harness.views[0].readerWidthCalls, ['narrow']);
    assert.deepEqual(harness.views[1].readerWidthCalls, ['narrow']);
    assert.deepEqual(harness.views[0].readerAlignmentCalls, ['justify']);
    assert.deepEqual(harness.views[1].readerAlignmentCalls, ['justify']);

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
        'extensions.mktero.readerLineHeight-observer',
        'extensions.mktero.readerWidth-observer',
        'extensions.mktero.readerAlignment-observer',
        'extensions.mktero.readerSourcePeek-observer',
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
    preferenceObservers.get('extensions.mktero.readerSourcePeek')(false);
    assert.deepEqual(first.view.readerSourcePeekCalls, [false]);
    assert.deepEqual(second.view.readerSourcePeekCalls, [false]);
    preferenceObservers.get('extensions.mktero.readerLineHeight')('loose');
    assert.deepEqual(first.view.readerLineHeightCalls, ['loose']);
    assert.deepEqual(second.view.readerLineHeightCalls, ['loose']);
    preferenceObservers.get('extensions.mktero.readerWidth')('wide');
    assert.deepEqual(first.view.readerWidthCalls, ['wide']);
    assert.deepEqual(second.view.readerWidthCalls, ['wide']);
    preferenceObservers.get('extensions.mktero.readerAlignment')('justify');
    assert.deepEqual(first.view.readerAlignmentCalls, ['justify']);
    assert.deepEqual(second.view.readerAlignmentCalls, ['justify']);

    presenter.dispose();
    assert.deepEqual(firstWindow.closed, [first.tabID]);
    assert.deepEqual(secondWindow.closed, [second.tabID]);
    assert.deepEqual(unregisteredObservers, [
        'multi-window-extensions.mktero.readerFont-observer',
        'multi-window-extensions.mktero.readerFontSize-observer',
        'multi-window-extensions.mktero.readerLineHeight-observer',
        'multi-window-extensions.mktero.readerWidth-observer',
        'multi-window-extensions.mktero.readerAlignment-observer',
        'multi-window-extensions.mktero.readerSourcePeek-observer',
    ]);
});

test('keeps code-copy callbacks isolated across windows and closes them', () => {
    const firstWindow = createMainWindow({ id: 'first-document' });
    const secondWindow = createMainWindow({ id: 'second-document' });
    let activeWindow = firstWindow;
    const copied = { first: [], second: [] };
    const harness = createViewHarness();
    const presenter = createPresenter(firstWindow, harness, {
        getMainWindow: () => activeWindow,
    });

    const first = presenter.open(42, {
        onCopyCode: code => copied.first.push(code),
    });
    activeWindow = secondWindow;
    const second = presenter.open(43, {
        onCopyCode: code => copied.second.push(code),
    });

    first.model.onCopyCode('const firstWindow = true;\n');
    second.model.onCopyCode('const secondWindow = true;\n');
    assert.deepEqual(copied, {
        first: ['const firstWindow = true;\n'],
        second: ['const secondWindow = true;\n'],
    });

    presenter.dispose();
    assert.equal(presenter.get(42), null);
    assert.equal(presenter.get(43), null);
    assert.equal(first.view.destroyCalls, 1);
    assert.equal(second.view.destroyCalls, 1);
    assert.deepEqual(firstWindow.closed, [first.tabID]);
    assert.deepEqual(secondWindow.closed, [second.tabID]);
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

test('exposes and refreshes document translation actions on the tab model', async () => {
    const mainWindow = createMainWindow();
    const harness = createViewHarness();
    const calls = [];
    const presenter = createPresenter(mainWindow, harness);
    const first = presenter.open(42, {
        onTranslateDocument: options => calls.push([
            'translate-first',
            options,
        ]),
        onCancelDocumentTranslation: () => calls.push(['cancel-first']),
        onSetTranslationView: view => calls.push(['view-first', view]),
        onSelectTranslationLanguage: language => calls.push([
            'language-first',
            language,
        ]),
    });
    const second = presenter.open(42, {
        onTranslateDocument: options => calls.push([
            'translate-second',
            options,
        ]),
        onCancelDocumentTranslation: () => calls.push(['cancel-second']),
        onSetTranslationView: view => calls.push(['view-second', view]),
        onSelectTranslationLanguage: language => calls.push([
            'language-second',
            language,
        ]),
    });

    second.model.onTranslateDocument({ forceRetranslate: true });
    second.model.onCancelDocumentTranslation();
    second.model.onSetTranslationView('compare');
    second.model.onSelectTranslationLanguage('ja-JP');

    assert.equal(first.model, second.model);
    assert.equal(second.model.translationView, 'original');
    assert.equal(second.model.translationStatus, 'none');
    assert.deepEqual(calls, [
        ['translate-second', { forceRetranslate: true }],
        ['cancel-second'],
        ['view-second', 'compare'],
        ['language-second', 'ja-JP'],
    ]);
});

test('exposes and refreshes selection translation actions on the tab model', async () => {
    const mainWindow = createMainWindow();
    const harness = createViewHarness();
    const calls = [];
    const presenter = createPresenter(mainWindow, harness);
    const first = presenter.open(42, {
        onTranslateSelection: request => calls.push(['translate-first', request]),
        onCancelSelectionTranslation: () => calls.push(['cancel-first']),
        shouldAutoTranslateSelection: () => false,
        onCopySelectionTranslation: text => calls.push(['copy-first', text]),
    });
    const second = presenter.open(42, {
        onTranslateSelection: request => calls.push(['translate-second', request]),
        onCancelSelectionTranslation: () => calls.push(['cancel-second']),
        shouldAutoTranslateSelection: () => true,
        onCopySelectionTranslation: text => calls.push(['copy-second', text]),
    });

    await second.model.onTranslateSelection({
        text: 'Selected text.',
        context: 'Surrounding text.',
    });
    second.model.onCancelSelectionTranslation();
    assert.equal(second.model.shouldAutoTranslateSelection(), true);
    await second.model.onCopySelectionTranslation('已翻译文本');

    assert.equal(first.model, second.model);
    assert.deepEqual(calls, [
        ['translate-second', {
            text: 'Selected text.',
            context: 'Surrounding text.',
        }],
        ['cancel-second'],
        ['copy-second', '已翻译文本'],
    ]);
    presenter.dispose();
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
        onRenderSourcePeek: () => calls.push('stale-peek'),
        onCopySourcedMarkdown: () => calls.push('stale-copy'),
    });
    const second = presenter.open(42, {
        onChangeAnnotationColor: (id, color) => calls.push({ id, color }),
        onUpdateAnnotationComment: (id, comment) => calls.push({ id, comment }),
        onDeleteAnnotation: id => calls.push({ deleted: id }),
        onOpenAnnotationInPDF: id => calls.push({ opened: id }),
        onOpenSourceInPDF: location => calls.push({ source: location }),
        onRenderSourcePeek: location => calls.push({ peek: location }),
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
    await second.model.onRenderSourcePeek({
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
        {
            peek: {
                pageIndex: 2,
                bbox: [100, 200, 900, 300],
            },
        },
        { copied: { kind: 'block', from: 0, to: 16 } },
    ]);
});

test('exposes and refreshes code copy actions on the tab model', async () => {
    const mainWindow = createMainWindow();
    const harness = createViewHarness();
    const calls = [];
    const presenter = createPresenter(mainWindow, harness);
    const first = presenter.open(42, {
        onCopyCode: () => calls.push('stale-copy'),
    });
    const second = presenter.open(42, {
        onCopyCode: code => calls.push(code),
    });

    await second.model.onCopyCode('const answer = 42;\n');

    assert.equal(first.model, second.model);
    assert.deepEqual(calls, ['const answer = 42;\n']);
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

test('cancels only the owned translation requests on close and all on dispose', async () => {
    const mainWindow = createMainWindow();
    const harness = createViewHarness();
    const presenter = createPresenter(mainWindow, harness);
    const tracker = new TranslationRequestTracker({
        createAbortController: () => new AbortController(),
    });
    const operations = [];
    const start = documentID => {
        let finish;
        const operation = {};
        operation.promise = tracker.run(documentID, 'paragraph-1', signal => {
            operation.signal = signal;
            return new Promise(resolve => { finish = resolve; });
        });
        operation.finish = finish;
        operations.push(operation);
    };
    presenter.open(42, {
        onClose: () => tracker.cancelDocument(42),
    });
    presenter.open(84, {
        onClose: () => tracker.cancelDocument(84),
    });
    start(42);
    start(84);

    mainWindow.added[0].options.onClose();

    assert.equal(operations[0].signal.aborted, true);
    assert.equal(operations[1].signal.aborted, false);

    presenter.dispose();

    assert.equal(operations[1].signal.aborted, true);
    for (const operation of operations) operation.finish();
    await Promise.all(operations.map(operation => operation.promise));
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
