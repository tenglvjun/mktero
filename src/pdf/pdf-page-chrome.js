import { createDehyphenatedPdfAnnotationTextIndex } from '../markdown/pdf-annotation-text.js';
import { isPageNumberLine, isPublisherWatermarkLine } from '../markdown/publisher-copyright.js';

const PAGE_EDGE_FRACTION = 0.05;
const MAX_DOCUMENT_ITEMS = 250_000;
const MAX_MARGIN_CHARACTERS = 2_000_000;
const MAX_MARGIN_ITEMS_PER_PAGE = 256;
const MAX_LINE_CHARACTERS = 2_048;
const MIN_REPEATED_LINE_CHARACTERS = 12;
const MAX_READING_ITEMS_PER_PAGE = 10_000;
const MAX_READING_PAGE_CHARACTERS = 1_000_000;
const MAX_READING_DOCUMENT_CHARACTERS = 10_000_000;
const MAX_FLOAT_SCAN_STEPS = 40_000;
const pageBodyViews = new WeakMap();
const readingViews = new WeakMap();

// This additional view is used only after the original-order lookups fail.
// It orders proven columns and separates labelled floats from the prose;
// every retained span still refers to the original immutable text index.
export function createPDFPageReadingViews(pages, { excludedItems = null } = {}) {
    const cached = excludedItems ? null : readingViews.get(pages);
    if (cached) return cached;
    if (pages.reduce((count, page) => count + (page.items?.length || 0), 0) > MAX_DOCUMENT_ITEMS
        || pages.reduce((count, page) => count + (page.rawText?.length || 0), 0) > MAX_READING_DOCUMENT_CHARACTERS) {
        const views = pages.map(page => ({ page, original: page, ranges: null }));
        if (!excludedItems) readingViews.set(pages, views);
        return views;
    }
    const layouts = pages.map(page => readingLines(page, excludedItems?.get(page)));
    const repeated = new Map();
    for (const [pageIndex, lines] of layouts.entries()) {
        for (const line of lines) {
            if (!line.margin) continue;
            const key = `${line.margin}|${line.text.replace(/\b\d+\b/gu, '#')}`;
            const entries = repeated.get(key) || [];
            entries.push({ pageIndex, line });
            repeated.set(key, entries);
        }
    }
    const views = pages.map((page, pageIndex) => {
        let lines = layouts[pageIndex];
        if (!lines.length) return { page, original: page, ranges: null };
        lines = lines.filter(line => {
            if (isPublisherWatermarkLine(line.text) || line.pageNumber) return false;
            if (!line.margin) return true;
            const key = `${line.margin}|${line.text.replace(/\b\d+\b/gu, '#')}`;
            return !repeated.get(key)?.some(other => other.pageIndex !== pageIndex
                && Math.abs(other.line.y / pages[other.pageIndex].viewport.height - line.y / page.viewport.height) < 0.01
                && Math.abs(other.line.x / pages[other.pageIndex].viewport.width - line.x / page.viewport.width) < 0.05);
        });
        lines = withoutIsolatedFloats(lines, page.viewport.width);
        return orderedView(page, columnOrder(lines, page.viewport.width));
    });
    if (!excludedItems) readingViews.set(pages, views);
    return views;
}

