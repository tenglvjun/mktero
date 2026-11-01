import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createLocalization } from '../src/i18n/localization.js';
import { NOTE_EDITOR_UNAVAILABLE } from '../src/core/zotero-note-bridge.js';
import { createZoteroNotesPanel } from '../src/ui/zotero-notes-panel.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function flush() {
    return new Promise(resolve => setImmediate(resolve));
}

function createPanel({ language, createContextMenu } = {}) {
    const { document } = parseHTML('<html><body></body></html>');
    const host = document.createElement('div');
    const aside = document.createElement('aside');
    document.body.append(host, aside);
    const localization = createLocalization(language ? { zoteroLocale: language } : undefined);
    const errors = [];
    const panel = createZoteroNotesPanel({
        document,
        host,
        aside,
        translate: localization.t.bind(localization),
        onError: error => errors.push(error),
        ...(createContextMenu ? { createContextMenu } : {}),
    });
    return { document, host, aside, panel, errors };
}

function recordingMenu() {
    const menu = {
        opened: [],
        destroyed: 0,
        open(request) {
            menu.opened.push(request);
        },
        destroy() {
            menu.destroyed += 1;
        },
    };
    return menu;
}

function readyState(notes, fields = {}) {
    return {
        status: 'ready',
        notes,
        editable: true,
        annotationCount: 0,
        ...fields,
    };
}

test('a slower list result does not overwrite a newer refresh or a replaced bridge', async () => {
    const { aside, panel, errors } = createPanel();
    const first = deferred();
    const second = deferred();
    const calls = [];
    const adapter = {
        list() {
            const pending = calls.length === 0 ? first : second;
            calls.push(pending);
            return pending.promise;
        },
        observe: () => () => {},
    };

    panel.setAdapter(adapter);
    assert.equal(calls.length, 1);
    const newer = panel.refresh();
    assert.equal(calls.length, 2);
    second.resolve(readyState([{ id: 2, title: 'Newer', preview: 'fresh' }]));
    await newer;
    first.resolve(readyState([{ id: 1, title: 'Older' }]));
    await flush();

    assert.equal(
        aside.querySelector('.mktero-zotero-note-title').textContent,
        'Newer'
    );
    assert.equal(aside.querySelectorAll('.mktero-zotero-note-link').length, 1);
    assert.equal(aside.querySelector('.mktero-zotero-notes-count').textContent, '1');

    const staleFailure = new Error('old list failed');
    const failed = deferred();
    const current = deferred();
    const nextCalls = [];
    panel.setAdapter({
        list() {
            const pending = nextCalls.length === 0 ? failed : current;
            nextCalls.push(pending);
            return pending.promise;
        },
        observe: () => () => {},
    });
    panel.refresh();
    current.resolve(readyState([{ id: 3, title: 'Current' }]));
    await flush();
    failed.reject(staleFailure);
    await flush();

    assert.equal(
        aside.querySelector('.mktero-zotero-note-title').textContent,
        'Current'
    );
    assert.deepEqual(errors, []);

    const orphan = deferred();
    panel.setAdapter({
        list: () => orphan.promise,
        observe: () => () => {},
    });
    panel.setAdapter(null);
    orphan.resolve(readyState([{ id: 9, title: 'From the removed bridge' }]));
    await flush();

    assert.equal(panel.available, false);
    assert.equal(aside.querySelector('.mktero-zotero-note-link'), null);
    assert.equal(
        aside.querySelector('.mktero-zotero-notes-status').textContent,
        'Notes are unavailable for this document.'
    );
    panel.destroy();
});

test('an observation refreshes the note list', async () => {
    const { aside, panel } = createPanel();
    let listener = null;
    let notes = [{ id: 1, title: 'First', preview: 'before' }];
    let disposed = false;
    panel.setAdapter({
        async list() {
            return readyState(notes);
        },
        observe(next) {
            listener = next;
            return () => {
                disposed = true;
                listener = null;
            };
        },
    });
    await flush();

    assert.equal(typeof listener, 'function');
    assert.equal(
        aside.querySelector('.mktero-zotero-note-title').textContent,
        'First'
    );
    notes = [{ id: 1, title: 'Updated', preview: 'after' }];
    listener();
    await flush();

    assert.equal(
        aside.querySelector('.mktero-zotero-note-title').textContent,
        'Updated'
    );
    assert.equal(
        aside.querySelector('.mktero-zotero-note-preview').textContent,
        'after'
    );
    assert.equal(disposed, false);
    panel.destroy();
    assert.equal(disposed, true);
    assert.equal(listener, null);
});

