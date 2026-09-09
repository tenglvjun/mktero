import { createInlineMarkdownEditor } from '../editor/inline-markdown-editor.js';
import { enhanceRenderedCodeBlocks } from '../editor/inline-rendering.js';
import {
    annotationPageLabel,
    safeAnnotationColor,
} from '../editor/pdf-annotations.js';
import {
    createEmptyAnnotationOverlay,
} from '../core/markdown-annotation-overlay.js';
import {
    collectMatchedAnnotationRanges,
    protectEditableBlocksWithAnnotations,
} from '../core/markdown-revision-session.js';
import {
    createMarkdownAnnotationTextQuote,
    markdownAnnotationRangeMatchesSource,
} from '../core/markdown-local-annotations.js';
import { resolvePDFPageIndexHint } from '../core/markdown-source-map.js';
import {
    AI_TARGET_LANGUAGES,
    isSupportedAITargetLanguage,
} from '../config/ai-preferences.js';
import {
    getMarkdownReaderFontFamily,
    MARKDOWN_READER_FONT_DEFAULT,
    MARKDOWN_READER_FONT_OPTIONS,
    MARKDOWN_READER_FONT_SIZE_DEFAULT as DEFAULT_READER_FONT_SIZE,
    MARKDOWN_READER_FONT_SIZE_MAX as MAX_READER_FONT_SIZE,
    MARKDOWN_READER_FONT_SIZE_MIN as MIN_READER_FONT_SIZE,
    normalizeMarkdownReaderFont,
    normalizeMarkdownReaderFontSize,
} from '../config/reader-preferences.js';
import {
    accessibleAnnotationText,
    comparePdfAnnotations,
} from '../core/pdf-annotation.js';
import { createLocalization } from '../i18n/localization.js';
import { findGitHubRepositories } from '../markdown/github-repository-links.js';
import { safeMarkdownLinkURL } from '../markdown/markdown-html.js';
import {
    visibleDocumentChromeRanges,
} from '../markdown/chrome-ranges.js';
import {
    createMarkdownFragmentID,
    createMarkdownFragmentIndex,
    createMarkdownReadingPositionAnchor,
    extractAlignedMarkdownOutline,
    resolveMarkdownReadingPosition,
} from '../markdown/markdown-outline.js';
import {
    extractMarkdownAssetOutline,
} from '../markdown/markdown-asset-outline.js';
import { appendRenderedMarkdown } from '../editor/rendered-markdown-dom.js';
import {
    createTranslationReadingPositionAnchor,
    mapComparisonRangeToSource,
    mapSourceRangeToComparison,
    resolveTranslationReadingPosition,
} from '../markdown/markdown-translation-blocks.js';
import {
    createLucideIcon,
    LUCIDE_ICONS,
} from '../icons/lucide-icon.js';
import { createConfirmationDialog } from './confirmation-dialog.js';
import { createLoadingPresentation } from './markdown-loading-state.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const BUNDLED_MARKDOWN_STYLES = typeof __MKTERO_MARKDOWN_STYLES__ === 'string'
    ? __MKTERO_MARKDOWN_STYLES__
    : null;
const DOCUMENT_ACTION_STATUS_TIMEOUT_MS = 5_000;
const DOCUMENT_ACTION_FEEDBACK = Object.freeze({
    saveSnapshot: Object.freeze({
        progress: 'viewer.snapshotSaving',
        success: 'viewer.snapshotSaved',
        failure: 'viewer.snapshotSaveFailed',
    }),
    exportMarkdown: Object.freeze({
        progress: 'viewer.markdownExporting',
        success: 'viewer.markdownExported',
        failure: 'viewer.markdownExportFailed',
        neutralStatus: 'cancelled',
    }),
});
const WARNING_TOAST_TIMEOUT_MS = 5_000;
const CORRECTION_UNDO_TIMEOUT_MS = 8_000;
const OUTLINE_SEGMENT_HEADINGS = 'headings';
const OUTLINE_SEGMENT_FIGURES = 'figures';
const SIDE_PANEL_KEYBOARD_STEP = 16;
const SIDE_PANEL_RESIZE_ACTIVATION_DISTANCE = 4;
const RESPONSIVE_SIDE_PANEL_BREAKPOINTS = Object.freeze({
    outline: 820,
    notes: 1120,
});
const LATIN_TRANSLATION_FONT_OPTIONS = createFontOptions([
    ['stix-two-text', 'viewer.fontSTIXTwoText',
        'var(--reader-translation-font-latin)'],
    ['georgia', 'viewer.fontGeorgia',
        'Georgia, Cambria, "Times New Roman", serif'],
    ['cambria', 'viewer.fontCambria',
        'Cambria, Georgia, "Times New Roman", serif'],
    ['times-new-roman', 'viewer.fontTimesNewRoman',
        '"Times New Roman", Georgia, Cambria, serif'],
]);
const TRANSLATION_FONT_OPTIONS = Object.freeze({
    'zh-CN': createFontOptions([
        ['noto-serif-sc', 'viewer.fontNotoSerifSC',
            'var(--reader-translation-font-zh-cn)'],
        ['source-han-serif-sc', 'viewer.fontSourceHanSerifSC',
            '"Source Han Serif SC", "Source Han Serif CN", "Noto Serif SC", "Songti SC", STSong, SimSun, serif'],
        ['songti-sc', 'viewer.fontSongtiSC',
            '"Songti SC", STSong, "Noto Serif SC", "Source Han Serif SC", SimSun, serif'],
        ['simsun', 'viewer.fontSimSun',
            'SimSun, "Noto Serif SC", "Source Han Serif SC", "Songti SC", STSong, serif'],
    ]),
    'zh-TW': createFontOptions([
        ['noto-serif-tc', 'viewer.fontNotoSerifTC',
            'var(--reader-translation-font-zh-tw)'],
        ['source-han-serif-tc', 'viewer.fontSourceHanSerifTC',
            '"Source Han Serif TC", "Source Han Serif TW", "Noto Serif TC", "Songti TC", PMingLiU, serif'],
        ['songti-tc', 'viewer.fontSongtiTC',
            '"Songti TC", "Noto Serif TC", "Source Han Serif TC", PMingLiU, serif'],
        ['pmingliu', 'viewer.fontPMingLiU',
            'PMingLiU, "Noto Serif TC", "Source Han Serif TC", "Songti TC", serif'],
    ]),
    'ja-JP': createFontOptions([
        ['noto-serif-jp', 'viewer.fontNotoSerifJP',
            'var(--reader-translation-font-ja)'],
        ['source-han-serif-jp', 'viewer.fontSourceHanSerifJP',
            '"Source Han Serif JP", "Noto Serif JP", "Yu Mincho", YuMincho, "Hiragino Mincho ProN", serif'],
        ['yu-mincho', 'viewer.fontYuMincho',
            '"Yu Mincho", YuMincho, "Noto Serif JP", "Source Han Serif JP", "Hiragino Mincho ProN", serif'],
        ['hiragino-mincho', 'viewer.fontHiraginoMincho',
            '"Hiragino Mincho ProN", "Hiragino Mincho Pro", "Noto Serif JP", "Source Han Serif JP", "Yu Mincho", serif'],
    ]),
    'ko-KR': createFontOptions([
        ['noto-serif-kr', 'viewer.fontNotoSerifKR',
            'var(--reader-translation-font-ko)'],
        ['source-han-serif-k', 'viewer.fontSourceHanSerifK',
            '"Source Han Serif K", "Noto Serif KR", AppleMyungjo, Batang, serif'],
        ['apple-myungjo', 'viewer.fontAppleMyungjo',
            'AppleMyungjo, "Noto Serif KR", "Source Han Serif K", Batang, serif'],
        ['batang', 'viewer.fontBatang',
            'Batang, "Noto Serif KR", "Source Han Serif K", AppleMyungjo, serif'],
    ]),
    'es-ES': LATIN_TRANSLATION_FONT_OPTIONS,
    'fr-FR': LATIN_TRANSLATION_FONT_OPTIONS,
    'pt-BR': LATIN_TRANSLATION_FONT_OPTIONS,
});
const SIDE_PANEL_CONFIG = Object.freeze({
    outline: Object.freeze({
        elementKey: 'outline',
        resizerKey: 'outlineResizer',
        toggleKey: 'outlineToggle',
        widthProperty: '--outline-width',
        defaultWidth: 256,
        minWidth: 180,
        maxWidth: 480,
        resizeDirection: 1,
        resizeClass: 'is-resizing-outline',
        collapsedClass: 'is-outline-collapsed',
        resizeLabelKey: 'viewer.outlineResize',
        collapseLabelKey: 'viewer.outlineCollapse',
        expandLabelKey: 'viewer.outlineExpand',
        collapseIcon: LUCIDE_ICONS.chevronLeft,
        expandIcon: LUCIDE_ICONS.chevronRight,
    }),
    notes: Object.freeze({
        elementKey: 'notes',
        resizerKey: 'notesResizer',
        toggleKey: 'notesToggle',
        widthProperty: '--notes-width',
        defaultWidth: 300,
        minWidth: 220,
        maxWidth: 480,
        resizeDirection: -1,
        resizeClass: 'is-resizing-notes',
        collapsedClass: 'is-notes-collapsed',
        resizeLabelKey: 'viewer.notesResize',
        collapseLabelKey: 'viewer.notesCollapse',
        expandLabelKey: 'viewer.notesExpand',
        collapseIcon: LUCIDE_ICONS.chevronRight,
        expandIcon: LUCIDE_ICONS.chevronLeft,
    }),
});
export function createMarkdownTabView({
    document,
    model,
    zotero,
    stylesheetText = BUNDLED_MARKDOWN_STYLES,
    editorFactory = createInlineMarkdownEditor,
    localization = createLocalization(),
    readerFont = MARKDOWN_READER_FONT_DEFAULT,
    readerFontSize = DEFAULT_READER_FONT_SIZE,
    onReaderFontChange = null,
    onReaderFontSizeChange = null,
}) {
    return new MarkdownTabView({
        document,
        model,
        zotero,
        stylesheetText,
        editorFactory,
        localization,
        readerFont,
        readerFontSize,
        onReaderFontChange,
        onReaderFontSizeChange,
    });
}

class MarkdownTabView {
    constructor({
        document,
        model,
        zotero,
        stylesheetText,
        editorFactory,
        localization,
        readerFont,
        readerFontSize,
        onReaderFontChange,
        onReaderFontSizeChange,
    }) {
        this.localization = localization;
        this.t = localization.t.bind(localization);
        if (!document?.createElementNS) {
            throw new Error(this.t('error.markdownViewUnavailable'));
        }
        if (!stylesheetText) {
            throw new Error(this.t('error.markdownStylesUnavailable'));
        }

        this.document = document;
        this.ownerWindow = document.defaultView || globalThis;
        this.zotero = zotero;
        this.model = model;
        this.readerFont = normalizeMarkdownReaderFont(readerFont);
        this.readerFontSize = normalizeMarkdownReaderFontSize(readerFontSize);
        this.onReaderFontChange = onReaderFontChange;
        this.onReaderFontSizeChange = onReaderFontSizeChange;
        this.renderedAssets = undefined;
        this.assetURLs = new Map();
        this.renderedMarkdown = undefined;
        this.renderedRenderMode = null;
        this.renderedTranslationView = 'original';
        this.renderedTranslationBlockRanges = [];
        this.fragmentIndex = new Map();
        this.renderedSnapshotHTML = undefined;
        this.renderedSnapshotAssets = undefined;
        this.snapshotURLs = new Map();
        this.documentActionBusy = null;
        this.destroyed = false;
        this.actionStatusTimer = null;
        this.warningToastSignature = null;
        this.warningToastTimer = null;
        this.correctionUndoTimer = null;
        this.correctionUndoBlockID = null;
        this.navigationBackAvailable = false;
        this.responsiveResizeObserver = null;
        this.documentActionsOpen = false;
        this.githubReposOpen = false;
        this.githubRepositories = [];
        this.readerFontOptionsOpen = false;
        this.readerFontOptionsContext = '';
        this.translationLanguagesOpen = false;
        this.translationLanguageSignature = '';
        this.translationReaderFonts = new Map();
        this.activeNavigationOffset = 0;
        this.outlineSegment = OUTLINE_SEGMENT_HEADINGS;
        this.outlineMarkdown = '';
        this.outlineSourceRanges = null;
        this.outlineChromeRanges = [];
        this.outlinePdfOutline = [];
        this.activeTranslationFailureID = null;
        this.listeners = [];
        this.sidePanels = Object.fromEntries(
            Object.entries(SIDE_PANEL_CONFIG).map(([name, config]) => [
                name,
                {
                    ...config,
                    visible: true,
                    width: config.defaultWidth,
                    resize: null,
                },
            ])
        );
        this.responsivePanels = Object.fromEntries(
            Object.keys(SIDE_PANEL_CONFIG).map(name => [name, {
                autoCollapsed: false,
                userOverride: false,
            }])
        );

        this.host = this.createElement('div', {
            class: 'mktero-tab-host',
            role: 'region',
            'aria-label': this.t('viewer.label'),
        });
        Object.assign(this.host.style, {
            display: 'block',
            width: '100%',
            height: '100%',
            minWidth: '0',
            minHeight: '0',
            overflow: 'hidden',
        });
        if (!this.host.attachShadow) {
            throw new Error(this.t('error.shadowRootUnavailable'));
        }

        this.root = this.createLayoutRoot();
        this.mount = this.host.attachShadow({ mode: 'open' });
        this.mount.appendChild(this.createStylesheet(stylesheetText));
        this.elements = this.createContent();
        this.mount.appendChild(this.elements.view);
        this.confirmationDialog = createConfirmationDialog({
            document: this.document,
            parent: this.elements.view,
        });
        this.setReaderFont(this.readerFont);
        this.setReaderFontSize(this.readerFontSize);
        this.editor = editorFactory({
            document: this.document,
            parent: this.elements.editorHost,
            initialMarkdown: '',
            resolveImageURL: source => this.resolveImageURL(source),
            openLink: href => this.openLink(href),
            createMarkdownAnnotation: (annotation, selectionContext) => (
                this.createMarkdownAnnotation(annotation, selectionContext)
            ),
            changeAnnotationColor: (annotationID, color) => (
                this.changeAnnotationColor(annotationID, color)
            ),
            updateAnnotationComment: (annotationID, comment) => (
                this.updateAnnotationComment(annotationID, comment)
            ),
            deleteAnnotation: annotationID => (
                this.deleteAnnotation(annotationID)
            ),
            copySourcedMarkdown: target => this.copySourcedMarkdown(target),
            copyCode: typeof model?.onCopyCode === 'function'
                ? code => this.copyCode(code)
                : null,
            translateSelection: typeof model?.onTranslateSelection === 'function'
                ? (
                    text,
                    selectionContext,
                    { onTextDelta } = {},
                ) => this.model.onTranslateSelection({
                    text,
                    context: selectionContext?.translationContext || '',
                    onTextDelta,
                })
                : null,
            cancelSelectionTranslation:
                typeof model?.onCancelSelectionTranslation === 'function'
                    ? () => this.model.onCancelSelectionTranslation()
                    : null,
            shouldAutoTranslateSelection:
                typeof model?.shouldAutoTranslateSelection === 'function'
                    ? () => this.model.shouldAutoTranslateSelection() === true
                    : null,
            copySelectionTranslation:
                typeof model?.onCopySelectionTranslation === 'function'
                    ? text => this.model.onCopySelectionTranslation(text)
                    : null,
            openSourceLocation: location => this.openSourceLocation(location),
            openAnnotationInPDF: annotationID => (
                this.openAnnotationInPDF(annotationID)
            ),
            onSourceNavigationError: error => this.zotero?.logError?.(error),
            onViewportChange: offset => this.syncActiveNavigation(offset),
            onNavigationBackChange: available => {
                this.navigationBackAvailable = Boolean(available);
                this.syncNavigationBack();
            },
            sourceItemID: this.model.sourceItemID,
            onListReferenceLibraries: options => (
                this.model.onListReferenceLibraries?.({
                    ...options,
                    sourceItemID: this.model.sourceItemID,
                })
            ),
            onGetReferenceStatus: (target, options) => (
                this.model.onGetReferenceStatus?.(target, options)
            ),
            onSearchReferenceMetadata: (target, options) => (
                this.model.onSearchReferenceMetadata?.(target, options)
            ),
            onImportReference: (target, options) => (
                this.model.onImportReference?.(target, options)
            ),
            onOpenReferenceMatch: match => (
                this.model.onOpenReferenceMatch?.(match)
            ),
            onSubscribeReferenceUpdates: listener => (
                this.model.onSubscribeReferenceUpdates?.(listener)
            ),
            onCommitCorrection: correction => (
                this.commitCorrection(correction)
            ),
            onRestoreCorrection: blockID => (
                this.restoreCorrection(blockID)
            ),
            onCorrectionError: error => this.reportCorrectionError(error),
            localization: this.localization,
        });
        this.syncOutline('');
        this.syncNotes(createEmptyAnnotationOverlay(), 0);
        this.bindActions();
    }

