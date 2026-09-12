import {
    FIGURE_LIMITS,
    FIGURE_PIPELINE_PROFILE,
    isFigurePreserveReason,
} from './figure-limits.js';
import { GFM, parser } from '@lezer/markdown';

export { alignFigureInputToPDF } from './figure-page-geometry.js';

const MARKDOWN_PARSER = parser.configure(GFM);
const HASH = /^[a-f0-9]{64}$/;

const FRAME_NAMES = new Set([
    'display-cropbox', 'unrotated-cropbox', 'unrotated-mediabox', 'unknown',
]);
const PAGE_UNITS = new Set(['pt', 'px', 'pdf-user-unit']);
const ROLES = new Set(['panel', 'caption', 'figure-text', 'body', 'unknown']);
const BBOX_KINDS = new Set(['visual-body', 'caption', 'text', 'group', 'unknown']);
const RANGE_EVIDENCE = new Set([
    'explicit-range', 'unique-asset', 'anchored-sequence', 'unresolved',
]);

export function validateFigureInput(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw figureError('INVALID_FIGURE_INPUT', 'Figure input is required');
    }
    if (!['mineru', 'mistral'].includes(input.provider)) {
        throw figureError('INVALID_FIGURE_PROVIDER', 'Figure provider is invalid');
    }
    if (typeof input.markdown !== 'string'
        || new TextEncoder().encode(input.markdown).length > FIGURE_LIMITS.maxMarkdownBytes) {
        throw figureError('INVALID_FIGURE_MARKDOWN', 'Figure Markdown is invalid');
    }
    validateAssets(input.assets);
    if (!Array.isArray(input.pages) || input.pages.length > FIGURE_LIMITS.maxPDFPages) {
        throw figureError('INVALID_FIGURE_PAGES', 'Figure pages are invalid');
    }
    const pages = new Set();
    for (const page of input.pages) {
        if (!Number.isSafeInteger(page?.pageIndex) || page.pageIndex < 0
            || page.pageIndex >= FIGURE_LIMITS.maxPDFPages
            || pages.has(page.pageIndex)) {
            throw figureError('INVALID_FIGURE_PAGE', 'Figure page index is invalid');
        }
        pages.add(page.pageIndex);
        if (page.width !== undefined && (!Number.isFinite(page.width) || page.width <= 0)
            || page.height !== undefined && (!Number.isFinite(page.height) || page.height <= 0)) {
            throw figureError('INVALID_FIGURE_GEOMETRY', 'Figure page dimensions are invalid');
        }
        if (page.unit !== undefined && !PAGE_UNITS.has(page.unit)
            || page.dpi !== undefined && page.dpi !== null
                && (page.unit !== 'px' || !Number.isFinite(page.dpi) || page.dpi <= 0)) {
            throw figureError('INVALID_FIGURE_GEOMETRY', 'Figure page units are invalid');
        }
        if (page.coordinateFrame !== undefined && !FRAME_NAMES.has(page.coordinateFrame)) {
            throw figureError('INVALID_FIGURE_FRAME', 'Figure coordinate frame is invalid');
        }
        if (page.markdownRange !== undefined && page.markdownRange !== null) {
            validateRange(page.markdownRange, input.markdown.length);
        }
    }
    if (!Array.isArray(input.blocks) || input.blocks.length > FIGURE_LIMITS.maxLayoutBlocks) {
        throw figureError('INVALID_FIGURE_BLOCKS', 'Figure blocks are invalid');
    }
    const ids = new Set();
    const consumed = [];
    for (const block of input.blocks) {
        if (!block || typeof block !== 'object' || Array.isArray(block)
            || typeof block.id !== 'string' || !block.id || ids.has(block.id)) {
            throw figureError('INVALID_FIGURE_BLOCK', 'Figure block identity is invalid');
        }
        ids.add(block.id);
        if (!Number.isSafeInteger(block.pageIndex) || !pages.has(block.pageIndex)) {
            throw figureError('INVALID_FIGURE_BLOCK_PAGE', 'Figure block page is invalid');
        }
        if (!Number.isSafeInteger(block.sourceOrdinal) || block.sourceOrdinal < 0
            || !Array.isArray(block.sourceRanges) || block.sourceRanges.length > FIGURE_LIMITS.maxPanels) {
            throw figureError('INVALID_FIGURE_BLOCK', 'Figure block source identity is invalid');
        }
        if (block.bbox !== undefined && block.bbox !== null) validateBBox(block.bbox);
        if (block.role !== undefined && !ROLES.has(block.role)) {
            throw figureError('INVALID_FIGURE_ROLE', 'Figure block role is invalid');
        }
        if (block.bboxKind !== undefined && !BBOX_KINDS.has(block.bboxKind)) {
            throw figureError('INVALID_FIGURE_BBOX_KIND', 'Figure block bbox kind is invalid');
        }
        if (block.rangeEvidence !== undefined && !RANGE_EVIDENCE.has(block.rangeEvidence)) {
            throw figureError('INVALID_FIGURE_RANGE_EVIDENCE', 'Figure range evidence is invalid');
        }
        for (const range of block.sourceRanges || []) {
            validateRange(range, input.markdown.length);
            consumed.push(range);
        }
        if (block.assetPath) normalizeFigureAssetPath(block.assetPath, input.assetBasePath || '');
        if (block.text !== undefined && (typeof block.text !== 'string'
            || block.text.length > FIGURE_LIMITS.maxFragmentLength)) {
            throw figureError('INVALID_FIGURE_TEXT', 'Figure block text is invalid');
        }
    }
    const blocksByID = new Map(input.blocks.map(block => [block.id, block]));
    for (const block of input.blocks) {
        if (!block.parentId) continue;
        const parent = blocksByID.get(block.parentId);
        if (!parent || parent.id === block.id || parent.pageIndex !== block.pageIndex
            || parent.bboxKind !== 'group') {
            throw figureError('INVALID_FIGURE_BLOCK', 'Figure parent identity is invalid');
        }
    }
    ensureNonOverlapping(consumed, 'INVALID_FIGURE_RANGE');
    return input;
}

