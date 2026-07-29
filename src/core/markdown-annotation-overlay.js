import { GFM, parser } from '@lezer/markdown';
import {
    createNormalizedTextIndex,
    normalizeText,
} from '../markdown/text-normalization.js';

const MARKDOWN_PARSER = parser.configure(GFM);
const MAX_MATCHABLE_MARKDOWN_LENGTH = 8 * 1024 * 1024;
const MAX_MATCH_CANDIDATES = 10_000;
const HIDDEN_NODE_NAMES = new Set([
    'CodeMark',
    'EmphasisMark',
    'HeaderMark',
    'LinkMark',
    'ListMark',
    'QuoteMark',
    'StrikethroughMark',
    'URL',
]);
const HIDDEN_SUBTREE_NAMES = new Set([
    'CommentBlock',
    'LinkReferenceDefinition',
]);

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
                matched: [],
                unmatched: [],
                warning: 'Zotero PDF annotations could not be loaded.',
            };
        }
    }

    async #resolve(itemID, markdown) {
        const annotations = await this.extractor.extract(itemID);
        if (!annotations.length) return { matched: [], unmatched: [] };
        if (markdown.length > MAX_MATCHABLE_MARKDOWN_LENGTH) {
            throw new Error(
                'Markdown exceeds the PDF annotation matching safety limit'
            );
        }
        const index = createVisibleTextIndex(markdown);
        let normalizedIndex = null;
        const matched = [];
        const unmatched = [];
        let previousSourceTo = 0;

        for (const annotation of annotations) {
            const candidates = findOccurrences(index.text, annotation.text);
            const exactRange = selectCandidateRange(
                candidates,
                candidate => index.sourceRange(candidate, annotation.text.length),
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
            const normalizedText = normalizeText(annotation.text);
            if (!normalizedIndex && !candidates.length) {
                normalizedIndex = createNormalizedTextIndex(
                    index.text,
                    offset => index.sourceOffsetAt(offset)
                );
            }
            const normalizedCandidates = candidates.length
                ? []
                : findOccurrences(normalizedIndex.text, normalizedText);
            const normalizedRange = selectCandidateRange(
                normalizedCandidates,
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
            const ambiguous = candidates.length || normalizedCandidates.length;
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

function createVisibleTextIndex(markdown) {
    const hiddenRanges = collectHiddenRanges(markdown);
    const segments = [];
    const chunks = [];
    let sourceFrom = 0;
    let visibleFrom = 0;
    for (const hidden of hiddenRanges) {
        if (sourceFrom < hidden.from) {
            const chunk = markdown.slice(sourceFrom, hidden.from);
            chunks.push(chunk);
            segments.push({
                visibleFrom,
                visibleTo: visibleFrom + chunk.length,
                sourceFrom,
            });
            visibleFrom += chunk.length;
        }
        sourceFrom = Math.max(sourceFrom, hidden.to);
    }
    if (sourceFrom < markdown.length) {
        const chunk = markdown.slice(sourceFrom);
        chunks.push(chunk);
        segments.push({
            visibleFrom,
            visibleTo: visibleFrom + chunk.length,
            sourceFrom,
        });
    }
    return {
        text: chunks.join(''),
        sourceOffsetAt(offset) {
            const segment = findSegment(segments, offset);
            return segment
                ? segment.sourceFrom + offset - segment.visibleFrom
                : markdown.length;
        },
        sourceRange(from, length) {
            return {
                from: this.sourceOffsetAt(from),
                to: this.sourceOffsetAt(from + length - 1) + 1,
            };
        },
    };
}

function collectHiddenRanges(markdown) {
    const ranges = [];
    MARKDOWN_PARSER.parse(markdown).iterate({
        enter(node) {
            if (HIDDEN_SUBTREE_NAMES.has(node.name)) {
                ranges.push({ from: node.from, to: node.to });
                return false;
            }
            if (HIDDEN_NODE_NAMES.has(node.name)) {
                ranges.push({ from: node.from, to: node.to });
            }
            return undefined;
        },
    });
    ranges.sort((left, right) => left.from - right.from || left.to - right.to);
    const merged = [];
    for (const range of ranges) {
        const previous = merged.at(-1);
        if (!previous || range.from > previous.to) {
            merged.push({ ...range });
        }
        else {
            previous.to = Math.max(previous.to, range.to);
        }
    }
    return merged;
}

function findOccurrences(source, target) {
    if (!target) return [];
    const result = [];
    let from = 0;
    while (from <= source.length - target.length) {
        const index = source.indexOf(target, from);
        if (index < 0) break;
        result.push(index);
        if (result.length >= MAX_MATCH_CANDIDATES) break;
        from = index + Math.max(1, target.length);
    }
    return result;
}

function findSegment(segments, offset) {
    let low = 0;
    let high = segments.length - 1;
    while (low <= high) {
        const middle = (low + high) >> 1;
        const segment = segments[middle];
        if (offset < segment.visibleFrom) {
            high = middle - 1;
        }
        else if (offset >= segment.visibleTo) {
            low = middle + 1;
        }
        else {
            return segment;
        }
    }
    return null;
}
