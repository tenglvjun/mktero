import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

test('uses the Zotero window AbortController when the plugin sandbox has none', async t => {
    const NativeAbortController = globalThis.AbortController;
    const previousGlobals = {
        Zotero: globalThis.Zotero,
        IOUtils: globalThis.IOUtils,
        PathUtils: globalThis.PathUtils,
        startup: globalThis.startup,
        shutdown: globalThis.shutdown,
    };
    const alerts = [];
    const debugLogs = [];
    let toolbarHandler;
    let openedPreferences = null;
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
                    openedPreferences = id;
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
    };
    globalThis.PathUtils = {
        join: path.join,
        parent: path.dirname,
        filename: path.basename,
    };
    delete globalThis.AbortController;

    t.after(() => {
        globalThis.shutdown?.();
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
    for (let index = 0; index < 5; index++) {
        await new Promise(resolve => setImmediate(resolve));
    }

    assert.deepEqual(alerts, []);
    assert.equal(openedPreferences, 'mktero-preferences');
    assert.ok(debugLogs.some(message => message.includes('conversion started for item 42')));
    assert.ok(debugLogs.some(message => message.includes('conversion failed for item 42')));
});

function createMainWindow(AbortController, alerts) {
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
        document: {
            createXULElement() {
                return {
                    children: [],
                    style: {},
                    setAttribute() {},
                    addEventListener() {},
                    appendChild(child) {
                        this.children.push(child);
                    },
                    contentWindow: null,
                };
            },
        },
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
                setAttribute() {},
                addEventListener(type, handler) {
                    if (type === 'click') click = handler;
                },
                click() {
                    click?.();
                },
            };
        },
    };
}