    render(model = this.model) {
        this.model = model;
        const elements = this.elements;
        this.syncLocalization();
        if (model.status !== 'ready' || model.renderMode === 'html') {
            this.clearCorrectionUndo();
        }
        const loadingView = createLoadingPresentation(model, this.t);
        const showContent = model.status === 'ready' || loadingView.preserveContent;

        elements.progress.hidden = !loadingView.visible;
        elements.progress.value = loadingView.progress || 0;
        elements.loading.hidden = !loadingView.visible;
        elements.loading.classList.toggle(
            'loading-state--inline',
            loadingView.preserveContent
        );
        elements.content.setAttribute('aria-busy', String(loadingView.visible));
        elements.error.hidden = model.status !== 'error';
        elements.errorMessage.textContent = model.error || '';
        this.syncWarningToast([
            ...(model.warnings || []),
            ...(model.translationError && model.translationStatus !== 'partial'
                ? [model.translationError]
                : []),
        ], {
            persistent: Boolean(
                model.warningAction
                || model.translationError && model.translationStatus !== 'partial'
            ),
        });
        this.syncContentVisibility(showContent);
        this.syncDocumentActions(model, loadingView);
        this.syncCorrectionBanner(model, loadingView);
        this.syncErrorActions(model);
        this.syncWarningActions(model);

        if (loadingView.visible) {
            elements.loadingTitle.textContent = loadingView.title;
            elements.loadingDetail.textContent = loadingView.detail;
            elements.loadingProgressLabel.textContent = loadingView.progressLabel;
            elements.loadingHint.textContent = loadingView.hint;
            elements.loadingProgress.value = loadingView.progress;
            if (!loadingView.preserveContent) {
                this.revokeAssetURLs();
                this.editor.setDocument({
                    markdown: '',
                    annotationOverlay: createEmptyAnnotationOverlay(),
                    sourceMap: [],
                });
                this.renderedMarkdown = '';
                elements.readingLayout.classList.remove('is-comparing');
                this.renderedRenderMode = 'markdown';
                this.renderedTranslationBlockRanges = [];
                this.fragmentIndex = new Map();
                this.syncOutline('');
                this.syncNotes(createEmptyAnnotationOverlay(), 0);
            }
            this.editor.setCorrectionState?.({
                enabled: false,
                blocks: model.editableBlocks || [],
                correctedBlockIDs: model.correctedBlockIDs || [],
            });
            return;
        }

        if (model.status === 'ready') {
            if (model.renderMode === 'html') {
                elements.readingLayout.hidden = true;
                elements.snapshotHost.hidden = false;
                this.renderedMarkdown = undefined;
                elements.readingLayout.classList.remove('is-comparing');
                this.renderedRenderMode = 'html';
                this.renderedTranslationBlockRanges = [];
                this.fragmentIndex = new Map();
                this.syncSnapshot();
                this.syncOutline('');
                this.syncNotes(createEmptyAnnotationOverlay(), 0);
                this.editor.setCorrectionState?.({ enabled: false });
                return;
            }
            elements.readingLayout.hidden = false;
            elements.snapshotHost.hidden = true;
            const translatedView = hasAvailableTranslation(model)
                && model.translationView === 'translated';
            const comparisonView = hasAvailableTranslation(model)
                && model.translationView === 'compare';
            elements.primaryPane.setAttribute(
                'aria-label',
                this.t(comparisonView
                    ? 'ai.translationView.compare'
                    : translatedView
                        ? 'ai.translationView.translated'
                        : 'ai.translationView.original')
            );
            const translationLanguage = normalizedTranslationLanguage(
                model.translationTargetLanguage
            );
            if (translatedView && translationLanguage) {
                elements.primaryPane.setAttribute('lang', translationLanguage);
            }
            else {
                elements.primaryPane.removeAttribute('lang');
            }
            const markdown = translatedView
                ? model.translatedMarkdown || ''
                : comparisonView
                    ? model.comparisonMarkdown || ''
                    : model.markdown || '';
            const documentChanged = this.renderedRenderMode !== 'markdown'
                || this.renderedMarkdown !== markdown;
            const previousTranslationView = this.renderedTranslationView;
            const previousTranslationBlockRanges =
                this.renderedTranslationBlockRanges;
            const translationAnchor = documentChanged
                && this.renderedMarkdown !== undefined
                && this.activeNavigationOffset > 0
                ? createTranslationReadingPositionAnchor(
                    this.activeNavigationOffset,
                    previousTranslationView,
                    previousTranslationBlockRanges
                )
                : null;
            const restoreAnchor = !translationAnchor && documentChanged
                && this.renderedMarkdown !== undefined
                && this.activeNavigationOffset > 0
                ? createMarkdownReadingPositionAnchor(
                    this.renderedMarkdown,
                    this.activeNavigationOffset
                )
                : null;
            const annotationOverlay = translatedView
                ? createEmptyAnnotationOverlay()
                : comparisonView
                    ? mapAnnotationOverlayToComparison(
                        model.annotationOverlay,
                        model.translationBlockRanges
                    )
                    : model.annotationOverlay || createEmptyAnnotationOverlay();
            const sourceMap = translatedView
                ? []
                : comparisonView
                    ? mapSourceMapToComparison(
                        model.sourceMap,
                        model.translationBlockRanges
                    )
                    : Array.isArray(model.sourceMap) ? model.sourceMap : [];
            const assetsChanged = this.syncAssetURLs();
            elements.readingLayout.classList.toggle(
                'is-comparing',
                comparisonView
            );
            const sourceChromeRanges = visibleDocumentChromeRanges(
                model.markdown || markdown,
                model.chromeRanges,
                model.title
            );
            this.editor.setDocument({
                markdown,
                annotationOverlay,
                sourceMap,
                chromeRanges: translatedView
                    ? []
                    : comparisonView
                        ? mapChromeRangesToComparison(
                            sourceChromeRanges,
                            model.translationBlockRanges
                        )
                        : sourceChromeRanges,
                sourceActionRanges: translatedView
                    ? []
                    : comparisonView
                        ? (model.translationBlockRanges || []).flatMap(
                            range => Number.isSafeInteger(
                                range?.comparisonSourceFrom
                            ) && Number.isSafeInteger(
                                range?.comparisonSourceTo
                            ) && range.comparisonSourceTo
                                > range.comparisonSourceFrom
                                ? [{
                                    from: range.comparisonSourceFrom,
                                    to: range.comparisonSourceTo,
                                }]
                                : []
                        )
                        : null,
                translationRanges: comparisonView
                    ? (model.comparisonTranslationRanges || []).map(range => ({
                        ...range,
                        ...(translationLanguage
                            ? { language: translationLanguage }
                            : {}),
                    }))
                    : [],
                translationFailures: createVisibleTranslationFailures(
                    model,
                    translatedView,
                    comparisonView
                ),
                translationPairs: createVisibleTranslationPairs(
                    model,
                    translatedView,
                    comparisonView
                ),
            });
            const correctionAnnotationRanges = collectMatchedAnnotationRanges(
                model.annotationOverlay
            );
            this.editor.setCorrectionState?.({
                enabled: Boolean(model.correctionMode)
                    && !translatedView
                    && !comparisonView,
                blocks: protectEditableBlocksWithAnnotations(
                    model.editableBlocks,
                    correctionAnnotationRanges
                ),
                correctedBlockIDs: model.correctedBlockIDs || [],
                annotationRanges: correctionAnnotationRanges,
            });
            this.renderedMarkdown = markdown;
            this.renderedRenderMode = 'markdown';
            this.renderedTranslationView = translationViewName(
                translatedView,
                comparisonView
            );
            this.renderedTranslationBlockRanges = Array.isArray(
                model.translationBlockRanges
            ) ? model.translationBlockRanges.map(range => ({ ...range })) : [];
            this.fragmentIndex = createMarkdownFragmentIndex(markdown);
            this.syncOutline(
                comparisonView ? model.markdown || '' : markdown,
                comparisonView ? model.comparisonSourceRanges : null,
                translatedView ? [] : sourceChromeRanges,
                translatedView && !comparisonView ? [] : model.pdfOutline
            );
            this.syncNotes(annotationOverlay, markdown.length);
            if (assetsChanged) this.editor.refreshRendering();
            if (translationAnchor) {
                const position = resolveTranslationReadingPosition(
                    translationAnchor,
                    this.renderedTranslationView,
                    model.translationBlockRanges
                );
                if (position !== null) this.restoreReadingPosition(position);
            }
            else if (restoreAnchor) {
                this.restoreReadingPosition(
                    resolveMarkdownReadingPosition(markdown, restoreAnchor)
                );
            }
            return;
        }

    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.clearDocumentActionStatus();
        this.clearWarningToast();
        this.clearCorrectionUndo();
        for (const { element, type, listener, options } of this.listeners) {
            element.removeEventListener(type, listener, options);
        }
        this.listeners = [];
        this.responsiveResizeObserver?.disconnect?.();
        this.responsiveResizeObserver = null;
        this.confirmationDialog.destroy();
        this.editor?.destroy();
        this.revokeAssetURLs();
        this.revokeSnapshotURLs();
        this.root.remove?.();
    }

    openSourceLocation(location) {
        if (typeof this.model.onOpenSourceInPDF !== 'function') {
            throw new Error('PDF source navigation is unavailable');
        }
        return this.model.onOpenSourceInPDF(location);
    }

    openAnnotationInPDF(annotationID) {
        if (typeof this.model.onOpenAnnotationInPDF !== 'function') {
            throw new Error('PDF annotation navigation is unavailable');
        }
        return this.model.onOpenAnnotationInPDF(annotationID);
    }

    copySourcedMarkdown(target) {
        if (typeof this.model.onCopySourcedMarkdown !== 'function') {
            throw new Error('Sourced Markdown copy is unavailable');
        }
        const sourceTarget = this.model.translationView === 'compare'
            ? mapComparisonTargetToSource(
                target,
                this.model.translationBlockRanges
            )
            : target;
        if (!sourceTarget) {
            throw new Error('A reliable PDF source is unavailable');
        }
        return this.model.onCopySourcedMarkdown(sourceTarget);
    }

    copyCode(code) {
        if (typeof this.model.onCopyCode !== 'function') {
            throw new Error('Code copy is unavailable');
        }
        return this.model.onCopyCode(code);
    }

    async changeAnnotationColor(annotationID, color) {
        const annotation = findOverlayAnnotation(
            this.model.annotationOverlay,
            annotationID
        );
        if (isMarkdownAnnotation(annotation)) {
            if (typeof this.model.onUpdateMarkdownAnnotation !== 'function') {
                throw new Error('Markdown annotation changes are unavailable');
            }
            const saved = await this.model.onUpdateMarkdownAnnotation(
                annotationID,
                annotationUpdate(annotation, { color })
            );
            this.replaceVisibleAnnotation(annotationID, saved || {
                ...annotation,
                color,
            });
            return;
        }
        if (typeof this.model.onChangeAnnotationColor !== 'function') {
            throw new Error('PDF annotation color changes are unavailable');
        }
        await this.model.onChangeAnnotationColor(annotationID, color);
        this.model.annotationOverlay = mapAnnotationOverlay(
            this.model.annotationOverlay,
            annotationID,
            annotation => ({ ...annotation, color })
        );
        this.render(this.model);
    }

    async deleteAnnotation(annotationID) {
        const annotation = findOverlayAnnotation(
            this.model.annotationOverlay,
            annotationID
        );
        if (isMarkdownAnnotation(annotation)) {
            if (typeof this.model.onDeleteMarkdownAnnotation !== 'function') {
                throw new Error('Markdown annotation deletion is unavailable');
            }
            await this.model.onDeleteMarkdownAnnotation(annotationID);
            this.removeVisibleAnnotation(annotationID);
            return;
        }
        if (typeof this.model.onDeleteAnnotation !== 'function') {
            throw new Error('PDF annotation deletion is unavailable');
        }
        await this.model.onDeleteAnnotation(annotationID);
        this.removeVisibleAnnotation(annotationID);
    }

    async createMarkdownAnnotation(annotation, selectionContext) {
        if (typeof this.model.onCreateMarkdownAnnotation !== 'function') {
            throw new Error('Markdown annotation creation is unavailable');
        }
        if (this.model.translationView === 'translated') {
            throw new Error('Markdown annotations require original text');
        }
        if (this.model.translationView === 'compare'
            && selectionContext?.side !== 'source') {
            throw new Error('Markdown annotations require original text');
        }
        const sourceAnnotation = this.model.translationView === 'compare'
            ? mapComparisonAnnotationToSource(
                annotation,
                this.model.translationBlockRanges
            )
            : annotation;
        if (!sourceAnnotation
            || !String(sourceAnnotation.text || '').trim()
            || !markdownAnnotationRangeMatchesSource(
                this.model.markdown,
                sourceAnnotation.ranges,
                sourceAnnotation.text
            )) {
            throw new Error('Markdown annotations require original text');
        }
        const pdfPageIndexHint = resolvePDFPageIndexHint(
            this.model.sourceMap,
            sourceAnnotation?.ranges?.[0],
            String(this.model.markdown || '').length
        );
        const textQuote = createMarkdownAnnotationTextQuote(
            this.model.markdown,
            sourceAnnotation.ranges,
            this.model.chromeRanges
        );
        const draft = {
            ...sourceAnnotation,
            ...(pdfPageIndexHint === null ? {} : { pdfPageIndexHint }),
            ...(textQuote ? { textQuote } : {}),
        };
        const saved = await this.model.onCreateMarkdownAnnotation(draft);
        this.model.annotationOverlay = appendMatchedAnnotation(
            this.model.annotationOverlay,
            saved
        );
        this.render(this.model);
        return saved;
    }

    removeVisibleAnnotation(annotationID) {
        this.model.annotationOverlay = filterAnnotationOverlay(
            this.model.annotationOverlay,
            annotationID
        );
        this.render(this.model);
    }

    async updateAnnotationComment(annotationID, comment) {
        const annotation = findOverlayAnnotation(
            this.model.annotationOverlay,
            annotationID
        );
        if (isMarkdownAnnotation(annotation)) {
            if (typeof this.model.onUpdateMarkdownAnnotation !== 'function') {
                throw new Error('Markdown annotation changes are unavailable');
            }
            const saved = await this.model.onUpdateMarkdownAnnotation(
                annotationID,
                annotationUpdate(annotation, { comment })
            );
            this.replaceVisibleAnnotation(annotationID, saved || {
                ...annotation,
                comment,
            });
            return;
        }
        if (typeof this.model.onUpdateAnnotationComment !== 'function') {
            throw new Error('PDF annotation comment changes are unavailable');
        }
        await this.model.onUpdateAnnotationComment(annotationID, comment);
        this.model.annotationOverlay = mapAnnotationOverlay(
            this.model.annotationOverlay,
            annotationID,
            annotation => ({ ...annotation, comment })
        );
        this.render(this.model);
    }

    replaceVisibleAnnotation(annotationID, annotation) {
        this.model.annotationOverlay = mapAnnotationOverlay(
            this.model.annotationOverlay,
            annotationID,
            () => annotation
        );
        this.render(this.model);
    }

    createStylesheet(stylesheetText) {
        const style = this.createElement('style', {
            'data-mktero-styles': 'embedded',
        });
        style.textContent = stylesheetText;
        return style;
    }

    createLayoutRoot() {
        if (!this.document.createXULElement) return this.host;
        const root = this.document.createXULElement('vbox');
        root.setAttribute('flex', '1');
        Object.assign(root.style, {
            width: '100%',
            height: '100%',
            minWidth: '0',
            minHeight: '0',
            overflow: 'hidden',
        });
        root.appendChild(this.host);
        return root;
    }

    createContent() {
        const initialLoading = createLoadingPresentation({
            status: 'loading',
            progress: 0,
            preserveContent: false,
        }, this.t);
        const progress = this.createElement('progress', {
            id: 'mktero-progress',
            max: '100',
            value: '0',
        });
        progress.hidden = true;
        const warning = this.createElement('div', {
            id: 'mktero-warning',
            class: 'message warning',
            role: 'status',
            'aria-live': 'polite',
            'aria-atomic': 'true',
        });
        warning.hidden = true;
        const warningMessage = this.createElement('p', {
            class: 'message-body',
        });
        const warningActions = this.createElement('div', {
            class: 'message-actions',
        });
        const warningSettings = this.createElement('button', {
            id: 'mktero-warning-settings',
            class: 'message-action',
            type: 'button',
            'aria-label': this.t('viewer.openSettings'),
            title: this.t('viewer.openSettings'),
        }, this.t('viewer.openSettings'));
        warningSettings.hidden = true;
        appendChildren(warningActions, warningSettings);
        appendChildren(warning, warningMessage, warningActions);
        const error = this.createElement('div', {
            id: 'mktero-error',
            class: 'message error',
            role: 'alert',
            'aria-live': 'assertive',
        });
        error.hidden = true;
        const errorMessage = this.createElement('p', {
            class: 'message-body',
        });
        const errorActions = this.createElement('div', {
            class: 'message-actions',
        });
        const errorRetry = this.createElement('button', {
            id: 'mktero-error-retry',
            class: 'message-action message-action--primary',
            type: 'button',
            'aria-label': this.t('viewer.retryConversion'),
            title: this.t('viewer.retryConversion'),
        });
        errorRetry.appendChild(createLucideIcon(
            this.document,
            LUCIDE_ICONS.refreshCw,
            {
                className: 'message-action-icon',
                size: 15,
            }
        ));
        errorRetry.appendChild(this.createElement(
            'span',
            { class: 'message-action-label' },
            this.t('viewer.retryConversion')
        ));
        const errorSettings = this.createElement('button', {
            id: 'mktero-error-settings',
            class: 'message-action',
            type: 'button',
            'aria-label': this.t('viewer.openSettings'),
            title: this.t('viewer.openSettings'),
        }, this.t('viewer.openSettings'));
        appendChildren(errorActions, errorRetry, errorSettings);
        appendChildren(error, errorMessage, errorActions);
        const spinner = createLucideIcon(
            this.document,
            LUCIDE_ICONS.loaderCircle,
            {
                className: 'loading-spinner',
                size: 38,
            }
        );
        const loadingTitle = this.createElement(
            'h2',
            { id: 'mktero-loading-title' },
            initialLoading.title
        );
        const loadingDetail = this.createElement(
            'p',
            { id: 'mktero-loading-detail' },
            initialLoading.detail
        );
        const progressHeadingLabel = this.createElement(
            'span',
            {},
            this.t('loading.progress')
        );
        const loadingProgressLabel = this.createElement(
            'strong',
            { id: 'mktero-loading-progress-label' },
            initialLoading.progressLabel
        );
        const loadingProgressHeading = this.createElement(
            'div',
            { class: 'loading-progress-heading' }
        );
        appendChildren(
            loadingProgressHeading,
            progressHeadingLabel,
            loadingProgressLabel
        );
        const loadingProgress = this.createElement('progress', {
            id: 'mktero-loading-progress',
            max: '100',
            value: '0',
        });
        const loadingHint = this.createElement(
            'p',
            { id: 'mktero-loading-hint', class: 'loading-hint' },
            initialLoading.hint
        );
        const loadingContent = this.createElement('div', { class: 'loading-content' });
        appendChildren(
            loadingContent,
            loadingTitle,
            loadingDetail,
            loadingProgressHeading,
            loadingProgress,
            loadingHint
        );
        const loading = this.createElement('section', {
            id: 'mktero-loading',
            class: 'loading-state',
            role: 'status',
            'aria-live': 'polite',
            'aria-atomic': 'true',
        });
        appendChildren(loading, spinner, loadingContent);

        const editorHost = this.createElement('div', {
            id: 'mktero-editor',
            class: 'markdown-editor-host',
        });
        const primaryPane = this.createElement('section', {
            class: 'markdown-reading-pane markdown-reading-pane--original',
            'data-comparison-pane': 'original',
            'aria-label': this.t('ai.translationView.original'),
        });
        primaryPane.appendChild(editorHost);
        const readingLayout = this.createElement('div', {
            class: 'markdown-reading-layout',
        });
        readingLayout.appendChild(primaryPane);
        const citationGraphButton = this.createElement('button', {
            id: 'mktero-citation-graph',
            class: 'markdown-citation-graph-button',
            type: 'button',
            'aria-label': this.t('viewer.openCitationGraph'),
            title: this.t('viewer.openCitationGraph'),
        });
        citationGraphButton.appendChild(createLucideIcon(
            this.document,
            LUCIDE_ICONS.network,
            { className: 'markdown-citation-graph-icon', size: 19 }
        ));
        const githubReposButton = this.createElement('button', {
            id: 'mktero-github-repos',
            class: 'markdown-github-repos-button',
            type: 'button',
            'aria-label': this.t('viewer.openGitHubRepositories'),
            title: this.t('viewer.openGitHubRepositories'),
            'aria-haspopup': 'true',
            'aria-expanded': 'false',
            'aria-controls': 'mktero-github-repos-menu',
        });
        githubReposButton.appendChild(createLucideIcon(
            this.document,
            LUCIDE_ICONS.github,
            { className: 'markdown-github-repos-icon', size: 19 }
        ));
        githubReposButton.hidden = true;
        const githubReposMenu = this.createElement('div', {
            id: 'mktero-github-repos-menu',
            class: 'markdown-github-repos-menu',
            role: 'menu',
            'aria-label': this.t('viewer.githubRepositories'),
        });
        githubReposMenu.hidden = true;
        const snapshotHost = this.createElement('div', {
            id: 'mktero-snapshot',
            class: 'markdown-snapshot-host',
            tabindex: '0',
        });
        snapshotHost.hidden = true;
        const documentActions = this.createDocumentActions();
        const correctionBanner = this.createElement('div', {
            class: 'markdown-correction-banner',
            role: 'status',
            'aria-live': 'polite',
        });
        correctionBanner.hidden = true;
        const correctionUndo = this.createElement('div', {
            class: 'markdown-correction-undo',
            role: 'status',
            'aria-live': 'polite',
            'aria-atomic': 'true',
        });
        const correctionUndoMessage = this.createElement(
            'span',
            { class: 'markdown-correction-undo-message' }
        );
        const correctionUndoButton = this.createElement('button', {
            class: 'markdown-correction-undo-button',
            type: 'button',
            'aria-label': this.t('revision.undoDeleteLabel'),
            title: this.t('revision.undoDeleteLabel'),
        }, this.t('revision.undoDelete'));
        appendChildren(correctionUndo, correctionUndoMessage, correctionUndoButton);
        correctionUndo.hidden = true;
        documentActions.toolbar.appendChild(correctionBanner);
        const editorSection = this.createElement('section', {
            class: 'markdown-editor',
            'aria-label': this.t('viewer.readOnly'),
        });
        appendChildren(
            editorSection,
            documentActions.toolbar,
            readingLayout,
            citationGraphButton,
            githubReposButton,
            githubReposMenu,
            correctionUndo,
            snapshotHost
        );
        const outlineTitle = this.createElement('h2', {
            class: 'markdown-outline-title',
        });
        outlineTitle.appendChild(createLucideIcon(
            this.document,
            LUCIDE_ICONS.fileText,
            { className: 'markdown-panel-title-icon', size: 16 }
        ));
        const outlineTitleLabel = this.createElement(
            'span',
            { class: 'markdown-panel-title-label' },
            this.t('viewer.outlineTitle')
        );
        outlineTitle.appendChild(outlineTitleLabel);
        const outlineHeadingsButton = this.createOutlineSegmentButton(
            OUTLINE_SEGMENT_HEADINGS,
            'viewer.outlineHeadings'
        );
        const outlineFiguresButton = this.createOutlineSegmentButton(
            OUTLINE_SEGMENT_FIGURES,
            'viewer.outlineFigures'
        );
        const outlineSegments = this.createElement('div', {
            class: 'markdown-outline-segments',
            role: 'tablist',
            'aria-label': this.t('viewer.outlineSections'),
        });
        appendChildren(
            outlineSegments,
            outlineHeadingsButton,
            outlineFiguresButton
        );
        const outlineHeader = this.createElement('div', {
            class: 'markdown-outline-header',
        });
        appendChildren(outlineHeader, outlineTitle, outlineSegments);
        const outlineList = this.createElement('ol', {
            id: 'mktero-outline-list',
            class: 'markdown-outline-list',
            role: 'tabpanel',
            'aria-labelledby': 'mktero-outline-segment-headings',
        });
        const outline = this.createElement('aside', {
            id: 'mktero-outline',
            class: 'markdown-outline',
            'aria-label': this.t('viewer.outline'),
        });
        appendChildren(outline, outlineHeader, outlineList);
        outline.style.setProperty(
            '--outline-width',
            `${this.sidePanels.outline.width}px`
        );
        const outlineControls = this.createSidePanelEdge('outline');

        const notesTitle = this.createElement('h2', {
            class: 'markdown-notes-title',
        });
        notesTitle.appendChild(createLucideIcon(
            this.document,
            LUCIDE_ICONS.messageSquareText,
            { className: 'markdown-panel-title-icon', size: 16 }
        ));
        const notesTitleLabel = this.createElement(
            'span',
            { class: 'markdown-panel-title-label' },
            this.t('viewer.notesTitle')
        );
        notesTitle.appendChild(notesTitleLabel);
        const notesList = this.createElement('ol', {
            class: 'markdown-notes-list',
        });
        const notes = this.createElement('aside', {
            id: 'mktero-notes',
            class: 'markdown-notes',
            'aria-label': this.t('viewer.notes'),
        });
        appendChildren(notes, notesTitle, notesList);
        notes.style.setProperty(
            '--notes-width',
            `${this.sidePanels.notes.width}px`
        );
        const notesControls = this.createSidePanelEdge('notes');

        const workspace = this.createElement('div', { class: 'markdown-workspace' });
        workspace.hidden = true;
        appendChildren(
            workspace,
            outline,
            outlineControls.edge,
            editorSection,
            notesControls.edge,
            notes
        );
        const content = this.createElement('main', {
            id: 'mktero-content',
            'aria-busy': 'true',
        });
        appendChildren(content, loading, workspace);

        const view = this.createElement('div', { class: 'mktero-tab-view' });
        appendChildren(view, progress, warning, error, content);
        return {
            view,
            progress,
            warning,
            warningMessage,
            warningSettings,
            error,
            errorMessage,
            errorRetry,
            errorSettings,
            content,
            loading,
            loadingTitle,
            loadingDetail,
            progressHeadingLabel,
            loadingProgress,
            loadingProgressLabel,
            loadingHint,
            workspace,
            outline,
            outlineTitle,
            outlineTitleLabel,
            outlineSegments,
            outlineSegmentButtons: [outlineHeadingsButton, outlineFiguresButton],
            outlineList,
            outlineResizer: outlineControls.resizer,
            outlineToggle: outlineControls.toggle,
            notes,
            notesTitle,
            notesTitleLabel,
            notesList,
            notesResizer: notesControls.resizer,
            notesToggle: notesControls.toggle,
            readingLayout,
            primaryPane,
            editorHost,
            snapshotHost,
            correctionBanner,
            correctionUndo,
            correctionUndoMessage,
            correctionUndoButton,
            editorActions: documentActions.toolbar,
            citationGraphButton,
            githubReposButton,
            githubReposMenu,
            navigationBack: documentActions.navigationBack,
            editorSection,
            actionToggle: documentActions.toggle,
            actionMenu: documentActions.menu,
            reparse: documentActions.reparse,
            reparseLabel: documentActions.reparseLabel,
            correctionToggle: documentActions.correctionToggle,
            correctionToggleLabel: documentActions.correctionToggleLabel,
            retranslateDocument: documentActions.retranslateDocument,
            retranslateDocumentLabel:
                documentActions.retranslateDocumentLabel,
            translateDocument: documentActions.translateDocument,
            translateDocumentLabel: documentActions.translateDocumentLabel,
            translationIdleIcon: documentActions.translationIdleIcon,
            translationLoadingIcon: documentActions.translationLoadingIcon,
            translationControls: documentActions.translationControls,
            translationSeparator: documentActions.translationSeparator,
            translationView: documentActions.translationView,
            translationViewButtons: documentActions.translationViewButtons,
            translationViewLabels: documentActions.translationViewLabels,
            translationViewLabel: documentActions.translationViewLabel,
            translatedViewLabel: documentActions.translatedViewLabel,
            translationLanguageChevron:
                documentActions.translationLanguageChevron,
            translationLanguageOptions:
                documentActions.translationLanguageOptions,
            translationStatus: documentActions.translationStatus,
            translationFailureNavigation:
                documentActions.translationFailureNavigation,
            translationFailurePosition:
                documentActions.translationFailurePosition,
            previousTranslationFailure:
                documentActions.previousTranslationFailure,
            nextTranslationFailure: documentActions.nextTranslationFailure,
            restoreCorrections: documentActions.restoreCorrections,
            restoreCorrectionsLabel: documentActions.restoreCorrectionsLabel,
            saveSnapshot: documentActions.saveSnapshot,
            saveSnapshotLabel: documentActions.saveSnapshotLabel,
            exportMarkdown: documentActions.exportMarkdown,
            exportMarkdownLabel: documentActions.exportMarkdownLabel,
            readerControls: documentActions.readerControls,
            readerFontSize: documentActions.readerFontSize,
            readerFontDecrease: documentActions.readerFontDecrease,
            readerFontIncrease: documentActions.readerFontIncrease,
            readerFontValue: documentActions.readerFontValue,
            readerFontFamily: documentActions.readerFontFamily,
            readerFontTrigger: documentActions.readerFontTrigger,
            readerFontCurrent: documentActions.readerFontCurrent,
            readerFontOptions: documentActions.readerFontOptions,
            actionStatus: documentActions.status,
        };
    }

