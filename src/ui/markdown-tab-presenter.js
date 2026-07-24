import { createLoadingPresentation } from './markdown-loading-state.js';

const TAB_TYPE = 'mktero';
const LOAD_TIMEOUT_MS = 5000;
const MARKDOWN_PAGE_ID = 'mktero-markdown-page';

export class MarkdownTabPresenter {
    constructor({ zotero, rootURI, services = getRuntimeServices() }) {
        this.zotero = zotero;
        this.rootURI = rootURI;
        this.services = services;
        this.presentations = new Map();
        this.sessionStatePatch = null;
        this.removeStaleSessionTabs();
        this.ensureSessionStateFilter();
    }

    open(itemID, { onClose, onReparse } = {}) {
        this.ensureSessionStateFilter();
        const owner = this.zotero.getMainWindow?.();
        const tabs = owner?.Zotero_Tabs;
        if (!owner?.document || !tabs?.add || !tabs?.select) {
            throw new Error('The Zotero tab manager is not available');
        }

        const existing = this.presentations.get(itemID);
        if (existing) {
            if (onClose) existing.onClose = onClose;
            if (onReparse) existing.model.onReparse = onReparse;
            tabs.select(existing.tabID);
            return { ...existing, created: false };
        }

        const model = createInitialModel(itemID, onReparse);
        const browser = owner.document.createXULElement('browser');
        const stack = owner.document.createXULElement('stack');
        const nativeLoading = owner.document.createXULElement('vbox');
        const nativeLoadingTitle = owner.document.createXULElement('label');
        const nativeLoadingLabel = owner.document.createXULElement('label');
        const nativeLoadingProgress = owner.document.createXULElement('progressmeter');
        const nativeLoadingHint = owner.document.createXULElement('label');
        const browserURI = `${this.rootURI}ui/markdown.xhtml`;
        stack.setAttribute('flex', '1');
        stack.style.width = '100%';
        stack.style.height = '100%';
        browser.setAttribute('type', 'content');
        browser.setAttribute('flex', '1');
        browser.setAttribute('remote', 'false');
        browser.setAttribute('maychangeremoteness', 'true');
        browser.style.width = '100%';
        browser.style.height = '100%';
        browser.mkteroModel = model;

        configureNativeLoading({
            nativeLoading,
            nativeLoadingTitle,
            nativeLoadingLabel,
            nativeLoadingProgress,
            nativeLoadingHint,
        });
        stack.appendChild(browser);
        stack.appendChild(nativeLoading);

        let presentation;
        let browserLoaded = false;
        const cleanupBrowserLoad = () => {
            owner.removeEventListener?.('DOMContentLoaded', handleBrowserDOMContentLoaded);
            if (presentation && presentation.loadTimeoutID !== null) {
                owner.clearTimeout?.(presentation.loadTimeoutID);
                presentation.loadTimeoutID = null;
            }
        };
        const handleBrowserDOMContentLoaded = event => {
            if (!browser.contentWindow
                || browser.contentWindow.document !== event.target) return;
            if (event.target.documentElement?.id !== MARKDOWN_PAGE_ID) return;
            browserLoaded = true;
            cleanupBrowserLoad();
            nativeLoading.hidden = true;
            this.debug(
                `Markdown view loaded for item ${itemID} (${describeURIScheme(browserURI)})`
            );
            const contentWindow = browser.contentWindow;
            contentWindow.mkteroModel = model;
            contentWindow.dispatchEvent(new contentWindow.CustomEvent('mktero:model-update'));
        };
        owner.addEventListener?.('DOMContentLoaded', handleBrowserDOMContentLoaded);

        const { id: tabID, container } = tabs.add({
            type: TAB_TYPE,
            title: model.title,
            data: {
                mkteroItemID: itemID,
                icon: 'attachment-pdf',
            },
            select: true,
            preventJumpback: true,
            onClose: () => {
                if (presentation) presentation.closed = true;
                cleanupBrowserLoad();
                if (this.presentations.get(itemID)?.tabID === tabID) {
                    this.presentations.delete(itemID);
                }
                try {
                    presentation?.onClose?.();
                }
                catch (error) {
                    this.zotero.logError?.(error);
                }
            },
        });
        container.appendChild(stack);

        presentation = {
            tabs,
            tabID,
            stack,
            browser,
            browserURI,
            model,
            nativeLoading,
            nativeLoadingTitle,
            nativeLoadingLabel,
            nativeLoadingProgress,
            nativeLoadingHint,
            closed: false,
            onClose,
            loadTimeoutID: null,
        };
        syncNativeLoading(presentation);
        this.presentations.set(itemID, presentation);

        this.debug(
            `Opening Markdown view for item ${itemID} `
            + `(${describeURIScheme(browserURI)}, remote=false)`
        );
        if (owner.setTimeout) {
            presentation.loadTimeoutID = owner.setTimeout(() => {
                presentation.loadTimeoutID = null;
                if (browserLoaded || presentation.closed) return;
                const currentURI = browser.currentURI?.spec || 'unavailable';
                nativeLoadingHint.setAttribute(
                    'value',
                    'The Markdown view is still loading. Conversion status will continue here.'
                );
                this.zotero.logError?.(new Error(
                    `Mktero: Markdown view did not load for item ${itemID} within `
                    + `${LOAD_TIMEOUT_MS}ms (current URI: ${describeURIScheme(currentURI)})`
                ));
            }, LOAD_TIMEOUT_MS);
        }
        this.loadBrowser(browser, browserURI);

        return { ...presentation, created: true };
    }

