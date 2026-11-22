import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createLocalization } from '../src/i18n/localization.js';
import { createZoteroNotesPanel } from '../src/ui/zotero-notes-panel.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
const research = { id: 8, key: 'QUESTION', libraryID: 1, kind: 'standalone', title: 'Why does this happen?', editable: true };
const local = { id: 9, key: 'LOCAL123', libraryID: 1, kind: 'item', title: 'Paper notes', editable: true };

function fixture(shared = { key: null }) {
    const { document } = parseHTML('<html><body></body></html>');
    const host = document.createElement('div');
    const aside = document.createElement('aside');
    document.body.append(host, aside);
    const localization = createLocalization();
    const errors = [];
    const mounted = [];
    const inserted = [];
    const listeners = new Set();
    const target = () => shared.key ? { status: 'ready', note: research, key: shared.key } : { status: 'none' };
    const adapter = {
        async list() {
            return { status: 'ready', notes: [local, research], editable: true,
                canCreateStandaloneNote: true, researchNote: target() };
        },
        getResearchNote: async () => target(),
        async pinResearchNote(id) {
            assert.equal(id, research.id);
            shared.key = research.key;
            listeners.forEach(notify => notify());
            return target();
        },
        async clearResearchNote() {
            shared.key = null;
            listeners.forEach(notify => notify());
        },
        canHostEditor: () => true,
        async mountEditor(container, { noteID }) {
            mounted.push(noteID);
            const note = noteID === research.id ? research : local;
            return { noteID, title: note.title, editable: true,
                insertAnnotations: async annotations => inserted.push({ noteID, annotations }),
                destroy() {} };
        },
        observe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    };
    const panel = createZoteroNotesPanel({ document, host, aside,
        translate: localization.t.bind(localization), onError: error => errors.push(error) });
    panel.setAdapter(adapter);
    return { panel, aside, adapter, mounted, inserted, errors, shared };
}

test('the initial setup creates, pins and opens a research note only after creation succeeds', async () => {
    const f = fixture();
    await flush();
    const options = [];
    let finish;
    f.adapter.createResearchNote = value => {
        options.push(value);
        return new Promise(resolve => { finish = resolve; });
    };
    await f.panel.refresh();
    assert.equal(f.aside.querySelector('.mktero-research-note-setup').hidden, false);
    const create = f.aside.querySelector('.mktero-research-note-create');
    assert.equal(create.textContent, 'Create research note');
    assert.equal(create.disabled, false);
    create.click();
    create.click();
    await flush();
    assert.deepEqual(options, [{ title: 'Research note' }]);
    assert.equal(create.disabled, true);
    assert.deepEqual(f.mounted, []);
    f.shared.key = research.key;
    finish({ noteID: research.id });
    await flush();
    assert.deepEqual(f.mounted, [research.id]);
    assert.equal(f.panel.insertTargetTitle, research.title);
    assert.equal(f.aside.querySelector('.mktero-research-note-setup').hidden, true);
    assert.equal(f.aside.querySelector('.mktero-note-continuation-hint').hidden, true);
    assert.deepEqual(f.errors, []);
    f.panel.destroy();
});

test('choosing an existing research note lists standalone notes and pins and opens the selected note', async () => {
    const f = fixture();
    await flush();
    const search = f.aside.querySelector('.mktero-zotero-notes-search-input');
    search.value = 'no matching note';
    search.dispatchEvent(new search.ownerDocument.defaultView.Event('input', { bubbles: true }));
    f.aside.querySelector('.mktero-research-note-choose').click();
    assert.equal(f.panel.noteScope, 'standalone');
    assert.equal(f.panel.noteQuery, '');
    assert.equal(f.aside.querySelector('.mktero-research-note-picker').hidden, false);
    assert.equal(f.aside.querySelector('.mktero-zotero-notes-tabs').hidden, true);
    assert.equal(f.aside.querySelector('.mktero-zotero-note-pin-card'), null);
    const choices = f.aside.querySelectorAll('.mktero-zotero-note-link');
    assert.equal(choices.length, 1);
    assert.match(choices[0].textContent, /Why does this happen\?/u);
    choices[0].click();
    await flush();
    assert.equal(f.shared.key, research.key);
    assert.deepEqual(f.mounted, [research.id]);
    assert.equal(f.aside.querySelector('.mktero-research-note-picker').hidden, true);
    assert.equal(f.panel.canInsert, true);
    f.panel.destroy();
});