    createDocumentActions() {
        const navigationBack = this.createElement('button', {
            id: 'mktero-navigation-back',
            class: 'markdown-reader-action markdown-reader-navigation-back',
            type: 'button',
            'aria-label': this.t('viewer.returnToCitation'),
            title: this.t('viewer.returnToCitation'),
            disabled: 'true',
        });
        navigationBack.appendChild(createLucideIcon(
            this.document,
            LUCIDE_ICONS.arrowLeft,
            {
                className: 'markdown-reader-action-icon',
                size: 18,
            }
        ));
        const toggle = this.createElement('button', {
            id: 'mktero-document-actions',
            class: 'markdown-reader-action markdown-reader-action--primary',
            type: 'button',
            'aria-expanded': 'false',
            'aria-controls': 'mktero-document-action-menu',
            'aria-haspopup': 'dialog',
            'aria-label': this.t('viewer.documentActionsToggle'),
            title: this.t('viewer.documentActionsToggle'),
        });
        toggle.appendChild(createLucideIcon(
            this.document,
            LUCIDE_ICONS.moreHorizontal,
            {
                className: 'markdown-reader-action-icon',
                size: 18,
            }
        ));
        const menu = this.createElement('div', {
            id: 'mktero-document-action-menu',
            class: 'markdown-reader-action-menu',
            role: 'dialog',
            'aria-label': this.t('viewer.documentActions'),
            'aria-hidden': 'true',
        });
        const readerFontDecrease = this.createElement('button', {
            id: 'mktero-reader-font-decrease',
            class: 'markdown-reader-font-button',
            type: 'button',
            'aria-label': this.t('viewer.textSizeDecrease'),
            title: this.t('viewer.textSizeDecrease'),
        }, 'A−');
        const readerFontValue = this.createElement('output', {
            id: 'mktero-reader-font-value',
            class: 'markdown-reader-font-value',
            'aria-live': 'polite',
            'aria-atomic': 'true',
        });
        const readerFontIncrease = this.createElement('button', {
            id: 'mktero-reader-font-increase',
            class: 'markdown-reader-font-button',
            type: 'button',
            'aria-label': this.t('viewer.textSizeIncrease'),
            title: this.t('viewer.textSizeIncrease'),
        }, 'A+');
        const readerFontControls = this.createElement('span', {
            class: 'markdown-reader-font-controls',
        });
        appendChildren(
            readerFontControls,
            readerFontDecrease,
            readerFontValue,
            readerFontIncrease
        );
        const readerFontSize = this.createElement('div', {
            class: 'markdown-reader-font-size',
            role: 'group',
            'aria-label': this.t('viewer.textSize'),
        });
        readerFontSize.appendChild(readerFontControls);
        const readerFontCurrent = this.createElement('span', {
            class: 'markdown-reader-font-current',
        });
        const readerFontTrigger = this.createElement('button', {
            id: 'mktero-reader-font-family',
            class: 'markdown-reader-font-select',
            type: 'button',
            'aria-haspopup': 'listbox',
            'aria-expanded': 'false',
            'aria-controls': 'mktero-reader-font-options',
            'aria-label': this.t('viewer.textFont'),
            title: this.t('viewer.textFont'),
        });
        appendChildren(
            readerFontTrigger,
            readerFontCurrent,
            createLucideIcon(
                this.document,
                LUCIDE_ICONS.chevronDown,
                {
                    className: 'markdown-reader-font-chevron',
                    size: 14,
                }
            )
        );
        const readerFontOptions = this.createElement('div', {
            id: 'mktero-reader-font-options',
            class: 'markdown-reader-font-options',
            role: 'listbox',
            'aria-label': this.t('viewer.textFont'),
        });
        readerFontOptions.hidden = true;
        readerFontOptions.replaceChildren(...MARKDOWN_READER_FONT_OPTIONS.map(
            option => this.createReaderFontOption(option)
        ));
        const readerFontPicker = this.createElement('div', {
            class: 'markdown-reader-font-picker',
        });
        appendChildren(readerFontPicker, readerFontTrigger, readerFontOptions);
        const readerFontFamily = this.createElement('div', {
            class: 'markdown-reader-font-family',
            role: 'group',
            'aria-label': this.t('viewer.textFont'),
        });
        readerFontFamily.appendChild(readerFontPicker);
        const readerControls = this.createElement('div', {
            class: 'markdown-reader-controls',
        });
        appendChildren(readerControls, readerFontSize, readerFontFamily);
        const correctionToggle = this.createElement('button', {
            id: 'mktero-correction-toggle',
            class: 'markdown-reader-action markdown-reader-action--child',
            type: 'button',
            'aria-label': this.t('revision.start'),
            title: this.t('revision.start'),
        });
        correctionToggle.appendChild(createLucideIcon(
            this.document,
            LUCIDE_ICONS.fileText,
            {
                className: 'markdown-reader-action-icon',
                size: 18,
            }
        ));
        const correctionToggleLabel = this.createElement(
            'span',
            { class: 'markdown-reader-action-label' },
            this.t('revision.start')
        );
        correctionToggle.appendChild(correctionToggleLabel);
        const restoreCorrections = this.createElement('button', {
            id: 'mktero-restore-corrections',
            class: 'markdown-reader-action markdown-reader-action--child',
            type: 'button',
            'aria-label': this.t('revision.restoreAll'),
            title: this.t('revision.restoreAll'),
        });
        restoreCorrections.appendChild(createLucideIcon(
            this.document,
            LUCIDE_ICONS.refreshCw,
            {
                className: 'markdown-reader-action-icon',
                size: 18,
            }
        ));
        const restoreCorrectionsLabel = this.createElement(
            'span',
            { class: 'markdown-reader-action-label' },
            this.t('revision.restoreAll')
        );
        restoreCorrections.appendChild(restoreCorrectionsLabel);
        const retranslateDocument = this.createElement('button', {
            id: 'mktero-retranslate-document',
            class: 'markdown-reader-action markdown-reader-action--child',
            type: 'button',
            'aria-label': this.t('ai.retranslateDocument'),
            title: this.t('ai.retranslateDocument'),
        });
        retranslateDocument.appendChild(createLucideIcon(
            this.document,
            LUCIDE_ICONS.refreshCw,
            {
                className: 'markdown-reader-action-icon',
                size: 18,
            }
        ));
        const retranslateDocumentLabel = this.createElement(
            'span',
            { class: 'markdown-reader-action-label' },
            this.t('ai.retranslateDocument')
        );
        retranslateDocument.appendChild(retranslateDocumentLabel);
        const translateDocument = this.createElement('button', {
            id: 'mktero-translate-document',
            class: 'markdown-translation-action',
            type: 'button',
            'aria-label': this.t('ai.translateDocument'),
            title: this.t('ai.translateDocument'),
        });
        const translationIdleIcon = createLucideIcon(
            this.document,
            LUCIDE_ICONS.languages,
            {
                className: 'markdown-reader-action-icon '
                    + 'markdown-translation-idle-icon',
                size: 18,
            }
        );
        const translationLoadingIcon = createLucideIcon(
            this.document,
            LUCIDE_ICONS.loaderCircle,
            {
                className: 'markdown-reader-action-icon '
                    + 'markdown-translation-loading-icon',
                size: 18,
            }
        );
        translationLoadingIcon.setAttribute('hidden', 'hidden');
        appendChildren(
            translateDocument,
            translationIdleIcon,
            translationLoadingIcon
        );
        const translateDocumentLabel = this.createElement(
            'span',
            { class: 'markdown-translation-action-label' },
            this.t('ai.translateDocument')
        );
        translateDocument.appendChild(translateDocumentLabel);
        const translationViewLabel = this.createElement(
            'span',
            {
                id: 'mktero-translation-view-label',
                class: 'markdown-translation-view-label',
            },
            this.t('ai.translationViewLabel')
        );
        const translationView = this.createElement('div', {
            id: 'mktero-translation-view',
            class: 'markdown-translation-view',
            role: 'radiogroup',
            'aria-labelledby': 'mktero-translation-view-label',
        });
        const translationViewButtons = [];
        const translationViewLabels = [];
        let translatedViewLabel = null;
        let translationLanguageChevron = null;
        for (const option of [
            ['original', 'ai.translationView.original'],
            ['translated', 'ai.translationView.translated'],
            ['compare', 'ai.translationView.compare'],
        ]) {
            const button = this.createElement('button', {
                class: 'markdown-translation-view-button',
                type: 'button',
                'data-translation-view': option[0],
                role: 'radio',
                'aria-checked': String(option[0] === 'original'),
                tabindex: option[0] === 'original' ? '0' : '-1',
            });
            const label = this.createElement('span', {
                class: 'markdown-translation-view-button-label',
                'data-i18n': option[1],
            }, this.t(option[1]));
            button.appendChild(label);
            translationViewLabels.push(label);
            if (option[0] === 'translated') {
                translatedViewLabel = label;
                translationLanguageChevron = createLucideIcon(
                    this.document,
                    LUCIDE_ICONS.chevronDown,
                    {
                        className: 'markdown-translation-language-chevron',
                        size: 13,
                    }
                );
                translationLanguageChevron.hidden = true;
                button.appendChild(translationLanguageChevron);
            }
            translationViewButtons.push(button);
            translationView.appendChild(button);
        }
        const translationLanguageOptions = this.createElement('div', {
            id: 'mktero-translation-language-options',
            class: 'markdown-translation-language-options',
            role: 'menu',
            'aria-label': this.t('ai.translationLanguages'),
            'aria-hidden': 'true',
        });
        translationLanguageOptions.hidden = true;
        translationView.appendChild(translationLanguageOptions);
        const translationControls = this.createElement('div', {
            class: 'markdown-translation-controls',
        });
        const translationStatus = this.createElement('span', {
            class: 'markdown-translation-status',
            role: 'status',
            'aria-live': 'polite',
            'aria-atomic': 'true',
        });
        translationStatus.hidden = true;
        const translationContext = this.createElement('span', {
            class: 'markdown-translation-context',
        });
        translationContext.appendChild(translationStatus);
        const translationFailureNavigation = this.createElement('div', {
            class: 'markdown-translation-failure-navigation',
        });
        translationFailureNavigation.hidden = true;
        const previousTranslationFailure = this.createElement('button', {
            class: 'markdown-translation-failure-navigation-button',
            type: 'button',
            'aria-label': this.t('ai.previousTranslationFailure'),
            title: this.t('ai.previousTranslationFailure'),
        });
        previousTranslationFailure.appendChild(createLucideIcon(
            this.document,
            LUCIDE_ICONS.chevronUp,
            { size: 16 }
        ));
        const nextTranslationFailure = this.createElement('button', {
            class: 'markdown-translation-failure-navigation-button',
            type: 'button',
            'aria-label': this.t('ai.nextTranslationFailure'),
            title: this.t('ai.nextTranslationFailure'),
        });
        nextTranslationFailure.appendChild(createLucideIcon(
            this.document,
            LUCIDE_ICONS.chevronDown,
            { size: 16 }
        ));
        const translationFailurePosition = this.createElement('span', {
            class: 'markdown-translation-failure-position',
            role: 'status',
            'aria-live': 'polite',
            'aria-atomic': 'true',
        });
        appendChildren(
            translationFailureNavigation,
            previousTranslationFailure,
            translationFailurePosition,
            nextTranslationFailure
        );
        const translationSeparator = this.createElement('span', {
            class: 'markdown-translation-separator',
            role: 'separator',
            'aria-orientation': 'vertical',
        });
        appendChildren(
            translationControls,
            translationViewLabel,
            translationView,
            translationContext,
            translationFailureNavigation,
            translationSeparator,
            translateDocument
        );
        const reparse = this.createElement('button', {
            id: 'mktero-reparse',
            class: 'markdown-reader-action markdown-reader-action--child',
            type: 'button',
            'aria-label': this.t('viewer.reparse'),
            title: this.t('viewer.reparse'),
        });
        reparse.appendChild(createLucideIcon(
            this.document,
            LUCIDE_ICONS.refreshCw,
            {
                className: 'markdown-reader-action-icon',
                size: 18,
            }
        ));
        const reparseLabel = this.createElement(
            'span',
            { class: 'markdown-reader-action-label' },
            this.t('viewer.reparseShort')
        );
        reparse.appendChild(reparseLabel);
        const saveSnapshot = this.createElement('button', {
            id: 'mktero-save-snapshot',
            class: 'markdown-reader-action markdown-reader-action--child',
            type: 'button',
            'aria-label': this.t('viewer.saveSnapshot'),
            title: this.t('viewer.saveSnapshot'),
        });
        saveSnapshot.appendChild(createLucideIcon(
            this.document,
            LUCIDE_ICONS.save,
            {
                className: 'markdown-reader-action-icon',
                size: 18,
            }
        ));
        const saveSnapshotLabel = this.createElement(
            'span',
            { class: 'markdown-reader-action-label' },
            this.t('viewer.saveSnapshotShort')
        );
        saveSnapshot.appendChild(saveSnapshotLabel);
        const exportMarkdown = this.createElement('button', {
            id: 'mktero-export-markdown',
            class: 'markdown-reader-action markdown-reader-action--child',
            type: 'button',
            'aria-label': this.t('viewer.exportMarkdown'),
            title: this.t('viewer.exportMarkdown'),
        });
        exportMarkdown.appendChild(createLucideIcon(
            this.document,
            LUCIDE_ICONS.download,
            {
                className: 'markdown-reader-action-icon',
                size: 18,
            }
        ));
        const exportMarkdownLabel = this.createElement(
            'span',
            { class: 'markdown-reader-action-label' },
            this.t('viewer.exportMarkdownShort')
        );
        exportMarkdown.appendChild(exportMarkdownLabel);
        menu.appendChild(correctionToggle);
        menu.appendChild(restoreCorrections);
        menu.appendChild(retranslateDocument);
        menu.appendChild(reparse);
        menu.appendChild(saveSnapshot);
        menu.appendChild(exportMarkdown);
        const status = this.createElement('span', {
            class: 'markdown-reader-action-status',
            'aria-live': 'polite',
            'aria-atomic': 'true',
        });
        status.hidden = true;
        const editorActions = this.createElement('div', {
            class: 'markdown-reader-actions markdown-reader-toolbar',
            role: 'toolbar',
            'aria-label': this.t('viewer.toolbar'),
        });
        appendChildren(
            editorActions,
            navigationBack,
            readerControls,
            translationControls,
            status,
            toggle,
            menu
        );
        return {
            toolbar: editorActions,
            navigationBack,
            toggle,
            menu,
            reparse,
            reparseLabel,
            correctionToggle,
            correctionToggleLabel,
            retranslateDocument,
            retranslateDocumentLabel,
            translateDocument,
            translationIdleIcon,
            translationLoadingIcon,
            translateDocumentLabel,
            translationControls,
            translationSeparator,
            translationView,
            translationViewButtons,
            translationViewLabels,
            translationViewLabel,
            translatedViewLabel,
            translationLanguageChevron,
            translationLanguageOptions,
            translationStatus,
            translationFailureNavigation,
            translationFailurePosition,
            previousTranslationFailure,
            nextTranslationFailure,
            restoreCorrections,
            restoreCorrectionsLabel,
            saveSnapshot,
            saveSnapshotLabel,
            exportMarkdown,
            exportMarkdownLabel,
            readerControls,
            readerFontSize,
            readerFontDecrease,
            readerFontIncrease,
            readerFontValue,
            readerFontFamily,
            readerFontTrigger,
            readerFontCurrent,
            readerFontOptions,
            status,
        };
    }

    createSidePanelEdge(name) {
        const panel = this.sidePanels[name];
        const id = `mktero-${name}`;
        const resizer = this.createElement('div', {
            id: `${id}-resizer`,
            class: `markdown-side-panel-resizer markdown-${name}-resizer`,
            role: 'separator',
            tabindex: '0',
            'aria-controls': id,
            'aria-orientation': 'vertical',
            'aria-valuemin': String(panel.minWidth),
            'aria-valuemax': String(panel.maxWidth),
            'aria-valuenow': String(panel.width),
            'aria-label': this.t(panel.resizeLabelKey),
            title: this.t(panel.resizeLabelKey),
        });
        const toggle = this.createElement('button', {
            id: `${id}-toggle`,
            class: `markdown-side-panel-toggle markdown-${name}-toggle`,
            type: 'button',
            'aria-controls': id,
            'aria-expanded': 'true',
            'aria-label': this.t(panel.collapseLabelKey),
            title: this.t(panel.collapseLabelKey),
        });
        toggle.appendChild(this.createSidePanelIcon(panel.collapseIcon));
        const edge = this.createElement('div', {
            class: `markdown-side-panel-edge markdown-${name}-edge`,
        });
        appendChildren(edge, resizer, toggle);
        return { edge, resizer, toggle };
    }

    createOutlineSegmentButton(segment, labelKey) {
        return this.createElement('button', {
            class: 'markdown-outline-segment',
            type: 'button',
            role: 'tab',
            id: `mktero-outline-segment-${segment}`,
            'data-outline-segment': segment,
            'aria-selected': segment === OUTLINE_SEGMENT_HEADINGS
                ? 'true'
                : 'false',
            'aria-controls': 'mktero-outline-list',
        }, this.t(labelKey));
    }

    createElement(tagName, attributes = {}, text = '') {
        const element = this.document.createElementNS(XHTML_NAMESPACE, tagName);
        for (const [name, value] of Object.entries(attributes)) {
            element.setAttribute(name, value);
        }
        if (text) element.textContent = text;
        return element;
    }

