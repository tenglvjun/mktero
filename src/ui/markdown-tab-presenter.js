const TAB_TYPE = 'mktero';

export class MarkdownTabPresenter {
    constructor({ zotero, rootURI }) {
        this.zotero = zotero;
        this.rootURI = rootURI;
        this.presentations = new Map();
        this.sessionStatePatch = null;
        this.removeStaleSessionTabs();
        this.ensureSessionStateFilter();
    }

    open(itemID) {
        this.ensureSessionStateFilter();
        const owner = this.zotero.getMainWindow?.();
        const tabs = owner?.Zotero_Tabs;
        if (!owner?.document || !tabs?.add || !tabs?.select) {
            throw new Error('The Zotero tab manager is not available');
        }

        const existing = this.presentations.get(itemID);
        if (existing) {
            tabs.select(existing.tabID);
            return { ...existing, created: false };
        }

        const model = createInitialModel(itemID);
        const browser = owner.document.createXULElement('browser');
        browser.setAttribute('type', 'content');
        browser.setAttribute('flex', '1');
        browser.setAttribute('src', `${this.rootURI}ui/markdown.xhtml`);
        browser.style.width = '100%';
        browser.style.height = '100%';
        browser.mkteroModel = model;
        browser.addEventListener?.('load', () => {
            const contentWindow = browser.contentWindow;
            if (!contentWindow) return;
            contentWindow.mkteroModel = model;
            contentWindow.dispatchEvent(new contentWindow.CustomEvent('mktero:model-update'));
        }, { once: true });

        let presentation;
        const { id: tabID, container } = tabs.add({
            type: TAB_TYPE,
            title: 'Markdown',
            data: {
                mkteroItemID: itemID,
                icon: 'attachment-pdf',
            },
            select: true,
            preventJumpback: true,
            onClose: () => {
                if (presentation) presentation.closed = true;
                if (this.presentations.get(itemID)?.tabID === tabID) {
                    this.presentations.delete(itemID);
                }
            },
        });
        container.appendChild(browser);

        presentation = { tabs, tabID, browser, model, closed: false };
        this.presentations.set(itemID, presentation);
        return { ...presentation, created: true };
    }

    update(presentation, changes) {
        const current = this.presentations.get(presentation.model.itemID);
        if (!current || current.tabID !== presentation.tabID || current.closed) return;

        Object.assign(current.model, changes);
        if (typeof changes.title === 'string' && changes.title) {
            current.tabs.rename?.(current.tabID, changes.title);
        }

        const contentWindow = current.browser.contentWindow;
        if (contentWindow?.dispatchEvent && contentWindow.CustomEvent) {
            contentWindow.dispatchEvent(new contentWindow.CustomEvent('mktero:model-update'));
        }
    }

    closeAll() {
        for (const presentation of [...this.presentations.values()]) {
            if (!presentation.closed) presentation.tabs.close?.(presentation.tabID);
        }
        this.presentations.clear();
    }

    dispose() {
        this.closeAll();
        this.restoreSessionStateFilter();
    }

    ensureSessionStateFilter() {
        const owner = this.zotero.getMainWindow?.();
        const tabs = owner?.Zotero_Tabs;
        if (!tabs?.getState) return;
        if (this.sessionStatePatch?.tabs === tabs) return;

        this.restoreSessionStateFilter();
        const originalGetState = tabs.getState;
        const filteredGetState = function filteredGetState() {
            const state = originalGetState.call(this);
            if (!Array.isArray(state)) return state;
            return state.filter(tab => !isMkteroSessionTab(tab));
        };
        tabs.getState = filteredGetState;
        this.sessionStatePatch = { tabs, originalGetState, filteredGetState };
    }

    restoreSessionStateFilter() {
        const patch = this.sessionStatePatch;
        if (!patch) return;
        if (patch.tabs.getState === patch.filteredGetState) {
            patch.tabs.getState = patch.originalGetState;
        }
        this.sessionStatePatch = null;
    }

    removeStaleSessionTabs() {
        const windows = this.zotero.Session?.state?.windows;
        if (!Array.isArray(windows)) return;

        for (const windowState of windows) {
            if (!Array.isArray(windowState.tabs)) continue;
            windowState.tabs = windowState.tabs.filter(tab => !isMkteroSessionTab(tab));
        }
    }
}

function isMkteroSessionTab(tab) {
    return tab?.type === TAB_TYPE && tab.data?.mkteroItemID !== undefined;
}

function createInitialModel(itemID) {
    return {
        itemID,
        title: 'Converting PDF…',
        status: 'loading',
        progress: 0,
        markdown: '',
        sourceKind: null,
        warnings: [],
        error: '',
    };
}