    update(presentation, changes) {
        const current = this.presentations.get(presentation.model.itemID);
        if (!current || current.tabID !== presentation.tabID || current.closed) return;

        Object.assign(current.model, changes);
        if (typeof changes.title === 'string' && changes.title) {
            current.tabs.rename?.(current.tabID, changes.title);
        }
        syncNativeLoading(current);

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

    loadBrowser(browser, browserURI) {
        const uri = this.services?.io?.newURI?.(browserURI);
        const principal = this.services?.scriptSecurityManager?.getSystemPrincipal?.();
        if (uri && principal && typeof browser.loadURI === 'function') {
            try {
                browser.loadURI(uri, { triggeringPrincipal: principal });
                return;
            }
            catch (error) {
                this.zotero.logError?.(error);
            }
        }
        browser.setAttribute('src', browserURI);
    }

    debug(message) {
        this.zotero.debug?.(`Mktero: ${message}`);
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

function configureNativeLoading({
    nativeLoading,
    nativeLoadingTitle,
    nativeLoadingLabel,
    nativeLoadingProgress,
    nativeLoadingHint,
}) {
    nativeLoading.hidden = false;
    nativeLoading.setAttribute('flex', '1');
    nativeLoading.setAttribute('align', 'center');
    nativeLoading.setAttribute('pack', 'center');
    nativeLoading.style.width = '100%';
    nativeLoading.style.height = '100%';
    nativeLoading.style.backgroundColor = 'Canvas';
    nativeLoading.style.color = 'CanvasText';
    nativeLoading.style.zIndex = '1';

    nativeLoadingTitle.setAttribute('value', 'Mktero');
    nativeLoadingTitle.style.fontSize = '18px';
    nativeLoadingTitle.style.fontWeight = '600';
    nativeLoadingTitle.style.marginBottom = '10px';
    nativeLoadingLabel.style.fontSize = '14px';
    nativeLoadingProgress.setAttribute('mode', 'undetermined');
    nativeLoadingProgress.style.width = '320px';
    nativeLoadingProgress.style.maxWidth = '70%';
    nativeLoadingProgress.style.marginTop = '16px';
    nativeLoadingHint.setAttribute(
        'value',
        'This may take a few minutes. You can keep this tab open.'
    );
    nativeLoadingHint.style.marginTop = '12px';
    nativeLoadingHint.style.opacity = '0.7';

    nativeLoading.appendChild(nativeLoadingTitle);
    nativeLoading.appendChild(nativeLoadingLabel);
    nativeLoading.appendChild(nativeLoadingProgress);
    nativeLoading.appendChild(nativeLoadingHint);
}

function syncNativeLoading(presentation) {
    if (presentation.nativeLoading.hidden) return;
    const model = presentation.model;
    if (model.status === 'loading') {
        const loading = createLoadingPresentation(model);
        presentation.nativeLoadingProgress.hidden = false;
        presentation.nativeLoadingLabel.setAttribute(
            'value',
            loading.detail.replace(/\.$/, '…')
        );
        if (loading.progress > 0) {
            presentation.nativeLoadingProgress.setAttribute('mode', 'normal');
            presentation.nativeLoadingProgress.setAttribute('value', loading.progress);
        }
        else {
            presentation.nativeLoadingProgress.setAttribute('mode', 'undetermined');
        }
        return;
    }
    if (model.status === 'ready') {
        presentation.nativeLoadingLabel.setAttribute(
            'value',
            model.cacheHit
                ? 'Cached Markdown is ready. Loading the view…'
                : 'Conversion complete. Loading the Markdown view…'
        );
        presentation.nativeLoadingProgress.setAttribute('mode', 'normal');
        presentation.nativeLoadingProgress.setAttribute('value', 100);
        return;
    }
    presentation.nativeLoadingLabel.setAttribute(
        'value',
        `Conversion failed: ${model.error || 'Unknown error'}`
    );
    presentation.nativeLoadingProgress.hidden = true;
}

function describeURIScheme(uri) {
    return String(uri).match(/^([a-z][a-z0-9+.-]*):/i)?.[1] || 'unknown';
}

function getRuntimeServices() {
    return typeof Services === 'undefined' ? null : Services;
}

function isMkteroSessionTab(tab) {
    return tab?.type === TAB_TYPE && tab.data?.mkteroItemID !== undefined;
}

function createInitialModel(itemID, onReparse) {
    return {
        itemID,
        title: 'Converting PDF…',
        status: 'loading',
        progress: 0,
        markdown: '',
        assets: [],
        assetBasePath: '',
        sourceKind: null,
        cacheHit: false,
        preserveContent: false,
        warnings: [],
        error: '',
        onReparse,
    };
}