    bindActions() {
        this.listen(this.elements.navigationBack, 'click', () => {
            this.editor.returnToCitation?.();
        });
        this.listen(this.elements.actionToggle, 'click', () => {
            if (this.elements.actionToggle.disabled) return;
            this.setReaderFontOptionsOpen(false);
            this.setTranslationLanguagesOpen(false);
            this.setDocumentActionsOpen(!this.documentActionsOpen);
        });
        this.listen(this.elements.reparse, 'click', event => {
            void this.reparseDocument(event.currentTarget);
        });
        this.listen(this.elements.correctionToggle, 'click', () => {
            this.toggleCorrectionMode();
        });
        this.listen(this.elements.translateDocument, 'click', () => {
            this.runDocumentTranslationAction();
        });
        this.listen(this.elements.retranslateDocument, 'click', () => {
            this.runDocumentRetranslationAction();
        });
        for (const button of this.elements.translationViewButtons) {
            this.listen(button, 'click', () => {
                if (button.getAttribute('data-translation-view') === 'translated'
                    && this.hasTranslationLanguageOptions()) {
                    this.setDocumentActionsOpen(false);
                    this.setReaderFontOptionsOpen(false);
                    this.setTranslationLanguagesOpen(
                        !this.translationLanguagesOpen
                    );
                    if (this.translationLanguagesOpen) {
                        this.focusTranslationLanguageOption(
                            this.model.translationTargetLanguage
                        );
                    }
                    return;
                }
                this.setTranslationLanguagesOpen(false);
                this.setTranslationView(
                    button.getAttribute('data-translation-view')
                );
            });
            this.listen(button, 'keydown', event => {
                if (button.getAttribute('data-translation-view') === 'translated'
                    && this.handleTranslationLanguageTriggerKeydown(event)) {
                    return;
                }
                this.handleTranslationViewKeydown(event, button);
            });
        }
        this.listen(this.elements.translationLanguageOptions, 'click', event => {
            const option = event.target?.closest?.(
                '.markdown-translation-language-option'
            );
            if (!option
                || !this.elements.translationLanguageOptions.contains(option)) {
                return;
            }
            if (option.hasAttribute('data-translation-cancel')) {
                this.cancelTranslationFromLanguageMenu();
                return;
            }
            this.selectTranslationLanguage(
                option.getAttribute('data-translation-language')
            );
        });
        this.listen(
            this.elements.translationLanguageOptions,
            'keydown',
            event => this.handleTranslationLanguageOptionKeydown(event)
        );
        this.listen(this.elements.previousTranslationFailure, 'click', () => {
            this.navigateTranslationFailure(-1);
        });
        this.listen(this.elements.nextTranslationFailure, 'click', () => {
            this.navigateTranslationFailure(1);
        });
        this.listen(this.elements.restoreCorrections, 'click', () => {
            void this.restoreAllCorrections();
        });
        this.listen(this.elements.correctionUndoButton, 'click', () => {
            void this.undoDeletedCorrection();
        });
        this.listen(this.elements.errorRetry, 'click', () => {
            this.runDocumentAction('retry', 'onReparse');
        });
        this.listen(this.elements.errorSettings, 'click', () => {
            this.runDocumentAction('openSettings', 'onOpenSettings');
        });
        this.listen(this.elements.warningSettings, 'click', () => {
            this.runDocumentAction('openWarningSettings', 'onOpenSettings');
        });
        this.listen(this.elements.saveSnapshot, 'click', () => {
            this.runDocumentAction('saveSnapshot', 'onSaveSnapshot');
        });
        this.listen(this.elements.exportMarkdown, 'click', () => {
            this.runDocumentAction('exportMarkdown', 'onExportMarkdown', {
                ownerWindow: this.ownerWindow,
            });
        });
        this.listen(this.elements.citationGraphButton, 'click', () => {
            this.openCitationGraph();
        });
        this.listen(this.elements.githubReposButton, 'click', () => {
            this.setGitHubReposOpen(!this.githubReposOpen);
        });
        this.listen(this.elements.githubReposMenu, 'click', event => {
            const item = event.target?.closest?.('.markdown-github-repos-item');
            if (!item || !this.elements.githubReposMenu.contains(item)) return;
            const href = safeMarkdownLinkURL(
                item.getAttribute('data-github-href') || ''
            );
            this.setGitHubReposOpen(false);
            if (href) this.openLink(href);
        });
        this.listen(this.elements.readerFontDecrease, 'click', () => {
            this.changeReaderFontSize(-1);
        });
        this.listen(this.elements.readerFontIncrease, 'click', () => {
            this.changeReaderFontSize(1);
        });
        this.listen(this.elements.readerFontTrigger, 'click', () => {
            this.setDocumentActionsOpen(false);
            this.setTranslationLanguagesOpen(false);
            this.setReaderFontOptionsOpen(!this.readerFontOptionsOpen);
        });
        this.listen(this.elements.readerFontTrigger, 'keydown', event => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            this.setDocumentActionsOpen(false);
            this.setTranslationLanguagesOpen(false);
            this.setReaderFontOptionsOpen(true);
            this.focusReaderFontOption(this.activeReaderFontValue());
        });
        this.listen(this.elements.readerFontOptions, 'click', event => {
            const option = event.target?.closest?.(
                '.markdown-reader-font-option'
            );
            if (!option || !this.elements.readerFontOptions.contains(option)) {
                return;
            }
            this.changeReaderFont(option.getAttribute('data-reader-font'));
            this.setReaderFontOptionsOpen(false);
            this.elements.readerFontTrigger.focus?.();
        });
        this.listen(this.elements.readerFontOptions, 'keydown', event => {
            this.handleReaderFontOptionKeydown(event);
        });
        this.listen(this.ownerWindow, 'keydown', event => {
            if (event.key === 'Escape' && this.translationLanguagesOpen) {
                event.preventDefault();
                this.setTranslationLanguagesOpen(false);
                this.translatedViewButton()?.focus?.();
                return;
            }
            if (event.key === 'Escape' && this.readerFontOptionsOpen) {
                event.preventDefault();
                this.setReaderFontOptionsOpen(false);
                this.elements.readerFontTrigger.focus?.();
                return;
            }
            if (event.key === 'Escape' && this.githubReposOpen) {
                event.preventDefault();
                this.setGitHubReposOpen(false);
                this.elements.githubReposButton.focus?.();
                return;
            }
            if (event.key === 'Escape' && this.documentActionsOpen) {
                event.preventDefault();
                this.setDocumentActionsOpen(false);
                this.elements.actionToggle.focus?.();
            }
        });
        const closeDocumentActionsOnOutsidePress = event => {
            if (!this.documentActionsOpen
                && !this.readerFontOptionsOpen
                && !this.translationLanguagesOpen
                && !this.githubReposOpen) return;
            const path = event.composedPath?.() || [];
            if (!path.includes(this.elements.translationView)) {
                this.setTranslationLanguagesOpen(false);
            }
            if (!path.includes(this.elements.readerFontFamily)) {
                this.setReaderFontOptionsOpen(false);
            }
            if (!path.includes(this.elements.editorActions)) {
                this.setDocumentActionsOpen(false);
            }
            if (!path.includes(this.elements.githubReposButton)
                && !path.includes(this.elements.githubReposMenu)) {
                this.setGitHubReposOpen(false);
            }
        };
        this.listen(
            this.ownerWindow,
            'pointerdown',
            closeDocumentActionsOnOutsidePress,
            { capture: true }
        );
        this.listen(
            this.ownerWindow,
            'mousedown',
            closeDocumentActionsOnOutsidePress,
            { capture: true }
        );
        this.listen(this.elements.snapshotHost, 'click', event => {
            const link = event.target?.closest?.('a');
            if (!link || !this.elements.snapshotHost.contains(link)) return;
            const href = link.getAttribute('href');
            if (!href) return;
            event.preventDefault();
            this.openLink(href);
        });
        this.listen(this.elements.outlineSegments, 'click', event => {
            const button = event.target?.closest?.('.markdown-outline-segment');
            if (!button || !this.elements.outlineSegments.contains(button)) {
                return;
            }
            this.setOutlineSegment(button.getAttribute('data-outline-segment'));
        });
        this.listen(this.elements.outlineList, 'click', event => {
            const button = event.target?.closest?.('.markdown-outline-link');
            if (!button || !this.elements.outlineList.contains(button)) return;
            const offset = Number(button.getAttribute('data-offset'));
            if (Number.isFinite(offset)) {
                this.syncActiveNavigation(offset);
                this.editor.scrollToOffset?.(offset);
            }
        });
        this.listen(this.elements.notesList, 'click', event => {
            const openPDF = event.target?.closest?.(
                '.markdown-note-open-pdf'
            );
            if (openPDF && this.elements.notesList.contains(openPDF)) {
                const annotationID = openPDF.getAttribute('data-annotation-id');
                this.runNoteButtonAction(openPDF, () => (
                    this.model.onOpenAnnotationInPDF(annotationID)
                ));
                return;
            }
            const retry = event.target?.closest?.(
                '.markdown-note-sync-retry'
            );
            if (retry && this.elements.notesList.contains(retry)) {
                const annotationID = retry.getAttribute('data-annotation-id');
                this.runNoteButtonAction(retry, () => (
                    this.retryMarkdownAnnotationSynchronization(annotationID)
                ));
                return;
            }
            const button = event.target?.closest?.('.markdown-note-link');
            if (!button
                || button.hasAttribute('disabled')
                || !this.elements.notesList.contains(button)) {
                return;
            }
            const offset = Number(button.getAttribute('data-offset'));
            if (Number.isFinite(offset)) {
                this.syncActiveNavigation(offset);
                this.editor.scrollToOffset?.(offset);
            }
        });
        this.bindSidePanelActions('outline');
        this.bindSidePanelActions('notes');
        this.listen(this.ownerWindow, 'resize', () => {
            this.syncResponsiveSidePanels();
        });
        const ResizeObserverType = this.ownerWindow.ResizeObserver
            || globalThis.ResizeObserver;
        if (typeof ResizeObserverType === 'function') {
            this.responsiveResizeObserver = new ResizeObserverType(entries => {
                const entry = entries.find(item => item.target === this.host)
                    || entries[0];
                this.syncResponsiveSidePanels(entry?.contentRect?.width);
            });
            this.responsiveResizeObserver.observe(this.host);
        }
        this.listen(this.ownerWindow, 'mousemove', event => {
            this.resizeSidePanel('outline', event);
            this.resizeSidePanel('notes', event);
        });
        this.listen(this.ownerWindow, 'mouseup', () => {
            this.finishSidePanelResize('outline');
            this.finishSidePanelResize('notes');
        });
        const cancelSidePanelResizes = () => {
            this.cancelSidePanelResize('outline');
            this.cancelSidePanelResize('notes');
        };
        const editorScroller = this.elements.editorHost.querySelector(
            '.cm-scroller'
        );
        if (editorScroller) {
            this.listen(editorScroller, 'scroll', cancelSidePanelResizes);
        }
        this.listen(
            this.elements.editorHost,
            'scroll',
            cancelSidePanelResizes,
            { capture: true }
        );
        this.listen(
            this.elements.editorHost,
            'wheel',
            cancelSidePanelResizes,
            { capture: true }
        );
        this.listen(
            this.elements.workspace,
            'scroll',
            cancelSidePanelResizes,
            { capture: true }
        );
        this.listen(
            this.elements.workspace,
            'wheel',
            cancelSidePanelResizes,
            { capture: true }
        );
        this.listen(
            this.document,
            'scroll',
            cancelSidePanelResizes,
            { capture: true }
        );
        this.listen(
            this.document,
            'wheel',
            cancelSidePanelResizes,
            { capture: true }
        );
        this.syncResponsiveSidePanels();
    }

    runDocumentAction(kind, callbackName, ...args) {
        const button = {
            reparse: this.elements.reparse,
            retry: this.elements.errorRetry,
            openSettings: this.elements.errorSettings,
            openWarningSettings: this.elements.warningSettings,
            saveSnapshot: this.elements.saveSnapshot,
            exportMarkdown: this.elements.exportMarkdown,
        }[kind];
        if (!button || button.disabled
            || this.documentActionBusy
            || typeof this.model[callbackName] !== 'function') {
            return;
        }
        const feedback = DOCUMENT_ACTION_FEEDBACK[kind];
        this.documentActionBusy = kind;
        if (feedback?.progress) this.setDocumentActionStatus(feedback.progress);
        this.setDocumentActionsOpen(false);
        this.syncDocumentActions(
            this.model,
            createLoadingPresentation(this.model, this.t)
        );
        let operation;
        try {
            operation = this.model[callbackName](...args);
        }
        catch (error) {
            this.zotero?.logError?.(error);
            if (feedback?.failure) {
                this.setDocumentActionStatus(feedback.failure, {
                    dismissAfter: true,
                });
            }
            this.documentActionBusy = null;
            this.syncDocumentActions(
                this.model,
                createLoadingPresentation(this.model, this.t)
            );
            return;
        }
        Promise.resolve(operation)
            .then(result => {
                if (this.destroyed) return;
                if (feedback?.neutralStatus
                    && feedback.neutralStatus === result?.status) {
                    this.clearDocumentActionStatus();
                }
                else if (feedback?.success) {
                    this.setDocumentActionStatus(feedback.success, {
                        dismissAfter: true,
                    });
                }
            })
            .catch(error => {
                this.zotero?.logError?.(error);
                if (!this.destroyed && feedback?.failure) {
                    this.setDocumentActionStatus(feedback.failure, {
                        dismissAfter: true,
                    });
                }
            })
            .finally(() => {
                this.documentActionBusy = null;
                if (this.destroyed) return;
                this.syncDocumentActions(
                    this.model,
                    createLoadingPresentation(this.model, this.t)
                );
            });
    }

    openCitationGraph() {
        const button = this.elements.citationGraphButton;
        if (button.disabled || typeof this.model.onOpenCitationGraph !== 'function') {
            return;
        }
        button.disabled = true;
        let operation;
        try {
            operation = this.model.onOpenCitationGraph(
                this.model.sourceItemID ?? this.model.itemID
            );
        }
        catch (error) {
            this.zotero?.logError?.(error);
        }
        Promise.resolve(operation)
            .catch(error => this.zotero?.logError?.(error))
            .finally(() => {
                if (button.parentNode) {
                    button.disabled = false;
                    this.syncDocumentActions(
                        this.model,
                        createLoadingPresentation(this.model, this.t)
                    );
                }
            });
    }

    toggleCorrectionMode() {
        if (this.elements.correctionToggle.disabled
            || this.documentActionBusy
            || typeof this.model.onSetCorrectionMode !== 'function') {
            return;
        }
        this.setDocumentActionsOpen(false);
        try {
            this.model.onSetCorrectionMode(!this.model.correctionMode);
        }
        catch (error) {
            this.reportCorrectionError(error);
        }
    }

    runDocumentTranslationAction() {
        if (this.elements.translateDocument.disabled
            || this.documentActionBusy) {
            return;
        }
        let operation;
        try {
            operation = this.model.translationStatus === 'loading'
                ? this.model.onCancelDocumentTranslation?.()
                : this.model.onTranslateDocument?.();
        }
        catch (error) {
            this.reportTranslationError(error);
            return;
        }
        Promise.resolve(operation).catch(error => {
            this.reportTranslationError(error);
        });
    }

    runDocumentRetranslationAction() {
        if (this.elements.retranslateDocument.disabled
            || this.documentActionBusy
            || this.model.translationStatus === 'loading'
            || typeof this.model.onTranslateDocument !== 'function') {
            return;
        }
        this.setDocumentActionsOpen(false);
        try {
            Promise.resolve(this.model.onTranslateDocument({
                forceRetranslate: true,
            })).catch(error => this.reportTranslationError(error));
        }
        catch (error) {
            this.reportTranslationError(error);
        }
    }

    setTranslationView(view) {
        if (this.elements.translationViewButtons.every(button => button.disabled)
            || typeof this.model.onSetTranslationView !== 'function') return;
        this.setTranslationLanguagesOpen(false);
        this.model.onSetTranslationView(view);
    }

    translatedViewButton() {
        return this.elements.translationViewButtons.find(button => (
            button.getAttribute('data-translation-view') === 'translated'
        ));
    }

    hasTranslationLanguageOptions() {
        return typeof this.model.onSelectTranslationLanguage === 'function'
            && this.translatedViewButton()?.getAttribute('aria-haspopup')
                === 'menu'
            && this.translationLanguageOptionButtons().length > 0;
    }

    handleTranslationLanguageTriggerKeydown(event) {
        if (!this.hasTranslationLanguageOptions()) return false;
        if (event.key === 'Escape' && this.translationLanguagesOpen) {
            event.preventDefault();
            event.stopPropagation();
            this.setTranslationLanguagesOpen(false);
            return true;
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return false;
        event.preventDefault();
        event.stopPropagation();
        this.setDocumentActionsOpen(false);
        this.setReaderFontOptionsOpen(false);
        this.setTranslationLanguagesOpen(true);
        this.focusTranslationLanguageOption(
            this.model.translationTargetLanguage,
            { lastFallback: event.key === 'ArrowUp' }
        );
        return true;
    }

    selectTranslationLanguage(language) {
        if (!this.hasTranslationLanguageOptions()
            || this.translatedViewButton()?.disabled
            || typeof this.model.onSelectTranslationLanguage !== 'function') {
            return;
        }
        this.setTranslationLanguagesOpen(false);
        this.translatedViewButton()?.focus?.();
        try {
            Promise.resolve(
                this.model.onSelectTranslationLanguage(language)
            ).catch(error => this.reportTranslationError(error));
        }
        catch (error) {
            this.reportTranslationError(error);
        }
    }

    cancelTranslationFromLanguageMenu() {
        if (this.model.translationStatus !== 'loading'
            || typeof this.model.onCancelDocumentTranslation !== 'function') {
            return;
        }
        this.setTranslationLanguagesOpen(false);
        this.translatedViewButton()?.focus?.();
        try {
            this.model.onCancelDocumentTranslation();
        }
        catch (error) {
            this.reportTranslationError(error);
        }
    }

    setTranslationLanguagesOpen(open) {
        const button = this.translatedViewButton();
        if (!button) return;
        const visible = Boolean(open)
            && !button.disabled
            && this.hasTranslationLanguageOptions();
        this.translationLanguagesOpen = visible;
        button.setAttribute('aria-expanded', String(visible));
        this.elements.translationLanguageOptions.hidden = !visible;
        this.elements.translationLanguageOptions.setAttribute(
            'aria-hidden',
            String(!visible)
        );
        this.elements.translationView.classList.toggle(
            'is-language-menu-open',
            visible
        );
        for (const option of this.translationLanguageMenuButtons()) {
            const selected = option.getAttribute('aria-checked') === 'true';
            option.setAttribute('tabindex', visible && selected ? '0' : '-1');
        }
    }

    translationLanguageOptionButtons() {
        return [...this.elements.translationLanguageOptions.querySelectorAll(
            '[data-translation-language]'
        )];
    }

    translationLanguageMenuButtons() {
        return [...this.elements.translationLanguageOptions.querySelectorAll(
            '.markdown-translation-language-option:not([disabled])'
        )].filter(option => !option.hidden);
    }

    focusTranslationLanguageOption(language, { lastFallback = false } = {}) {
        const options = this.translationLanguageMenuButtons();
        const target = options.find(option => (
            option.getAttribute('data-translation-language') === language
        )) || options[lastFallback ? options.length - 1 : 0];
        if (!target) return;
        for (const option of options) {
            option.setAttribute('tabindex', option === target ? '0' : '-1');
        }
        target.focus?.();
    }

    handleTranslationLanguageOptionKeydown(event) {
        const option = event.target?.closest?.(
            '.markdown-translation-language-option'
        );
        if (!option
            || !this.elements.translationLanguageOptions.contains(option)) {
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            this.setTranslationLanguagesOpen(false);
            this.translatedViewButton()?.focus?.();
            return;
        }
        if (event.key === 'Tab') {
            this.setTranslationLanguagesOpen(false);
            return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            option.click();
            return;
        }
        const options = this.translationLanguageMenuButtons();
        const index = options.indexOf(option);
        let nextIndex;
        if (event.key === 'ArrowDown') {
            nextIndex = (index + 1) % options.length;
        }
        else if (event.key === 'ArrowUp') {
            nextIndex = (index - 1 + options.length) % options.length;
        }
        else if (event.key === 'Home') {
            nextIndex = 0;
        }
        else if (event.key === 'End') {
            nextIndex = options.length - 1;
        }
        else {
            return;
        }
        event.preventDefault();
        this.focusTranslationLanguageOption(
            options[nextIndex].getAttribute('data-translation-language')
        );
    }

    handleTranslationViewKeydown(event, currentButton) {
        const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
        if (!keys.includes(event.key)) return;
        const enabled = this.elements.translationViewButtons.filter(
            button => !button.disabled
        );
        const index = enabled.indexOf(currentButton);
        if (index < 0) return;
        event.preventDefault();
        const direction = ['ArrowRight', 'ArrowDown'].includes(event.key)
            ? 1
            : -1;
        const next = enabled[(index + direction + enabled.length)
            % enabled.length];
        next.focus?.();
        this.setTranslationView(next.getAttribute('data-translation-view'));
    }

    navigateTranslationFailure(direction) {
        const failures = visibleTranslationFailureRanges(this.model);
        if (!failures.length) return;
        const current = this.activeNavigationOffset;
        const activeIndex = Math.max(
            0,
            failures.findIndex(failure => failure.id
                === this.activeTranslationFailureID)
        );
        const next = this.activeTranslationFailureID
            ? failures[(activeIndex + direction + failures.length)
                % failures.length]
            : direction > 0
                ? failures.find(failure => failure.from > current)
                    || failures[0]
                : [...failures].reverse().find(failure => failure.from < current)
                    || failures.at(-1);
        this.activeTranslationFailureID = next.id;
        this.restoreReadingPosition(next.from);
        this.editor.highlightTranslationBlock?.(next.id);
    }

    reportTranslationError(error) {
        this.zotero?.logError?.(error);
    }

    commitCorrection(correction) {
        return this.runCorrectionOperation(
            () => this.model.onCommitCorrection(correction),
            {
                progressKey: 'revision.saving',
                successKey: 'revision.saved',
                failureKey: 'revision.saveFailed',
            }
        ).then(result => {
            const replacement = String(
                correction.replacementMarkdown ?? ''
            );
            if (!replacement.trim()) {
                this.showCorrectionUndo(correction.blockID);
            }
            else {
                this.clearCorrectionUndo();
                void this.offerChangedBlockTranslation(result);
            }
            return result;
        });
    }

    async offerChangedBlockTranslation(result) {
        const refresh = result?.translationRefresh;
        const blockIDs = Array.isArray(refresh?.blockIDs)
            ? [...new Set(refresh.blockIDs.map(String).filter(Boolean))]
            : [];
        if (!blockIDs.length
            || typeof this.model.onTranslateDocument !== 'function') {
            return false;
        }
        const singular = blockIDs.length === 1;
        const confirmed = await this.confirmationDialog.confirm({
            title: this.t(singular
                ? 'ai.retranslateChangedBlockDialogTitle'
                : 'ai.retranslateChangedBlocksDialogTitle', {
                count: blockIDs.length,
            }),
            message: this.t(singular
                ? 'ai.retranslateChangedBlockConfirm'
                : 'ai.retranslateChangedBlocksConfirm', {
                count: blockIDs.length,
            }),
            confirmLabel: this.t('ai.retranslateChangedDialogConfirm'),
            cancelLabel: this.t('dialog.cancel'),
            icon: LUCIDE_ICONS.languages,
            confirmIcon: LUCIDE_ICONS.languages,
            returnFocus: this.elements.correctionToggle,
        });
        if (!confirmed) return false;
        Promise.resolve(this.model.onTranslateDocument({
            retryBlockIDs: blockIDs,
            targetLanguage: refresh.targetLanguage,
            translationView: refresh.translationView,
        })).catch(error => this.reportTranslationError(error));
        return true;
    }

    async reparseDocument(returnFocus = this.elements.reparse) {
        if (this.elements.reparse.disabled
            || this.documentActionBusy
            || typeof this.model.onReparse !== 'function') {
            return false;
        }
        const correctionCount = this.model.hasCorrections
            ? this.model.correctionCount || 0
            : 0;
        if (correctionCount) {
            const confirmed = await this.confirmationDialog.confirm({
                title: this.t('revision.reparseDialogTitle'),
                message: this.t('revision.reparseConfirm', {
                    count: correctionCount,
                }),
                confirmLabel: this.t('revision.reparseDialogConfirm'),
                cancelLabel: this.t('dialog.cancel'),
                tone: 'danger',
                icon: LUCIDE_ICONS.triangleAlert,
                confirmIcon: LUCIDE_ICONS.refreshCw,
                returnFocus,
            });
            if (!confirmed || this.destroyed) return false;
        }
        this.runDocumentAction('reparse', 'onReparse');
        return true;
    }

    restoreCorrection(blockID) {
        if (this.correctionUndoBlockID === blockID) {
            this.clearCorrectionUndo();
        }
        return this.runCorrectionOperation(
            () => this.model.onRestoreCorrection(blockID),
            {
                progressKey: 'revision.restoring',
                successKey: 'revision.restored',
                failureKey: 'revision.restoreFailed',
            }
        );
    }

    async restoreAllCorrections() {
        if (this.elements.restoreCorrections.disabled
            || typeof this.model.onRestoreAllCorrections !== 'function') {
            return false;
        }
        const confirmed = await this.confirmationDialog.confirm({
            title: this.t('revision.restoreAllDialogTitle'),
            message: this.t('revision.restoreAllConfirm', {
                count: this.model.correctionCount || 0,
            }),
            confirmLabel: this.t('revision.restoreAllDialogConfirm'),
            cancelLabel: this.t('dialog.cancel'),
            tone: 'danger',
            icon: LUCIDE_ICONS.triangleAlert,
            confirmIcon: LUCIDE_ICONS.rotateCcw,
            returnFocus: this.elements.restoreCorrections,
        });
        if (!confirmed) return false;
        this.clearCorrectionUndo();
        this.setDocumentActionsOpen(false);
        await this.runCorrectionOperation(
            () => this.model.onRestoreAllCorrections(),
            {
                progressKey: 'revision.restoring',
                successKey: 'revision.restored',
                failureKey: 'revision.restoreFailed',
            }
        );
        return true;
    }

    async undoDeletedCorrection() {
        const blockID = this.correctionUndoBlockID;
        if (!blockID) return false;
        this.clearCorrectionUndo();
        try {
            await this.restoreCorrection(blockID);
            return true;
        }
        catch {
            this.showCorrectionUndo(blockID);
            return false;
        }
    }

    async runCorrectionOperation(operation, {
        progressKey,
        successKey,
        failureKey,
    }) {
        if (this.documentActionBusy) {
            throw new Error('Another Markdown document action is in progress');
        }
        this.documentActionBusy = 'correction';
        this.setDocumentActionStatus(progressKey);
        this.syncDocumentActions(
            this.model,
            createLoadingPresentation(this.model, this.t)
        );
        try {
            const result = await operation();
            this.setDocumentActionStatus(successKey, { dismissAfter: true });
            return result;
        }
        catch (error) {
            this.zotero?.logError?.(error);
            this.setDocumentActionStatus(
                error?.code === 'MARKDOWN_ANNOTATION_PROTECTED'
                    ? 'revision.annotationProtected'
                    : failureKey,
                { dismissAfter: true }
            );
            throw error;
        }
        finally {
            this.documentActionBusy = null;
            this.syncDocumentActions(
                this.model,
                createLoadingPresentation(this.model, this.t)
            );
        }
    }

    reportCorrectionError(error) {
        this.zotero?.logError?.(error);
    }

    showCorrectionUndo(blockID) {
        this.clearCorrectionUndo();
        this.correctionUndoBlockID = blockID;
        this.elements.correctionUndoMessage.textContent = this.t(
            'revision.deletedUndo'
        );
        this.elements.correctionUndoButton.disabled = false;
        this.elements.correctionUndo.hidden = false;
        if (typeof this.ownerWindow.setTimeout !== 'function') return;
        this.correctionUndoTimer = this.ownerWindow.setTimeout(() => {
            this.correctionUndoTimer = null;
            this.correctionUndoBlockID = null;
            this.elements.correctionUndo.hidden = true;
        }, CORRECTION_UNDO_TIMEOUT_MS);
    }

    clearCorrectionUndo() {
        if (this.correctionUndoTimer !== null) {
            this.ownerWindow.clearTimeout?.(this.correctionUndoTimer);
            this.correctionUndoTimer = null;
        }
        this.correctionUndoBlockID = null;
        if (this.elements?.correctionUndo) {
            this.elements.correctionUndo.hidden = true;
            this.elements.correctionUndoButton.disabled = false;
        }
    }

    setDocumentActionStatus(key, { dismissAfter = false } = {}) {
        this.clearDocumentActionStatus();
        this.elements.actionStatus.textContent = this.t(key);
        this.elements.actionStatus.hidden = false;
        if (!dismissAfter || typeof this.ownerWindow.setTimeout !== 'function') {
            return;
        }
        this.actionStatusTimer = this.ownerWindow.setTimeout(() => {
            this.actionStatusTimer = null;
            this.elements.actionStatus.textContent = '';
            this.elements.actionStatus.hidden = true;
        }, DOCUMENT_ACTION_STATUS_TIMEOUT_MS);
    }

    changeReaderFontSize(delta) {
        const nextSize = normalizeMarkdownReaderFontSize(
            this.readerFontSize + delta
        );
        if (nextSize === this.readerFontSize) return;
        this.setReaderFontSize(nextSize);
        try {
            this.onReaderFontSizeChange?.(nextSize);
        }
        catch (error) {
            this.zotero?.logError?.(error);
        }
    }

    setReaderFont(font) {
        const nextFont = normalizeMarkdownReaderFont(font);
        const changed = nextFont !== this.readerFont;
        this.readerFont = nextFont;
        this.host.style.setProperty(
            '--reader-font',
            getMarkdownReaderFontFamily(this.readerFont)
        );
        if (changed) this.editor?.requestMeasure?.();
        if (!this.elements) return;
        this.syncReaderFontPicker();
    }

    syncReaderFontPicker() {
        const translation = this.translationReaderFontContext();
        if (translation) {
            this.host.style.setProperty(
                '--reader-selected-translation-font',
                translation.selected.family
            );
        }
        else {
            this.host.style.removeProperty('--reader-selected-translation-font');
        }
        const translatedMode = translation
            && this.model?.translationView === 'translated';
        const options = translatedMode
            ? translation.options
            : MARKDOWN_READER_FONT_OPTIONS;
        const context = translatedMode
            ? `translation:${translation.language}`
            : 'source';
        if (this.readerFontOptionsContext !== context) {
            const focusedOption = this.mount.activeElement;
            const optionHadFocus = Boolean(focusedOption)
                && this.elements.readerFontOptions.contains(focusedOption);
            this.setReaderFontOptionsOpen(false);
            if (optionHadFocus) this.elements.readerFontTrigger.focus?.();
            this.elements.readerFontOptions.replaceChildren(...options.map(
                option => this.createReaderFontOption(option)
            ));
            this.readerFontOptionsContext = context;
        }
        const selectedValue = translatedMode
            ? translation.selected.value
            : this.readerFont;
        const selectedConfig = options.find(option => (
            option.value === selectedValue
        )) || options[0];
        const selectedLabel = this.t(selectedConfig.labelKey);
        const triggerLabel = `${this.t('viewer.textFont')}: ${selectedLabel}`;
        this.elements.readerFontCurrent.textContent = selectedLabel;
        this.elements.readerFontTrigger.setAttribute('aria-label', triggerLabel);
        this.elements.readerFontTrigger.setAttribute('title', triggerLabel);
        for (const option of this.readerFontOptionButtons()) {
            const selected = option.getAttribute('data-reader-font')
                === selectedConfig.value;
            option.setAttribute('aria-selected', String(selected));
            option.classList.toggle('is-selected', selected);
            option.setAttribute(
                'tabindex',
                this.readerFontOptionsOpen && selected ? '0' : '-1'
            );
        }
    }

    translationReaderFontContext() {
        if (!hasAvailableTranslation(this.model)) return null;
        const language = normalizedTranslationLanguage(
            this.model.translationTargetLanguage
        );
        const options = TRANSLATION_FONT_OPTIONS[language];
        if (!options?.length) return null;
        const selectedValue = this.translationReaderFonts.get(language);
        const selected = options.find(option => option.value === selectedValue)
            || options[0];
        return { language, options, selected };
    }

    activeReaderFontValue() {
        const translation = this.translationReaderFontContext();
        return translation && this.model?.translationView === 'translated'
            ? translation.selected.value
            : this.readerFont;
    }

    createReaderFontOption(option) {
        const button = this.createElement('button', {
            id: `mktero-reader-font-option-${option.value}`,
            class: 'markdown-reader-font-option',
            type: 'button',
            role: 'option',
            'aria-selected': 'false',
            'data-reader-font': option.value,
            tabindex: '-1',
        });
        appendChildren(
            button,
            createLucideIcon(
                this.document,
                LUCIDE_ICONS.check,
                {
                    className: 'markdown-reader-font-option-check',
                    size: 14,
                }
            ),
            this.createElement('span', {
                class: 'markdown-reader-font-option-label',
                'data-i18n': option.labelKey,
            }, this.t(option.labelKey))
        );
        return button;
    }

    setReaderFontOptionsOpen(open) {
        const visible = Boolean(open)
            && !this.elements.readerFontFamily.hidden;
        this.readerFontOptionsOpen = visible;
        this.elements.readerFontTrigger.setAttribute(
            'aria-expanded',
            String(visible)
        );
        this.elements.readerFontOptions.hidden = !visible;
        this.elements.readerFontFamily.classList.toggle('is-open', visible);
        for (const option of this.readerFontOptionButtons()) {
            const selected = option.getAttribute('aria-selected') === 'true';
            option.setAttribute('tabindex', visible && selected ? '0' : '-1');
        }
    }

    readerFontOptionButtons() {
        return [...this.elements.readerFontOptions.querySelectorAll(
            '.markdown-reader-font-option'
        )];
    }

    focusReaderFontOption(font) {
        const options = this.readerFontOptionButtons();
        const target = options.find(option => (
            option.getAttribute('data-reader-font') === font
        )) || options[0];
        if (!target) return;
        for (const option of options) {
            option.setAttribute('tabindex', option === target ? '0' : '-1');
        }
        target.focus?.();
    }

    handleReaderFontOptionKeydown(event) {
        const option = event.target?.closest?.(
            '.markdown-reader-font-option'
        );
        if (!option || !this.elements.readerFontOptions.contains(option)) {
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            this.setReaderFontOptionsOpen(false);
            this.elements.readerFontTrigger.focus?.();
            return;
        }
        if (event.key === 'Tab') {
            this.setReaderFontOptionsOpen(false);
            return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            option.click();
            return;
        }
        const options = this.readerFontOptionButtons();
        const index = options.indexOf(option);
        let nextIndex;
        if (event.key === 'ArrowDown') {
            nextIndex = (index + 1) % options.length;
        }
        else if (event.key === 'ArrowUp') {
            nextIndex = (index - 1 + options.length) % options.length;
        }
        else if (event.key === 'Home') {
            nextIndex = 0;
        }
        else if (event.key === 'End') {
            nextIndex = options.length - 1;
        }
        else {
            return;
        }
        event.preventDefault();
        this.focusReaderFontOption(
            options[nextIndex].getAttribute('data-reader-font')
        );
    }

    setReaderFontSize(size) {
        const nextSize = normalizeMarkdownReaderFontSize(size);
        const changed = nextSize !== this.readerFontSize;
        this.readerFontSize = nextSize;
        this.host.style.setProperty(
            '--reader-font-size',
            `${this.readerFontSize}px`
        );
        if (changed) this.editor?.requestMeasure?.();
        if (!this.elements) return;
        this.elements.readerFontValue.textContent = this.t(
            'viewer.textSizeValue',
            { size: this.readerFontSize }
        );
        this.elements.readerFontDecrease.disabled
            = this.readerFontSize <= MIN_READER_FONT_SIZE;
        this.elements.readerFontIncrease.disabled
            = this.readerFontSize >= MAX_READER_FONT_SIZE;
    }

    clearDocumentActionStatus() {
        if (this.actionStatusTimer !== null) {
            this.ownerWindow.clearTimeout?.(this.actionStatusTimer);
            this.actionStatusTimer = null;
        }
        if (!this.elements?.actionStatus) return;
        this.elements.actionStatus.textContent = '';
        this.elements.actionStatus.hidden = true;
    }

    clearWarningToast() {
        if (this.warningToastTimer !== null) {
            this.ownerWindow.clearTimeout?.(this.warningToastTimer);
            this.warningToastTimer = null;
        }
        this.warningToastSignature = null;
        if (!this.elements?.warning) return;
        this.elements.warning.hidden = true;
        this.elements.warningMessage.textContent = '';
    }

    changeReaderFont(font) {
        const translation = this.translationReaderFontContext();
        if (translation && this.model?.translationView === 'translated') {
            const selected = translation.options.find(option => (
                option.value === font
            ));
            if (!selected || selected.value === translation.selected.value) return;
            this.translationReaderFonts.set(translation.language, selected.value);
            this.syncReaderFontPicker();
            this.editor?.requestMeasure?.();
            return;
        }
        const normalized = normalizeMarkdownReaderFont(font);
        if (normalized === this.readerFont) return;
        this.setReaderFont(normalized);
        try {
            this.onReaderFontChange?.(normalized);
        }
        catch (error) {
            this.zotero?.logError?.(error);
        }
    }

    runNoteButtonAction(button, action) {
        button.disabled = true;
        Promise.resolve()
            .then(action)
            .catch(error => this.zotero?.logError?.(error))
            .finally(() => {
                if (button.parentNode) button.disabled = false;
            });
    }

    bindSidePanelActions(name) {
        const panel = this.sidePanels[name];
        const { resizer, toggle } = this.sidePanelElements(name);
        this.listen(toggle, 'click', () => {
            this.setSidePanelVisibility(name, !panel.visible, {
                source: 'user',
            });
        });
        this.listen(resizer, 'dblclick', event => {
            event.preventDefault();
            this.setSidePanelVisibility(name, !panel.visible, {
                source: 'user',
            });
        });
        this.listen(resizer, 'mousedown', event => {
            this.startSidePanelResize(name, event);
        });
        this.listen(resizer, 'keydown', event => {
            this.handleSidePanelResizeKey(name, event);
        });
    }

    listen(element, type, listener, options) {
        element.addEventListener(type, listener, options);
        this.listeners.push({ element, type, listener, options });
    }

    syncContentVisibility(visible) {
        this.elements.workspace.hidden = !visible;
    }

    syncNavigationBack() {
        this.elements.navigationBack.disabled = !this.navigationBackAvailable;
    }

    syncLocalization() {
        this.host.setAttribute('aria-label', this.t('viewer.label'));
        this.elements.progressHeadingLabel.textContent = this.t('loading.progress');
        this.elements.editorSection.setAttribute(
            'aria-label',
            this.t('viewer.readOnly')
        );
        this.elements.editorActions.setAttribute(
            'aria-label',
            this.t('viewer.toolbar')
        );
        this.elements.navigationBack.setAttribute(
            'aria-label',
            this.t('viewer.returnToCitation')
        );
        this.elements.navigationBack.setAttribute(
            'title',
            this.t('viewer.returnToCitation')
        );
        this.elements.actionMenu.setAttribute(
            'aria-label',
            this.t('viewer.documentActions')
        );
        this.elements.actionToggle.setAttribute(
            'aria-label',
            this.t('viewer.documentActionsToggle')
        );
        this.elements.actionToggle.setAttribute(
            'title',
            this.t('viewer.documentActionsToggle')
        );
        this.elements.citationGraphButton.setAttribute(
            'aria-label',
            this.t('viewer.openCitationGraph')
        );
        this.elements.citationGraphButton.setAttribute(
            'title',
            this.t('viewer.openCitationGraph')
        );
        this.elements.githubReposButton.setAttribute(
            'aria-label',
            this.t('viewer.openGitHubRepositories')
        );
        this.elements.githubReposButton.setAttribute(
            'title',
            this.t('viewer.openGitHubRepositories')
        );
        this.elements.githubReposMenu.setAttribute(
            'aria-label',
            this.t('viewer.githubRepositories')
        );
        this.elements.reparse.setAttribute('aria-label', this.t('viewer.reparse'));
        this.elements.reparse.setAttribute('title', this.t('viewer.reparse'));
        this.elements.saveSnapshot.setAttribute(
            'aria-label',
            this.t('viewer.saveSnapshot')
        );
        this.elements.saveSnapshot.setAttribute(
            'title',
            this.t('viewer.saveSnapshot')
        );
        this.elements.exportMarkdown.setAttribute(
            'aria-label',
            this.t('viewer.exportMarkdown')
        );
        this.elements.exportMarkdown.setAttribute(
            'title',
            this.t('viewer.exportMarkdown')
        );
        this.elements.reparseLabel.textContent = this.t(
            'viewer.reparseShort'
        );
        this.elements.saveSnapshotLabel.textContent = this.t(
            'viewer.saveSnapshotShort'
        );
        this.elements.exportMarkdownLabel.textContent = this.t(
            'viewer.exportMarkdownShort'
        );
        const correctionLabel = this.t(this.model.correctionMode
            ? 'revision.finish'
            : 'revision.start');
        this.elements.correctionToggle.setAttribute(
            'aria-label',
            correctionLabel
        );
        this.elements.correctionToggle.setAttribute('title', correctionLabel);
        this.elements.correctionToggleLabel.textContent = correctionLabel;
        this.elements.retranslateDocument.setAttribute(
            'aria-label',
            this.t('ai.retranslateDocument')
        );
        this.elements.retranslateDocument.setAttribute(
            'title',
            this.t('ai.retranslateDocument')
        );
        this.elements.retranslateDocumentLabel.textContent = this.t(
            'ai.retranslateDocument'
        );
        const translationLabelKey = translationActionLabelKey(this.model);
        const translationLabel = this.model.translationStatus === 'loading'
            ? this.t(translationLabelKey, {
                stage: this.t(
                    `ai.translationStage.${this.model.translationStage || 'preparing'}`
                ),
            })
            : this.t(translationLabelKey);
        this.elements.translateDocument.setAttribute(
            'aria-label',
            translationLabel
        );
        this.elements.translateDocument.setAttribute('title', translationLabel);
        this.elements.translateDocumentLabel.textContent =
            this.model.translationStatus === 'loading'
                ? this.t('ai.cancelDocumentTranslationCompact')
                : translationLabel;
        this.elements.translationViewLabel.textContent = this.t(
            'ai.translationViewLabel'
        );
        for (const label of this.elements.translationViewLabels) {
            label.textContent = this.t(label.getAttribute('data-i18n'));
        }
        this.elements.translationLanguageOptions.setAttribute(
            'aria-label',
            this.t('ai.translationLanguages')
        );
        this.elements.previousTranslationFailure.setAttribute(
            'aria-label',
            this.t('ai.previousTranslationFailure')
        );
        this.elements.previousTranslationFailure.setAttribute(
            'title',
            this.t('ai.previousTranslationFailure')
        );
        this.elements.nextTranslationFailure.setAttribute(
            'aria-label',
            this.t('ai.nextTranslationFailure')
        );
        this.elements.nextTranslationFailure.setAttribute(
            'title',
            this.t('ai.nextTranslationFailure')
        );
        this.elements.correctionUndoMessage.textContent = this.t(
            'revision.deletedUndo'
        );
        this.elements.correctionUndoButton.textContent = this.t(
            'revision.undoDelete'
        );
        this.elements.correctionUndoButton.setAttribute(
            'aria-label',
            this.t('revision.undoDeleteLabel')
        );
        this.elements.correctionUndoButton.setAttribute(
            'title',
            this.t('revision.undoDeleteLabel')
        );
        this.elements.restoreCorrections.setAttribute(
            'aria-label',
            this.t('revision.restoreAll')
        );
        this.elements.restoreCorrections.setAttribute(
            'title',
            this.t('revision.restoreAll')
        );
        this.elements.restoreCorrectionsLabel.textContent = this.t(
            'revision.restoreAll'
        );
        this.elements.errorRetry.setAttribute(
            'aria-label',
            this.t('viewer.retryConversion')
        );
        this.elements.errorRetry.setAttribute(
            'title',
            this.t('viewer.retryConversion')
        );
        this.elements.errorRetry.querySelector('.message-action-label')
            .replaceChildren(this.t('viewer.retryConversion'));
        this.elements.errorSettings.textContent = this.t('viewer.openSettings');
        this.elements.errorSettings.setAttribute(
            'aria-label',
            this.t('viewer.openSettings')
        );
        this.elements.errorSettings.setAttribute(
            'title',
            this.t('viewer.openSettings')
        );
        this.elements.warningSettings.textContent = this.t('viewer.openSettings');
        this.elements.warningSettings.setAttribute(
            'aria-label',
            this.t('viewer.openSettings')
        );
        this.elements.warningSettings.setAttribute(
            'title',
            this.t('viewer.openSettings')
        );
        this.elements.readerFontSize.setAttribute(
            'aria-label',
            this.t('viewer.textSize')
        );
        this.elements.readerFontDecrease.setAttribute(
            'aria-label',
            this.t('viewer.textSizeDecrease')
        );
        this.elements.readerFontDecrease.setAttribute(
            'title',
            this.t('viewer.textSizeDecrease')
        );
        this.elements.readerFontIncrease.setAttribute(
            'aria-label',
            this.t('viewer.textSizeIncrease')
        );
        this.elements.readerFontIncrease.setAttribute(
            'title',
            this.t('viewer.textSizeIncrease')
        );
        this.elements.readerFontFamily.setAttribute(
            'aria-label',
            this.t('viewer.textFont')
        );
        this.elements.readerFontOptions.setAttribute(
            'aria-label',
            this.t('viewer.textFont')
        );
        for (const label of this.elements.readerFontOptions.querySelectorAll(
            '[data-i18n]'
        )) {
            const key = label.getAttribute('data-i18n');
            if (key) label.textContent = this.t(key);
        }
        this.setReaderFont(this.readerFont);
        this.setReaderFontSize(this.readerFontSize);
        this.elements.outline.setAttribute('aria-label', this.t('viewer.outline'));
        this.elements.outlineTitleLabel.textContent = this.t(
            'viewer.outlineTitle'
        );
        this.elements.outlineSegments.setAttribute(
            'aria-label',
            this.t('viewer.outlineSections')
        );
        for (const button of this.elements.outlineSegmentButtons) {
            const segment = button.getAttribute('data-outline-segment');
            button.textContent = this.t(
                segment === OUTLINE_SEGMENT_FIGURES
                    ? 'viewer.outlineFigures'
                    : 'viewer.outlineHeadings'
            );
        }
        this.renderOutlineList();
        this.elements.notes.setAttribute('aria-label', this.t('viewer.notes'));
        this.elements.notesTitleLabel.textContent = this.t('viewer.notesTitle');
        this.elements.notesList.querySelector('.markdown-notes-empty')
            ?.replaceChildren(this.t('viewer.notesEmpty'));
        this.syncSidePanelControlLabels('outline');
        this.syncSidePanelControlLabels('notes');
    }

    syncDocumentActions(model, loadingView) {
        const reparseAvailable = typeof model.onReparse === 'function';
        const saveAvailable = typeof model.onSaveSnapshot === 'function'
            && model.renderMode !== 'html';
        const exportAvailable = model.status === 'ready'
            && model.renderMode !== 'html'
            && typeof model.onExportMarkdown === 'function';
        const correctionAvailable = model.status === 'ready'
            && model.renderMode !== 'html'
            && Array.isArray(model.editableBlocks)
            && model.editableBlocks.length > 0
            && typeof model.onSetCorrectionMode === 'function'
            && typeof model.onCommitCorrection === 'function';
        const restoreAvailable = model.status === 'ready'
            && model.renderMode !== 'html'
            && model.hasCorrections
            && typeof model.onRestoreAllCorrections === 'function';
        const translationAvailable = model.status === 'ready'
            && model.renderMode !== 'html'
            && typeof model.onTranslateDocument === 'function';
        const citationGraphAvailable = model.status === 'ready'
            && typeof model.onOpenCitationGraph === 'function';
        const documentActionsAvailable = reparseAvailable
            || saveAvailable
            || exportAvailable
            || correctionAvailable
            || restoreAvailable
            || translationAvailable;
        const readerControlsAvailable = model.status === 'ready'
            || loadingView.preserveContent;
        const toolbarAvailable = documentActionsAvailable
            || readerControlsAvailable
            || citationGraphAvailable;
        const reparsing = loadingView.visible && loadingView.preserveContent;
        const activeElement = this.mount.activeElement;
        const readerControlHadFocus = Boolean(activeElement)
            && this.elements.readerControls.contains(activeElement);
        if (!readerControlsAvailable) {
            this.setReaderFontOptionsOpen(false);
            if (readerControlHadFocus) {
                if (toolbarAvailable && !this.documentActionBusy) {
                    this.elements.actionToggle.focus?.();
                }
                else {
                    activeElement.blur?.();
                }
            }
        }
        this.elements.editorActions.hidden = !toolbarAvailable;
        this.elements.reparse.hidden = !reparseAvailable;
        this.elements.saveSnapshot.hidden = !saveAvailable;
        this.elements.exportMarkdown.hidden = !exportAvailable;
        this.elements.correctionToggle.hidden = !correctionAvailable;
        this.elements.translationControls.hidden = !translationAvailable;
        this.elements.restoreCorrections.hidden = !restoreAvailable;
        this.elements.actionToggle.hidden = !documentActionsAvailable;
        this.elements.citationGraphButton.hidden = !citationGraphAvailable;
        this.elements.citationGraphButton.disabled = !citationGraphAvailable
            || Boolean(this.documentActionBusy);
        this.syncGitHubRepositories(model, citationGraphAvailable);
        this.elements.readerFontSize.hidden = !readerControlsAvailable;
        this.elements.readerFontFamily.hidden = !readerControlsAvailable;
        this.syncNavigationBack();
        this.elements.reparse.disabled = !reparseAvailable
            || loadingView.visible
            || Boolean(this.documentActionBusy);
        this.elements.saveSnapshot.disabled = !saveAvailable
            || loadingView.visible
            || Boolean(this.documentActionBusy);
        this.elements.exportMarkdown.disabled = !exportAvailable
            || loadingView.visible
            || Boolean(this.documentActionBusy);
        this.elements.correctionToggle.disabled = !correctionAvailable
            || loadingView.visible
            || Boolean(this.documentActionBusy);
        const translationReady = hasAvailableTranslation(model);
        const completeTranslationReady = hasCompleteTranslation(model);
        const translating = model.translationStatus === 'loading';
        const partial = model.translationStatus === 'partial'
            || translating && (model.translationFailedBlocks || []).length > 0;
        this.syncTranslatedViewLabel(model, translationReady);
        this.syncTranslationLanguageOptions(model, translationReady);
        this.elements.translationViewLabel.hidden = !translationReady;
        this.elements.translationView.hidden = !translationReady;
        this.elements.translationFailureNavigation.hidden = !partial;
        this.elements.translationSeparator.hidden = completeTranslationReady
            || translationReady
            && !partial
            && !translating;
        this.elements.translateDocument.hidden = completeTranslationReady
            || translationReady
            && !partial
            && !translating;
        this.elements.retranslateDocument.hidden = !translationReady;
        this.elements.retranslateDocument.disabled = !translationReady
            || translating
            || loadingView.visible
            || Boolean(this.documentActionBusy);
        this.elements.translateDocument.disabled = !translationAvailable
            || loadingView.visible
            || (Boolean(this.documentActionBusy)
                && model.translationStatus !== 'loading');
        const translationViewDisabled = !translationAvailable
            || !translationReady
            || loadingView.visible
            || Boolean(this.documentActionBusy);
        for (const button of this.elements.translationViewButtons) {
            button.disabled = translationViewDisabled;
        }
        if (translationViewDisabled) this.setTranslationLanguagesOpen(false);
        const translationView = translationReady
            ? model.translationView || 'original'
            : 'original';
        for (const button of this.elements.translationViewButtons) {
            const selected = button.getAttribute('data-translation-view')
                === translationView;
            button.setAttribute('aria-checked', String(selected));
            button.setAttribute('tabindex', selected ? '0' : '-1');
        }
        this.elements.translateDocument.setAttribute(
            'aria-busy',
            String(model.translationStatus === 'loading')
        );
        this.elements.translateDocument.classList.toggle(
            'is-translating',
            translating
        );
        this.elements.editorActions.classList.toggle(
            'is-translating',
            translating
        );
        if (translating) {
            this.elements.translationIdleIcon.setAttribute('hidden', 'hidden');
            this.elements.translationLoadingIcon.removeAttribute('hidden');
        }
        else {
            this.elements.translationIdleIcon.removeAttribute('hidden');
            this.elements.translationLoadingIcon.setAttribute('hidden', 'hidden');
        }
        this.syncTranslationStatus(model, {
            translating,
            partial,
            translationReady,
        });
        this.elements.restoreCorrections.disabled = !restoreAvailable
            || loadingView.visible
            || Boolean(this.documentActionBusy);
        this.elements.actionToggle.disabled = !documentActionsAvailable
            || Boolean(this.documentActionBusy);
        const readerTabIndex = readerControlsAvailable ? '0' : '-1';
        this.elements.readerFontDecrease.setAttribute(
            'tabindex',
            readerTabIndex
        );
        this.elements.readerFontIncrease.setAttribute(
            'tabindex',
            readerTabIndex
        );
        this.elements.readerFontTrigger.setAttribute(
            'tabindex',
            readerTabIndex
        );
        this.elements.reparse.setAttribute('aria-busy', String(reparsing));
        this.elements.reparse.classList.toggle('is-reparsing', reparsing);
        const saving = this.documentActionBusy === 'saveSnapshot';
        this.elements.saveSnapshot.setAttribute('aria-busy', String(saving));
        this.elements.saveSnapshot.classList.toggle('is-saving', saving);
        const exporting = this.documentActionBusy === 'exportMarkdown';
        this.elements.exportMarkdown.setAttribute(
            'aria-busy',
            String(exporting)
        );
        this.elements.exportMarkdown.classList.toggle(
            'is-exporting',
            exporting
        );
        if (!documentActionsAvailable) {
            this.documentActionsOpen = false;
        }
        this.syncDocumentActionMenuState(
            this.documentActionsOpen && documentActionsAvailable
        );
        this.syncErrorActions(model);
        this.syncWarningActions(model);
    }

    syncTranslatedViewLabel(model, translationReady) {
        const button = this.translatedViewButton();
        const labelElement = this.elements.translatedViewLabel;
        if (!button || !labelElement) return;
        const languageKey = translationReady
            ? translationLanguageMessageKey(model.translationTargetLanguage)
            : '';
        const language = languageKey ? this.t(languageKey) : '';
        const label = language || this.t('ai.translationView.translated');
        const description = language
            ? this.t('ai.translationView.translatedLanguage', { language })
            : label;
        labelElement.textContent = label;
        button.setAttribute('aria-label', description);
        button.setAttribute('title', description);
    }

    syncTranslationLanguageOptions(model, translationReady) {
        const button = this.translatedViewButton();
        if (!button) return;
        const completeLanguages = new Set(normalizedCachedTranslationLanguages(
            model.translationCachedLanguages
        ));
        if (hasVisibleCompleteTranslation(model)
            && isSupportedAITargetLanguage(model.translationTargetLanguage)) {
            completeLanguages.add(model.translationTargetLanguage);
        }
        const partialLanguages = new Set(normalizedCachedTranslationLanguages(
            model.translationPartialLanguages
        ));
        const translating = model.translationStatus === 'loading';
        const options = AI_TARGET_LANGUAGES.map(language => ({
            language,
            label: this.t(translationLanguageMessageKey(language)),
            status: translating
                && model.translationRequestedTargetLanguage === language
                ? 'translating'
                : completeLanguages.has(language)
                ? 'complete'
                : partialLanguages.has(language) ? 'partial' : 'missing',
            disabled: translating,
        }));
        const completeOptions = options.filter(option => (
            completeLanguages.has(option.language)
        ));
        const availableOptions = options.filter(option => (
            !completeLanguages.has(option.language)
        ));
        const groups = [{
            label: this.t('ai.translationLanguages.complete'),
            options: completeOptions,
        }, {
            label: this.t('ai.translationLanguages.available'),
            options: availableOptions,
        }].filter(group => group.options.length);
        const signature = JSON.stringify({ groups, translating });
        if (signature !== this.translationLanguageSignature) {
            const focused = this.mount.activeElement;
            const optionHadFocus = Boolean(focused)
                && this.elements.translationLanguageOptions.contains(focused);
            this.setTranslationLanguagesOpen(false);
            this.elements.translationLanguageOptions.replaceChildren(
                ...groups.map(group => (
                    this.createTranslationLanguageGroup(group)
                )),
                ...(translating ? [this.createTranslationCancelOption()] : [])
            );
            this.translationLanguageSignature = signature;
            if (optionHadFocus) button.focus?.();
        }
        const available = translationReady
            && completeOptions.length > 0
            && typeof model.onSelectTranslationLanguage === 'function';
        if (available) {
            button.setAttribute('aria-haspopup', 'menu');
            button.setAttribute(
                'aria-controls',
                'mktero-translation-language-options'
            );
            button.setAttribute(
                'aria-expanded',
                String(this.translationLanguagesOpen)
            );
        }
        else {
            this.setTranslationLanguagesOpen(false);
            button.removeAttribute('aria-haspopup');
            button.removeAttribute('aria-controls');
            button.removeAttribute('aria-expanded');
        }
        this.elements.translationLanguageChevron.hidden = !available;
        for (const option of this.translationLanguageOptionButtons()) {
            const selected = option.getAttribute('data-translation-language')
                === model.translationTargetLanguage;
            option.setAttribute('aria-checked', String(selected));
            option.classList.toggle('is-selected', selected);
            option.setAttribute(
                'tabindex',
                this.translationLanguagesOpen && selected ? '0' : '-1'
            );
        }
    }

    createTranslationLanguageGroup({ label, options }) {
        const group = this.createElement('div', {
            class: 'markdown-translation-language-group',
            role: 'group',
            'aria-label': label,
        });
        group.appendChild(this.createElement('span', {
            class: 'markdown-translation-language-group-label',
            'aria-hidden': 'true',
        }, label));
        appendChildren(
            group,
            ...options.map(option => this.createTranslationLanguageOption(option))
        );
        return group;
    }

    createTranslationLanguageOption({
        language,
        label,
        status,
        disabled,
    }) {
        const button = this.createElement('button', {
            class: 'markdown-translation-language-option',
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': 'false',
            'data-translation-language': language,
            'data-translation-status': status,
            tabindex: '-1',
        });
        const icon = status === 'complete'
            ? LUCIDE_ICONS.check
            : status === 'translating'
                ? LUCIDE_ICONS.loaderCircle
            : status === 'partial'
                ? LUCIDE_ICONS.refreshCw
                : LUCIDE_ICONS.languages;
        button.disabled = Boolean(disabled);
        appendChildren(
            button,
            createLucideIcon(
                this.document,
                icon,
                {
                    className: 'markdown-translation-language-option-check',
                    size: 14,
                }
            ),
            this.createElement('span', {
                class: 'markdown-translation-language-option-label',
            }, label)
        );
        return button;
    }

    createTranslationCancelOption() {
        const button = this.createElement('button', {
            id: 'mktero-cancel-translation-language',
            class: 'markdown-translation-language-option '
                + 'markdown-translation-language-cancel',
            type: 'button',
            role: 'menuitem',
            'data-translation-cancel': '',
            tabindex: '-1',
        });
        appendChildren(
            button,
            createLucideIcon(this.document, LUCIDE_ICONS.x, {
                className: 'markdown-translation-language-option-check',
                size: 14,
            }),
            this.createElement('span', {
                class: 'markdown-translation-language-option-label',
            }, this.t('ai.cancelDocumentTranslationCompact'))
        );
        return button;
    }

    syncTranslationStatus(model, {
        translating,
        partial,
        translationReady,
    }) {
        const completed = Math.max(
            0,
            Number(model.translationCompletedBlocks) || 0
        );
        const total = Math.max(
            completed,
            Number(model.translationTotalBlocks) || 0
        );
        const failed = (model.translationFailedBlocks || []).length;
        let status = '';
        if (translating) {
            const requestedLanguageKey = translationLanguageMessageKey(
                model.translationRequestedTargetLanguage
            );
            const requestedLanguage = requestedLanguageKey
                ? this.t(requestedLanguageKey)
                : '';
            status = requestedLanguage
                ? this.t(translationReady
                    ? 'ai.translationGeneratingLanguage'
                    : 'ai.translationProgressLanguage', {
                    completed,
                    total,
                    progress: Math.max(
                        0,
                        Math.min(100, Number(model.translationProgress) || 0)
                    ),
                    language: requestedLanguage,
                })
                : total
                    ? this.t('ai.translationProgress', {
                        completed,
                        total,
                        progress: Math.max(
                            0,
                            Math.min(
                                100,
                                Number(model.translationProgress) || 0
                            )
                        ),
                    })
                : this.t(
                    `ai.translationStage.${model.translationStage
                        || 'preparing'}`
                );
        }
        else if (partial) {
            status = this.t('ai.translationPartialCompact', { failed });
        }
        this.elements.translationStatus.textContent = status;
        this.elements.translationStatus.hidden = !status;
        this.elements.previousTranslationFailure.disabled = !partial
            || !translationReady;
        this.elements.nextTranslationFailure.disabled = !partial
            || !translationReady;
        this.syncTranslationFailurePosition();
    }

    syncTranslationFailurePosition() {
        const failures = visibleTranslationFailureRanges(this.model);
        if (!failures.length) {
            this.activeTranslationFailureID = null;
            this.elements.translationFailurePosition.textContent = '';
            this.elements.translationFailurePosition.removeAttribute('aria-label');
            return;
        }
        let index = failures.findIndex(failure => failure.id
            === this.activeTranslationFailureID);
        if (index < 0) {
            index = failures.findLastIndex(failure => (
                failure.from <= this.activeNavigationOffset
            ));
            if (index < 0) index = 0;
            this.activeTranslationFailureID = failures[index].id;
        }
        const current = index + 1;
        const total = failures.length;
        this.elements.translationFailurePosition.textContent = `${current}/${total}`;
        this.elements.translationFailurePosition.setAttribute(
            'aria-label',
            this.t('ai.translationFailurePosition', { current, total })
        );
    }

    syncErrorActions(model) {
        const errorVisible = model.status === 'error';
        const retryAvailable = errorVisible
            && typeof model.onReparse === 'function';
        const settingsAvailable = errorVisible
            && model.errorAction === 'open-settings'
            && typeof model.onOpenSettings === 'function';
        this.elements.errorRetry.hidden = !retryAvailable;
        this.elements.errorSettings.hidden = !settingsAvailable;
        this.elements.errorRetry.disabled = !retryAvailable
            || Boolean(this.documentActionBusy);
        this.elements.errorSettings.disabled = !settingsAvailable
            || Boolean(this.documentActionBusy);
    }

    syncWarningActions(model) {
        const settingsAvailable = model.status === 'ready'
            && model.warningAction === 'open-settings'
            && typeof model.onOpenSettings === 'function';
        this.elements.warningSettings.hidden = !settingsAvailable;
        this.elements.warningSettings.disabled = !settingsAvailable
            || Boolean(this.documentActionBusy);
    }

    syncWarningToast(warnings, { persistent = false } = {}) {
        const message = Array.isArray(warnings)
            ? warnings.filter(Boolean).join(' ')
            : '';
        if (!message) {
            this.clearWarningToast();
            return;
        }
        const signature = `${persistent ? 'persistent' : 'transient'}:${message}`;
        if (signature === this.warningToastSignature) return;

        this.clearWarningToast();
        this.warningToastSignature = signature;
        this.elements.warningMessage.textContent = message;
        this.elements.warning.hidden = false;
        if (persistent) return;
        if (typeof this.ownerWindow.setTimeout !== 'function') return;
        this.warningToastTimer = this.ownerWindow.setTimeout(() => {
            if (this.warningToastSignature !== signature) return;
            this.warningToastTimer = null;
            this.elements.warning.hidden = true;
        }, WARNING_TOAST_TIMEOUT_MS);
    }

    syncReparseAction(model, loadingView) {
        this.syncDocumentActions(model, loadingView);
    }

    syncCorrectionBanner(model, loadingView) {
        const visible = !loadingView.visible
            && model.status === 'ready'
            && model.renderMode !== 'html'
            && model.correctionMode;
        this.elements.correctionBanner.hidden = !visible;
        this.elements.editorSection.setAttribute(
            'aria-label',
            this.t(model.correctionMode ? 'revision.start' : 'viewer.readOnly')
        );
        if (!visible) {
            this.elements.correctionBanner.textContent = '';
            return;
        }
        this.elements.correctionBanner.textContent = this.t(
            'revision.bannerActive',
            { count: model.correctionCount || 0 }
        );
    }

    setDocumentActionsOpen(open) {
        this.documentActionsOpen = Boolean(open);
        const available = !this.elements.actionToggle.hidden;
        this.syncDocumentActionMenuState(this.documentActionsOpen && available);
        if (this.documentActionsOpen) this.setGitHubReposOpen(false);
    }

    syncGitHubRepositories(model, citationGraphAvailable) {
        const repositories = model.status === 'ready'
            ? findGitHubRepositories(model.markdown)
            : [];
        this.githubRepositories = repositories;
        const available = repositories.length > 0;
        this.elements.githubReposButton.hidden = !available;
        this.elements.githubReposButton.classList.toggle(
            'markdown-github-repos-button--raised',
            available && citationGraphAvailable
        );
        this.elements.githubReposMenu.classList.toggle(
            'markdown-github-repos-menu--raised',
            available && citationGraphAvailable
        );
        if (!available) this.setGitHubReposOpen(false);
        if (this.githubReposOpen) this.renderGitHubReposMenu();
    }

    setGitHubReposOpen(open) {
        const available = !this.elements.githubReposButton.hidden
            && this.githubRepositories.length > 0;
        this.githubReposOpen = Boolean(open) && available;
        this.elements.githubReposButton.setAttribute(
            'aria-expanded',
            String(this.githubReposOpen)
        );
        this.elements.githubReposMenu.hidden = !this.githubReposOpen;
        if (this.githubReposOpen) {
            this.documentActionsOpen = false;
            this.syncDocumentActionMenuState(false);
            this.setReaderFontOptionsOpen(false);
            this.setTranslationLanguagesOpen(false);
            this.renderGitHubReposMenu();
        }
    }

    renderGitHubReposMenu() {
        const menu = this.elements.githubReposMenu;
        while (menu.firstChild) menu.removeChild(menu.firstChild);
        for (const repository of this.githubRepositories) {
            const item = this.createElement('button', {
                class: 'markdown-github-repos-item',
                type: 'button',
                role: 'menuitem',
                'data-github-href': repository.href,
                'aria-label': this.t('link.githubRepository', {
                    label: repository.label,
                }),
            }, repository.label);
            menu.appendChild(item);
        }
    }

    syncDocumentActionMenuState(visible) {
        if (!visible) this.setReaderFontOptionsOpen(false);
        this.elements.actionToggle.setAttribute(
            'aria-expanded',
            String(visible)
        );
        this.elements.actionMenu.setAttribute('aria-hidden', String(!visible));
        const menuTabIndex = visible ? '0' : '-1';
        this.elements.reparse.setAttribute('tabindex', menuTabIndex);
        this.elements.saveSnapshot.setAttribute('tabindex', menuTabIndex);
        this.elements.exportMarkdown.setAttribute('tabindex', menuTabIndex);
        this.elements.correctionToggle.setAttribute('tabindex', menuTabIndex);
        this.elements.retranslateDocument.setAttribute(
            'tabindex',
            menuTabIndex
        );
        this.elements.restoreCorrections.setAttribute(
            'tabindex',
            menuTabIndex
        );
        this.elements.editorActions.classList.toggle('is-open', visible);
    }

    syncSidePanelControlLabels(name) {
        const panel = this.sidePanels[name];
        const { resizer, toggle } = this.sidePanelElements(name);
        const resizeLabel = this.t(panel.visible
            ? panel.resizeLabelKey
            : panel.expandLabelKey);
        resizer.setAttribute('aria-label', resizeLabel);
        resizer.setAttribute('title', resizeLabel);
        const toggleLabel = this.t(panel.visible
            ? panel.collapseLabelKey
            : panel.expandLabelKey);
        toggle.setAttribute('aria-label', toggleLabel);
        toggle.setAttribute('title', toggleLabel);
    }

    startSidePanelResize(name, event) {
        const panel = this.sidePanels[name];
        if (event.button !== 0
            || !panel.visible
            || this.elements.workspace.hidden) {
            return;
        }
        panel.resize = {
            pointerStartX: event.clientX,
            pointerStartY: Number.isFinite(event.clientY)
                ? event.clientY
                : null,
            widthAtStart: panel.width,
            active: false,
        };
    }

    resizeSidePanel(name, event) {
        const panel = this.sidePanels[name];
        if (!panel.resize || !Number.isFinite(event.clientX)) return;
        if (Number.isFinite(event.buttons) && event.buttons !== 1) {
            this.cancelSidePanelResize(name);
            return;
        }
        if (panel.resize.pointerStartY !== null
            && !Number.isFinite(event.clientY)) {
            this.cancelSidePanelResize(name);
            return;
        }
        const deltaX = event.clientX - panel.resize.pointerStartX;
        const deltaY = panel.resize.pointerStartY === null
            || !Number.isFinite(event.clientY)
            ? 0
            : event.clientY - panel.resize.pointerStartY;
        const horizontalDistance = Math.abs(deltaX);
        const verticalDistance = Math.abs(deltaY);
        if (panel.resize.pointerStartY !== null
            && horizontalDistance <= verticalDistance) {
            if (panel.resize.active) {
                this.setSidePanelWidth(name, panel.resize.widthAtStart);
            }
            this.finishSidePanelResize(name);
            return;
        }
        if (!panel.resize.active) {
            if (Math.max(horizontalDistance, verticalDistance)
                < SIDE_PANEL_RESIZE_ACTIVATION_DISTANCE) {
                return;
            }
            panel.resize.active = true;
            event.preventDefault();
            this.elements.workspace.classList.add(panel.resizeClass);
        }
        this.setSidePanelWidth(
            name,
            panel.resize.widthAtStart
                + panel.resizeDirection
                * (event.clientX - panel.resize.pointerStartX)
        );
    }

    finishSidePanelResize(name) {
        const panel = this.sidePanels[name];
        if (!panel.resize) return;
        panel.resize = null;
        this.elements.workspace.classList.remove(panel.resizeClass);
    }

    cancelSidePanelResize(name) {
        const panel = this.sidePanels[name];
        if (panel.resize?.active) {
            this.setSidePanelWidth(name, panel.resize.widthAtStart);
        }
        this.finishSidePanelResize(name);
    }

    setSidePanelWidth(name, width) {
        const panel = this.sidePanels[name];
        const { element, resizer } = this.sidePanelElements(name);
        const nextWidth = Math.min(
            panel.maxWidth,
            Math.max(panel.minWidth, Math.round(width))
        );
        panel.width = nextWidth;
        element.style.setProperty(
            panel.widthProperty,
            `${nextWidth}px`
        );
        resizer.setAttribute('aria-valuenow', String(nextWidth));
    }

    setSidePanelVisibility(name, visible, { source = 'user' } = {}) {
        const panel = this.sidePanels[name];
        const { element, resizer, toggle } = this.sidePanelElements(name);
        this.finishSidePanelResize(name);
        if (source === 'user') {
            const responsive = this.responsivePanels[name];
            responsive.autoCollapsed = false;
            const breakpoint = RESPONSIVE_SIDE_PANEL_BREAKPOINTS[name];
            const containerWidth = this.responsiveSidePanelWidth();
            responsive.userOverride = Number.isFinite(breakpoint)
                && containerWidth <= breakpoint;
        }
        panel.visible = visible;
        element.hidden = !visible;
        resizer.classList.toggle(
            panel.collapsedClass,
            !visible
        );
        toggle.replaceChildren(this.createSidePanelIcon(
            visible ? panel.collapseIcon : panel.expandIcon
        ));
        toggle.setAttribute('aria-expanded', String(visible));
        this.syncSidePanelControlLabels(name);
    }

    syncResponsiveSidePanels(measuredWidth = null) {
        const containerWidth = this.responsiveSidePanelWidth(measuredWidth);
        if (!Number.isFinite(containerWidth)) return;

        for (const name of Object.keys(RESPONSIVE_SIDE_PANEL_BREAKPOINTS)) {
            const panel = this.sidePanels[name];
            const responsive = this.responsivePanels[name];
            const shouldCollapse = containerWidth
                <= RESPONSIVE_SIDE_PANEL_BREAKPOINTS[name];
            if (!shouldCollapse) {
                const restorePanel = responsive.autoCollapsed
                    && !panel.visible;
                responsive.autoCollapsed = false;
                responsive.userOverride = false;
                if (restorePanel) {
                    this.setSidePanelVisibility(name, true, {
                        source: 'responsive',
                    });
                }
                continue;
            }
            if (responsive.userOverride || responsive.autoCollapsed) continue;
            if (!panel.visible) continue;
            responsive.autoCollapsed = true;
            this.setSidePanelVisibility(name, false, {
                source: 'responsive',
            });
        }
    }

    responsiveSidePanelWidth(measuredWidth = null) {
        const candidates = [
            measuredWidth,
            this.host.getBoundingClientRect?.()?.width,
            this.host.clientWidth,
            this.elements.workspace.getBoundingClientRect?.()?.width,
            this.elements.workspace.clientWidth,
            this.ownerWindow.innerWidth,
        ];
        return candidates
            .map(value => Number(value))
            .find(value => Number.isFinite(value) && value > 0);
    }

    handleSidePanelResizeKey(name, event) {
        const panel = this.sidePanels[name];
        if (['Enter', ' '].includes(event.key)) {
            event.preventDefault();
            this.setSidePanelVisibility(name, !panel.visible, {
                source: 'user',
            });
            return;
        }
        if (!panel.visible) return;
        const widths = {
            ArrowLeft: panel.width
                - panel.resizeDirection * SIDE_PANEL_KEYBOARD_STEP,
            ArrowRight: panel.width
                + panel.resizeDirection * SIDE_PANEL_KEYBOARD_STEP,
            Home: panel.minWidth,
            End: panel.maxWidth,
        };
        if (!(event.key in widths)) return;
        event.preventDefault();
        this.setSidePanelWidth(name, widths[event.key]);
    }

    sidePanelElements(name) {
        const panel = this.sidePanels[name];
        return {
            element: this.elements[panel.elementKey],
            resizer: this.elements[panel.resizerKey],
            toggle: this.elements[panel.toggleKey],
        };
    }

    createSidePanelIcon(icon) {
        return createLucideIcon(this.document, icon, {
            className: 'markdown-side-panel-toggle-icon',
            size: 18,
        });
    }

    syncOutline(
        markdown,
        sourceRanges = null,
        chromeRanges = [],
        pdfOutline = []
    ) {
        this.outlineMarkdown = String(markdown || '');
        this.outlineSourceRanges = sourceRanges;
        this.outlineChromeRanges = Array.isArray(chromeRanges)
            ? chromeRanges
            : [];
        this.outlinePdfOutline = Array.isArray(pdfOutline) ? pdfOutline : [];
        this.renderOutlineList();
    }

    setOutlineSegment(segment) {
        if (segment !== OUTLINE_SEGMENT_HEADINGS
            && segment !== OUTLINE_SEGMENT_FIGURES) {
            return;
        }
        if (this.outlineSegment === segment) return;
        this.outlineSegment = segment;
        this.syncOutlineSegmentButtons();
        this.renderOutlineList();
    }

    syncOutlineSegmentButtons() {
        const selectedID = `mktero-outline-segment-${this.outlineSegment}`;
        for (const button of this.elements.outlineSegmentButtons) {
            const selected = button.getAttribute('data-outline-segment')
                === this.outlineSegment;
            button.setAttribute('aria-selected', selected ? 'true' : 'false');
        }
        this.elements.outlineList.setAttribute('aria-labelledby', selectedID);
    }

    renderOutlineList() {
        const list = this.elements.outlineList;
        list.replaceChildren();
        const items = this.outlineSegment === OUTLINE_SEGMENT_FIGURES
            ? this.outlineAssetItems()
            : this.outlineHeadingItems();
        if (!items.length) {
            list.appendChild(this.createElement(
                'li',
                { class: 'markdown-outline-empty' },
                this.outlineEmptyMessage()
            ));
            this.syncActiveNavigation(this.activeNavigationOffset);
            return;
        }
        for (const item of items) {
            const button = this.createOutlineItemButton(item);
            const listItem = this.createElement('li', {
                class: 'markdown-outline-item',
            });
            listItem.appendChild(button);
            list.appendChild(listItem);
        }
        this.syncActiveNavigation(this.activeNavigationOffset);
    }

    outlineEmptyMessage() {
        return this.outlineSegment === OUTLINE_SEGMENT_FIGURES
            ? this.t('viewer.outlineFiguresEmpty')
            : this.t('viewer.outlineEmpty');
    }

    outlineHeadingItems() {
        return extractAlignedMarkdownOutline(
            this.outlineMarkdown,
            this.outlineChromeRanges,
            this.outlinePdfOutline
        ).map(heading => ({
            text: heading.text,
            offset: mapSourceOffsetToComparison(
                heading.offset,
                this.outlineSourceRanges
            ),
            level: heading.level,
        }));
    }

    outlineAssetItems() {
        return extractMarkdownAssetOutline(
            this.outlineMarkdown,
            this.outlineChromeRanges
        ).map(asset => ({
            text: asset.text,
            offset: mapSourceOffsetToComparison(
                asset.offset,
                this.outlineSourceRanges
            ),
            type: asset.type,
            imageSource: asset.imageSource || '',
            tablePreviewSource: asset.tablePreviewSource || '',
        }));
    }

    createOutlineItemButton(item) {
        const button = this.createElement(
            'button',
            this.outlineItemAttributes(item)
        );
        if (!item.type) {
            button.textContent = item.text;
            return button;
        }
        const tableThumb = this.createOutlineTableThumb(item);
        if (tableThumb) button.appendChild(tableThumb);
        const thumbURL = this.outlineThumbURL(item);
        if (thumbURL) {
            button.appendChild(this.createElement('img', {
                class: 'markdown-outline-thumb',
                src: thumbURL,
                alt: '',
                draggable: 'false',
            }));
        }
        button.appendChild(this.createElement(
            'span',
            { class: 'markdown-outline-caption' },
            item.text
        ));
        return button;
    }

    createOutlineTableThumb(item) {
        if (item.type !== 'table' || !item.tablePreviewSource) return null;
        const thumb = this.createElement('div', {
            class: 'markdown-outline-thumb markdown-outline-table-thumb',
        });
        appendRenderedMarkdown(
            thumb,
            item.tablePreviewSource,
            source => this.resolveImageURL(source),
            false,
            this.t
        );
        return thumb;
    }

    outlineThumbURL(item) {
        if (item.type !== 'figure' || !item.imageSource) return null;
        return this.resolveImageURL(item.imageSource);
    }

    outlineItemAttributes(item) {
        const attributes = {
            class: 'markdown-outline-link',
            type: 'button',
            'data-offset': String(item.offset),
            title: item.text,
        };
        if (item.level) {
            attributes['data-level'] = String(item.level);
            attributes.style = `--outline-indent: ${(item.level - 1) * 12}px;`;
        }
        if (item.type) {
            attributes['data-asset-type'] = item.type;
        }
        return attributes;
    }

    syncNotes(annotationOverlay, markdownLength) {
        const list = this.elements.notesList;
        list.replaceChildren();
        const entries = orderedAnnotationEntries(annotationOverlay);
        if (!entries.length) {
            list.appendChild(this.createElement(
                'li',
                { class: 'markdown-notes-empty' },
                this.t('viewer.notesEmpty')
            ));
            this.syncActiveNavigation(this.activeNavigationOffset);
            return;
        }

        for (const { annotation, matched } of entries) {
            list.appendChild(this.createNoteItem(
                annotation,
                matched,
                markdownLength
            ));
        }
        this.syncActiveNavigation(this.activeNavigationOffset);
    }

    syncActiveNavigation(offset = 0) {
        const requestedOffset = Number(offset);
        this.activeNavigationOffset = Number.isFinite(requestedOffset)
            ? Math.max(0, Math.trunc(requestedOffset))
            : 0;
        if (this.elements?.translationFailurePosition) {
            this.activeTranslationFailureID = null;
            this.syncTranslationFailurePosition();
        }
        const activeOutline = findActiveNavigationItem(
            [...this.elements.outlineList.querySelectorAll(
                '.markdown-outline-link[data-offset]'
            )],
            this.activeNavigationOffset
        );
        for (const link of this.elements.outlineList.querySelectorAll(
            '.markdown-outline-link'
        )) {
            const active = link === activeOutline;
            link.classList.toggle('is-active', active);
            if (active) link.setAttribute('aria-current', 'location');
            else link.removeAttribute('aria-current');
        }

        const activeNote = findActiveNavigationItem(
            [...this.elements.notesList.querySelectorAll(
                '.markdown-note-link[data-offset]'
            )],
            this.activeNavigationOffset
        );
        for (const link of this.elements.notesList.querySelectorAll(
            '.markdown-note-link'
        )) {
            const active = link === activeNote;
            link.classList.toggle('is-active', active);
            if (active) link.setAttribute('aria-current', 'location');
            else link.removeAttribute('aria-current');
        }
    }

    restoreReadingPosition(offset) {
        const requestedOffset = Number(offset);
        if (!Number.isFinite(requestedOffset)) return;
        const normalizedOffset = Math.max(0, Math.trunc(requestedOffset));
        this.syncActiveNavigation(normalizedOffset);
        this.editor.scrollToOffset?.(normalizedOffset);
    }

    createNoteItem(annotation, matched, markdownLength) {
        const offset = matched
            ? firstAnnotationOffset(annotation, markdownLength)
            : null;
        const button = this.createElement(
            'button',
            this.noteButtonAttributes(annotation, offset)
        );
        button.appendChild(this.createNoteMetadata(annotation, offset !== null));
        button.appendChild(this.createElement(
            'span',
            { class: 'markdown-note-quote' },
            String(annotation.text || '')
        ));
        if (annotation.comment) {
            button.appendChild(this.createElement(
                'span',
                { class: 'markdown-note-comment' },
                String(annotation.comment)
            ));
        }
        const item = this.createElement('li', {
            class: 'markdown-note-item',
        });
        item.appendChild(button);
        if (!isMarkdownAnnotation(annotation)
            && typeof this.model.onOpenAnnotationInPDF === 'function') {
            const openPDF = this.createElement('button', {
                class: 'markdown-note-open-pdf',
                type: 'button',
                'data-annotation-id': String(annotation.id || ''),
                'aria-label': this.t('annotation.openInPDF'),
                title: this.t('annotation.openInPDF'),
            });
            openPDF.appendChild(createLucideIcon(
                this.document,
                LUCIDE_ICONS.externalLink,
                { className: 'markdown-note-open-pdf-icon', size: 15 }
            ));
            item.appendChild(openPDF);
        }
        else if (annotation.synchronization?.status === 'failed') {
            const retry = this.createElement('button', {
                class: 'markdown-note-sync-retry',
                type: 'button',
                'data-annotation-id': String(annotation.id || ''),
                'aria-label': this.t('annotation.retrySync'),
                title: this.t('annotation.retrySync'),
            });
            retry.appendChild(createLucideIcon(
                this.document,
                LUCIDE_ICONS.refreshCw,
                { className: 'markdown-note-sync-retry-icon', size: 15 }
            ));
            item.appendChild(retry);
        }
        return item;
    }

    noteButtonAttributes(annotation, offset) {
        const canJump = offset !== null;
        const attributes = {
            class: canJump
                ? 'markdown-note-link'
                : 'markdown-note-link is-note-unavailable',
            type: 'button',
            'data-annotation-id': String(annotation.id || ''),
            style: `--mktero-annotation-color: ${safeAnnotationColor(
                annotation.color
            )};`,
        };
        if (!canJump) {
            attributes.disabled = 'disabled';
            return attributes;
        }
        attributes['data-offset'] = String(offset);
        attributes['aria-label'] = this.t('viewer.noteJump', {
            text: accessibleAnnotationText(
                annotation.comment || annotation.text
            ),
        });
        return attributes;
    }

    createNoteMetadata(annotation, canJump) {
        const metadata = this.createElement('span', {
            class: 'markdown-note-metadata',
        });
        metadata.appendChild(this.createElement('span', {
            class: 'markdown-note-color',
            style: `--mktero-annotation-color: ${safeAnnotationColor(
                annotation.color
            )};`,
            'aria-hidden': 'true',
        }));
        const pageLabel = annotationPageLabel(annotation);
        if (pageLabel) {
            metadata.appendChild(this.createElement(
                'span',
                { class: 'markdown-note-page' },
                this.t('annotation.page', { page: pageLabel })
            ));
        }
        if (!canJump) {
            metadata.appendChild(this.createElement(
                'span',
                { class: 'markdown-note-unavailable' },
                this.t(annotationUnavailableLabelKey(annotation))
            ));
        }
        const synchronization = this.createNoteSynchronization(annotation);
        if (synchronization) metadata.appendChild(synchronization);
        return metadata;
    }

    createNoteSynchronization(annotation) {
        const status = annotation.synchronization?.status;
        if (status !== 'pending' && status !== 'failed') return null;
        const failed = status === 'failed';
        const label = failed
            ? this.t(synchronizationFailureLabelKey(
                annotation.synchronization?.reason
            ))
            : this.t('annotation.syncPending');
        const element = this.createElement('span', {
            class: `markdown-note-sync markdown-note-sync--${status}`,
            title: label,
        });
        element.appendChild(createLucideIcon(
            this.document,
            failed ? LUCIDE_ICONS.triangleAlert : LUCIDE_ICONS.clock,
            { className: 'markdown-note-sync-icon', size: 13 }
        ));
        element.appendChild(this.createElement(
            'span',
            { class: 'markdown-note-sync-label' },
            label
        ));
        return element;
    }

    async retryMarkdownAnnotationSynchronization(annotationID) {
        if (typeof this.model.onRetryMarkdownAnnotationSynchronization
            !== 'function') {
            throw new Error('Markdown annotation synchronization is unavailable');
        }
        const retried = await this.model
            .onRetryMarkdownAnnotationSynchronization(annotationID);
        const current = findOverlayAnnotation(
            this.model.annotationOverlay,
            annotationID
        );
        if (!isMarkdownAnnotation(current)) return retried;
        this.replaceVisibleAnnotation(annotationID, {
            ...current,
            synchronization: { status: 'pending' },
        });
        return retried;
    }

    openLink(href) {
        if (href.startsWith('#')) {
            this.scrollToFragment(href.slice(1));
            return;
        }
        if (this.zotero?.launchURL) {
            this.zotero.launchURL(href);
        }
    }

    scrollToFragment(fragment) {
        if (!fragment) return;
        let id;
        try {
            id = decodeURIComponent(fragment);
        }
        catch {
            id = fragment;
        }
        const element = this.mount.getElementById?.(id);
        if (element) {
            element.scrollIntoView?.();
            return;
        }
        const normalizedID = id.toLowerCase();
        const snapshotElement = [...(
            this.elements.snapshotHost.querySelectorAll?.('[id]') || []
        )].find(element => (
            element.getAttribute('id')?.toLowerCase() === normalizedID
        ));
        if (snapshotElement) {
            snapshotElement.scrollIntoView?.();
            return;
        }
        const offset = this.fragmentIndex.has(id)
            ? this.fragmentIndex.get(id)
            : this.fragmentIndex.get(normalizedID);
        if (!Number.isFinite(offset)) return;
        this.restoreReadingPosition(offset);
    }

    syncAssetURLs() {
        if (this.renderedAssets === this.model.assets) return false;
        this.revokeAssetURLs();
        this.renderedAssets = this.model.assets;
        const URLAPI = this.ownerWindow.URL || globalThis.URL;
        const BlobType = this.ownerWindow.Blob || globalThis.Blob;
        for (const asset of this.model.assets || []) {
            if (!asset?.path || !asset?.mimeType || !asset?.data) continue;
            const path = normalizeZipPath(asset.path);
            const url = URLAPI.createObjectURL(new BlobType(
                [asset.data],
                { type: asset.mimeType }
            ));
            this.assetURLs.set(path, url);
        }
        return true;
    }

    revokeAssetURLs() {
        const URLAPI = this.ownerWindow.URL || globalThis.URL;
        for (const url of this.assetURLs.values()) URLAPI.revokeObjectURL(url);
        this.assetURLs = new Map();
        this.renderedAssets = undefined;
    }

    syncSnapshot() {
        const elements = this.elements;
        if (this.renderedSnapshotHTML === this.model.snapshotHTML
            && this.renderedSnapshotAssets === this.model.snapshotAssets) {
            return;
        }
        this.revokeSnapshotURLs();
        this.renderedSnapshotHTML = this.model.snapshotHTML || '';
        this.renderedSnapshotAssets = this.model.snapshotAssets;
        const URLAPI = this.ownerWindow.URL || globalThis.URL;
        const BlobType = this.ownerWindow.Blob || globalThis.Blob;
        for (const asset of this.model.snapshotAssets || []) {
            if (!asset?.attachmentKey || !asset?.mimeType || !asset?.data) continue;
            const url = URLAPI.createObjectURL(new BlobType(
                [asset.data],
                { type: asset.mimeType }
            ));
            this.snapshotURLs.set(String(asset.attachmentKey), url);
        }
        const template = this.createElement('template');
        template.innerHTML = this.model.snapshotHTML || '';
        sanitizeSnapshotFragment(template.content, this.snapshotURLs);
        elements.snapshotHost.replaceChildren(...template.content.childNodes);
        enhanceRenderedCodeBlocks(elements.snapshotHost, this.document, {
            copyCode: typeof this.model?.onCopyCode === 'function'
                ? code => this.copyCode(code)
                : null,
            translate: this.t,
        });
        this.syncSnapshotFragmentTargets();
    }

    syncSnapshotFragmentTargets() {
        const headings = [...this.elements.snapshotHost.querySelectorAll(
            'h1, h2, h3, h4, h5, h6'
        )];
        const usedIDs = new Set(
            [...this.elements.snapshotHost.querySelectorAll('[id]')]
                .map(element => element.getAttribute('id'))
                .filter(Boolean)
        );
        let fragmentIndex = 0;
        for (const heading of headings) {
            if (!heading.textContent?.trim()) continue;
            if (heading.getAttribute('id')) {
                fragmentIndex++;
                continue;
            }
            heading.setAttribute(
                'id',
                createMarkdownFragmentID(
                    heading.textContent,
                    fragmentIndex,
                    usedIDs
                )
            );
            fragmentIndex++;
        }
    }

    revokeSnapshotURLs() {
        const URLAPI = this.ownerWindow.URL || globalThis.URL;
        for (const url of this.snapshotURLs.values()) URLAPI.revokeObjectURL(url);
        this.snapshotURLs = new Map();
        this.renderedSnapshotHTML = undefined;
        this.renderedSnapshotAssets = undefined;
    }

    resolveImageURL(source) {
        const path = String(source || '').split(/[?#]/, 1)[0];
        if (!path || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('/')) {
            return null;
        }
        let decodedPath;
        try {
            decodedPath = decodeURIComponent(path);
        }
        catch {
            return null;
        }
        return this.assetURLs.get(
            resolveZipPath(this.model.assetBasePath || '', decodedPath)
        ) || null;
    }
}

function findActiveNavigationItem(elements, offset) {
    let active = null;
    let activeOffset = -1;
    for (const element of elements) {
        const itemOffset = Number(element.getAttribute('data-offset'));
        if (!Number.isFinite(itemOffset)
            || itemOffset > offset
            || itemOffset < activeOffset) {
            continue;
        }
        active = element;
        activeOffset = itemOffset;
    }
    return active;
}

function mapSourceOffsetToComparison(offset, sourceRanges) {
    if (!Array.isArray(sourceRanges)) return offset;
    const range = sourceRanges.find(candidate => (
        Number.isSafeInteger(candidate?.sourceFrom)
        && Number.isSafeInteger(candidate?.sourceTo)
        && Number.isSafeInteger(candidate?.comparisonFrom)
        && offset >= candidate.sourceFrom
        && offset <= candidate.sourceTo
    ));
    return range
        ? range.comparisonFrom + offset - range.sourceFrom
        : offset;
}

function translationViewName(translatedView, comparisonView) {
    if (comparisonView) return 'compare';
    return translatedView ? 'translated' : 'original';
}

function createVisibleTranslationFailures(
    model,
    translatedView,
    comparisonView
) {
    if (!translatedView && !comparisonView) return [];
    const view = translatedView ? 'translated' : 'compare';
    return translationFailureRangesForView(model, view);
}

function createVisibleTranslationPairs(model, translatedView, comparisonView) {
    const translatableIDs = new Set(
        (model.translationBlocks || []).map(translation => translation.id)
    );
    const failedIDs = new Set(
        (model.translationFailedBlocks || []).map(failure => failure.id)
    );
    return (model.translationBlockRanges || []).flatMap(range => {
        const failed = failedIDs.has(range?.id);
        if (!translatedView && !comparisonView && !failed) return [];
        const sourceFrom = comparisonView
            ? range?.comparisonSourceFrom
            : !translatedView
                ? range?.sourceFrom
                : null;
        const sourceTo = comparisonView
            ? range?.comparisonSourceTo
            : !translatedView
                ? range?.sourceTo
                : null;
        const translatedFrom = translatedView
            ? range?.translatedFrom
            : comparisonView
                ? range?.comparisonTranslationFrom
                : null;
        const translatedTo = translatedView
            ? range?.translatedTo
            : comparisonView
                ? range?.comparisonTranslationTo
                : null;
        const validSource = Number.isSafeInteger(sourceFrom)
            && Number.isSafeInteger(sourceTo)
            && sourceTo > sourceFrom;
        const validTranslation = Number.isSafeInteger(translatedFrom)
            && Number.isSafeInteger(translatedTo)
            && translatedTo > translatedFrom;
        if (!range?.id
            || !translatableIDs.has(range.id)
            || !validSource && !validTranslation) {
            return [];
        }
        return [{
            id: range.id,
            ...(validSource ? { sourceFrom, sourceTo } : {}),
            ...(validTranslation ? { translatedFrom, translatedTo } : {}),
        }];
    });
}

function mapAnnotationOverlayToComparison(overlay, blockRanges) {
    const source = overlay || createEmptyAnnotationOverlay();
    return {
        matched: (source.matched || []).flatMap(annotation => {
            const ranges = (annotation.ranges || []).map(range => (
                mapSourceRangeToComparison(range, blockRanges)
            ));
            return ranges.length && ranges.every(Boolean)
                ? [{ ...annotation, ranges }]
                : [];
        }),
        unmatched: [...(source.unmatched || [])],
    };
}

function mapChromeRangesToComparison(chromeRanges, blockRanges) {
    if (!Array.isArray(chromeRanges)) return [];
    return chromeRanges.flatMap(range => {
        const mapped = mapSourceRangeToComparison(range, blockRanges);
        return mapped ? [mapped] : [];
    });
}

function mapSourceMapToComparison(sourceMap, blockRanges) {
    if (!Array.isArray(sourceMap)) return [];
    return sourceMap.flatMap(entry => {
        const range = mapSourceRangeToComparison({
            from: entry.markdownFrom,
            to: entry.markdownTo,
        }, blockRanges);
        if (!range) return [];
        const locationRanges = Array.isArray(entry.locationRanges)
            ? entry.locationRanges.flatMap(locationRange => {
                const mapped = mapSourceRangeToComparison({
                    from: locationRange.markdownFrom,
                    to: locationRange.markdownTo,
                }, blockRanges);
                return mapped ? [{
                    ...locationRange,
                    markdownFrom: mapped.from,
                    markdownTo: mapped.to,
                }] : [];
            })
            : undefined;
        return [{
            ...entry,
            markdownFrom: range.from,
            markdownTo: range.to,
            ...(locationRanges === undefined ? {} : { locationRanges }),
        }];
    });
}

function mapComparisonTargetToSource(target, blockRanges) {
    if (target?.kind === 'selection') {
        const ranges = Array.isArray(target.ranges)
            ? target.ranges.map(range => (
                mapComparisonRangeToSource(range, blockRanges)
            ))
            : [];
        return ranges.length && ranges.every(Boolean)
            ? { ...target, ranges }
            : null;
    }
    if (target?.kind === 'block') {
        const range = mapComparisonRangeToSource(target, blockRanges);
        return range ? { ...target, ...range } : null;
    }
    return null;
}

function mapComparisonAnnotationToSource(annotation, blockRanges) {
    const ranges = Array.isArray(annotation?.ranges)
        ? annotation.ranges.map(range => (
            mapComparisonRangeToSource(range, blockRanges)
        ))
        : [];
    return ranges.length && ranges.every(Boolean)
        ? { ...annotation, ranges }
        : null;
}

function orderedAnnotationEntries(annotationOverlay) {
    const matched = Array.isArray(annotationOverlay?.matched)
        ? annotationOverlay.matched
            .filter(isAnnotationEntry)
            .map(annotation => ({ annotation, matched: true }))
        : [];
    const unmatched = Array.isArray(annotationOverlay?.unmatched)
        ? annotationOverlay.unmatched
            .filter(isAnnotationEntry)
            .map(annotation => ({ annotation, matched: false }))
        : [];
    return [...matched, ...unmatched].sort((left, right) => (
        comparePdfAnnotations(left.annotation, right.annotation)
    ));
}

function firstAnnotationOffset(annotation, markdownLength) {
    if (!Number.isInteger(markdownLength) || markdownLength < 0) return null;
    for (const range of annotation?.ranges || []) {
        if (Number.isInteger(range?.from)
            && Number.isInteger(range?.to)
            && range.from >= 0
            && range.to > range.from
            && range.to <= markdownLength) {
            return range.from;
        }
    }
    return null;
}

function isAnnotationEntry(annotation) {
    return Boolean(annotation && typeof annotation === 'object');
}

function mapAnnotationOverlay(annotationOverlay, annotationID, transform) {
    const targetID = String(annotationID || '');
    return transformAnnotationOverlay(annotationOverlay, annotations => (
        annotations.map(annotation => (
            String(annotation?.id || '') === targetID
                ? transform(annotation)
                : annotation
        ))
    ));
}

function appendMatchedAnnotation(annotationOverlay, annotation) {
    const overlay = annotationOverlay || createEmptyAnnotationOverlay();
    return {
        ...overlay,
        matched: [...(overlay.matched || []), annotation],
        unmatched: [...(overlay.unmatched || [])],
    };
}

function findOverlayAnnotation(annotationOverlay, annotationID) {
    const targetID = String(annotationID || '');
    return [
        ...(annotationOverlay?.matched || []),
        ...(annotationOverlay?.unmatched || []),
    ].find(annotation => String(annotation?.id || '') === targetID) || null;
}

function isMarkdownAnnotation(annotation) {
    return annotation?.source === 'markdown';
}

function annotationUnavailableLabelKey(annotation) {
    return annotation?.reason === 'ambiguous'
        ? 'viewer.noteAmbiguous'
        : 'viewer.noteUnavailable';
}

function synchronizationFailureLabelKey(reason) {
    switch (reason) {
        case 'pdf-index-unavailable':
            return 'annotation.syncFailed.pdfIndexUnavailable';
        case 'text-not-found':
            return 'annotation.syncFailed.textNotFound';
        case 'text-ambiguous':
            return 'annotation.syncFailed.textAmbiguous';
        case 'reader-unavailable':
            return 'annotation.syncFailed.readerUnavailable';
        case 'search-timeout':
            return 'annotation.syncFailed.searchTimeout';
        default:
            return 'annotation.syncFailed.unknown';
    }
}

function annotationUpdate(annotation, changes) {
    return {
        ...changes,
        text: annotation.text,
        ranges: annotation.ranges,
    };
}

function filterAnnotationOverlay(annotationOverlay, annotationID) {
    const targetID = String(annotationID || '');
    const keep = annotation => String(annotation?.id || '') !== targetID;
    return transformAnnotationOverlay(
        annotationOverlay,
        annotations => annotations.filter(keep)
    );
}

function transformAnnotationOverlay(annotationOverlay, transform) {
    const overlay = annotationOverlay || createEmptyAnnotationOverlay();
    return {
        ...overlay,
        matched: transform(overlay.matched || []),
        unmatched: transform(overlay.unmatched || []),
    };
}

function appendChildren(parent, ...children) {
    for (const child of children) parent.appendChild(child);
}

function isAvailableTranslationStatus(status) {
    return status === 'ready' || status === 'partial';
}

function hasAvailableTranslation(model) {
    return isAvailableTranslationStatus(model?.translationStatus)
        || model?.translationStatus === 'loading'
            && Array.isArray(model.translationBlocks)
            && model.translationBlocks.length > 0
            && typeof model.translatedMarkdown === 'string'
            && typeof model.comparisonMarkdown === 'string';
}

function hasCompleteTranslation(model) {
    return hasVisibleCompleteTranslation(model)
        || normalizedCachedTranslationLanguages(
            model?.translationCachedLanguages
        ).length > 0;
}

function hasVisibleCompleteTranslation(model) {
    return (model?.translationStatus === 'ready'
            || model?.translationStatus === 'loading'
                && (model.translationFailedBlocks || []).length === 0)
        && hasAvailableTranslation(model);
}

function hasTranslationLanguageMismatch(model) {
    const configured = String(
        model?.translationConfiguredTargetLanguage || ''
    );
    const visible = String(model?.translationTargetLanguage || '');
    return Boolean(configured && visible && configured !== visible);
}

function translationActionLabelKey(model) {
    if (model?.translationStatus === 'loading') {
        return 'ai.cancelDocumentTranslation';
    }
    if (hasTranslationLanguageMismatch(model)) return 'ai.translateDocument';
    if (model?.translationStatus === 'partial') {
        return 'ai.retryDocumentTranslation';
    }
    return isAvailableTranslationStatus(model?.translationStatus)
        ? 'ai.translatedDocument'
        : 'ai.translateDocument';
}

function translationLanguageMessageKey(language) {
    return {
        'zh-CN': 'preferences.ai.language.zhCN',
        'zh-TW': 'preferences.ai.language.zhTW',
        'ja-JP': 'preferences.ai.language.jaJP',
        'ko-KR': 'preferences.ai.language.koKR',
        'es-ES': 'preferences.ai.language.esES',
        'fr-FR': 'preferences.ai.language.frFR',
        'pt-BR': 'preferences.ai.language.ptBR',
    }[String(language || '')] || '';
}

function normalizedCachedTranslationLanguages(values) {
    if (!Array.isArray(values)) return [];
    return [...new Set(values.map(value => String(value || '').trim()))]
        .filter(isSupportedAITargetLanguage);
}

function normalizedTranslationLanguage(language) {
    const normalized = String(language || '').trim();
    return isSupportedAITargetLanguage(normalized) ? normalized : '';
}

function createFontOptions(definitions) {
    return Object.freeze(definitions.map(([value, labelKey, family]) => (
        Object.freeze({ value, labelKey, family })
    )));
}

function visibleTranslationFailureRanges(model) {
    const view = model.translationView || 'original';
    return translationFailureRangesForView(model, view)
        .map(failure => ({ id: failure.id, from: failure.from }))
        .sort((left, right) => left.from - right.from);
}

function translationFailureRangesForView(model, view) {
    const rangesByID = new Map(
        (model.translationBlockRanges || []).map(range => [range.id, range])
    );
    return (model.translationFailedBlocks || []).flatMap(failure => {
        const block = rangesByID.get(failure.id);
        const from = view === 'translated'
            ? block?.translatedFrom
            : view === 'compare'
                ? block?.comparisonSourceFrom
                : block?.sourceFrom;
        const to = view === 'translated'
            ? block?.translatedTo
            : view === 'compare'
                ? block?.comparisonSourceTo
                : block?.sourceTo;
        return Number.isSafeInteger(from)
            && Number.isSafeInteger(to)
            && to > from
            ? [{ id: failure.id, from, to }]
            : [];
    });
}

function resolveZipPath(basePath, relativePath) {
    const segments = `${basePath}/${relativePath}`.split('/');
    const resolved = [];
    for (const segment of segments) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            resolved.pop();
            continue;
        }
        resolved.push(segment);
    }
    return resolved.join('/');
}

