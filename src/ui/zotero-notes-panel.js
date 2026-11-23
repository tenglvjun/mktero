import {
    NOTE_EDITOR_UNAVAILABLE,
    NOTE_REVIEW_UNCONFIRMED,
    NOTE_TARGET_CHANGED,
} from '../core/zotero-note-bridge.js';
import { createLucideIcon, LUCIDE_ICONS } from '../icons/lucide-icon.js';
import { createNativeContextMenu } from './native-context-menu.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
export const NOTE_EDITOR_SLOT = 'mktero-note-editor';

const NOTE_SCOPES = Object.freeze(['item', 'standalone']);
const NOTE_SCOPE_LABEL_KEYS = Object.freeze({
    item: 'notes.itemNotes',
    standalone: 'notes.standalone',
});
const NOTE_SCOPE_EMPTY_KEYS = Object.freeze({
    item: 'notes.itemEmpty',
    standalone: 'notes.standaloneEmpty',
});

// The right column of a Mktero tab: the current paper's child notes and the
// standalone notes of the paper's Zotero library. The list lives in the
// reader's shadow tree. Zotero's `note-editor` cannot: it needs the chrome
// document's styles and l10n, so it is mounted in a light-DOM container on the
// shadow host and slotted into the column.
//
// `adapter` is the tab's notes bridge (see `createTabNotesBridge` in
// bootstrap): list, canHostEditor, mountEditor, openInWindow,
// createFromAnnotations, showInLibrary, moveToTrash, and observe. Without
// one the column is unavailable.
//
// Right-clicking a note opens the same menu as a note in Zotero's own notes
// pane: Show in Library, Edit in a Separate Window, and Move to Trash.
export function createZoteroNotesPanel(options) {
    return new ZoteroNotesPanel(options);
}

class ZoteroNotesPanel {
    constructor({
        document,
        host,
        aside,
        translate,
        onStateChange = () => {},
        onEditorClose = () => {},
        onError = () => {},
        createContextMenu = createNativeContextMenu,
    }) {
        this.document = document;
        this.host = host;
        this.aside = aside;
        this.t = translate;
        this.onStateChange = onStateChange;
        this.onEditorClose = onEditorClose;
        this.onError = onError;
        this.contextMenu = createContextMenu(document);
        this.adapter = null;
        this.disposeObserver = null;
        this.generation = 0;
        this.destroyed = false;
        this.state = {
            status: 'unavailable',
            notes: [],
            editable: false,
            canCreateItemNote: false,
            canCreateStandaloneNote: false,
            annotationCount: 0,
        };
        this.noteQuery = '';
        this.noteScope = 'item';
        this.mode = 'list';
        this.handle = null;
        this.openingNote = false;
        this.researchActionPending = false;
        this.choosingResearchNote = false;
        this.review = null;
        this.continuationHintVisible = false;
        // Bumped whenever the open editor is closed, so a mount that finishes
        // after the reader went back (or switched adapter) is discarded.
        this.editorToken = 0;
        this.editorContainer = null;
        this.elements = this.createContent();
        this.render();
    }

    get available() {
        return Boolean(this.adapter);
    }

    // The column can take annotations only while an editable note is open in
    // it, the same rule Zotero's reader applies to "Add to Note".
    get canInsert() {
        return Boolean(this.handle?.editable) && this.mode === 'editor';
    }

    get canPrepareInsert() {
        if (this.mode === 'editor') return this.canInsert;
        return !this.openingNote
            && this.state.researchNote?.status === 'ready'
            && this.adapter?.canHostEditor?.(this.hostContext()) === true;
    }

    get insertTargetIdentity() {
        if (this.mode === 'editor') {
            if (!this.handle) return null;
            return this.handle.noteID
                ? `note:${this.handle.noteID}`
                : `editor:${this.editorToken}`;
        }
        const id = this.state.researchNote?.note?.id;
        return this.state.researchNote?.status === 'ready' && id ? `note:${id}` : null;
    }

    get insertTargetTitle() {
        if (this.mode === 'editor') {
            return this.handle?.title
                || this.state.notes.find(note => note.id === this.handle?.noteID)?.title
                || '';
        }
        return this.state.researchNote?.status === 'ready'
            ? this.state.researchNote.note?.title || this.t('notes.untitled')
            : '';
    }

    async pinResearchNote(noteID = this.handle?.noteID) {
        if (!noteID || !this.adapter?.pinResearchNote) return;
        await this.adapter.pinResearchNote(noteID);
        await this.refresh();
    }

    async createResearchNote() {
        const adapter = this.adapter;
        if (!adapter?.createResearchNote || !this.state.canCreateStandaloneNote
            || this.openingNote || this.researchActionPending) return;
        const token = this.editorToken;
        this.researchActionPending = true;
        this.render();
        try {
            const result = await adapter.createResearchNote({ title: this.t('notes.researchNote') });
            if (this.destroyed || adapter !== this.adapter || token !== this.editorToken) return;
            if (!result?.noteID) throw unavailableNote();
            this.choosingResearchNote = false;
            await this.refresh();
            if (this.destroyed || adapter !== this.adapter || token !== this.editorToken) return;
            await this.openNote(result.noteID);
        }
        finally {
            if (adapter === this.adapter && !this.destroyed) {
                this.researchActionPending = false;
                this.render();
            }
        }
    }

    chooseResearchNote() {
        if (!this.adapter?.pinResearchNote || this.openingNote || this.researchActionPending) return;
        this.closeReview();
        this.closeEditor();
        this.choosingResearchNote = true;
        this.noteScope = 'standalone';
        this.noteQuery = '';
        this.elements.searchInput.value = '';
        this.syncNoteScopeButtons();
        this.render();
        if (!this.elements.search.hidden) this.elements.searchInput.focus();
    }

    async selectResearchNote(noteID) {
        const adapter = this.adapter;
        if (!adapter?.pinResearchNote || this.researchActionPending) return;
        const token = this.editorToken;
        this.researchActionPending = true;
        this.render();
        try {
            await adapter.pinResearchNote(noteID);
            if (this.destroyed || adapter !== this.adapter || token !== this.editorToken) return;
            this.choosingResearchNote = false;
            await this.refresh();
            if (this.destroyed || adapter !== this.adapter || token !== this.editorToken) return;
            await this.openNote(noteID);
        }
        finally {
            if (adapter === this.adapter && !this.destroyed) {
                this.researchActionPending = false;
                this.render();
            }
        }
    }

