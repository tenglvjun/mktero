const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const STYLE_ID = 'mktero-context-pane-style';
export const MKTERO_TAB_SELECTED_ATTRIBUTE = 'mktero-tab-selected';
const PENDING_ATTRIBUTE = 'mktero-context-pane-pending';
const UNAVAILABLE_ATTRIBUTE = 'mktero-context-pane-unavailable';
const FOCUS_ATTRIBUTE = 'mktero-context-pane-focus';
const OWN_ATTRIBUTES = [MKTERO_TAB_SELECTED_ATTRIBUTE, PENDING_ATTRIBUTE,
    UNAVAILABLE_ATTRIBUTE, FOCUS_ATTRIBUTE];
const HIDDEN_SELECTORS = ['#zotero-context-pane', '#zotero-context-pane-sidenav',
    '#zotero-context-splitter', '#zotero-context-splitter-stacked'];

// Zotero does not dispatch custom tabs to its context pane. Bind only the
// current Mktero tab here, without changing reader eligibility or tab type.
export function createZoteroContextPane(options) {
    return new ZoteroContextPane(options);
}

class ZoteroContextPane {
    constructor({ window, zotero }) {
        this.window = window;
        this.zotero = zotero;
        this.document = window?.document;
        this.active = null;
        this.records = new Map();
        this.pending = new Map();
        this.generation = 0;
        this.commandGeneration = 0;
        this.ready = false;
        this.disposed = false;
        this.nativeSnapshot = null;
        this.restorers = [];
        this.installTabLookups();
        this.installContextSelection();
        this.installSectionClicks();
        this.installStyle();
        const Observer = window?.MutationObserver;
        if (typeof Observer === 'function') {
            this.observer = new Observer(() => this.observeExpansion());
            for (const id of ['zotero-context-pane', 'zotero-context-pane-inner',
                'zotero-context-splitter', 'zotero-context-splitter-stacked']) {
                const node = this.document?.getElementById?.(id);
                if (node) this.observer.observe(node, {
                    attributes: true, attributeFilter: ['collapsed', 'state'],
                });
            }
        }
    }

    get controller() {
        return this.window?.ZoteroContextPane;
    }

    get context() {
        return this.controller?.context
            || this.document?.getElementById?.('zotero-context-pane-inner');
    }

    get sidenav() {
        return this.context?.sidenav
            || this.document?.getElementById?.('zotero-context-pane-sidenav');
    }

    isCurrent(presentation = this.active) {
        return !this.disposed && presentation && !presentation.closed
            && presentation === this.active
            && this.window?.Zotero_Tabs?.selectedID === presentation.tabID;
    }

    installTabLookups() {
        const tabs = this.window?.Zotero_Tabs;
        if (!tabs) return;
        const owned = id => tabs._tabs?.find(tab => tab.id === id)?.type === 'mktero';
        const wrap = (name, replacement) => {
            const original = tabs[name];
            if (typeof original !== 'function') return;
            const manager = this;
            const wrapper = function (...args) {
                if (manager.disposed) return original.apply(this, args);
                return replacement.call(this, original, ...args);
            };
            tabs[name] = wrapper;
            this.restorers.push(() => {
                if (tabs[name] === wrapper) tabs[name] = original;
            });
        };
        // Reader.open uses this generic lookup to reuse unloaded PDF tabs.
        // A Mktero item context must not become a substitute PDF reader.
        wrap('getTabIDByItemID', function (original, itemID, ...args) {
            const id = original.call(this, itemID, ...args);
            if (!owned(id)) return id;
            return this._tabs?.find(tab => tab.type !== 'mktero'
                && tab.data?.itemID === itemID)?.id;
        });
        wrap('getTabIDsByItemID', function (original, ...args) {
            return original.apply(this, args).filter(id => !owned(id));
        });
        // Item notifications ask rename() to derive a native tab title. A
        // custom tab has no native getTitle hook; keep its presenter title.
        wrap('rename', function (original, id, title, ...args) {
            if (!title && owned(id)) {
                title = tabs._tabs.find(tab => tab.id === id)?.title;
            }
            return original.call(this, id, title, ...args);
        });
    }