test('uses note tabs and searches only the active scope', async () => {
    const { aside, panel } = createPanel();
    panel.setAdapter({
        async list() {
            return readyState([
                { id: 1, kind: 'item', title: 'Paper method', preview: 'sample' },
                { id: 2, kind: 'standalone', title: 'Literature review', preview: 'cross paper' },
            ]);
        },
        observe: () => () => {},
    });
    await flush();

    assert.deepEqual(
        [...aside.querySelectorAll('.mktero-zotero-notes-tab')]
            .map(node => node.textContent),
        ['Item notes', 'Standalone notes']
    );
    assert.equal(aside.querySelectorAll('.mktero-zotero-note-link').length, 1);
    assert.equal(
        aside.querySelector('.mktero-zotero-note-title').textContent,
        'Paper method'
    );

    aside.querySelector('[data-note-scope="standalone"]').click();
    assert.equal(aside.querySelectorAll('.mktero-zotero-note-link').length, 1);
    assert.equal(
        aside.querySelector('.mktero-zotero-note-title').textContent,
        'Literature review'
    );
    assert.equal(
        aside.querySelector('.mktero-zotero-notes-tab[aria-selected="true"]')
            .textContent,
        'Standalone notes'
    );

    const input = aside.querySelector('.mktero-zotero-notes-search-input');
    input.value = 'literature';
    input.dispatchEvent(new aside.ownerDocument.defaultView.Event('input', {
        bubbles: true,
    }));

    assert.equal(aside.querySelectorAll('.mktero-zotero-note-link').length, 1);
    input.value = 'paper method';
    input.dispatchEvent(new aside.ownerDocument.defaultView.Event('input', {
        bubbles: true,
    }));
    assert.equal(aside.querySelectorAll('.mktero-zotero-note-link').length, 0);
    panel.destroy();
});

test('new note menu distinguishes item and standalone notes', async () => {
    const menu = recordingMenu();
    const { aside, panel } = createPanel({ createContextMenu: () => menu });
    const mounted = [];
    panel.setAdapter({
        async list() {
            return readyState([], {
                canCreateItemNote: true,
                canCreateStandaloneNote: true,
            });
        },
        canHostEditor: () => true,
        async mountEditor(_container, options) {
            mounted.push(options.noteKind);
            return {
                noteID: null,
                editable: true,
                isGone: () => false,
                insertAnnotations() {},
                destroy() {},
            };
        },
        observe: () => () => {},
    });
    await flush();

    aside.querySelector('.mktero-zotero-note-new').click();
    assert.deepEqual(
        menu.opened.at(-1).items.map(item => item.label),
        ['New note for this item', 'New standalone note']
    );
    menu.opened.at(-1).items[0].command();
    await flush();
    menu.opened.at(-1).items[1].command();
    await flush();
    assert.deepEqual(mounted, ['item', 'standalone']);
    panel.destroy();
});
test('a note deleted elsewhere closes the open editor on refresh', async () => {
    const { aside, panel } = createPanel();
    const destroyed = [];
    let listener = null;
    let gone = false;
    let failList = false;
    let notes = [{ id: 3, title: 'Open note', preview: 'still here' }];
    panel.setAdapter({
        async list() {
            if (failList) throw new Error('list failed');
            return readyState(notes);
        },
        canHostEditor: () => true,
        async mountEditor(_container, { noteID }) {
            return {
                noteID,
                editable: true,
                isGone: () => gone,
                insertAnnotations() {},
                destroy() {
                    destroyed.push(noteID);
                },
            };
        },
        observe(next) {
            listener = next;
            return () => {};
        },
    });
    await flush();
    aside.querySelector('.mktero-zotero-note-link').click();
    await flush();

    assert.equal(
        aside.querySelector('.mktero-zotero-notes-editor-view').hidden,
        false
    );

    // A list that lags behind the note's first save, is cut at its limit, or
    // fails does not mean the note is gone.
    notes = [];
    listener();
    await flush();
    failList = true;
    listener();
    await flush();
    assert.deepEqual(destroyed, []);
    assert.equal(
        aside.querySelector('.mktero-zotero-notes-editor-view').hidden,
        false
    );

    failList = false;
    gone = true;
    listener();
    await flush();

    assert.deepEqual(destroyed, [3]);
    assert.equal(
        aside.querySelector('.mktero-zotero-notes-editor-view').hidden,
        true
    );
    assert.equal(
        aside.querySelector('.mktero-zotero-notes-list-view').hidden,
        false
    );
});