    async clearResearchNote() {
        if (!this.adapter?.clearResearchNote) return;
        this.closeReview();
        await this.adapter.clearResearchNote();
        await this.refresh();
    }

    async continueResearchNote() {
        const adapter = this.adapter;
        const token = this.editorToken;
        const expected = this.state.researchNote?.note?.id;
        if (!expected || !adapter?.getResearchNote) throw unavailableNote();
        const target = await adapter.getResearchNote();
        if (this.destroyed || adapter !== this.adapter || token !== this.editorToken
            || target?.note?.id !== expected
            || !['ready', 'readonly'].includes(target.status)) {
            throw unavailableNote();
        }
        if (this.handle?.noteID === expected && this.mode === 'editor') return;
        await this.openNote(expected);
    }

    isCurrentReview(review) {
        return !this.destroyed && this.review === review && this.adapter === review.adapter
            && this.state.researchNote?.note?.id === review.noteID;
    }

    closeReview({ focus = false } = {}) {
        if (!this.review) return;
        this.review = null;
        this.render();
        if (focus) this.elements.researchReread.focus();
    }

    async openReview() {
        const target = this.state.researchNote;
        const adapter = this.adapter;
        if (!target?.note?.id || !adapter?.listResearchNoteExcerpts || this.review) return;
        const review = {
            adapter, noteID: target.note.id, excerpts: [], selected: new Set(),
            visible: true, loading: true, writing: false, status: '',
        };
        this.review = review;
        this.render();
        this.elements.reviewBack.focus();
        await this.loadReview(review);
    }

    async loadReview(review) {
        const { adapter, noteID } = review;
        const request = {};
        review.load = request;
        const isCurrent = () => this.isCurrentReview(review) && review.load === request;
        try {
            const result = await adapter.listResearchNoteExcerpts(noteID, {
                editorHandle: this.handle,
            });
            if (!isCurrent()) return;
            review.excerpts = result.excerpts;
            const availableIDs = new Set(result.excerpts.filter(row => row.available).map(row => row.id));
            for (const id of review.selected) {
                if (!availableIDs.has(id)) review.selected.delete(id);
            }
            review.savedOnly = result.savedOnly;
        }
        catch {
            if (isCurrent()) review.status = 'notes.reviewUnavailable';
        }
        finally {
            if (isCurrent()) {
                review.loading = false;
                this.render();
            }
        }
    }

    async openReviewSource(review, id) {
        if (!this.isCurrentReview(review)) return;
        try {
            await review.adapter.openResearchNoteExcerpt(review.noteID, id, {
                editorHandle: this.handle,
                ...this.hostContext(),
                isCurrent: () => this.isCurrentReview(review),
            });
        }
        catch {
            if (!this.isCurrentReview(review)) return;
            review.status = 'notes.reviewSourceUnavailable';
            await this.loadReview(review);
        }
    }

    async appendReview() {
        const review = this.review;
        if (!review || review.writing || !review.selected.size) return;
        review.writing = true;
        review.status = '';
        const ensureCurrent = () => this.isCurrentReview(review);
        this.render();
        try {
            if (this.handle?.noteID !== review.noteID || this.mode !== 'editor') {
                await this.continueResearchNote();
            }
            if (!ensureCurrent()) return;
            const handle = this.handle;
            if (!handle?.appendResearchNoteReview || handle.noteID !== review.noteID || !handle.editable) {
                review.status = 'notes.reviewWriteUnavailable';
                return;
            }
            const token = this.editorToken;
            const ids = review.excerpts.filter(row => review.selected.has(row.id)).map(row => row.id);
            review.visible = false;
            this.render();
            await handle.appendResearchNoteReview(ids, {
                title: this.t('notes.reviewTitle'),
                question: this.t('notes.reviewQuestion'),
                excerpts: this.t('notes.reviewExcerpts'),
                judgment: this.t('notes.reviewJudgment'),
            }, () => ensureCurrent() && this.handle === handle && this.editorToken === token);
            if (ensureCurrent()) this.closeReview();
        }
        catch (error) {
            if (!ensureCurrent()) return;
            if (error?.code === NOTE_TARGET_CHANGED) {
                review.visible = true;
                review.status = 'notes.reviewExcerptsChanged';
                await this.loadReview(review);
            }
            else if (error?.code === NOTE_REVIEW_UNCONFIRMED) {
                this.closeReview();
                this.elements.reviewEditorStatus.hidden = false;
                this.elements.reviewEditorStatus.textContent = this.t('notes.reviewWriteUnavailable');
            }
            else {
                review.status = 'notes.reviewWriteUnavailable';
                review.visible = true;
                review.selected.clear();
                await this.loadReview(review);
            }
        }
        finally {
            if (ensureCurrent()) {
                review.writing = false;
                this.render();
            }
        }
    }

    // Capture one editor before PDF location starts. A user switching notes
    // during that asynchronous lookup must never receive a delayed insertion.
    async prepareInsert() {
        if (!this.canPrepareInsert) throw unavailableNote();
        if (this.mode !== 'editor') await this.continueResearchNote();
        const handle = this.handle;
        const adapter = this.adapter;
        const token = this.editorToken;
        if (!this.canInsert || !handle) throw unavailableNote();
        return {
            insertAnnotations: async (annotations, options) => {
                if (this.destroyed || this.handle !== handle || this.adapter !== adapter
                    || this.editorToken !== token || !handle.editable || handle.isGone?.()) {
                    throw unavailableNote();
                }
                this.continuationHintVisible = false;
                this.renderContinuationHint();
                await handle.insertAnnotations(annotations, options);
                if (!this.destroyed && this.handle === handle && this.adapter === adapter
                    && this.editorToken === token && handle.editable && !handle.isGone?.()) {
                    this.continuationHintVisible = true;
                    this.renderContinuationHint();
                }
            },
        };
    }

    get annotationCount() {
        return this.state.annotationCount || 0;
    }

