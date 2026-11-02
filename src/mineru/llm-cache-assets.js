import { FIGURE_LIMITS } from '../figures/figure-limits.js';
import { figureImageDimensions } from '../figures/figure-image-dimensions.js';
import { collectFigureImageNodes, validateFigureCrop } from '../figures/figure-model.js';
import {
    LLM_CACHE_LIMITS, LLMCacheError, isLLMCacheImagePath,
    normalizeLLMCachePath, throwIfLLMCacheAborted,
} from './llm-cache-bundle.js';

const encoder = new TextEncoder();

/** Adapts a private source snapshot to a self-contained MinerU input bundle. */
export async function adaptLLMCacheAssets(input, {
    fileData,
    openPDF = null,
    signal,
    decodeImage = null,
    yieldToUI = () => new Promise(resolve => globalThis.setTimeout(resolve, 0)),
    limits: overrides,
} = {}) {
    throwIfLLMCacheAborted(signal);
    const limits = { ...FIGURE_LIMITS, ...LLM_CACHE_LIMITS, ...overrides };
    const files = input.files || new Map(input.entries.map(entry => [entry.path, entry]));
    const blocks = input.contentList.map(block => ({ ...block, bbox: [...block.bbox] }));
    const outputAssets = new Map();
    const replacements = new Map();
    const coverage = [];
    const counts = { preserved: 0, importedCrops: 0, localCrops: 0, equivalent: 0 };
    const warnings = [...input.warnings];
    const crops = await readCropCandidates(input, files, { limits, decodeImage, signal });
    if (input.geometry && crops === null) warnings.push('LLM_CACHE_CROPS_STALE');
    const imageBlocks = blocks.filter(needsImage);
    if (imageBlocks.length > limits.maxInputAssets) resourceError();
    const manifestIndex = indexManifest(input.manifest, limits);
    const resolved = new Map();
    const covered = new Set();
    let session;
    let generatedBytes = 0;
    try {
        for (let index = 0; index < blocks.length; index++) {
            if (index % 32 === 0) await yieldToUI();
            throwIfLLMCacheAborted(signal);
            const block = blocks[index];
            if (!needsImage(block)) continue;
            if (block.img_path && files.has(block.img_path)) {
                const entry = files.get(block.img_path);
                await checkImage(entry, { limits, signal, decodeImage });
                outputAssets.set(entry.path, entry);
                counts.preserved++;
                coverage.push({ blockIndex: index, pageIndex: block.page_idx, type: block.type,
                    required: !isTextEquivalent(block), method: 'preserved', path: entry.path });
                covered.add(index);
                continue;
            }
            if (isTextEquivalent(block)) {
                if (block.img_path) replacements.set(block.img_path, null);
                delete block.img_path;
                counts.equivalent++;
                coverage.push({ blockIndex: index, pageIndex: block.page_idx, type: block.type,
                    required: false, method: 'text-equivalent' });
                covered.add(index);
                continue;
            }
            const matches = (crops || []).filter(crop => cropMatches(crop, block, manifestIndex));
            if (matches.length === 1) resolved.set(index, matches[0]);
            else if (matches.length > 1 && !openPDF) {
                throw new LLMCacheError('LLM_CACHE_AMBIGUOUS_FIGURE', 'Multiple cached crops match the same figure');
            }
            await yieldToUI();
        }
        // A complete crop may cover adjacent source panels. Only merge when the
        // manifest explicitly groups all their paths and no prose intervenes.
        const grouped = new Map();
        for (const [index, crop] of resolved) {
            const list = grouped.get(crop.path) || [];
            list.push(index);
            grouped.set(crop.path, list);
        }
        const removed = new Set();
        for (const indices of grouped.values()) {
            if (indices.length === 1) continue;
            const crop = resolved.get(indices[0]);
            if (!canMergePanels(indices, blocks, input.manifest, crop)) {
                for (const index of indices) resolved.delete(index);
                continue;
            }
            const first = blocks[indices[0]];
            first.bbox = unionBoxes(indices.map(index => blocks[index].bbox));
            const captions = [...new Set(indices.flatMap(index => captionsFor(blocks[index])))];
            first.image_caption = captions;
            for (const index of indices.slice(1)) removed.add(index);
        }
        for (let index = 0; index < blocks.length; index++) {
            if (index % 32 === 0) await yieldToUI();
            throwIfLLMCacheAborted(signal);
            const block = blocks[index];
            if (!needsImage(block) || covered.has(index)) continue;
            const crop = resolved.get(index);
            if (crop) {
                const destination = `images/imported-crop-${crop.index}.png`;
                outputAssets.set(destination, { path: destination, data: crop.data });
                if (block.img_path) replacements.set(block.img_path, destination);
                block.img_path = destination;
                coverage.push({ blockIndex: index, pageIndex: block.page_idx, type: block.type, required: true,
                    method: 'imported-crop', path: destination, merged: removed.has(index) });
                if (!removed.has(index)) counts.importedCrops++;
            }
            else {
                if (removed.has(index)) continue;
                if (!openPDF) missingImage(index);
                if (!session) {
                    if (!ArrayBuffer.isView(fileData) || fileData.BYTES_PER_ELEMENT !== 1
                        || !fileData.byteLength || fileData.byteLength > limits.maxPDFBytes) {
                        throw new LLMCacheError('LLM_CACHE_RESOURCE_LIMIT', 'The local PDF exceeds the import budget');
                    }
                    session = await openPDF(fileData, { signal });
                    throwIfLLMCacheAborted(signal);
                }
                const geometry = await session.getPageGeometry(block.page_idx, { signal });
                assertPlainPageGeometry(geometry, block.page_idx);
                throwIfLLMCacheAborted(signal);
                const rendered = await session.renderRegion({
                    pageIndex: block.page_idx, bbox: [...block.bbox],
                    coordinateFrame: 'display-cropbox', rotation: geometry.rotation,
                    dpi: limits.defaultDpi,
                }, { signal });
                throwIfLLMCacheAborted(signal);
                validateFigureCrop(rendered, limits);
                generatedBytes += rendered.data.byteLength;
                if (generatedBytes > limits.maxGeneratedBytes) resourceError();
                const destination = `images/local-crop-${index}.png`;
                outputAssets.set(destination, { path: destination, data: rendered.data });
                if (block.img_path) replacements.set(block.img_path, destination);
                block.img_path = destination;
                coverage.push({ blockIndex: index, pageIndex: block.page_idx, type: block.type,
                    required: true, method: 'local-crop', path: destination });
                counts.localCrops++;
            }
            await yieldToUI();
        }
        const markdown = rewriteMarkdownImages(input.markdown, replacements, files, outputAssets);
        // Layouts are kept only when no adapted resource would make their old
        // image references override the repaired content-list path.
        const layoutEntries = [];
        const keepLayout = !replacements.size && !removed.size;
        const normalized = blocks.filter((_, index) => !removed.has(index));
        const contentPaths = new Set(normalized.map(block => block.img_path).filter(Boolean));
        for (const reference of input.layout ? layoutImagePaths(input.layout) : []) {
            const { path: imagePath, pageIndex, type, required } = reference;
            if (keepLayout) {
                const entry = files.get(imagePath);
                if (!entry && required) missingImage(imagePath);
                if (entry) {
                    await checkImage(entry, { limits, signal, decodeImage });
                    outputAssets.set(imagePath, entry);
                    if (!coverage.some(record => record.path === imagePath && record.pageIndex === pageIndex)) counts.preserved++;
                }
                coverage.push({ layoutPath: imagePath, pageIndex, type, required,
                    method: entry ? 'preserved' : 'omitted', path: imagePath });
            }
            else {
                const destination = replacements.has(imagePath) ? replacements.get(imagePath) : imagePath;
                // Once the layout is omitted, its required pictures must be
                // represented by the repaired content list, not just copied as unused assets.
                if (required && (!destination || !contentPaths.has(destination))) missingImage(imagePath);
                coverage.push({ layoutPath: imagePath, pageIndex, type, required,
                    method: 'content-list', path: destination || imagePath });
            }
        }
        if (input.layout && keepLayout) {
            layoutEntries.push({ path: 'layout.json', data: encoder.encode(JSON.stringify(input.layout)) });
        }
        else if (input.layout && !blocks.length) {
            throw new LLMCacheError('LLM_CACHE_MISSING_IMAGE', 'The layout cannot be adapted without a content list');
        }
        for (const entry of outputAssets.values()) {
            await checkImage(entry, { limits, signal, decodeImage });
            await yieldToUI();
        }
        const entries = [
            { path: 'full.md', data: encoder.encode(markdown) },
            ...(normalized.length ? [{ path: 'content_list.json', data: encoder.encode(JSON.stringify(normalized)) }] : []),
            ...layoutEntries,
            ...outputAssets.values(),
        ];
        const totalBytes = entries.reduce((sum, entry) => sum + entry.data.byteLength, 0);
        const assetBytes = [...outputAssets.values()].reduce((sum, entry) => sum + entry.data.byteLength, 0);
        if (entries.length > limits.maxEntries || outputAssets.size > limits.maxInputAssets
            || totalBytes > limits.maxTotalBytes || assetBytes > limits.maxTotalAssetBytes) resourceError();
        throwIfLLMCacheAborted(signal);
        if (counts.importedCrops) warnings.push('LLM_CACHE_IMPORTED_CROPS');
        if (counts.localCrops) warnings.push('LLM_CACHE_LOCAL_CROPS');
        return { entries, coverage, counts, warnings, contentList: normalized, markdown };
    }
    finally {
        await session?.close?.();
    }
}

