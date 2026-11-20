import {
    createMathCompactTextIndex,
    mathCompactText,
} from '../markdown/math-compact-text.js';

const MAX_CAPTIONS = 64;
const MAX_CAPTION_CHARACTERS = 8_192;
const MAX_TOTAL_CAPTION_CHARACTERS = 65_536;
const MAX_PAGE_ITEMS = 10_000;
const MAX_DOCUMENT_ITEMS = 250_000;
const MAX_PAGE_CHARACTERS = 1_000_000;
const MAX_DOCUMENT_CHARACTERS = 10_000_000;
const MAX_SEARCH_CHARACTERS = 20_000_000;
const MIN_CAPTION_KEY_LENGTH = 24;
const SELECTION_ANCHOR_LENGTH = 24;
const BOX_ROUNDING_POINTS = 0.02;
const HASH = /^[a-f0-9]{64}$/u;

// Evidence is ephemeral and bound to the exact PDF bytes. A caption can only
// disappear from a derived view after its entire text and item region agree.
export function createPDFCaptionExclusions(pages, selectedText, evidence, sourceHash) {
    if (typeof sourceHash !== 'string' || !HASH.test(sourceHash) || evidence?.sourceHash !== sourceHash
        || typeof evidence.markdownHash !== 'string' || !HASH.test(evidence.markdownHash)
        || !Array.isArray(evidence.captions) || !evidence.captions.length
        || evidence.captions.length > MAX_CAPTIONS || !withinIndexBudgets(pages)) return null;
    let characters = 0;
    for (const caption of evidence.captions) {
        if (typeof caption?.text !== 'string' || caption.text.length > MAX_CAPTION_CHARACTERS) return null;
        characters += caption.text.length;
        if (characters > MAX_TOTAL_CAPTION_CHARACTERS) return null;
    }
    const target = mathCompactText(selectedText);
    if (target.length < SELECTION_ANCHOR_LENGTH) return null;
    const candidates = evidence.captions.flatMap(caption => {
        const page = pages.find(page => page.pageIndex === caption.pageIndex);
        if (!page || !validCaptionGeometry(page, caption)) return [];
        const key = mathCompactText(caption.text);
        if (key.length < MIN_CAPTION_KEY_LENGTH || overlapsSelection(key, target)) return [];
        return [{ caption, page, key, count: 0, range: null }];
    });
    if (!candidates.length) return null;
    let searchCharacters = 0;
    for (const page of pages) {
        const compact = createMathCompactTextIndex(page.rawText, { pdfTextLayer: true });
        for (const candidate of candidates) {
            if (candidate.count > 1) continue;
            searchCharacters += compact.text.length;
            if (searchCharacters > MAX_SEARCH_CHARACTERS) return null;
            const from = compact.text.indexOf(candidate.key);
            if (from < 0) continue;
            candidate.count++;
            if (page !== candidate.page || compact.text.indexOf(candidate.key, from + 1) >= 0) {
                candidate.count = 2;
                continue;
            }
            candidate.range = compact.sourceRange(from, candidate.key.length);
        }
    }
    const exclusions = new Map();
    for (const candidate of candidates) {
        if (candidate.count !== 1 || !candidate.range) continue;
        const items = verifiedCaptionItems(candidate);
        if (!items) continue;
        const excluded = exclusions.get(candidate.page) || new Set();
        for (const item of items) excluded.add(item);
        exclusions.set(candidate.page, excluded);
    }
    return exclusions.size ? exclusions : null;
}

function withinIndexBudgets(pages) {
    if (!Array.isArray(pages) || !pages.length || pages.length > 10_000) return false;
    let items = 0;
    let characters = 0;
    const pageIndexes = new Set();
    for (const page of pages) {
        if (!Number.isSafeInteger(page?.pageIndex) || page.pageIndex < 0 || pageIndexes.has(page.pageIndex)
            || !Array.isArray(page.items) || page.items.length > MAX_PAGE_ITEMS
            || typeof page.rawText !== 'string' || page.rawText.length > MAX_PAGE_CHARACTERS) return false;
        pageIndexes.add(page.pageIndex);
        items += page.items.length;
        characters += page.rawText.length;
        if (items > MAX_DOCUMENT_ITEMS || characters > MAX_DOCUMENT_CHARACTERS) return false;
    }
    return true;
}

function overlapsSelection(caption, target) {
    return target.includes(caption) || caption.includes(target)
        || caption.includes(target.slice(0, SELECTION_ANCHOR_LENGTH))
        || caption.includes(target.slice(-SELECTION_ANCHOR_LENGTH));
}

