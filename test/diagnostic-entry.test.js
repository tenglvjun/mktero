import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
    DIAGNOSTIC_MENU_ITEM_ID,
    registerDiagnosticMenuItem,
    selectedDiagnosticItemID,
} from '../src/platform/zotero-diagnostic-entry.js';

function menuWindow(markup) {
    const dom = new JSDOM(`<!doctype html><html><body>${markup}</body></html>`);
    return dom.window;
}

test('places the report item right after Zotero Report Errors in the Help menu', async () => {
    const window = menuWindow(`
        <menu id="menu_HelpPopup">
            <menuitem id="troubleShooting"></menuitem>
            <menuitem id="reportErrors"></menuitem>
            <menu id="debug-output-menu"></menu>
        </menu>
        <menu id="menu_ToolsPopup"></menu>`);
    const commands = [];
    const dispose = registerDiagnosticMenuItem({
        window,
        onCommand: () => commands.push('report'),
        translate: key => key,
    });

    const help = window.document.getElementById('menu_HelpPopup');
    assert.deepEqual([...help.children].map(child => child.id), [
        'troubleShooting',
        'reportErrors',
        DIAGNOSTIC_MENU_ITEM_ID,
        'debug-output-menu',
    ]);
    assert.equal(window.document.getElementById('menu_ToolsPopup').children.length, 0);
    const item = window.document.getElementById(DIAGNOSTIC_MENU_ITEM_ID);
    assert.equal(item.getAttribute('label'), 'diagnostics.menu');
    item.dispatchEvent(new window.Event('command'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(commands, ['report']);

    dispose();
    assert.equal(window.document.getElementById(DIAGNOSTIC_MENU_ITEM_ID), null);
});

test('falls back to the Tools menu and replaces a stale item', () => {
    const window = menuWindow(`
        <menu id="menu_ToolsPopup"><menuitem id="${DIAGNOSTIC_MENU_ITEM_ID}"></menuitem></menu>`);
    const errors = [];
    const dispose = registerDiagnosticMenuItem({
        window,
        onCommand: () => { throw new Error('report failed'); },
        onError: error => errors.push(error.message),
    });

    const tools = window.document.getElementById('menu_ToolsPopup');
    assert.equal(tools.querySelectorAll(`#${DIAGNOSTIC_MENU_ITEM_ID}`).length, 1);
    dispose();
    assert.equal(registerDiagnosticMenuItem({
        window: menuWindow('<div></div>'),
        onCommand() {},
    }), null);
});

test('reads the PDF of the active tab or the single selected library item', () => {
    const pdf = { id: 11, isPDFAttachment: () => true };
    const parent = {
        id: 10,
        isPDFAttachment: () => false,
        isRegularItem: () => true,
        getAttachments: () => [11, 12],
    };
    const note = { id: 12, isPDFAttachment: () => false };
    const zotero = {
        Items: { get: id => ({ 11: pdf, 12: note })[id] },
        Reader: { getByTabID: tabID => (tabID === 'reader-1' ? { itemID: 21 } : null) },
    };
    const windowFor = (selectedID, selected) => ({
        Zotero_Tabs: { selectedID },
        ZoteroPane: { getSelectedItems: () => selected },
    });
    const sourceItemForTab = tabID => (tabID === 'mktero-1' ? 31 : null);

    assert.equal(selectedDiagnosticItemID({
        zotero, window: windowFor('mktero-1', []), sourceItemForTab,
    }), 31);
    assert.equal(selectedDiagnosticItemID({
        zotero, window: windowFor('reader-1', []), sourceItemForTab,
    }), 21);
    assert.equal(selectedDiagnosticItemID({
        zotero, window: windowFor('zotero-pane', [parent]), sourceItemForTab,
    }), 11);
    assert.equal(selectedDiagnosticItemID({
        zotero, window: windowFor('zotero-pane', [pdf]), sourceItemForTab,
    }), 11);
    assert.equal(selectedDiagnosticItemID({
        zotero, window: windowFor('zotero-pane', [pdf, parent]), sourceItemForTab,
    }), null);
    assert.equal(selectedDiagnosticItemID({
        zotero, window: windowFor('other-tab', []), sourceItemForTab,
    }), null);
    assert.equal(selectedDiagnosticItemID({
        zotero,
        window: { Zotero_Tabs: { get selectedID() { throw new Error('closed'); } } },
    }), null);
});
