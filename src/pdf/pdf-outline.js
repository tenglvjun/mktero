import { pdfLines, pdfPageItems } from '../mineru/document/pdf-geometry.js';
import { outlineHeadingMatchKey } from '../markdown/markdown-outline.js';

export const MAX_PDF_OUTLINE_ENTRIES = 500;
export const MAX_PDF_OUTLINE_DEPTH = 6;
export const MAX_PDF_OUTLINE_TITLE_LENGTH = 500;

export function normalizePdfOutline(raw, depth = 1, destinations = null) {
    if (!Array.isArray(raw) || depth > MAX_PDF_OUTLINE_DEPTH) return [];
    const items = [];
    for (const node of raw) {
        if (countPdfOutlineEntries(items) >= MAX_PDF_OUTLINE_ENTRIES) break;
        const title = String(node?.title || '')
            .trim()
            .slice(0, MAX_PDF_OUTLINE_TITLE_LENGTH);
        const children = Array.isArray(node?.items)
            ? normalizePdfOutline(node.items, depth + 1, destinations)
            : [];
        if (!title) {
            for (const child of children) {
                if (countPdfOutlineEntries(items) >= MAX_PDF_OUTLINE_ENTRIES) {
                    break;
                }
                items.push(child);
            }
            continue;
        }
        const item = { title, items: children };
        items.push(item);
        if (node.dest != null) destinations?.set(item, node.dest);
    }
    return items;
}

export async function readPdfOutline(document, pages, { signal } = {}) {
    const destinations = new Map();
    const outline = normalizePdfOutline(await document.getOutline?.(), 1, destinations);
    const linesByPage = new Map();
    for (const [item, target] of destinations) {
        if (signal?.aborted) break;
        try {
            const dest = typeof target === 'string'
                ? await document.getDestination(target)
                : target;
            if (!Array.isArray(dest)) continue;
            const [ref, kind, left, top] = dest;
            const pageIndex = Number.isSafeInteger(ref) ? ref : await document.getPageIndex(ref);
            const page = pages[pageIndex];
            if (!page) continue;
            const y = bookmarkTop(page.viewport, kind?.name, left, top);
            if (y === null) continue;
            if (!linesByPage.has(pageIndex)) {
                linesByPage.set(pageIndex, pdfLines(pdfPageItems(page, page.viewport) || []));
            }
            const heading = findPrintedHeading(item.title, y, linesByPage.get(pageIndex));
            if (heading) item.heading = { ...heading, pageIndex };
        }
        catch {
            // A broken destination still has a title usable for alignment.
        }
    }
    return outline;
}

function bookmarkTop(viewport, kind, left, top) {
    const [, xToY, , yToY, , offsetY] = viewport.transform;
    const y = kind === 'XYZ' ? top : kind === 'FitH' || kind === 'FitBH' ? left : null;
    const x = kind === 'XYZ' ? left : null;
    if (!Number.isFinite(y) || xToY !== 0 && !Number.isFinite(x)) return null;
    return (xToY * (x ?? 0) + yToY * y + offsetY) / viewport.height * 1000;
}

function findPrintedHeading(title, y, lines) {
    const key = outlineHeadingMatchKey(title);
    if (!key) return null;
    const matches = [];
    for (const line of lines) {
        const top = line.bottom - line.height;
        if (y < top - 12 || y > line.bottom + 12) continue;
        const text = line.items.map(item => item.text).join(' ');
        const bbox = [line.left, top, line.right, line.bottom];
        if (text.length <= MAX_PDF_OUTLINE_TITLE_LENGTH
            && bbox.every(value => value >= 0 && value <= 1000)
            && bbox[2] > bbox[0]
            && outlineHeadingMatchKey(text) === key) {
            matches.push({ text, bbox });
        }
    }
    return matches.length === 1 ? matches[0] : null;
}

export function validatePdfOutline(outline, pageCount = Infinity) {
    if (outline === undefined) return;
    if (!Array.isArray(outline)
        || countPdfOutlineEntries(outline) > MAX_PDF_OUTLINE_ENTRIES) {
        throw new Error('Invalid PDF outline');
    }
    validatePdfOutlineNodes(outline, 1, pageCount);
}

function validatePdfOutlineNodes(nodes, depth, pageCount) {
    if (depth > MAX_PDF_OUTLINE_DEPTH) {
        throw new Error('Invalid PDF outline');
    }
    for (const node of nodes) {
        if (typeof node?.title !== 'string'
            || !node.title
            || node.title.length > MAX_PDF_OUTLINE_TITLE_LENGTH
            || node.heading !== undefined && !validHeading(node.heading, pageCount)
            || !Array.isArray(node.items)) {
            throw new Error('Invalid PDF outline');
        }
        validatePdfOutlineNodes(node.items, depth + 1, pageCount);
    }
}

function validHeading(heading, pageCount) {
    const box = heading?.bbox;
    return Number.isSafeInteger(heading?.pageIndex) && heading.pageIndex >= 0
        && heading.pageIndex < pageCount
        && typeof heading.text === 'string' && heading.text.length > 0
        && heading.text.length <= MAX_PDF_OUTLINE_TITLE_LENGTH
        && Array.isArray(box) && box.length === 4
        && box.every(value => Number.isFinite(value) && value >= 0 && value <= 1000)
        && box[2] > box[0] && box[3] > box[1];
}

function countPdfOutlineEntries(nodes) {
    if (!Array.isArray(nodes)) return 0;
    let count = 0;
    for (const node of nodes) {
        count += 1 + countPdfOutlineEntries(node?.items);
        if (count > MAX_PDF_OUTLINE_ENTRIES) return count;
    }
    return count;
}
