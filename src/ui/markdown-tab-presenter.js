import {
    createEmptyAnnotationOverlay,
} from '../core/markdown-annotation-overlay.js';
import { createLocalization } from '../i18n/localization.js';
import { createMarkdownTabView } from './markdown-window.js';

const TAB_TYPE = 'mktero';
const TAB_ICON = 'markdown';
const TAB_ICON_STYLE_ID = 'mktero-markdown-tab-icon-style';
const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

export class MarkdownTabPresenter {
    constructor({
        zotero,
        rootURI,
        createView = createMarkdownTabView,
        localization = createLocalization(),
    }) {
        this.zotero = zotero;
        this.rootURI = rootURI;
        this.createView = createView;
        this.localization = localization;
        this.presentations = new Map();
        this.sessionStatePatch = null;
        this.tabIconStyle = null;
        this.removeStaleSessionTabs();
        this.ensureSessionStateFilter();
    }

    open(documentID, {
        sourceItemID = documentID,
        onClose,
        onReparse,
        onSaveSnapshot,
        onChangeAnnotationColor,
        onUpdateAnnotationComment,
        onDeleteAnnotation,
        onOpenAnnotationInPDF,
        onOpenSourceInPDF,
        onCopySourcedMarkdown,
        onCreateMarkdownAnnotation,
        onUpdateMarkdownAnnotation,
        onDeleteMarkdownAnnotation,
        onRetryMarkdownAnnotationSynchronization,
    } = {}) {
        this.ensureSessionStateFilter();
        const owner = this.zotero.getMainWindow?.();
        const tabs = owner?.Zotero_Tabs;
        if (!owner?.document || !tabs?.add || !tabs?.select) {
            throw new Error(this.localization.t('error.tabManagerUnavailable'));
        }
        this.ensureTabIconStyle(owner.document);

        const existing = this.presentations.get(documentID);
        if (existing) {
            if (sourceItemID !== null && sourceItemID !== undefined) {
                existing.model.itemID = sourceItemID;
                existing.model.sourceItemID = sourceItemID;
                this.closeForSourceItem(sourceItemID, {
                    exceptDocumentID: documentID,
                });
            }
            if (onClose) existing.onClose = onClose;
            if (onReparse !== undefined) {
                existing.model.onReparse = onReparse;
            }
            if (onSaveSnapshot !== undefined) {
                existing.model.onSaveSnapshot = onSaveSnapshot;
            }
            if (onChangeAnnotationColor) {
                existing.model.onChangeAnnotationColor = onChangeAnnotationColor;
            }
            if (onUpdateAnnotationComment) {
                existing.model.onUpdateAnnotationComment
                    = onUpdateAnnotationComment;
            }
            if (onDeleteAnnotation) {
                existing.model.onDeleteAnnotation = onDeleteAnnotation;
            }
            if (onOpenAnnotationInPDF) {
                existing.model.onOpenAnnotationInPDF = onOpenAnnotationInPDF;
            }
            if (onOpenSourceInPDF) {
                existing.model.onOpenSourceInPDF = onOpenSourceInPDF;
            }
            if (onCopySourcedMarkdown) {
                existing.model.onCopySourcedMarkdown = onCopySourcedMarkdown;
            }
            if (onCreateMarkdownAnnotation) {
                existing.model.onCreateMarkdownAnnotation
                    = onCreateMarkdownAnnotation;
            }
            if (onUpdateMarkdownAnnotation) {
                existing.model.onUpdateMarkdownAnnotation
                    = onUpdateMarkdownAnnotation;
            }
            if (onDeleteMarkdownAnnotation) {
                existing.model.onDeleteMarkdownAnnotation
                    = onDeleteMarkdownAnnotation;
            }
            if (onRetryMarkdownAnnotationSynchronization) {
                existing.model.onRetryMarkdownAnnotationSynchronization
                    = onRetryMarkdownAnnotationSynchronization;
            }
            tabs.select(existing.tabID);
            return { ...existing, created: false };
        }

        const model = createInitialModel(
            documentID,
            sourceItemID,
            {
                onReparse,
                onSaveSnapshot,
                onChangeAnnotationColor,
                onUpdateAnnotationComment,
                onDeleteAnnotation,
                onOpenAnnotationInPDF,
                onOpenSourceInPDF,
                onCopySourcedMarkdown,
                onCreateMarkdownAnnotation,
                onUpdateMarkdownAnnotation,
                onDeleteMarkdownAnnotation,
                onRetryMarkdownAnnotationSynchronization,
            },
            this.localization.t.bind(this.localization)
        );
        const view = this.createView({
            document: owner.document,
            rootURI: this.rootURI,
            model,
            zotero: this.zotero,
            localization: this.localization,
        });
        view.render(model);
        this.closeForSourceItem(sourceItemID, {
            exceptDocumentID: documentID,
        });
        let presentation;
        let tabID;
        try {
            const result = tabs.add({
                type: TAB_TYPE,
                title: model.title,
                data: {
                    mkteroItemID: documentID,
                    mkteroDocumentID: documentID,
                    mkteroSourceItemID: sourceItemID,
                    icon: TAB_ICON,
                },
                select: true,
                preventJumpback: true,
                onClose: () => {
                    if (presentation) presentation.closed = true;
                    presentation?.view.destroy?.();
                    if (this.presentations.get(documentID)?.tabID === tabID) {
                        this.presentations.delete(documentID);
                    }
                    try {
                        presentation?.onClose?.();
                    }
                    catch (error) {
                        this.zotero.logError?.(error);
                    }
                },
            });
            tabID = result.id;
            result.container.appendChild(view.root);
        }
        catch (error) {
            view.destroy?.();
            if (tabID) tabs.close?.(tabID);
            throw error;
        }

        presentation = {
            tabs,
            tabID,
            view,
            model,
            closed: false,
            onClose,
        };
        this.presentations.set(documentID, presentation);

        this.debug('Opened inline Markdown view for document ' + documentID);

        return { ...presentation, created: true };
    }