function needsImage(block) {
    return ['image', 'chart', 'table'].includes(block.type)
        || block.type === 'equation' && Boolean(block.img_path);
}

function isTextEquivalent(block) {
    if (block.type === 'equation') return Boolean(String(block.text || block.latex || '').trim());
    const html = String(block.table_body || '');
    if (block.type !== 'table' || !/<table\b[\s>]/iu.test(html)
        || !/<\/table\s*>/iu.test(html) || !/<t[dh]\b[\s>]/iu.test(html)
        || /<(?:img|svg|canvas)\b/iu.test(html)
        || !markupComparisonText(html).replace(/&(?:nbsp|#160);/giu, '').trim()) return false;
    return !captionsFor(block).some(caption => parseLabel(caption)?.kind === 'figure');
}

function captionsFor(block) {
    const value = block.type === 'table' ? block.table_caption
        : block.type === 'chart' ? block.chart_caption : block.image_caption;
    return (Array.isArray(value) ? value : typeof value === 'string' ? [value] : []).filter(value => typeof value === 'string');
}

// Comparison text only; the original markup still goes through the renderer.
// Consume nested and unfinished tags without leaving tag fragments in the text.
function markupComparisonText(value) {
    let output = '';
    let depth = 0;
    let quote = '';
    for (const character of String(value || '')) {
        if (!depth) {
            if (character === '<') depth = 1;
            else output += character;
        }
        else if (quote) {
            if (character === quote) quote = '';
        }
        else if (character === '"' || character === "'") quote = character;
        else if (character === '<') depth++;
        else if (character === '>') depth--;
    }
    return output;
}

function parseLabel(value) {
    const match = markupComparisonText(value).trim()
        .match(/^(supplement(?:ary|al)\s+)?(fig(?:ure)?\.?|table)\s*([sS]?\d+)([a-z])?\b/iu);
    if (!match) return null;
    const kind = /^table/iu.test(match[2]) ? 'table' : 'figure';
    const supplementary = Boolean(match[1]) || /^s/iu.test(match[3]);
    return { kind, key: `${kind}:${supplementary ? 's' : ''}${match[3].replace(/^s/iu, '')}`, panel: (match[4] || '').toLowerCase() };
}

function manifestBlocks(manifest) {
    return Array.isArray(manifest?.figureBlocks) ? manifest.figureBlocks : [];
}

function manifestFigureRecords(manifest) {
    return [
        ...(Array.isArray(manifest?.allFigures) ? manifest.allFigures : []),
        ...(Array.isArray(manifest?.allTables) ? manifest.allTables : []),
        ...(Array.isArray(manifest?.sections) ? manifest.sections.flatMap(section => [
            ...(Array.isArray(section?.figures) ? section.figures : []),
            ...(Array.isArray(section?.tables) ? section.tables : []),
        ]) : []),
    ];
}

function indexManifest(manifest, limits) {
    const groups = manifestBlocks(manifest);
    const records = manifestFigureRecords(manifest);
    if (groups.length > limits.maxInputAssets || records.length > limits.maxInputAssets * 4) resourceError();
    const groupPaths = new Map();
    const figurePaths = new Map();
    for (const group of groups) {
        const paths = Array.isArray(group?.imagePaths) ? group.imagePaths : [];
        if (paths.length > limits.maxInputAssets) resourceError();
        for (const path of paths) {
            const normalized = normalizeLLMCachePath(path);
            const entries = groupPaths.get(normalized) || [];
            entries.push(group);
            groupPaths.set(normalized, entries);
        }
    }
    for (const record of records) {
        if (!record?.path) continue;
        const normalized = normalizeLLMCachePath(record.path);
        const entries = figurePaths.get(normalized) || [];
        entries.push(record);
        figurePaths.set(normalized, entries);
    }
    return { groupPaths, figurePaths };
}

function cropMatches(crop, block, manifestIndex) {
    if (crop.pageNumber !== block.page_idx + 1) return false;
    const originalPath = block.img_path;
    if (originalPath && crop.imagePaths.includes(originalPath)) return true;
    const groups = manifestIndex.groupPaths.get(originalPath) || [];
    if (crop.mineruBlockId && groups.some(record => record.blockId === crop.mineruBlockId)) return true;
    const manifestCaptions = groups.flatMap(record => [
        ...(Array.isArray(record.labelHints) ? record.labelHints : []),
        ...(Array.isArray(record.captionHints) ? record.captionHints : []),
    ]);
    const figures = manifestIndex.figurePaths.get(originalPath) || [];
    const hints = [...captionsFor(block), ...manifestCaptions,
        ...figures.flatMap(record => [record.label, record.baseLabel, record.caption])];
    const labels = hints.map(parseLabel).filter(Boolean);
    const target = parseLabel(crop.label);
    if (!target || !labels.length || !labels.every(label => label.key === target.key)) return false;
    if (target.panel && !labels.some(label => label.panel === target.panel)) return false;
    // Require the manifest inventory to corroborate a caption-only match.
    return groups.length > 0 || figures.some(record => {
        const label = parseLabel(record.label || record.baseLabel || record.caption);
        return label?.key === target.key;
    });
}

function canMergePanels(indices, blocks, manifest, crop) {
    if (indices.some((index, position) => position && index !== indices[position - 1] + 1)) return false;
    const target = parseLabel(crop.label);
    if (!target || target.panel || indices.some(index => blocks[index].type !== 'image'
        || blocks[index].page_idx + 1 !== crop.pageNumber)) return false;
    const paths = indices.map(index => blocks[index].img_path);
    return manifestBlocks(manifest).some(record => record.ambiguous !== true
        && record.kind !== 'mixed' && record.kind !== 'table'
        && Array.isArray(record.imagePaths) && paths.every(path => record.imagePaths.includes(path))
        && (record.labelHints || []).some(hint => parseLabel(hint)?.key === target.key));
}

async function readCropCandidates(input, files, { limits, decodeImage, signal }) {
    const cache = input.geometry;
    if (!cache) return [];
    if (!input.manifest || cache.version !== 2 || cache.algorithmVersion !== 14
        || !Array.isArray(cache.entries) || cache.manifestHash !== llmCropManifestHash(input.manifest)
        || cache.attachmentId !== input.attachment?.id && input.source.origin !== 'restored') return null;
    if (cache.entries.length > limits.maxFigures || !Array.isArray(cache.missingFigures || [])
        || (cache.missingFigures || []).length > limits.maxFigures) resourceError();
    const missing = cache.missingFigures || [];
    const candidates = [];
    for (let index = 0; index < cache.entries.length; index++) {
        throwIfLLMCacheAborted(signal);
        const crop = cache.entries[index];
        if (!crop || typeof crop.label !== 'string' || !parseLabel(crop.label)
            || !Number.isSafeInteger(crop.pageNumber) || crop.pageNumber < 1
            || crop.pageNumber > (input.manifest.totalPages || limits.maxPDFPages)
            || !validRect(crop.rect)) {
            throw new LLMCacheError('LLM_CACHE_INVALID_CROP', 'The cached figure geometry is invalid');
        }
        const label = parseLabel(crop.label);
        if (missing.some(entry => parseLabel(entry?.label)?.key === label.key
            && (!entry.pageNumber || entry.pageNumber === crop.pageNumber))) continue;
        const imagePath = resolveCropPath(crop.cropPath, input, files);
        const file = files.get(imagePath);
        if (!file) continue;
        const dimensions = await checkImage(file, { limits, signal, decodeImage, crop: true });
        const imagePaths = Array.isArray(crop.mineruImagePaths)
            ? crop.mineruImagePaths.map(normalizeLLMCachePath) : [];
        candidates.push({ ...crop, index, path: imagePath, data: file.data, dimensions, imagePaths });
    }
    return candidates;
}

function resolveCropPath(value, input, files) {
    if (typeof value !== 'string' || !value || value.length > 4096
        || /[\u0000-\u001f\u007f]/u.test(value) || /%(?:2e|2f|5c)/iu.test(value)) unsafeCrop();
    const normalized = value.replace(/\\/gu, '/');
    if (normalized.split('/').some(part => part === '..' || part === '.')) unsafeCrop();
    if (/^[a-z][a-z0-9+.-]*:/iu.test(normalized) && !/^[A-Za-z]:\//u.test(normalized)) unsafeCrop();
    if (normalized.startsWith('//')) unsafeCrop();
    let relative = normalized;
    if (/^(?:\/|[A-Za-z]:\/)/u.test(normalized)) {
        const root = String(input.sourceRoot || '').replace(/\\/gu, '/').replace(/\/$/u, '');
        if (root && normalized.startsWith(`${root}/`)) relative = normalized.slice(root.length + 1);
        else if (input.source.origin === 'restored') {
            const marker = '/figure_crops/crops/';
            const at = normalized.indexOf(marker);
            if (at < 0 || at !== normalized.lastIndexOf(marker)) unsafeCrop();
            relative = normalized.slice(at + 1);
        }
        else unsafeCrop();
    }
    relative = normalizeLLMCachePath(relative);
    if (!relative.startsWith('figure_crops/crops/') || !/\.png$/iu.test(relative)) unsafeCrop();
    return relative;
}

async function checkImage(entry, { limits, signal, decodeImage, crop = false }) {
    if (!isLLMCacheImagePath(entry.path) || entry.data.byteLength > limits.maxAssetBytes) resourceError();
    const mimeType = /\.png$/iu.test(entry.path) ? 'image/png'
        : /\.jpe?g$/iu.test(entry.path) ? 'image/jpeg'
            : /\.gif$/iu.test(entry.path) ? 'image/gif' : 'image/webp';
    let dimensions = figureImageDimensions({ data: entry.data, mimeType });
    let decoded;
    try {
        if (decodeImage) {
            decoded = await decodeImage({ data: entry.data, mimeType }, { signal });
            dimensions = decoded;
        }
        throwIfLLMCacheAborted(signal);
        if (!dimensions || !Number.isSafeInteger(dimensions.width) || dimensions.width < 1
            || !Number.isSafeInteger(dimensions.height) || dimensions.height < 1
            || dimensions.width * dimensions.height > limits.maxDecodedImagePixels) {
            throw new LLMCacheError('LLM_CACHE_INVALID_IMAGE', 'A cached image is invalid or exceeds the decoded pixel budget');
        }
        if (mimeType === 'image/png') validateFigureCrop({
            data: entry.data, mimeType, width: dimensions.width, height: dimensions.height,
        }, {
            ...limits, maxCropBytes: crop ? limits.maxCropBytes : limits.maxAssetBytes,
            maxCropEdge: crop ? limits.maxCropEdge : limits.maxIntermediateCanvasEdge,
            maxCropPixels: crop ? limits.maxCropPixels : limits.maxDecodedImagePixels,
        });
        if (crop && mimeType !== 'image/png') unsafeCrop();
        return { width: dimensions.width, height: dimensions.height };
    }
    finally {
        decoded?.close?.();
    }
}

function assertPlainPageGeometry(geometry, pageIndex) {
    const box = geometry?.viewBox;
    const media = geometry?.mediaBox;
    if (geometry?.pageIndex !== pageIndex || geometry?.coordinateFrame !== 'display-cropbox'
        || geometry.rotation !== 0 || geometry.userUnit !== 1
        || !Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)
        || box[0] !== 0 || box[1] !== 0 || box[2] <= 0 || box[3] <= 0
        || Math.abs(box[2] - geometry.width) > 0.01 || Math.abs(box[3] - geometry.height) > 0.01
        || media && (!Array.isArray(media) || media.length !== 4
            || media.some((value, index) => !Number.isFinite(value) || Math.abs(value - box[index]) > 0.01))) {
        throw new LLMCacheError('LLM_CACHE_UNSUPPORTED_GEOMETRY', 'The missing figure cannot be recovered from an uncertain PDF coordinate frame');
    }
}

function validRect(rect) {
    return rect && ['left', 'top', 'width', 'height'].every(key => Number.isFinite(rect[key]))
        && rect.left >= 0 && rect.top >= 0 && rect.width > 0 && rect.height > 0;
}

function unionBoxes(boxes) {
    return [Math.min(...boxes.map(box => box[0])), Math.min(...boxes.map(box => box[1])),
        Math.max(...boxes.map(box => box[2])), Math.max(...boxes.map(box => box[3]))];
}

function rewriteMarkdownImages(markdown, replacements, files, outputAssets) {
    if (/<img\b/iu.test(markdown)) {
        throw new LLMCacheError('LLM_CACHE_UNSUPPORTED_FORMAT', 'Raw HTML images are not supported by the local cache adapter');
    }
    const edits = [];
    for (const image of collectFigureImageNodes(markdown)) {
        const original = normalizeLLMCachePath(image.assetPath);
        if (replacements.has(original)) {
            const replacement = replacements.get(original);
            edits.push({ from: image.from, to: image.to,
                text: replacement ? `![${image.caption}](${replacement})` : '' });
        }
        else {
            if (!files.has(original) || !isLLMCacheImagePath(original)) missingImage(original);
            outputAssets.set(original, files.get(original));
        }
    }
    let result = markdown;
    for (const edit of edits.sort((left, right) => right.from - left.from)) {
        result = result.slice(0, edit.from) + edit.text + result.slice(edit.to);
    }
    return result;
}

function layoutImagePaths(layout) {
    const result = new Map();
    const chrome = new Set(['header', 'footer', 'page_number', 'aside_text']);
    for (const page of layout.pdf_info) {
        for (const block of [...(page.para_blocks || []), ...(page.discarded_blocks || [])]) {
            const type = block.type === 'interline_equation' ? 'equation' : block.type;
            const captions = (block.blocks || []).filter(child => child.type === 'table_caption')
                .map(child => layoutStrings(child, 'content').join(' '));
            const equivalent = value => isTextEquivalent({ type, table_caption: captions,
                table_body: layoutStrings(value, 'html').join('\n'),
                text: type === 'equation' ? layoutStrings(value, 'content').join('\n') : '',
            });
            const required = !chrome.has(type) && !equivalent(block);
            let hasImagePath = false;
            const pending = [{ value: block, required }];
            while (pending.length) {
                const { value, required: inherited } = pending.pop();
                if (!value || typeof value !== 'object') continue;
                // Table bodies can have independent images. Text in one body
                // does not prove that a different image-only body is redundant.
                const required = type === 'table' && value.type === 'table_body' ? !equivalent(value) : inherited;
                if (typeof value.image_path === 'string') {
                    hasImagePath = true;
                    const path = normalizeLLMCachePath(value.image_path);
                    const key = `${page.page_idx}:${path}`;
                    if (!result.has(key) || required) result.set(key, { path, pageIndex: page.page_idx, type, required });
                }
                for (const child of Object.values(value).reverse()) {
                    if (child && typeof child === 'object') pending.push({ value: child, required });
                }
            }
            if (required && ['image', 'chart', 'equation'].includes(type) && !hasImagePath) {
                missingImage(`layout page ${page.page_idx}`);
            }
        }
    }
    return [...result.values()];
}

function layoutStrings(value, key) {
    const result = [];
    const pending = [value];
    while (pending.length) {
        const value = pending.pop();
        if (!value || typeof value !== 'object') continue;
        if (typeof value[key] === 'string') result.push(value[key]);
        for (const child of Object.values(value).reverse()) if (child && typeof child === 'object') pending.push(child);
    }
    return result;
}

/** FNV-1a is the source format's freshness checksum, not a PDF identity. */
export function llmCropManifestHash(manifest) {
    const fields = {
        figureBlocks: manifest?.figureBlocks ?? null,
        allFigures: manifest?.allFigures ?? null,
        allTables: manifest?.allTables ?? null,
        totalPages: manifest?.totalPages ?? null,
        sections: (Array.isArray(manifest?.sections) ? manifest.sections : []).map(section => ({
            figures: section?.figures ?? null, tables: section?.tables ?? null,
        })),
    };
    let hash = 0x811c9dc5;
    const text = JSON.stringify(fields);
    for (let index = 0; index < text.length; index++) {
        hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
    }
    return `fnv1a32-${hash.toString(16).padStart(8, '0')}`;
}

function missingImage(index) {
    throw new LLMCacheError('LLM_CACHE_MISSING_IMAGE', `A required cached figure cannot be recovered (${index})`);
}

function unsafeCrop() {
    throw new LLMCacheError('LLM_CACHE_UNSAFE_PATH', 'The cached figure path is unsafe or outside the supported crop directory');
}

function resourceError() {
    throw new LLMCacheError('LLM_CACHE_RESOURCE_LIMIT', 'The imported figures exceed their resource budget');
}
