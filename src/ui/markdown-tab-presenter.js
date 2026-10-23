import {
    createEmptyAnnotationOverlay,
} from '../core/markdown-annotation-overlay.js';
import {
    getMarkdownReaderAlignment,
    getMarkdownReaderFont,
    getMarkdownReaderFontSize,
    getMarkdownReaderLineHeight,
    getMarkdownReaderSourcePeek,
    getMarkdownReaderWidth,
    normalizeMarkdownReaderAlignment,
    normalizeMarkdownReaderFont,
    normalizeMarkdownReaderFontSize,
    normalizeMarkdownReaderLineHeight,
    normalizeMarkdownReaderSourcePeek,
    normalizeMarkdownReaderWidth,
    observeMarkdownReaderAlignment,
    observeMarkdownReaderFont,
    observeMarkdownReaderFontSize,
    observeMarkdownReaderLineHeight,
    observeMarkdownReaderSourcePeek,
    observeMarkdownReaderWidth,
    setMarkdownReaderAlignment,
    setMarkdownReaderFont,
    setMarkdownReaderFontSize,
    setMarkdownReaderLineHeight,
    setMarkdownReaderSourcePeek,
    setMarkdownReaderWidth,
} from '../config/reader-preferences.js';
import { createLocalization } from '../i18n/localization.js';
import { createMarkdownTabView } from './markdown-window.js';
import { navigationShortcutLabels } from './reader-shortcuts.js';
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
        this.readerLineHeight = getMarkdownReaderLineHeight(zotero);
        this.readerWidth = getMarkdownReaderWidth(zotero);
        this.readerAlignment = getMarkdownReaderAlignment(zotero);
        this.readerSourcePeek = getMarkdownReaderSourcePeek(zotero);
        this.navigationShortcuts = navigationShortcutLabels({
            isMac: zotero?.isMac === true,
        });
        this.presentations = new Map();
        this.disposeReaderFontObserver = observeMarkdownReaderFont(
            zotero,
            font => this.applyReaderFont(font)
        );
        this.disposeReaderFontSizeObserver = observeMarkdownReaderFontSize(
            zotero,
            size => this.applyReaderFontSize(size)
        );
        this.disposeReaderLineHeightObserver = observeMarkdownReaderLineHeight(
            zotero,
            value => this.applyReaderLineHeight(value)
        );
        this.disposeReaderWidthObserver = observeMarkdownReaderWidth(
            zotero,
            value => this.applyReaderWidth(value)
        );
        this.disposeReaderAlignmentObserver = observeMarkdownReaderAlignment(
            zotero,
            value => this.applyReaderAlignment(value)
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
        onExportObsidian,
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
        onReadClipboard,
        onWriteClipboard,
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

        let existing = this.presentations.get(documentID);
        // A document whose window is gone, or that already closed, cannot be
        // selected again. Release it and open a new tab instead.
        if (existing && !presentationWindowIsOpen(existing)) {
            this.finishPresentation(existing, MARKDOWN_TAB_CLOSE_REASONS.USER);
            existing = null;
        }
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
            if (onExportObsidian !== undefined) {
                existing.model.onExportObsidian = onExportObsidian;
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
            if (onReadClipboard && onWriteClipboard) {
                existing.model.onReadClipboard = onReadClipboard;
                existing.model.onWriteClipboard = onWriteClipboard;
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
            if (this.selectPresentation(existing, owner)) {
                return { ...existing, created: false };
            }
            this.finishPresentation(existing, MARKDOWN_TAB_CLOSE_REASONS.USER);
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
                onExportObsidian,
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
                onReadClipboard,
                onWriteClipboard,
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
            readerLineHeight: this.readerLineHeight,
            readerWidth: this.readerWidth,
            readerAlignment: this.readerAlignment,
            onReaderLineHeightChange: value => (
                this.updateReaderLineHeight(value)
            ),
            onReaderWidthChange: value => this.updateReaderWidth(value),
            onReaderAlignmentChange: value => (
                this.updateReaderAlignment(value)
            ),
            navigationShortcuts: this.navigationShortcuts,
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
                    if (!presentation) return;
                    this.finishPresentation(
                        presentation,
                        presentation.closeReason
                            || MARKDOWN_TAB_CLOSE_REASONS.USER
                    );
                },
            });
            tabID = result.id;
            result.container.appendChild(view.root);
            // The deck element is what Zotero notifies when this tab is
            // selected. The first select already happened inside add().
            result.container.onTabSelectionChanged = selected => {
                view.handleTabSelection?.(selected);
            };
            view.handleTabSelection?.(true);
        }
        catch (error) {
            view.destroy?.();
            if (tabID) tabs.close?.(tabID);
            throw error;
        }

        presentation = {
            owner,
            tabs,
            tabID,
            documentID,
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

    applyReaderLineHeight(value) {
        const normalized = normalizeMarkdownReaderLineHeight(value);
        if (normalized === this.readerLineHeight) return;
        this.readerLineHeight = normalized;
        for (const presentation of this.presentations.values()) {
            presentation.view.setReaderLineHeight?.(normalized);
        }
    }

    applyReaderWidth(value) {
        const normalized = normalizeMarkdownReaderWidth(value);
        if (normalized === this.readerWidth) return;
        this.readerWidth = normalized;
        for (const presentation of this.presentations.values()) {
            presentation.view.setReaderWidth?.(normalized);
        }
    }

    applyReaderAlignment(value) {
        const normalized = normalizeMarkdownReaderAlignment(value);
        if (normalized === this.readerAlignment) return;
        this.readerAlignment = normalized;
        for (const presentation of this.presentations.values()) {
            presentation.view.setReaderAlignment?.(normalized);
        }
    }

    updateReaderLineHeight(value) {
        const normalized = normalizeMarkdownReaderLineHeight(value);
        try {
            setMarkdownReaderLineHeight(this.zotero, normalized);
        }
        catch (error) {
            this.zotero.logError?.(error);
        }
        this.applyReaderLineHeight(normalized);
        return normalized;
    }

    updateReaderWidth(value) {
        const normalized = normalizeMarkdownReaderWidth(value);
        try {
            setMarkdownReaderWidth(this.zotero, normalized);
        }
        catch (error) {
            this.zotero.logError?.(error);
        }
        this.applyReaderWidth(normalized);
        return normalized;
    }

    updateReaderAlignment(value) {
        const normalized = normalizeMarkdownReaderAlignment(value);
        try {
            setMarkdownReaderAlignment(this.zotero, normalized);
        }
        catch (error) {
            this.zotero.logError?.(error);
        }
        this.applyReaderAlignment(normalized);
        return normalized;
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
        this.disposeReaderLineHeightObserver?.();
        this.disposeReaderLineHeightObserver = null;
        this.disposeReaderWidthObserver?.();
        this.disposeReaderWidthObserver = null;
        this.disposeReaderAlignmentObserver?.();
        this.disposeReaderAlignmentObserver = null;
        this.disposeReaderSourcePeekObserver?.();
        this.disposeReaderSourcePeekObserver = null;
        this.closeAll({ reason: MARKDOWN_TAB_CLOSE_REASONS.SHUTDOWN });
        this.restoreSessionStateFilter();
        this.tabIconStyle?.remove?.();
        this.tabIconStyle = null;
    }

    // closeForWindow releases the documents of a main window that is going
    // away. Zotero closes its tabs while the window unloads, but a failure
    // earlier in that teardown skips the rest, and macOS keeps Zotero running
    // so the documents would otherwise stay open. The closing window's tab
    // manager is not called again.
    closeForWindow(window) {
        if (!window) return;
        for (const presentation of [...this.presentations.values()]) {
            if (presentation.owner !== window) continue;
            this.finishPresentation(
                presentation,
                MARKDOWN_TAB_CLOSE_REASONS.USER
            );
        }
    }

    closePresentation(presentation, reason) {
        if (!presentation || presentation.closed) return;
        presentation.closeReason = reason;
        try {
            presentation.tabs.close?.(presentation.tabID);
        }
        catch (error) {
            this.zotero.logError?.(error);
        }
        // Zotero runs the tab's onClose synchronously. When the tab is no
        // longer known to its window, or closing it threw, the document is
        // released here instead.
        this.finishPresentation(presentation, reason);
    }

    // finishPresentation runs once per document: it saves and destroys the
    // view, forgets the document, and reports the close. A failure in one
    // step does not skip the others.
    finishPresentation(presentation, reason) {
        if (!presentation) return;
        const first = !presentation.closed;
        presentation.closed = true;
        presentation.closeReason = null;
        // Destroying the view saves an open correction, and that save looks
        // the document up, so the document is forgotten only afterwards.
        if (first) {
            try {
                presentation.view.destroy?.();
            }
            catch (error) {
                this.zotero.logError?.(error);
            }
        }
        if (this.presentations.get(presentation.documentID) === presentation) {
            this.presentations.delete(presentation.documentID);
        }
        if (!first) return;
        try {
            presentation.onClose?.({ reason });
        }
        catch (error) {
            this.zotero.logError?.(error);
        }
    }

    selectPresentation(presentation, owner) {
        try {
            presentation.tabs.select(presentation.tabID);
            if (presentation.owner !== owner) presentation.owner.focus?.();
            return true;
        }
        catch (error) {
            this.zotero.logError?.(error);
            return false;
        }
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

// A closed main window can no longer select or close its tabs. Reading a
// property of a destroyed window can itself throw.
function presentationWindowIsOpen(presentation) {
    if (presentation.closed) return false;
    try {
        return presentation.owner?.closed !== true;
    }
    catch {
        return false;
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