    installContextSelection() {
        const context = this.context;
        const original = context?._selectItemContext;
        if (typeof original !== 'function') return;
        const manager = this;
        const select = function (tabID, ...args) {
            // Zotero 7 creates a reader context and immediately renders it
            // before _addItemContext resolves. Correct its type before that
            // first render, including native item-notification rebuilds.
            if (!manager.disposed && manager.records.has(tabID)) {
                const container = this._getItemContext?.(tabID);
                if (container) container.tabType = 'mktero';
            }
            return original.call(this, tabID, ...args);
        };
        context._selectItemContext = select;
        this.restorers.push(() => {
            if (context._selectItemContext === select) context._selectItemContext = original;
        });
    }

    installSectionClicks() {
        const sidenav = this.sidenav;
        if (!sidenav?.addEventListener) return;
        const click = event => {
            const presentation = this.active;
            const pane = event.target?.closest?.('[data-pane]')?.dataset.pane;
            if (!pane || pane === 'context-notes' || event.button !== 0 || event.detail !== 1
                || !this.ready || !this.isCurrent(presentation)) return;
            const container = this.context?._getItemContext?.(presentation.tabID);
            if (!container || sidenav.container !== container
                || typeof container.scrollToPane !== 'function') return;
            // The native handler awaits scrolling, then expands whichever
            // container is current at that later time. Keep this command tied
            // to its original tab, including a subsequent explicit close.
            event.stopImmediatePropagation();
            event.preventDefault();
            void this.openSection(presentation, container, pane);
        };
        sidenav.addEventListener('click', click, true);
        this.restorers.push(() => sidenav.removeEventListener('click', click, true));
    }

    async openSection(presentation, container, pane) {
        const generation = this.generation;
        const command = ++this.commandGeneration;
        try {
            let behavior = this.controller.collapsed ? 'instant' : 'smooth';
            if (this.context.mode === 'notes') {
                this.context.mode = 'item';
                behavior = 'instant';
            }
            await container.scrollToPane(pane, behavior);
            if (!this.isCurrent(presentation) || generation !== this.generation
                || command !== this.commandGeneration || this.sidenav?.container !== container) return;
            if (this.writeCollapsed(false)) presentation.view.setNativeSidebarOpen?.(true);
            this.sidenav?.render?.();
        }
        catch (error) {
            if (this.isCurrent(presentation) && generation === this.generation) this.zotero?.logError?.(error);
        }
    }

    installStyle() {
        const document = this.document;
        if (!document?.createElementNS || !document.documentElement?.appendChild) return;
        this.style = document.getElementById(STYLE_ID);
        if (this.style) return;
        this.style = document.createElementNS(XHTML_NAMESPACE, 'style');
        this.style.id = STYLE_ID;
        const root = `:root[${MKTERO_TAB_SELECTED_ATTRIBUTE}]`;
        // Native library item panes keep a 37px icon rail when collapsed.
        // The reader's outer XUL box otherwise collapses the rail as well.
        this.style.textContent = `
${root} #zotero-context-pane[collapsed="true"] {
    visibility: visible;
}
${root} #zotero-context-pane:not(.stacked)[collapsed="true"] {
    min-width: 37px;
    max-width: 37px;
    width: 37px !important;
    flex: 0 0 37px;
}
${root} #zotero-context-pane:not(.stacked)[collapsed="true"] > vbox {
    display: none;
}
${root} #zotero-context-pane.stacked[collapsed="true"] #zotero-context-pane-inner {
    visibility: visible;
    min-height: 37px;
    max-height: 37px;
    height: 37px !important;
}
${root} #zotero-context-pane-inner[collapsed="true"] > #zotero-context-pane-deck {
    display: none;
}
` + [PENDING_ATTRIBUTE, UNAVAILABLE_ATTRIBUTE, FOCUS_ATTRIBUTE]
            .flatMap(attribute => HIDDEN_SELECTORS.map(selector => (
                `:root[${MKTERO_TAB_SELECTED_ATTRIBUTE}][${attribute}] ${selector}`
            ))).join(',\n') + ' { display: none !important; }';
        document.documentElement.appendChild(this.style);
    }

    attribute(name, enabled) {
        this.document?.documentElement?.toggleAttribute?.(name, Boolean(enabled));
    }

