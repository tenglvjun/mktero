import test from 'node:test';
import assert from 'node:assert/strict';
import { createZoteroNotes } from '../src/platform/zotero-notes.js';

function codeError(code) {
    return error => {
        assert.equal(error.code, code);
        assert.equal(error instanceof Error, true);
        return true;
    };
}

function createFakeZotero(items = []) {
    const byID = new Map(items.map(item => [item.id, item]));
    const libraries = new Map();
    const constructed = [];
    const notifier = {
        registered: [],
        unregistered: [],
        registerObserver(observer, types, id) {
            const notifierID = this.registered.length + 1;
            this.registered.push({ observer, types, id, notifierID });
            return notifierID;
        },
        unregisterObserver(notifierID) {
            this.unregistered.push(notifierID);
        },
    };
    function Item(type) {
        constructed.push(type);
        this.itemType = type;
        this.isNote = () => type === 'note';
        this.libraryID = null;
        this.parentID = null;
        this.id = 0;
        this.saveTx = async () => {
            this.id = 500;
        };
    }
    const zotero = {
        byID,
        libraries,
        constructed,
        notifier,
        dateCalls: [],
        Item,
        Items: {
            get: id => byID.get(id) || null,
            getByLibraryAndKey(libraryID, key) {
                return [...byID.values()].find(item => (
                    item.libraryID === libraryID && item.key === key
                )) || null;
            },
            async loadDataTypes() {},
            getAll(libraryID) {
                return items.filter(item => (
                    String(item?.libraryID) === String(libraryID)
                ));
            },
        },
        Libraries: {
            get: id => libraries.get(id) || { editable: true },
        },
        Notifier: notifier,
        Annotations: {
            async toJSON(item) {
                return {
                    type: item.annotationType || 'highlight',
                    text: item.text || '',
                    sortIndex: item.sortIndex || '',
                    key: item.key,
                    id: 'json-id',
                };
            },
        },
        EditorInstance: {
            async createNoteFromAnnotations(annotations, options) {
                zotero.createdFromAnnotations = {
                    annotations,
                    options,
                    self: this,
                };
                return { id: 77 };
            },
        },
        Date: {
            sqlToDate(value, isUTC) {
                zotero.dateCalls.push([value, isUTC]);
                return value ? { value } : null;
            },
            toFriendlyDate(date) {
                return `friendly:${date.value}`;
            },
        },
        logError(error) {
            zotero.loggedErrors = zotero.loggedErrors || [];
            zotero.loggedErrors.push(error);
        },
    };
    return zotero;
}

function pdfAttachment(overrides = {}) {
    return {
        id: 42,
        libraryID: 7,
        parentID: 9,
        deleted: false,
        isPDFAttachment: () => true,
        getAnnotations: () => [],
        ...overrides,
    };
}

function parentItem(overrides = {}) {
    return {
        id: 9,
        libraryID: 7,
        deleted: false,
        isRegularItem: () => true,
        getNotes: () => [],
        ...overrides,
    };
}

function noteItem(overrides = {}) {
    return {
        id: 1,
        key: 'NOTE1',
        libraryID: 7,
        parentID: 9,
        deleted: false,
        dateModified: '2024-01-01 00:00:00',
        isNote: () => true,
        isEditable: () => true,
        getNote: () => '<p>Title</p><p>Preview</p>',
        getNoteTitle: () => '',
        ...overrides,
    };
}

function standaloneNoteItem(overrides = {}) {
    return noteItem({
        parentID: null,
        ...overrides,
    });
}
function createEditorWindow({ registered = true, iframe = null } = {}) {
    const editors = [];
    const window = {
        editors,
        document: {
            createXULElement(name) {
                const editor = {
                    name,
                    attributes: {},
                    classes: [],
                    assignments: [],
                    polls: 0,
                    saveSyncCalls: 0,
                    focusCalls: 0,
                    removed: false,
                    instance: null,
                    setAttribute(key, value) {
                        this.attributes[key] = value;
                    },
                    classList: {
                        add: cls => editor.classes.push(cls),
                    },
                    set mode(value) {
                        editor.assignments.push(['mode', value]);
                        editor._mode = value;
                    },
                    get mode() {
                        return editor._mode;
                    },
                    set item(value) {
                        editor.assignments.push(['item', value]);
                        editor._item = value;
                        // Zotero fills the parent line from the item. The
                        // adapter clears it afterwards.
                        editor._parentItem = { id: 'from-item' };
                    },
                    get item() {
                        return editor._item;
                    },
                    set parentItem(value) {
                        editor.assignments.push(['parentItem', value]);
                        editor._parentItem = value;
                    },
                    get parentItem() {
                        return editor._parentItem;
                    },
                    getCurrentInstance() {
                        this.polls += 1;
                        return this.instance;
                    },
                    saveSync() {
                        this.saveSyncCalls += 1;
                    },
                    focus() {
                        this.focusCalls += 1;
                    },
                    remove() {
                        this.removed = true;
                    },
                    _iframe: iframe,
                };
                editors.push(editor);
                return editor;
            },
        },
        customElements: {
            get(name) {
                if (!registered || name !== 'note-editor') return undefined;
                return function NoteEditor() {};
            },
        },
        ZoteroPane: {
            calls: [],
            openNoteWindow(id) {
                this.calls.push(['openNoteWindow', id]);
                return `window:${id}`;
            },
            openNote(id, options) {
                this.calls.push(['openNote', id, options]);
                return `note:${id}`;
            },
        },
    };
    return window;
}