export function validateFigureMap(map, document = {}) {
    if (!map || typeof map !== 'object' || Array.isArray(map)
        || map.version !== 1 || map.pipeline !== FIGURE_PIPELINE_PROFILE
        || !Array.isArray(map.figures) || !Array.isArray(map.preserved)) {
        throw figureError('INVALID_FIGURE_MAP', 'Figure map is invalid');
    }
    assertFigureJSONBudget(map);
    if (typeof document.markdown !== 'string') {
        throw figureError('INVALID_FIGURE_MARKDOWN', 'Figure Markdown is required');
    }
    if (map.markdownHash !== null
        && (typeof map.markdownHash !== 'string' || !/^[a-f0-9]{64}$/.test(map.markdownHash))) {
        throw figureError('INVALID_FIGURE_HASH', 'Figure map hash is invalid');
    }
    if (document.markdownHash && map.markdownHash && document.markdownHash !== map.markdownHash) {
        throw figureError('FIGURE_MARKDOWN_HASH_MISMATCH', 'Figure Markdown hash does not match');
    }
    if (document.persisted
        && (!HASH.test(map.markdownHash || '') || !HASH.test(document.markdownHash || '')
            || document.markdownHash !== map.markdownHash)) {
        throw figureError('INVALID_FIGURE_HASH', 'Persisted figure hash is required');
    }
    if (map.figures.length > FIGURE_LIMITS.maxFigures
        || map.preserved.length > FIGURE_LIMITS.maxFigures) {
        throw figureError('FIGURE_RESOURCE_LIMIT', 'Figure map is too large');
    }
    const ids = new Set();
    const assetPaths = new Map((document.assets || []).map(asset => ([
        normalizeFigureAssetPath(asset.path), asset,
    ])));
    const images = new Map(collectFigureImageNodes(document.markdown)
        .map(image => [`${image.from}:${image.to}`, image]));
    const ranges = [];
    for (const figure of map.figures) {
        if (!figure || typeof figure.id !== 'string'
            || !/^fig-p\d+-b[\w-]{1,100}$/.test(figure.id) || ids.has(figure.id)) {
            throw figureError('INVALID_FIGURE_ID', 'Figure IDs are invalid');
        }
        ids.add(figure.id);
        if (!Number.isSafeInteger(figure.pageIndex) || figure.pageIndex < 0
            || figure.pageIndex >= FIGURE_LIMITS.maxPDFPages) {
            throw figureError('INVALID_FIGURE_PAGE', 'Figure page index is invalid');
        }
        validateBBox(figure.visualBBox);
        if (figure.label !== null && (typeof figure.label !== 'string'
            || figure.label.length > FIGURE_LIMITS.maxCaptionLength)) {
            throw figureError('INVALID_FIGURE_LABEL', 'Figure label is invalid');
        }
        if (figure.captionBBox !== null && figure.captionBBox !== undefined) {
            validateBBox(figure.captionBBox);
        }
        if (!Array.isArray(figure.panels) || !figure.panels.length
            || figure.panels.length > FIGURE_LIMITS.maxPanels
            || !Array.isArray(figure.memberBlockIds)
            || figure.memberBlockIds.length > FIGURE_LIMITS.maxPanels * 4
            || figure.memberBlockIds.some(id => typeof id !== 'string' || !id || id.length > 256)
            || new Set(figure.memberBlockIds).size !== figure.memberBlockIds.length) {
            throw figureError('FIGURE_RESOURCE_LIMIT', 'Figure panels are invalid');
        }
        if (!figure.render || figure.render.mode !== 'pdf-region'
            || typeof figure.render.assetPath !== 'string') {
            throw figureError('INVALID_FIGURE_RENDER', 'Figure render metadata is invalid');
        }
        const renderPath = normalizeFigureAssetPath(
            figure.render.assetPath,
            document.assetBasePath || ''
        );
        if (!assetPaths.has(renderPath)) {
            throw figureError('FIGURE_ASSET_MISSING', 'Figure render asset is missing');
        }
        validateFigureCrop({ ...assetPaths.get(renderPath),
            width: figure.render.width, height: figure.render.height });
        validateRange(figure.render.range, document.markdown?.length ?? Infinity);
        const image = images.get(`${figure.render.range.from}:${figure.render.range.to}`);
        if (!image?.standalone || normalizeFigureAssetPath(image.assetPath, document.assetBasePath || '') !== renderPath) {
            throw figureError('INVALID_FIGURE_ANCHOR', 'Figure image anchor does not match');
        }
        for (const range of figure.render.captionRanges || []) {
            validateRange(range, document.markdown?.length ?? Infinity);
            if (range.from < image.captionRange.from || range.to > image.captionRange.to) {
                throw figureError('INVALID_FIGURE_RANGE', 'Figure caption range is outside its image');
            }
        }
        ranges.push(figure.render.range);
        const panelIDs = new Set();
        for (const panel of figure.panels) {
            validateBBox(panel.bbox);
            if (typeof panel.blockId !== 'string' || !figure.memberBlockIds.includes(panel.blockId)
                || panelIDs.has(panel.blockId)
                || panel.bbox[0] < figure.visualBBox[0] || panel.bbox[1] < figure.visualBBox[1]
                || panel.bbox[2] > figure.visualBBox[2] || panel.bbox[3] > figure.visualBBox[3]
                || !assetPaths.has(normalizeFigureAssetPath(
                    panel.originalAssetPath, document.assetBasePath || ''
                ))) {
                throw figureError('INVALID_FIGURE_PANEL', 'Figure panel source is invalid');
            }
            panelIDs.add(panel.blockId);
            if (panel.label !== null && panel.label !== undefined
                && (typeof panel.label !== 'string' || panel.label.length > FIGURE_LIMITS.maxCaptionLength)) {
                throw figureError('INVALID_FIGURE_PANEL', 'Figure panel label is invalid');
            }
        }
        validateProvenance(figure.provenance, new Set(figure.memberBlockIds));
    }
    ensureNonOverlapping(ranges, 'INVALID_FIGURE_RANGE');
    for (const preserved of map.preserved) {
        if (!preserved || typeof preserved.id !== 'string'
            || !Number.isSafeInteger(preserved.pageIndex) || preserved.pageIndex < 0
            || !isFigurePreserveReason(preserved.reason)) {
            throw figureError('INVALID_FIGURE_PRESERVED', 'Preserved figure metadata is invalid');
        }
    }
    return map;
}

