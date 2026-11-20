import { findTextOccurrences } from '../markdown/text-normalization.js';
import {
    createHyphenFoldedPdfAnnotationTextIndex,
    createPdfAnnotationTextIndex,
    expandPdfAnnotationSourceRange,
    normalizePdfAnnotationText,
} from '../markdown/pdf-annotation-text.js';
import {
    createVisibleMarkdownTextIndex,
    expandMarkdownRangeToMathBoundaries,
    unescapeImageMathText,
} from '../markdown/markdown-visible-text.js';
import {
    leadingCodePoints,
    MAX_PDF_ANNOTATION_TEXT_QUOTE_CONTEXT_CODE_POINTS,
    normalizePDFAnnotationTextQuote,
    trailingCodePoints,
} from './pdf-annotation.js';
import { resolvePDFPageIndexHint } from './markdown-source-map.js';
import {
    createMathCompactTextIndex,
    findMathCompactOccurrences,
    hasMathMarkup,
    mathCompactText,
} from '../markdown/math-compact-text.js';

const MAX_MATCHABLE_MARKDOWN_LENGTH = 8 * 1024 * 1024;
const MAX_MATCH_CANDIDATES = 10_000;
const MIN_TEXT_QUOTE_CONTEXT_MATCH_LENGTH = 12;
const MAX_FOLDED_TEXT_QUOTE_CONTEXT_CODE_POINTS
    = MAX_PDF_ANNOTATION_TEXT_QUOTE_CONTEXT_CODE_POINTS * 2;

export class MarkdownAnnotationOverlay {
    constructor({
        extractor,
        locateTextQuote = null,
        onError = () => {},
    }) {
        if (!extractor?.extract) {
            throw new TypeError('An annotation extractor is required');
        }
        if (locateTextQuote !== null && typeof locateTextQuote !== 'function') {
            throw new TypeError('A PDF text quote locator must be a function');
        }
        this.extractor = extractor;
        this.locateTextQuote = locateTextQuote;
        this.onError = onError;
    }

    async resolve(itemID, markdown, { sourceMap = null } = {}) {
        if (typeof markdown !== 'string') {
            throw new TypeError('Markdown must be a string');
        }
        try {
            return await this.#resolve(itemID, markdown, sourceMap);
        }
        catch (error) {
            try {
                this.onError(error);
            }
            catch {
                // Annotation diagnostics must not make PDF conversion fail.
            }
            return {
                ...createEmptyAnnotationOverlay(),
                warning: 'Zotero PDF annotations could not be loaded.',
            };
        }
    }

    async #resolve(itemID, markdown, sourceMap) {
        const annotations = await this.extractor.extract(itemID);
        if (!annotations.length) return createEmptyAnnotationOverlay();
        if (markdown.length > MAX_MATCHABLE_MARKDOWN_LENGTH) {
            throw new Error(
                'Markdown exceeds the PDF annotation matching safety limit'
            );
        }
        const state = {
            index: createVisibleMarkdownTextIndex(markdown, [], {
                imageMath: true,
            }),
            normalizedIndex: null,
            mathBoundaryIndex: null,
            lineWrappedIndex: null,
            mathCompactIndex: null,
            previousSourceTo: 0,
        };
        const matched = [];
        const unmatched = [];
        const context = { itemID, markdown, sourceMap };

