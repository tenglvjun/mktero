import { BLOCK_KIND, BLOCK_ROLE } from './ir.js';

// The PDF's own text layer (a PDF.js text index, as the annotation locator
// builds it) gives every text fragment its real lines: how many there are,
// how far the last one runs, how far the first one is indented, and its
// font. MinerU cloud results only carry one box per block.
//
// The text index is untrusted input: every number is checked, and the work
// is bounded per page.
export const PDF_GEOMETRY_LIMITS = Object.freeze({
    maxPages: 2_000,
    maxItemsPerPage: 20_000,
    // A PDF page and its MinerU page must have the same shape, within 2%.
    aspectTolerance: 0.02,
});
// An item belongs to the fragment that contains its center, with a margin
// in the IR's 0–1000 page units.
const CONTAINMENT_MARGIN = 4;
const MAX_FONT_NAME_LENGTH = 128;
const MAX_ITEM_TEXT_LENGTH = 2_000;

// Attaches `fragment.pdf = { lines, lastFill, firstIndent, fontSize, font }`
// to the text fragments of every page whose PDF page matches. Pages with
// such fragments get `geometry: 'line'`; the IR records what was used in
// `diagnostics.pdfGeometry`. Without a usable index nothing changes.
export function attachPDFGeometry(ir, pdfText) {
    const diagnostics = { pages: 0, mismatched: 0, fragments: 0, measured: 0 };
    ir.diagnostics.pdfGeometry = diagnostics;
    const pdfPages = pdfPagesByIndex(pdfText);
    if (!pdfPages.size) return ir;
    const fragmentsByPage = new Map();
    for (const block of ir.blocks) {
        if (!isMeasurable(block)) continue;
        for (const fragment of block.fragments || []) {
            if (!validBox(fragment.bbox)) continue;
            if (!fragmentsByPage.has(fragment.pageIndex)) fragmentsByPage.set(fragment.pageIndex, []);
            fragmentsByPage.get(fragment.pageIndex).push(fragment);
            diagnostics.fragments++;
        }
    }
    for (const page of ir.pages) {
        const fragments = fragmentsByPage.get(page.pageIndex);
        const pdfPage = pdfPages.get(page.pageIndex);
        if (!fragments?.length || !pdfPage) continue;
        const items = pdfPageItems(pdfPage, page);
        if (!items) {
            diagnostics.mismatched++;
            continue;
        }
        diagnostics.pages++;
        let measured = 0;
        for (const fragment of fragments) {
            const geometry = measureFragment(fragment.bbox, items);
            if (!geometry) continue;
            fragment.pdf = geometry;
            measured++;
        }
        diagnostics.measured += measured;
        if (measured) page.geometry = 'line';
    }
    return ir;
}

function isMeasurable(block) {
    return block.kind === BLOCK_KIND.TEXT || block.kind === BLOCK_KIND.TITLE || block.kind === BLOCK_KIND.LIST
        || block.kind === BLOCK_KIND.REFERENCE || block.role === BLOCK_ROLE.PAGE_NOTE;
}

function pdfPagesByIndex(pdfText) {
    const pages = Array.isArray(pdfText?.pages) ? pdfText.pages.slice(0, PDF_GEOMETRY_LIMITS.maxPages) : [];
    const pdfPages = new Map();
    for (const page of pages) {
        if (Number.isSafeInteger(page?.pageIndex) && !pdfPages.has(page.pageIndex)) pdfPages.set(page.pageIndex, page);
    }
    return pdfPages;
}

// The text items of every PDF page that has its MinerU page's shape, by page
// index, as `{ bbox, size, font, text }` in the IR's 0–1000 units.
export function pdfTextItemsByPage(ir, pdfText) {
    const pdfPages = pdfPagesByIndex(pdfText);
    const byPage = new Map();
    if (!pdfPages.size) return byPage;
    for (const page of ir.pages) {
        const pdfPage = pdfPages.get(page.pageIndex);
        const items = pdfPage ? pdfPageItems(pdfPage, page) : null;
        if (items) byPage.set(page.pageIndex, items);
    }
    return byPage;
}