    update(presentation, changes) {
        const current = this.presentations.get(presentation.model.documentID);
        if (!current || current.tabID !== presentation.tabID || current.closed) return;

        Object.assign(current.model, changes);
        if (typeof changes.title === 'string' && changes.title) {
            current.tabs.rename?.(current.tabID, changes.title);
        }
        current.view.render(current.model);
    }

    get(documentID) {
        return this.presentations.get(documentID) || null;
    }

    getForSourceItem(sourceItemID) {
        if (sourceItemID === null || sourceItemID === undefined) return null;
        const sourceKey = String(sourceItemID);
        return [...this.presentations.values()].find(presentation => (
            String(presentation.model.sourceItemID) === sourceKey
        )) || null;
    }

    closeForSourceItem(sourceItemID, { exceptDocumentID = null } = {}) {
        if (sourceItemID === null || sourceItemID === undefined) return;
        const sourceKey = String(sourceItemID);
        const exceptKey = exceptDocumentID === null
            || exceptDocumentID === undefined
            ? null
            : String(exceptDocumentID);
        for (const presentation of [...this.presentations.values()]) {
            if (String(presentation.model.sourceItemID) !== sourceKey
                || String(presentation.model.documentID) === exceptKey
                || presentation.closed) {
                continue;
            }
            presentation.tabs.close?.(presentation.tabID);
        }
    }

    list() {
        return [...this.presentations.values()];
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
        this.tabIconStyle?.remove?.();
        this.tabIconStyle = null;
    }

    ensureTabIconStyle(document) {
        const existing = document.getElementById?.(TAB_ICON_STYLE_ID);
        if (existing) {
            this.tabIconStyle = existing;
            return;
        }
        if (!document.createElementNS || !document.documentElement?.appendChild) return;

        const style = document.createElementNS(XHTML_NAMESPACE, 'style');
        style.setAttribute('id', TAB_ICON_STYLE_ID);
        style.textContent = `
.icon-item-type[data-item-type="${TAB_ICON}"] {
    background-image: url("${this.rootURI}ui/icons/mktero.svg") !important;
    background-position: center !important;
    background-repeat: no-repeat !important;
    background-size: contain !important;
}
`;
        document.documentElement.appendChild(style);
        this.tabIconStyle = style;
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

function isMkteroSessionTab(tab) {
    return tab?.type === TAB_TYPE && tab.data?.mkteroItemID !== undefined;
}

function createInitialModel(
    documentID,
    sourceItemID,
    actions,
    translate
) {
    return {
        itemID: sourceItemID,
        documentID,
        sourceItemID,
        title: translate('loading.convertingTitle'),
        status: 'loading',
        progress: 0,
        markdown: '',
        assets: [],
        assetBasePath: '',
        sourceKind: null,
        renderMode: 'markdown',
        cacheHit: false,
        cacheKey: null,
        sourceMap: [],
        annotationOverlay: createEmptyAnnotationOverlay(),
        preserveContent: false,
        resumingTask: false,
        warnings: [],
        error: '',
        snapshotHTML: '',
        snapshotAssets: [],
        snapshotModified: false,
        ...actions,
    };
}
