export const SAVED_MARKDOWN_NOTE_KIND = 'mktero-saved-markdown';
export const SAVED_MARKDOWN_NOTE_SCHEMA_VERSION = 2;
export const ZOTERO_NOTE_SCHEMA_VERSION = 9;
export const SOURCE_MARKDOWN_ATTACHMENT_TITLE = 'Mktero source.md';
export const SOURCE_MAP_ATTACHMENT_TITLE = 'Mktero source-map.json';

const MAX_NOTE_HTML_BYTES = 20 * 1024 * 1024;
const MAX_ASSETS = 2_000;
const MAX_ASSET_PATH_LENGTH = 1_024;
const HEX_HASH = /^[a-f0-9]{64}$/;
const ITEM_KEY = /^[A-Za-z0-9_-]{1,128}$/;
const ASSET_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[^\u0000-\u001F\u007F]{1,1024}$/;
const MIME_TYPE = /^image\/[A-Za-z0-9.+-]+$/;
const ROOT_PATTERN = /^\s*<div\b([^>]*)>([\s\S]*)<\/div>\s*$/i;
const ZOTERO_NOTE_CLASS = /(?:^|\s)zotero-note(?:\s|$)/i;
const ZOTERO_NOTE_VERSION_CLASS = /(?:^|\s)znv\d+(?:\s|$)/i;
const MANIFEST_MARKER_PREFIX = 'zotero://mktero/saved-markdown?manifest=';
const MANIFEST_MARKER_PATTERN = /^\s*<p\b[^>]*>\s*<a\b([^>]*)>[\s\S]*?<\/a>\s*<\/p>([\s\S]*)$/i;
const MANIFEST_MARKER_LABEL = 'Mktero Markdown Snapshot';

export function createSavedMarkdownManifest({
    sourcePDFKey,
    sourceParentKey = null,
    sourceLibraryKey = null,
    cacheKey,
    markdownHash,
    parserProfile,
    sourceAttachmentKey,
    sourceMapAttachmentKey,
    assetBasePath = '',
    assets = [],
    snapshotHTMLHash,
    createdAt,
}) {
    const manifest = {
        schemaVersion: SAVED_MARKDOWN_NOTE_SCHEMA_VERSION,
        kind: SAVED_MARKDOWN_NOTE_KIND,
        sourcePDFKey,
        sourceParentKey,
        sourceLibraryKey,
        cacheKey,
        markdownHash,
        parserProfile,
        sourceAttachmentKey,
        sourceMapAttachmentKey,
        assetBasePath,
        assets,
        snapshotHTMLHash,
        createdAt,
    };
    validateManifest(manifest);
    return manifest;
}

export function serializeSavedMarkdownNote({ bodyHTML, manifest }) {
    if (typeof bodyHTML !== 'string' || !bodyHTML.trim()) {
        throw new TypeError('Saved Markdown note HTML is required');
    }
    validateManifest(manifest);
    validateBodyHTML(bodyHTML);

    const markerURL = MANIFEST_MARKER_PREFIX
        + encodeURIComponent(JSON.stringify(manifest));
    const marker = '<p><a href="' + escapeAttribute(markerURL) + '">'
        + MANIFEST_MARKER_LABEL + '</a></p>';
    const noteHTML = `<div data-schema-version="${ZOTERO_NOTE_SCHEMA_VERSION}">`
        + marker + bodyHTML + '</div>';
    if (new TextEncoder().encode(noteHTML).length > MAX_NOTE_HTML_BYTES) {
        throw new Error('Saved Markdown note HTML exceeds the size limit');
    }
    return noteHTML;
}

export function isSavedMarkdownNote(noteHTML) {
    try {
        parseSavedMarkdownNote(noteHTML);
        return true;
    }
    catch {
        return false;
    }
}