test('cancelling research-note selection keeps the existing destination and does not open a note', async () => {
    const f = fixture({ key: research.key });
    await flush();
    f.panel.elements.researchChange.click();
    assert.equal(f.aside.querySelector('.mktero-research-note').hidden, true);
    f.aside.querySelector('.mktero-research-note-cancel').click();
    assert.equal(f.shared.key, research.key);
    assert.equal(f.aside.querySelector('.mktero-research-note').hidden, false);
    assert.equal(f.aside.querySelector('.mktero-research-note-picker').hidden, true);
    assert.deepEqual(f.mounted, []);
    f.panel.destroy();
});

test('the setup works for parentless PDFs and disables unavailable creation and read-only choices', async () => {
    const f = fixture();
    await flush();
    f.adapter.createResearchNote = async () => ({ noteID: research.id });
    const list = f.adapter.list;
    f.adapter.list = async () => ({ ...await list(), status: 'no-parent', editable: false,
        canCreateItemNote: false, canCreateStandaloneNote: true });
    await f.panel.refresh();
    assert.equal(f.aside.querySelector('.mktero-research-note-create').disabled, false);
    f.adapter.list = async () => ({ status: 'ready', notes: [{ ...research, editable: false }],
        editable: false, canCreateStandaloneNote: false, researchNote: { status: 'none' } });
    await f.panel.refresh();
    assert.equal(f.aside.querySelector('.mktero-research-note-create').disabled, true);
    assert.equal(f.aside.querySelector('.mktero-research-note-choose').disabled, true);
    f.panel.chooseResearchNote();
    const choice = f.aside.querySelector('.mktero-zotero-note-link');
    assert.equal(choice.disabled, true);
    choice.click();
    await flush();
    assert.equal(f.shared.key, null);
    assert.deepEqual(f.mounted, []);
    f.panel.destroy();
});

test('a failed creation keeps setup available and does not mount an editor', async () => {
    const f = fixture();
    f.adapter.createResearchNote = async () => { throw new Error('Save failed'); };
    await f.panel.refresh();
    f.aside.querySelector('.mktero-research-note-create').click();
    await flush();
    assert.equal(f.errors.length, 1);
    assert.equal(f.errors[0].message, 'Save failed');
    assert.equal(f.aside.querySelector('.mktero-research-note-create').disabled, false);
    assert.equal(f.aside.querySelector('.mktero-research-note-setup').hidden, false);
    assert.equal(f.shared.key, null);
    assert.deepEqual(f.mounted, []);
    f.panel.destroy();
});

test('creation completed after an adapter switch cannot open a note in the new context', async () => {
    const f = fixture();
    let finish;
    f.adapter.createResearchNote = () => new Promise(resolve => { finish = resolve; });
    await f.panel.refresh();
    const creating = f.panel.createResearchNote();
    f.panel.setAdapter({ list: async () => ({ status: 'ready', notes: [] }) });
    finish({ noteID: research.id });
    await creating;
    assert.deepEqual(f.mounted, []);
    assert.equal(f.panel.mode, 'list');
    f.panel.destroy();
});

test('a successful excerpt shows a dismissible writing hint outside the editor without changing inserted content', async () => {
    const f = fixture({ key: research.key });
    await flush();
    const destination = await f.panel.prepareInsert();
    const hint = f.aside.querySelector('.mktero-note-continuation-hint');
    assert.equal(hint.hidden, true);
    const annotations = [{ text: 'An excerpt with a source', position: { pageIndex: 0 } }];
    await destination.insertAnnotations(annotations);
    assert.equal(hint.hidden, false);
    assert.match(hint.textContent, /Excerpt added.*questions, critiques or connections/u);
    assert.equal(hint.querySelector('input, textarea, [contenteditable]'), null);
    assert.deepEqual(f.inserted, [{ noteID: research.id, annotations }]);
    assert.equal(f.panel.host?.contains(hint), false);
    f.aside.querySelector('.mktero-note-continuation-dismiss').click();
    assert.equal(hint.hidden, true);
    assert.equal(f.inserted.length, 1);
    await f.panel.insertAnnotations(annotations);
    assert.equal(hint.hidden, false);
    f.panel.back();
    await f.panel.openNote(research.id);
    assert.equal(hint.hidden, true);
    f.panel.destroy();
});

