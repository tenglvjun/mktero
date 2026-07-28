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
                setAttribute(name, value) {
                    this.attributes[name] = String(value);
                },
                addEventListener(type, handler) {
                    listeners.set(type, handler);
                },
                click() {
                    listeners.get('click')?.();
                },
            };
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
    assert.equal(appended[0].textContent, 'MD');
    assert.deepEqual(opened, [42]);
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
    registerReaderToolbar({
        zotero,
        pluginID: 'mktero@example.com',
        onOpen: async () => {},
    });
    const appended = [];

    handler({
        reader: { type: 'epub', itemID: 42 },
        doc: createDocument(),
        append: element => appended.push(element),
    });

    assert.deepEqual(appended, []);
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

test('adds and removes the toolbar action without restarting Zotero', () => {
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
