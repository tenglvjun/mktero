// Entry point for the iOS renderer bundle.
//
// It exposes one function on a global: Markdown plus an asset table in, HTML
// out. Nothing here reads Zotero, the network, storage, or the DOM.
//
// The renderer's own image handling only emits an `<img>` when it can resolve a
// reference to a `blob:` URL; anything else becomes a `missing-image`
// placeholder. So the app passes the images it unpacked, and this entry builds
// blob URLs for them. Keeping that in the page means the bytes never have to
// cross the script bridge.
import { renderMarkdownHTML } from '../src/markdown/markdown-html.js';
import { analyzeMarkdownFootnotes } from '../src/markdown/markdown-footnotes.js';

/**
 * Renders Markdown to the same HTML the extension's reader produces.
 *
 * `assets` is a list of `{ path, mimeType, base64 }`. Each entry is turned into
 * a blob URL once and reused, so a figure referenced twice costs one blob.
 */
function render(markdown, assets) {
    const source = typeof markdown === 'string' ? markdown : '';
    const urls = createAssetURLs(assets);
    const resolveImageURL = href => {
        const key = normalizeAssetPath(href);
        if (!key) return null;
        return urls.get(key) || null;
    };

    let html = '';
    try {
        html = renderMarkdownHTML(source, { resolveImageURL });
    }
    catch (error) {
        // A renderer failure must not leave the reader blank: escape the source
        // so the user still sees the text.
        html = `<pre class="mktero-render-fallback">${escapeHTML(source)}</pre>`;
        return { html, footnotes: [], error: String(error && error.message || error) };
    }

    let footnotes = [];
    try {
        const analysis = analyzeMarkdownFootnotes(source);
        footnotes = (analysis?.notes || []).map(entry => ({
            key: String(entry.key ?? ''),
            label: String(entry.label ?? ''),
        }));
    }
    catch {
        // Footnotes are optional decoration; a failure here must not lose the
        // rendered document.
        footnotes = [];
    }
    return { html, footnotes, error: '' };
}

/**
 * Builds a URL for each asset, keyed by a normalized reference path.
 *
 * The renderer only emits an <img> when a reference resolves to something
 * starting with `blob:`. A real blob would be bound to this page's origin, and
 * a WKWebView page loaded from a string has a null origin, so the URL it
 * produced was `blob:null/...` and the reader could never load it.
 *
 * Instead each asset maps to a `blob:`-prefixed URL that carries the asset path
 * instead of an opaque id. The renderer accepts it, and the reader page swaps
 * that path onto its own `mktero-figure://` scheme, which it already serves from
 * the local cache.
 */
function createAssetURLs(assets) {
    const urls = new Map();
    if (!Array.isArray(assets)) return urls;
    for (const asset of assets) {
        const path = normalizeAssetPath(asset?.path);
        if (!path || urls.has(path)) continue;
        urls.set(path, `blob:mktero-figure/${path}`);
    }
    return urls;
}

/**
 * Normalizes a Markdown image reference so it matches the archive key.
 *
 * Mirrors the app's `ResultArchive.normalizeReference`: strip a title, angle
 * brackets, a leading `./`, and a fragment. Remote and data URLs are not local
 * assets.
 */
function normalizeAssetPath(href) {
    let target = String(href ?? '').trim();
    if (!target) return '';
    const space = target.search(/[ \t]/);
    if (space >= 0) target = target.slice(0, space);
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    if (!target) return '';
    if (/^(?:https?:|data:)/i.test(target)) return '';
    const hash = target.indexOf('#');
    if (hash >= 0) target = target.slice(0, hash);
    while (target.startsWith('./')) target = target.slice(2);
    if (target.split('/').includes('..')) return '';
    try {
        return decodeURIComponent(target);
    }
    catch {
        return target;
    }
}

function escapeHTML(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

globalThis.MkteroRenderer = {
    version: __MKTERO_VERSION__,
    render,
};