export function cloneFigureMap(map) {
    return map === null || map === undefined
        ? map
        : JSON.parse(JSON.stringify(map));
}

export function normalizeFigureAssetPath(path, basePath = '') {
    if (typeof path !== 'string' || !path || path.length > 1024
        || /[\u0000-\u001f\u007f]/.test(path)) {
        throw figureError('INVALID_FIGURE_ASSET_PATH', 'Figure asset path is invalid');
    }
    let decoded;
    try {
        decoded = decodeURIComponent(path);
    }
    catch {
        throw figureError('INVALID_FIGURE_ASSET_PATH', 'Figure asset path is invalid');
    }
    if (/[\u0000-\u001f\u007f\\]/.test(decoded) || /^[a-z][a-z0-9+.-]*:/i.test(decoded)
        || decoded.startsWith('/') || decoded.startsWith('//')) {
        throw figureError('INVALID_FIGURE_ASSET_PATH', 'Figure asset path is unsafe');
    }
    const normalize = value => {
        const segments = value.split('/');
        if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
            throw figureError('INVALID_FIGURE_ASSET_PATH', 'Figure asset path is unsafe');
        }
        return segments.join('/');
    };
    const normalizedPath = normalize(decoded);
    if (!basePath) return normalizedPath;
    const normalizedBase = normalizeFigureAssetPath(basePath);
    const result = `${normalizedBase}/${normalizedPath}`;
    if (result.length > 1024) throw figureError('INVALID_FIGURE_ASSET_PATH', 'Figure path is too long');
    return result;
}

