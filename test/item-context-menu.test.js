import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { translateMessage } from '../src/i18n/localization.js';
import {
    createSavedMarkdownManifest,
    serializeSavedMarkdownNote,
} from '../src/core/saved-markdown-note-format.js';
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
    const disposeSecond = registerItemContextMenu({
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

test('shows the action for a saved Mktero note but not an ordinary note', async () => {
    const ordinary = {
        id: 70,
        isNote: () => true,
        getNote: () => '<div><p>Ordinary</p></div>',
    };
    const manifest = createSavedMarkdownManifest({
        sourcePDFKey: 'PDF00001',
        sourceLibraryKey: '1',
        cacheKey: 'a'.repeat(64),
        markdownHash: 'b'.repeat(64),
        parserProfile: 'mineru-v1',
        sourceAttachmentKey: 'SOURCE01',
        sourceMapAttachmentKey: 'MAP00001',
        assets: [],
        snapshotHTMLHash: 'c'.repeat(64),
        createdAt: '2026-08-04T00:00:00.000Z',
    });
    const saved = {
        id: 71,
        isNote: () => true,
        getNote: () => [
            '<div class="zotero-note znv1">',
            serializeSavedMarkdownNote({
                bodyHTML: '<h1>Saved</h1>',
                manifest,
            }),
            '</div>',
        ].join(''),
    };
    const harness = createMenuHarness([ordinary]);
    const opened = [];
    registerItemContextMenu({
        zotero: { Items: { get: () => null } },
        window: harness.window,
        rootURI: 'resource://mktero/',
        onOpen: () => assert.fail('ordinary note must not open'),
        onOpenSavedNote: id => opened.push(id),
        onError: assert.fail,
    });

    showMenu(harness.document);
    const menuItem = harness.document.querySelector('#mktero-read-as-markdown');
    assert.equal(menuItem.hidden, true);

    harness.select([saved]);
    showMenu(harness.document);
    assert.equal(menuItem.hidden, false);
    assert.equal(
        menuItem.getAttribute('label'),
        'Open saved Markdown with Mktero'
    );
    menuItem.dispatchEvent(new harness.document.defaultView.Event('command'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(opened, [71]);
});

test('uses store recognition for a legacy snapshot stripped by Zotero', async () => {
    const recovered = {
        id: 72,
        isNote: () => true,
        getNote: () => [
            '<div class="zotero-note znv1">',
            '<div data-schema-version="9"><h1>Saved</h1></div>',
            '</div>',
        ].join(''),
    };
    const harness = createMenuHarness([recovered]);
    const opened = [];
    registerItemContextMenu({
        zotero: { Items: { get: () => null } },
        window: harness.window,
        rootURI: 'resource://mktero/',
        onOpen: () => assert.fail('a recovered note must use the saved flow'),
        onOpenSavedNote: id => opened.push(id),
        isSavedMarkdownNote: item => item === recovered,
        onError: assert.fail,
    });

    showMenu(harness.document);
    const menuItem = harness.document.querySelector('#mktero-read-as-markdown');
    assert.equal(menuItem.hidden, false);
    assert.equal(
        menuItem.getAttribute('label'),
        'Open saved Markdown with Mktero'
    );

    menuItem.dispatchEvent(new harness.document.defaultView.Event('command'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(opened, [72]);
});

test('keeps context-menu registrations isolated across Zotero windows', async () => {
    const first = createMenuHarness([pdfItem(41)]);
    const second = createMenuHarness([pdfItem(42)]);
    const opened = [];
    const disposeFirst = registerItemContextMenu({
        zotero: { Items: { get: () => null } },
        window: first.window,
        rootURI: 'resource://mktero/',
        onOpen: id => opened.push(id),
        onError: assert.fail,
    });
    const disposeSecond = registerItemContextMenu({
        zotero: { Items: { get: () => null } },
        window: second.window,
        rootURI: 'resource://mktero/',
        onOpen: id => opened.push(id),
        onError: assert.fail,
    });

    showMenu(first.document);
    showMenu(second.document);
    first.document.querySelector('#mktero-read-as-markdown').dispatchEvent(
        new first.document.defaultView.Event('command')
    );
    second.document.querySelector('#mktero-read-as-markdown').dispatchEvent(
        new second.document.defaultView.Event('command')
    );
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(opened, [41, 42]);
    disposeFirst();
    assert.equal(first.document.querySelector('#mktero-read-as-markdown'), null);
    assert.ok(second.document.querySelector('#mktero-read-as-markdown'));
    disposeSecond();
});