test('failed or stale insertions never show a successful writing hint', async () => {
    const f = fixture({ key: research.key });
    await flush();
    const destination = await f.panel.prepareInsert();
    await destination.insertAnnotations([{ text: 'Succeeded' }]);
    const hint = f.aside.querySelector('.mktero-note-continuation-hint');
    assert.equal(hint.hidden, false);
    f.panel.handle.insertAnnotations = async () => { throw new Error('Insert failed'); };
    await assert.rejects(destination.insertAnnotations([{ text: 'Failed' }]), /Insert failed/u);
    assert.equal(hint.hidden, true);
    let finish;
    f.panel.handle.insertAnnotations = () => new Promise(resolve => { finish = resolve; });
    const inserting = destination.insertAnnotations([{ text: 'Already dispatched' }]);
    await f.panel.openNote(local.id);
    finish();
    await inserting;
    assert.equal(hint.hidden, true);
    f.panel.destroy();
});

test('card pins toggle the research target without opening its editor', async () => {
    const f = fixture();
    await flush();
    f.panel.setNoteScope('standalone');
    const pin = f.aside.querySelector('.mktero-zotero-note-pin-card');
    assert.ok(pin, 'standalone note cards expose a pin action');
    assert.equal(f.aside.querySelector('.mktero-research-note-change'), null);
    assert.equal(pin.closest('.mktero-zotero-note-link'), null, 'action buttons are not nested');
    assert.equal(pin.getAttribute('aria-pressed'), 'false');
    assert.equal(pin.querySelector('svg').getAttribute('data-lucide'), 'pin');
    pin.click();
    await flush();
    assert.equal(f.shared.key, research.key);
    assert.deepEqual(f.mounted, []);
    const pinned = f.aside.querySelector('.mktero-zotero-note-pin-card');
    assert.equal(pinned.getAttribute('aria-pressed'), 'true');
    assert.equal(pinned.title, 'Unpin Research Note');
    pinned.click();
    await flush();
    assert.equal(f.shared.key, null);
    assert.equal(f.aside.querySelector('.mktero-zotero-note-pin-card').getAttribute('aria-pressed'), 'false');
    assert.equal(f.aside.querySelectorAll('.mktero-zotero-note-link').length, 1);
    assert.deepEqual(f.mounted, []);
    f.aside.querySelector('.mktero-zotero-note-link').click();
    await flush();
    assert.deepEqual(f.mounted, [research.id]);
    assert.equal(f.aside.querySelector('.mktero-zotero-note-pin svg').getAttribute('data-lucide'), 'pin');
    assert.deepEqual(f.errors, []);
    f.panel.destroy();
});

test('child notes have no card pin and read-only standalone cards cannot be pinned', async () => {
    const f = fixture();
    await flush();
    assert.equal(f.aside.querySelector('.mktero-zotero-note-pin-card'), null);
    f.adapter.list = async () => ({ status: 'ready', editable: true,
        notes: [{ ...research, editable: false }], researchNote: { status: 'none' } });
    await f.panel.refresh();
    f.panel.setNoteScope('standalone');
    const pin = f.aside.querySelector('.mktero-zotero-note-pin-card');
    assert.ok(pin);
    assert.equal(pin.disabled, true);
    pin.click();
    await flush();
    assert.equal(f.shared.key, null);
    assert.deepEqual(f.mounted, []);
    f.panel.destroy();
});

