import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { translateMessage } from '../src/i18n/localization.js';
import {
    createSavedMarkdownManifest,
    serializeSavedMarkdownNote,
} from '../src/core/saved-markdown-note-format.js';
import {
    registerCollectionContextMenu,
    registerItemContextMenu,
} from '../src/ui/item-context-menu.js';

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
            AbortController,
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

function collection(id, items = [], children = []) {
    return {
        id,
        getChildItems: () => items,
        getChildCollections: () => children,
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
    assert.equal(menuItem.getAttribute('class') || '', '');
    assert.equal(menuItem.getAttribute('image') || '', '');

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

test('does not add a citation graph action to the item context menu', () => {
    const parent = regularItem(10, []);
    const harness = createMenuHarness([parent]);
    const dispose = registerItemContextMenu({
        zotero: { Items: { get: () => null } },
        window: harness.window,
        rootURI: 'resource://mktero/',
        onOpen: () => assert.fail('an item without a PDF cannot open Markdown'),
        onError: assert.fail,
    });

    showMenu(harness.document);
    const markdown = harness.document.querySelector('#mktero-read-as-markdown');
    assert.equal(markdown.hidden, true);
    assert.equal(
        harness.document.querySelector('#mktero-open-citation-graph'),
        null
    );

    dispose();
});

test('connects local cache discovery and import through the existing item menu registration', async () => {
    const parent = regularItem(10, [42, 43]);
    const first = { ...pdfItem(42), libraryID: 1, key: 'PDF00042' };
    const second = { ...pdfItem(43), libraryID: 1, key: 'PDF00043' };
    const harness = createMenuHarness([parent]);
    const opened = [];
    const imported = [];
    const probed = [];
    const dispose = registerItemContextMenu({
        zotero: { Items: { get: id => ({ 10: parent, 42: first, 43: second })[id] } },
        window: harness.window,
        onOpen: itemID => opened.push(itemID),
        probeLLMCache: async attachment => {
            probed.push(attachment.id);
            return attachment.id === 43;
        },
        onImportLLMCache: (itemID, identity) => imported.push({ itemID, ...identity }),
        onError: assert.fail,
    });
    showMenu(harness.document);
    await new Promise(resolve => setImmediate(resolve));
    const importItem = harness.document.querySelector('#mktero-import-llm-cache');
    assert.equal(importItem.hidden, false);
    assert.deepEqual(probed, [42, 43]);
    importItem.dispatchEvent(new harness.document.defaultView.Event('command'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(imported, [{ itemID: 43, libraryID: 1, attachmentKey: 'PDF00043' }]);
    assert.deepEqual(probed, [42, 43, 43]);
    harness.document.querySelector('#mktero-read-as-markdown').dispatchEvent(
        new harness.document.defaultView.Event('command')
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(opened, [42]);
    dispose();
    assert.equal(harness.document.querySelector('#mktero-import-llm-cache'), null);
    assert.equal(harness.document.querySelector('#mktero-import-llm-cache-options'), null);
});

test('omits import menus when import callbacks are not configured', () => {
    const harness = createMenuHarness([pdfItem(42)]);
    const dispose = registerItemContextMenu({
        zotero: { Items: { get: () => null } },
        window: harness.window,
        onOpen: () => {},
    });
    showMenu(harness.document);
    assert.equal(harness.document.querySelector('#mktero-import-llm-cache'), null);
    assert.equal(harness.document.querySelector('#mktero-import-llm-cache-options'), null);
    dispose();
});

test('removes a legacy citation graph context-menu item during registration', () => {
    const harness = createMenuHarness();
    const legacy = harness.document.createElement('menuitem');
    legacy.id = 'mktero-open-citation-graph';
    harness.document.querySelector('#zotero-itemmenu').appendChild(legacy);

    const dispose = registerItemContextMenu({
        zotero: { Items: { get: () => null } },
        window: harness.window,
        rootURI: 'resource://mktero/',
        onOpen: () => {},
    });

    assert.equal(
        harness.document.querySelector('#mktero-open-citation-graph'),
        null
    );
    dispose();
});

test('prepares every selected PDF and changes the label while one is preparing', async () => {
    const first = pdfItem(1);
    first.getDisplayTitle = () => 'First';
    const secondParent = regularItem(10, [2, 1]);
    secondParent.getDisplayTitle = () => 'Second';
    const second = pdfItem(2);
    second.parentItemID = 10;
    const harness = createMenuHarness([first, secondParent]);
    const prepared = [];
    const opened = [];
    registerItemContextMenu({
        zotero: {
            Items: {
                get: id => ({
                    1: first,
                    2: second,
                    10: secondParent,
                })[id] || null,
            },
        },
        window: harness.window,
        rootURI: 'resource://mktero/',
        onOpen: itemID => opened.push(itemID),
        onPrepare: targets => prepared.push(targets),
        isPreparing: itemID => itemID === 2,
        onError: assert.fail,
    });

    showMenu(harness.document);
    const menuItem = harness.document.querySelector('#mktero-read-as-markdown');
    assert.equal(menuItem.hidden, false);
    assert.equal(menuItem.getAttribute('label'), 'Prepare selected Markdown');
    menuItem.dispatchEvent(new harness.document.defaultView.Event('command'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(prepared, [[
        { itemID: 1, title: 'First' },
        { itemID: 2, title: 'Second' },
    ]]);

    harness.select([second]);
    showMenu(harness.document);
    assert.equal(menuItem.getAttribute('label'), 'Open preparing Markdown');
    menuItem.dispatchEvent(new harness.document.defaultView.Event('command'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(opened, [2]);
});

test('prepares unique PDFs recursively across selected collection trees', async () => {
    const direct = pdfItem(7);
    direct.getDisplayTitle = () => 'Direct';
    const parent = regularItem(8, [9]);
    parent.getDisplayTitle = () => 'Parent paper';
    const attachment = pdfItem(9);
    attachment.parentItemID = 8;
    const nested = pdfItem(10);
    nested.getDisplayTitle = () => 'Nested';
    const deep = pdfItem(12);
    deep.getDisplayTitle = () => 'Deep';
    const grandchild = collection(300, [deep]);
    const child = collection(200, [direct, nested], [grandchild]);
    const root = collection(100, [direct, parent], [child.id]);
    const { document } = parseHTML('<html><body><div id="zotero-collectionmenu"></div></body></html>');
    document.createXULElement = tagName => document.createElement(tagName);
    const prepared = [];
    const confirmations = [];
    const dispose = registerCollectionContextMenu({
        zotero: {
            Items: {
                get: id => ({ 8: parent, 9: attachment })[id] || null,
            },
            Collections: {
                get: id => ({ 200: child, 300: grandchild })[id] || null,
            },
        },
        window: {
            document,
            ZoteroPane: { getSelectedCollections: () => [root, child] },
        },
        onPrepare: targets => prepared.push(targets),
        confirm: async (action, details) => {
            confirmations.push({ action, details });
            return true;
        },
        onError: assert.fail,
    });

    document.querySelector('#zotero-collectionmenu').dispatchEvent(
        new document.defaultView.Event('popupshowing', { bubbles: true })
    );
    const menuItem = document.querySelector('#mktero-prepare-collection-markdown');
    assert.equal(menuItem.hidden, false);
    assert.equal(
        menuItem.getAttribute('label'),
        'Prepare collection tree Markdown'
    );
    menuItem.dispatchEvent(new document.defaultView.Event('command'));
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(confirmations, [{ action: 'prepare', details: { count: 4 } }]);
    assert.deepEqual(prepared, [[
        { itemID: 7, title: 'Direct' },
        { itemID: 9, title: 'Parent paper' },
        { itemID: 10, title: 'Nested' },
        { itemID: 12, title: 'Deep' },
    ]]);
    dispose();
    assert.equal(document.querySelector('#mktero-prepare-collection-markdown'), null);
});


function showItemMenu(harness) {
    harness.document.querySelector('#zotero-itemmenu').dispatchEvent(
        new harness.document.defaultView.Event('popupshowing', { bubbles: true })
    );
}

function exportSubmenu(harness, id = 'mktero-export-obsidian') {
    const element = harness.document.querySelector(`#${id}`);
    assert.ok(element, `missing export submenu #${id}`);
    assert.equal(element.tagName.toLowerCase(), 'menu');
    const popup = element.querySelector('menupopup');
    assert.ok(popup, `missing popup inside #${id}`);
    return {
        element,
        popup,
        item: action => popup.querySelector(`#${id.replace(/obsidian$/, '')}${action}`),
        labels: () => [...popup.children].map(child => child.getAttribute('label')),
    };
}

function command(element, harness) {
    element.dispatchEvent(new harness.document.defaultView.Event('command'));
}

test('offers the four export actions as a submenu when Markdown is ready', async () => {
    const pdf = pdfItem(42);
    pdf.parentItemID = 7;
    const harness = createMenuHarness([pdf]);
    const calls = [];
    const dispose = registerItemContextMenu({
        zotero: { Items: { get: () => null } },
        window: harness.window,
        rootURI: 'resource://mktero/',
        onOpen: () => {},
        onPrepare: () => assert.fail('a single PDF must not prepare'),
        onExport: (action, targets) => calls.push({ action, targets }),
        hasMarkdown: item => item === pdf,
        onError: assert.fail,
    });

    showItemMenu(harness);
    const submenu = exportSubmenu(harness);

    assert.equal(submenu.element.hidden, false);
    assert.equal(submenu.element.getAttribute('label'), 'Export selected Markdown');
    assert.deepEqual(submenu.labels(), [
        'Save snapshot',
        'Export Markdown',
        'Export to Obsidian',
        'Export EPUB',
    ]);

    for (const action of ['snapshot', 'markdown', 'obsidian', 'epub']) {
        command(submenu.item(action), harness);
    }
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(calls.map(call => call.action), [
        'snapshot',
        'markdown',
        'obsidian',
        'epub',
    ]);
    assert.deepEqual(calls[0].targets, [{ itemID: 42, title: 'PDF' }]);

    harness.select([pdfItem(43)]);
    showItemMenu(harness);
    assert.equal(submenu.element.hidden, true);
    dispose();
    assert.equal(harness.document.querySelector('#mktero-export-obsidian'), null);
});

test('keeps every export action for a multi-item selection', async () => {
    const first = pdfItem(1);
    first.getDisplayTitle = () => 'First';
    const second = pdfItem(2);
    second.getDisplayTitle = () => 'Second';
    const harness = createMenuHarness([first, second]);
    const calls = [];
    const dispose = registerItemContextMenu({
        zotero: { Items: { get: () => null } },
        window: harness.window,
        rootURI: 'resource://mktero/',
        onOpen: () => {},
        onPrepare: () => {},
        onExport: (action, targets) => calls.push({ action, targets }),
        hasMarkdown: item => item === first,
        onError: assert.fail,
    });

    showItemMenu(harness);
    const submenu = exportSubmenu(harness);

    assert.equal(submenu.element.hidden, false);
    // Neither PDF has a parent item, so only the snapshot action is missing.
    assert.deepEqual(submenu.labels(), [
        'Export Markdown',
        'Export to Obsidian',
        'Export EPUB',
    ]);

    command(submenu.item('obsidian'), harness);
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(calls, [{
        action: 'obsidian',
        targets: [
            { itemID: 1, title: 'First' },
            { itemID: 2, title: 'Second' },
        ],
    }]);
    dispose();
});

test('hides the export submenu when no selected item has Markdown', () => {
    const harness = createMenuHarness([pdfItem(1), pdfItem(2)]);
    registerItemContextMenu({
        zotero: { Items: { get: () => null } },
        window: harness.window,
        rootURI: 'resource://mktero/',
        onOpen: () => {},
        onPrepare: () => {},
        onExport: () => assert.fail('nothing converted must not export'),
        hasMarkdown: () => false,
        onError: assert.fail,
    });

    showItemMenu(harness);
    assert.equal(exportSubmenu(harness).element.hidden, true);
    assert.equal(
        harness.document.querySelector('#mktero-read-as-markdown').hidden,
        false
    );
});

test('hides the export submenu when the callback is omitted', () => {
    const harness = createMenuHarness([pdfItem(1), pdfItem(2)]);
    registerItemContextMenu({
        zotero: { Items: { get: () => null } },
        window: harness.window,
        rootURI: 'resource://mktero/',
        onOpen: () => {},
        onPrepare: () => {},
        onError: assert.fail,
    });

    showItemMenu(harness);
    assert.equal(
        harness.document.querySelector('#mktero-read-as-markdown').hidden,
        false
    );
    assert.equal(exportSubmenu(harness).element.hidden, true);
});

test('offers the same four actions on a collection tree and confirms once', async () => {
    const direct = pdfItem(7);
    direct.getDisplayTitle = () => 'Direct';
    const parent = regularItem(8, [9]);
    parent.getDisplayTitle = () => 'Parent paper';
    const attachment = pdfItem(9);
    attachment.parentItemID = 8;
    attachment.getDisplayTitle = () => 'Parent paper';
    const nested = pdfItem(10);
    nested.getDisplayTitle = () => 'Nested';
    const deep = pdfItem(12);
    deep.getDisplayTitle = () => 'Deep';
    const grandchild = collection(300, [deep]);
    const child = collection(200, [direct, nested], [grandchild.id]);
    const root = collection(100, [direct, parent], [child.id]);
    const { document } = parseHTML(
        '<html><body><div id="zotero-collectionmenu"></div></body></html>'
    );
    document.createXULElement = tagName => document.createElement(tagName);
    const prepared = [];
    const exported = [];
    const confirmations = [];
    const dispose = registerCollectionContextMenu({
        zotero: {
            Items: {
                get: id => ({ 8: parent, 9: attachment })[id] || null,
            },
            Collections: {
                get: id => ({ 200: child, 300: grandchild })[id] || null,
            },
        },
        window: {
            document,
            ZoteroPane: { getSelectedCollections: () => [root, child] },
        },
        onPrepare: targets => prepared.push(targets),
        onExport: (action, targets) => exported.push({ action, targets }),
        confirm: async (action, details) => {
            confirmations.push({ action, details });
            return true;
        },
        hasMarkdown: item => item === direct || item === deep,
        onError: assert.fail,
    });

    document.querySelector('#zotero-collectionmenu').dispatchEvent(
        new document.defaultView.Event('popupshowing', { bubbles: true })
    );
    const prepareItem = document.querySelector('#mktero-prepare-collection-markdown');
    const submenu = exportSubmenu(
        { document },
        'mktero-export-collection-obsidian'
    );
    assert.equal(prepareItem.hidden, false);
    assert.equal(submenu.element.hidden, false);
    assert.equal(
        submenu.element.getAttribute('label'),
        'Export collection tree Markdown'
    );
    assert.deepEqual(submenu.labels(), [
        'Save snapshot',
        'Export Markdown',
        'Export to Obsidian',
        'Export EPUB',
    ]);

    command(submenu.item('markdown'), { document });
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(confirmations, [{
        action: 'export',
        details: { count: 4, readyCount: 2, action: 'markdown' },
    }]);
    assert.deepEqual(exported, [{
        action: 'markdown',
        targets: [
            { itemID: 7, title: 'Direct' },
            { itemID: 9, title: 'Parent paper' },
            { itemID: 10, title: 'Nested' },
            { itemID: 12, title: 'Deep' },
        ],
    }]);
    assert.deepEqual(prepared, []);
    dispose();
    assert.equal(document.querySelector('#mktero-prepare-collection-markdown'), null);
    assert.equal(
        document.querySelector('#mktero-export-collection-obsidian'),
        null
    );
});

test('cancelling collection batch confirmation starts neither action', async () => {
    const direct = pdfItem(7);
    const selected = collection(100, [direct]);
    const { document } = parseHTML(
        '<html><body><div id="zotero-collectionmenu"></div></body></html>'
    );
    document.createXULElement = tagName => document.createElement(tagName);
    const actions = [];
    const prepared = [];
    const exported = [];
    registerCollectionContextMenu({
        zotero: { Items: { get: () => null } },
        window: {
            document,
            ZoteroPane: { getSelectedCollections: () => [selected] },
        },
        onPrepare: targets => prepared.push(targets),
        onExport: (action, targets) => exported.push({ action, targets }),
        confirm: async action => {
            actions.push(action);
            return false;
        },
        hasMarkdown: () => true,
        onError: assert.fail,
    });

    document.querySelector('#zotero-collectionmenu').dispatchEvent(
        new document.defaultView.Event('popupshowing', { bubbles: true })
    );
    document.querySelector('#mktero-prepare-collection-markdown').dispatchEvent(
        new document.defaultView.Event('command')
    );
    command(
        document.querySelector('#mktero-export-collection-epub'),
        { document }
    );
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(actions, ['prepare', 'export']);
    assert.deepEqual(prepared, []);
    assert.deepEqual(exported, []);
});

test('hides the collection export submenu when no item has Markdown', () => {
    const direct = pdfItem(7);
    const { document } = parseHTML(
        '<html><body><div id="zotero-collectionmenu"></div></body></html>'
    );
    document.createXULElement = tagName => document.createElement(tagName);
    registerCollectionContextMenu({
        zotero: { Items: { get: () => null } },
        window: {
            document,
            ZoteroPane: {
                getSelectedCollections: () => [{
                    getChildItems: () => [direct],
                }],
            },
        },
        onPrepare: () => {},
        onExport: () => assert.fail('an unconverted collection must not export'),
        hasMarkdown: () => false,
        onError: assert.fail,
    });

    document.querySelector('#zotero-collectionmenu').dispatchEvent(
        new document.defaultView.Event('popupshowing', { bubbles: true })
    );
    assert.equal(
        document.querySelector('#mktero-export-collection-obsidian').hidden,
        true
    );
    assert.equal(
        document.querySelector('#mktero-prepare-collection-markdown').hidden,
        false
    );
});

test('hides the collection export submenu when the callback is omitted', () => {
    const direct = pdfItem(7);
    const { document } = parseHTML(
        '<html><body><div id="zotero-collectionmenu"></div></body></html>'
    );
    document.createXULElement = tagName => document.createElement(tagName);
    registerCollectionContextMenu({
        zotero: { Items: { get: () => null } },
        window: {
            document,
            ZoteroPane: {
                getSelectedCollections: () => [{
                    getChildItems: () => [direct],
                }],
            },
        },
        onPrepare: () => {},
        onError: assert.fail,
    });

    document.querySelector('#zotero-collectionmenu').dispatchEvent(
        new document.defaultView.Event('popupshowing', { bubbles: true })
    );
    assert.equal(
        document.querySelector('#mktero-prepare-collection-markdown').hidden,
        false
    );
    assert.equal(
        document.querySelector('#mktero-export-collection-obsidian').hidden,
        true
    );
});
