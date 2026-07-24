import test from 'node:test';
import assert from 'node:assert/strict';
import { MarkdownTabPresenter } from '../src/ui/markdown-tab-presenter.js';

function createMainWindow() {
    const added = [];
    const selected = [];
    const renamed = [];
    const closed = [];
    let nextID = 1;

    const document = {
        createXULElement(tagName) {
            const events = [];
            const listeners = new Map();
            return {
                tagName,
                attributes: {},
                children: [],
                style: {},
                events,
                listeners,
                attached: false,
                srcSetAfterAppend: false,
                loadedURI: null,
                loadOptions: null,
                contentWindow: {
                    loaded: false,
                    CustomEvent: class CustomEvent {
                        constructor(type) {
                            this.type = type;
                        }
                    },
                    dispatchEvent(event) {
                        if (this.loaded) events.push(event.type);
                    },
                },
                setAttribute(name, value) {
                    this.attributes[name] = String(value);
                    if (name === 'src' && this.attached) {
                        this.srcSetAfterAppend = true;
                    }
                },
                addEventListener(type, listener) {
                    listeners.set(type, listener);
                },
                appendChild(child) {
                    child.attached = true;
                    this.children.push(child);
                },
                fixupAndLoadURIString() {
                    throw new Error('NS_ERROR_FAILURE [nsIWebNavigation.fixupAndLoadURIString]');
                },
                loadURI(uri, options) {
                    if (!this.attached) throw new Error('The browser must be attached before loading');
                    if (!uri?.spec) throw new TypeError('loadURI requires an nsIURI-like object');
                    this.loadedURI = uri;
                    this.loadOptions = options;
                },
                load() {
                    this.contentWindow.loaded = true;
                    listeners.get('load')?.();
                },
            };
        },
    };
    const Zotero_Tabs = {
        add(options) {
            const children = [];
            const tab = {
                id: `tab-${nextID++}`,
                options,
                children,
                container: {
                    appendChild(child) {
                        child.attached = true;
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

    return { document, Zotero_Tabs, added, selected, renamed, closed };
}

test('opens Markdown in a Zotero tab and reuses it for the same PDF', () => {
    const mainWindow = createMainWindow();
    const systemPrincipal = { kind: 'system-principal' };
    const presenter = new MarkdownTabPresenter({
        zotero: { getMainWindow: () => mainWindow },
        rootURI: 'jar:file:///profile/extensions/mktero.xpi!/',
        services: {
            io: {
                newURI: spec => ({ spec }),
            },
            scriptSecurityManager: {
                getSystemPrincipal: () => systemPrincipal,
            },
        },
    });

    const first = presenter.open(42);
    const second = presenter.open(42);

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(mainWindow.added.length, 1);
    assert.equal(mainWindow.added[0].options.type, 'mktero');
    assert.equal(mainWindow.added[0].options.title, 'Converting PDF…');
    assert.equal(mainWindow.added[0].options.data.mkteroItemID, 42);
    assert.equal(first.browser.attributes.remote, 'false');
    assert.equal(
        first.browser.loadedURI.spec,
        'jar:file:///profile/extensions/mktero.xpi!/ui/markdown.xhtml'
    );
    assert.equal(first.browser.loadOptions.triggeringPrincipal, systemPrincipal);
    assert.deepEqual(mainWindow.selected, [first.tabID]);
    assert.deepEqual(mainWindow.Zotero_Tabs.getState().map(tab => tab.type), ['library', 'other']);
});

test('shows native conversion progress until the Markdown browser loads', () => {
    const mainWindow = createMainWindow();
    const presenter = new MarkdownTabPresenter({
        zotero: { getMainWindow: () => mainWindow },
        rootURI: 'resource://mktero/',
    });

    const presentation = presenter.open(42);

    assert.equal(presentation.nativeLoading.hidden, false);
    assert.equal(
        presentation.nativeLoadingLabel.attributes.value,
        'Preparing the PDF for MinerU…'
    );

    presenter.update(presentation, { status: 'loading', progress: 5 });
    assert.equal(
        presentation.nativeLoadingLabel.attributes.value,
        'Uploading the PDF to MinerU…'
    );
    assert.equal(presentation.nativeLoadingProgress.attributes.value, '5');

    presenter.update(presentation, { status: 'loading', progress: 10 });
    assert.equal(
        presentation.nativeLoadingLabel.attributes.value,
        'PDF uploaded. MinerU is parsing the document…'
    );

    presentation.browser.load();
    assert.equal(presentation.nativeLoading.hidden, true);
});

test('exposes and refreshes the reparse action on the tab model', async () => {
    const mainWindow = createMainWindow();
    const calls = [];
    const presenter = new MarkdownTabPresenter({
        zotero: { getMainWindow: () => mainWindow },
        rootURI: 'resource://mktero/',
    });
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
});

test('removes stale Mktero tabs before Zotero restores the previous session', () => {
    const mainWindow = createMainWindow();
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

    new MarkdownTabPresenter({
        zotero: {
            getMainWindow: () => mainWindow,
            Session: { state },
        },
        rootURI: 'resource://mktero/',
    });

    assert.deepEqual(state.windows[0].tabs.map(tab => tab.type), ['library', 'reader']);
});

test('updates and closes the owned Markdown tab', () => {
    const mainWindow = createMainWindow();
    const presenter = new MarkdownTabPresenter({
        zotero: { getMainWindow: () => mainWindow },
        rootURI: 'resource://mktero/',
    });
    const presentation = presenter.open(42);
    presentation.browser.load();

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
    assert.deepEqual(presentation.browser.events, [
        'mktero:model-update',
        'mktero:model-update',
    ]);
    assert.deepEqual(mainWindow.closed, [presentation.tabID]);
});

test('delivers the latest model after the Markdown browser finishes loading', () => {
    const mainWindow = createMainWindow();
    const presenter = new MarkdownTabPresenter({
        zotero: { getMainWindow: () => mainWindow },
        rootURI: 'resource://mktero/',
    });
    const presentation = presenter.open(42);

    presenter.update(presentation, {
        status: 'ready',
        markdown: '# Loaded after conversion',
    });
    assert.deepEqual(presentation.browser.events, []);

    presentation.browser.load();

    assert.equal(presentation.browser.contentWindow.mkteroModel, presentation.model);
    assert.deepEqual(presentation.browser.events, ['mktero:model-update']);
});

test('ignores conversion updates after the Markdown tab is closed', () => {
    const mainWindow = createMainWindow();
    let closeCalls = 0;
    const presenter = new MarkdownTabPresenter({
        zotero: { getMainWindow: () => mainWindow },
        rootURI: 'resource://mktero/',
    });
    const presentation = presenter.open(42, {
        onClose: () => closeCalls++,
    });

    mainWindow.added[0].options.onClose();
    presenter.update(presentation, {
        title: 'Late Result',
        status: 'ready',
        markdown: '# Late Result',
    });

    assert.equal(presentation.model.status, 'loading');
    assert.equal(presentation.model.markdown, '');
    assert.deepEqual(mainWindow.renamed, []);
    assert.deepEqual(presentation.browser.events, []);
    assert.equal(closeCalls, 1);
});