export function normalizeFigureAssetDestination(path, basePath = '') {
    const normalizedPath = normalizeFigureAssetPath(path);
    if (!basePath) return normalizedPath;
    const normalizedBase = normalizeFigureAssetPath(basePath);
    return normalizedPath === normalizedBase || normalizedPath.startsWith(normalizedBase + '/')
        ? normalizedPath.slice(normalizedBase.length + 1)
        : normalizedPath;
}

function validateAssets(assets) {
    if (!Array.isArray(assets) || assets.length > FIGURE_LIMITS.maxInputAssets) {
        throw figureError('INVALID_FIGURE_ASSETS', 'Figure assets are invalid');
    }
    const paths = new Set();
    let total = 0;
    for (const asset of assets) {
        const path = normalizeFigureAssetPath(asset?.path);
        if (paths.has(path) || !/^image\/[\w.+-]+$/u.test(String(asset?.mimeType || ''))
            || !ArrayBuffer.isView(asset?.data) || asset.data.BYTES_PER_ELEMENT !== 1) {
            throw figureError('INVALID_FIGURE_ASSET', 'Figure asset is invalid');
        }
        paths.add(path);
        total += asset.data.byteLength;
        if (asset.data.byteLength > 25 * 1024 * 1024 || total > FIGURE_LIMITS.maxTotalAssetBytes) {
            throw figureError('FIGURE_RESOURCE_LIMIT', 'Figure assets exceed the limit');
        }
    }
}

export function assertFigureJSONBudget(value, {
    maxBytes = FIGURE_LIMITS.maxMapBytes,
    maxNodes = FIGURE_LIMITS.maxJSONNodes,
    maxDepth = FIGURE_LIMITS.maxJSONDepth,
} = {}) {
    const pending = [{ value, depth: 0 }];
    const seen = new Set();
    let count = 0;
    let textBytes = 0;
    while (pending.length) {
        const entry = pending.pop();
        if (++count > maxNodes || entry.depth > maxDepth) {
            throw figureError('FIGURE_RESOURCE_LIMIT', 'Figure JSON exceeds the structural limit');
        }
        if (typeof entry.value === 'string') {
            textBytes += new TextEncoder().encode(entry.value).length;
            if (textBytes > maxBytes) throw figureError('FIGURE_RESOURCE_LIMIT', 'Figure JSON is too large');
        }
        else if (entry.value && typeof entry.value === 'object') {
            if (seen.has(entry.value)) throw figureError('INVALID_FIGURE_JSON', 'Figure JSON contains a cycle');
            seen.add(entry.value);
            const values = Object.values(entry.value);
            if (pending.length + values.length + count > maxNodes) {
                throw figureError('FIGURE_RESOURCE_LIMIT', 'Figure JSON exceeds the node limit');
            }
            for (const child of values) pending.push({ value: child, depth: entry.depth + 1 });
        }
    }
    if (new TextEncoder().encode(JSON.stringify(value)).length > maxBytes) {
        throw figureError('FIGURE_RESOURCE_LIMIT', 'Figure JSON is too large');
    }
    return value;
}

export function validateFigureCrop(crop, limits = FIGURE_LIMITS) {
    if (crop?.mimeType !== 'image/png' || !ArrayBuffer.isView(crop.data)
        || crop.data.BYTES_PER_ELEMENT !== 1 || crop.data.byteLength < 45
        || crop.data.byteLength > limits.maxCropBytes
        || !Number.isSafeInteger(crop.width) || !Number.isSafeInteger(crop.height)
        || crop.width < 1 || crop.height < 1
        || crop.width > limits.maxCropEdge || crop.height > limits.maxCropEdge
        || crop.width * crop.height > limits.maxCropPixels) {
        throw figureError('INVALID_FIGURE_PNG', 'Figure PNG exceeds limits or has invalid dimensions');
    }
    const bytes = crop.data;
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (signature.some((value, index) => bytes[index] !== value)
        || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452
        || view.getUint32(16) !== crop.width || view.getUint32(20) !== crop.height
        || !({ 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] })[bytes[25]]?.includes(bytes[24])
        || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) {
        throw figureError('INVALID_FIGURE_PNG', 'Figure PNG header is invalid');
    }
    let offset = 8;
    let imageBytes = 0;
    let ended = false;
    while (offset + 12 <= bytes.length) {
        const size = view.getUint32(offset);
        const type = view.getUint32(offset + 4);
        const end = offset + 12 + size;
        if (end > bytes.length || (offset !== 8 && type === 0x49484452)
            || pngCRC(bytes, offset + 4, end - 4) !== view.getUint32(end - 4)) {
            throw figureError('INVALID_FIGURE_PNG', 'Figure PNG chunk is invalid');
        }
        if (type === 0x49444154) imageBytes += size;
        if (type === 0x49454e44) {
            ended = size === 0 && end === bytes.length;
            break;
        }
        offset = end;
    }
    if (!ended || !imageBytes) throw figureError('INVALID_FIGURE_PNG', 'Figure PNG is incomplete');
    return crop;
}