function validCaptionGeometry(page, caption) {
    const geometry = caption.pdfGeometry;
    const viewport = page.viewport;
    if (caption.coordinateFrame !== 'display-cropbox'
        || ![0, 90, 180, 270].includes(caption.rotation)
        || geometry?.rotation !== caption.rotation
        || !positive(geometry.width) || !positive(geometry.height) || !positive(geometry.userUnit)
        || !rectangle(geometry.viewBox) || !matrix(geometry.viewportTransform)
        || (geometry.mediaBox != null && (!rectangle(geometry.mediaBox) || !contains(geometry.mediaBox, geometry.viewBox)))
        || !positive(viewport?.width) || !positive(viewport?.height) || !matrix(viewport.transform)
        || !normalizedBox(caption.captionBBox) || !normalizedBox(caption.visualBBox)
        || intersects(caption.captionBBox, caption.visualBBox)) return false;
    const [x0, y0, x1, y1] = geometry.viewBox;
    const scale = geometry.userUnit;
    const transforms = {
        0: [scale, 0, 0, -scale, -x0 * scale, y1 * scale],
        90: [0, scale, scale, 0, -y0 * scale, -x0 * scale],
        180: [-scale, 0, 0, scale, x1 * scale, -y0 * scale],
        270: [0, -scale, -scale, 0, y1 * scale, x1 * scale],
    };
    const width = (caption.rotation % 180 ? y1 - y0 : x1 - x0) * scale;
    const height = (caption.rotation % 180 ? x1 - x0 : y1 - y0) * scale;
    return close(geometry.width, width) && close(geometry.height, height)
        && close(viewport.width, width) && close(viewport.height, height)
        && transforms[caption.rotation].every((value, index) => close(geometry.viewportTransform[index], value)
            && close(viewport.transform[index], value));
}

function verifiedCaptionItems({ page, caption, range, key }) {
    const bounds = caption.captionBBox.map((value, index) => value * (index % 2 ? page.viewport.height : page.viewport.width) / 1000);
    const matched = [];
    let sourceEnd = 0;
    for (const item of page.items) {
        if (typeof item?.text !== 'string') return null;
        if (!item.text.trim()) continue;
        if (!Number.isSafeInteger(item.sourceFrom) || !Number.isSafeInteger(item.sourceTo)
            || item.sourceFrom < sourceEnd || item.sourceTo <= item.sourceFrom
            || item.sourceTo > page.rawText.length
            || page.rawText.slice(item.sourceFrom, item.sourceTo) !== item.text) return null;
        sourceEnd = item.sourceTo;
        const box = itemDisplayBox(page, item);
        if (!box) return null;
        const inMatch = item.sourceFrom < range.to && item.sourceTo > range.from;
        if (inMatch) {
            if (!contains(bounds, box)) return null;
            matched.push(item);
        }
        else if (intersects(bounds, box)) return null;
    }
    if (!matched.length) return null;
    const fullText = page.rawText.slice(matched[0].sourceFrom, matched.at(-1).sourceTo);
    if (createMathCompactTextIndex(fullText, { pdfTextLayer: true }).text !== key) return null;
    // No unindexed text may hide between the verified items.
    for (let index = 1; index < matched.length; index++) {
        if (page.rawText.slice(matched[index - 1].sourceTo, matched[index].sourceFrom).trim()) return null;
    }
    return matched;
}

function itemDisplayBox(page, item) {
    if (!matrix(item.transform) || !positive(item.width) || !positive(item.height)
        || page.styles?.[item.fontName]?.vertical) return null;
    const [a, b, c, d, e, f] = page.viewport.transform;
    const [ia, ib, ic, id, ix, iy] = item.transform;
    const horizontal = [a * ia + c * ib, b * ia + d * ib];
    const horizontalLength = Math.hypot(...horizontal);
    if (!positive(horizontalLength)) return null;
    const advance = item.width * Math.hypot(a, b);
    const along = horizontal.map(value => value * advance / horizontalLength);
    const up = [a * ic + c * id, b * ic + d * id];
    if (!positive(Math.hypot(...up))) return null;
    const x = a * ix + c * iy + e;
    const y = b * ix + d * iy + f;
    const xs = [x, x + along[0], x + up[0], x + along[0] + up[0]];
    const ys = [y, y + along[1], y + up[1], y + along[1] + up[1]];
    const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    return rectangle(box) ? box : null;
}

function positive(value) {
    return Number.isFinite(value) && value > 0;
}

function rectangle(value) {
    return Array.isArray(value) && value.length === 4 && value.every(Number.isFinite)
        && value[2] > value[0] && value[3] > value[1];
}

function normalizedBox(value) {
    return rectangle(value) && value.every(number => number >= 0 && number <= 1000);
}

function matrix(value) {
    return Array.isArray(value) && value.length === 6 && value.every(Number.isFinite);
}

function close(left, right) {
    return Math.abs(left - right) <= 1e-6 * Math.max(1, Math.abs(right));
}

function intersects(left, right) {
    return Math.min(left[2], right[2]) > Math.max(left[0], right[0])
        && Math.min(left[3], right[3]) > Math.max(left[1], right[1]);
}

function contains(outer, inner) {
    return inner[0] >= outer[0] - BOX_ROUNDING_POINTS && inner[1] >= outer[1] - BOX_ROUNDING_POINTS
        && inner[2] <= outer[2] + BOX_ROUNDING_POINTS && inner[3] <= outer[3] + BOX_ROUNDING_POINTS;
}
