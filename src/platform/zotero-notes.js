import {
    annotationJSONForNote,
    NOTE_ANNOTATION_NOT_IN_PDF,
    NOTE_EDITOR_UNAVAILABLE,
    NOTE_NO_PARENT_ITEM,
    noteBridgeError,
    NOTES_UNAVAILABLE,
    summarizeNoteHTML,
} from '../core/zotero-note-bridge.js';
import {
    noteMathPlaceholder,
    replaceNoteMathPlaceholders,
    rewriteNoteHighlightMath,
} from '../core/zotero-note-math.js';
import {
    noteMathSegmentsText,
    noteSegmentTextKey,
} from '../markdown/markdown-visible-text.js';

const MAX_LISTED_NOTES = 500;
const MAX_NOTE_ANNOTATIONS = 5_000;
const NOTIFY_DELAY_MS = 150;
const EDITOR_INSTANCE_WAIT_MS = 10_000;
const EDITOR_INSTANCE_POLL_MS = 25;

// Zotero notes of the paper a Mktero tab shows. The notes are ordinary
// Zotero note items under the PDF's parent item, edited with Zotero's own
// `note-editor`. Mktero stores nothing about them.
//
// Everything used here exists in Zotero 7.0 through 10.0: `note-editor`,
// `getCurrentInstance()`, `EditorInstance.insertAnnotations()`,
// `EditorInstance.createNoteFromAnnotations()`, `Annotations.toJSON()`, and
// `ZoteroPane.openNoteWindow()`.
//
// A highlight with formulas is inserted the way `insertAnnotations()` itself
// inserts one: `serializeAnnotations()`, then the editor's `insertHTML`
// message. Those two steps are not public API, so each is checked and a
// missing one keeps the plain `insertAnnotations()`.
export function createZoteroNotes(zotero, {
    getMainWindow = () => zotero?.getMainWindow?.() || null,
    isSnapshotNote = () => false,
    parseHTML = html => {
        const DOMParser = getMainWindow()?.DOMParser;
        if (typeof DOMParser !== 'function') return null;
        return new DOMParser().parseFromString(html, 'text/html');
    },
    setTimeout = (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimeout = timer => globalThis.clearTimeout(timer),
    delay = milliseconds => new Promise(resolve => (
        globalThis.setTimeout(resolve, milliseconds)
    )),
} = {}) {
    const observers = new Set();
    let notifierID = null;
    let notifyTimer = null;

    const attachmentFor = itemID => {
        const attachment = zotero?.Items?.get?.(itemID);
        return attachment?.isPDFAttachment?.() ? attachment : null;
    };
    const parentFor = attachment => {
        const parentID = attachment?.parentID ?? attachment?.parentItemID;
        if (!parentID) return null;
        const parent = zotero.Items.get(parentID);
        return parent?.isRegularItem?.() ? parent : null;
    };
    const libraryEditable = libraryID => (
        zotero?.Libraries?.get?.(libraryID)?.editable !== false
    );

    const scheduleNotify = () => {
        if (notifyTimer !== null || !observers.size) return;
        notifyTimer = setTimeout(() => {
            notifyTimer = null;
            for (const observer of [...observers]) {
                try {
                    observer();
                }
                catch (error) {
                    zotero?.logError?.(error);
                }
            }
        }, NOTIFY_DELAY_MS);
    };
    const ensureNotifier = () => {
        if (notifierID !== null
            || typeof zotero?.Notifier?.registerObserver !== 'function') {
            return;
        }
        notifierID = zotero.Notifier.registerObserver({
            notify: (_event, type) => {
                if (type === 'item') scheduleNotify();
            },
        }, ['item'], 'mktero-notes');
    };
    const releaseNotifier = () => {
        if (notifyTimer !== null) {
            clearTimeout(notifyTimer);
            notifyTimer = null;
        }
        if (notifierID === null) return;
        try {
            zotero.Notifier.unregisterObserver?.(notifierID);
        }
        catch (error) {
            zotero?.logError?.(error);
        }
        notifierID = null;
    };

    // The editor is created in the tab's own window: a Mktero tab can be in
    // any main window, and a XUL element cannot move between documents.
    const editorDocument = (window = getMainWindow()) => {
        const document = window?.document;
        if (typeof document?.createXULElement !== 'function'
            || typeof window?.customElements?.get !== 'function'
            || !window.customElements.get('note-editor')) {
            return null;
        }
        return document;
    };

    return {
        // Resolves the column's state for one PDF attachment:
        // { status: 'ready', notes, editable, annotationCount }, or a
        // status of 'no-parent' (a standalone PDF) or 'unavailable'.
        async list(attachmentID) {
            const attachment = attachmentFor(attachmentID);
            if (!attachment) {
                return { status: 'unavailable', notes: [], editable: false, annotationCount: 0 };
            }
            const annotationCount = await countNoteAnnotations(zotero, attachment);
            const parent = parentFor(attachment);
            if (!parent) {
                return { status: 'no-parent', notes: [], editable: false, annotationCount };
            }
            await zotero.Items.loadDataTypes?.([parent], ['childItems']);
            // Newest first, then the limit: Zotero returns child notes in
            // its own order, so cutting first could drop the note being
            // written.
            const items = (parent.getNotes?.(false) || [])
                .map(id => zotero.Items.get(id))
                .filter(item => item?.isNote?.() && !item.deleted)
                .sort((left, right) => (
                    String(right.dateModified || '').localeCompare(
                        String(left.dateModified || '')
                    )
                ))
                .slice(0, MAX_LISTED_NOTES);
            await zotero.Items.loadDataTypes?.(items, ['note']);
            const notes = items
                .filter(item => {
                    // A note that cannot be checked might be a snapshot,
                    // and a snapshot must never be listed or edited here.
                    try {
                        return !isSnapshotNote(item);
                    }
                    catch {
                        return false;
                    }
                })
                .map(item => noteEntry(zotero, item));
            return {
                status: 'ready',
                notes,
                editable: libraryEditable(parent.libraryID)
                    && !parent.deleted
                    && !attachment.deleted,
                annotationCount,
            };
        },

        canHostEditor({ window } = {}) {
            return Boolean(editorDocument(window || getMainWindow()));
        },

        // Mounts Zotero's note editor in `container` for an existing note
        // (`noteID`) or a new child note of the PDF's parent item. A new note
        // is saved by the editor on the first edit, as in Zotero's own panes.
        async mountEditor(container, {
            attachmentID,
            noteID = null,
            focus = true,
            window = null,
        } = {}) {
            const document = editorDocument(
                window || container?.ownerDocument?.defaultView || getMainWindow()
            );
            const containerDocument = container?.ownerDocument;
            if (!document
                || !container
                || (containerDocument && containerDocument !== document)) {
                throw noteBridgeError(
                    NOTE_EDITOR_UNAVAILABLE,
                    'The Zotero note editor cannot be shown here'
                );
            }
            const item = noteID
                ? zotero.Items.get(noteID)
                : newChildNote(zotero, parentFor(attachmentFor(attachmentID)));
            if (!item?.isNote?.()) throw new Error('The note is unavailable');
            if (noteID) await zotero.Items.loadDataTypes?.([item], ['note']);
            const editable = noteEditable(zotero, item);
            const parentID = item.parentID ?? null;
            const editor = document.createXULElement('note-editor');
            editor.setAttribute('flex', '1');
            editor.classList.add('mktero-note-editor');
            // The host is an HTML flex column; the XUL flex attribute alone
            // does not stretch the editor there.
            if (editor.style) {
                Object.assign(editor.style, {
                    display: 'flex',
                    flex: '1 1 auto',
                    minHeight: '0',
                });
            }
            container.replaceChildren(editor);
            editor.mode = editable ? 'edit' : 'view';
            editor.item = item;
            // The editor's own parent line would repeat the paper the tab
            // already shows, as in Zotero's context pane.
            editor.parentItem = null;
            if (focus) void editor.focus?.();
            let destroyed = false;
            const instance = () => waitForEditorInstance(editor, {
                delay,
                isDestroyed: () => destroyed,
            });
            return {
                get noteID() {
                    return item.id || null;
                },
                // True once a saved note was deleted, trashed, or moved to
                // another item. An unsaved new note is never gone.
                isGone() {
                    if (!item.id) return false;
                    const current = zotero.Items.get(item.id);
                    return !current?.isNote?.()
                        || current.deleted === true
                        || (parentID !== null && current.parentID !== parentID);
                },
                editable,
                // `segmentsFor(annotation, index)` may give the text and
                // formulas of an annotation, so the note shows its formulas.
                async insertAnnotations(annotations, { segmentsFor = null } = {}) {
                    if (!editable) {
                        throw noteBridgeError(
                            NOTE_EDITOR_UNAVAILABLE,
                            'The note is read-only'
                        );
                    }
                    const editorInstance = await instance();
                    editorInstance.focus?.();
                    const inserted = await insertAnnotationsWithMath(
                        zotero,
                        editorInstance,
                        annotations,
                        { segmentsFor, parseHTML }
                    );
                    if (!inserted) await editorInstance.insertAnnotations(annotations);
                },
                focus() {
                    return editor.focus?.();
                },
                save() {
                    try {
                        editor.saveSync?.();
                    }
                    catch (error) {
                        zotero?.logError?.(error);
                    }
                },
                destroy() {
                    if (destroyed) return;
                    this.save();
                    destroyed = true;
                    editor.remove();
                },
            };
        },

        // Fallback when the editor cannot be hosted: Zotero's note window.
        // A new note is saved first because the window opens an item id.
        async openInWindow({ attachmentID, noteID = null, window = null } = {}) {
            let id = noteID;
            if (!id) {
                const note = newChildNote(zotero, parentFor(attachmentFor(attachmentID)));
                await note.saveTx();
                id = note.id;
            }
            const pane = (window?.ZoteroPane ? window : getMainWindow())?.ZoteroPane;
            if (typeof pane?.openNoteWindow === 'function') {
                return pane.openNoteWindow(id);
            }
            if (typeof pane?.openNote === 'function') {
                return pane.openNote(id, { openInWindow: true });
            }
            throw noteBridgeError(NOTES_UNAVAILABLE, 'Zotero cannot open the note');
        },

        // "Show in Library" from Zotero's notes pane: select the note in the
        // library tab of the tab's own window.
        async showInLibrary({ noteID, window = null } = {}) {
            const target = window?.ZoteroPane ? window : getMainWindow();
            const pane = target?.ZoteroPane;
            const item = zotero.Items.get(noteID);
            if (!item?.isNote?.() || typeof pane?.selectItem !== 'function') {
                throw noteBridgeError(NOTES_UNAVAILABLE, 'The note cannot be shown');
            }
            const selected = pane.selectItem(noteID);
            target.Zotero_Tabs?.select?.('zotero-pane');
            await selected;
        },

        // "Move to Trash" from Zotero's notes pane. The trash can restore it.
        async moveToTrash({ noteID } = {}) {
            const item = zotero.Items.get(noteID);
            if (!item?.isNote?.() || item.deleted) return;
            if (!noteEditable(zotero, item)) {
                throw new Error('The note is read-only');
            }
            await zotero.Items.trashTx([noteID]);
        },

        // A new child note with every non-ink annotation of the PDF, the
        // same note Zotero's "Add Note from Annotations" creates.
        // `segmentsFor(key)` may give an annotation's text and formulas; the
        // note is then saved once more with the formulas in its highlights.
        async createFromAnnotations(attachmentID, { segmentsFor = null } = {}) {
            const attachment = attachmentFor(attachmentID);
            const parent = parentFor(attachment);
            if (!parent) {
                throw noteBridgeError(
                    NOTE_NO_PARENT_ITEM,
                    'A standalone PDF cannot have child notes'
                );
            }
            const annotations = await noteAnnotationItems(zotero, attachment);
            if (!annotations.length) {
                throw noteBridgeError(
                    NOTE_ANNOTATION_NOT_IN_PDF,
                    'The PDF has no annotations'
                );
            }
            const create = zotero?.EditorInstance?.createNoteFromAnnotations;
            if (typeof create !== 'function') {
                throw noteBridgeError(NOTES_UNAVAILABLE, 'Zotero cannot create the note');
            }
            const note = await create.call(
                zotero.EditorInstance,
                annotations,
                { parentID: parent.id }
            );
            if (note && typeof segmentsFor === 'function') {
                await rewriteSavedNoteMath(zotero, note, segmentsFor, parseHTML);
            }
            return { noteID: note?.id ?? null };
        },

        // Reader JSON of saved Zotero annotations of this PDF, in page order,
        // ready for `insertAnnotations()`.
        async annotationsForNote(attachmentID, keys) {
            const attachment = attachmentFor(attachmentID);
            if (!attachment) throw new Error('PDF attachment is unavailable');
            const items = [...new Set((keys || []).map(String).filter(Boolean))]
                .slice(0, MAX_NOTE_ANNOTATIONS)
                .map(key => zotero.Items.getByLibraryAndKey?.(
                    attachment.libraryID,
                    key
                ))
                .filter(item => item?.isAnnotation?.()
                    && item.parentID === attachment.id
                    && !item.deleted);
            if (!items.length) {
                throw noteBridgeError(
                    NOTE_ANNOTATION_NOT_IN_PDF,
                    'The annotation is not in the PDF'
                );
            }
            await zotero.Items.loadDataTypes?.(
                items,
                ['annotation', 'annotationDeferred']
            );
            const toJSON = zotero?.Annotations?.toJSON;
            if (typeof toJSON !== 'function') {
                throw noteBridgeError(NOTES_UNAVAILABLE, 'Zotero annotations are unavailable');
            }
            const json = [];
            for (const item of items) {
                json.push(annotationJSONForNote(
                    await toJSON.call(zotero.Annotations, item),
                    { attachmentItemID: attachment.id, key: item.key }
                ));
            }
            return json.sort((left, right) => (
                String(left.sortIndex || '').localeCompare(String(right.sortIndex || ''))
            ));
        },

        // Calls `listener` (debounced) after Zotero items change.
        observe(listener) {
            if (typeof listener !== 'function') return () => {};
            observers.add(listener);
            ensureNotifier();
            return () => {
                observers.delete(listener);
                if (!observers.size) releaseNotifier();
            };
        },

        dispose() {
            observers.clear();
            releaseNotifier();
        },
    };
}

function newChildNote(zotero, parent) {
    if (!parent) {
        throw noteBridgeError(
            NOTE_NO_PARENT_ITEM,
            'A standalone PDF cannot have child notes'
        );
    }
    if (zotero?.Libraries?.get?.(parent.libraryID)?.editable === false) {
        throw noteBridgeError(NOTE_EDITOR_UNAVAILABLE, 'The library is read-only');
    }
    const note = new zotero.Item('note');
    note.libraryID = parent.libraryID;
    note.parentID = parent.id;
    return note;
}

function noteEditable(zotero, item) {
    if (zotero?.Libraries?.get?.(item.libraryID)?.editable === false) return false;
    if (item.deleted) return false;
    const parentID = item.parentID;
    if (parentID && zotero.Items.get(parentID)?.deleted) return false;
    return item.isEditable?.() !== false;
}

function noteEntry(zotero, item) {
    let html = '';
    try {
        html = String(item.getNote?.() || '');
    }
    catch {
        html = '';
    }
    let title = '';
    try {
        title = String(item.getNoteTitle?.() || '');
    }
    catch {
        title = '';
    }
    const summary = summarizeNoteHTML(html, { title });
    const dateModified = String(item.dateModified || '');
    return {
        id: item.id,
        key: String(item.key || ''),
        title: summary.title,
        preview: summary.preview,
        dateModified,
        dateLabel: friendlyDate(zotero, dateModified),
    };
}

function friendlyDate(zotero, sqlDate) {
    if (!sqlDate) return '';
    try {
        const date = zotero?.Date?.sqlToDate?.(sqlDate, true);
        if (!date) return '';
        return String(zotero.Date.toFriendlyDate?.(date) || '');
    }
    catch {
        return '';
    }
}

async function noteAnnotationItems(zotero, attachment) {
    if (!attachment) return [];
    await zotero.Items.loadDataTypes?.([attachment], ['childItems']);
    const annotations = attachment.getAnnotations?.(false) || [];
    if (!Array.isArray(annotations) || annotations.length > MAX_NOTE_ANNOTATIONS) {
        return [];
    }
    await zotero.Items.loadDataTypes?.(
        annotations,
        ['annotation', 'annotationDeferred']
    );
    return annotations.filter(annotation => annotation?.annotationType !== 'ink');
}

async function countNoteAnnotations(zotero, attachment) {
    try {
        return (await noteAnnotationItems(zotero, attachment)).length;
    }
    catch (error) {
        zotero?.logError?.(error);
        return 0;
    }
}

// `note-editor` creates its EditorInstance after its iframe loads, and the
// instance is usable once its init promise settles. Both waits share one
// deadline, so a stuck editor fails instead of hanging the insert.
async function waitForEditorInstance(editor, { delay, isDestroyed }) {
    const attempts = Math.ceil(EDITOR_INSTANCE_WAIT_MS / EDITOR_INSTANCE_POLL_MS);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (isDestroyed()) break;
        const instance = editor.getCurrentInstance?.();
        if (instance) {
            const ready = await Promise.race([
                Promise.resolve(instance._initPromise).then(() => true, () => false),
                delay((attempts - attempt) * EDITOR_INSTANCE_POLL_MS).then(() => false),
            ]);
            if (ready && !isDestroyed()) return instance;
            break;
        }
        await delay(EDITOR_INSTANCE_POLL_MS);
    }
    throw noteBridgeError(
        NOTE_EDITOR_UNAVAILABLE,
        'The Zotero note editor is not ready'
    );
}

