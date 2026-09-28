import {
    isValidSourceLocation,
    isValidSourceMapEntry,
} from './markdown-source-map.js';
import { normalizeCompactText } from '../markdown/text-normalization.js';

const MAX_SELECTION_PAGES = 2;
const MAX_RECTS_PER_PAGE = 1_000;
const UNIQUE_COVERAGE = 0.6;
const CLEAR_RUNNER_UP = 0.3;
const AMBIGUOUS_COVERAGE = 0.4;

export function pdfSelectionPagesFromAnnotation(annotation) {
    const position = annotation?.position;
    const pageIndex = position?.pageIndex;
    const rects = normalizeRectList(position?.rects);
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || !rects) return null;
    const pages = [{ pageIndex, rects }];
    if (position.nextPageRects == null) return pages;
    const nextRects = normalizeRectList(position.nextPageRects);
    if (!nextRects || pageIndex >= Number.MAX_SAFE_INTEGER) return null;
    pages.push({ pageIndex: pageIndex + 1, rects: nextRects });
    return pages;
}

export function collectSourceMapSelectionTargets(sourceMap, documentLength) {
    if (!Array.isArray(sourceMap)) return [];
    const targets = [];
    for (const entry of sourceMap) {
        if (!isValidSourceMapEntry(entry, documentLength)) continue;
        const ranges = selectionRangesForEntry(entry);
        for (const range of ranges) {
            if (!isValidSourceLocation(range.location)
                || !containedRange(range, entry)) {
                continue;
            }
            targets.push({
                markdownFrom: range.markdownFrom,
                markdownTo: range.markdownTo,
                pageIndex: range.location.pageIndex,
                bbox: [...range.location.bbox],
            });
        }
    }
    return targets;
}

export function selectionCandidatesFromTargets(targets, rectForBBox) {
    if (!Array.isArray(targets) || typeof rectForBBox !== 'function') return null;
    const candidates = [];
    for (const target of targets) {
        if (!isValidSourceLocation(target)
            || !validMarkdownRange(target.markdownFrom, target.markdownTo)) {
            return null;
        }
        let rect;
        try {
            rect = rectForBBox(target.pageIndex, target.bbox);
        }
        catch {
            return null;
        }
        const normalized = normalizeRect(rect);
        if (!normalized) return null;
        candidates.push({
            markdownFrom: target.markdownFrom,
            markdownTo: target.markdownTo,
            pageIndex: target.pageIndex,
            rect: normalized,
        });
    }
    return candidates;
}

export function resolvePdfSelectionSource({ pages, candidates } = {}) {
    if (!Array.isArray(pages)
        || pages.length < 1
        || pages.length > MAX_SELECTION_PAGES
        || !Array.isArray(candidates)) {
        return null;
    }
    const ranges = [];
    for (const page of pages) {
        const rects = normalizeRectList(page?.rects);
        if (!Number.isSafeInteger(page?.pageIndex)
            || page.pageIndex < 0
            || !rects) {
            return null;
        }
        const match = matchPage(page.pageIndex, rects, candidates);
        if (!match) return null;
        ranges.push(match);
    }
    return combineRanges(ranges);
}

const MIN_UNIQUE_SELECTION_TEXT = 48;

export function maximumPdfSelectionCoverage({ pages, candidates } = {}) {
    if (!Array.isArray(pages) || !Array.isArray(candidates)) return 0;
    let maximum = 0;
    for (const page of pages) {
        const rects = normalizeRectList(page?.rects);
        if (!Number.isSafeInteger(page?.pageIndex) || !rects) continue;
        const selectionArea = rects.reduce((sum, rect) => sum + area(rect), 0);
        if (selectionArea <= 0) continue;
        for (const candidate of candidates) {
            if (candidate?.pageIndex !== page.pageIndex) continue;
            const rect = normalizeRect(candidate.rect);
            if (!rect) continue;
            const covered = rects.reduce(
                (sum, selection) => sum + intersectionArea(selection, rect),
                0
            );
            maximum = Math.max(maximum, Math.min(1, covered / selectionArea));
        }
    }
    return maximum;
}

export function resolveUniqueSelectionText({ markdown, sourceMap, text } = {}) {
    if (typeof markdown !== 'string' || !Array.isArray(sourceMap)) return null;
    const needle = normalizeCompactText(text);
    if (needle.length < MIN_UNIQUE_SELECTION_TEXT) return null;
    const hits = [];
    for (const entry of sourceMap) {
        if (!isValidSourceMapEntry(entry, markdown.length)) continue;
        const slice = markdown.slice(entry.markdownFrom, entry.markdownTo);
        const compact = normalizeCompactText(slice);
        const start = compact.indexOf(needle);
        if (start < 0 || compact.indexOf(needle, start + needle.length) >= 0) {
            continue;
        }
        const span = compactSpan(slice, needle) || {
            from: 0,
            to: slice.length,
        };
        if (hits.length === 1) return null;
        hits.push({
            markdownFrom: entry.markdownFrom + span.from,
            markdownTo: entry.markdownFrom + span.to,
        });
    }
    return hits[0] || null;
}

