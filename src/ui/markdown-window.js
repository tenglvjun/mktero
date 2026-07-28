import { createInlineMarkdownEditor } from '../editor/inline-markdown-editor.js';
import { createLocalization } from '../i18n/localization.js';
import { extractMarkdownOutline } from '../markdown/markdown-outline.js';
import { createLoadingPresentation } from './markdown-loading-state.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const BUNDLED_MARKDOWN_STYLES = typeof __MKTERO_MARKDOWN_STYLES__ === 'string'
    ? __MKTERO_MARKDOWN_STYLES__
    : null;
const DEFAULT_OUTLINE_WIDTH = 256;
const MIN_OUTLINE_WIDTH = 180;
const MAX_OUTLINE_WIDTH = 480;
const OUTLINE_KEYBOARD_STEP = 16;
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
        this.outlineVisible = true;
        this.outlineWidth = DEFAULT_OUTLINE_WIDTH;
        this.outlineResize = null;

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
            localization: this.localization,
        });
        this.syncOutline('');
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

        if (loadingView.visible) {
            elements.loadingTitle.textContent = loadingView.title;
            elements.loadingDetail.textContent = loadingView.detail;
            elements.loadingProgressLabel.textContent = loadingView.progressLabel;
            elements.loadingHint.textContent = loadingView.hint;
            elements.loadingProgress.value = loadingView.progress;
            if (!loadingView.preserveContent) {
                this.revokeAssetURLs();
                this.editor.setMarkdown('');
                this.syncOutline('');
            }
            return;
        }

        if (model.status === 'ready') {
            const markdown = model.markdown || '';
            const assetsChanged = this.syncAssetURLs();
            this.editor.setMarkdown(markdown);
            this.syncOutline(markdown);
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
        const spinner = this.createElement('div', {
            class: 'loading-spinner',
            'aria-hidden': 'true',
        });
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
        const editorSection = this.createElement('section', {
            class: 'markdown-editor',
            'aria-label': this.t('viewer.readOnly'),
        });
        editorSection.appendChild(editorHost);
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
            `${this.outlineWidth}px`
        );
        const outlineResizer = this.createElement('div', {
            id: 'mktero-outline-resizer',
            class: 'markdown-outline-resizer',
            role: 'separator',
            tabindex: '0',
            'aria-controls': 'mktero-outline',
            'aria-orientation': 'vertical',
            'aria-valuemin': String(MIN_OUTLINE_WIDTH),
            'aria-valuemax': String(MAX_OUTLINE_WIDTH),
            'aria-valuenow': String(this.outlineWidth),
            'aria-label': this.t('viewer.outlineResize'),
            title: this.t('viewer.outlineResize'),
        });
        const outlineToggle = this.createElement(
            'button',
            {
                id: 'mktero-outline-toggle',
                class: 'markdown-outline-toggle',
                type: 'button',
                'aria-controls': 'mktero-outline',
                'aria-expanded': 'true',
                'aria-label': this.t('viewer.outlineCollapse'),
                title: this.t('viewer.outlineCollapse'),
            },
            '‹'
        );
        const outlineEdge = this.createElement('div', {
            class: 'markdown-outline-edge',
        });
        appendChildren(outlineEdge, outlineResizer, outlineToggle);
        const workspace = this.createElement('div', { class: 'markdown-workspace' });
        workspace.hidden = true;
        appendChildren(workspace, outline, outlineEdge, editorSection);
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
            outlineResizer,
            outlineToggle,
            editorHost,
            editorSection,
        };
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
        this.listen(this.elements.outlineList, 'click', event => {
            const button = event.target?.closest?.('.markdown-outline-link');
            if (!button || !this.elements.outlineList.contains(button)) return;
            const offset = Number(button.getAttribute('data-offset'));
            if (Number.isFinite(offset)) this.editor.scrollToOffset?.(offset);
        });
        this.listen(this.elements.outlineToggle, 'click', () => {
            this.setOutlineVisibility(!this.outlineVisible);
        });
        this.listen(this.elements.outlineResizer, 'dblclick', event => {
            event.preventDefault();
            this.setOutlineVisibility(!this.outlineVisible);
        });
        this.listen(this.elements.outlineResizer, 'mousedown', event => {
            this.startOutlineResize(event);
        });
        this.listen(this.ownerWindow, 'mousemove', event => {
            this.resizeOutline(event);
        });
        this.listen(this.ownerWindow, 'mouseup', () => {
            this.finishOutlineResize();
        });
        this.listen(this.elements.outlineResizer, 'keydown', event => {
            this.handleOutlineResizeKey(event);
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
        this.elements.outline.setAttribute('aria-label', this.t('viewer.outline'));
        this.elements.outlineTitle.textContent = this.t('viewer.outlineTitle');
        this.elements.outlineList.querySelector('.markdown-outline-empty')
            ?.replaceChildren(this.t('viewer.outlineEmpty'));
        this.syncOutlineControlLabels();
    }

    syncOutlineControlLabels() {
        const resizeLabel = this.outlineVisible
            ? this.t('viewer.outlineResize')
            : this.t('viewer.outlineExpand');
        this.elements.outlineResizer.setAttribute('aria-label', resizeLabel);
        this.elements.outlineResizer.setAttribute('title', resizeLabel);
        const toggleLabel = this.t(this.outlineVisible
            ? 'viewer.outlineCollapse'
            : 'viewer.outlineExpand');
        this.elements.outlineToggle.setAttribute('aria-label', toggleLabel);
        this.elements.outlineToggle.setAttribute('title', toggleLabel);
    }

    startOutlineResize(event) {
        if (event.button !== 0
            || !this.outlineVisible
            || this.elements.workspace.hidden) {
            return;
        }
        event.preventDefault();
        this.outlineResize = {
            pointerStartX: event.clientX,
            widthAtStart: this.outlineWidth,
        };
        this.elements.workspace.classList.add('is-resizing-outline');
    }

    resizeOutline(event) {
        if (!this.outlineResize || !Number.isFinite(event.clientX)) return;
        this.setOutlineWidth(
            this.outlineResize.widthAtStart
                + event.clientX
                - this.outlineResize.pointerStartX
        );
    }

    finishOutlineResize() {
        if (!this.outlineResize) return;
        this.outlineResize = null;
        this.elements.workspace.classList.remove('is-resizing-outline');
    }

    setOutlineWidth(width) {
        const nextWidth = Math.min(
            MAX_OUTLINE_WIDTH,
            Math.max(MIN_OUTLINE_WIDTH, Math.round(width))
        );
        this.outlineWidth = nextWidth;
        this.elements.outline.style.setProperty(
            '--outline-width',
            `${nextWidth}px`
        );
        this.elements.outlineResizer.setAttribute(
            'aria-valuenow',
            String(nextWidth)
        );
    }

    setOutlineVisibility(visible) {
        this.finishOutlineResize();
        this.outlineVisible = visible;
        this.elements.outline.hidden = !visible;
        this.elements.outlineResizer.classList.toggle(
            'is-outline-collapsed',
            !visible
        );
        this.elements.outlineToggle.textContent = visible ? '‹' : '›';
        this.elements.outlineToggle.setAttribute(
            'aria-expanded',
            String(visible)
        );
        this.syncOutlineControlLabels();
    }

    handleOutlineResizeKey(event) {
        if (['Enter', ' '].includes(event.key)) {
            event.preventDefault();
            this.setOutlineVisibility(!this.outlineVisible);
            return;
        }
        if (!this.outlineVisible) return;
        const widths = {
            ArrowLeft: this.outlineWidth - OUTLINE_KEYBOARD_STEP,
            ArrowRight: this.outlineWidth + OUTLINE_KEYBOARD_STEP,
            Home: MIN_OUTLINE_WIDTH,
            End: MAX_OUTLINE_WIDTH,
        };
        if (!(event.key in widths)) return;
        event.preventDefault();
        this.setOutlineWidth(widths[event.key]);
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
