import { renderMarkdownHTML } from '../markdown/markdown-html.js';

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
}

function render() {
    if (!model || document.readyState === 'loading') return;

    document.title = model.title || 'Mktero';
    document.getElementById('mktero-title').textContent = model.title || 'Mktero';
    const status = document.getElementById('mktero-status');
    const progress = document.getElementById('mktero-progress');
    const error = document.getElementById('mktero-error');
    const warning = document.getElementById('mktero-warning');
    const preview = document.getElementById('mktero-preview');
    const source = document.getElementById('mktero-source');

    progress.hidden = model.status !== 'loading';
    progress.value = model.progress || 0;
    error.hidden = model.status !== 'error';
    error.textContent = model.error || '';
    warning.hidden = !model.warnings?.length;
    warning.textContent = model.warnings?.join(' ') || '';

    if (model.status === 'loading') {
        revokeAssetURLs();
        status.textContent = `Converting PDF… ${model.progress || 0}%`;
        preview.replaceChildren();
        source.textContent = '';
    }
    else if (model.status === 'ready') {
        syncAssetURLs();
        status.textContent = sourceLabel(model.sourceKind);
        preview.innerHTML = renderMarkdownHTML(model.markdown || '', {
            resolveImageURL,
        });
        source.textContent = model.markdown || '';
    }
    else {
        status.textContent = 'Conversion failed';
    }
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

function sourceLabel(sourceKind) {
    if (sourceKind === 'markdown') return 'MinerU Markdown';
    if (sourceKind === 'structured') return 'Structured Markdown';
    return 'Plain-text Markdown';
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