function readingLines(page, excludedItems) {
    if ((page.items?.length || 0) > MAX_READING_ITEMS_PER_PAGE
        || typeof page.rawText !== 'string' || page.rawText.length > MAX_READING_PAGE_CHARACTERS
        || !Number.isFinite(page.viewport?.width) || page.viewport.width <= 0
        || !Number.isFinite(page.viewport?.height) || page.viewport.height <= 0) return [];
    const positioned = [];
    let sourceEnd = 0;
    for (const item of page.items || []) {
        if (!item.text?.trim()) continue;
        if (!Number.isSafeInteger(item.sourceFrom) || !Number.isSafeInteger(item.sourceTo)
            || item.sourceFrom < sourceEnd || item.sourceTo <= item.sourceFrom
            || item.sourceTo > page.rawText.length
            || page.rawText.slice(item.sourceFrom, item.sourceTo) !== item.text) return [];
        sourceEnd = item.sourceTo;
        if (excludedItems?.has(item)) continue;
        let entry = positionedItem(page, item);
        if (!Number.isFinite(item.width) || item.width < 0) return [];
        if (!entry) {
            if (isPublisherWatermarkLine(item.text)) continue;
            const matrix = page.viewport?.transform;
            const point = item.transform;
            if (!Array.isArray(matrix) || matrix.length !== 6 || !matrix.every(Number.isFinite)
                || !Array.isArray(point) || point.length !== 6 || !point.every(Number.isFinite)
                || !Number.isFinite(item.height) || item.height <= 0) return [];
            const x = matrix[0] * point[4] + matrix[2] * point[5] + matrix[4];
            const y = matrix[1] * point[4] + matrix[3] * point[5] + matrix[5];
            if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
            entry = { item, x, y, height: item.height, rotated: true };
        }
        entry.right = entry.x + (entry.rotated ? 0 : item.width);
        if (!Number.isFinite(entry.right) || !Number.isFinite(entry.height) || entry.height <= 0) return [];
        positioned.push(entry);
    }
    if (!positioned.length) return [];
    const prose = positioned.filter(entry => entry.item.text.length >= 40 && !entry.rotated);
    const heights = (prose.length ? prose : positioned).map(entry => entry.height)
        .filter(height => height > 0).sort((a, b) => a - b);
    const bodyHeight = heights[Math.floor(heights.length / 2)];
    positioned.sort((a, b) => a.y - b.y || a.x - b.x);
    const rows = [];
    for (const entry of positioned) {
        const previous = rows.at(-1);
        if (previous && Math.abs(previous.y - entry.y) <= Math.max(1, bodyHeight * 0.8)) {
            const previousHeight = previous.height;
            previous.entries.push(entry);
            previous.height = Math.max(previous.height, entry.height);
            if (entry.height > previousHeight) previous.y = entry.y;
        }
        else rows.push({ y: entry.y, height: entry.height, entries: [entry] });
    }
    return rows.map((row, index) => {
        const entries = row.entries.sort((a, b) => a.x - b.x);
        const text = entries.map(entry => entry.item.text).join(' ').replace(/\s+/gu, ' ').trim();
        const height = Math.max(...entries.map(entry => entry.height));
        const gap = Math.min(row.y - (rows[index - 1]?.y ?? -Infinity),
            (rows[index + 1]?.y ?? Infinity) - row.y);
        const atEdge = row.y < page.viewport.height * 0.05 || row.y > page.viewport.height * 0.95;
        const isolated = atEdge ? gap >= height * 1.5 : gap >= Math.max(12, height * 2);
        const margin = isolated
            ? row.y < page.viewport.height * 0.1 ? 'top'
                : row.y > page.viewport.height * 0.9 ? 'bottom' : null
            : null;
        const pageNumber = margin && isPageNumberLine(text)
            && (text === page.pageLabel || text === String(page.pageIndex + 1));
        return { y: row.y, x: entries[0].x, right: Math.max(...entries.map(entry => entry.right)), height, text, entries, margin, pageNumber };
    });
}

