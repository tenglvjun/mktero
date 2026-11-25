import {
    isSupportedAITargetLanguage,
} from '../config/ai-preferences.js';
import { createVisibleMarkdownTextIndex } from '../markdown/markdown-visible-text.js';

export function normalizeTranslationPresentation(value = {}) {
    const language = String(value?.language || '').trim();
    const sourceFallback = Boolean(value?.sourceFallback);
    return Object.freeze({
        language: !sourceFallback && isSupportedAITargetLanguage(language)
            ? language
            : '',
        sourceFallback,
    });
}

export function sameTranslationPresentation(left, right) {
    return left?.language === right?.language
        && left?.sourceFallback === right?.sourceFallback;
}

export function applyTranslationPresentation(element, value) {
    const presentation = normalizeTranslationPresentation(value);
    if (presentation.language) {
        element.classList.add('cm-mktero-translation-block');
        element.setAttribute('lang', presentation.language);
    }
    if (presentation.sourceFallback) {
        element.classList.add('cm-mktero-translation-failure-block');
    }
}

// blockRanges is the current view index, not the stored translation records.
// Its units are verified sentences or structurally paired figure captions.
export function projectSourceAnnotationRanges(ranges, options) {
    return projectSourceAnnotation(ranges, options).ranges;
}

// Project source ranges into the Translation view and report the granularity of a fallback.
export function projectSourceAnnotation(ranges, options) {
    const {
        sourceMarkdown, translatedMarkdown, blockRanges, groupedPDFSelection, getSourceTextIndex,
    } = options || {};
    if (typeof sourceMarkdown !== 'string' || typeof translatedMarkdown !== 'string'
        || !Array.isArray(ranges) || !Array.isArray(blockRanges)) {
        return { ranges: [], fallback: null };
    }

    const selected = ranges.filter(range => boundedRange(range?.from, range?.to, 0, sourceMarkdown.length))
        .sort(compareRanges);
    if (!selected.length) return { ranges: [], fallback: null };
    const coverage = [];
    // Prefix maxima let us binary-search the first overlap without merging
    // the original segments used for verbatim projection.
    const selectionEnds = [];
    for (const { from, to } of selected) {
        const last = coverage.at(-1);
        if (last && from <= last.to) last.to = Math.max(last.to, to);
        else coverage.push({ from, to });
        selectionEnds.push(coverage.at(-1).to);
    }
    const coverageEnds = coverage.map(range => range.to);
    let visibleIndex;
    const covers = (from, to) => {
        const start = firstEndAfter(coverageEnds, from);
        const first = coverage[start];
        if (first?.from <= from && first.to >= to) return true;
        if (!groupedPDFSelection || !first || first.from >= to) return false;
        // PDF text quotes may omit markup or whitespace at a page boundary.
        // Only bridge gaps containing no visible text.
        visibleIndex ||= getSourceTextIndex?.()
            || createVisibleMarkdownTextIndex(sourceMarkdown, [], { imageMath: true });
        let cursor = from;
        for (let index = start; index < coverage.length && coverage[index].from < to; index++) {
            const part = coverage[index];
            if (cursor < part.from && visibleIndex.text.slice(
                visibleIndex.visibleOffsetAt(cursor), visibleIndex.visibleOffsetAt(part.from)
            ).trim()) return false;
            cursor = part.to;
            if (cursor >= to) return true;
        }
        return !visibleIndex.text.slice(
            visibleIndex.visibleOffsetAt(cursor), visibleIndex.visibleOffsetAt(to)
        ).trim();
    };

    const projected = [];
    let fallback = null;
    for (const block of blockRanges) {
        if (!block) continue;
        const caption = block.figureCaption;
        const sourceFrom = caption?.sourceRanges?.[0]?.from ?? block.sourceFrom;
        const sourceTo = caption?.sourceRanges?.[0]?.to ?? block.sourceTo;
        const { translatedFrom, translatedTo } = caption || block;
        if (!boundedRange(sourceFrom, sourceTo, 0, sourceMarkdown.length)
            || !boundedRange(translatedFrom, translatedTo, 0, translatedMarkdown.length)
            || sourceTo <= coverage[0].from || sourceFrom >= coverage.at(-1).to) continue;
        const first = firstEndAfter(selectionEnds, sourceFrom);
        if (!selected[first] || selected[first].from >= sourceTo) continue;

        const source = sourceMarkdown.slice(sourceFrom, sourceTo);
        if (sourceTo - sourceFrom === translatedTo - translatedFrom
            && source === translatedMarkdown.slice(translatedFrom, translatedTo)) {
            for (let i = first; i < selected.length && selected[i].from < sourceTo; i++) {
                const from = Math.max(sourceFrom, selected[i].from);
                const to = Math.min(sourceTo, selected[i].to);
                if (from < to) projected.push({
                    from: translatedFrom + (from - sourceFrom),
                    to: translatedFrom + (to - sourceFrom),
                });
            }
        }
        else if (caption && block.alignmentUnits?.[0]?.sourceKind === 'caption') {
            projected.push({ from: translatedFrom, to: translatedTo });
            fallback = 'caption';
        }
        else if (covers(sourceFrom, sourceTo) || coversVisibleBlock(source, sourceFrom, covers)) {
            projected.push({ from: translatedFrom, to: translatedTo });
        }
        else if (Array.isArray(block.alignmentUnits)) {
            for (const unit of block.alignmentUnits) {
                const from = unit?.translatedFrom;
                const to = unit?.translatedTo;
                if (typeof unit?.id !== 'string' || !unit.id
                    || !boundedRange(from, to, translatedFrom, translatedTo)) continue;
                if (coversSourceUnit(unit.sourceRanges, sourceFrom, sourceTo, covers)) {
                    projected.push({ from, to });
                }
                else if (selectionWithinSourceUnit(
                    selected,
                    unit.sourceRanges,
                    sourceFrom,
                    sourceTo,
                    Boolean(caption)
                )) {
                    projected.push({ from, to });
                    fallback ||= 'sentence';
                }
            }
        }
    }
    const unique = projected.sort(compareRanges).filter((range, index) => (
        index === 0 || compareRanges(projected[index - 1], range) !== 0
    ));
    return { ranges: unique, fallback };
}

