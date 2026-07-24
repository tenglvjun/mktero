import { renderMarkdownHTML } from '../markdown/markdown-html.js';
import { createLoadingPresentation } from './markdown-loading-state.js';

let model;
let renderedAssets;
let assetURLs = new Map();

window.addEventListener('DOMContentLoaded', () => {
    model = getEmbeddedModel() || {
        title: 'Mktero',
        status: 'error',
        error: 'The Markdown document was not provided.',
    };
    bindActions();
    render();
});

window.addEventListener('mktero:model-update', () => {
    model = getEmbeddedModel() || model;
    render();
});

window.addEventListener('unload', revokeAssetURLs);

function getEmbeddedModel() {
    return window.mkteroModel
        || window.frameElement?.mkteroModel
        || window.arguments?.[0];
}

function bindActions() {
    document.getElementById('mktero-show-preview').addEventListener('click', () => setMode('preview'));
    document.getElementById('mktero-show-source').addEventListener('click', () => setMode('source'));
    document.getElementById('mktero-copy').addEventListener('click', copyMarkdown);
    document.getElementById('mktero-reparse').addEventListener('click', reparse);
}

function render() {
    if (!model || document.readyState === 'loading') return;

    document.title = model.title || 'Mktero';
    document.getElementById('mktero-title').textContent = model.title || 'Mktero';
    const status = document.getElementById('mktero-status');
    const progress = document.getElementById('mktero-progress');
    const error = document.getElementById('mktero-error');
    const warning = document.getElementById('mktero-warning');
    const content = document.getElementById('mktero-content');
    const loading = document.getElementById('mktero-loading');
    const loadingProgress = document.getElementById('mktero-loading-progress');
    const preview = document.getElementById('mktero-preview');
    const source = document.getElementById('mktero-source');
    const previewButton = document.getElementById('mktero-show-preview');
    const sourceButton = document.getElementById('mktero-show-source');
    const reparseButton = document.getElementById('mktero-reparse');
    const copyButton = document.getElementById('mktero-copy');
    const loadingView = createLoadingPresentation(model);
    const showContent = model.status === 'ready' || loadingView.preserveContent;

    progress.hidden = !loadingView.visible;
    progress.value = loadingView.progress || 0;
    loading.hidden = !loadingView.visible;
    loading.classList.toggle('loading-state--inline', loadingView.preserveContent);
    content.setAttribute('aria-busy', String(loadingView.visible));
    error.hidden = model.status !== 'error';
    error.textContent = model.error || '';
    warning.hidden = !model.warnings?.length;
    warning.textContent = model.warnings?.join(' ') || '';
    previewButton.disabled = !showContent;
    sourceButton.disabled = !showContent;
    copyButton.disabled = !showContent;
    reparseButton.disabled = loadingView.visible || typeof model.onReparse !== 'function';
    syncContentVisibility(showContent);

    if (loadingView.visible) {
        status.textContent = `${loadingView.title} ${loadingView.progressLabel}`;
        document.getElementById('mktero-loading-title').textContent = loadingView.title;
        document.getElementById('mktero-loading-detail').textContent = loadingView.detail;
        document.getElementById('mktero-loading-progress-label').textContent
            = loadingView.progressLabel;
        document.getElementById('mktero-loading-hint').textContent = loadingView.hint;
        loadingProgress.value = loadingView.progress;
        if (!loadingView.preserveContent) {
            revokeAssetURLs();
            preview.replaceChildren();
            source.textContent = '';
        }
    }
    else if (model.status === 'ready') {
        syncAssetURLs();
        status.textContent = sourceLabel(model.sourceKind, model.cacheHit);
        preview.innerHTML = renderMarkdownHTML(model.markdown || '', {
            resolveImageURL,
        });
        source.textContent = model.markdown || '';
    }
    else {
        status.textContent = 'Conversion failed';
    }
}

function syncContentVisibility(visible) {
    const previewMode = document.getElementById('mktero-show-preview')
        .classList.contains('active');
    document.getElementById('mktero-preview').hidden = !visible || !previewMode;
    document.getElementById('mktero-source').hidden = !visible || previewMode;
}

function syncAssetURLs() {
    if (renderedAssets === model.assets) return;
    revokeAssetURLs();
    renderedAssets = model.assets;
    for (const asset of model.assets || []) {
        if (!asset?.path || !asset?.mimeType || !asset?.data) continue;
        const path = normalizeZipPath(asset.path);
        const url = URL.createObjectURL(new Blob([asset.data], { type: asset.mimeType }));
        assetURLs.set(path, url);
    }
}

function revokeAssetURLs() {
    for (const url of assetURLs.values()) URL.revokeObjectURL(url);
    assetURLs = new Map();
    renderedAssets = undefined;
}

function resolveImageURL(source) {
    const path = String(source || '').split(/[?#]/, 1)[0];
    if (!path || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('/')) return null;
    let decodedPath;
    try {
        decodedPath = decodeURIComponent(path);
    }
    catch {
        return null;
    }
    return assetURLs.get(resolveZipPath(model.assetBasePath || '', decodedPath)) || null;
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

function sourceLabel(sourceKind, cacheHit) {
    if (sourceKind === 'markdown' && cacheHit) return 'Cached MinerU Markdown';
    if (sourceKind === 'markdown') return 'MinerU Markdown';
    if (sourceKind === 'structured') return 'Structured Markdown';
    return 'Plain-text Markdown';
}

async function reparse() {
    const button = document.getElementById('mktero-reparse');
    if (typeof model.onReparse !== 'function') return;
    button.disabled = true;
    try {
        await model.onReparse();
    }
    finally {
        button.disabled = model.status === 'loading';
    }
}

function setMode(mode) {
    const previewMode = mode === 'preview';
    document.getElementById('mktero-preview').hidden = !previewMode;
    document.getElementById('mktero-source').hidden = previewMode;
    document.getElementById('mktero-show-preview').classList.toggle('active', previewMode);
    document.getElementById('mktero-show-source').classList.toggle('active', !previewMode);
}

async function copyMarkdown() {
    const button = document.getElementById('mktero-copy');
    try {
        await navigator.clipboard.writeText(model.markdown || '');
        button.textContent = 'Copied';
    }
    catch {
        button.textContent = 'Copy failed';
    }
    window.setTimeout(() => {
        button.textContent = 'Copy Markdown';
    }, 1500);
}
