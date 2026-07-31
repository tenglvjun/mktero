import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { translateMessage } from '../src/i18n/localization.js';
import { registerReaderToolbar } from '../src/ui/reader-toolbar.js';

function createDocument() {
    return {
        createElement(tagName) {
            const listeners = new Map();
            return {
                tagName,
                className: '',
                textContent: '',
                title: '',
                type: '',
                dataset: {},
                attributes: {},
                children: [],
                setAttribute(name, value) {
                    this.attributes[name] = String(value);
                },
                appendChild(child) {
                    this.children.push(child);
                    return child;
                },
                addEventListener(type, handler) {
                    listeners.set(type, handler);
                },
                click() {
                    listeners.get('click')?.();
                },
            };
        },
        createElementNS(_namespace, tagName) {
            return this.createElement(tagName);
        },
    };
}

test('adds an action to PDF reader toolbars and opens that reader item', async () => {
    let registered;
    const zotero = {
        Reader: {
            registerEventListener(type, handler, pluginID) {
                registered = { type, handler, pluginID };
            },
            unregisterEventListener() {},
        },
    };
    const opened = [];
    registerReaderToolbar({
        zotero,
        pluginID: 'mktero@example.com',
        onOpen: async reader => opened.push(reader.itemID),
    });
    const appended = [];
    const reader = { type: 'pdf', itemID: 42 };

    registered.handler({
        reader,
        doc: createDocument(),
        append: element => appended.push(element),
    });
    appended[0].click();
    await Promise.resolve();

    assert.equal(registered.type, 'renderToolbar');
    assert.equal(registered.pluginID, 'mktero@example.com');
    assert.equal(appended.length, 1);
    assert.equal(appended[0].textContent, '');
    assert.equal(appended[0].children[0].tagName, 'svg');
    assert.equal(
        appended[0].children[0].attributes['data-lucide'],
        'file-text'
    );
    assert.deepEqual(opened, [42]);
});

test('synchronizes pending annotations when a PDF reader opens', async () => {
    let handler;
    const zotero = {
        Reader: {
            registerEventListener(_type, value) {
                handler = value;
            },
            unregisterEventListener() {},
        },
    };
    const ready = [];
    registerReaderToolbar({
        zotero,
        pluginID: 'mktero@example.com',
        onOpen: () => {},
        onPDFReaderAvailable: async reader => ready.push(reader.itemID),
    });
    const reader = { type: 'pdf', itemID: 42 };

    handler({
        reader,
        doc: createDocument(),
        append: () => {},
    });
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(ready, [42]);
});

