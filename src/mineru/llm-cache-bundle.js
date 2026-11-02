import { isValidNormalizedSourceBBox } from '../core/markdown-source-map.js';
import { FIGURE_LIMITS } from '../figures/figure-limits.js';
import { assertFigureJSONBudget, normalizeFigureAssetPath } from '../figures/figure-model.js';
import { projectMinerULayout } from './document/result-bundle.js';

export const LLM_CACHE_LIMITS = Object.freeze({
    maxEntries: 5000,
    maxDepth: 16,
    maxTotalBytes: 256 * 1024 * 1024,
    maxPDFBytes: FIGURE_LIMITS.maxPDFBytes,
    maxMarkdownBytes: FIGURE_LIMITS.maxMarkdownBytes,
    maxJSONBytes: 20 * 1024 * 1024,
    maxAssetBytes: 25 * 1024 * 1024,
    maxTotalAssetBytes: FIGURE_LIMITS.maxTotalAssetBytes,
    maxContentBlocks: FIGURE_LIMITS.maxLayoutBlocks,
    maxAssets: FIGURE_LIMITS.maxInputAssets,
});

export class LLMCacheError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'LLMCacheError';
        this.code = code;
    }
}

export function throwIfLLMCacheAborted(signal) {
    if (!signal?.aborted) return;
    const error = new Error('The local cache import was cancelled');
    error.name = 'AbortError';
    throw error;
}

export function normalizeLLMCachePath(value) {
    try {
        return normalizeFigureAssetPath(value);
    }
    catch {
        throw new LLMCacheError('LLM_CACHE_UNSAFE_PATH', 'The local cache contains an unsafe path');
    }
}

export function isLLMCacheImagePath(value) {
    return /\.(?:png|jpe?g|gif|webp)$/iu.test(value);
}

export function isLLMCacheInputPath(value) {
    return value === 'full.md' || value === '_llm_source.json' || value === 'manifest.json'
        || value === 'figure_crops/figure_geometry.json'
        || /^[^/]*(?:content_list|layout|middle)\.json$/iu.test(value)
        || isLLMCacheImagePath(value);
}

export function llmCacheJSON(entry, limits = LLM_CACHE_LIMITS) {
    if (entry.data.byteLength > limits.maxJSONBytes) {
        throw new LLMCacheError('LLM_CACHE_RESOURCE_LIMIT', 'The local cache JSON exceeds the size limit');
    }
    let parsed;
    try {
        parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(entry.data));
    }
    catch {
        throw new LLMCacheError('LLM_CACHE_INVALID_JSON', 'The local cache contains invalid JSON');
    }
    try {
        assertFigureJSONBudget(parsed, { maxBytes: limits.maxJSONBytes });
    }
    catch {
        throw new LLMCacheError('LLM_CACHE_RESOURCE_LIMIT', 'The local cache JSON exceeds its structural budget');
    }
    return parsed;
}

