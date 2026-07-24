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
                style: {},
                events,
                listeners,
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
                },
                addEventListener(type, listener) {
                    listeners.set(type, listener);
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
    const presenter = new MarkdownTabPresenter({
        zotero: { getMainWindow: () => mainWindow },
        rootURI: 'resource://mktero/',
    });

    const first = presenter.open(42);
    const second = presenter.open(42);

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(mainWindow.added.length, 1);
    assert.equal(mainWindow.added[0].options.type, 'mktero');
    assert.equal(mainWindow.added[0].options.data.mkteroItemID, 42);
    assert.equal(mainWindow.added[0].children[0].tagName, 'browser');
    assert.equal(
        mainWindow.added[0].children[0].attributes.src,
        'resource://mktero/ui/markdown.xhtml'
    );
    assert.deepEqual(mainWindow.selected, [first.tabID]);
    assert.deepEqual(mainWindow.Zotero_Tabs.getState().map(tab => tab.type), ['library', 'other']);
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