function compactSpan(source, needle) {
    const units = [];
    for (let index = 0; index < source.length; index += 1) {
        const compact = normalizeCompactText(source[index]);
        for (const unit of compact) units.push({ unit, index });
    }
    const compact = units.map(unit => unit.unit).join('');
    const start = compact.indexOf(needle);
    if (start < 0) return null;
    const end = units[start + needle.length - 1];
    if (!end) return null;
    return {
        from: units[start].index,
        to: end.index + 1,
    };
}

function selectionRangesForEntry(entry) {
    if (Array.isArray(entry.locationRanges) && entry.locationRanges.length) {
        return entry.locationRanges;
    }
    return entry.locations.map(location => ({
        markdownFrom: entry.markdownFrom,
        markdownTo: entry.markdownTo,
        location,
    }));
}

function containedRange(range, entry) {
    return Number.isSafeInteger(range?.markdownFrom)
        && Number.isSafeInteger(range?.markdownTo)
        && range.markdownFrom >= entry.markdownFrom
        && range.markdownTo <= entry.markdownTo
        && range.markdownTo > range.markdownFrom;
}

function matchPage(pageIndex, rects, candidates) {
    const selectionArea = rects.reduce((sum, rect) => sum + area(rect), 0);
    if (selectionArea <= 0) return null;
    const scored = [];
    for (const candidate of candidates) {
        if (candidate?.pageIndex !== pageIndex) continue;
        const rect = normalizeRect(candidate.rect);
        if (!rect || !validMarkdownRange(
            candidate.markdownFrom,
            candidate.markdownTo
        )) {
            continue;
        }
        const covered = rects.reduce(
            (sum, selection) => sum + intersectionArea(selection, rect),
            0
        );
        scored.push({
            coverage: Math.min(1, covered / selectionArea),
            markdownFrom: candidate.markdownFrom,
            markdownTo: candidate.markdownTo,
        });
    }
    scored.sort((left, right) => (
        right.coverage - left.coverage
        || left.markdownFrom - right.markdownFrom
        || left.markdownTo - right.markdownTo
    ));
    const best = scored[0];
    const second = scored[1]?.coverage || 0;
    if (!best
        || best.coverage < UNIQUE_COVERAGE
        || !(second < CLEAR_RUNNER_UP || second < best.coverage / 2)
        || scored.filter(item => item.coverage >= AMBIGUOUS_COVERAGE).length > 1) {
        return null;
    }
    return {
        markdownFrom: best.markdownFrom,
        markdownTo: best.markdownTo,
    };
}

function combineRanges(ranges) {
    const sorted = [...ranges].sort((left, right) => (
        left.markdownFrom - right.markdownFrom
        || left.markdownTo - right.markdownTo
    ));
    let current = { ...sorted[0] };
    for (let index = 1; index < sorted.length; index += 1) {
        const next = sorted[index];
        const overlaps = current.markdownFrom < next.markdownTo
            && next.markdownFrom < current.markdownTo;
        const adjacent = current.markdownTo === next.markdownFrom;
        if (!overlaps && !adjacent) return null;
        current = {
            markdownFrom: Math.min(current.markdownFrom, next.markdownFrom),
            markdownTo: Math.max(current.markdownTo, next.markdownTo),
        };
    }
    return current;
}

function normalizeRectList(rects) {
    if (!Array.isArray(rects) || !rects.length || rects.length > MAX_RECTS_PER_PAGE) {
        return null;
    }
    const normalized = [];
    for (const rect of rects) {
        const box = normalizeRect(rect);
        if (!box) return null;
        normalized.push(box);
    }
    return normalized;
}

function normalizeRect(rect) {
    if (!Array.isArray(rect)
        || rect.length !== 4
        || !rect.every(Number.isFinite)) {
        return null;
    }
    const left = Math.min(rect[0], rect[2]);
    const right = Math.max(rect[0], rect[2]);
    const bottom = Math.min(rect[1], rect[3]);
    const top = Math.max(rect[1], rect[3]);
    if (right <= left || top <= bottom) return null;
    return [left, bottom, right, top];
}

function intersectionArea(left, right) {
    const x1 = Math.max(left[0], right[0]);
    const y1 = Math.max(left[1], right[1]);
    const x2 = Math.min(left[2], right[2]);
    const y2 = Math.min(left[3], right[3]);
    if (x2 <= x1 || y2 <= y1) return 0;
    return (x2 - x1) * (y2 - y1);
}

function area(rect) {
    return (rect[2] - rect[0]) * (rect[3] - rect[1]);
}

function validMarkdownRange(from, to) {
    return Number.isSafeInteger(from)
        && Number.isSafeInteger(to)
        && from >= 0
        && to > from;
}