test('going back while the editor loads discards the late editor', async () => {
    const { aside, panel } = createPanel();
    const destroyed = [];
    const opened = [];
    let resolveMount;
    panel.setAdapter({
        async list() {
            return readyState([{ id: 5, title: 'Slow note' }]);
        },
        canHostEditor: () => true,
        mountEditor(_container, { noteID }) {
            return new Promise(resolve => {
                resolveMount = () => resolve({
                    noteID,
                    editable: true,
                    insertAnnotations() {},
                    destroy() {
                        destroyed.push(noteID);
                    },
                });
            });
        },
        async openInWindow(options) {
            opened.push(options);
        },
        observe: () => () => {},
    });
    await flush();
    aside.querySelector('.mktero-zotero-note-link').click();
    await flush();
    aside.querySelector('.mktero-zotero-note-back').click();
    resolveMount();
    await flush();

    assert.deepEqual(destroyed, [5]);
    assert.deepEqual(opened, []);
    assert.equal(panel.canInsert, false);
    assert.equal(
        aside.querySelector('.mktero-zotero-notes-editor-view').hidden,
        true
    );
});

test('a note the tab cannot host opens in a window instead', async () => {
    const { aside, panel, errors } = createPanel();
    const opened = [];
    panel.setAdapter({
        async list() {
            return readyState([{ id: 8, title: 'Existing' }]);
        },
        canHostEditor: () => true,
        async mountEditor() {
            const error = new Error('The note editor cannot be hosted');
            error.code = NOTE_EDITOR_UNAVAILABLE;
            throw error;
        },
        async openInWindow(options) {
            opened.push(options);
        },
        observe: () => () => {},
    });
    await flush();
    aside.querySelector('.mktero-zotero-note-link').click();
    await flush();

    assert.deepEqual(opened.map(options => options.noteID), [8]);
    assert.equal(typeof opened[0].window, 'object');
    assert.deepEqual(errors, []);
    assert.equal(
        aside.querySelector('.mktero-zotero-notes-editor-view').hidden,
        true
    );
    assert.equal(
        aside.querySelector('.mktero-zotero-notes-list-view').hidden,
        false
    );
    panel.destroy();
});

test('a mount failure other than an unhostable editor is reported', async () => {
    const { aside, panel, errors } = createPanel();
    const opened = [];
    const failure = new Error('library locked');
    panel.setAdapter({
        async list() {
            return readyState([{ id: 4, title: 'Existing' }]);
        },
        canHostEditor: () => true,
        async mountEditor() {
            throw failure;
        },
        async openInWindow(options) {
            opened.push(options);
        },
        observe: () => () => {},
    });
    await flush();
    aside.querySelector('.mktero-zotero-note-link').click();
    await flush();

    assert.deepEqual(opened, []);
    assert.deepEqual(errors, [failure]);
    assert.equal(
        aside.querySelector('.mktero-zotero-notes-list-view').hidden,
        false
    );
    panel.destroy();
});

test('insertAnnotations rejects when no editable note is open', async () => {
    const { aside, panel } = createPanel();
    const inserted = [];
    await assert.rejects(
        () => panel.insertAnnotations([{ id: 'HIGH0001' }]),
        error => error.code === NOTE_EDITOR_UNAVAILABLE
    );

    panel.setAdapter({
        async list() {
            return readyState([{ id: 1, title: 'Read only' }]);
        },
        canHostEditor: () => true,
        async mountEditor(_container, { noteID }) {
            return {
                noteID,
                editable: false,
                insertAnnotations(annotations) {
                    inserted.push(annotations);
                },
                destroy() {},
            };
        },
        observe: () => () => {},
    });
    await flush();
    aside.querySelector('.mktero-zotero-note-link').click();
    await flush();
    await assert.rejects(
        () => panel.insertAnnotations([{ id: 'HIGH0001' }]),
        error => error.code === NOTE_EDITOR_UNAVAILABLE
    );
    assert.deepEqual(inserted, []);

    panel.setAdapter({
        async list() {
            return readyState([{ id: 2, title: 'Editable' }]);
        },
        canHostEditor: () => true,
        async mountEditor(_container, { noteID }) {
            return {
                noteID,
                editable: true,
                insertAnnotations(annotations) {
                    inserted.push(annotations);
                },
                destroy() {},
            };
        },
        observe: () => () => {},
    });
    await flush();
    aside.querySelector('.mktero-zotero-note-link').click();
    await flush();
    await panel.insertAnnotations([{ id: 'HIGH0001', type: 'highlight' }]);
    assert.deepEqual(inserted, [[{ id: 'HIGH0001', type: 'highlight' }]]);
    panel.destroy();
});