function createContainer() {
    return {
        children: [],
        replaceChildren(...nodes) {
            this.children = [...nodes];
            for (const node of nodes) {
                const originalRemove = node.remove?.bind(node);
                node.remove = () => {
                    node.removed = true;
                    this.children = this.children.filter(child => child !== node);
                    originalRemove?.();
                };
            }
        },
    };
}

function createTimers() {
    let nextID = 1;
    const pending = new Map();
    return {
        pending,
        setTimeout(callback, delay) {
            const id = nextID++;
            pending.set(id, { callback, delay });
            return id;
        },
        clearTimeout(id) {
            pending.delete(id);
        },
        flush() {
            const timers = [...pending.values()];
            pending.clear();
            for (const timer of timers) timer.callback();
        },
    };
}

test('lists current item notes and same-library standalone notes without other item notes', async () => {
    const child = noteItem({ id: 1, dateModified: '2024-01-01 00:00:00' });
    const standalone = standaloneNoteItem({
        id: 2,
        key: 'STANDALONE',
        dateModified: '2024-03-01 00:00:00',
        getNote: () => '<p>Literature review</p><p>Across papers</p>',
    });
    const otherItemNote = noteItem({
        id: 3,
        key: 'OTHER-ITEM',
        parentID: 99,
        dateModified: '2024-04-01 00:00:00',
    });
    const otherLibraryStandalone = standaloneNoteItem({
        id: 4,
        key: 'OTHER-LIBRARY',
        libraryID: 8,
        dateModified: '2024-05-01 00:00:00',
    });
    const parent = parentItem({ getNotes: () => [1] });
    const attachment = pdfAttachment();
    const zotero = createFakeZotero([
        attachment,
        parent,
        child,
        standalone,
        otherItemNote,
        otherLibraryStandalone,
    ]);
    const notes = createZoteroNotes(zotero);

    const result = await notes.list(42);

    assert.equal(result.status, 'ready');
    assert.deepEqual(result.notes.map(note => [note.id, note.kind]), [
        [1, 'item'],
        [2, 'standalone'],
    ]);
    assert.equal(result.canCreateItemNote, true);
    assert.equal(result.canCreateStandaloneNote, true);
});
test('reports notes unavailable when the item is missing or not a PDF', async () => {
    const regular = {
        id: 5,
        isPDFAttachment: () => false,
        isRegularItem: () => true,
    };
    const zotero = createFakeZotero([regular]);
    const notes = createZoteroNotes(zotero);
    const unavailable = {
        status: 'unavailable',
        notes: [],
        editable: false,
        canCreateItemNote: false,
        canCreateStandaloneNote: false,
        annotationCount: 0,
    };

    assert.deepEqual(await notes.list(5), unavailable);
    assert.deepEqual(await notes.list(99), unavailable);
});

test('reports a standalone PDF as having no parent and skips ink annotations', async () => {
    const seen = [];
    const attachment = pdfAttachment({
        parentID: null,
        getAnnotations(includeTrashed) {
            seen.push(includeTrashed);
            return [
                { annotationType: 'highlight' },
                { annotationType: 'ink' },
                { annotationType: 'image' },
                { annotationType: 'ink' },
            ];
        },
    });
    const notes = createZoteroNotes(createFakeZotero([attachment]));

    assert.deepEqual(await notes.list(42), {
        status: 'no-parent',
        notes: [],
        editable: false,
        canCreateItemNote: false,
        canCreateStandaloneNote: true,
        annotationCount: 2,
    });
    assert.deepEqual(seen, [false]);
});

test('lists child notes newest first and drops deleted and snapshot notes', async () => {
    const older = noteItem({
        id: 1,
        key: 'OLDER',
        dateModified: '2024-01-02 08:00:00',
        getNote: () => '<p>January</p><p>old preview</p>',
    });
    const newest = noteItem({
        id: 2,
        key: 'NEWEST',
        dateModified: '2024-08-09 12:30:00',
        getNote: () => '<p>Ignored HTML title</p><p>summer</p>',
        getNoteTitle: () => 'August title',
    });
    const deleted = noteItem({
        id: 3,
        key: 'DELETED',
        deleted: true,
        dateModified: '2024-09-01 00:00:00',
    });
    const snapshot = noteItem({
        id: 4,
        key: 'SNAPSHOT',
        dateModified: '2024-07-01 00:00:00',
        getNote: () => '<p>Mktero Markdown Snapshot</p><p>hidden</p>',
    });
    const middle = noteItem({
        id: 5,
        key: 'MIDDLE',
        dateModified: '2024-03-04 00:00:00',
        getNote: () => '<p>March</p><p>middle preview</p>',
    });
    const notANote = {
        id: 6,
        key: 'ATTACHMENT',
        isNote: () => false,
        deleted: false,
    };
    const parent = parentItem({
        // Zotero's getNotes() returns note item ids, not items.
        getNotes: includeTrashed => {
            assert.equal(includeTrashed, false);
            return [1, 2, 3, 4, 5, 6, 404];
        },
    });
    const attachment = pdfAttachment({
        getAnnotations: () => [
            { annotationType: 'highlight' },
            { annotationType: 'ink' },
        ],
    });
    const zotero = createFakeZotero([
        attachment,
        parent,
        older,
        newest,
        deleted,
        snapshot,
        middle,
        notANote,
    ]);
    const seenSnapshots = [];
    const notes = createZoteroNotes(zotero, {
        isSnapshotNote: item => {
            seenSnapshots.push(item.id);
            return item.id === 4;
        },
    });

    const result = await notes.list(42);

    assert.equal(result.status, 'ready');
    assert.equal(result.editable, true);
    assert.equal(result.annotationCount, 1);
    assert.deepEqual(result.notes.map(note => note.id), [2, 5, 1]);
    assert.deepEqual(result.notes[0], {
        id: 2,
        key: 'NEWEST',
        kind: 'item',
        title: 'August title',
        preview: 'summer',
        dateModified: '2024-08-09 12:30:00',
        dateLabel: 'friendly:2024-08-09 12:30:00',
        editable: true,
    });
    assert.equal(result.notes[1].title, 'March');
    assert.equal(result.notes[1].preview, 'middle preview');
    assert.equal(result.notes[2].title, 'January');
    assert.deepEqual(zotero.dateCalls.map(call => call[0]).sort(), [
        '2024-01-02 08:00:00',
        '2024-03-04 00:00:00',
        '2024-08-09 12:30:00',
    ]);
    assert.equal(zotero.dateCalls.every(([, isUTC]) => isUTC === true), true);
    // Newest first: the snapshot check runs after sorting.
    assert.deepEqual(seenSnapshots, [2, 4, 5, 1]);
});