function withoutIsolatedFloats(lines, width) {
    const excluded = new Set();
    let scanSteps = 0;
    const proseHeights = lines.filter(line => line.text.length >= 80).map(line => line.height).sort((a, b) => a - b);
    const bodyHeight = proseHeights[Math.floor(proseHeights.length / 2)] || 0;
    for (let index = 0; index < lines.length; index++) {
        const first = lines[index];
        if (!/^(?:Figure|Fig\.?|Table)\s+\d+[A-Za-z]?\s*[.:—–|]/u.test(first.text)
            || !isFullWidthFloatLine(first, width, true)) continue;
        const previous = lines[index - 1];
        if (previous && first.y - previous.y < first.height * 1.8) continue;
        let end = index + 1;
        while (end < lines.length && lines[end].y - lines[end - 1].y <= first.height * 1.65) end++;
        const after = lines[end];
        if (after && after.y - lines[end - 1].y < first.height * 2) continue;
        const caption = lines.slice(index, end);
        if (!caption.every(line => isFullWidthFloatLine(line, width))) continue;
        const grids = [];
        for (const direction of [-1, 1]) {
            const grid = [];
            let cursor = direction < 0 ? index - 1 : end;
            while (cursor >= 0 && cursor < lines.length) {
                if (++scanSteps > MAX_FLOAT_SCAN_STEPS) return lines;
                const row = lines[cursor];
                const shortCharacters = row.entries.reduce((count, entry) => count
                    + (entry.item.text.trim().length <= 16 ? entry.item.text.trim().length : 0), 0);
                const characters = row.entries.reduce((count, entry) => count + entry.item.text.trim().length, 0);
                const centeredLabel = row.height <= first.height * 0.65 && row.text.length <= 64
                    && row.x >= width * 0.2 && row.right <= width * 0.8;
                if (row.height > first.height * 0.9
                    || (shortCharacters < characters * 0.6 && !centeredLabel)) break;
                grid.push(row);
                cursor += direction;
            }
            if (grid.length >= 3) grids.push(...grid);
        }
        if (!grids.length && first.height > bodyHeight * 0.85) continue;
        [...caption, ...grids].forEach(line => excluded.add(line));
    }
    return lines.filter(line => !excluded.has(line));
}

function isFullWidthFloatLine(line, width, requireCrossing = false) {
    const crossing = line.entries.some(entry => entry.x < width / 2 && entry.right > width / 2);
    if (!crossing && (requireCrossing || line.right > width / 2 || line.x > width * 0.2)) return false;
    let right = line.entries[0].right;
    for (const entry of line.entries.slice(1)) {
        if (entry.x - right > Math.max(12, line.height * 2)) return false;
        right = Math.max(right, entry.right);
    }
    return true;
}

function readingEntries(line, predicate = () => true) {
    return line.entries.filter(predicate).sort((left, right) => left.item.sourceFrom - right.item.sourceFrom);
}

function columnOrder(lines, width) {
    const middle = width / 2;
    const left = lines.flatMap(line => line.entries.filter(entry => entry.right <= middle));
    const right = lines.flatMap(line => line.entries.filter(entry => entry.x >= middle));
    const leftRows = new Set(lines.filter(line => line.entries.filter(entry => entry.right <= middle)
        .reduce((count, entry) => count + entry.item.text.length, 0) >= 30).map(line => Math.round(line.y)));
    const rightRows = new Set(lines.filter(line => line.entries.filter(entry => entry.x >= middle)
        .reduce((count, entry) => count + entry.item.text.length, 0) >= 30).map(line => Math.round(line.y)));
    const paired = [...leftRows].filter(y => [-2, -1, 0, 1, 2].some(delta => rightRows.has(y + delta)));
    const originalOrder = () => lines.flatMap(line => line.entries)
        .sort((a, b) => a.item.sourceFrom - b.item.sourceFrom);
    if (paired.length < 4) return originalOrder();
    const gutterLeft = Math.max(...left.map(entry => entry.right));
    const gutterRight = Math.min(...right.map(entry => entry.x));
    if (gutterRight - gutterLeft < 6) return originalOrder();
    const result = [];
    let band = [];
    const flush = () => {
        result.push(...band.flatMap(line => readingEntries(line, entry => entry.right <= middle)),
            ...band.flatMap(line => readingEntries(line, entry => entry.x >= middle)));
        band = [];
    };
    for (const line of lines) {
        if (line.entries.some(entry => entry.x < middle && entry.right > middle)) {
            flush();
            result.push(...readingEntries(line));
        }
        else band.push(line);
    }
    flush();
    return result;
}