test('destroy removes the editor container and disposes the observer', async () => {
    const { host, aside, panel } = createPanel();
    const destroyed = [];
    let disposals = 0;
    panel.setAdapter({
        async list() {
            return readyState([{ id: 6, title: 'Open' }]);
        },
        canHostEditor: () => true,
        async mountEditor(container, { noteID }) {
            container.appendChild(container.ownerDocument.createElement('div'));
            return {
                noteID,
                editable: true,
                insertAnnotations() {},
                destroy() {
                    destroyed.push(noteID);
                },
            };
        },
        observe: () => () => {
            disposals += 1;
        },
    });
    await flush();
    aside.querySelector('.mktero-zotero-note-link').click();
    await flush();
    const container = host.querySelector('.mktero-note-editor-host');
    assert.ok(container);
    assert.equal(container.getAttribute('slot'), 'mktero-note-editor');

    panel.destroy();

    assert.deepEqual(destroyed, [6]);
    assert.equal(disposals, 1);
    assert.equal(host.querySelector('.mktero-note-editor-host'), null);
    assert.equal(container.isConnected, false);
    panel.destroy();
    assert.equal(disposals, 1);
});

test('right-clicking a note opens the Zotero notes-pane menu', async () => {
    const menu = recordingMenu();
    const { aside, panel, errors } = createPanel({ createContextMenu: () => menu });
    const calls = [];
    let notes = [
        { id: 4, title: 'First' },
        { id: 5, title: 'Second' },
    ];
    panel.setAdapter({
        async list() {
            calls.push(['list']);
            return readyState(notes);
        },
        canHostEditor: () => false,
        async openInWindow(options) {
            calls.push(['window', options.noteID]);
        },
        async showInLibrary(options) {
            calls.push(['library', options.noteID, typeof options.window]);
        },
        async moveToTrash(options) {
            calls.push(['trash', options.noteID]);
            notes = notes.filter(note => note.id !== options.noteID);
        },
        observe: () => () => {},
    });
    await flush();

    const second = aside.querySelectorAll('.mktero-zotero-note-link')[1];
    const event = new second.ownerDocument.defaultView.Event('contextmenu', {
        bubbles: true,
        cancelable: true,
    });
    Object.defineProperties(event, {
        screenX: { value: 300 },
        screenY: { value: 420 },
    });
    second.dispatchEvent(event);

    assert.equal(event.defaultPrevented, true);
    assert.equal(menu.opened.length, 1);
    const request = menu.opened[0];
    assert.equal(request.screenX, 300);
    assert.equal(request.screenY, 420);
    assert.equal(request.anchor, second);
    assert.deepEqual(
        request.items.map(item => (item.separator ? '---' : item.label)),
        ['Show in Library', 'Edit in a Separate Window', '---', 'Move to Trash']
    );
    assert.equal(request.items[3].disabled, false);

    request.items[0].command();
    request.items[1].command();
    await flush();
    assert.deepEqual(calls.filter(call => call[0] !== 'list'), [
        ['library', 5, 'object'],
        ['window', 5],
    ]);

    request.items[3].command();
    await flush();
    assert.deepEqual(calls.filter(call => call[0] === 'trash'), [['trash', 5]]);
    assert.deepEqual(
        [...aside.querySelectorAll('.mktero-zotero-note-title')]
            .map(node => node.textContent),
        ['First']
    );
    assert.deepEqual(errors, []);

    panel.destroy();
    assert.equal(menu.destroyed, 1);
});

test('the note menu cannot trash a note of a read-only library', async () => {
    const menu = recordingMenu();
    const { aside, panel } = createPanel({
        language: 'zh-CN',
        createContextMenu: () => menu,
    });
    const trashed = [];
    panel.setAdapter({
        async list() {
            return readyState([{ id: 4, title: 'Read only' }], { editable: false });
        },
        canHostEditor: () => false,
        async openInWindow() {},
        async showInLibrary() {},
        async moveToTrash(options) {
            trashed.push(options.noteID);
        },
        observe: () => () => {},
    });
    await flush();
    aside.querySelector('.mktero-zotero-note-link').dispatchEvent(
        new aside.ownerDocument.defaultView.Event('contextmenu', {
            bubbles: true,
            cancelable: true,
        })
    );

    const items = menu.opened[0].items;
    assert.deepEqual(
        items.map(item => (item.separator ? '---' : item.label)),
        ['在文献库中显示', '在独立窗口编辑', '---', '移动到回收站']
    );
    assert.equal(items[3].disabled, true);
    await panel.moveToTrash(4);
    assert.deepEqual(trashed, []);
});

test('without a native menu the browser keeps its own context menu', async () => {
    const { aside, panel } = createPanel();
    panel.setAdapter({
        async list() {
            return readyState([{ id: 4, title: 'Note' }]);
        },
        observe: () => () => {},
    });
    await flush();
    const event = new aside.ownerDocument.defaultView.Event('contextmenu', {
        bubbles: true,
        cancelable: true,
    });
    aside.querySelector('.mktero-zotero-note-link').dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
});