test('drops a note when the snapshot check throws', async () => {
    // A note that cannot be checked might be a snapshot, and a snapshot must
    // never be listed or receive Add to Note.
    const unreadable = noteItem({
        id: 6,
        key: 'UNREADABLE',
        dateModified: '2024-02-02 00:00:00',
        getNote: () => '<p>Unreadable</p><p>maybe a snapshot</p>',
    });
    const plain = noteItem({
        id: 7,
        key: 'PLAIN',
        dateModified: '2024-01-01 00:00:00',
        getNote: () => '<p>Plain</p><p>listed</p>',
    });
    const parent = parentItem({ getNotes: () => [6, 7] });
    const attachment = pdfAttachment();
    const notes = createZoteroNotes(
        createFakeZotero([attachment, parent, unreadable, plain]),
        {
            isSnapshotNote: item => {
                if (item.id === 6) throw new Error('note HTML is unreadable');
                return false;
            },
        }
    );

    const result = await notes.list(42);

    assert.equal(result.status, 'ready');
    assert.deepEqual(result.notes.map(note => note.id), [7]);
});

test('sorts child notes before applying the list limit', async () => {
    // Ids clear of the attachment (42) and the parent item (9).
    const ids = Array.from({ length: 501 }, (_, index) => index + 1001);
    const items = ids.map(id => noteItem({
        id,
        key: `NOTE${id}`,
        // The newest note is the last id Zotero returns.
        dateModified: id === 1501
            ? '2025-01-01 00:00:00'
            : `2024-01-01 00:00:${String(id % 60).padStart(2, '0')}`,
    }));
    const parent = parentItem({ getNotes: () => ids });
    const attachment = pdfAttachment();
    const notes = createZoteroNotes(createFakeZotero([attachment, parent, ...items]));

    const result = await notes.list(42);

    assert.equal(result.notes.length, 500);
    assert.equal(result.notes[0].id, 1501);
});

test('reports the notes column read-only for a read-only library or a deleted parent', async () => {
    const child = noteItem({ id: 1, dateModified: '2024-01-01 00:00:00' });
    const parent = parentItem({
        libraryID: 3,
        getNotes: () => [1],
    });
    const attachment = pdfAttachment({ libraryID: 3, parentID: 9 });
    child.libraryID = 3;
    const readOnly = createFakeZotero([attachment, parent, child]);
    readOnly.libraries.set(3, { editable: false });
    const readOnlyNotes = createZoteroNotes(readOnly);
    const readOnlyResult = await readOnlyNotes.list(42);
    assert.equal(readOnlyResult.status, 'ready');
    assert.equal(readOnlyResult.editable, false);
    assert.equal(readOnlyResult.notes.length, 1);

    parent.deleted = true;
    const deletedParent = createFakeZotero([attachment, parent, child]);
    const deletedResult = await createZoteroNotes(deletedParent).list(42);
    assert.equal(deletedResult.status, 'ready');
    assert.equal(deletedResult.editable, false);
    assert.equal(deletedResult.notes.length, 1);

    parent.deleted = false;
    attachment.deleted = true;
    const deletedAttachment = createFakeZotero([attachment, parent, child]);
    const deletedAttachmentResult = await createZoteroNotes(deletedAttachment).list(42);
    assert.equal(deletedAttachmentResult.editable, false);
    assert.equal(deletedAttachmentResult.status, 'ready');
});

test('hosts the note editor only when the window can create a note-editor', () => {
    const zotero = createFakeZotero();
    assert.equal(
        createZoteroNotes(zotero, { getMainWindow: () => null }).canHostEditor(),
        false
    );
    assert.equal(createZoteroNotes(zotero, {
        getMainWindow: () => ({
            document: {},
            customElements: { get: () => function NoteEditor() {} },
        }),
    }).canHostEditor(), false);
    assert.equal(createZoteroNotes(zotero, {
        getMainWindow: () => ({
            document: { createXULElement() {} },
            customElements: {
                get: name => (name === 'note-editor' ? undefined : function Other() {}),
            },
        }),
    }).canHostEditor(), false);
    assert.equal(createZoteroNotes(zotero, {
        getMainWindow: () => createEditorWindow(),
    }).canHostEditor(), true);
});

