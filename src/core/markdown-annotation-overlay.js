import { findTextOccurrences } from '../markdown/text-normalization.js';
import {
    createPdfAnnotationTextIndex,
    expandPdfAnnotationSourceRange,
    normalizePdfAnnotationText,
} from '../markdown/pdf-annotation-text.js';
import {
    createVisibleMarkdownTextIndex,
} from '../markdown/markdown-visible-text.js';

const MAX_MATCHABLE_MARKDOWN_LENGTH = 8 * 1024 * 1024;
const MAX_MATCH_CANDIDATES = 10_000;

export class MarkdownAnnotationOverlay {
    constructor({ extractor, onError = () => {} }) {
        if (!extractor?.extract) {
            throw new TypeError('An annotation extractor is required');
        }
        this.extractor = extractor;
        this.onError = onError;
    }

    async resolve(itemID, markdown) {
        if (typeof markdown !== 'string') {
            throw new TypeError('Markdown must be a string');
        }
        try {
            return await this.#resolve(itemID, markdown);
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

    async #resolve(itemID, markdown) {
        const annotations = await this.extractor.extract(itemID);
        if (!annotations.length) return createEmptyAnnotationOverlay();
        if (markdown.length > MAX_MATCHABLE_MARKDOWN_LENGTH) {
            throw new Error(
                'Markdown exceeds the PDF annotation matching safety limit'
            );
        }
        const index = createVisibleMarkdownTextIndex(markdown);
        let normalizedIndex = null;
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
            const exactRange = selectCandidateRange(
                candidateResult.truncated ? [] : candidates,
                candidate => expandPdfAnnotationSourceRange(
                    markdown,
                    index.sourceRange(candidate, annotation.text.length)
                ),
                previousSourceTo
            );
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
            const normalizedRange = selectCandidateRange(
                normalizedCandidateResult.truncated
                    ? []
                    : normalizedCandidates,
                candidate => normalizedIndex.sourceRange(
                    candidate,
                    normalizedText.length
                ),
                previousSourceTo
            );
            if (normalizedRange) {
                matched.push(resolvedAnnotation(
                    annotation,
                    'normalized',
                    normalizedRange
                ));
                previousSourceTo = Math.max(previousSourceTo, normalizedRange.to);
                continue;
            }
            const ambiguous = candidateResult.truncated
                || candidates.length
                || normalizedCandidateResult.truncated
                || normalizedCandidates.length;
            unmatched.push({
                ...annotation,
                reason: ambiguous ? 'ambiguous' : 'not-found',
            });
        }
        return { matched, unmatched };
    }
}

function resolvedAnnotation(annotation, matchKind, range) {
    return {
        ...annotation,
        matchKind,
        ranges: [range],
    };
}

function selectCandidateRange(candidates, toRange, previousSourceTo) {
    const ranges = candidates.map(toRange);
    if (ranges.length === 1) return ranges[0];
    if (!previousSourceTo) return null;
    const following = ranges.filter(range => range.from >= previousSourceTo);
    return following.length === 1 ? following[0] : null;
}

export function createEmptyAnnotationOverlay() {
    return { matched: [], unmatched: [] };
}