export function extractZoteroNoteBody(noteHTML) {
    if (typeof noteHTML !== 'string') {
        throw new TypeError('Zotero note HTML must be a string');
    }
    if (new TextEncoder().encode(noteHTML).length > MAX_NOTE_HTML_BYTES) {
        throw new Error('Saved Markdown note HTML exceeds the size limit');
    }
    const root = parseNoteRoot(noteHTML);
    if (!root) throw new Error('Zotero note root is missing');
    const attributes = parseAttributes(root.attributes);
    if (!isZoteroNoteWrapper(attributes)) return root.bodyHTML;

    const inner = parseNoteRoot(root.bodyHTML);
    if (!inner) return root.bodyHTML;
    const innerAttributes = parseAttributes(inner.attributes);
    return innerAttributes['data-schema-version']
        ? inner.bodyHTML
        : root.bodyHTML;
}

export function parseSavedMarkdownNote(noteHTML) {
    if (typeof noteHTML !== 'string') {
        throw new TypeError('Zotero note HTML must be a string');
    }
    if (new TextEncoder().encode(noteHTML).length > MAX_NOTE_HTML_BYTES) {
        throw new Error('Saved Markdown note HTML exceeds the size limit');
    }

    const root = parseNoteRoot(noteHTML);
    if (!root) throw new Error('Saved Markdown note root is missing');
    let markedRoot = root;
    let attributes = parseAttributes(markedRoot.attributes);
    if (attributes['data-mktero-kind'] !== SAVED_MARKDOWN_NOTE_KIND
        && isZoteroNoteWrapper(attributes)) {
        markedRoot = parseNoteRoot(root.bodyHTML);
        if (!markedRoot) throw new Error('Saved Markdown note root is missing');
        attributes = parseAttributes(markedRoot.attributes);
    }
    const marker = parseManifestMarker(markedRoot.bodyHTML);
    const manifest = marker
        ? marker.manifest
        : parseLegacyManifest(attributes);

    return {
        kind: SAVED_MARKDOWN_NOTE_KIND,
        schemaVersion: manifest.schemaVersion,
        manifest,
        bodyHTML: marker?.bodyHTML ?? markedRoot.bodyHTML,
        noteHTML,
    };
}

function parseManifestMarker(bodyHTML) {
    const match = MANIFEST_MARKER_PATTERN.exec(bodyHTML);
    if (!match) return null;
    const href = parseAttributes(match[1]).href || '';
    if (!href.startsWith(MANIFEST_MARKER_PREFIX)) return null;
    let parsed;
    try {
        parsed = JSON.parse(decodeURIComponent(
            href.slice(MANIFEST_MARKER_PREFIX.length)
        ));
    }
    catch {
        throw new Error('Saved Markdown manifest marker is invalid');
    }
    return {
        manifest: createSavedMarkdownManifest(parsed),
        bodyHTML: match[2],
    };
}

function parseLegacyManifest(attributes) {
    if (attributes['data-mktero-kind'] !== SAVED_MARKDOWN_NOTE_KIND) {
        throw new Error('This is not a Mktero saved Markdown note');
    }
    const assets = parseJSONAttribute(
        attributes['data-mktero-assets'],
        'saved Markdown assets'
    );
    return createSavedMarkdownManifest({
        sourcePDFKey: attributes['data-mktero-source-pdf-key'],
        sourceParentKey: attributes['data-mktero-source-parent-key'] || null,
        sourceLibraryKey: attributes['data-mktero-source-library-key'] || null,
        cacheKey: attributes['data-mktero-cache-key'],
        markdownHash: attributes['data-mktero-markdown-hash'],
        parserProfile: attributes['data-mktero-parser-profile'],
        sourceAttachmentKey: attributes['data-mktero-source-attachment-key'],
        sourceMapAttachmentKey: attributes['data-mktero-source-map-key'],
        assetBasePath: attributes['data-mktero-asset-base-path'] || '',
        assets,
        snapshotHTMLHash: attributes['data-mktero-snapshot-html-hash'],
        createdAt: attributes['data-mktero-created-at'],
    });
}

function parseNoteRoot(noteHTML) {
    const match = ROOT_PATTERN.exec(noteHTML);
    if (!match) return null;
    return {
        attributes: match[1],
        bodyHTML: match[2],
    };
}

function isZoteroNoteWrapper(attributes) {
    const className = attributes.class || '';
    return ZOTERO_NOTE_CLASS.test(className)
        && ZOTERO_NOTE_VERSION_CLASS.test(className);
}

