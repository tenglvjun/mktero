import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createZoteroContextPane } from '../src/ui/zotero-context-pane.js';

const turn = () => new Promise(resolve => setTimeout(resolve, 0));

function harness() {
    const { document, MutationObserver } = parseHTML(`<html><body>
        <div id="zotero-context-pane" collapsed="false"><div id="zotero-context-pane-inner"></div>
        <div id="zotero-context-pane-sidenav"></div></div>
        <div id="zotero-context-splitter" state="open"></div>
        <div id="zotero-context-splitter-stacked" state="open"></div>
    </body></html>`);
    const pane = document.getElementById('zotero-context-pane');
    const sidenav = document.getElementById('zotero-context-pane-sidenav');
    const contexts = new Map();
    const selected = [];
    const errors = [];
    const items = new Map([[42, { id: 42, libraryID: 1 }], [43, { id: 43, libraryID: 1 }]]);
    const context = {
        sidenav,
        mode: 'item',
        async _addItemContext(tabID, itemID, type) {
            contexts.set(tabID, { itemID, type, pinnedPane: '', render() {} });
        },
        _getItemContext: id => contexts.get(id),
        _selectItemContext(id) {
            selected.push(id);
            sidenav.container = contexts.get(id);
        },
        _removeItemContext(id) { contexts.delete(id); },
        _selectNotesContext() {},
        _getCurrentNotesContext: () => ({ updateNotesListFromCache() {}, switchToTab() {} }),
    };
    const controller = {
        context,
        sidenav,
        splitter: document.getElementById('zotero-context-splitter'),
        get collapsed() { return pane.getAttribute('collapsed') === 'true'; },
        set collapsed(value) {
            pane.setAttribute('collapsed', String(value));
            for (const id of ['zotero-context-splitter', 'zotero-context-splitter-stacked']) {
                document.getElementById(id).setAttribute('state', value ? 'collapsed' : 'open');
            }
        },
        update() {},
    };
    const window = { document, MutationObserver, ZoteroContextPane: controller,
        Zotero_Tabs: { selectedID: 'native', selectedType: 'reader', updateSidebarLayout() {} } };
    const zotero = { Items: { get: id => items.get(id) }, logError: error => errors.push(error) };
    const manager = createZoteroContextPane({ window, zotero });
    const presentation = (id, itemID = 42, notes = true) => ({
        tabID: id,
        model: { sourceItemID: itemID },
        view: { nativeSidebarOpen: false, focusMode: false, notesVisible: notes, notesIntent: notes,
            nativeEvents: [],
            setNativeSidebarOpen(open) {
                this.nativeEvents.push(open);
                this.nativeSidebarOpen = open;
                this.notesVisible = !open && this.notesIntent;
            },
        },
    });
    const select = async entry => {
        window.Zotero_Tabs.selectedID = entry?.tabID || 'native';
        window.Zotero_Tabs.selectedType = entry ? 'mktero' : 'reader';
        await manager.select(entry);
        await turn();
    };
    return { document, pane, sidenav, context, contexts, controller, window, zotero, manager,
        selected, errors, items, presentation, select };
}

test('binds the actual source to a custom-tab context without changing native tab eligibility', async () => {
    const h = harness();
    const entry = h.presentation('mktero-a');
    await h.select(entry);
    assert.deepEqual(h.contexts.get(entry.tabID), {
        itemID: 42, type: 'mktero', tabType: 'mktero', pinnedPane: '', render: h.contexts.get(entry.tabID).render,
    });
    assert.equal(h.sidenav.container, h.contexts.get(entry.tabID));
    assert.equal(h.sidenav.hidden, false);
    assert.equal(h.controller.collapsed, true);
    assert.deepEqual(entry.view.nativeEvents, []);
    assert.equal(h.window.Zotero_Tabs.selectedType, 'mktero');
    h.manager.dispose();
});