    get canCreateFromAnnotations() {
        return this.available
            && this.state.status === 'ready'
            && this.state.editable
            && this.annotationCount > 0;
    }

    setAdapter(adapter) {
        if (adapter === this.adapter) return;
        this.disposeObserver?.();
        this.disposeObserver = null;
        this.review = null;
        this.closeEditor();
        this.choosingResearchNote = false;
        this.researchActionPending = false;
        // Drop a list() already in flight. Replacing the bridge with nothing
        // does not start a new refresh, so the generation has to move here.
        this.generation += 1;
        this.adapter = adapter || null;
        if (this.adapter?.observe) {
            this.disposeObserver = this.adapter.observe(() => {
                void this.refresh();
            });
        }
        this.state = {
            status: this.adapter ? 'loading' : 'unavailable',
            notes: [],
            editable: false,
            canCreateItemNote: false,
            canCreateStandaloneNote: false,
            annotationCount: 0,
        };
        this.noteQuery = '';
        this.noteScope = 'item';
        if (this.elements?.searchInput) this.elements.searchInput.value = '';
        this.render();
        if (this.adapter) void this.refresh();
    }

    async refresh() {
        if (!this.adapter || this.destroyed) return;
        const generation = ++this.generation;
        const adapter = this.adapter;
        let state;
        try {
            state = await adapter.list();
        }
        catch (error) {
            if (this.destroyed
                || generation !== this.generation
                || adapter !== this.adapter) {
                return;
            }
            this.onError(error);
            state = {
                status: 'unavailable',
                notes: [],
                editable: false,
                canCreateItemNote: false,
                canCreateStandaloneNote: false,
                annotationCount: 0,
            };
        }
        if (this.destroyed
            || generation !== this.generation
            || adapter !== this.adapter) {
            return;
        }
        this.state = {
            status: state?.status || 'unavailable',
            notes: Array.isArray(state?.notes) ? state.notes : [],
            editable: state?.editable === true,
            canCreateItemNote: state?.canCreateItemNote === undefined
                ? state?.editable === true
                : state.canCreateItemNote === true,
            canCreateStandaloneNote: state?.canCreateStandaloneNote === undefined
                ? state?.editable === true
                : state.canCreateStandaloneNote === true,
            researchNote: state?.researchNote || { status: 'none' },
            annotationCount: Number.isSafeInteger(state?.annotationCount)
                ? state.annotationCount
                : 0,
        };
        if (this.review && !this.isCurrentReview(this.review)) this.review = null;
        // A note deleted elsewhere cannot stay open. Only the handle can say
        // so: a list can lag behind a note's first save, can be cut at its
        // limit, or can have failed, and none of those means the note is gone.
        if (this.mode === 'editor' && this.handle?.isGone?.() === true) {
            this.closeEditor();
        }
        this.render();
    }

    async openNote(noteID) {
        if (!this.adapter || this.openingNote) return;
        if (!this.adapter.canHostEditor?.(this.hostContext())) {
            await this.runAction(() => this.adapter.openInWindow({
                noteID,
                ...this.hostContext(),
            }));
            return;
        }
        await this.showEditor({ noteID });
    }

    async createNote(noteKind = 'item') {
        if (!this.adapter || this.openingNote) return;
        const canCreate = noteKind === 'standalone'
            ? this.state.canCreateStandaloneNote
            : this.state.canCreateItemNote;
        if (!canCreate) return;
        if (!this.adapter.canHostEditor?.(this.hostContext())) {
            await this.runAction(() => this.adapter.openInWindow({
                noteKind,
                ...this.hostContext(),
            }));
            return;
        }
        await this.showEditor({ noteID: null, noteKind });
    }

    setNoteScope(scope) {
        if (!NOTE_SCOPES.includes(scope) || this.noteScope === scope) return;
        this.noteScope = scope;
        this.noteQuery = '';
        if (this.elements?.searchInput) this.elements.searchInput.value = '';
        this.syncNoteScopeButtons();
        this.render();
    }

    scopeNotes() {
        return this.state.notes.filter(note => (
            (note.kind || 'item') === this.noteScope
        ));
    }

    syncNoteScopeButtons() {
        for (const button of this.elements.noteScopeButtons) {
            const selected = button.getAttribute('data-note-scope') === this.noteScope;
            button.setAttribute('aria-selected', selected ? 'true' : 'false');
            button.textContent = this.t(
                NOTE_SCOPE_LABEL_KEYS[button.getAttribute('data-note-scope')]
            );
        }
        this.elements.noteScopes.setAttribute('aria-label', this.t('notes.scopes'));
        this.elements.list.setAttribute(
            'aria-labelledby',
            `mktero-zotero-notes-tab-${this.noteScope}`
        );
    }

    // `options.segmentsFor` passes each annotation's text and formulas on to
    // the note, so the note shows the formulas the reader shows.
    async createFromAnnotations(options = undefined) {
        if (!this.adapter) return;
        const result = options === undefined
            ? await this.adapter.createFromAnnotations()
            : await this.adapter.createFromAnnotations(options);
        await this.refresh();
        if (result?.noteID) await this.openNote(result.noteID);
    }

    async insertAnnotations(annotations, options = undefined) {
        if (!this.canInsert) {
            const error = new Error('No note is open');
            error.code = NOTE_EDITOR_UNAVAILABLE;
            throw error;
        }
        const handle = this.handle;
        const token = this.editorToken;
        this.continuationHintVisible = false;
        this.renderContinuationHint();
        if (options === undefined) {
            await handle.insertAnnotations(annotations);
        }
        else {
            await handle.insertAnnotations(annotations, options);
        }
        if (!this.destroyed && this.handle === handle && this.editorToken === token
            && handle.editable && !handle.isGone?.()) {
            this.continuationHintVisible = true;
            this.renderContinuationHint();
        }
    }

    back() {
        this.closeEditor();
        this.render();
        void this.refresh();
    }

    async openCurrentInWindow() {
        const noteID = this.handle?.noteID;
        if (!noteID || !this.adapter) return;
        this.closeEditor();
        this.render();
        await this.runAction(() => this.adapter.openInWindow({
            noteID,
            ...this.hostContext(),
        }));
    }

