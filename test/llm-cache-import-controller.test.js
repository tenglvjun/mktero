import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { translateMessage } from '../src/i18n/localization.js';
import { registerLLMCacheImportMenu } from '../src/ui/llm-cache-import-controller.js';

function pdf(id, properties = {}) {
    return {
        id, key: `PDF${String(id).padStart(5, '0')}`, libraryID: 1,
        isPDFAttachment: () => true, attachmentFilename: `paper-${id}.pdf`,
        ...properties,
    };
}

function parent(ids) {
    return { id: 10, key: 'PARENT10', libraryID: 1,
        isRegularItem: () => true, getAttachments: () => ids };
}

function harness(items, selected = items) {
    const { document, window: domWindow } = parseHTML(
        '<html><body><menupopup id="zotero-itemmenu"></menupopup></body></html>'
    );
    document.createXULElement = tag => document.createElement(tag);
    let selection = selected;
    const events = new EventTarget();
    const window = {
        document,
        AbortController,
        ZoteroPane: { getSelectedItems: () => selection },
        addEventListener: (...args) => events.addEventListener(...args),
        removeEventListener: (...args) => events.removeEventListener(...args),
    };
    const menu = document.getElementById('zotero-itemmenu');
    return {
        document, window, menu,
        zotero: { Items: { get: id => items.find(item => item.id === id) } },
        select: selectedItems => { selection = selectedItems; },
        show() {
            menu.state = 'showing';
            menu.dispatchEvent(new domWindow.Event('popupshowing', { bubbles: true }));
            menu.state = 'open';
        },
        hide() {
            menu.state = 'closed';
            menu.dispatchEvent(new domWindow.Event('popuphidden', { bubbles: true }));
        },
        unload: () => events.dispatchEvent(new Event('unload')),
        command: node => node.dispatchEvent(new domWindow.Event('command', { bubbles: true })),
        direct: () => document.getElementById('mktero-import-llm-cache'),
        submenu: () => document.getElementById('mktero-import-llm-cache-options'),
    };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function register(h, options = {}) {
    return registerLLMCacheImportMenu({
        zotero: h.zotero, window: h.window,
        probeCandidate: async () => true,
        onImport: () => {}, onError: assert.fail, ...options,
    });
}

test('keeps the action absent unless both optional import callbacks are available', () => {
    const h = harness([pdf(42)]);
    assert.equal(registerLLMCacheImportMenu({ zotero: h.zotero, window: h.window }), null);
    assert.equal(h.direct(), null);
});

test('discovers a single PDF asynchronously and rechecks its candidate before importing its fixed identity', async () => {
    const attachment = pdf(42);
    const h = harness([attachment]);
    const imported = [];
    const probed = [];
    const dispose = register(h, {
        probeCandidate: async (item, { signal }) => {
            assert.equal(signal.aborted, false);
            probed.push(item.id);
            return true;
        },
        onImport: (...args) => imported.push(args),
    });
    h.show();
    assert.equal(h.direct().hidden, true);
    await tick();
    assert.equal(h.direct().hidden, false);
    assert.equal(h.submenu().hidden, true);
    h.command(h.direct());
    h.hide();
    await tick();
    assert.deepEqual(probed, [42, 42]);
    assert.deepEqual(imported, [[42, { libraryID: 1, attachmentKey: 'PDF00042' }]]);
    dispose();
});

test('uses the single cached attachment of a parent even when it is not the first PDF', async () => {
    const first = pdf(42);
    const second = pdf(43);
    const paper = parent([42, 43]);
    const h = harness([paper, first, second], [paper]);
    const imported = [];
    register(h, {
        probeCandidate: async item => item.id === 43,
        onImport: id => imported.push(id),
    });
    h.show();
    await tick();
    assert.equal(h.direct().hidden, false);
    h.command(h.direct());
    await tick();
    assert.deepEqual(imported, [43]);
});

test('lists multiple cached PDFs by attachment title and filename and imports only the selected submenu target', async () => {
    const first = pdf(42, { getDisplayTitle: () => 'Main text' });
    const second = pdf(43, { getDisplayTitle: () => 'Supplement' });
    const paper = parent([42, 43]);
    const h = harness([paper, first, second], [paper]);
    const imported = [];
    register(h, { onImport: id => imported.push(id) });
    h.show();
    await tick();
    assert.equal(h.direct().hidden, true);
    assert.equal(h.submenu().hidden, false);
    const choices = [...h.submenu().querySelectorAll('menuitem')];
    assert.equal(choices.length, 2);
    assert.match(choices[0].getAttribute('label'), /Main text.*paper-42\.pdf/u);
    assert.match(choices[1].getAttribute('label'), /Supplement.*paper-43\.pdf/u);
    h.command(choices[1]);
    await tick();
    assert.deepEqual(imported, [43]);
});

test('disambiguates identical attachment labels without using the parent paper title', async () => {
    const paper = parent([42, 43]);
    paper.getDisplayTitle = () => 'Parent paper';
    const first = pdf(42, { attachmentFilename: 'same.pdf' });
    const second = pdf(43, { attachmentFilename: 'same.pdf' });
    const h = harness([paper, first, second], [paper]);
    register(h);
    h.show();
    await tick();
    const labels = [...h.submenu().querySelectorAll('menuitem')].map(node => node.getAttribute('label'));
    assert.notEqual(labels[0], labels[1]);
    assert.match(labels[0], /42/u);
    assert.match(labels[1], /43/u);
    assert.ok(labels.every(label => !label.includes('Parent paper')));
});

test('hides absent candidates and does not probe notes, webpages, deleted items, or multiple selections', async () => {
    const first = pdf(42);
    const second = pdf(43);
    const note = { id: 70, isNote: () => true };
    const webpage = { id: 71, isPDFAttachment: () => false };
    const deleted = pdf(44, { deleted: true });
    const h = harness([first, second, note, webpage, deleted], [first]);
    const probed = [];
    register(h, { probeCandidate: async item => { probed.push(item.id); return false; } });
    h.show();
    await tick();
    assert.equal(h.direct().hidden, true);
    assert.equal(h.submenu().hidden, true);
    for (const selection of [[first, second], [note], [webpage], [deleted], []]) {
        h.select(selection);
        h.show();
        await tick();
        assert.equal(h.direct().hidden, true);
        assert.equal(h.submenu().hidden, true);
    }
    assert.deepEqual(probed, [42]);
});

test('refreshes missing candidates on the next opening after results are generated', async () => {
    const h = harness([pdf(42)]);
    let available = false;
    register(h, { probeCandidate: async () => available });
    h.show();
    await tick();
    assert.equal(h.direct().hidden, true);
    h.hide();
    available = true;
    h.show();
    await tick();
    assert.equal(h.direct().hidden, false);
});

test('drops a slow probe for A after another popup starts for B', async () => {
    const first = pdf(42);
    const second = pdf(43);
    const h = harness([first, second], [first]);
    const slow = deferred();
    let firstSignal;
    register(h, { probeCandidate: (item, { signal }) => {
        if (item.id === 42) { firstSignal = signal; return slow.promise; }
        return false;
    } });
    h.show();
    h.select([second]);
    h.show();
    await tick();
    slow.resolve(true);
    await tick();
    assert.equal(firstSignal.aborted, true);
    assert.equal(h.direct().hidden, true);
    assert.equal(h.submenu().hidden, true);
});

test('drops a probe when selection changes without opening another popup', async () => {
    const first = pdf(42);
    const second = pdf(43);
    const h = harness([first, second], [first]);
    const slow = deferred();
    register(h, { probeCandidate: () => slow.promise });
    h.show();
    h.select([second]);
    slow.resolve(true);
    await tick();
    assert.equal(h.direct().hidden, true);
});

test('aborts probes and ignores late results when the main menu closes', async () => {
    const h = harness([pdf(42)]);
    const slow = deferred();
    let probeSignal;
    register(h, { probeCandidate: (item, { signal }) => { probeSignal = signal; return slow.promise; } });
    h.show();
    h.hide();
    assert.equal(probeSignal.aborted, true);
    slow.resolve(true);
    await tick();
    assert.equal(h.direct().hidden, true);
});

test('allows a native command dispatched after popuphidden while still revalidating its target', async () => {
    const h = harness([pdf(42)]);
    const imported = [];
    register(h, { onImport: id => imported.push(id) });
    h.show();
    await tick();
    const chosen = h.direct();
    h.hide();
    h.command(chosen);
    await tick();
    assert.deepEqual(imported, [42]);
});

test('ignores nested popup events while the parent menu is open', async () => {
    const paper = parent([42, 43]);
    const h = harness([paper, pdf(42), pdf(43)], [paper]);
    let probes = 0;
    register(h, { probeCandidate: async () => { probes++; return true; } });
    h.show();
    await tick();
    const popup = h.submenu().querySelector('menupopup');
    popup.dispatchEvent(new h.document.defaultView.Event('popupshowing', { bubbles: true }));
    popup.dispatchEvent(new h.document.defaultView.Event('popuphidden', { bubbles: true }));
    await tick();
    assert.equal(probes, 2);
    assert.equal(h.submenu().hidden, false);
});

test('bounds probe concurrency and stops launching queued candidates after closing', async () => {
    const attachments = Array.from({ length: 12 }, (_, index) => pdf(42 + index));
    const paper = parent(attachments.map(item => item.id));
    const h = harness([paper, ...attachments], [paper]);
    const slow = deferred();
    let probes = 0;
    register(h, { probeCandidate: async () => { probes++; await slow.promise; return true; } });
    h.show();
    assert.equal(probes, 3);
    h.hide();
    slow.resolve(true);
    await tick();
    assert.equal(probes, 3);
    assert.equal(h.direct().hidden, true);
});

test('disables busy targets and rechecks busy state after a command probe', async () => {
    const h = harness([pdf(42)]);
    let busy = true;
    let probe = 0;
    const slow = deferred();
    const imported = [];
    const errors = [];
    register(h, {
        isPreparing: () => busy,
        probeCandidate: () => ++probe === 1 ? true : slow.promise,
        onImport: id => imported.push(id), onError: error => errors.push(error),
    });
    h.show();
    await tick();
    assert.equal(h.direct().disabled, true);
    busy = false;
    h.command(h.direct());
    busy = true;
    slow.resolve(true);
    await tick();
    assert.deepEqual(imported, []);
    assert.equal(errors[0]?.code, 'LLM_CACHE_IMPORT_BUSY');
});

test('refuses a command when the cache disappears after the menu opened', async () => {
    const h = harness([pdf(42)]);
    let available = true;
    const errors = [];
    register(h, { probeCandidate: async () => available,
        onImport: () => assert.fail('missing cache must not import'),
        onError: error => errors.push(error),
    });
    h.show();
    await tick();
    available = false;
    h.command(h.direct());
    await tick();
    assert.equal(errors[0]?.code, 'LLM_CACHE_IMPORT_UNAVAILABLE');
});

test('refuses stale commands when an attachment key or library changes', async () => {
    for (const field of ['key', 'libraryID']) {
        const attachment = pdf(42);
        const h = harness([attachment]);
        let probes = 0;
        register(h, { probeCandidate: async () => { probes++; return true; },
            onImport: () => assert.fail('changed identity must not import'),
        });
        h.show();
        await tick();
        attachment[field] = field === 'key' ? 'DIFF0042' : 2;
        h.command(h.direct());
        await tick();
        assert.equal(probes, 1);
    }
});

test('revalidates selection and attachment deletion after the command probe returns', async () => {
    for (const change of ['selection', 'deleted', 'key']) {
        const attachment = pdf(42);
        const other = pdf(43);
        const h = harness([attachment, other], [attachment]);
        const slow = deferred();
        let probes = 0;
        register(h, { probeCandidate: () => ++probes === 1 ? true : slow.promise,
            onImport: () => assert.fail('stale command must not import'),
        });
        h.show();
        await tick();
        h.command(h.direct());
        if (change === 'selection') h.select([other]);
        if (change === 'deleted') attachment.deleted = true;
        if (change === 'key') attachment.key = 'DIFF0042';
        slow.resolve(true);
        await tick();
    }
});

test('prevents duplicate commands while the same window is validating an import', async () => {
    const h = harness([pdf(42)]);
    const slow = deferred();
    let probes = 0;
    const imported = [];
    register(h, { probeCandidate: () => ++probes === 1 ? true : slow.promise,
        onImport: id => imported.push(id),
    });
    h.show();
    await tick();
    h.command(h.direct());
    h.command(h.direct());
    slow.resolve(true);
    await tick();
    assert.equal(probes, 2);
    assert.deepEqual(imported, [42]);
});

test('keeps import validation and busy states independent for different PDF attachments', async () => {
    const first = pdf(42);
    const second = pdf(43);
    const paper = parent([42, 43]);
    const h = harness([paper, first, second], [paper]);
    const firstImport = deferred();
    const imported = [];
    register(h, { onImport: async id => {
        imported.push(id);
        if (id === 42) await firstImport.promise;
    } });
    h.show();
    await tick();
    let choices = [...h.submenu().querySelectorAll('menuitem')];
    h.command(choices[0]);
    await tick();
    h.hide();
    h.show();
    await tick();
    choices = [...h.submenu().querySelectorAll('menuitem')];
    assert.equal(choices[0].disabled, true);
    assert.equal(choices[1].disabled, false);
    h.command(choices[1]);
    await tick();
    assert.deepEqual(imported, [42, 43]);
    firstImport.resolve();
    await tick();
    assert.equal(choices[0].disabled, false);
});

test('cleans up on disposal and window unload, including in-flight command validation', async () => {
    for (const action of ['dispose', 'unload']) {
        const h = harness([pdf(42)]);
        const slow = deferred();
        const signals = [];
        let probes = 0;
        const dispose = register(h, { probeCandidate: (item, { signal }) => {
            signals.push(signal);
            return ++probes === 1 ? true : slow.promise;
        }, onImport: () => assert.fail('disposed window must not import') });
        h.show();
        await tick();
        const staleItem = h.direct();
        h.command(staleItem);
        if (action === 'dispose') dispose();
        else h.unload();
        assert.equal(signals[1].aborted, true);
        assert.equal(h.direct(), null);
        assert.equal(h.submenu(), null);
        slow.resolve(true);
        await tick();
        h.show();
        h.command(staleItem);
        await tick();
        assert.equal(probes, 2);
        dispose();
    }
});

test('isolates menu registrations across windows and replaces an old registration cleanly', async () => {
    const first = harness([pdf(42)]);
    const second = harness([pdf(43)]);
    const imported = [];
    const obsolete = register(first, { onImport: () => assert.fail('replaced callback must not run') });
    const disposeFirst = register(first, { onImport: id => imported.push(id) });
    const disposeSecond = register(second, { onImport: id => imported.push(id) });
    obsolete();
    first.show();
    second.show();
    await tick();
    first.command(first.direct());
    second.command(second.direct());
    await tick();
    assert.deepEqual(imported, [42, 43]);
    disposeFirst();
    assert.equal(first.direct(), null);
    assert.ok(second.direct());
    disposeSecond();
});

test('contains probe failures in menu discovery and reports command failures without importing', async () => {
    const h = harness([pdf(42)]);
    let fail = true;
    const failure = new Error('unavailable');
    const errors = [];
    register(h, { probeCandidate: async () => { if (fail) throw failure; return true; },
        onImport: () => assert.fail('failed probe must not import'),
        onError: error => errors.push(error),
    });
    h.show();
    await tick();
    assert.equal(h.direct().hidden, true);
    assert.deepEqual(errors, []);
    fail = false;
    h.show();
    await tick();
    fail = true;
    h.command(h.direct());
    await tick();
    assert.deepEqual(errors, [failure]);
});

test('localizes import menus and recovery messages in English and Simplified Chinese', async () => {
    for (const language of ['en-US', 'zh-CN']) {
        const t = (key, variables) => translateMessage(language, key, variables);
        const h = harness([pdf(42)]);
        register(h, { translate: t });
        h.show();
        await tick();
        assert.equal(h.direct().getAttribute('label'), t('menu.importLLMCache'));
        for (const key of ['cacheRequired', 'unavailable', 'busy', 'failed', 'working', 'reparse', 'reparseConfirm']) {
            assert.notEqual(t(`importLLM.${key}`), `importLLM.${key}`);
        }
    }
});