test('observes native open and close while programmatic close does not replay restoration', async () => {
    const h = harness();
    const entry = h.presentation('mktero-a');
    await h.select(entry);
    h.controller.collapsed = false;
    await turn();
    assert.deepEqual(entry.view.nativeEvents, [true]);
    assert.equal(entry.view.notesVisible, false);
    assert.equal(h.manager.setOpen(entry, false), true);
    entry.view.nativeSidebarOpen = false;
    entry.view.notesVisible = true;
    await turn();
    assert.deepEqual(entry.view.nativeEvents, [true]);
    h.controller.collapsed = false;
    await turn();
    h.controller.collapsed = true;
    await turn();
    assert.deepEqual(entry.view.nativeEvents, [true, true, false]);
    assert.equal(entry.view.notesVisible, true);
    h.manager.dispose();
});

test('preserves per-tab native expansion and restores the native-tab layout when leaving', async () => {
    const h = harness();
    const a = h.presentation('mktero-a');
    const b = h.presentation('mktero-b', 43, false);
    await h.select(a);
    h.controller.collapsed = false;
    await turn();
    await h.select(b);
    assert.equal(h.controller.collapsed, true);
    assert.equal(a.view.nativeSidebarOpen, true);
    assert.deepEqual(a.view.nativeEvents, [true]);
    await h.select(a);
    assert.equal(h.controller.collapsed, false);
    assert.equal(h.sidenav.container, h.contexts.get(a.tabID));
    await h.select(null);
    assert.equal(h.controller.collapsed, false);
    assert.equal(h.document.documentElement.hasAttribute('mktero-tab-selected'), false);
    h.manager.dispose();
});

test('ignores late context setup after switching tabs and after disposal', async () => {
    const h = harness();
    let resolve;
    const original = h.context._addItemContext;
    h.context._addItemContext = async (...args) => {
        if (args[0] === 'mktero-a') await new Promise(done => { resolve = done; });
        return original(...args);
    };
    const a = h.presentation('mktero-a');
    const b = h.presentation('mktero-b', 43);
    h.window.Zotero_Tabs.selectedID = a.tabID;
    h.window.Zotero_Tabs.selectedType = 'mktero';
    const pending = h.manager.select(a);
    await h.select(b);
    resolve();
    await pending;
    assert.equal(h.selected.at(-1), b.tabID);
    h.manager.dispose();
    h.controller.collapsed = false;
    await turn();
    assert.deepEqual(a.view.nativeEvents, []);
    assert.deepEqual(b.view.nativeEvents, []);
});

test('focus temporarily hides native content without consuming the view restoration state', async () => {
    const h = harness();
    const entry = h.presentation('mktero-a');
    await h.select(entry);
    h.controller.collapsed = false;
    await turn();
    entry.view.focusMode = true;
    h.manager.setFocusMode(entry, true);
    assert.equal(h.document.documentElement.hasAttribute('mktero-context-pane-focus'), true);
    assert.equal(h.controller.collapsed, true);
    assert.equal(entry.view.nativeSidebarOpen, true);
    entry.view.focusMode = false;
    h.manager.setFocusMode(entry, false);
    assert.equal(h.controller.collapsed, false);
    assert.deepEqual(entry.view.nativeEvents, [true]);
    h.manager.dispose();
});

test('removes invalid or changed source contexts and never exposes a previous paper', async () => {
    const h = harness();
    const entry = h.presentation('mktero-a');
    await h.select(entry);
    entry.model.sourceItemID = 43;
    await h.manager.update(entry);
    assert.equal(h.contexts.get(entry.tabID).itemID, 43);
    entry.model.sourceItemID = null;
    await h.manager.update(entry);
    assert.equal(h.contexts.has(entry.tabID), false);
    assert.equal(h.document.documentElement.hasAttribute('mktero-context-pane-unavailable'), true);
    assert.equal(h.manager.setOpen(entry, true), false);
    h.manager.dispose();
});

test('cleans up only its own contexts and restores native collapsed state', async () => {
    const h = harness();
    h.contexts.set('native', { itemID: 43 });
    h.controller.collapsed = true;
    const entry = h.presentation('mktero-a');
    await h.select(entry);
    h.controller.collapsed = false;
    await turn();
    h.manager.dispose();
    assert.equal(h.controller.collapsed, true);
    assert.equal(h.contexts.has(entry.tabID), false);
    assert.equal(h.contexts.has('native'), true);
    assert.equal(h.document.getElementById('mktero-context-pane-style'), null);
    h.controller.collapsed = false;
    await turn();
    assert.deepEqual(entry.view.nativeEvents, [true]);
});