function orderedView(original, entries) {
    const ranges = [];
    const items = [];
    const output = [];
    let offset = 0;
    let previous = null;
    for (const entry of entries) {
        const { item } = entry;
        const rawGap = previous && item.sourceFrom >= previous.item.sourceTo
            && item.sourceFrom - previous.item.sourceTo <= 2
            ? original.rawText.slice(previous.item.sourceTo, item.sourceFrom) : null;
        const originalGap = rawGap !== null && /^\s*$/u.test(rawGap) ? rawGap : null;
        const separator = originalGap ?? (previous && Math.abs(previous.y - entry.y) <= 1
            && entry.x - previous.right < 1 ? '' : '\n');
        if (output.length) {
            output.push(separator);
            offset += separator.length;
        }
        const bodyFrom = offset;
        output.push(item.text);
        offset += item.text.length;
        ranges.push({ from: item.sourceFrom, to: item.sourceTo, bodyFrom, bodyTo: offset });
        items.push({ ...item, sourceFrom: bodyFrom, sourceTo: offset });
        previous = entry;
    }
    const rawText = output.join('');
    return { original, ranges, page: { ...original, items, rawText, normalizedText: createDehyphenatedPdfAnnotationTextIndex(rawText).text } };
}

// Only isolated lines at the physical page edges are eligible. Repetition
// is established across pages by visual order, not PDF content-stream order.
// The raw index stays untouched; each derived page keeps its original spans.
export function createPDFPageBodyViews(pages) {
    const cached = pageBodyViews.get(pages);
    if (cached) return cached;
    const linesByPage = [];
    const occurrences = new Map();
    let itemCount = 0;
    let marginCharacters = 0;
    for (const page of pages) {
        itemCount += page.items?.length || 0;
        if (itemCount > MAX_DOCUMENT_ITEMS) return unchangedViews(pages);
        const lines = marginLines(page);
        linesByPage.push(lines);
        for (const line of lines) {
            marginCharacters += line.text.length;
            if (marginCharacters > MAX_MARGIN_CHARACTERS) return unchangedViews(pages);
            const key = `${line.side}|${line.text}`;
            const entries = occurrences.get(key) || [];
            entries.push({ page, line });
            occurrences.set(key, entries);
        }
    }
    const views = pages.map((page, index) => {
        const excluded = [];
        for (const line of linesByPage[index]) {
            const repeated = occurrences.get(`${line.side}|${line.text}`);
            if (!repeated?.some(other => other.page !== page
                && Math.abs(other.line.y - line.y) <= 0.01
                && Math.abs(other.line.x - line.x) <= 0.05)) {
                continue;
            }
            excluded.push(...line.items.map(item => ({ from: item.sourceFrom, to: item.sourceTo })));
        }
        return bodyView(page, excluded);
    });
    pageBodyViews.set(pages, views);
    return views;
}

export function originalPDFBodyRanges(view, range) {
    if (!view.ranges) return [range];
    const ranges = [];
    for (const span of view.ranges) {
        if (span.bodyTo <= range.from) continue;
        if (span.bodyFrom >= range.to) break;
        const from = Math.max(span.bodyFrom, range.from);
        const to = Math.min(span.bodyTo, range.to);
        if (to > from) {
            ranges.push({
                from: span.from + from - span.bodyFrom,
                to: span.from + to - span.bodyFrom,
            });
        }
    }
    return ranges;
}

function unchangedViews(pages) {
    const views = pages.map(page => ({ page, original: page, ranges: null }));
    pageBodyViews.set(pages, views);
    return views;
}

function positionedItem(page, item) {
    const viewport = page?.viewport;
    const transform = viewport?.transform;
    const point = item?.transform;
    if (!Array.isArray(transform) || transform.length !== 6
        || !transform.every(Number.isFinite)
        || !Array.isArray(point) || point.length !== 6
        || !point.every(Number.isFinite)
        || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)
        || viewport.width <= 0 || viewport.height <= 0) {
        return null;
    }
    const x = transform[0] * point[4] + transform[2] * point[5] + transform[4];
    const y = transform[1] * point[4] + transform[3] * point[5] + transform[5];
    const alongX = transform[0] * point[0] + transform[2] * point[1];
    const alongY = transform[1] * point[0] + transform[3] * point[1];
    if (!Number.isFinite(x) || !Number.isFinite(y)
        || Math.abs(alongY) > Math.abs(alongX) * 0.05
        || x < 0 || x > viewport.width || y < 0 || y > viewport.height) {
        return null;
    }
    const relativeY = y / viewport.height;
    const side = relativeY <= PAGE_EDGE_FRACTION ? 'top'
        : relativeY >= 1 - PAGE_EDGE_FRACTION ? 'bottom' : null;
    const height = Math.hypot(
        transform[0] * point[2] + transform[2] * point[3],
        transform[1] * point[2] + transform[3] * point[3]
    );
    return { item, x, y, side, height };
}

