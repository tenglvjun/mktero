import { findTextOccurrences } from '../markdown/text-normalization.js';
import {
    createDehyphenatedPdfAnnotationTextIndex,
    createHyphenFoldedPdfAnnotationTextIndex,
    createPdfAnnotationTextIndex,
    expandPdfAnnotationSourceRange,
    normalizePdfAnnotationText,
} from '../markdown/pdf-annotation-text.js';
import {
    createVisibleMarkdownTextIndex,
} from '../markdown/markdown-visible-text.js';
import {
    leadingCodePoints,
    MAX_PDF_ANNOTATION_TEXT_QUOTE_CONTEXT_CODE_POINTS,
    normalizePDFAnnotationTextQuote,
    trailingCodePoints,
} from './pdf-annotation.js';
import { resolvePDFPageIndexHint } from './markdown-source-map.js';

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
        const index = createVisibleMarkdownTextIndex(markdown);
        let normalizedIndex = null;
        let dehyphenatedIndex = null;
        const matched = [];
        const unmatched = [];
        let previousSourceTo = 0;

        for (const annotation of annotations) {
            const candidateResult = findTextOccurrences(
                index.text,
                annotation.text,
                MAX_MATCH_CANDIDATES
            );
            const candidates = candidateResult.offsets;
            const exactRanges = candidateResult.truncated
                ? []
                : candidates.map(candidate => expandPdfAnnotationSourceRange(
                    markdown,
                    index.sourceRange(candidate, annotation.text.length)
                ));
            const exactPageRanges = selectPageCandidates(
                exactRanges,
                annotation.pageIndex,
                sourceMap,
                markdown.length
            );
            let exactRange = selectCandidateRange(
                exactPageRanges,
                previousSourceTo
            );
            if (!exactRange && exactPageRanges.length > 1) {
                const textQuote = await this.#locateTextQuote(
                    itemID,
                    annotation
                );
                if (textQuote) {
                    normalizedIndex ||= createPdfAnnotationTextIndex(
                        index.text,
                        offset => index.sourceOffsetAt(offset)
                    );
                    exactRange = selectTextQuoteCandidateRange(
                        exactPageRanges,
                        normalizedIndex,
                        textQuote
                    );
                }
            }
            if (exactRange) {
                matched.push(resolvedAnnotation(
                    annotation,
                    'exact',
                    exactRange
                ));
                previousSourceTo = Math.max(previousSourceTo, exactRange.to);
                continue;
            }
            const normalizedText = normalizePdfAnnotationText(annotation.text);
            if (!normalizedIndex && !candidates.length) {
                normalizedIndex = createPdfAnnotationTextIndex(
                    index.text,
                    offset => index.sourceOffsetAt(offset)
                );
            }
            const normalizedCandidateResult = candidates.length
                ? { offsets: [], truncated: false }
                : findTextOccurrences(
                    normalizedIndex.text,
                    normalizedText,
                    MAX_MATCH_CANDIDATES
                );
            const normalizedCandidates = normalizedCandidateResult.offsets;
            const normalizedRanges = normalizedCandidateResult.truncated
                ? []
                : normalizedCandidates.map(candidate => (
                    normalizedIndex.sourceRange(
                        candidate,
                        normalizedText.length
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
                previousSourceTo
            );
            if (!normalizedRange && normalizedPageRanges.length > 1) {
                const textQuote = await this.#locateTextQuote(
                    itemID,
                    annotation
                );
                if (textQuote) {
                    normalizedRange = selectTextQuoteCandidateRange(
                        normalizedPageRanges,
                        normalizedIndex,
                        textQuote
                    );
                }
            }
            if (normalizedRange) {
                matched.push(resolvedAnnotation(
                    annotation,
                    'normalized',
                    normalizedRange
                ));
                previousSourceTo = Math.max(previousSourceTo, normalizedRange.to);
                continue;
            }
            const dehyphenatedText = createDehyphenatedPdfAnnotationTextIndex(
                annotation.text
            ).text;
            if (!dehyphenatedIndex
                && !candidates.length
                && !normalizedCandidates.length) {
                dehyphenatedIndex = createDehyphenatedPdfAnnotationTextIndex(
                    index.text,
                    offset => index.sourceOffsetAt(offset)
                );
            }
            const dehyphenatedCandidateResult = candidates.length
                || normalizedCandidates.length
                ? { offsets: [], truncated: false }
                : findTextOccurrences(
                    dehyphenatedIndex.text,
                    dehyphenatedText,
                    MAX_MATCH_CANDIDATES
                );
            const dehyphenatedCandidates = dehyphenatedCandidateResult.offsets;
            const dehyphenatedRanges = dehyphenatedCandidateResult.truncated
                ? []
                : dehyphenatedCandidates.map(candidate => (
                    dehyphenatedIndex.sourceRange(
                        candidate,
                        dehyphenatedText.length
                    )
                ));
            const dehyphenatedPageRanges = selectPageCandidates(
                dehyphenatedRanges,
                annotation.pageIndex,
                sourceMap,
                markdown.length
            );
            const dehyphenatedRange = selectCandidateRange(
                dehyphenatedPageRanges,
                previousSourceTo
            );
            if (dehyphenatedRange) {
                matched.push(resolvedAnnotation(
                    annotation,
                    'normalized',
                    dehyphenatedRange
                ));
                previousSourceTo = Math.max(
                    previousSourceTo,
                    dehyphenatedRange.to
                );
                continue;
            }
            const ambiguous = candidateResult.truncated
                || candidates.length
                || normalizedCandidateResult.truncated
                || normalizedCandidates.length
                || dehyphenatedCandidateResult.truncated
                || dehyphenatedCandidates.length;
            unmatched.push({
                ...annotation,
                reason: ambiguous ? 'ambiguous' : 'not-found',
            });
        }
        return { matched, unmatched };
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
    const exactMatches = ranges.filter(range => textQuoteMatchesRange(
        normalizedIndex,
        range,
        textQuote,
        normalizePdfAnnotationText,
        MAX_PDF_ANNOTATION_TEXT_QUOTE_CONTEXT_CODE_POINTS
    ));
    if (exactMatches.length) {
        return exactMatches.length === 1 ? exactMatches[0] : null;
    }
    const foldHyphens = value => (
        createHyphenFoldedPdfAnnotationTextIndex(value).text.trim()
    );
    const foldedMatches = ranges.filter(range => textQuoteMatchesRange(
        normalizedIndex,
        range,
        textQuote,
        foldHyphens,
        MAX_FOLDED_TEXT_QUOTE_CONTEXT_CODE_POINTS
    ));
    return foldedMatches.length === 1 ? foldedMatches[0] : null;
}

function textQuoteMatchesRange(
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
    const comparisons = [];
    if (prefix.length >= MIN_TEXT_QUOTE_CONTEXT_MATCH_LENGTH) {
        const before = normalizeContext(trailingCodePoints(
            normalizedIndex.text,
            contextCodePoints,
            normalizedRange.from
        ));
        comparisons.push(before.endsWith(prefix));
    }
    if (suffix.length >= MIN_TEXT_QUOTE_CONTEXT_MATCH_LENGTH) {
        const after = normalizeContext(leadingCodePoints(
            normalizedIndex.text,
            contextCodePoints,
            normalizedRange.to
        ));
        comparisons.push(after.startsWith(suffix));
    }
    return comparisons.length > 0 && comparisons.every(Boolean);
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