        for (const annotation of annotations) {
            const before = state.previousSourceTo;
            let result = await this.#match(
                context,
                state,
                annotation,
                annotation.text
            );
            // A caption highlight saved before the reader undid an image
            // description's doubled backslash still reads "\\Delta". Its
            // text is also tried as the reader now reads it, and the two must
            // not land in different places.
            const legacyText = unescapeImageMathText(annotation.text);
            if (legacyText !== annotation.text && result.reason !== 'ambiguous') {
                state.previousSourceTo = before;
                const legacy = await this.#match(
                    context,
                    state,
                    annotation,
                    legacyText
                );
                result = pickTextVariant(result, legacy);
                state.previousSourceTo = result.annotation
                    ? Math.max(before, result.annotation.ranges[0].to)
                    : before;
            }
            if (result.annotation) matched.push(result.annotation);
            else unmatched.push({ ...annotation, reason: result.reason });
        }
        return { matched, unmatched };
    }

    async #match({ itemID, markdown, sourceMap }, state, annotation, text) {
        const candidateResult = findTextOccurrences(
            state.index.text,
            text,
            MAX_MATCH_CANDIDATES
        );
        const candidates = candidateResult.offsets;
        const exactRanges = candidateResult.truncated
            ? []
            : candidates.map(candidate => expandMarkdownRangeToMathBoundaries(
                markdown,
                expandPdfAnnotationSourceRange(
                    markdown,
                    state.index.sourceRange(candidate, text.length)
                )
            ));
        const exactPageRanges = selectPageCandidates(
            exactRanges,
            annotation.pageIndex,
            sourceMap,
            markdown.length
        );
        let exactRange = selectCandidateRange(
            exactPageRanges,
            state.previousSourceTo
        );
        if (!exactRange && exactPageRanges.length > 1) {
            const textQuote = await this.#locateTextQuote(
                itemID,
                annotation
            );
            if (textQuote) {
                state.normalizedIndex ||= createPdfAnnotationTextIndex(
                    state.index.text,
                    offset => state.index.sourceOffsetAt(offset)
                );
                exactRange = selectTextQuoteCandidateRange(
                    exactPageRanges,
                    state.normalizedIndex,
                    textQuote
                );
            }
        }
        if (exactRange) {
            return matchedAnnotation(state, resolvedAnnotation(
                annotation,
                'exact',
                exactRange
            ));
        }
        const normalizedText = normalizePdfAnnotationText(text);
        if (!state.normalizedIndex && !candidates.length) {
            state.normalizedIndex = createPdfAnnotationTextIndex(
                state.index.text,
                offset => state.index.sourceOffsetAt(offset)
            );
        }
        const normalizedCandidateResult = candidates.length
            ? { offsets: [], truncated: false }
            : findTextOccurrences(
                state.normalizedIndex.text,
                normalizedText,
                MAX_MATCH_CANDIDATES
            );
        const normalizedCandidates = normalizedCandidateResult.offsets;
        const normalizedRanges = normalizedCandidateResult.truncated
            ? []
            : normalizedCandidates.map(candidate => (
                expandMarkdownRangeToMathBoundaries(
                    markdown,
                    state.normalizedIndex.sourceRange(
                        candidate,
                        normalizedText.length
                    )
                )
            ));
        const normalizedPageRanges = selectPageCandidates(
            normalizedRanges,
            annotation.pageIndex,
            sourceMap,
            markdown.length
        );
        let normalizedRange = selectCandidateRange(
            normalizedPageRanges,
            state.previousSourceTo
        );
        if (!normalizedRange && normalizedPageRanges.length > 1) {
            const textQuote = await this.#locateTextQuote(
                itemID,
                annotation
            );
            if (textQuote) {
                normalizedRange = selectTextQuoteCandidateRange(
                    normalizedPageRanges,
                    state.normalizedIndex,
                    textQuote
                );
            }
        }
        if (normalizedRange) {
            return matchedAnnotation(state, resolvedAnnotation(
                annotation,
                'normalized',
                normalizedRange
            ));
        }
        let lineWrappedResult = { ranges: [], truncated: false };
        if (!candidates.length && !normalizedCandidates.length) {
            state.lineWrappedIndex ||= createHyphenFoldedPdfAnnotationTextIndex(
                state.index.text
            );
            lineWrappedResult = lineWrappedAnnotationRanges(
                state.index, state.lineWrappedIndex, text, range => {
                    // This index has the same options as the standalone
                    // boundary helper, and is parsed once per document.
                    state.mathBoundaryIndex ||= createVisibleMarkdownTextIndex(markdown);
                    return state.mathBoundaryIndex.expandSourceRangeToMathBoundaries(range);
                }
            );
        }
        const lineWrappedPageRanges = selectPageCandidates(
            lineWrappedResult.ranges,
            annotation.pageIndex,
            sourceMap,
            markdown.length
        );
        let lineWrappedRange = selectCandidateRange(
            lineWrappedPageRanges,
            state.previousSourceTo
        );
        if (!lineWrappedRange && lineWrappedPageRanges.length > 1) {
            const textQuote = await this.#locateTextQuote(itemID, annotation);
            if (textQuote) {
                lineWrappedRange = selectTextQuoteCandidateRange(
                    lineWrappedPageRanges,
                    state.normalizedIndex,
                    textQuote
                );
            }
        }
        if (lineWrappedRange) {
            return matchedAnnotation(state, resolvedAnnotation(
                annotation,
                'normalized',
                lineWrappedRange
            ));
        }
        // A formula's TeX and its PDF glyphs only agree once both are
        // reduced to the symbols they print. This runs last, and only for
        // text that carries math, so prose keeps its stricter matches.
        let mathCompactCandidates = [];
        if (!candidates.length
            && !normalizedCandidates.length
            && !lineWrappedResult.ranges.length
            && !lineWrappedResult.truncated
            && hasMathMarkup(text)) {
            state.mathCompactIndex ||= createMathCompactTextIndex(
                state.index.text
            );
            mathCompactCandidates = mathCompactAnnotationRanges(
                markdown,
                state.index,
                state.mathCompactIndex,
                text
            );
            const mathCompactRange = selectCandidateRange(
                selectPageCandidates(
                    mathCompactCandidates,
                    annotation.pageIndex,
                    sourceMap,
                    markdown.length
                ),
                state.previousSourceTo
            );
            if (mathCompactRange) {
                return matchedAnnotation(state, resolvedAnnotation(
                    annotation,
                    'normalized',
                    mathCompactRange
                ));
            }
        }
        const ambiguous = mathCompactCandidates.length > 1
            || candidateResult.truncated
            || candidates.length
            || normalizedCandidateResult.truncated
            || normalizedCandidates.length
            || lineWrappedResult.truncated
            || lineWrappedResult.ranges.length;
        return { reason: ambiguous ? 'ambiguous' : 'not-found' };
    }

    async #locateTextQuote(itemID, annotation) {
        if (!this.locateTextQuote) return null;
        try {
            return normalizePDFAnnotationTextQuote(
                await this.locateTextQuote(itemID, annotation)
            );
        }
        catch (error) {
            try {
                this.onError(error);
            }
            catch {
                // Context diagnostics must not hide PDF annotations.
            }
            return null;
        }
    }
}