function marginLines(page) {
    const margins = [];
    let bodyTop = Infinity;
    let bodyBottom = -Infinity;
    for (const item of page.items || []) {
        if (typeof item?.text !== 'string' || !item.text.trim()) continue;
        const positioned = positionedItem(page, item);
        if (!positioned) continue;
        if (!positioned.side) {
            bodyTop = Math.min(bodyTop, positioned.y);
            bodyBottom = Math.max(bodyBottom, positioned.y);
            continue;
        }
        if (item.text.length > MAX_LINE_CHARACTERS
            || !Number.isSafeInteger(item.sourceFrom) || !Number.isSafeInteger(item.sourceTo)
            || item.sourceFrom < 0 || item.sourceTo <= item.sourceFrom
            || page.rawText.slice(item.sourceFrom, item.sourceTo) !== item.text) {
            return [];
        }
        margins.push(positioned);
        if (margins.length > MAX_MARGIN_ITEMS_PER_PAGE) return [];
    }
    if (!Number.isFinite(bodyTop)) return [];
    margins.sort((left, right) => left.y - right.y || left.x - right.x);
    const lines = [];
    for (const positioned of margins) {
        const previous = lines.at(-1);
        if (previous && positioned.side === previous.side
            && Math.abs(positioned.y - previous.y) <= 1) {
            previous.entries.push(positioned);
        }
        else {
            lines.push({ side: positioned.side, y: positioned.y, entries: [positioned] });
        }
    }
    return lines.flatMap(line => {
        const entries = line.entries.sort((left, right) => left.x - right.x);
        const height = Math.max(...entries.map(entry => entry.height));
        const bodyDistance = line.side === 'top'
            ? bodyTop - line.y
            : line.y - bodyBottom;
        if (bodyDistance < Math.max(12, height * 1.5)) return [];
        const text = entries.map(({ item }) => (
            item.text.trim() === String(page.pageIndex + 1)
                || item.text.trim() === page.pageLabel
                ? '#page' : item.text
        )).join(' ').normalize('NFKC').replace(/\s+/gu, ' ').trim();
        if (text.length < MIN_REPEATED_LINE_CHARACTERS || text.length > MAX_LINE_CHARACTERS) return [];
        return [{
            side: line.side,
            x: entries[0].x / page.viewport.width,
            y: line.y / page.viewport.height,
            text,
            items: entries.map(entry => entry.item),
        }];
    });
}

function bodyView(original, excluded) {
    if (!excluded.length) return { page: original, original, ranges: null };
    excluded.sort((left, right) => left.from - right.from || left.to - right.to);
    const ranges = [];
    let sourceOffset = 0;
    let bodyOffset = 0;
    for (const range of [...excluded, { from: original.rawText.length, to: original.rawText.length }]) {
        if (range.from > sourceOffset) {
            const length = range.from - sourceOffset;
            ranges.push({ from: sourceOffset, to: range.from, bodyFrom: bodyOffset, bodyTo: bodyOffset + length });
            bodyOffset += length;
        }
        sourceOffset = Math.max(sourceOffset, range.to);
    }
    const rawText = ranges.map(range => original.rawText.slice(range.from, range.to)).join('');
    const items = [];
    let spanIndex = 0;
    for (const item of original.items) {
        while (spanIndex < ranges.length && ranges[spanIndex].to <= item.sourceFrom) spanIndex++;
        const span = ranges[spanIndex];
        if (!span || item.sourceFrom < span.from || item.sourceTo > span.to) continue;
        items.push({
            ...item,
            sourceFrom: span.bodyFrom + item.sourceFrom - span.from,
            sourceTo: span.bodyFrom + item.sourceTo - span.from,
        });
    }
    return {
        original,
        ranges,
        page: {
            ...original,
            rawText,
            normalizedText: createDehyphenatedPdfAnnotationTextIndex(rawText).text,
            items,
        },
    };
}