// The segments `segmentsFor` gives an annotation, when their text is the
// annotation's: a passage the reader matched loosely keeps Zotero's text.
function verifiedSegments(segments, text) {
    if (!Array.isArray(segments) || !segments.some(item => item?.type === 'math')) {
        return null;
    }
    const expected = noteSegmentTextKey(text);
    return expected && expected === noteSegmentTextKey(noteMathSegmentsText(segments))
        ? segments
        : null;
}

// Inserts `annotations` with their formulas, the way
// `EditorInstance.insertAnnotations()` inserts them without. Returns false
// before changing the note when the formulas cannot be inserted, so the
// caller inserts the annotations as before.
async function insertAnnotationsWithMath(
    zotero,
    editorInstance,
    annotations,
    { segmentsFor, parseHTML }
) {
    if (typeof segmentsFor !== 'function' || !Array.isArray(annotations)) {
        return false;
    }
    const serialize = zotero?.EditorInstanceUtilities?.serializeAnnotations;
    if (typeof serialize !== 'function'
        || typeof editorInstance?._postMessage !== 'function'
        || typeof editorInstance._ensureNoteCreated !== 'function') {
        return false;
    }
    // An image is imported into the note first; leave those to Zotero.
    if (annotations.some(annotation => annotation?.image || annotation?.type === 'image')) {
        return false;
    }
    const segmentsByIndex = new Map();
    const prepared = annotations.map((annotation, index) => {
        let segments = null;
        try {
            segments = verifiedSegments(
                segmentsFor(annotation, index),
                annotation?.text
            );
        }
        catch (error) {
            zotero?.logError?.(error);
        }
        if (!segments) return annotation;
        segmentsByIndex.set(index, segments);
        return { ...annotation, text: noteMathPlaceholder(index) };
    });
    if (!segmentsByIndex.size) return false;
    let html;
    try {
        const serialized = serialize.call(
            zotero.EditorInstanceUtilities,
            prepared
        );
        html = replaceNoteMathPlaceholders(
            typeof serialized === 'string' ? serialized : String(serialized?.html || ''),
            segmentsByIndex,
            { parseHTML }
        );
    }
    catch (error) {
        zotero?.logError?.(error);
        return false;
    }
    if (!html) return false;
    await editorInstance._ensureNoteCreated();
    editorInstance._postMessage({ action: 'insertHTML', pos: null, html });
    return true;
}

// Puts formulas into the highlights of a note Zotero just created. A failure
// leaves the note as Zotero wrote it, in memory as in the database.
async function rewriteSavedNoteMath(zotero, note, segmentsFor, parseHTML) {
    let original = null;
    let changed = false;
    try {
        const html = String(note.getNote?.() || '');
        if (!html) return;
        original = html;
        const rewritten = rewriteNoteHighlightMath(
            html,
            key => {
                const segments = segmentsFor(key);
                return Array.isArray(segments)
                    && segments.some(item => item?.type === 'math')
                    ? segments
                    : null;
            },
            { parseHTML }
        );
        if (!rewritten || rewritten === html) return;
        note.setNote(rewritten);
        changed = true;
        await note.saveTx();
    }
    catch (error) {
        zotero?.logError?.(error);
        if (changed && original !== null) {
            try {
                note.setNote(original);
            }
            catch (restoreError) {
                zotero?.logError?.(restoreError);
            }
        }
    }
}