/** Reads the on-disk contract without importing any source-plugin modules. */
export function inspectLLMCacheEntries(entries, {
    attachment,
    pdfPageCount = null,
    sourceRoot = '',
    limits: overrides,
} = {}) {
    const limits = { ...LLM_CACHE_LIMITS, ...overrides };
    const files = checkedFiles(entries, limits);
    if (files.has('_llm_write_pending.json')) {
        throw new LLMCacheError('LLM_CACHE_WRITING', 'The source plugin is still writing its cache');
    }
    const markdownEntry = files.get('full.md');
    if (!markdownEntry || markdownEntry.data.length > limits.maxMarkdownBytes) {
        throw new LLMCacheError('LLM_CACHE_MISSING_MARKDOWN', 'A supported full.md is required');
    }
    let markdown;
    try {
        markdown = new TextDecoder('utf-8', { fatal: true }).decode(markdownEntry.data);
    }
    catch {
        throw new LLMCacheError('LLM_CACHE_INVALID_MARKDOWN', 'The cached Markdown is not valid UTF-8');
    }
    if (!markdown.trim()) throw new LLMCacheError('LLM_CACHE_EMPTY', 'The cached Markdown is empty');
    const source = readSource(files.get('_llm_source.json'), attachment, limits);
    const manifest = files.has('manifest.json') ? llmCacheJSON(files.get('manifest.json'), limits) : null;
    validateManifest(manifest, markdown, pdfPageCount);
    const lists = [...files.keys()].filter(name => /^(?:.+_)?content_list\.json$/iu.test(name));
    const layouts = [...files.keys()].filter(name => /^(?:.+_)?(?:layout|middle)\.json$/iu.test(name));
    if (lists.length > 1 || layouts.length > 1) {
        throw new LLMCacheError('LLM_CACHE_AMBIGUOUS_STRUCTURE', 'The local cache has multiple structure candidates');
    }
    let contentList = lists.length ? llmCacheJSON(files.get(lists[0]), limits) : [];
    if (!Array.isArray(contentList) || contentList.length > limits.maxContentBlocks) {
        throw new LLMCacheError('LLM_CACHE_INVALID_STRUCTURE', 'The cached content list is invalid or exceeds its limit');
    }
    const knownPageCount = pdfPageCount ?? manifest?.totalPages ?? null;
    contentList = contentList.map(block => checkedBlock(block, knownPageCount));
    const layout = layouts.length ? llmCacheJSON(files.get(layouts[0]), limits) : null;
    if (layouts.length) validateLayout(layout, knownPageCount);
    if (!contentList.length && !layout) {
        throw new LLMCacheError('LLM_CACHE_UNSUPPORTED_FORMAT', 'A content list with bounding boxes or supported layout is required');
    }
    const geometry = files.has('figure_crops/figure_geometry.json')
        ? llmCacheJSON(files.get('figure_crops/figure_geometry.json'), limits) : null;
    if (files.has('figure_crops/figure_geometry.json')
        && (!geometry || typeof geometry !== 'object' || Array.isArray(geometry))) {
        throw new LLMCacheError('LLM_CACHE_INVALID_CROP', 'The cached figure geometry is invalid');
    }
    return {
        entries: [...files.values()], files, markdown, contentList, layout,
        layoutPath: layouts[0] || null,
        manifest, geometry, source, sourceRoot,
        attachment: attachment ? { id: attachment.id, key: attachment.key, libraryID: attachment.libraryID } : null,
        sourceFormat: source.format,
        warnings: [
            ...(source.format === 'missing' ? ['LLM_CACHE_SOURCE_MISSING']
                : source.format === 'legacy' ? ['LLM_CACHE_SOURCE_LEGACY'] : []),
            ...(source.format !== 'missing' && (!source.attachmentId || !source.attachmentKey)
                ? ['LLM_CACHE_SOURCE_INCOMPLETE'] : []),
        ],
    };
}

function checkedFiles(entries, limits) {
    if (!Array.isArray(entries) || entries.length > limits.maxEntries) {
        throw new LLMCacheError('LLM_CACHE_RESOURCE_LIMIT', 'The local cache exceeds the file count limit');
    }
    const files = new Map();
    let total = 0;
    let assetTotal = 0;
    let assets = 0;
    for (const entry of entries) {
        const name = normalizeLLMCachePath(entry?.path);
        if (name.split('/').length > limits.maxDepth || files.has(name)) {
            throw new LLMCacheError('LLM_CACHE_UNSAFE_PATH', 'The local cache has duplicate paths or excessive nesting');
        }
        if (!ArrayBuffer.isView(entry?.data) || entry.data.BYTES_PER_ELEMENT !== 1) {
            throw new LLMCacheError('LLM_CACHE_INVALID_FILE', 'The local cache contains invalid file bytes');
        }
        total += entry.data.byteLength;
        if (isLLMCacheImagePath(name)) {
            assetTotal += entry.data.byteLength;
            assets++;
            if (entry.data.byteLength > limits.maxAssetBytes) {
                throw new LLMCacheError('LLM_CACHE_RESOURCE_LIMIT', 'A local cache image exceeds the byte limit');
            }
        }
        if (total > limits.maxTotalBytes || assetTotal > limits.maxTotalAssetBytes || assets > limits.maxAssets) {
            throw new LLMCacheError('LLM_CACHE_RESOURCE_LIMIT', 'The local cache exceeds its resource budget');
        }
        files.set(name, { path: name, data: entry.data });
    }
    return files;
}

