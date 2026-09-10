import {
    createEmptyAnnotationOverlay,
} from '../core/markdown-annotation-overlay.js';
import {
    getMarkdownReaderFont,
    getMarkdownReaderFontSize,
    getMarkdownReaderSourcePeek,
    normalizeMarkdownReaderFont,
    normalizeMarkdownReaderFontSize,
    normalizeMarkdownReaderSourcePeek,
    observeMarkdownReaderFont,
    observeMarkdownReaderFontSize,
    observeMarkdownReaderSourcePeek,
    setMarkdownReaderFont,
    setMarkdownReaderFontSize,
    setMarkdownReaderSourcePeek,
} from '../config/reader-preferences.js';
import { createLocalization } from '../i18n/localization.js';
import { createMarkdownTabView } from './markdown-window.js';
import { createEmptyTranslationState } from './markdown-tab-state.js';
import {
    installMkteroSessionStateFilter,
    removeStaleMkteroSessionTabs,
} from './mktero-session-tabs.js';

const TAB_TYPE = 'mktero';
const TAB_ICON = 'markdown';
const TAB_ICON_STYLE_ID = 'mktero-markdown-tab-icon-style';
const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

export const MARKDOWN_TAB_CLOSE_REASONS = Object.freeze({
    USER: 'user',
    REPLACEMENT: 'replacement',
    SHUTDOWN: 'shutdown',
});

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
        this.readerFont = getMarkdownReaderFont(zotero);
        this.readerFontSize = getMarkdownReaderFontSize(zotero);
        this.readerSourcePeek = getMarkdownReaderSourcePeek(zotero);
        this.presentations = new Map();
        this.disposeReaderFontObserver = observeMarkdownReaderFont(
            zotero,
            font => this.applyReaderFont(font)
        );
        this.disposeReaderFontSizeObserver = observeMarkdownReaderFontSize(
            zotero,
            size => this.applyReaderFontSize(size)
        );
        this.disposeReaderSourcePeekObserver = observeMarkdownReaderSourcePeek(
            zotero,
            enabled => this.applyReaderSourcePeek(enabled)
        );
        this.sessionStateTabs = null;
        this.disposeSessionStateFilter = null;
        this.tabIconStyle = null;
        this.removeStaleSessionTabs();
        this.ensureSessionStateFilter();
    }

    open(documentID, {
        sourceItemID = documentID,
        onClose,
        onReparse,
        onOpenCitationGraph,
        onOpenSettings,
        onSaveSnapshot,
        onExportMarkdown,
        onSetCorrectionMode,
        onCommitCorrection,
        onRestoreCorrection,
        onRestoreAllCorrections,
        onTranslateDocument,
        onCancelDocumentTranslation,
        onTranslateSelection,
        onCancelSelectionTranslation,
        shouldAutoTranslateSelection,
        onCopySelectionTranslation,
        onSetTranslationView,
        onSelectTranslationLanguage,
        onChangeAnnotationColor,
        onUpdateAnnotationComment,
        onDeleteAnnotation,
        onOpenAnnotationInPDF,
        onOpenSourceInPDF,
        onRenderSourcePeek,
        onDisposeSourcePeek,
        onCopySourcedMarkdown,
        onCopyCode,
        onCreateMarkdownAnnotation,
        onUpdateMarkdownAnnotation,
        onDeleteMarkdownAnnotation,
        onRetryMarkdownAnnotationSynchronization,
        onListReferenceLibraries,
        onGetReferenceStatus,
        onSearchReferenceMetadata,
        onImportReference,
        onOpenReferenceMatch,
        onSubscribeReferenceUpdates,
        onReadingPositionChange,
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
            if (onOpenCitationGraph !== undefined) {
                existing.model.onOpenCitationGraph = onOpenCitationGraph;
            }
            if (onOpenSettings !== undefined) {
                existing.model.onOpenSettings = onOpenSettings;
            }
            if (onSaveSnapshot !== undefined) {
                existing.model.onSaveSnapshot = onSaveSnapshot;
            }
            if (onExportMarkdown !== undefined) {
                existing.model.onExportMarkdown = onExportMarkdown;
            }
            if (onSetCorrectionMode !== undefined) {
                existing.model.onSetCorrectionMode = onSetCorrectionMode;
            }
            if (onCommitCorrection !== undefined) {
                existing.model.onCommitCorrection = onCommitCorrection;
            }
            if (onRestoreCorrection !== undefined) {
                existing.model.onRestoreCorrection = onRestoreCorrection;
            }
            if (onRestoreAllCorrections !== undefined) {
                existing.model.onRestoreAllCorrections
                    = onRestoreAllCorrections;
            }
            if (onTranslateDocument !== undefined) {
                existing.model.onTranslateDocument = onTranslateDocument;
            }
            if (onCancelDocumentTranslation !== undefined) {
                existing.model.onCancelDocumentTranslation
                    = onCancelDocumentTranslation;
            }
            if (onTranslateSelection !== undefined) {
                existing.model.onTranslateSelection = onTranslateSelection;
            }
            if (onCancelSelectionTranslation !== undefined) {
                existing.model.onCancelSelectionTranslation
                    = onCancelSelectionTranslation;
            }
            if (shouldAutoTranslateSelection !== undefined) {
                existing.model.shouldAutoTranslateSelection
                    = shouldAutoTranslateSelection;
            }
            if (onCopySelectionTranslation !== undefined) {
                existing.model.onCopySelectionTranslation
                    = onCopySelectionTranslation;
            }
            if (onSetTranslationView !== undefined) {
                existing.model.onSetTranslationView = onSetTranslationView;
            }
            if (onSelectTranslationLanguage !== undefined) {
                existing.model.onSelectTranslationLanguage
                    = onSelectTranslationLanguage;
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
            if (onRenderSourcePeek !== undefined) {
                existing.model.onRenderSourcePeek = onRenderSourcePeek;
            }
            if (onDisposeSourcePeek !== undefined) {
                existing.model.onDisposeSourcePeek = onDisposeSourcePeek;
            }
            if (onCopySourcedMarkdown) {
                existing.model.onCopySourcedMarkdown = onCopySourcedMarkdown;
            }
            if (onCopyCode) {
                existing.model.onCopyCode = onCopyCode;
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
            if (onListReferenceLibraries !== undefined) {
                existing.model.onListReferenceLibraries = onListReferenceLibraries;
            }
            if (onGetReferenceStatus !== undefined) {
                existing.model.onGetReferenceStatus = onGetReferenceStatus;
            }
            if (onSearchReferenceMetadata !== undefined) {
                existing.model.onSearchReferenceMetadata = onSearchReferenceMetadata;
            }
            if (onImportReference !== undefined) {
                existing.model.onImportReference = onImportReference;
            }
            if (onOpenReferenceMatch !== undefined) {
                existing.model.onOpenReferenceMatch = onOpenReferenceMatch;
            }
            if (onSubscribeReferenceUpdates !== undefined) {
                existing.model.onSubscribeReferenceUpdates = onSubscribeReferenceUpdates;
            }
            if (onReadingPositionChange !== undefined) {
                existing.model.onReadingPositionChange = onReadingPositionChange;
            }
            tabs.select(existing.tabID);
            return { ...existing, created: false };
        }

        const model = createInitialModel(
            documentID,
            sourceItemID,
            {
                onReparse,
                onOpenCitationGraph,
                onOpenSettings,
                onSaveSnapshot,
                onExportMarkdown,
                onSetCorrectionMode,
                onCommitCorrection,
                onRestoreCorrection,
                onRestoreAllCorrections,
                onTranslateDocument,
                onCancelDocumentTranslation,
                onTranslateSelection,
                onCancelSelectionTranslation,
                shouldAutoTranslateSelection,
                onCopySelectionTranslation,
                onSetTranslationView,
                onSelectTranslationLanguage,
                onChangeAnnotationColor,
                onUpdateAnnotationComment,
                onDeleteAnnotation,
                onOpenAnnotationInPDF,
                onOpenSourceInPDF,
                onRenderSourcePeek,
                onDisposeSourcePeek,
                onCopySourcedMarkdown,
                onCopyCode,
                onCreateMarkdownAnnotation,
                onUpdateMarkdownAnnotation,
                onDeleteMarkdownAnnotation,
                onRetryMarkdownAnnotationSynchronization,
                onListReferenceLibraries,
                onGetReferenceStatus,
                onSearchReferenceMetadata,
                onImportReference,
                onOpenReferenceMatch,
                onSubscribeReferenceUpdates,
                onReadingPositionChange,
            },
            this.localization.t.bind(this.localization)
        );
        const view = this.createView({
            document: owner.document,
            rootURI: this.rootURI,
            model,
            zotero: this.zotero,
            localization: this.localization,
            readerFont: this.readerFont,
            readerFontSize: this.readerFontSize,
            onReaderFontChange: font => this.updateReaderFont(font),
            onReaderFontSizeChange: size => this.updateReaderFontSize(size),
            readerSourcePeek: this.readerSourcePeek,
            onReaderSourcePeekChange: enabled => (
                this.updateReaderSourcePeek(enabled)
            ),
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
                    if (presentation?.closed) return;
                    const reason = presentation?.closeReason
                        || MARKDOWN_TAB_CLOSE_REASONS.USER;
                    if (presentation) {
                        presentation.closed = true;
                        presentation.closeReason = null;
                    }
                    presentation?.view.destroy?.();
                    if (this.presentations.get(documentID)?.tabID === tabID) {
                        this.presentations.delete(documentID);
                    }
                    try {
                        presentation?.onClose?.({ reason });
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
            closeReason: null,
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

    updateReaderFontSize(size) {
        const normalized = normalizeMarkdownReaderFontSize(size);
        try {
            setMarkdownReaderFontSize(this.zotero, normalized);
        }
        catch (error) {
            this.zotero.logError?.(error);
        }
        this.applyReaderFontSize(normalized);
        return normalized;
    }

    updateReaderFont(font) {
        const normalized = normalizeMarkdownReaderFont(font);
        try {
            setMarkdownReaderFont(this.zotero, normalized);
        }
        catch (error) {
            this.zotero.logError?.(error);
        }
        this.applyReaderFont(normalized);
        return normalized;
    }

    applyReaderFont(font) {
        const normalized = normalizeMarkdownReaderFont(font);
        if (normalized === this.readerFont) return;
        this.readerFont = normalized;
        for (const presentation of this.presentations.values()) {
            presentation.view.setReaderFont?.(normalized);
        }
    }

    applyReaderFontSize(size) {
        const normalized = normalizeMarkdownReaderFontSize(size);
        if (normalized === this.readerFontSize) return;
        this.readerFontSize = normalized;
        for (const presentation of this.presentations.values()) {
            presentation.view.setReaderFontSize?.(normalized);
        }
    }

    updateReaderSourcePeek(enabled) {
        const normalized = normalizeMarkdownReaderSourcePeek(enabled);
        try {
            setMarkdownReaderSourcePeek(this.zotero, normalized);
        }
        catch (error) {
            this.zotero.logError?.(error);
        }
        this.applyReaderSourcePeek(normalized);
        return normalized;
    }

    applyReaderSourcePeek(enabled) {
        const normalized = normalizeMarkdownReaderSourcePeek(enabled);
        if (normalized === this.readerSourcePeek) return;
        this.readerSourcePeek = normalized;
        for (const presentation of this.presentations.values()) {
            presentation.view.setReaderSourcePeek?.(normalized);
        }
    }

    getForSourceItem(sourceItemID) {
        if (sourceItemID === null || sourceItemID === undefined) return null;
        const sourceKey = String(sourceItemID);
        return [...this.presentations.values()].find(presentation => (
            String(presentation.model.sourceItemID) === sourceKey
        )) || null;
    }

    closeForSourceItem(sourceItemID, {
        exceptDocumentID = null,
        reason = MARKDOWN_TAB_CLOSE_REASONS.REPLACEMENT,
    } = {}) {
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
            this.closePresentation(presentation, reason);
        }
    }

    list() {
        return [...this.presentations.values()];
    }

    closeAll({ reason = MARKDOWN_TAB_CLOSE_REASONS.USER } = {}) {
        for (const presentation of [...this.presentations.values()]) {
            this.closePresentation(presentation, reason);
        }
        this.presentations.clear();
    }

    dispose() {
        this.disposeReaderFontObserver?.();
        this.disposeReaderFontObserver = null;
        this.disposeReaderFontSizeObserver?.();
        this.disposeReaderFontSizeObserver = null;
        this.disposeReaderSourcePeekObserver?.();
        this.disposeReaderSourcePeekObserver = null;
        this.closeAll({ reason: MARKDOWN_TAB_CLOSE_REASONS.SHUTDOWN });
        this.restoreSessionStateFilter();
        this.tabIconStyle?.remove?.();
        this.tabIconStyle = null;
    }

    closePresentation(presentation, reason) {
        if (!presentation || presentation.closed) return;
        presentation.closeReason = reason;
        presentation.tabs.close?.(presentation.tabID);
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
        if (this.sessionStateTabs === tabs) return;

        this.restoreSessionStateFilter();
        this.disposeSessionStateFilter = installMkteroSessionStateFilter(tabs);
        this.sessionStateTabs = tabs;
    }

    restoreSessionStateFilter() {
        this.disposeSessionStateFilter?.();
        this.disposeSessionStateFilter = null;
        this.sessionStateTabs = null;
    }

    debug(message) {
        this.zotero.debug?.(`Mktero: ${message}`);
    }

    removeStaleSessionTabs() {
        removeStaleMkteroSessionTabs(this.zotero);
    }
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
        provider: null,
        parserProfile: null,
        renderMode: 'markdown',
        cacheHit: false,
        cacheKey: null,
        sourceHash: null,
        sourceMap: [],
        annotationOverlay: createEmptyAnnotationOverlay(),
        editableBlocks: [],
        correctedBlockIDs: [],
        correctionCount: 0,
        hasCorrections: false,
        correctionMode: false,
        ...createEmptyTranslationState(),
        preserveContent: false,
        resumingTask: false,
        warnings: [],
        error: '',
        errorAction: null,
        warningAction: null,
        snapshotHTML: '',
        snapshotAssets: [],
        snapshotModified: false,
        ...actions,
    };
}
