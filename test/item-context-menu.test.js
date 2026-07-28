import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { translateMessage } from '../src/i18n/localization.js';
import { registerItemContextMenu } from '../src/ui/item-context-menu.js';

function createMenuHarness(selectedItems = []) {
    const { document } = parseHTML([
        '<html><body>',
        '<div id="zotero-itemmenu"></div>',
        '</body></html>',
    ].join(''));
    document.createXULElement = tagName => document.createElement(tagName);
    let selected = selectedItems;
    return {
        document,
        window: {
            document,
            ZoteroPane: { getSelectedItems: () => selected },
        },
        select(items) {
            selected = items;
        },
    };
}

function pdfItem(id) {
    return {
        id,
        isPDFAttachment: () => true,
    };
}

function regularItem(id, attachmentIDs = []) {
    return {
        id,
        isPDFAttachment: () => false,
        isRegularItem: () => true,
        getAttachments: () => attachmentIDs,
    };
}

function showMenu(document) {
    document.querySelector('#zotero-itemmenu').dispatchEvent(
        new document.defaultView.Event('popupshowing', { bubbles: true })
    );
}

test('adds a Markdown action for a parent item and opens its PDF attachment', async () => {
    const parent = regularItem(10, [42]);
    const attachment = pdfItem(42);
    const harness = createMenuHarness([parent]);
    const opened = [];
    const dispose = registerItemContextMenu({
        zotero: { Items: { get: id => id === 42 ? attachment : null } },
        window: harness.window,
        rootURI: 'resource://mktero/',
        onOpen: itemID => opened.push(itemID),
        onError: assert.fail,
    });

    showMenu(harness.document);
    const menuItem = harness.document.querySelector('#mktero-read-as-markdown');

    assert.ok(menuItem);
    assert.equal(menuItem.hidden, false);
    assert.equal(menuItem.getAttribute('label'), 'Read as Markdown with Mktero');
    assert.equal(menuItem.getAttribute('class'), 'menuitem-iconic');
    assert.equal(
        menuItem.getAttribute('image'),
        'resource://mktero/ui/icons/mktero.svg'
    );

    menuItem.dispatchEvent(new harness.document.defaultView.Event('command'));
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(opened, [42]);
    dispose();
    assert.equal(harness.document.querySelector('#mktero-read-as-markdown'), null);
});

test('opens a directly selected PDF attachment', async () => {
    const attachment = pdfItem(42);
    const harness = createMenuHarness([attachment]);
    const opened = [];
    registerItemContextMenu({
        zotero: { Items: { get: () => null } },
        window: harness.window,
        rootURI: 'resource://mktero/',
        onOpen: itemID => opened.push(itemID),
        onError: assert.fail,
    });

    showMenu(harness.document);
    const menuItem = harness.document.querySelector('#mktero-read-as-markdown');
    menuItem.dispatchEvent(new harness.document.defaultView.Event('command'));
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(opened, [42]);
});

test('hides the action unless exactly one item resolves to a PDF', () => {
    const parentWithoutPDF = regularItem(10, [99]);
    const harness = createMenuHarness([parentWithoutPDF]);
    registerItemContextMenu({
        zotero: {
            Items: {
                get: () => ({ id: 99, isPDFAttachment: () => false }),
            },
        },
        window: harness.window,
        rootURI: 'resource://mktero/',
        onOpen: () => assert.fail('hidden action must not open'),
        onError: assert.fail,
    });
    const menuItem = harness.document.querySelector('#mktero-read-as-markdown');

    showMenu(harness.document);
    assert.equal(menuItem.hidden, true);

    harness.select([pdfItem(1), pdfItem(2)]);
    showMenu(harness.document);
    assert.equal(menuItem.hidden, true);
});

test('reports failures from the shared Markdown opening flow', async () => {
    const attachment = pdfItem(42);
    const harness = createMenuHarness([attachment]);
    const failure = new Error('conversion failed');
    const reported = [];
    registerItemContextMenu({
        zotero: { Items: { get: () => null } },
        window: harness.window,
        rootURI: 'resource://mktero/',
        onOpen: async () => { throw failure; },
        onError: error => reported.push(error),
    });

    showMenu(harness.document);
    harness.document.querySelector('#mktero-read-as-markdown').dispatchEvent(
        new harness.document.defaultView.Event('command')
    );
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(reported, [failure]);
});

test('localizes the item menu action', () => {
    const harness = createMenuHarness([pdfItem(42)]);
    registerItemContextMenu({
        zotero: { Items: { get: () => null } },
        window: harness.window,
        rootURI: 'resource://mktero/',
        onOpen: () => {},
        onError: assert.fail,
        translate: (key, variables) => translateMessage('zh-CN', key, variables),
    });

    assert.equal(
        harness.document.querySelector('#mktero-read-as-markdown')
            .getAttribute('label'),
        '使用 Mktero 阅读 Markdown'
    );
});