// The items whose center lies inside a box, with the containment margin.
// Page items are sorted by their vertical center, so a box reads only its
// band of the page.
export function itemsInBox(bbox, items) {
    const top = bbox[1] - CONTAINMENT_MARGIN;
    let low = 0;
    let high = items.length;
    while (low < high) {
        const middle = (low + high) >> 1;
        if (items[middle].centerY < top) low = middle + 1;
        else high = middle;
    }
    const inside = [];
    for (let index = low; index < items.length && items[index].centerY <= bbox[3] + CONTAINMENT_MARGIN; index++) {
        const item = items[index];
        if (contains(bbox, (item.bbox[0] + item.bbox[2]) / 2, item.centerY)) inside.push(item);
    }
    return inside;
}

// Items grouped into lines, top to bottom, each line left to right: items
// share a line when their bottoms are within half the smaller item's height.
export function pdfLines(items) {
    const sorted = [...items].sort((left, right) => left.bbox[3] - right.bbox[3] || left.bbox[0] - right.bbox[0]);
    const lines = [];
    for (const item of sorted) {
        const height = item.bbox[3] - item.bbox[1];
        // Lines are made in order of their bottoms; only the last few can
        // be within reach of this item.
        const reach = Math.max(2, 0.5 * height);
        let from = lines.length;
        while (from > 0 && lines[from - 1].bottom >= item.bbox[3] - reach) from--;
        let line = null;
        for (let index = from; index < lines.length && !line; index++) {
            const candidate = lines[index];
            if (Math.abs(candidate.bottom - item.bbox[3]) < Math.max(2, 0.5 * Math.min(height, candidate.height))) line = candidate;
        }
        if (line) {
            line.left = Math.min(line.left, item.bbox[0]);
            line.right = Math.max(line.right, item.bbox[2]);
            line.height = Math.max(line.height, height);
            line.items.push(item);
        }
        else {
            lines.push({ bottom: item.bbox[3], height, left: item.bbox[0], right: item.bbox[2], items: [item] });
        }
    }
    lines.sort((left, right) => left.bottom - right.bottom);
    for (const line of lines) line.items.sort((left, right) => left.bbox[0] - right.bbox[0]);
    return lines;
}

// The page's text items as boxes in the IR's 0–1000 units, sorted by their
// vertical center, or null when the PDF page does not have the MinerU
// page's shape. Computed once per PDF page and MinerU page size.
const pageItemsCache = new WeakMap();
function pdfPageItems(pdfPage, irPage) {
    if (!pdfPage || typeof pdfPage !== 'object') return null;
    const key = `${irPage.width}x${irPage.height}`;
    const cached = pageItemsCache.get(pdfPage);
    if (cached?.key === key) return cached.items;
    const items = computePageItems(pdfPage, irPage);
    pageItemsCache.set(pdfPage, { key, items });
    return items;
}

function computePageItems(pdfPage, irPage) {
    const viewport = pdfPage.viewport;
    const transform = viewport?.transform;
    if (!Array.isArray(transform) || transform.length !== 6 || !transform.every(Number.isFinite)
        || !(viewport.width > 0) || !(viewport.height > 0)) {
        return null;
    }
    if (irPage.width > 0 && irPage.height > 0) {
        const pdfAspect = viewport.width / viewport.height;
        const irAspect = irPage.width / irPage.height;
        if (Math.abs(pdfAspect - irAspect) / irAspect > PDF_GEOMETRY_LIMITS.aspectTolerance) return null;
    }
    const items = [];
    for (const item of (Array.isArray(pdfPage.items) ? pdfPage.items : []).slice(0, PDF_GEOMETRY_LIMITS.maxItemsPerPage)) {
        const box = itemBox(item, transform, viewport.width, viewport.height);
        if (box) items.push(box);
    }
    return items.sort((left, right) => left.centerY - right.centerY);
}

