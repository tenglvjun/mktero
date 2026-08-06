import { createInlineMarkdownEditor } from '../editor/inline-markdown-editor.js';
import {
    annotationPageLabel,
    safeAnnotationColor,
} from '../editor/pdf-annotations.js';
import {
    createEmptyAnnotationOverlay,
} from '../core/markdown-annotation-overlay.js';
import { resolvePDFPageIndexHint } from '../core/markdown-source-map.js';
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
import {
    createMarkdownFragmentID,
    createMarkdownFragmentIndex,
    createMarkdownReadingPositionAnchor,
    extractMarkdownOutline,
    resolveMarkdownReadingPosition,
} from '../markdown/markdown-outline.js';
import {
    createLucideIcon,
    LUCIDE_ICONS,
} from '../icons/lucide-icon.js';
import { createLoadingPresentation } from './markdown-loading-state.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const BUNDLED_MARKDOWN_STYLES = typeof __MKTERO_MARKDOWN_STYLES__ === 'string'
    ? __MKTERO_MARKDOWN_STYLES__
    : null;
const DOCUMENT_ACTION_STATUS_TIMEOUT_MS = 5_000;
const WARNING_TOAST_TIMEOUT_MS = 5_000;
const SIDE_PANEL_KEYBOARD_STEP = 16;
const SIDE_PANEL_RESIZE_ACTIVATION_DISTANCE = 4;
const RESPONSIVE_SIDE_PANEL_BREAKPOINTS = Object.freeze({
    outline: 820,
    notes: 1120,
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
        this.fragmentIndex = new Map();
        this.renderedSnapshotHTML = undefined;
        this.renderedSnapshotAssets = undefined;
        this.snapshotURLs = new Map();
        this.documentActionBusy = null;
        this.actionStatusTimer = null;
        this.warningToastSignature = null;
        this.warningToastTimer = null;
        this.responsiveResizeObserver = null;
        this.documentActionsOpen = false;
        this.readerFontOptionsOpen = false;
        this.activeNavigationOffset = 0;
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
        this.setReaderFont(this.readerFont);
        this.setReaderFontSize(this.readerFontSize);
        this.editor = editorFactory({
            document: this.document,
            parent: this.elements.editorHost,
            initialMarkdown: '',
            resolveImageURL: source => this.resolveImageURL(source),
            openLink: href => this.openLink(href),
            createMarkdownAnnotation: annotation => (
                this.createMarkdownAnnotation(annotation)
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
            openSourceLocation: location => this.openSourceLocation(location),
            openAnnotationInPDF: annotationID => (
                this.openAnnotationInPDF(annotationID)
            ),
            onSourceNavigationError: error => this.zotero?.logError?.(error),
            onViewportChange: offset => this.syncActiveNavigation(offset),
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
        this.syncWarningToast(model.warnings, {
            persistent: Boolean(model.warningAction),
        });
        this.syncContentVisibility(showContent);
        this.syncDocumentActions(model, loadingView);
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
                this.renderedRenderMode = 'markdown';
                this.fragmentIndex = new Map();
                this.syncOutline('');
                this.syncNotes(createEmptyAnnotationOverlay(), 0);
            }
            return;
        }

        if (model.status === 'ready') {
            if (model.renderMode === 'html') {
                elements.editorHost.hidden = true;
                elements.snapshotHost.hidden = false;
                this.renderedMarkdown = undefined;
                this.renderedRenderMode = 'html';
                this.fragmentIndex = new Map();
                this.syncSnapshot();
                this.syncOutline('');
                this.syncNotes(createEmptyAnnotationOverlay(), 0);
                return;
            }
            elements.editorHost.hidden = false;
            elements.snapshotHost.hidden = true;
            const markdown = model.markdown || '';
            const documentChanged = this.renderedRenderMode !== 'markdown'
                || this.renderedMarkdown !== markdown;
            const restoreAnchor = documentChanged
                && this.renderedMarkdown !== undefined
                && this.activeNavigationOffset > 0
                ? createMarkdownReadingPositionAnchor(
                    this.renderedMarkdown,
                    this.activeNavigationOffset
                )
                : null;
            const annotationOverlay = model.annotationOverlay
                || createEmptyAnnotationOverlay();
            const assetsChanged = this.syncAssetURLs();
            this.editor.setDocument({
                markdown,
                annotationOverlay,
                sourceMap: Array.isArray(model.sourceMap) ? model.sourceMap : [],
            });
            this.renderedMarkdown = markdown;
            this.renderedRenderMode = 'markdown';
            this.fragmentIndex = createMarkdownFragmentIndex(markdown);
            this.syncOutline(markdown);
            this.syncNotes(annotationOverlay, markdown.length);
            if (assetsChanged) this.editor.refreshRendering();
            if (restoreAnchor) {
                this.restoreReadingPosition(
                    resolveMarkdownReadingPosition(markdown, restoreAnchor)
                );
            }
            return;
        }

    }

    destroy() {
        this.clearDocumentActionStatus();
        this.clearWarningToast();
        for (const { element, type, listener, options } of this.listeners) {
            element.removeEventListener(type, listener, options);
        }
        this.listeners = [];
        this.responsiveResizeObserver?.disconnect?.();
        this.responsiveResizeObserver = null;
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
        return this.model.onCopySourcedMarkdown(target);
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

    async createMarkdownAnnotation(annotation) {
        if (typeof this.model.onCreateMarkdownAnnotation !== 'function') {
            throw new Error('Markdown annotation creation is unavailable');
        }
        const pdfPageIndexHint = resolvePDFPageIndexHint(
            this.model.sourceMap,
            annotation?.ranges?.[0],
            String(this.model.markdown || '').length
        );
        const draft = pdfPageIndexHint === null
            ? annotation
            : { ...annotation, pdfPageIndexHint };
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
        const snapshotHost = this.createElement('div', {
            id: 'mktero-snapshot',
            class: 'markdown-snapshot-host',
            tabindex: '0',
        });
        snapshotHost.hidden = true;
        const documentActions = this.createDocumentActions();
        const editorSection = this.createElement('section', {
            class: 'markdown-editor',
            'aria-label': this.t('viewer.readOnly'),
        });
        appendChildren(
            editorSection,
            documentActions.toolbar,
            editorHost,
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
        const outlineList = this.createElement('ol', {
            class: 'markdown-outline-list',
        });
        const outline = this.createElement('aside', {
            id: 'mktero-outline',
            class: 'markdown-outline',
            'aria-label': this.t('viewer.outline'),
        });
        appendChildren(outline, outlineTitle, outlineList);
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
            outlineList,
            outlineResizer: outlineControls.resizer,
            outlineToggle: outlineControls.toggle,
            notes,
            notesTitle,
            notesTitleLabel,
            notesList,
            notesResizer: notesControls.resizer,
            notesToggle: notesControls.toggle,
            editorHost,
            snapshotHost,
            editorActions: documentActions.toolbar,
            editorSection,
            actionToggle: documentActions.toggle,
            actionMenu: documentActions.menu,
            reparse: documentActions.reparse,
            reparseLabel: documentActions.reparseLabel,
            saveSnapshot: documentActions.saveSnapshot,
            saveSnapshotLabel: documentActions.saveSnapshotLabel,
            readerFontSize: documentActions.readerFontSize,
            readerFontLabel: documentActions.readerFontLabel,
            readerFontDecrease: documentActions.readerFontDecrease,
            readerFontIncrease: documentActions.readerFontIncrease,
            readerFontValue: documentActions.readerFontValue,
            readerFontFamily: documentActions.readerFontFamily,
            readerFontFamilyLabel: documentActions.readerFontFamilyLabel,
            readerFontTrigger: documentActions.readerFontTrigger,
            readerFontCurrent: documentActions.readerFontCurrent,
            readerFontOptions: documentActions.readerFontOptions,
            actionStatus: documentActions.status,
        };
    }

    createDocumentActions() {
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
        const readerFontLabel = this.createElement(
            'span',
            { class: 'markdown-reader-font-label' },
            this.t('viewer.textSize')
        );
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
        appendChildren(readerFontSize, readerFontLabel, readerFontControls);
        const readerFontFamilyLabel = this.createElement(
            'span',
            { class: 'markdown-reader-font-label' },
            this.t('viewer.textFont')
        );
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
        for (const option of MARKDOWN_READER_FONT_OPTIONS) {
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
            readerFontOptions.appendChild(button);
        }
        const readerFontPicker = this.createElement('div', {
            class: 'markdown-reader-font-picker',
        });
        appendChildren(readerFontPicker, readerFontTrigger, readerFontOptions);
        const readerFontFamily = this.createElement('div', {
            class: 'markdown-reader-font-family',
            role: 'group',
            'aria-label': this.t('viewer.textFont'),
        });
        appendChildren(
            readerFontFamily,
            readerFontFamilyLabel,
            readerFontPicker
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
        menu.appendChild(readerFontSize);
        menu.appendChild(readerFontFamily);
        menu.appendChild(reparse);
        menu.appendChild(saveSnapshot);
        const status = this.createElement('span', {
            class: 'markdown-reader-action-status',
            'aria-live': 'polite',
            'aria-atomic': 'true',
        });
        status.hidden = true;
        const editorActions = this.createElement('div', {
            class: 'markdown-reader-actions',
            role: 'toolbar',
            'aria-label': this.t('viewer.documentActions'),
        });
        appendChildren(editorActions, menu, toggle, status);
        return {
            toolbar: editorActions,
            toggle,
            menu,
            reparse,
            reparseLabel,
            saveSnapshot,
            saveSnapshotLabel,
            readerFontSize,
            readerFontLabel,
            readerFontDecrease,
            readerFontIncrease,
            readerFontValue,
            readerFontFamily,
            readerFontFamilyLabel,
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

    createElement(tagName, attributes = {}, text = '') {
        const element = this.document.createElementNS(XHTML_NAMESPACE, tagName);
        for (const [name, value] of Object.entries(attributes)) {
            element.setAttribute(name, value);
        }
        if (text) element.textContent = text;
        return element;
    }

    bindActions() {
        this.listen(this.elements.actionToggle, 'click', () => {
            if (this.elements.actionToggle.disabled) return;
            this.setDocumentActionsOpen(!this.documentActionsOpen);
        });
        this.listen(this.elements.reparse, 'click', () => {
            this.runDocumentAction('reparse', 'onReparse');
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
        this.listen(this.elements.readerFontDecrease, 'click', () => {
            this.changeReaderFontSize(-1);
        });
        this.listen(this.elements.readerFontIncrease, 'click', () => {
            this.changeReaderFontSize(1);
        });
        this.listen(this.elements.readerFontTrigger, 'click', () => {
            this.setReaderFontOptionsOpen(!this.readerFontOptionsOpen);
        });
        this.listen(this.elements.readerFontTrigger, 'keydown', event => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            this.setReaderFontOptionsOpen(true);
            this.focusReaderFontOption(this.readerFont);
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
            if (event.key === 'Escape' && this.readerFontOptionsOpen) {
                event.preventDefault();
                this.setReaderFontOptionsOpen(false);
                this.elements.readerFontTrigger.focus?.();
                return;
            }
            if (event.key === 'Escape' && this.documentActionsOpen) {
                event.preventDefault();
                this.setDocumentActionsOpen(false);
                this.elements.actionToggle.focus?.();
            }
        });
        const closeDocumentActionsOnOutsidePress = event => {
            if (!this.documentActionsOpen) return;
            const path = event.composedPath?.() || [];
            if (!path.includes(this.elements.readerFontFamily)) {
                this.setReaderFontOptionsOpen(false);
            }
            if (!path.includes(this.elements.editorActions)) {
                this.setDocumentActionsOpen(false);
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

    runDocumentAction(kind, callbackName) {
        const button = {
            reparse: this.elements.reparse,
            retry: this.elements.errorRetry,
            openSettings: this.elements.errorSettings,
            openWarningSettings: this.elements.warningSettings,
            saveSnapshot: this.elements.saveSnapshot,
        }[kind];
        if (!button || button.disabled
            || this.documentActionBusy
            || typeof this.model[callbackName] !== 'function') {
            return;
        }
        this.documentActionBusy = kind;
        if (kind === 'saveSnapshot') {
            this.setDocumentActionStatus('viewer.snapshotSaving');
        }
        this.setDocumentActionsOpen(false);
        this.syncDocumentActions(
            this.model,
            createLoadingPresentation(this.model, this.t)
        );
        let operation;
        try {
            operation = this.model[callbackName]();
        }
        catch (error) {
            this.zotero?.logError?.(error);
            if (kind === 'saveSnapshot') {
                this.setDocumentActionStatus(
                    'viewer.snapshotSaveFailed',
                    { dismissAfter: true }
                );
            }
            this.documentActionBusy = null;
            this.syncDocumentActions(
                this.model,
                createLoadingPresentation(this.model, this.t)
            );
            return;
        }
        Promise.resolve(operation)
            .then(() => {
                if (kind === 'saveSnapshot') {
                    this.setDocumentActionStatus(
                        'viewer.snapshotSaved',
                        { dismissAfter: true }
                    );
                }
            })
            .catch(error => {
                this.zotero?.logError?.(error);
                if (kind === 'saveSnapshot') {
                    this.setDocumentActionStatus(
                        'viewer.snapshotSaveFailed',
                        { dismissAfter: true }
                    );
                }
            })
            .finally(() => {
                this.documentActionBusy = null;
                this.syncDocumentActions(
                    this.model,
                    createLoadingPresentation(this.model, this.t)
                );
            });
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
        this.readerFont = normalizeMarkdownReaderFont(font);
        this.host.style.setProperty(
            '--reader-font',
            getMarkdownReaderFontFamily(this.readerFont)
        );
        if (!this.elements) return;
        const selectedConfig = MARKDOWN_READER_FONT_OPTIONS.find(option => (
            option.value === this.readerFont
        ));
        const selectedLabel = this.t(selectedConfig.labelKey);
        const triggerLabel = `${this.t('viewer.textFont')}: ${selectedLabel}`;
        this.elements.readerFontCurrent.textContent = selectedLabel;
        this.elements.readerFontTrigger.setAttribute('aria-label', triggerLabel);
        this.elements.readerFontTrigger.setAttribute('title', triggerLabel);
        for (const option of this.readerFontOptionButtons()) {
            const selected = option.getAttribute('data-reader-font')
                === this.readerFont;
            option.setAttribute('aria-selected', String(selected));
            option.classList.toggle('is-selected', selected);
            option.setAttribute(
                'tabindex',
                this.readerFontOptionsOpen && selected ? '0' : '-1'
            );
        }
    }

    setReaderFontOptionsOpen(open) {
        const visible = Boolean(open) && this.documentActionsOpen;
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
        this.readerFontSize = normalizeMarkdownReaderFontSize(size);
        this.host.style.setProperty(
            '--reader-font-size',
            `${this.readerFontSize}px`
        );
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

    syncLocalization() {
        this.host.setAttribute('aria-label', this.t('viewer.label'));
        this.elements.progressHeadingLabel.textContent = this.t('loading.progress');
        this.elements.editorSection.setAttribute(
            'aria-label',
            this.t('viewer.readOnly')
        );
        this.elements.editorActions.setAttribute(
            'aria-label',
            this.t('viewer.documentActions')
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
        this.elements.reparseLabel.textContent = this.t(
            'viewer.reparseShort'
        );
        this.elements.saveSnapshotLabel.textContent = this.t(
            'viewer.saveSnapshotShort'
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
        this.elements.readerFontLabel.textContent = this.t('viewer.textSize');
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
        this.elements.readerFontFamilyLabel.textContent = this.t(
            'viewer.textFont'
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
        this.elements.outlineList.querySelector('.markdown-outline-empty')
            ?.replaceChildren(this.t('viewer.outlineEmpty'));
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
        const readerControlsAvailable = model.status === 'ready'
            || loadingView.preserveContent;
        const available = reparseAvailable
            || saveAvailable
            || readerControlsAvailable;
        const reparsing = loadingView.visible && loadingView.preserveContent;
        const activeElement = this.mount.activeElement;
        const readerControlHadFocus = Boolean(activeElement)
            && this.elements.readerFontFamily.contains(activeElement);
        if (!readerControlsAvailable) {
            this.setReaderFontOptionsOpen(false);
            if (readerControlHadFocus) {
                if (available && !this.documentActionBusy) {
                    this.elements.actionToggle.focus?.();
                }
                else {
                    activeElement.blur?.();
                }
            }
        }
        this.elements.editorActions.hidden = !available;
        this.elements.reparse.hidden = !reparseAvailable;
        this.elements.saveSnapshot.hidden = !saveAvailable;
        this.elements.readerFontSize.hidden = !readerControlsAvailable;
        this.elements.readerFontFamily.hidden = !readerControlsAvailable;
        this.elements.reparse.disabled = !reparseAvailable
            || loadingView.visible
            || Boolean(this.documentActionBusy);
        this.elements.saveSnapshot.disabled = !saveAvailable
            || loadingView.visible
            || Boolean(this.documentActionBusy);
        this.elements.actionToggle.disabled = !available
            || Boolean(this.documentActionBusy);
        this.elements.reparse.setAttribute('aria-busy', String(reparsing));
        this.elements.reparse.classList.toggle('is-reparsing', reparsing);
        const saving = this.documentActionBusy === 'saveSnapshot';
        this.elements.saveSnapshot.setAttribute('aria-busy', String(saving));
        this.elements.saveSnapshot.classList.toggle('is-saving', saving);
        if (!available) {
            this.documentActionsOpen = false;
        }
        this.syncDocumentActionMenuState(this.documentActionsOpen && available);
        this.syncErrorActions(model);
        this.syncWarningActions(model);
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

    setDocumentActionsOpen(open) {
        this.documentActionsOpen = Boolean(open);
        const available = !this.elements.editorActions.hidden;
        this.syncDocumentActionMenuState(this.documentActionsOpen && available);
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
        this.elements.readerFontDecrease.setAttribute('tabindex', menuTabIndex);
        this.elements.readerFontIncrease.setAttribute('tabindex', menuTabIndex);
        this.elements.readerFontTrigger.setAttribute('tabindex', menuTabIndex);
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

    syncOutline(markdown) {
        const list = this.elements.outlineList;
        list.replaceChildren();
        const headings = extractMarkdownOutline(markdown);
        if (!headings.length) {
            list.appendChild(this.createElement(
                'li',
                { class: 'markdown-outline-empty' },
                this.t('viewer.outlineEmpty')
            ));
            this.syncActiveNavigation(this.activeNavigationOffset);
            return;
        }
        for (const heading of headings) {
            const button = this.createElement(
                'button',
                {
                    class: 'markdown-outline-link',
                    type: 'button',
                    'data-level': String(heading.level),
                    'data-offset': String(heading.offset),
                    style: `--outline-indent: ${(heading.level - 1) * 12}px;`,
                    title: heading.text,
                },
                heading.text
            );
            const item = this.createElement('li', {
                class: 'markdown-outline-item',
            });
            item.appendChild(button);
            list.appendChild(item);
        }
        this.syncActiveNavigation(this.activeNavigationOffset);
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
