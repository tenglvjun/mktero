import test from 'node:test';
import assert from 'node:assert/strict';
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
