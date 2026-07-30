import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

test('uses the Zotero window AbortController when the plugin sandbox has none', {
    timeout: 5_000,
}, async t => {
    const NativeAbortController = globalThis.AbortController;
    const previousGlobals = {
        Zotero: globalThis.Zotero,
        IOUtils: globalThis.IOUtils,
        PathUtils: globalThis.PathUtils,
        startup: globalThis.startup,
        shutdown: globalThis.shutdown,
        __MKTERO_MARKDOWN_STYLES__: globalThis.__MKTERO_MARKDOWN_STYLES__,
    };
    const alerts = [];
    const debugLogs = [];
    let toolbarHandler;
    let resolveOpenedPreferences;
    const openedPreferences = new Promise(resolve => {
        resolveOpenedPreferences = resolve;
    });
    const mainWindow = createMainWindow(NativeAbortController, alerts);
    globalThis.Zotero = {
        version: '9.0.6',
        uiReadyPromise: Promise.resolve(),
        Profile: { dir: '/tmp/mktero-test-profile' },
        Session: { state: { windows: [] } },
        Prefs: {
            get(key) {
                if (key === 'extensions.mktero.cacheEnabled') return false;
                return '';
            },
        },
        Items: {
            getAsync: async () => ({
                id: 42,
                attachmentFilename: 'paper.pdf',
                parentItem: null,
                isPDFAttachment: () => true,
                getDisplayTitle: () => 'Paper',
                getFilePathAsync: async () => '/tmp/paper.pdf',
            }),
        },
        PreferencePanes: {
            register: async options => options.id,
            unregister() {},
        },
        Utilities: {
            Internal: {
                openPreferences(id) {
                    resolveOpenedPreferences(id);
                },
            },
        },
        Reader: {
            registerEventListener(_type, handler) {
                toolbarHandler = handler;
            },
        },
        getMainWindow: () => mainWindow,
        debug(message) {
            debugLogs.push(message);
        },
        logError() {},
    };
    globalThis.IOUtils = {
        exists: async () => false,
        read: async () => new Uint8Array([1]),
        stat: async () => ({ size: 0 }),
    };
    globalThis.PathUtils = {
        join: path.join,
        parent: path.dirname,
        filename: path.basename,
    };
    globalThis.__MKTERO_MARKDOWN_STYLES__ = readFileSync(
        new URL('../ui/markdown.css', import.meta.url),
        'utf8'
    );
    delete globalThis.AbortController;

    t.after(() => {
        globalThis.shutdown?.();
        mainWindow.document.defaultView.close();
        globalThis.AbortController = NativeAbortController;
        for (const [name, value] of Object.entries(previousGlobals)) {
            if (value === undefined) delete globalThis[name];
            else globalThis[name] = value;
        }
    });

    await import('../src/bootstrap.js?abort-controller-regression');
    await globalThis.startup({
        id: 'mktero@tenglvjun.github.io',
        rootURI: 'resource://mktero/',
    });
    const appended = [];
    toolbarHandler({
        reader: { type: 'pdf', itemID: 42 },
        doc: createToolbarDocument(),
        append: button => appended.push(button),
    });

    appended[0].click();

    assert.deepEqual(alerts, []);
    assert.equal(await openedPreferences, 'mktero-preferences');
    assert.ok(debugLogs.some(message => message.includes('conversion started for item 42')));
    assert.ok(debugLogs.some(message => message.includes('conversion failed for item 42')));
});

function createMainWindow(AbortController, alerts) {
    const { document } = new JSDOM(
        '<!doctype html><html><body></body></html>',
        { pretendToBeVisual: true }
    ).window;
    const tabs = new Map();
    let nextTabID = 1;
    const Zotero_Tabs = {
        add(options) {
            const id = `tab-${nextTabID++}`;
            tabs.set(id, options);
            return {
                id,
                container: { appendChild() {} },
            };
        },
        select() {},
        rename() {},
        getState: () => [],
        close(tabID) {
            tabs.get(tabID)?.onClose?.();
            tabs.delete(tabID);
        },
    };
    return {
        AbortController,
        Zotero_Tabs,
        document,
        alert(message) {
            alerts.push(message);
        },
    };
}

function createToolbarDocument() {
    return {
        createElement() {
            let click;
            return {
                dataset: {},
                children: [],
                setAttribute() {},
                appendChild(child) {
                    this.children.push(child);
                    return child;
                },
                addEventListener(type, handler) {
                    if (type === 'click') click = handler;
                },
                click() {
                    click?.();
                },
            };
        },
        createElementNS(_namespace, tagName) {
            return this.createElement(tagName);
        },
    };
}