function boundedRange(from, to, lower, upper) {
    return Number.isSafeInteger(from) && Number.isSafeInteger(to)
        && lower <= from && from < to && to <= upper;
}

function compareRanges(left, right) {
    return left.from - right.from || left.to - right.to;
}

function firstEndAfter(ends, offset) {
    let low = 0;
    let high = ends.length;
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (ends[mid] <= offset) low = mid + 1;
        else high = mid;
    }
    return low;
}

function coversSourceUnit(ranges, lower, upper, covers) {
    if (!Array.isArray(ranges) || !ranges.length) return false;
    for (const range of ranges) {
        if (!boundedRange(range?.from, range?.to, lower, upper)
            || !covers(range.from, range.to)) return false;
    }
    return true;
}

function selectionWithinSourceUnit(selection, ranges, blockFrom, blockTo, clipToCaption) {
    if (!Array.isArray(ranges) || ranges.length !== 1 || !selection.length) return false;
    const [sourceRange] = ranges;
    if (!boundedRange(sourceRange?.from, sourceRange?.to, blockFrom, blockTo)) return false;
    const inBlock = selection.filter(selected => (
        selected.from < blockTo && selected.to > blockFrom
    ));
    return inBlock.length > 0 && inBlock.every(selected => {
        const from = clipToCaption ? Math.max(selected.from, blockFrom) : selected.from;
        const to = clipToCaption ? Math.min(selected.to, blockTo) : selected.to;
        return from >= sourceRange.from && to <= sourceRange.to;
    });
}

function coversVisibleBlock(source, offset, covers) {
    // PDF quote matching returns the first and last visible characters, not
    // the surrounding Markdown markers. Build the same index only for a
    // touched, rewritten block that the annotation does not already cover.
    const index = createVisibleMarkdownTextIndex(source, [], { imageMath: true });
    const text = index.text.trimStart();
    const length = text.trimEnd().length;
    if (!length) return false;
    const { from, to } = index.sourceRange(index.text.length - text.length, length);
    return covers(offset + from, offset + to);
}