// Either reading may be the one the highlight was made on, so a place only
// one of them finds is kept when the other finds no place at all.
function pickTextVariant(saved, legacy) {
    if (saved.reason === 'ambiguous' || legacy.reason === 'ambiguous') {
        return { reason: 'ambiguous' };
    }
    if (saved.annotation && legacy.annotation) {
        const [left] = saved.annotation.ranges;
        const [right] = legacy.annotation.ranges;
        return left.from === right.from && left.to === right.to
            ? saved
            : { reason: 'ambiguous' };
    }
    return saved.annotation ? saved : legacy;
}

function matchedAnnotation(state, annotation) {
    state.previousSourceTo = Math.max(
        state.previousSourceTo,
        annotation.ranges[0].to
    );
    return { annotation };
}

function resolvedAnnotation(annotation, matchKind, range) {
    return {
        ...annotation,
        matchKind,
        ranges: [range],
    };
}

function selectCandidateRange(ranges, previousSourceTo) {
    if (ranges.length === 1) return ranges[0];
    if (!previousSourceTo) return null;
    const following = ranges.filter(range => range.from >= previousSourceTo);
    return following.length === 1 ? following[0] : null;
}

function selectTextQuoteCandidateRange(
    ranges,
    normalizedIndex,
    textQuote
) {
    if (!textQuote) return null;
    const exactContexts = ranges.map(range => textQuoteContextMatchesRange(
        normalizedIndex,
        range,
        textQuote,
        normalizePdfAnnotationText,
        MAX_PDF_ANNOTATION_TEXT_QUOTE_CONTEXT_CODE_POINTS
    ));
    const exactMatches = ranges.filter((_, index) => (
        exactContexts[index].complete
    ));
    if (exactMatches.length) {
        return exactMatches.length === 1 ? exactMatches[0] : null;
    }
    const foldHyphens = value => (
        createHyphenFoldedPdfAnnotationTextIndex(value).text.trim()
    );
    const foldedContexts = ranges.map(range => textQuoteContextMatchesRange(
        normalizedIndex,
        range,
        textQuote,
        foldHyphens,
        MAX_FOLDED_TEXT_QUOTE_CONTEXT_CODE_POINTS
    ));
    const foldedMatches = ranges.filter((_, index) => (
        foldedContexts[index].complete
    ));
    if (foldedMatches.length) {
        return foldedMatches.length === 1 ? foldedMatches[0] : null;
    }
    // PDF text can put a page header or another column beside the quote.
    // Keep a unique surviving side only when the other side finds no place;
    // conflicting evidence, including after hyphen folding, stays ambiguous.
    const prefixMatches = ranges.filter((_, index) => (
        exactContexts[index].prefix || foldedContexts[index].prefix
    ));
    const suffixMatches = ranges.filter((_, index) => (
        exactContexts[index].suffix || foldedContexts[index].suffix
    ));
    if (prefixMatches.length && suffixMatches.length) return null;
    const matches = prefixMatches.length ? prefixMatches : suffixMatches;
    return matches.length === 1 ? matches[0] : null;
}

function textQuoteContextMatchesRange(
    normalizedIndex,
    range,
    textQuote,
    normalizeContext,
    contextCodePoints
) {
    const normalizedRange = normalizedIndex.normalizedRangeForSourceRange(
        range.from,
        range.to
    );
    const prefix = normalizeContext(textQuote.prefix);
    const suffix = normalizeContext(textQuote.suffix);
    const matches = { prefix: false, suffix: false, complete: false };
    const comparisons = [];
    if (prefix.length >= MIN_TEXT_QUOTE_CONTEXT_MATCH_LENGTH) {
        const before = normalizeContext(trailingCodePoints(
            normalizedIndex.text,
            contextCodePoints,
            normalizedRange.from
        ));
        matches.prefix = before.endsWith(prefix);
        comparisons.push(matches.prefix);
    }
    if (suffix.length >= MIN_TEXT_QUOTE_CONTEXT_MATCH_LENGTH) {
        const after = normalizeContext(leadingCodePoints(
            normalizedIndex.text,
            contextCodePoints,
            normalizedRange.to
        ));
        matches.suffix = after.startsWith(suffix);
        comparisons.push(matches.suffix);
    }
    matches.complete = comparisons.length > 0 && comparisons.every(Boolean);
    return matches;
}