    syncLocalization() {
        const { elements } = this;
        elements.titleLabel.textContent = this.t('viewer.notesTitle');
        this.aside.setAttribute('aria-label', this.t('viewer.notes'));
        setLabel(elements.newButton, this.t('notes.newNote'));
        for (const button of elements.noteScopeButtons) {
            button.textContent = this.t(
                NOTE_SCOPE_LABEL_KEYS[button.getAttribute('data-note-scope')]
            );
        }
        elements.noteScopes.setAttribute('aria-label', this.t('notes.scopes'));
        elements.searchInput.setAttribute('aria-label', this.t('notes.search'));
        elements.searchInput.setAttribute('placeholder', this.t('notes.searchPlaceholder'));
        setLabel(elements.backButton, this.t('notes.backToList'));
        setLabel(elements.windowButton, this.t('notes.openInWindow'));
        this.render();
    }

    destroy() {
        if (this.destroyed) return;
        this.disposeObserver?.();
        this.disposeObserver = null;
        this.review = null;
        this.closeEditor();
        this.editorContainer?.remove();
        this.editorContainer = null;
        this.contextMenu?.destroy();
        this.contextMenu = null;
        this.destroyed = true;
        this.adapter = null;
    }

    // The menu Zotero's notes pane shows for a note, for a note of the list.
    openNoteMenu(noteID, { screenX, screenY, anchor } = {}) {
        if (!this.contextMenu || !this.adapter || this.destroyed) return false;
        const adapter = this.adapter;
        const note = this.state.notes.find(item => item.id === noteID);
        const action = run => () => {
            void this.runAction(run);
        };
        this.contextMenu.open({
            screenX,
            screenY,
            anchor,
            items: [
                {
                    label: this.t('notes.showInLibrary'),
                    disabled: typeof adapter.showInLibrary !== 'function',
                    command: action(() => adapter.showInLibrary({
                        noteID,
                        ...this.hostContext(),
                    })),
                },
                {
                    label: this.t('notes.openInWindow'),
                    command: action(() => adapter.openInWindow({
                        noteID,
                        ...this.hostContext(),
                    })),
                },
                ...(note?.kind === 'standalone' && adapter.pinResearchNote ? [{
                    label: this.t('notes.pinResearchNote'),
                    disabled: note.editable === false || !this.state.editable,
                    command: action(() => this.pinResearchNote(noteID)),
                }] : []),
                { separator: true },
                {
                    label: this.t('notes.moveToTrash'),
                    disabled: note?.editable === false
                        || (note?.editable === undefined && !this.state.editable)
                        || typeof adapter.moveToTrash !== 'function',
                    command: action(() => this.moveToTrash(noteID)),
                },
            ],
        });
        return true;
    }

    async moveToTrash(noteID) {
        const note = this.state.notes.find(item => item.id === noteID);
        const noteEditable = note?.editable !== false
            && (note?.editable === true || this.state.editable);
        if (!this.adapter || !noteEditable) return;
        const adapter = this.adapter;
        await adapter.moveToTrash({ noteID });
        if (adapter !== this.adapter || this.destroyed) return;
        this.state = {
            ...this.state,
            notes: this.state.notes.filter(note => note.id !== noteID),
        };
        this.render();
        void this.refresh();
    }

    // The window the editor lives in: the tab's own window, which is not
    // always Zotero's first main window.
    hostContext() {
        return { window: this.document.defaultView || null };
    }

    openCreateMenu({ anchor } = {}) {
        if (!this.contextMenu || !this.adapter || this.destroyed) return false;
        const action = run => () => {
            void this.runAction(run);
        };
        this.contextMenu.open({
            anchor,
            items: [
                {
                    label: this.t('notes.newItemNote'),
                    disabled: !this.state.canCreateItemNote,
                    command: action(() => this.createNote('item')),
                },
                {
                    label: this.t('notes.newStandaloneNote'),
                    disabled: !this.state.canCreateStandaloneNote,
                    command: action(() => this.createNote('standalone')),
                },
            ],
        });
        return true;
    }

    async showEditor({ noteID, noteKind = 'item' }) {
        this.openingNote = true;
        this.closeEditor();
        const token = this.editorToken;
        const adapter = this.adapter;
        const container = this.ensureEditorContainer();
        this.mode = 'editor';
        this.render();
        let handle;
        try {
            handle = await adapter.mountEditor(container, {
                noteID,
                noteKind,
                ...this.hostContext(),
            });
        }
        catch (error) {
            if (token !== this.editorToken || this.destroyed) return;
            this.mode = 'list';
            container.replaceChildren();
            this.render();
            if (error?.code === NOTE_EDITOR_UNAVAILABLE && noteID) {
                await this.runAction(() => adapter.openInWindow({
                    noteID,
                    noteKind,
                    ...this.hostContext(),
                }));
            }
            else {
                this.onError(error);
            }
            return;
        }
        finally {
            this.openingNote = false;
        }
        // The reader went back, the tab closed, or the adapter changed while
        // the editor was loading.
        if (token !== this.editorToken || this.destroyed || adapter !== this.adapter) {
            try {
                handle?.destroy();
            }
            catch (error) {
                this.onError(error);
            }
            return;
        }
        this.handle = handle;
        this.mode = 'editor';
        this.render();
    }

    closeEditor() {
        this.editorToken += 1;
        const handle = this.handle;
        this.handle = null;
        this.mode = 'list';
        this.continuationHintVisible = false;
        if (this.elements) {
            this.elements.reviewEditorStatus.hidden = true;
            this.elements.continuationPrompts.removeAttribute('open');
            this.renderContinuationHint();
        }
        if (handle) {
            try {
                handle.destroy();
            }
            catch (error) {
                this.onError(error);
            }
            // The caret was in the editor. Hand it back so the reader's own
            // keys (n, p, "?") work again without a click in the article.
            if (!this.destroyed) this.onEditorClose();
        }
        this.editorContainer?.replaceChildren();
    }

    async runAction(action) {
        try {
            await action();
        }
        catch (error) {
            this.onError(error);
        }
    }

