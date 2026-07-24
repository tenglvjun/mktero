import { renderMarkdownHTML } from '../markdown/markdown-html.js';

let model;

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
        status.textContent = `Converting PDF… ${model.progress || 0}%`;
        preview.replaceChildren();
        source.textContent = '';
    }
    else if (model.status === 'ready') {
        status.textContent = model.sourceKind === 'structured'
            ? 'Structured Markdown'
            : 'Plain-text Markdown';
        preview.innerHTML = renderMarkdownHTML(model.markdown || '');
        source.textContent = model.markdown || '';
    }
    else {
        status.textContent = 'Conversion failed';
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