function selectPageCandidates(ranges, pageIndex, sourceMap, documentLength) {
    if (ranges.length <= 1
        || !Number.isInteger(pageIndex)
        || pageIndex < 0
        || !Array.isArray(sourceMap)) {
        return ranges;
    }

    const pageCandidates = [];
    let hasPageEvidence = false;
    let hasUnknownCandidate = false;
    for (const range of ranges) {
        const candidatePage = resolvePDFPageIndexHint(
            sourceMap,
            range,
            documentLength
        );
        if (candidatePage === null) {
            hasUnknownCandidate = true;
            continue;
        }
        hasPageEvidence = true;
        if (candidatePage === pageIndex) pageCandidates.push(range);
    }
    return hasPageEvidence && !hasUnknownCandidate
        ? pageCandidates
        : ranges;
}

export function createEmptyAnnotationOverlay() {
    return { matched: [], unmatched: [] };
}

// Folding hyphens only finds candidates. Each full candidate still has to
// agree character for character, except a letter-to-letter line-end hyphen
// may join with or without its hyphen. Ordinary word spaces and unwrapped
// lexical hyphens cannot disappear. All valid interpretations compete.
function lineWrappedAnnotationRanges(visibleIndex, foldedIndex, text, expandMathRange) {
    const target = createPdfAnnotationTextIndex(text).text.trim();
    const key = createHyphenFoldedPdfAnnotationTextIndex(text).text.trim();
    if (!key) return { ranges: [], truncated: false };
    const candidates = findTextOccurrences(foldedIndex.text, key, MAX_MATCH_CANDIDATES);
    if (candidates.truncated) return { ranges: [], truncated: true };
    const ranges = [];
    let verifiedCharacters = 0;
    for (const offset of candidates.offsets) {
        const visibleRange = foldedIndex.sourceRange(offset, key.length);
        verifiedCharacters += visibleRange.to - visibleRange.from;
        if (verifiedCharacters > MAX_MATCHABLE_MARKDOWN_LENGTH) {
            return { ranges: [], truncated: true };
        }
        const source = createPdfAnnotationTextIndex(
            visibleIndex.text.slice(visibleRange.from, visibleRange.to)
        ).text.trim();
        if (!lineWrappedTextMatches(target, source)) continue;
        ranges.push(expandMathRange(
            visibleIndex.sourceRange(visibleRange.from, visibleRange.to - visibleRange.from)
        ));
    }
    return { ranges, truncated: false };
}

function lineWrappedTextMatches(left, right) {
    let leftOffset = 0;
    let rightOffset = 0;
    while (leftOffset < left.length && rightOffset < right.length) {
        const leftWrapped = isWrappedHyphen(left, leftOffset);
        const rightWrapped = isWrappedHyphen(right, rightOffset);
        if (left[leftOffset] === right[rightOffset]) {
            leftOffset += leftWrapped ? 2 : 1;
            rightOffset += rightWrapped ? 2 : 1;
        }
        else if (leftWrapped) leftOffset += 2;
        else if (rightWrapped) rightOffset += 2;
        else return false;
    }
    return leftOffset === left.length && rightOffset === right.length;
}

function isWrappedHyphen(text, offset) {
    return text[offset] === '-' && text[offset + 1] === ' '
        && /\p{L}$/u.test(text.slice(Math.max(0, offset - 2), offset))
        && /^\p{L}/u.test(text.slice(offset + 2, offset + 4));
}

// Maps each math-compact occurrence of `text` through the visible index back
// to Markdown, grown to whole formulas so no delimiter is left behind.
function mathCompactAnnotationRanges(markdown, visibleIndex, compactIndex, text) {
    // A Zotero highlight's text is PDF text-layer text, so a misencoded
    // operator ("Ð" for \bigcup) reads back as the glyph it stands for.
    const key = createMathCompactTextIndex(text, { pdfTextLayer: true }).text;
    const offsets = findMathCompactOccurrences(compactIndex, key);
    if (!offsets) return [];
    return offsets.flatMap(offset => {
        const visibleRange = compactIndex.sourceRange(offset, key.length);
        if (!visibleRange) return [];
        const sourceRange = visibleIndex.sourceRange(
            visibleRange.from,
            visibleRange.to - visibleRange.from
        );
        return [expandMarkdownRangeToMathBoundaries(markdown, sourceRange)];
    });
}