test('keeps native reader reuse lookups and automatic titles away from custom tabs', () => {
    const h = harness();
    h.manager.dispose();
    const tabs = h.window.Zotero_Tabs;
    tabs._tabs = [
        { id: 'mktero-a', type: 'mktero', title: 'Markdown title', data: { itemID: 42 } },
        { id: 'pdf-a', type: 'reader', title: 'PDF title', data: { itemID: 42 } },
    ];
    const lookup = tabs.getTabIDByItemID = id => tabs._tabs.find(tab => tab.data.itemID === id)?.id;
    const lookups = tabs.getTabIDsByItemID = id => tabs._tabs.filter(tab => tab.data.itemID === id).map(tab => tab.id);
    const renamed = [];
    const rename = tabs.rename = (id, title) => renamed.push({ id, title });
    const manager = createZoteroContextPane({ window: h.window, zotero: h.zotero });
    assert.equal(tabs.getTabIDByItemID(42), 'pdf-a');
    assert.deepEqual(tabs.getTabIDsByItemID(42), ['pdf-a']);
    tabs._tabs.pop();
    assert.equal(tabs.getTabIDByItemID(42), undefined);
    tabs.rename('mktero-a');
    tabs.rename('mktero-a', 'New presenter title');
    assert.deepEqual(renamed, [
        { id: 'mktero-a', title: 'Markdown title' },
        { id: 'mktero-a', title: 'New presenter title' },
    ]);
    manager.dispose();
    assert.equal(tabs.getTabIDByItemID, lookup);
    assert.equal(tabs.getTabIDsByItemID, lookups);
    assert.equal(tabs.rename, rename);
});

test('serializes a changed source behind late creation and removes contexts completed after close', async () => {
    const h = harness();
    const added = [];
    const original = h.context._addItemContext;
    let finishFirst;
    h.context._addItemContext = async (...args) => {
        added.push(args[1]);
        if (args[1] === 42) await new Promise(resolve => { finishFirst = resolve; });
        return original(...args);
    };
    const a = h.presentation('mktero-a');
    h.window.Zotero_Tabs.selectedID = a.tabID;
    const first = h.manager.select(a);
    await turn();
    a.model.sourceItemID = 43;
    const second = h.manager.update(a);
    await turn();
    assert.deepEqual(added, [42]);
    finishFirst();
    await Promise.all([first, second]);
    assert.deepEqual(added, [42, 43]);
    assert.equal(h.contexts.get(a.tabID).itemID, 43);
    assert.equal(h.document.documentElement.hasAttribute('mktero-context-pane-pending'), false);
    h.manager.dispose();

    const closed = harness();
    const create = closed.context._addItemContext;
    let finishClosed;
    closed.context._addItemContext = async (...args) => {
        await new Promise(resolve => { finishClosed = resolve; });
        return create(...args);
    };
    const b = closed.presentation('mktero-b');
    closed.window.Zotero_Tabs.selectedID = b.tabID;
    const pending = closed.manager.select(b);
    await turn();
    b.closed = true;
    closed.manager.release(b);
    closed.manager.dispose();
    finishClosed();
    await pending;
    assert.equal(closed.contexts.has(b.tabID), false);
    assert.deepEqual(b.view.nativeEvents, []);
});

test('can retry a failed context without revealing an unrelated source', async () => {
    const h = harness();
    const original = h.context._addItemContext;
    let fail = true;
    h.context._addItemContext = async (...args) => {
        if (fail) throw new Error('Fixture context failed');
        return original(...args);
    };
    const a = h.presentation('mktero-a');
    await h.select(a);
    assert.equal(h.document.documentElement.hasAttribute('mktero-context-pane-unavailable'), true);
    assert.equal(h.manager.setOpen(a, true), false);
    assert.equal(h.errors.length, 1);
    fail = false;
    await h.manager.update(a);
    assert.equal(h.contexts.get(a.tabID).itemID, 42);
    assert.equal(h.document.documentElement.hasAttribute('mktero-context-pane-unavailable'), false);
    h.manager.dispose();
});