function readSource(entry, attachment, limits) {
    if (!entry) return { format: 'missing', origin: null };
    const source = llmCacheJSON(entry, limits);
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
        throw new LLMCacheError('LLM_CACHE_INVALID_SOURCE', 'The source record is invalid');
    }
    const legacy = source.kind === undefined && source.version === undefined;
    if (!legacy && (source.kind !== 'llm-for-zotero/mineru-cache-source' || source.version !== 2)) {
        throw new LLMCacheError('LLM_CACHE_UNSUPPORTED_SOURCE', 'The source record format is not supported');
    }
    if (legacy && (!Number.isSafeInteger(source.attachmentId) || source.attachmentId < 1
        || typeof source.parsedAt !== 'string' || !source.parsedAt)) {
        throw new LLMCacheError('LLM_CACHE_INVALID_SOURCE', 'The legacy source record is incomplete');
    }
    if (source.attachmentId !== undefined && (!Number.isSafeInteger(source.attachmentId)
        || source.attachmentId < 1 || attachment && source.attachmentId !== attachment.id)) {
        throw new LLMCacheError('LLM_CACHE_ATTACHMENT_MISMATCH', 'The cache source attachment does not match');
    }
    if (source.attachmentKey !== undefined && typeof source.attachmentKey !== 'string') {
        throw new LLMCacheError('LLM_CACHE_INVALID_SOURCE', 'The source attachment key is invalid');
    }
    if (source.attachmentKey && attachment && source.attachmentKey !== attachment.key) {
        throw new LLMCacheError('LLM_CACHE_ATTACHMENT_MISMATCH', 'The cache source attachment key does not match');
    }
    if (source.origin !== undefined && !['parsed', 'restored'].includes(source.origin)) {
        throw new LLMCacheError('LLM_CACHE_INVALID_SOURCE', 'The cache source origin is not supported');
    }
    return { ...source, format: legacy ? 'legacy' : 'v2', origin: source.origin || 'parsed' };
}

function validateManifest(manifest, markdown, pdfPageCount) {
    if (manifest === null) return;
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new LLMCacheError('LLM_CACHE_INVALID_MANIFEST', 'The local cache manifest is invalid');
    }
    if (manifest.totalChars !== undefined && (!Number.isSafeInteger(manifest.totalChars)
        || manifest.totalChars !== markdown.length)) {
        throw new LLMCacheError('LLM_CACHE_CHANGED', 'The cached Markdown length does not match its manifest');
    }
    if (manifest.totalPages !== undefined && (!Number.isSafeInteger(manifest.totalPages)
        || manifest.totalPages < 1 || manifest.totalPages > FIGURE_LIMITS.maxPDFPages
        || pdfPageCount !== null && manifest.totalPages !== pdfPageCount)) {
        throw new LLMCacheError('LLM_CACHE_PAGE_MISMATCH', 'The cached page count does not match the PDF');
    }
}

function checkedBlock(block, pageCount) {
    if (!block || typeof block !== 'object' || Array.isArray(block)
        || typeof block.type !== 'string' || !block.type || block.type.length > 64
        || !Number.isSafeInteger(block.page_idx) || block.page_idx < 0
        || block.page_idx >= (pageCount ?? FIGURE_LIMITS.maxPDFPages)) {
        throw new LLMCacheError('LLM_CACHE_INVALID_STRUCTURE', 'The content list contains an invalid block or page');
    }
    if (!isValidNormalizedSourceBBox(block.bbox)) {
        throw new LLMCacheError('LLM_CACHE_UNSUPPORTED_BBOX', 'The content list has no supported bounding boxes; local MinerU V1 results are not supported');
    }
    const supportedTypes = ['text', 'ref_text', 'list', 'equation', 'image', 'chart', 'table', 'code',
        'header', 'footer', 'page_number', 'aside_text', 'page_footnote'];
    if (!supportedTypes.includes(block.type)) {
        throw new LLMCacheError('LLM_CACHE_UNSUPPORTED_FORMAT', 'The content list contains an unsupported block type');
    }
    if (block.img_path !== undefined && block.img_path !== null && typeof block.img_path !== 'string') {
        throw new LLMCacheError('LLM_CACHE_INVALID_STRUCTURE', 'The content list image path is invalid');
    }
    const imagePath = block.img_path ? normalizeLLMCachePath(block.img_path) : block.img_path;
    return { ...block, ...(imagePath ? { img_path: imagePath } : {}), bbox: [...block.bbox] };
}

function validateLayout(layout, pageCount) {
    let projected;
    try {
        projected = projectMinerULayout(layout);
    }
    catch {
        throw new LLMCacheError('LLM_CACHE_RESOURCE_LIMIT', 'The local cache layout exceeds its structural budget');
    }
    if (!projected || !projected.pages.length || projected.diagnostics.droppedPages
        || projected.diagnostics.droppedFields || projected.diagnostics.truncatedStrings
        || projected.pages.some(page => page.pageIndex >= (pageCount ?? FIGURE_LIMITS.maxPDFPages))) {
        throw new LLMCacheError('LLM_CACHE_INVALID_STRUCTURE', 'The local cache layout is invalid or loses required fields');
    }
}