    writeCollapsed(collapsed) {
        try {
            if (!this.controller || typeof this.controller.collapsed !== 'boolean') return false;
            this.controller.collapsed = Boolean(collapsed);
            // Mutations from our own selection/focus transitions must not be
            // replayed later as a fresh user close of a newer presentation.
            this.observer?.takeRecords?.();
            return this.controller.collapsed === Boolean(collapsed);
        }
        catch (error) {
            this.zotero?.logError?.(error);
            this.observer?.takeRecords?.();
            return false;
        }
    }

    captureSection() {
        if (!this.active || !this.ready) return;
        const record = this.records.get(this.active.tabID);
        if (!record || this.sidenav?.container !== this.context?._getItemContext?.(this.active.tabID)) return;
        record.mode = this.context.mode || 'item';
        record.pinnedPane = this.sidenav?.container?.pinnedPane || '';
    }

    async select(presentation) {
        if (this.disposed) return;
        if (presentation === this.active && this.ready
            && this.records.get(presentation?.tabID)?.itemID === presentation?.model.sourceItemID) {
            this.setFocusMode(presentation, presentation.view.focusMode);
            return;
        }
        this.captureSection();
        const generation = ++this.generation;
        this.ready = false;
        this.active = presentation || null;
        if (!presentation) {
            for (const attribute of OWN_ATTRIBUTES) this.attribute(attribute, false);
            if (this.nativeSnapshot) this.restoreNativeLayout();
            this.nativeSnapshot = null;
            return;
        }
        if (!this.nativeSnapshot && this.controller) {
            this.nativeSnapshot = { collapsed: Boolean(this.controller.collapsed) };
        }
        this.attribute(MKTERO_TAB_SELECTED_ATTRIBUTE, true);
        this.attribute(PENDING_ATTRIBUTE, true);
        this.attribute(UNAVAILABLE_ATTRIBUTE, false);
        this.attribute(FOCUS_ATTRIBUTE, presentation.view.focusMode);
        this.observer?.takeRecords?.();
        const item = this.zotero?.Items?.get?.(presentation.model.sourceItemID);
        if (!item || item.deleted || typeof this.context?._addItemContext !== 'function'
            || typeof this.context?._selectItemContext !== 'function') {
            this.release(presentation);
            this.attribute(PENDING_ATTRIBUTE, false);
            this.attribute(UNAVAILABLE_ATTRIBUTE, true);
            presentation.view.setNativeSidebarOpen?.(false);
            return;
        }
        try {
            const record = this.ensureContext(presentation, item);
            await record.promise;
            if (!this.isCurrent(presentation) || generation !== this.generation || record.released) return;
            const context = this.context;
            const container = context._getItemContext?.(presentation.tabID);
            if (!container) throw new Error('The Zotero item context could not be created');
            // Zotero 7 hardcodes reader in _addItemContext. Registered
            // sections must still receive the real custom tab type.
            container.tabType = 'mktero';
            context._selectItemContext(presentation.tabID);
            container.pinnedPane = record.pinnedPane;
            // Select the library synchronously: _setupNotesContext awaits an
            // attachment, then switches whichever tab has become current.
            this.setupNotes(presentation, item);
            context.mode = record.mode;
            if (this.sidenav) this.sidenav.hidden = false;
            const splitter = this.controller.splitter;
            splitter?.removeAttribute?.('hidden');
            if (!this.writeCollapsed(presentation.view.focusMode || !presentation.view.nativeSidebarOpen)) {
                throw new Error('The Zotero context pane could not change its expanded state');
            }
            this.ready = true;
            this.attribute(PENDING_ATTRIBUTE, false);
            this.window.Zotero_Tabs.updateSidebarLayout?.();
        }
        catch (error) {
            if (!this.isCurrent(presentation) || generation !== this.generation) return;
            const record = this.records.get(presentation.tabID);
            if (record) record.failed = true;
            this.zotero?.logError?.(error);
            this.attribute(PENDING_ATTRIBUTE, false);
            this.attribute(UNAVAILABLE_ATTRIBUTE, true);
            presentation.view.setNativeSidebarOpen?.(false);
        }
    }