test('an editable standalone note can be pinned while the PDF has no parent item', async () => {
    const f = fixture();
    await flush();
    const list = f.adapter.list;
    f.adapter.list = async () => ({ ...await list(), status: 'no-parent',
        editable: false, canCreateItemNote: false, canCreateStandaloneNote: true });
    await f.panel.refresh();
    f.panel.setNoteScope('standalone');
    const pin = f.aside.querySelector('.mktero-zotero-note-pin-card');
    assert.ok(pin);
    assert.equal(pin.disabled, false);
    pin.click();
    await flush();
    assert.equal(f.shared.key, research.key);
    assert.equal(f.aside.querySelector('.mktero-zotero-note-pin-card').getAttribute('aria-pressed'), 'true');
    assert.deepEqual(f.mounted, []);
    f.panel.destroy();
});

test('a pinned target continues in a new panel and a reconstructed adapter without mounting on refresh', async () => {
    const first = fixture();
    await flush();
    await first.panel.pinResearchNote(research.id);
    const second = fixture(first.shared);
    await flush();
    assert.equal(second.panel.insertTargetTitle, research.title);
    assert.equal(second.panel.canPrepareInsert, true);
    assert.deepEqual(second.mounted, []);
    await second.panel.refresh();
    assert.deepEqual(second.mounted, []);
    const destination = await second.panel.prepareInsert();
    await destination.insertAnnotations([{ text: 'Evidence from paper B' }]);
    assert.deepEqual(second.mounted, [research.id]);
    assert.equal(second.inserted[0].noteID, research.id);
    first.panel.destroy();
    second.panel.destroy();
    const restarted = fixture(first.shared);
    await flush();
    assert.equal(restarted.panel.insertTargetTitle, research.title);
    assert.deepEqual(restarted.mounted, []);
    restarted.panel.destroy();
});

test('a local editor wins over the pinned destination until Continue is explicitly chosen', async () => {
    const f = fixture({ key: research.key });
    await flush();
    await f.panel.openNote(local.id);
    await f.panel.refresh();
    assert.equal(f.panel.insertTargetTitle, local.title);
    const destination = await f.panel.prepareInsert();
    await destination.insertAnnotations([{ text: 'Local evidence' }]);
    assert.equal(f.inserted[0].noteID, local.id);
    assert.deepEqual(f.mounted, [local.id]);
    await f.panel.continueResearchNote();
    assert.equal(f.panel.insertTargetTitle, research.title);
    await f.panel.clearResearchNote();
    assert.equal(f.shared.key, null);
    assert.equal(f.panel.insertTargetTitle, research.title);
    assert.equal(f.panel.canInsert, true);
    f.panel.destroy();
});

test('an in-flight insertion refuses to write into a newly opened note', async () => {
    const f = fixture({ key: research.key });
    await flush();
    const destination = await f.panel.prepareInsert();
    await f.panel.openNote(local.id);
    await assert.rejects(destination.insertAnnotations([{ text: 'Wrong destination' }]),
        error => error.code === 'MKTERO_NOTE_EDITOR_UNAVAILABLE');
    assert.deepEqual(f.inserted, []);
    f.panel.destroy();
});

test('closing the editor while a target is resolving never reopens it later', async () => {
    const f = fixture({ key: research.key });
    await flush();
    let release;
    f.adapter.getResearchNote = () => new Promise(resolve => { release = resolve; });
    const preparing = f.panel.prepareInsert();
    f.panel.back();
    release({ status: 'ready', note: research });
    await assert.rejects(preparing, error => error.code === 'MKTERO_NOTE_EDITOR_UNAVAILABLE');
    assert.deepEqual(f.mounted, []);
    assert.equal(f.panel.mode, 'list');
    f.panel.destroy();
});

test('missing and read-only research targets never become insertion destinations', async () => {
    const f = fixture({ key: research.key });
    await flush();
    f.adapter.list = async () => ({ status: 'ready', notes: [], editable: true,
        researchNote: { status: 'missing', key: research.key } });
    await f.panel.refresh();
    assert.equal(f.panel.canPrepareInsert, false);
    assert.equal(f.aside.querySelector('.mktero-research-note').hidden, false);
    await assert.rejects(f.panel.prepareInsert());
    f.adapter.list = async () => ({ status: 'ready', notes: [], editable: true,
        researchNote: { status: 'readonly', note: { ...research, editable: false } } });
    await f.panel.refresh();
    assert.equal(f.panel.canPrepareInsert, false);
    assert.deepEqual(f.mounted, []);
    f.panel.destroy();
});
