import { createInlineMarkdownEditor } from '../editor/inline-markdown-editor.js';
import {
    annotationPageLabel,
    safeAnnotationColor,
} from '../editor/pdf-annotations.js';
import {
    createEmptyAnnotationOverlay,
} from '../core/markdown-annotation-overlay.js';
import {
    accessibleAnnotationText,
    comparePdfAnnotations,
} from '../core/pdf-annotation.js';
import { createLocalization } from '../i18n/localization.js';
import { extractMarkdownOutline } from '../markdown/markdown-outline.js';
import {
    createLucideIcon,
    LUCIDE_ICONS,
} from '../icons/lucide-icon.js';
import { createLoadingPresentation } from './markdown-loading-state.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const BUNDLED_MARKDOWN_STYLES = typeof __MKTERO_MARKDOWN_STYLES__ === 'string'
    ? __MKTERO_MARKDOWN_STYLES__
    : null;
const SIDE_PANEL_KEYBOARD_STEP = 16;
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
}) {
    return new MarkdownTabView({
        document,
        model,
        zotero,
        stylesheetText,
        editorFactory,
        localization,
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
        this.renderedAssets = undefined;
        this.assetURLs = new Map();
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
        elements.error.textContent = model.error || '';
        elements.warning.hidden = !model.warnings?.length;
        elements.warning.textContent = model.warnings?.join(' ') || '';
        this.syncContentVisibility(showContent);
        this.syncReparseAction(model, loadingView);

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
                });
                this.syncOutline('');
                this.syncNotes(createEmptyAnnotationOverlay(), 0);
            }
            return;
        }

        if (model.status === 'ready') {
            const markdown = model.markdown || '';
            const annotationOverlay = model.annotationOverlay
                || createEmptyAnnotationOverlay();
            const assetsChanged = this.syncAssetURLs();
            this.editor.setDocument({
                markdown,
                annotationOverlay,
            });
            this.syncOutline(markdown);
            this.syncNotes(annotationOverlay, markdown.length);
            if (assetsChanged) this.editor.refreshRendering();
            return;
        }

    }

    destroy() {
        for (const { element, type, listener } of this.listeners) {
            element.removeEventListener(type, listener);
        }
        this.listeners = [];
        this.editor?.destroy();
        this.revokeAssetURLs();
        this.root.remove?.();
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
        const saved = await this.model.onCreateMarkdownAnnotation(annotation);
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
        });
        warning.hidden = true;
        const error = this.createElement('div', {
            id: 'mktero-error',
            class: 'message error',
        });
        error.hidden = true;
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
        const documentActions = this.createDocumentActions();
        const editorSection = this.createElement('section', {
            class: 'markdown-editor',
            'aria-label': this.t('viewer.readOnly'),
        });
        appendChildren(editorSection, documentActions.toolbar, editorHost);
        const outlineTitle = this.createElement(
            'h2',
            { class: 'markdown-outline-title' },
            this.t('viewer.outlineTitle')
        );
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

        const notesTitle = this.createElement(
            'h2',
            { class: 'markdown-notes-title' },
            this.t('viewer.notesTitle')
        );
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
            error,
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
            outlineList,
            outlineResizer: outlineControls.resizer,
            outlineToggle: outlineControls.toggle,
            notes,
            notesTitle,
            notesList,
            notesResizer: notesControls.resizer,
            notesToggle: notesControls.toggle,
            editorHost,
            editorActions: documentActions.toolbar,
            editorSection,
            reparse: documentActions.reparse,
        };
    }

    createDocumentActions() {
        const reparse = this.createElement('button', {
            id: 'mktero-reparse',
            class: 'markdown-reader-action',
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
        const editorActions = this.createElement('div', {
            class: 'markdown-reader-actions',
            role: 'toolbar',
            'aria-label': this.t('viewer.documentActions'),
        });
        editorActions.appendChild(reparse);
        return { toolbar: editorActions, reparse };
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
        this.listen(this.elements.reparse, 'click', () => {
            if (this.elements.reparse.disabled
                || typeof this.model.onReparse !== 'function') {
                return;
            }
            this.elements.reparse.disabled = true;
            try {
                Promise.resolve(this.model.onReparse())
                    .catch(error => this.zotero?.logError?.(error))
                    .finally(() => this.syncReparseAction(
                        this.model,
                        createLoadingPresentation(this.model, this.t)
                    ));
            }
            catch (error) {
                this.zotero?.logError?.(error);
                this.elements.reparse.disabled = false;
            }
        });
        this.listen(this.elements.outlineList, 'click', event => {
            const button = event.target?.closest?.('.markdown-outline-link');
            if (!button || !this.elements.outlineList.contains(button)) return;
            const offset = Number(button.getAttribute('data-offset'));
            if (Number.isFinite(offset)) this.editor.scrollToOffset?.(offset);
        });
        this.listen(this.elements.notesList, 'click', event => {
            const button = event.target?.closest?.('.markdown-note-link');
            if (!button
                || button.hasAttribute('disabled')
                || !this.elements.notesList.contains(button)) {
                return;
            }
            const offset = Number(button.getAttribute('data-offset'));
            if (Number.isFinite(offset)) this.editor.scrollToOffset?.(offset);
        });
        this.bindSidePanelActions('outline');
        this.bindSidePanelActions('notes');
        this.listen(this.ownerWindow, 'mousemove', event => {
            this.resizeSidePanel('outline', event);
            this.resizeSidePanel('notes', event);
        });
        this.listen(this.ownerWindow, 'mouseup', () => {
            this.finishSidePanelResize('outline');
            this.finishSidePanelResize('notes');
        });
    }

    bindSidePanelActions(name) {
        const panel = this.sidePanels[name];
        const { resizer, toggle } = this.sidePanelElements(name);
        this.listen(toggle, 'click', () => {
            this.setSidePanelVisibility(name, !panel.visible);
        });
        this.listen(resizer, 'dblclick', event => {
            event.preventDefault();
            this.setSidePanelVisibility(name, !panel.visible);
        });
        this.listen(resizer, 'mousedown', event => {
            this.startSidePanelResize(name, event);
        });
        this.listen(resizer, 'keydown', event => {
            this.handleSidePanelResizeKey(name, event);
        });
    }

    listen(element, type, listener) {
        element.addEventListener(type, listener);
        this.listeners.push({ element, type, listener });
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
        this.elements.reparse.setAttribute('aria-label', this.t('viewer.reparse'));
        this.elements.reparse.setAttribute('title', this.t('viewer.reparse'));
        this.elements.outline.setAttribute('aria-label', this.t('viewer.outline'));
        this.elements.outlineTitle.textContent = this.t('viewer.outlineTitle');
        this.elements.outlineList.querySelector('.markdown-outline-empty')
            ?.replaceChildren(this.t('viewer.outlineEmpty'));
        this.elements.notes.setAttribute('aria-label', this.t('viewer.notes'));
        this.elements.notesTitle.textContent = this.t('viewer.notesTitle');
        this.elements.notesList.querySelector('.markdown-notes-empty')
            ?.replaceChildren(this.t('viewer.notesEmpty'));
        this.syncSidePanelControlLabels('outline');
        this.syncSidePanelControlLabels('notes');
    }

    syncReparseAction(model, loadingView) {
        const available = typeof model.onReparse === 'function';
        const reparsing = loadingView.visible && loadingView.preserveContent;
        this.elements.editorActions.hidden = !available;
        this.elements.reparse.disabled = !available || loadingView.visible;
        this.elements.reparse.setAttribute('aria-busy', String(reparsing));
        this.elements.reparse.classList.toggle('is-reparsing', reparsing);
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
        event.preventDefault();
        panel.resize = {
            pointerStartX: event.clientX,
            widthAtStart: panel.width,
        };
        this.elements.workspace.classList.add(panel.resizeClass);
    }

    resizeSidePanel(name, event) {
        const panel = this.sidePanels[name];
        if (!panel.resize || !Number.isFinite(event.clientX)) return;
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

    setSidePanelVisibility(name, visible) {
        const panel = this.sidePanels[name];
        const { element, resizer, toggle } = this.sidePanelElements(name);
        this.finishSidePanelResize(name);
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

    handleSidePanelResizeKey(name, event) {
        const panel = this.sidePanels[name];
        if (['Enter', ' '].includes(event.key)) {
            event.preventDefault();
            this.setSidePanelVisibility(name, !panel.visible);
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
            return;
        }

        for (const { annotation, matched } of entries) {
            list.appendChild(this.createNoteItem(
                annotation,
                matched,
                markdownLength
            ));
        }
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
                this.t('viewer.noteUnavailable')
            ));
        }
        return metadata;
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
        this.mount.getElementById?.(id)?.scrollIntoView?.();
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