    ensureEditorContainer() {
        if (this.editorContainer?.isConnected) return this.editorContainer;
        const container = this.document.createElementNS(XHTML_NAMESPACE, 'div');
        container.className = 'mktero-note-editor-host';
        container.setAttribute('slot', NOTE_EDITOR_SLOT);
        Object.assign(container.style, {
            display: 'flex',
            flexDirection: 'column',
            minWidth: '0',
            minHeight: '0',
            height: '100%',
        });
        this.host.appendChild(container);
        this.editorContainer = container;
        return container;
    }

    render() {
        if (this.destroyed) return;
        const { elements, state } = this;
        const reviewing = this.review?.visible === true;
        const editing = this.mode === 'editor';
        const listed = state.status === 'ready' || state.status === 'no-parent';
        const scopeNotes = this.scopeNotes();
        const visibleNotes = this.filteredNotes();
        elements.listView.hidden = editing || reviewing;
        elements.editorView.hidden = !editing || reviewing;
        elements.count.hidden = editing || !listed || !scopeNotes.length;
        elements.count.textContent = visibleNotes.length === scopeNotes.length
            ? String(scopeNotes.length)
            : `${visibleNotes.length}/${scopeNotes.length}`;
        elements.search.hidden = editing || !listed || !scopeNotes.length;
        elements.noteScopes.hidden = editing || !listed || this.choosingResearchNote;
        elements.titleLabel.textContent = this.t(this.choosingResearchNote
            ? 'notes.chooseResearchNote' : 'viewer.notesTitle');
        elements.researchPicker.hidden = editing || !this.choosingResearchNote;
        elements.researchPickerText.textContent = this.t('notes.chooseResearchNoteHint');
        elements.researchPickerCancel.textContent = this.t('notes.cancelResearchChoice');
        elements.researchPickerCancel.disabled = this.researchActionPending;
        elements.newButton.hidden = editing || this.choosingResearchNote
            || !listed
            || (state.status === 'no-parent'
                && !state.canCreateItemNote
                && !state.canCreateStandaloneNote);
        elements.newButton.disabled = !state.canCreateItemNote
            && !state.canCreateStandaloneNote;
        elements.windowButton.hidden = !this.handle?.noteID;
        const openNote = state.notes.find(note => note.id === this.handle?.noteID);
        elements.pinButton.hidden = !this.adapter?.pinResearchNote
            || !this.handle?.noteID
            || openNote?.kind !== 'standalone';
        elements.pinButton.disabled = !this.canInsert;
        elements.editorTarget.textContent = this.t('notes.insertTarget', {
            title: this.insertTargetTitle || this.t('notes.untitled'),
        });
        elements.editorTarget.title = elements.editorTarget.textContent;
        this.renderResearchNote();
        this.renderReview();
        this.renderContinuationHint();
        this.renderStatus();
        this.renderList();
        this.onStateChange();
    }

    renderResearchNote() {
        const target = this.state.researchNote;
        const { researchStrip, researchTitle, researchLabel, researchContinue,
            researchClear, researchStatus, researchSetup, researchSetupText,
            researchCreate, researchChoose, researchChange } = this.elements;
        const listed = ['ready', 'no-parent'].includes(this.state.status);
        const hasTarget = Boolean(target && target.status !== 'none');
        const busy = this.openingNote || this.researchActionPending;
        researchStrip.hidden = !hasTarget || this.choosingResearchNote;
        researchSetup.hidden = !listed || hasTarget || this.choosingResearchNote
            || this.mode === 'editor' || !this.adapter?.pinResearchNote;
        researchSetup.setAttribute('aria-busy', String(this.researchActionPending));
        researchSetupText.textContent = this.t('notes.researchSetup');
        researchCreate.textContent = this.t('notes.createResearchNote');
        researchCreate.disabled = busy || !this.state.canCreateStandaloneNote
            || !this.adapter?.createResearchNote;
        researchChoose.textContent = this.t('notes.chooseResearchNote');
        researchChoose.disabled = busy || !this.state.notes.some(note => (
            note.kind === 'standalone' && note.editable === true
        ));
        researchChange.textContent = this.t('notes.changeResearchNote');
        researchChange.hidden = !this.adapter?.pinResearchNote || this.choosingResearchNote;
        researchChange.disabled = busy;
        researchClear.disabled = busy;
        researchLabel.textContent = this.t('notes.researchNote');
        researchTitle.textContent = target?.note?.title || this.t('notes.untitled');
        setLabel(researchContinue, this.t('notes.continueResearchNote', {
            title: target?.note?.title || this.t('notes.untitled'),
        }));
        researchContinue.disabled = !['ready', 'readonly'].includes(target?.status) || busy;
        const reread = this.elements.researchReread;
        reread.hidden = busy || !this.adapter?.listResearchNoteExcerpts
            || !['ready', 'readonly'].includes(target?.status);
        reread.disabled = Boolean(this.review);
        reread.textContent = this.t('notes.reviewOpen');
        setLabel(researchClear, this.t('notes.clearResearchNote'));
        const statusKey = {
            readonly: 'notes.researchReadonly',
            missing: 'notes.researchMissing',
            unavailable: 'notes.researchUnavailable',
        }[target?.status];
        researchStatus.hidden = !statusKey;
        researchStatus.textContent = statusKey ? this.t(statusKey) : '';
        setLabel(this.elements.pinButton, this.t('notes.pinResearchNote'));
    }