function itemBox(item, viewport, width, height) {
    const text = typeof item?.text === 'string' ? item.text : '';
    const t = item?.transform;
    if (!text.trim() || !Array.isArray(t) || t.length !== 6 || !t.every(Number.isFinite)
        || !Number.isFinite(item.width) || item.width < 0) {
        return null;
    }
    const scale = Math.hypot(t[0], t[1]);
    const size = Math.hypot(t[2], t[3]);
    if (!(scale > 0) || !(size > 0)) return null;
    const dirX = t[0] / scale;
    const dirY = t[1] / scale;
    const x0 = t[4];
    const y0 = t[5];
    const x1 = x0 + dirX * item.width;
    const y1 = y0 + dirY * item.width;
    const upX = -dirY * size;
    const upY = dirX * size;
    const xs = [];
    const ys = [];
    for (const [x, y] of [[x0, y0], [x1, y1], [x0 + upX, y0 + upY], [x1 + upX, y1 + upY]]) {
        xs.push((viewport[0] * x + viewport[2] * y + viewport[4]) / width * 1000);
        ys.push((viewport[1] * x + viewport[3] * y + viewport[5]) / height * 1000);
    }
    const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    if (!bbox.every(Number.isFinite)) return null;
    return {
        bbox,
        size: Math.round(size * 10) / 10,
        font: typeof item.fontName === 'string' ? item.fontName.slice(0, MAX_FONT_NAME_LENGTH) : '',
        length: text.trim().length,
        text: text.trim().slice(0, MAX_ITEM_TEXT_LENGTH),
        spaceBefore: /^\s/u.test(text),
        spaceAfter: /\s$/u.test(text),
        centerY: (bbox[1] + bbox[3]) / 2,
    };
}

function measureFragment(bbox, items) {
    const inside = itemsInBox(bbox, items)
        .sort((left, right) => left.bbox[3] - right.bbox[3] || left.bbox[0] - right.bbox[0]);
    if (!inside.length) return null;
    const lines = pdfLines(inside);
    const left = Math.min(...lines.map(line => line.left));
    const right = Math.max(...lines.map(line => line.right));
    const width = right - left;
    const lineHeight = median(lines.map(line => line.height));
    const fonts = new Map();
    for (const item of inside) fonts.set(item.font, (fonts.get(item.font) || 0) + item.length);
    return {
        lines: lines.length,
        lastFill: width > 0 ? round2((lines.at(-1).right - left) / width) : 1,
        firstIndent: lineHeight > 0 ? round2((lines[0].left - left) / lineHeight) : 0,
        fontSize: median(inside.map(item => item.size)),
        font: [...fonts].sort((a, b) => b[1] - a[1])[0][0],
    };
}

function contains(bbox, x, y) {
    return x >= bbox[0] - CONTAINMENT_MARGIN && x <= bbox[2] + CONTAINMENT_MARGIN
        && y >= bbox[1] - CONTAINMENT_MARGIN && y <= bbox[3] + CONTAINMENT_MARGIN;
}

function validBox(bbox) {
    return Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite) && bbox[0] < bbox[2] && bbox[1] < bbox[3];
}

function median(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}

function round2(value) {
    return Math.round(value * 100) / 100;
}

// Whether the document starts its paragraphs with an indented first line:
// most multi-line paragraphs measured from the PDF are indented.
const MIN_INDENT_PARAGRAPHS = 5;
const MIN_INDENTED_SHARE = 0.6;
const INDENTED = 0.8;
export function indentsParagraphs(blocks) {
    let indented = 0;
    let measured = 0;
    for (const block of blocks) {
        if (block.role !== BLOCK_ROLE.BODY || block.kind !== BLOCK_KIND.TEXT || block.fragments?.length !== 1) continue;
        const geometry = block.fragments[0].pdf;
        if (!geometry || geometry.lines < 3) continue;
        measured++;
        if (geometry.firstIndent > INDENTED) indented++;
    }
    return measured >= MIN_INDENT_PARAGRAPHS && indented / measured >= MIN_INDENTED_SHARE;
}