function validateManifest(manifest) {
    if (!manifest || typeof manifest !== 'object') {
        throw new TypeError('Saved Markdown manifest is required');
    }
    if (manifest.schemaVersion !== SAVED_MARKDOWN_NOTE_SCHEMA_VERSION
        || manifest.kind !== SAVED_MARKDOWN_NOTE_KIND) {
        throw new Error('Unsupported saved Markdown manifest');
    }
    for (const [name, required] of [
        ['sourcePDFKey', true],
        ['cacheKey', true],
        ['markdownHash', true],
        ['parserProfile', true],
        ['sourceAttachmentKey', true],
        ['sourceMapAttachmentKey', true],
        ['snapshotHTMLHash', true],
    ]) {
        if (required && (typeof manifest[name] !== 'string' || !manifest[name])) {
            throw new Error(`Saved Markdown manifest field ${name} is required`);
        }
    }
    if (!ITEM_KEY.test(manifest.sourcePDFKey)
        || (manifest.sourceParentKey !== null
            && !ITEM_KEY.test(manifest.sourceParentKey))
        || (manifest.sourceLibraryKey !== null
            && !ITEM_KEY.test(manifest.sourceLibraryKey))
        || !ITEM_KEY.test(manifest.sourceAttachmentKey)
        || !ITEM_KEY.test(manifest.sourceMapAttachmentKey)) {
        throw new Error('Saved Markdown item keys are invalid');
    }
    if (!HEX_HASH.test(manifest.cacheKey)
        || !HEX_HASH.test(manifest.markdownHash)
        || !HEX_HASH.test(manifest.snapshotHTMLHash)) {
        throw new Error('Saved Markdown hashes are invalid');
    }
    if (typeof manifest.parserProfile !== 'string'
        || !manifest.parserProfile
        || manifest.parserProfile.length > 4_096
        || /[\u0000-\u001F\u007F]/.test(manifest.parserProfile)) {
        throw new Error('Saved Markdown parser profile is invalid');
    }
    if (typeof manifest.assetBasePath !== 'string'
        || manifest.assetBasePath.length > MAX_ASSET_PATH_LENGTH
        || (manifest.assetBasePath && !ASSET_PATH.test(manifest.assetBasePath))) {
        throw new Error('Saved Markdown asset base path is invalid');
    }
    if (!Array.isArray(manifest.assets) || manifest.assets.length > MAX_ASSETS) {
        throw new Error('Saved Markdown assets are invalid');
    }
    for (const asset of manifest.assets) {
        if (!ASSET_PATH.test(String(asset?.path || ''))
            || !ITEM_KEY.test(String(asset?.attachmentKey || ''))
            || !MIME_TYPE.test(String(asset?.mimeType || ''))) {
            throw new Error('Saved Markdown asset metadata is invalid');
        }
        if (String(asset.path).length > MAX_ASSET_PATH_LENGTH) {
            throw new Error('Saved Markdown asset path is too long');
        }
    }
    if (typeof manifest.createdAt !== 'string') {
        throw new Error('Saved Markdown creation time is invalid');
    }
}

function validateBodyHTML(bodyHTML) {
    const source = bodyHTML.toLowerCase();
    if (/<\/?(?:script|iframe|object|embed|form|style)\b/.test(source)
        || /\bon[a-z]+\s*=/.test(source)
        || /(?:href|src)\s*=\s*["']\s*javascript:/i.test(bodyHTML)
        || /<img\b[^>]*\bsrc\s*=/i.test(bodyHTML)) {
        throw new Error('Saved Markdown HTML contains unsafe markup');
    }
}

function parseAttributes(source) {
    const attributes = {};
    const pattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    for (const match of source.matchAll(pattern)) {
        attributes[match[1]] = decodeEntities(match[2] ?? match[3] ?? '');
    }
    return attributes;
}

function parseJSONAttribute(value, label) {
    if (typeof value !== 'string' || !value) throw new Error(`${label} are missing`);
    try {
        const parsed = JSON.parse(decodeURIComponent(value));
        return parsed;
    }
    catch {
        throw new Error(`${label} are invalid`);
    }
}

function escapeAttribute(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/'/g, '&#39;');
}

function decodeEntities(value) {
    return String(value)
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}