test('pastes copied formula HTML when the note iframe only sees TeX', async () => {
    const parent = parentItem({ id: 9, libraryID: 3 });
    const attachment = pdfAttachment({ id: 42, libraryID: 3, parentID: 9 });
    const zotero = createFakeZotero([attachment, parent]);
    const posted = [];
    const listeners = [];
    const iframe = {
        contentDocument: {
            addEventListener(type, listener, capture) {
                listeners.push({ type, listener, capture });
            },
            removeEventListener(type, listener) {
                const index = listeners.findIndex(item => item.listener === listener);
                if (index >= 0) listeners.splice(index, 1);
            },
        },
        addEventListener() {},
        removeEventListener() {},
    };
    const window = createEditorWindow({ iframe });
    const html = '<pre class="math">$$\\hat{G}_t$$</pre>';
    const notes = createZoteroNotes(zotero, {
        getMainWindow: () => window,
        readClipboardHTML: () => html,
    });
    const handle = await notes.mountEditor(createContainer(), { attachmentID: 42 });
    const editor = window.editors[0];
    editor.instance = { _postMessage(message) { posted.push(message); } };

    assert.equal(listeners.length, 1);
    const event = {
        shiftKey: false,
        defaultPrevented: false,
        prevented: false,
        stopped: false,
        preventDefault() { this.prevented = true; this.defaultPrevented = true; },
        stopPropagation() { this.stopped = true; },
    };
    listeners[0].listener(event);

    assert.equal(event.prevented, true);
    assert.equal(event.stopped, true);
    assert.deepEqual(posted, [{
        action: 'insertHTML',
        pos: null,
        html,
    }]);

    posted.length = 0;
    listeners[0].listener({ ...event, shiftKey: true, preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(posted, []);
    handle.destroy();
    assert.equal(listeners.length, 0);
});

test('mounts an editable note-editor for a new child note', async () => {
    const parent = parentItem({ id: 9, libraryID: 3 });
    const attachment = pdfAttachment({ id: 42, libraryID: 3, parentID: 9 });
    const zotero = createFakeZotero([attachment, parent]);
    const window = createEditorWindow();
    const container = createContainer();
    const notes = createZoteroNotes(zotero, { getMainWindow: () => window });

    const handle = await notes.mountEditor(container, { attachmentID: 42 });
    const editor = window.editors[0];

    assert.equal(zotero.constructed.length, 1);
    assert.equal(zotero.constructed[0], 'note');
    assert.equal(editor.name, 'note-editor');
    assert.equal(container.children[0], editor);
    assert.equal(editor.attributes.flex, '1');
    assert.deepEqual(editor.classes, ['mktero-note-editor']);
    assert.equal(editor.mode, 'edit');
    assert.equal(handle.editable, true);
    assert.equal(handle.noteID, null);
    assert.equal(editor.item.libraryID, 3);
    assert.equal(editor.item.parentID, 9);
    assert.equal(editor.item.parentID === attachment.id, false);
    assert.equal(editor.parentItem, null);
    assert.deepEqual(
        editor.assignments.map(entry => entry[0]).slice(-2),
        ['item', 'parentItem']
    );
    assert.equal(editor.assignments.at(-1)[1], null);
    assert.equal(editor.focusCalls, 1);
    editor.item.id = 15;
    assert.equal(handle.noteID, 15);
});

test('mounts an editable editor for a new standalone note', async () => {
    const attachment = pdfAttachment({ id: 42, libraryID: 3, parentID: null });
    const zotero = createFakeZotero([attachment]);
    const window = createEditorWindow();
    const notes = createZoteroNotes(zotero, { getMainWindow: () => window });

    const handle = await notes.mountEditor(createContainer(), {
        attachmentID: 42,
        noteKind: 'standalone',
    });
    const editor = window.editors[0];

    assert.equal(handle.editable, true);
    assert.equal(editor.item.libraryID, 3);
    assert.equal(editor.item.parentID, null);
});
test('mounts a read-only note in view mode and refuses insertion', async () => {
    const note = noteItem({ id: 8, libraryID: 3, key: 'RO' });
    const parent = parentItem({ id: 9, libraryID: 3 });
    const attachment = pdfAttachment({ libraryID: 3, parentID: 9 });
    const zotero = createFakeZotero([attachment, parent, note]);
    zotero.libraries.set(3, { editable: false });
    const window = createEditorWindow();
    const delays = [];
    const notes = createZoteroNotes(zotero, {
        getMainWindow: () => window,
        delay: async milliseconds => {
            delays.push(milliseconds);
        },
    });

    const handle = await notes.mountEditor(createContainer(), {
        attachmentID: 42,
        noteID: 8,
    });
    const editor = window.editors[0];
    editor.getCurrentInstance = () => {
        throw new Error('read-only insertion must not wait for the editor');
    };

    assert.equal(zotero.constructed.length, 0);
    assert.equal(editor.mode, 'view');
    assert.equal(editor.item, note);
    assert.equal(editor.parentItem, null);
    assert.equal(handle.editable, false);
    await assert.rejects(
        handle.insertAnnotations([{ type: 'highlight', text: 'nope' }]),
        codeError('MKTERO_NOTE_EDITOR_UNAVAILABLE')
    );
    assert.deepEqual(delays, []);
});

test('waits for the note editor instance before inserting annotations', async () => {
    const note = noteItem({ id: 8 });
    const parent = parentItem();
    const attachment = pdfAttachment();
    const zotero = createFakeZotero([attachment, parent, note]);
    const window = createEditorWindow();
    const delays = [];
    let releaseDelay = () => {};
    const notes = createZoteroNotes(zotero, {
        getMainWindow: () => window,
        delay: milliseconds => {
            delays.push(milliseconds);
            return new Promise(resolve => {
                releaseDelay = resolve;
            });
        },
    });
    const handle = await notes.mountEditor(createContainer(), {
        attachmentID: 42,
        noteID: 8,
        focus: false,
    });
    const editor = window.editors[0];
    const inserted = [];
    let releaseInit = () => {};
    const instance = {
        _initPromise: new Promise(resolve => {
            releaseInit = resolve;
        }),
        focusCalls: 0,
        focus() {
            this.focusCalls += 1;
        },
        async insertAnnotations(annotations) {
            inserted.push(annotations);
        },
    };
    editor.instance = null;
    const payload = [{ type: 'highlight', text: 'quoted' }];
    const pending = handle.insertAnnotations(payload);

    assert.equal(inserted.length, 0);
    assert.deepEqual(delays, [25]);
    editor.instance = instance;
    releaseDelay();
    await Promise.resolve();
    assert.equal(inserted.length, 0);
    releaseInit();
    await pending;

    assert.deepEqual(inserted, [payload]);
    assert.equal(instance.focusCalls, 1);
    assert.equal(editor.polls >= 1, true);
});

test('gives up on a note editor whose instance never finishes loading', async () => {
    const note = noteItem({ id: 8 });
    const zotero = createFakeZotero([pdfAttachment(), parentItem(), note]);
    const window = createEditorWindow();
    const notes = createZoteroNotes(zotero, {
        getMainWindow: () => window,
        delay: () => Promise.resolve(),
    });
    const handle = await notes.mountEditor(createContainer(), {
        attachmentID: 42,
        noteID: 8,
        focus: false,
    });
    window.editors[0].instance = {
        _initPromise: new Promise(() => {}),
        insertAnnotations() {
            throw new Error('must not insert');
        },
    };

    await assert.rejects(
        handle.insertAnnotations([{ type: 'highlight', text: 'x' }]),
        error => error.code === 'MKTERO_NOTE_EDITOR_UNAVAILABLE'
    );
});

test('saves and removes the note editor when the handle is destroyed', async () => {
    const note = noteItem({ id: 8 });
    const parent = parentItem();
    const attachment = pdfAttachment();
    const window = createEditorWindow();
    const container = createContainer();
    const notes = createZoteroNotes(
        createFakeZotero([attachment, parent, note]),
        { getMainWindow: () => window }
    );
    const handle = await notes.mountEditor(container, {
        attachmentID: 42,
        noteID: 8,
    });
    const editor = window.editors[0];

    handle.destroy();
    handle.destroy();

    assert.equal(editor.saveSyncCalls, 1);
    assert.equal(editor.removed, true);
    assert.deepEqual(container.children, []);
});

test('refuses to mount a note editor that the window cannot host', async () => {
    const note = noteItem({ id: 8 });
    const zotero = createFakeZotero([pdfAttachment(), parentItem(), note]);
    const notes = createZoteroNotes(zotero, {
        getMainWindow: () => createEditorWindow({ registered: false }),
    });

    await assert.rejects(
        notes.mountEditor(createContainer(), { attachmentID: 42, noteID: 8 }),
        codeError('MKTERO_NOTE_EDITOR_UNAVAILABLE')
    );
    assert.equal(zotero.constructed.length, 0);
    assert.equal(notes.canHostEditor(), false);
});

test('refuses a new note for a standalone PDF', async () => {
    const attachment = pdfAttachment({ parentID: null });
    const zotero = createFakeZotero([attachment]);
    const notes = createZoteroNotes(zotero, {
        getMainWindow: () => createEditorWindow(),
    });

    await assert.rejects(
        notes.mountEditor(createContainer(), { attachmentID: 42 }),
        codeError('MKTERO_NOTE_NO_PARENT_ITEM')
    );
    assert.equal(zotero.constructed.length, 0);
});

test('shows a note in the library tab of the tab window', async () => {
    const note = noteItem({ id: 8 });
    const zotero = createFakeZotero([note]);
    const mainWindow = createEditorWindow();
    const tabWindow = createEditorWindow();
    const calls = [];
    tabWindow.ZoteroPane.selectItem = async id => {
        calls.push(['selectItem', id]);
    };
    tabWindow.Zotero_Tabs = {
        select: id => calls.push(['tab', id]),
    };
    const notes = createZoteroNotes(zotero, { getMainWindow: () => mainWindow });

    await notes.showInLibrary({ noteID: 8, window: tabWindow });

    assert.deepEqual(calls, [['selectItem', 8], ['tab', 'zotero-pane']]);
    await assert.rejects(
        notes.showInLibrary({ noteID: 404, window: tabWindow }),
        error => error.code === 'MKTERO_NOTES_UNAVAILABLE'
    );
});

test('moves an editable note to the trash and refuses a read-only one', async () => {
    const note = noteItem({ id: 8, libraryID: 7 });
    const readOnly = noteItem({ id: 9, libraryID: 3 });
    const zotero = createFakeZotero([note, readOnly]);
    zotero.libraries.set(3, { editable: false });
    const trashed = [];
    zotero.Items.trashTx = async ids => {
        trashed.push(ids);
    };
    const notes = createZoteroNotes(zotero);

    await notes.moveToTrash({ noteID: 8 });
    await assert.rejects(notes.moveToTrash({ noteID: 9 }), /read-only/);
    await notes.moveToTrash({ noteID: 404 });

    assert.deepEqual(trashed, [[8]]);
});

test('prefers ZoteroPane.openNoteWindow when opening a note', async () => {
    const window = createEditorWindow();
    const notes = createZoteroNotes(createFakeZotero(), {
        getMainWindow: () => window,
    });

    const result = await notes.openInWindow({ noteID: 8 });

    assert.equal(result, 'window:8');
    assert.deepEqual(window.ZoteroPane.calls, [['openNoteWindow', 8]]);
});

test('falls back to openNote when Zotero has no note window opener', async () => {
    const window = createEditorWindow();
    window.ZoteroPane.openNoteWindow = undefined;
    const notes = createZoteroNotes(createFakeZotero(), {
        getMainWindow: () => window,
    });

    const result = await notes.openInWindow({ noteID: 8 });

    assert.equal(result, 'note:8');
    assert.deepEqual(window.ZoteroPane.calls, [[
        'openNote',
        8,
        { openInWindow: true },
    ]]);

    window.ZoteroPane.openNote = undefined;
    await assert.rejects(
        notes.openInWindow({ noteID: 8 }),
        codeError('MKTERO_NOTES_UNAVAILABLE')
    );
});

test('saves a new child note before opening it in a window', async () => {
    const parent = parentItem({ id: 9, libraryID: 3 });
    const attachment = pdfAttachment({ id: 42, libraryID: 3, parentID: 9 });
    const zotero = createFakeZotero([attachment, parent]);
    const order = [];
    zotero.Item = function Item(type) {
        order.push(['new', type]);
        this.isNote = () => true;
        this.saveTx = async () => {
            order.push(['save', this.libraryID, this.parentID]);
            this.id = 61;
        };
    };
    const window = createEditorWindow();
    window.ZoteroPane.openNoteWindow = id => {
        order.push(['open', id]);
        return 'opened';
    };
    const notes = createZoteroNotes(zotero, { getMainWindow: () => window });

    const result = await notes.openInWindow({ attachmentID: 42 });

    assert.equal(result, 'opened');
    assert.deepEqual(order, [
        ['new', 'note'],
        ['save', 3, 9],
        ['open', 61],
    ]);
});

test('creates a note from the PDF annotations except ink', async () => {
    const highlight = { id: 1, annotationType: 'highlight' };
    const ink = { id: 2, annotationType: 'ink' };
    const underline = { id: 3, annotationType: 'underline' };
    const textAnnotation = { id: 4, annotationType: 'note' };
    const attachment = pdfAttachment({
        getAnnotations(includeTrashed) {
            assert.equal(includeTrashed, false);
            return [highlight, ink, underline, textAnnotation];
        },
    });
    const parent = parentItem({ id: 9 });
    const zotero = createFakeZotero([attachment, parent]);
    const notes = createZoteroNotes(zotero);

    const result = await notes.createFromAnnotations(42);

    assert.deepEqual(result, { noteID: 77 });
    assert.equal(zotero.createdFromAnnotations.self, zotero.EditorInstance);
    assert.deepEqual(zotero.createdFromAnnotations.options, { parentID: 9 });
    assert.deepEqual(zotero.createdFromAnnotations.annotations, [
        highlight,
        underline,
        textAnnotation,
    ]);
});

test('refuses to create a note when the PDF has no non-ink annotations', async () => {
    const attachment = pdfAttachment({
        getAnnotations: () => [{ annotationType: 'ink' }],
    });
    const zotero = createFakeZotero([attachment, parentItem()]);
    let createCalls = 0;
    zotero.EditorInstance.createNoteFromAnnotations = async () => {
        createCalls += 1;
        return { id: 1 };
    };
    const notes = createZoteroNotes(zotero);

    await assert.rejects(
        notes.createFromAnnotations(42),
        codeError('MKTERO_NOTE_ANNOTATION_NOT_IN_PDF')
    );
    attachment.getAnnotations = () => [];
    await assert.rejects(
        notes.createFromAnnotations(42),
        codeError('MKTERO_NOTE_ANNOTATION_NOT_IN_PDF')
    );
    assert.equal(createCalls, 0);
});

test('builds reader JSON for this PDF only, deduped and in page order', async () => {
    const attachment = pdfAttachment({ id: 42, libraryID: 7 });
    const late = {
        id: 101,
        key: 'LATE',
        libraryID: 7,
        parentID: 42,
        deleted: false,
        annotationType: 'highlight',
        text: 'later',
        sortIndex: '00009|000000|00000',
        isAnnotation: () => true,
    };
    const early = {
        id: 102,
        key: 'EARLY',
        libraryID: 7,
        parentID: 42,
        deleted: false,
        annotationType: 'highlight',
        text: 'earlier',
        sortIndex: '00001|000000|00000',
        isAnnotation: () => true,
    };
    const foreign = {
        id: 103,
        key: 'FOREIGN',
        libraryID: 7,
        parentID: 99,
        deleted: false,
        sortIndex: '00000|000000|00000',
        isAnnotation: () => true,
    };
    const deleted = {
        id: 104,
        key: 'GONE',
        libraryID: 7,
        parentID: 42,
        deleted: true,
        sortIndex: '00000|000001|00000',
        isAnnotation: () => true,
    };
    const notAnnotation = {
        id: 105,
        key: 'NOTANN',
        libraryID: 7,
        parentID: 42,
        deleted: false,
        isAnnotation: () => false,
    };
    const zotero = createFakeZotero([
        attachment,
        late,
        early,
        foreign,
        deleted,
        notAnnotation,
    ]);
    const lookups = [];
    const originalLookup = zotero.Items.getByLibraryAndKey;
    zotero.Items.getByLibraryAndKey = (libraryID, key) => {
        lookups.push([libraryID, key]);
        return originalLookup(libraryID, key);
    };
    const notes = createZoteroNotes(zotero);

    const result = await notes.annotationsForNote(42, [
        'LATE',
        'EARLY',
        'LATE',
        'FOREIGN',
        'GONE',
        'NOTANN',
        '',
        'missing',
    ]);

    assert.deepEqual(result.map(item => item.id), ['EARLY', 'LATE']);
    assert.equal(result[0].attachmentItemID, 42);
    assert.equal(result[1].attachmentItemID, 42);
    assert.equal(result[0].text, 'earlier');
    assert.equal(result[1].sortIndex, '00009|000000|00000');
    assert.deepEqual(lookups, [
        [7, 'LATE'],
        [7, 'EARLY'],
        [7, 'FOREIGN'],
        [7, 'GONE'],
        [7, 'NOTANN'],
        [7, 'missing'],
    ]);
});

test('refuses note annotations that are not in the PDF', async () => {
    const attachment = pdfAttachment({ id: 42, libraryID: 7 });
    const foreign = {
        id: 103,
        key: 'FOREIGN',
        libraryID: 7,
        parentID: 99,
        deleted: false,
        isAnnotation: () => true,
    };
    const zotero = createFakeZotero([attachment, foreign]);
    let jsonCalls = 0;
    zotero.Annotations.toJSON = async () => {
        jsonCalls += 1;
        return {};
    };
    const notes = createZoteroNotes(zotero);

    await assert.rejects(
        notes.annotationsForNote(42, ['FOREIGN', 'missing']),
        codeError('MKTERO_NOTE_ANNOTATION_NOT_IN_PDF')
    );
    await assert.rejects(
        notes.annotationsForNote(42, []),
        codeError('MKTERO_NOTE_ANNOTATION_NOT_IN_PDF')
    );
    assert.equal(jsonCalls, 0);
});

test('registers one item observer and debounces notifications into one call', () => {
    const timers = createTimers();
    const zotero = createFakeZotero();
    const notes = createZoteroNotes(zotero, {
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
    });
    const calls = [];
    const ignored = notes.observe(null);
    ignored();
    notes.observe(() => calls.push('first'));
    notes.observe(() => {
        calls.push('second');
        throw new Error('listener failed');
    });

    assert.equal(zotero.notifier.registered.length, 1);
    assert.deepEqual(zotero.notifier.registered[0].types, ['item']);
    assert.equal(zotero.notifier.registered[0].id, 'mktero-notes');
    const { observer } = zotero.notifier.registered[0];
    observer.notify('select', 'tab', []);
    observer.notify('modify', 'item', [1]);
    observer.notify('add', 'item', [2]);
    observer.notify('delete', 'item', [3]);

    assert.equal(calls.length, 0);
    assert.equal(timers.pending.size, 1);
    assert.equal([...timers.pending.values()][0].delay, 150);
    timers.flush();

    assert.deepEqual(calls, ['first', 'second']);
    assert.equal(zotero.loggedErrors[0].message, 'listener failed');
    observer.notify('modify', 'item', [4]);
    timers.flush();
    assert.deepEqual(calls, ['first', 'second', 'first', 'second']);
    notes.dispose();
});

test('unregisters the item observer when the last listener leaves', () => {
    const timers = createTimers();
    const zotero = createFakeZotero();
    const notes = createZoteroNotes(zotero, {
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
    });
    const stopFirst = notes.observe(() => {});
    const stopSecond = notes.observe(() => {});
    const { observer, notifierID } = zotero.notifier.registered[0];

    stopFirst();
    assert.deepEqual(zotero.notifier.unregistered, []);
    observer.notify('modify', 'item', [1]);
    assert.equal(timers.pending.size, 1);
    stopSecond();

    assert.deepEqual(zotero.notifier.unregistered, [notifierID]);
    assert.equal(timers.pending.size, 0);
    observer.notify('add', 'item', [2]);
    assert.equal(timers.pending.size, 0);

    notes.observe(() => {});
    assert.equal(zotero.notifier.registered.length, 2);
    assert.deepEqual(
        zotero.notifier.registered[1].types,
        ['item']
    );
    notes.dispose();
});

test('dispose unregisters the item observer and drops a pending notification', () => {
    const timers = createTimers();
    const calls = [];
    const zotero = createFakeZotero();
    const notes = createZoteroNotes(zotero, {
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
    });
    notes.observe(() => calls.push('late'));
    const { observer, notifierID } = zotero.notifier.registered[0];
    observer.notify('modify', 'item', [1]);
    observer.notify('delete', 'item', [2]);

    notes.dispose();
    timers.flush();

    assert.deepEqual(zotero.notifier.unregistered, [notifierID]);
    assert.equal(timers.pending.size, 0);
    assert.deepEqual(calls, []);
    observer.notify('add', 'item', [3]);
    assert.equal(timers.pending.size, 0);
});

// A note editor's ProseMirror view as far as the caret uses it. `pending` is
// the document an insert message will produce, applied on the editor's next
// turn, which here is the next poll.
function fakeNode(name, children = [], { textblock = false, leaf = false, spec = {} } = {}) {
    const size = children.reduce((sum, child) => sum + child.nodeSize, 0);
    return {
        type: { name, spec },
        isTextblock: textblock,
        isLeaf: leaf,
        isAtom: leaf || Boolean(spec.atom),
        childCount: children.length,
        child: index => children[index],
        content: { size },
        nodeSize: leaf ? 1 : size + 2,
    };
}

function fakeText(value) {
    return { isLeaf: true, nodeSize: value.length, type: { name: 'text', spec: {} } };
}

function fakeDoc(children) {
    const root = fakeNode('doc', children);
    return { ...root, nodeSize: root.content.size };
}

function fakeParagraph(children = []) {
    return fakeNode('paragraph', children, { textblock: true });
}

function fakeAnnotationParagraph() {
    return fakeParagraph([
        fakeNode('highlight', [fakeText('“genetic anchor is”')]),
        fakeText(' '),
        fakeNode('citation', [], { leaf: true }),
    ]);
}

function createFakeNoteView(doc) {
    const view = { pending: null, dispatched: [] };
    const makeTr = state => {
        const tr = {
            steps: [],
            doc: state.doc,
            insert(pos, node) {
                tr.steps.push(['insert', pos, node]);
                return tr;
            },
            setSelection(selection) {
                tr.steps.push(['select', selection]);
                return tr;
            },
            scrollIntoView() {
                tr.steps.push(['scroll']);
                return tr;
            },
        };
        tr.doc = { ...state.doc, resolve: pos => ({ pos }) };
        return tr;
    };
    class FakeSelection {
        static near($pos, bias) {
            return { near: $pos.pos, bias };
        }
    }
    const setDoc = next => {
        view.state = {
            doc: next,
            selection: new FakeSelection(),
            schema: { nodes: { paragraph: { createAndFill: () => ({ newParagraph: true }) } } },
            get tr() {
                return makeTr(view.state);
            },
        };
    };
    setDoc(doc);
    view.dispatch = tr => view.dispatched.push(tr.steps);
    view.applyPending = () => {
        if (!view.pending) return;
        setDoc(view.pending);
        view.pending = null;
    };
    return view;
}

function noteInstanceWithView(view, extra = {}) {
    return {
        _initPromise: Promise.resolve(),
        _iframeWindow: {
            wrappedJSObject: {
                _currentEditorInstance: { _editorCore: { view } },
            },
        },
        focus() {},
        ...extra,
    };
}

async function mountNoteWithView(view, extra = {}, options = {}) {
    const note = noteItem({ id: 8 });
    const zotero = createFakeZotero([pdfAttachment(), parentItem(), note]);
    const window = createEditorWindow(options.window);
    const notes = createZoteroNotes(zotero, {
        getMainWindow: () => window,
        // The editor handles the insert message on its next turn.
        delay: async () => {
            view.applyPending();
        },
        ...options.notes,
    });
    const handle = await notes.mountEditor(createContainer(), {
        attachmentID: 42,
        noteID: 8,
        focus: false,
    });
    window.editors[0].instance = noteInstanceWithView(view, extra);
    return { handle, editor: window.editors[0], zotero };
}

test('Add to Note puts the caret after the inserted citation, not in the quote', async () => {
    const view = createFakeNoteView(fakeDoc([fakeParagraph()]));
    const inserted = fakeAnnotationParagraph();
    const { handle } = await mountNoteWithView(view, {
        async insertAnnotations() {
            view.pending = fakeDoc([inserted]);
        },
    });

    await handle.insertAnnotations([{ type: 'highlight', text: 'genetic anchor is' }]);

    assert.deepEqual(view.dispatched, [[
        ['select', { near: inserted.nodeSize - 1, bias: -1 }],
        ['scroll'],
    ]]);
});

test('Add to Note ending in a display formula puts the caret on a new line', async () => {
    const view = createFakeNoteView(fakeDoc([fakeParagraph()]));
    const formula = fakeNode('math_display', [fakeText('x')], {
        textblock: true,
        spec: { atom: true, code: true },
    });
    const { handle } = await mountNoteWithView(view, {
        async insertAnnotations() {
            view.pending = fakeDoc([formula]);
        },
    });

    await handle.insertAnnotations([{ type: 'highlight', text: 'x' }]);

    assert.deepEqual(view.dispatched, [[
        ['insert', formula.nodeSize, { newParagraph: true }],
        ['select', { near: formula.nodeSize + 1, bias: -1 }],
        ['scroll'],
    ]]);
});

test('Add to Note keeps the caret when the view is unavailable or nothing arrives', async () => {
    // Without a view, the insert is as before and nothing waits.
    const note = noteItem({ id: 8 });
    const zotero = createFakeZotero([pdfAttachment(), parentItem(), note]);
    const window = createEditorWindow();
    const delays = [];
    const notes = createZoteroNotes(zotero, {
        getMainWindow: () => window,
        delay: async milliseconds => {
            delays.push(milliseconds);
        },
    });
    const handle = await notes.mountEditor(createContainer(), {
        attachmentID: 42,
        noteID: 8,
        focus: false,
    });
    const inserted = [];
    window.editors[0].instance = {
        _initPromise: Promise.resolve(),
        async insertAnnotations(annotations) {
            inserted.push(annotations);
        },
    };
    await handle.insertAnnotations([{ type: 'highlight', text: 'x' }]);
    assert.equal(inserted.length, 1);
    // The instance wait races its own deadline; no caret poll follows.
    assert.equal(delays.includes(25), false);

    // An insert that never reaches the document gives up without a change.
    const view = createFakeNoteView(fakeDoc([fakeParagraph()]));
    const { handle: waiting } = await mountNoteWithView(view, {
        async insertAnnotations() {},
    });
    await waiting.insertAnnotations([{ type: 'highlight', text: 'x' }]);
    assert.deepEqual(view.dispatched, []);
});

test('a hosted formula paste puts the caret after the pasted formula', async () => {
    const listeners = [];
    const iframe = {
        contentDocument: {
            addEventListener(type, listener) {
                listeners.push(listener);
            },
            removeEventListener() {},
        },
        addEventListener() {},
        removeEventListener() {},
    };
    const view = createFakeNoteView(fakeDoc([fakeParagraph()]));
    const formula = fakeNode('math_display', [fakeText('x')], {
        textblock: true,
        spec: { atom: true, code: true },
    });
    const posted = [];
    const { handle } = await mountNoteWithView(view, {
        _postMessage(message) {
            posted.push(message);
            view.pending = fakeDoc([formula]);
        },
    }, {
        window: { iframe },
        notes: { readClipboardHTML: () => '<pre class="math">$$x$$</pre>' },
    });

    listeners[0]({
        shiftKey: false,
        defaultPrevented: false,
        preventDefault() {},
        stopPropagation() {},
    });
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();

    assert.equal(posted.length, 1);
    assert.deepEqual(view.dispatched, [[
        ['insert', formula.nodeSize, { newParagraph: true }],
        ['select', { near: formula.nodeSize + 1, bias: -1 }],
        ['scroll'],
    ]]);
    handle.destroy();
});