    renderReview() {
        const review = this.review;
        const { reviewView, reviewBack, reviewList, reviewStatus, reviewAppend, reviewFilter } = this.elements;
        reviewView.hidden = !review?.visible;
        if (!review && this.renderedReview) {
            this.renderedReview = null;
            reviewList.replaceChildren();
        }
        if (!review?.visible) return;
        reviewBack.textContent = this.t('notes.reviewBack');
        reviewBack.disabled = review.writing;
        reviewAppend.textContent = this.t('notes.reviewAppend');
        reviewFilter.textContent = this.t(review.showSelected ? 'notes.reviewShowAll' : 'notes.reviewShowSelected');
        reviewFilter.disabled = !review.selected.size && !review.showSelected;
        this.updateReviewAppend();
        const message = review.status || (review.loading && 'notes.reviewLoading')
            || (!review.excerpts.length && 'notes.reviewEmpty')
            || (review.savedOnly && 'notes.reviewSavedOnly')
            || (this.state.researchNote.status === 'readonly' && 'notes.researchReadonly');
        reviewStatus.hidden = !message;
        reviewStatus.textContent = message ? this.t(message) : '';
        const readonly = this.state.researchNote.status === 'readonly';
        const previous = this.renderedReview;
        if (previous?.excerpts === review.excerpts && previous.readonly === readonly
            && previous.showSelected === review.showSelected) return;
        this.renderedReview = { excerpts: review.excerpts, readonly, showSelected: review.showSelected };
        const shown = review.showSelected
            ? review.excerpts.filter(row => review.selected.has(row.id))
            : review.excerpts;
        const rows = shown.map(row => {
            const item = this.element('li', 'mktero-review-row');
            const label = this.element('label', 'mktero-review-excerpt');
            const select = this.element('input');
            select.type = 'checkbox';
            select.disabled = !row.available || readonly;
            select.checked = review.selected.has(row.id);
            select.addEventListener('change', () => {
                if (!this.isCurrentReview(review) || review.writing) {
                    select.checked = review.selected.has(row.id);
                    return;
                }
                if (select.checked) review.selected.add(row.id);
                else review.selected.delete(row.id);
                if (review.showSelected) this.renderedReview = null;
                this.renderReview();
                if (review.showSelected) reviewFilter.focus();
            });
            const excerpt = this.element('span');
            excerpt.textContent = row.text;
            label.append(select, excerpt);
            const source = this.element('button', 'mktero-review-source mktero-research-note-text-action');
            source.type = 'button';
            source.disabled = !row.available;
            const sourceLabel = this.t('notes.reviewSource', {
                title: row.title || this.t('notes.untitled'),
                page: row.source.pageLabel || String(row.source.position.pageIndex + 1),
            });
            source.textContent = row.available ? sourceLabel
                : `${sourceLabel} · ${this.t('notes.reviewSourceUnavailable')}`;
            source.addEventListener('click', () => void this.openReviewSource(review, row.id));
            item.append(label, source);
            return item;
        });
        reviewList.replaceChildren(...rows);
    }

    updateReviewAppend() {
        const review = this.review;
        this.elements.reviewAppend.disabled = !review?.selected.size || review.loading || review.writing
            || this.state.researchNote?.status !== 'ready';
    }

    renderContinuationHint() {
        const { continuationHint, continuationText, continuationDismiss,
            continuationSummary, continuationQuestions } = this.elements;
        continuationHint.hidden = !this.continuationHintVisible || this.mode !== 'editor'
            || !this.canInsert;
        continuationText.textContent = this.t('notes.continueAfterExcerpt');
        continuationSummary.textContent = this.t('notes.thinkingPrompts');
        for (const question of continuationQuestions) {
            question.textContent = this.t(question.dataset.messageKey);
        }
        setLabel(continuationDismiss, this.t('notes.dismissContinueHint'));
    }

    renderStatus() {
        const { status } = this.state;
        const scopeNotes = this.scopeNotes();
        const filtered = this.filteredNotes();
        let key = {
            loading: 'notes.loading',
            unavailable: 'notes.unavailable',
        }[status];
        if (!key && this.noteQuery.trim() && scopeNotes.length && !filtered.length) {
            key = 'notes.noSearchMatches';
        }
        if (!key && status === 'no-parent' && this.noteScope === 'item') {
            key = 'notes.noParent';
        }
        if (!key && !scopeNotes.length && (status === 'ready' || status === 'no-parent')) {
            key = NOTE_SCOPE_EMPTY_KEYS[this.noteScope];
        }
        this.elements.status.hidden = !key;
        this.elements.status.textContent = key ? this.t(key) : '';
    }

    filteredNotes() {
        const query = String(this.noteQuery || '')
            .toLowerCase()
            .replace(/\s+/gu, ' ')
            .trim();
        if (!query) return this.scopeNotes();
        return this.scopeNotes().filter(note => (
            `${note.title || ''} ${note.preview || ''}`
                .toLowerCase()
                .replace(/\s+/gu, ' ')
                .includes(query)
        ));
    }

    renderList() {
        const list = this.elements.list;
        list.replaceChildren();
        if (this.state.status !== 'ready' && this.state.status !== 'no-parent') return;
        for (const note of this.filteredNotes()) {
            list.appendChild(this.renderNote(note));
        }
    }

    renderNote(note) {
        const item = this.element('li', 'mktero-zotero-note-item');
        const button = this.element('button', 'mktero-zotero-note-link');
        button.type = 'button';
        button.setAttribute('data-note-id', String(note.id));
        const title = this.element('span', 'mktero-zotero-note-title');
        title.textContent = note.title || this.t('notes.untitled');
        button.appendChild(title);
        if (note.preview) {
            const preview = this.element('span', 'mktero-zotero-note-preview');
            preview.textContent = note.preview;
            button.appendChild(preview);
        }
        if (note.dateLabel) {
            const date = this.element('span', 'mktero-zotero-note-date');
            date.textContent = note.dateLabel;
            button.appendChild(date);
        }
        button.addEventListener('click', () => {
            if (this.choosingResearchNote) {
                if (!button.disabled) void this.runAction(() => this.selectResearchNote(note.id));
            }
            else {
                void this.openNote(note.id);
            }
        });
        if (this.choosingResearchNote) {
            button.disabled = this.researchActionPending || note.editable !== true;
            if (note.editable !== true) button.title = this.t('notes.researchReadonly');
        }
        button.addEventListener('contextmenu', event => {
            if (this.openNoteMenu(note.id, {
                screenX: event.screenX,
                screenY: event.screenY,
                anchor: button,
            })) {
                event.preventDefault();
                event.stopPropagation();
            }
        });
        item.appendChild(button);
        if (!this.choosingResearchNote && note.kind === 'standalone' && this.adapter?.pinResearchNote) {
            item.classList.add('mktero-zotero-note-item--pinnable');
            title.id = `mktero-zotero-note-title-${note.id}`;
            const pinned = this.state.researchNote?.note?.id === note.id;
            const pin = this.iconButton('mktero-zotero-note-pin-card',
                LUCIDE_ICONS.pin, pinned ? 'notes.clearResearchNote' : 'notes.pinResearchNote');
            pin.setAttribute('data-note-id', String(note.id));
            pin.setAttribute('aria-pressed', pinned ? 'true' : 'false');
            pin.setAttribute('aria-describedby', title.id);
            // List editability describes creating child notes, which a standalone
            // PDF cannot do. Pinning uses the standalone note's own permission.
            pin.disabled = pinned
                ? typeof this.adapter.clearResearchNote !== 'function'
                : note.editable !== true;
            pin.addEventListener('click', event => {
                event.stopPropagation();
                if (pin.disabled) return;
                void this.runAction(() => (pinned
                    ? this.clearResearchNote()
                    : this.pinResearchNote(note.id)));
            });
            item.appendChild(pin);
        }
        return item;
    }