function normalizeZipPath(path) {
    return resolveZipPath('', String(path).replace(/\\/g, '/'));
}

function sanitizeSnapshotFragment(fragment, snapshotURLs) {
    for (const element of fragment.querySelectorAll?.(
        'script,iframe,object,embed,form,style,svg,base,meta,link,video,audio,source,track'
    ) || []) {
        element.remove();
    }
    for (const element of fragment.querySelectorAll?.('*') || []) {
        for (const attribute of [...element.attributes || []]) {
            const name = attribute.name.toLowerCase();
            const value = attribute.value;
            if (name.startsWith('on')) {
                element.removeAttribute(attribute.name);
                continue;
            }
            if (name === 'style'
                || name === 'srcset'
                || name === 'formaction'
                || name === 'poster'
                || name === 'xlink:href') {
                element.removeAttribute(attribute.name);
                continue;
            }
            if (name === 'href' && !isSafeSnapshotLinkURL(value)) {
                element.removeAttribute(attribute.name);
                continue;
            }
            if (name === 'src') {
                element.removeAttribute(attribute.name);
            }
        }
        if (element.localName?.toLowerCase() === 'img') {
            const attachmentKey = element.getAttribute('data-attachment-key');
            const imageURL = snapshotURLs.get(String(attachmentKey || ''));
            if (imageURL) {
                element.setAttribute('src', imageURL);
            }
            else if (attachmentKey) {
                element.removeAttribute('src');
            }
        }
    }
}

function isSafeSnapshotLinkURL(value) {
    const source = String(value || '').trim();
    return /^https?:\/\//i.test(source)
        || /^zotero:\/\//i.test(source)
        || source.startsWith('#');
}