test('routes deferred synchronization errors through the toolbar handler', async () => {
    let handler;
    const zotero = {
        Reader: {
            registerEventListener(_type, value) {
                handler = value;
            },
            unregisterEventListener() {},
        },
    };
    const errors = [];
    const reader = { type: 'pdf', itemID: 42 };
    registerReaderToolbar({
        zotero,
        pluginID: 'mktero@example.com',
        onOpen: () => {},
        onPDFReaderAvailable: async () => {
            throw new Error('Could not load pending annotations');
        },
        onError: (error, failedReader) => {
            errors.push({ message: error.message, failedReader });
        },
    });

    handler({
        reader,
        doc: createDocument(),
        append: () => {},
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(errors, [{
        message: 'Could not load pending annotations',
        failedReader: reader,
    }]);
});

test('synchronizes an open PDF even before its toolbar document exists', async () => {
    let handler;
    const reader = { type: 'pdf', itemID: 42 };
    const zotero = {
        Reader: {
            _readers: [reader],
            registerEventListener(_type, value) {
                handler = value;
            },
            unregisterEventListener() {},
        },
    };
    const opened = [];
    registerReaderToolbar({
        zotero,
        pluginID: 'mktero@example.com',
        onOpen: () => {},
        onPDFReaderAvailable: openReader => opened.push(openReader.itemID),
    });
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(opened, [42]);

    handler({
        reader,
        doc: createDocument(),
        append: () => {},
    });
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(opened, [42, 42]);
});

test('localizes the reader toolbar action', () => {
    let handler;
    const zotero = {
        Reader: {
            registerEventListener(_type, value) {
                handler = value;
            },
            unregisterEventListener() {},
        },
    };
    registerReaderToolbar({
        zotero,
        pluginID: 'mktero@example.com',
        onOpen: () => {},
        translate: (key, variables) => translateMessage('zh-CN', key, variables),
    });
    const appended = [];

    handler({
        reader: { type: 'pdf', itemID: 42 },
        doc: createDocument(),
        append: element => appended.push(element),
    });

    assert.equal(appended[0].title, '以 Markdown 打开');
    assert.equal(appended[0].attributes['aria-label'], '以 Markdown 打开 PDF');
});

test('does not add the action to non-PDF readers', () => {
    let handler;
    const zotero = {
        Reader: {
            registerEventListener(_type, value) {
                handler = value;
            },
            unregisterEventListener() {},
        },
    };
    const ready = [];
    registerReaderToolbar({
        zotero,
        pluginID: 'mktero@example.com',
        onOpen: async () => {},
        onPDFReaderAvailable: reader => ready.push(reader.itemID),
    });
    const appended = [];

    handler({
        reader: { type: 'epub', itemID: 42 },
        doc: createDocument(),
        append: element => appended.push(element),
    });

    assert.deepEqual(appended, []);
    assert.deepEqual(ready, []);
});

test('uses Zotero plugin cleanup instead of the broken 9.0 listener unregister API', () => {
    let unregisterCalls = 0;
    const zotero = {
        version: '9.0.6',
        Reader: {
            registerEventListener() {},
            unregisterEventListener() {
                unregisterCalls++;
            },
        },
    };

    const dispose = registerReaderToolbar({
        zotero,
        pluginID: 'mktero@example.com',
        onOpen: async () => {},
    });
    dispose();

    assert.equal(unregisterCalls, 0);
});

test('cancels a queued PDF availability notification during cleanup', async () => {
    const reader = { type: 'pdf', itemID: 42 };
    const zotero = {
        Reader: {
            _readers: [reader],
            registerEventListener() {},
            unregisterEventListener() {},
        },
    };
    const available = [];
    const dispose = registerReaderToolbar({
        zotero,
        pluginID: 'mktero@example.com',
        onOpen: () => {},
        onPDFReaderAvailable: openReader => {
            available.push(openReader.itemID);
        },
    });

    dispose();
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(available, []);
});

test('adds and removes the toolbar action without restarting Zotero', async () => {
    const { document } = parseHTML([
        '<html><body>',
        '<div class="toolbar"><div class="end">',
        '<div class="custom-sections"></div>',
        '</div></div>',
        '</body></html>',
    ].join(''));
    const reader = {
        type: 'pdf',
        itemID: 42,
        _iframeWindow: { document },
    };
    const cleanedPluginIDs = [];
    let toolbarHandler;
    const zotero = {
        version: '9.0.6',
        Reader: {
            _readers: [reader],
            registerEventListener(_type, handler) {
                toolbarHandler = handler;
            },
            _unregisterEventListenerByPluginID(pluginID) {
                cleanedPluginIDs.push(pluginID);
            },
        },
    };
    const dispose = registerReaderToolbar({
        zotero,
        pluginID: 'mktero@example.com',
        onOpen: async () => {},
    });
    await Promise.resolve();
    await Promise.resolve();

    assert.ok(document.querySelector('.mktero-markdown-button'));
    toolbarHandler({
        reader,
        doc: document,
        append: element => document.querySelector('.custom-sections').append(element),
    });
    assert.equal(document.querySelectorAll('.mktero-markdown-button').length, 1);
    dispose();
    assert.equal(document.querySelector('.mktero-markdown-button'), null);
    toolbarHandler({
        reader,
        doc: document,
        append: element => document.querySelector('.custom-sections').append(element),
    });
    assert.equal(document.querySelector('.mktero-markdown-button'), null);
    assert.deepEqual(cleanedPluginIDs, ['mktero@example.com']);
});

test('synchronizes and cleans up PDF readers across Zotero windows', async () => {
    const documents = [1, 2].map(() => parseHTML([
        '<html><body>',
        '<div class="toolbar"><div class="end">',
        '<div class="custom-sections"></div>',
        '</div></div>',
        '</body></html>',
    ].join('')).document);
    const readers = documents.map((document, index) => ({
        type: 'pdf',
        itemID: 42 + index,
        _iframeWindow: { document },
    }));
    let toolbarHandler;
    const zotero = {
        version: '9.0.6',
        Reader: {
            _readers: readers,
            registerEventListener(_type, handler) {
                toolbarHandler = handler;
            },
            _unregisterEventListenerByPluginID() {},
        },
    };
    const synchronized = [];
    const dispose = registerReaderToolbar({
        zotero,
        pluginID: 'mktero@example.com',
        onOpen: () => {},
        onPDFReaderAvailable: reader => synchronized.push(reader.itemID),
    });
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(synchronized, [42, 43]);
    for (const document of documents) {
        assert.ok(document.querySelector('.mktero-markdown-button'));
    }

    dispose();
    for (const document of documents) {
        assert.equal(document.querySelector('.mktero-markdown-button'), null);
    }
    toolbarHandler({
        reader: readers[0],
        doc: documents[0],
        append: () => {},
    });
    await Promise.resolve();

    assert.deepEqual(synchronized, [42, 43]);
});

test('replaces a stale toolbar action during a hot plugin update', () => {
    const { document } = parseHTML([
        '<html><body>',
        '<div class="toolbar"><div class="end">',
        '<div class="custom-sections"><div class="section">',
        '<button id="stale" class="mktero-markdown-button">MD</button>',
        '</div></div>',
        '</div></div>',
        '</body></html>',
    ].join(''));
    const staleButton = document.querySelector('#stale');
    const zotero = {
        version: '9.0.6',
        Reader: {
            _readers: [{
                type: 'pdf',
                itemID: 42,
                _iframeWindow: { document },
            }],
            registerEventListener() {},
            _unregisterEventListenerByPluginID() {},
        },
    };

    const dispose = registerReaderToolbar({
        zotero,
        pluginID: 'mktero@example.com',
        onOpen: async () => {},
    });
    const currentButton = document.querySelector('.mktero-markdown-button');

    assert.notEqual(currentButton, staleButton);
    assert.equal(staleButton.isConnected, false);
    dispose();
});