    createContent() {
        const researchStrip = this.element('div', 'mktero-research-note');
        const researchRow = this.element('div', 'mktero-research-note-row');
        const researchContinue = this.element('button', 'mktero-research-note-continue');
        researchContinue.type = 'button';
        const researchLabel = this.element('span', 'mktero-research-note-label');
        const researchTitle = this.element('span', 'mktero-research-note-title');
        researchContinue.append(researchLabel, researchTitle);
        const researchClear = this.iconButton('mktero-research-note-clear',
            LUCIDE_ICONS.x, 'notes.clearResearchNote');
        const researchStatus = this.element('p', 'mktero-research-note-status');
        researchStatus.setAttribute('role', 'status');
        researchRow.append(researchContinue, researchClear);
        researchStrip.append(researchRow, researchStatus);
        const researchChange = this.element('button', 'mktero-research-note-text-action');
        researchChange.type = 'button';
        researchChange.addEventListener('click', () => this.chooseResearchNote());
        const researchReread = this.element('button', 'mktero-research-note-reread mktero-research-note-text-action');
        researchReread.type = 'button';
        researchReread.addEventListener('click', () => void this.openReview());
        researchStrip.append(researchChange, researchReread);
        const researchSetup = this.element('div', 'mktero-research-note-setup');
        const researchSetupText = this.element('p', 'mktero-research-note-help');
        const researchActions = this.element('div', 'mktero-research-note-actions');
        const researchCreate = this.element('button', 'mktero-research-note-create mktero-research-note-action');
        researchCreate.type = 'button';
        researchCreate.addEventListener('click', () => {
            void this.runAction(() => this.createResearchNote());
        });
        const researchChoose = this.element('button', 'mktero-research-note-choose mktero-research-note-text-action');
        researchChoose.type = 'button';
        researchChoose.addEventListener('click', () => this.chooseResearchNote());
        researchActions.append(researchCreate, researchChoose);
        researchSetup.append(researchSetupText, researchActions);
        researchContinue.addEventListener('click', () => {
            this.closeReview();
            void this.runAction(() => this.continueResearchNote());
        });
        researchClear.addEventListener('click', () => {
            void this.runAction(() => this.clearResearchNote());
        });
        const header = this.element('div', 'mktero-zotero-notes-header');
        const titleRow = this.element('div', 'mktero-zotero-notes-title-row');
        const title = this.element('h2', 'mktero-zotero-notes-title');
        title.appendChild(createLucideIcon(this.document, LUCIDE_ICONS.notebookPen, {
            className: 'markdown-panel-title-icon',
            size: 16,
        }));
        const titleLabel = this.element('span', 'markdown-panel-title-label');
        title.appendChild(titleLabel);
        const actions = this.element('span', 'mktero-zotero-notes-actions');
        const count = this.element('span', 'mktero-zotero-notes-count');
        const newButton = this.iconButton(
            'mktero-zotero-note-new',
            LUCIDE_ICONS.plus,
            'notes.newNote'
        );
        actions.append(count, newButton);
        titleRow.append(title, actions);
        header.appendChild(titleRow);

        const noteScopes = this.element('div', 'mktero-zotero-notes-tabs');
        noteScopes.setAttribute('role', 'tablist');
        noteScopes.setAttribute('aria-label', this.t('notes.scopes'));
        const noteScopeButtons = NOTE_SCOPES.map(scope => {
            const button = this.element('button', 'mktero-zotero-notes-tab');
            button.type = 'button';
            button.setAttribute('role', 'tab');
            button.setAttribute('id', `mktero-zotero-notes-tab-${scope}`);
            button.setAttribute('data-note-scope', scope);
            button.setAttribute('aria-selected', scope === this.noteScope ? 'true' : 'false');
            button.setAttribute('aria-controls', 'mktero-zotero-notes-list');
            button.textContent = this.t(NOTE_SCOPE_LABEL_KEYS[scope]);
            button.addEventListener('click', () => this.setNoteScope(scope));
            noteScopes.appendChild(button);
            return button;
        });

        const search = this.element('div', 'mktero-zotero-notes-search');
        header.appendChild(noteScopes);
        const searchInput = this.element('input', 'mktero-zotero-notes-search-input');
        searchInput.type = 'search';
        searchInput.setAttribute('aria-label', this.t('notes.search'));
        searchInput.setAttribute('placeholder', this.t('notes.searchPlaceholder'));
        searchInput.addEventListener('input', () => {
            this.noteQuery = searchInput.value;
            this.render();
        });
        search.appendChild(searchInput);

        const listView = this.element('div', 'mktero-zotero-notes-list-view');
        const researchPicker = this.element('div', 'mktero-research-note-picker');
        const researchPickerText = this.element('p', 'mktero-research-note-help');
        const researchPickerCancel = this.element('button', 'mktero-research-note-cancel mktero-research-note-text-action');
        researchPickerCancel.type = 'button';
        researchPickerCancel.addEventListener('click', () => {
            if (this.researchActionPending) return;
            this.choosingResearchNote = false;
            this.render();
            if (!researchSetup.hidden) researchChoose.focus();
            else researchChange.focus();
        });
        researchPicker.append(researchPickerText, researchPickerCancel);
        const status = this.element('p', 'mktero-zotero-notes-status');
        status.setAttribute('role', 'status');
        const list = this.element('ul', 'mktero-zotero-notes-list');
        list.setAttribute('id', 'mktero-zotero-notes-list');
        list.setAttribute('role', 'tabpanel');
        list.setAttribute('aria-labelledby', 'mktero-zotero-notes-tab-item');
        listView.append(header, researchPicker, search, status, list);

        const editorView = this.element('div', 'mktero-zotero-notes-editor-view');
        const editorBar = this.element('div', 'mktero-zotero-notes-editor-bar');
        const backButton = this.iconButton(
            'mktero-zotero-note-back',
            LUCIDE_ICONS.arrowLeft,
            'notes.backToList'
        );
        const windowButton = this.iconButton(
            'mktero-zotero-note-window',
            LUCIDE_ICONS.externalLink,
            'notes.openInWindow'
        );
        const pinButton = this.iconButton('mktero-zotero-note-pin',
            LUCIDE_ICONS.pin, 'notes.pinResearchNote');
        const editorTarget = this.element('span', 'mktero-note-destination');
        editorBar.append(backButton, editorTarget, pinButton, windowButton);
        const slot = this.element('slot', 'mktero-zotero-note-slot');
        slot.setAttribute('name', NOTE_EDITOR_SLOT);
        const continuationHint = this.element('div', 'mktero-note-continuation-hint');
        const continuationBody = this.element('div', 'mktero-note-continuation-body');
        const continuationText = this.element('span', 'mktero-note-continuation-text');
        continuationText.setAttribute('role', 'status');
        continuationText.setAttribute('aria-live', 'polite');
        const continuationPrompts = this.element('details', 'mktero-note-thinking-prompts');
        const continuationSummary = this.element('summary', 'mktero-note-thinking-summary');
        const continuationList = this.element('ul', 'mktero-note-thinking-list');
        const continuationQuestions = [
            'notes.thinkingAssumptions',
            'notes.thinkingMethod',
            'notes.thinkingConnection',
            'notes.thinkingUncertainty',
        ].map(key => {
            const question = this.element('li');
            question.dataset.messageKey = key;
            return question;
        });
        continuationList.append(...continuationQuestions);
        continuationPrompts.append(continuationSummary, continuationList);
        continuationBody.append(continuationText, continuationPrompts);
        const continuationDismiss = this.iconButton('mktero-note-continuation-dismiss',
            LUCIDE_ICONS.x, 'notes.dismissContinueHint');
        continuationDismiss.addEventListener('click', () => {
            this.continuationHintVisible = false;
            continuationPrompts.removeAttribute('open');
            this.renderContinuationHint();
            this.handle?.focus?.();
        });
        continuationHint.append(continuationBody, continuationDismiss);
        const reviewEditorStatus = this.element('p', 'mktero-research-note-status');
        reviewEditorStatus.setAttribute('role', 'status');
        reviewEditorStatus.hidden = true;
        editorView.append(editorBar, reviewEditorStatus, continuationHint, slot);
        editorView.hidden = true;

        const reviewView = this.element('div', 'mktero-research-review');
        const reviewBack = this.element('button', 'mktero-research-note-text-action mktero-review-back');
        reviewBack.type = 'button';
        reviewBack.addEventListener('click', () => this.closeReview({ focus: true }));
        const reviewList = this.element('ul', 'mktero-review-excerpts');
        const reviewFilter = this.element('button', 'mktero-research-note-text-action mktero-review-filter');
        reviewFilter.type = 'button';
        reviewFilter.addEventListener('click', () => {
            if (!this.review) return;
            this.review.showSelected = !this.review.showSelected;
            this.renderReview();
        });
        const reviewControls = this.element('div', 'mktero-research-note-actions');
        reviewControls.append(reviewBack, reviewFilter);
        const reviewStatus = this.element('p', 'mktero-research-note-status');
        reviewStatus.setAttribute('role', 'status');
        const reviewAppend = this.element('button', 'mktero-research-note-action mktero-review-append');
        reviewAppend.type = 'button';
        reviewAppend.addEventListener('click', () => void this.appendReview());
        reviewView.append(reviewControls, reviewStatus, reviewList, reviewAppend);
        reviewView.hidden = true;

        this.aside.replaceChildren(researchStrip, researchSetup, listView, reviewView, editorView);
        newButton.addEventListener('click', () => {
            if (this.openCreateMenu({ anchor: newButton })) return;
            void this.createNote('item');
        });
        backButton.addEventListener('click', () => this.back());
        pinButton.addEventListener('click', () => {
            void this.runAction(() => this.pinResearchNote());
        });
        windowButton.addEventListener('click', () => {
            void this.openCurrentInWindow();
        });
        const elements = {
            researchStrip, researchLabel, researchTitle, researchContinue,
            researchClear, researchStatus, researchSetup, researchSetupText,
            researchCreate, researchChoose, researchChange,
            researchReread, reviewView, reviewBack, reviewList, reviewStatus, reviewAppend,
            reviewEditorStatus, reviewFilter,
            researchPicker, researchPickerText, researchPickerCancel,
            continuationHint, continuationText, continuationDismiss,
            continuationPrompts, continuationSummary, continuationQuestions, pinButton, editorTarget,
            listView,
            editorView,
            titleLabel,
            count,
            newButton,
            noteScopes,
            noteScopeButtons,
            search,
            searchInput,
            status,
            list,
            backButton,
            windowButton,
        };
        titleLabel.textContent = this.t('viewer.notesTitle');
        return elements;
    }

    iconButton(className, icon, labelKey) {
        const button = this.element('button', `mktero-zotero-notes-button ${className}`);
        button.type = 'button';
        setLabel(button, this.t(labelKey));
        button.appendChild(createLucideIcon(this.document, icon, { size: 15 }));
        return button;
    }

    element(tagName, className) {
        const element = this.document.createElementNS(XHTML_NAMESPACE, tagName);
        if (className) element.className = className;
        return element;
    }
}

function unavailableNote() {
    const error = new Error('The note destination is unavailable or changed');
    error.code = NOTE_EDITOR_UNAVAILABLE;
    return error;
}

function setLabel(element, label) {
    element.setAttribute('aria-label', label);
    element.setAttribute('title', label);
}