    restoreNativeLayout() {
        this.writeCollapsed(this.nativeSnapshot.collapsed);
        // The library select handler has already hidden the reader pane. Its
        // splitter state still belongs to the next native reader, but setting
        // collapsed through the controller must not expose it in the library.
        if (this.window?.Zotero_Tabs?.selectedType === 'library') {
            for (const id of ['zotero-context-pane', 'zotero-context-pane-inner']) {
                this.document?.getElementById?.(id)?.setAttribute('collapsed', 'true');
            }
            for (const id of ['zotero-context-splitter', 'zotero-context-splitter-stacked']) {
                this.document?.getElementById?.(id)?.setAttribute('hidden', 'true');
            }
            if (this.sidenav) this.sidenav.hidden = true;
            this.observer?.takeRecords?.();
        }
    }

    ensureContext(presentation, item) {
        const id = presentation.tabID;
        const previous = this.records.get(id);
        if (previous?.itemID === presentation.model.sourceItemID
            && !previous.released && !previous.failed) return previous;
        const context = this.context;
        const pending = this.pending.get(id);
        const record = { itemID: presentation.model.sourceItemID, mode: 'item',
            pinnedPane: '', released: false, promise: null };
        record.promise = Promise.resolve().then(async () => {
            try { await pending; }
            catch { /* A failed earlier bind must not prevent retrying. */ }
            if (this.disposed || record.released || this.records.get(id) !== record) return;
            context._removeItemContext?.(id);
            await context._addItemContext(id, item.id ?? record.itemID, 'mktero');
            if (this.disposed || record.released || this.records.get(id) !== record) {
                context._removeItemContext?.(id);
            }
        });
        this.records.set(id, record);
        this.pending.set(id, record.promise);
        const clear = () => {
            if (this.pending.get(id) === record.promise) this.pending.delete(id);
        };
        record.promise.then(clear, clear);
        return record;
    }

    setupNotes(presentation, item) {
        const context = this.context;
        if (typeof context?._selectNotesContext !== 'function'
            || typeof context?._getCurrentNotesContext !== 'function') return;
        context._selectNotesContext(item.libraryID);
        const notes = context._getCurrentNotesContext();
        notes?.updateNotesListFromCache?.();
        notes?.switchToTab?.(presentation.tabID);
        if (this.sidenav) this.sidenav.contextNotesPaneEnabled = true;
    }

    observeExpansion() {
        const presentation = this.active;
        if (!this.ready || !this.isCurrent(presentation)) return;
        const open = this.controller?.collapsed === false;
        if (presentation.view.focusMode) {
            if (open) presentation.view.setNativeSidebarOpen?.(true);
            return;
        }
        if (open !== Boolean(presentation.view.nativeSidebarOpen)) {
            ++this.commandGeneration;
            presentation.view.setNativeSidebarOpen?.(open);
        }
    }

    setOpen(presentation, open) {
        if (!this.ready || !this.isCurrent(presentation)) return false;
        ++this.commandGeneration;
        return this.writeCollapsed(!open);
    }

    setFocusMode(presentation, enabled) {
        if (!this.isCurrent(presentation)) return false;
        const previous = this.document?.documentElement?.hasAttribute?.(FOCUS_ATTRIBUTE) === true;
        const next = Boolean(enabled);
        if (previous === next) return true;
        ++this.commandGeneration;
        this.attribute(FOCUS_ATTRIBUTE, next);
        if (!this.ready || this.writeCollapsed(next || !presentation.view.nativeSidebarOpen)) return true;
        this.attribute(FOCUS_ATTRIBUTE, previous);
        return false;
    }

    update(presentation) {
        if (presentation !== this.active) return Promise.resolve();
        return this.select(presentation);
    }

    release(presentation) {
        const record = this.records.get(presentation.tabID);
        if (!record) return;
        record.released = true;
        this.records.delete(presentation.tabID);
        this.removeContext(presentation.tabID);
    }

    removeContext(tabID) {
        try {
            this.context?._removeItemContext?.(tabID);
        }
        catch (error) {
            this.zotero?.logError?.(error);
        }
    }

    dispose() {
        if (this.disposed) return;
        this.captureSection();
        this.disposed = true;
        ++this.generation;
        this.observer?.disconnect?.();
        for (const [tabID, record] of this.records) {
            record.released = true;
            this.removeContext(tabID);
        }
        this.records.clear();
        for (const attribute of OWN_ATTRIBUTES) this.attribute(attribute, false);
        if (this.nativeSnapshot) this.restoreNativeLayout();
        this.nativeSnapshot = null;
        this.active = null;
        for (const restore of this.restorers) restore();
        this.restorers.length = 0;
        this.style?.remove?.();
    }
}
