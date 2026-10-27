import {
    NOTE_EDITOR_UNAVAILABLE,
} from '../core/zotero-note-bridge.js';
import { createLucideIcon, LUCIDE_ICONS } from '../icons/lucide-icon.js';
import { createNativeContextMenu } from './native-context-menu.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
export const NOTE_EDITOR_SLOT = 'mktero-note-editor';

// The right column of a Mktero tab: the Zotero child notes of the paper.
// The list lives in the reader's shadow tree. Zotero's `note-editor` cannot:
// it needs the chrome document's styles and l10n, so it is mounted in a
// light-DOM container on the shadow host and slotted into the column.
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
            annotationCount: 0,
        };
        this.mode = 'list';
        this.handle = null;
        this.openingNote = false;
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
        this.closeEditor();
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
            annotationCount: 0,
        };
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
            state = { status: 'unavailable', notes: [], editable: false, annotationCount: 0 };
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
            annotationCount: Number.isSafeInteger(state?.annotationCount)
                ? state.annotationCount
                : 0,
        };
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

    async createNote() {
        if (!this.adapter || this.openingNote) return;
        if (!this.adapter.canHostEditor?.(this.hostContext())) {
            await this.runAction(() => this.adapter.openInWindow(this.hostContext()));
            return;
        }
        await this.showEditor({ noteID: null });
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
        if (options === undefined) {
            await this.handle.insertAnnotations(annotations);
            return;
        }
        await this.handle.insertAnnotations(annotations, options);
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
        setLabel(elements.backButton, this.t('notes.backToList'));
        setLabel(elements.windowButton, this.t('notes.openInWindow'));
        this.render();
    }

    destroy() {
        if (this.destroyed) return;
        this.disposeObserver?.();
        this.disposeObserver = null;
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
                { separator: true },
                {
                    label: this.t('notes.moveToTrash'),
                    disabled: !this.state.editable
                        || typeof adapter.moveToTrash !== 'function',
                    command: action(() => this.moveToTrash(noteID)),
                },
            ],
        });
        return true;
    }

    async moveToTrash(noteID) {
        if (!this.adapter || !this.state.editable) return;
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

    async showEditor({ noteID }) {
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
        const editing = this.mode === 'editor';
        elements.listView.hidden = editing;
        elements.editorView.hidden = !editing;
        elements.count.hidden = editing || state.status !== 'ready' || !state.notes.length;
        elements.count.textContent = state.notes.length
            ? String(state.notes.length)
            : '';
        elements.newButton.hidden = state.status !== 'ready';
        elements.newButton.disabled = !state.editable;
        elements.windowButton.hidden = !this.handle?.noteID;
        this.renderStatus();
        this.renderList();
        this.onStateChange();
    }

    renderStatus() {
        const { status, notes } = this.state;
        const key = {
            loading: 'notes.loading',
            'no-parent': 'notes.noParent',
            unavailable: 'notes.unavailable',
        }[status] || (notes.length ? '' : 'notes.empty');
        this.elements.status.hidden = !key;
        this.elements.status.textContent = key ? this.t(key) : '';
    }

    renderList() {
        const list = this.elements.list;
        list.replaceChildren();
        if (this.state.status !== 'ready') return;
        for (const note of this.state.notes) {
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
                void this.openNote(note.id);
            });
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
            list.appendChild(item);
        }
    }

    createContent() {
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

        const listView = this.element('div', 'mktero-zotero-notes-list-view');
        const status = this.element('p', 'mktero-zotero-notes-status');
        status.setAttribute('role', 'status');
        const list = this.element('ul', 'mktero-zotero-notes-list');
        listView.append(header, status, list);

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
        editorBar.append(backButton, windowButton);
        const slot = this.element('slot', 'mktero-zotero-note-slot');
        slot.setAttribute('name', NOTE_EDITOR_SLOT);
        editorView.append(editorBar, slot);
        editorView.hidden = true;

        this.aside.replaceChildren(listView, editorView);
        newButton.addEventListener('click', () => {
            void this.createNote();
        });
        backButton.addEventListener('click', () => this.back());
        windowButton.addEventListener('click', () => {
            void this.openCurrentInWindow();
        });
        const elements = {
            listView,
            editorView,
            titleLabel,
            count,
            newButton,
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

function setLabel(element, label) {
    element.setAttribute('aria-label', label);
    element.setAttribute('title', label);
}