const PNG_CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    return value >>> 0;
});

function pngCRC(bytes, from, to) {
    let crc = 0xffffffff;
    for (let index = from; index < to; index++) crc = (crc >>> 8) ^ PNG_CRC_TABLE[(crc ^ bytes[index]) & 255];
    return (crc ^ 0xffffffff) >>> 0;
}

export function collectFigureImageNodes(markdown) {
    const images = [];
    MARKDOWN_PARSER.parse(markdown).iterate({
        enter(node) {
            if (node.name !== 'Image') return undefined;
            let destination;
            const marks = [];
            for (let child = node.node.firstChild; child; child = child.nextSibling) {
                if (child.name === 'URL') destination = child;
                if (child.name === 'LinkMark') marks.push(child);
            }
            if (destination && marks.length >= 2) {
                let assetPath = markdown.slice(destination.from, destination.to);
                if (assetPath.startsWith('<') && assetPath.endsWith('>')) assetPath = assetPath.slice(1, -1);
                const captionRange = { from: marks[0].to, to: marks[1].from };
                images.push({ from: node.from, to: node.to, assetPath, captionRange,
                    caption: markdown.slice(captionRange.from, captionRange.to),
                    standalone: node.node.parent?.name === 'Paragraph'
                        && node.node.parent.from === node.from && node.node.parent.to === node.to });
            }
            return false;
        },
    });
    return images;
}

function validateBBox(value) {
    if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)
        || value[0] < 0 || value[1] < 0 || value[2] > 1000 || value[3] > 1000
        || value[2] <= value[0] || value[3] <= value[1]) {
        throw figureError('INVALID_FIGURE_BBOX', 'Figure bounding box is invalid');
    }
}

function validateRange(range, length) {
    if (!Number.isSafeInteger(range?.from) || !Number.isSafeInteger(range?.to)
        || range.from < 0 || range.to <= range.from || range.to > length) {
        throw figureError('INVALID_FIGURE_RANGE', 'Figure source range is invalid');
    }
}

function ensureNonOverlapping(ranges, code) {
    const sorted = ranges.slice().sort((left, right) => left.from - right.from);
    for (let index = 1; index < sorted.length; index++) {
        if (sorted[index].from < sorted[index - 1].to) {
            throw figureError(code, 'Figure source ranges overlap');
        }
    }
}

function validateProvenance(provenance, memberIDs) {
    if (!provenance || typeof provenance !== 'object'
        || !FRAME_NAMES.has(provenance.coordinateFrame)
        || ![0, 90, 180, 270].includes(provenance.rotation)
        || !Array.isArray(provenance.evidence)
        || provenance.evidence.length > 32
        || provenance.evidence.some(value => typeof value !== 'string' || value.length > 128)
        || !Array.isArray(provenance.fragments)) {
        throw figureError('INVALID_FIGURE_PROVENANCE', 'Figure provenance is invalid');
    }
    if (provenance.fragments.length > FIGURE_LIMITS.maxPanels * 4) {
        throw figureError('FIGURE_RESOURCE_LIMIT', 'Figure provenance is too large');
    }
    for (const fragment of provenance.fragments) {
        if (!memberIDs.has(fragment.blockId) || !ROLES.has(fragment.role)
            || typeof fragment.markdown !== 'string'
            || fragment.markdown.length > FIGURE_LIMITS.maxFragmentLength) {
            throw figureError('INVALID_FIGURE_FRAGMENT', 'Figure provenance fragment is invalid');
        }
        if (fragment.bbox) validateBBox(fragment.bbox);
    }
}

function figureError(code, message) {
    const error = new TypeError(message);
    error.code = code;
    return error;
}