test('restores native splitter intent while leaving the reader content hidden in the library', async () => {
    const h = harness();
    const a = h.presentation('mktero-a');
    await h.select(a);
    h.window.Zotero_Tabs.selectedType = 'library';
    h.window.Zotero_Tabs.selectedID = 'zotero-pane';
    await h.manager.select(null);
    assert.equal(h.pane.getAttribute('collapsed'), 'true');
    assert.equal(h.document.getElementById('zotero-context-pane-inner').getAttribute('collapsed'), 'true');
    assert.equal(h.document.getElementById('zotero-context-splitter').getAttribute('state'), 'open');
    assert.equal(h.sidenav.hidden, true);
    assert.deepEqual(a.view.nativeEvents, []);
    h.manager.dispose();
});

test('reports an explicit native expansion during focus even when native intent was already open', async () => {
    const h = harness();
    const a = h.presentation('mktero-a');
    await h.select(a);
    h.controller.collapsed = false;
    await turn();
    a.view.focusMode = true;
    h.manager.setFocusMode(a, true);
    assert.equal(h.controller.collapsed, true);
    h.controller.collapsed = false;
    await turn();
    assert.deepEqual(a.view.nativeEvents, [true, true]);
    h.manager.dispose();
});

test('corrects Zotero 7 tab type before its first automatic context render', async () => {
    const h = harness();
    const renderedTypes = [];
    let container;
    Object.defineProperty(h.sidenav, 'container', {
        configurable: true,
        get: () => container,
        set: value => { container = value; renderedTypes.push(value.tabType); },
    });
    const original = h.context._addItemContext;
    h.context._addItemContext = async (...args) => {
        await original(...args);
        h.contexts.get(args[0]).tabType = 'reader';
        h.context._selectItemContext(args[0]);
    };
    const a = h.presentation('mktero-a');
    await h.select(a);
    assert.deepEqual(renderedTypes, ['mktero', 'mktero']);
    h.manager.dispose();
});

test('binds an asynchronous native section click to its original tab', async () => {
    const h = harness();
    const a = h.presentation('mktero-a');
    const b = h.presentation('mktero-b', 43);
    await h.select(a);
    let finish;
    h.contexts.get(a.tabID).scrollToPane = () => new Promise(resolve => { finish = resolve; });
    h.sidenav.innerHTML = '<button data-pane="info">Info</button>';
    let nativeClicks = 0;
    h.sidenav.addEventListener('click', () => { nativeClicks += 1; });
    const event = new h.document.defaultView.Event('click', { bubbles: true, cancelable: true });
    Object.defineProperties(event, { button: { value: 0 }, detail: { value: 1 } });
    h.sidenav.querySelector('button').dispatchEvent(event);
    assert.equal(nativeClicks, 0);
    assert.equal(event.defaultPrevented, true);
    await h.select(b);
    finish();
    await turn();
    assert.equal(h.controller.collapsed, true);
    assert.equal(b.view.notesVisible, true);
    assert.deepEqual(b.view.nativeEvents, []);
    h.manager.dispose();
});

test('does not reopen native content when an earlier section scroll finishes after explicit notes opening', async () => {
    const h = harness();
    const a = h.presentation('mktero-a');
    await h.select(a);
    h.controller.collapsed = false;
    await turn();
    const container = h.contexts.get(a.tabID);
    let finish;
    container.scrollToPane = () => new Promise(resolve => { finish = resolve; });
    const opening = h.manager.openSection(a, container, 'info');
    assert.equal(h.manager.setOpen(a, false), true);
    a.view.nativeSidebarOpen = false;
    a.view.notesVisible = true;
    finish();
    await opening;
    assert.equal(h.controller.collapsed, true);
    assert.equal(a.view.notesVisible, true);
    assert.deepEqual(a.view.nativeEvents, [true]);
    h.manager.dispose();
});

test('a failed native section scroll preserves the prior notes and native state', async () => {
    const h = harness();
    const a = h.presentation('mktero-a');
    await h.select(a);
    const container = h.contexts.get(a.tabID);
    container.scrollToPane = async () => { throw new Error('Fixture scroll failed'); };
    await h.manager.openSection(a, container, 'info');
    assert.equal(h.controller.collapsed, true);
    assert.equal(a.view.notesVisible, true);
    assert.deepEqual(a.view.nativeEvents, []);
    assert.equal(h.errors.length, 1);
    h.manager.dispose();
});
