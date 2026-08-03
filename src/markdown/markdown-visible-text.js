import { GFM, parser } from '@lezer/markdown';
import { findInlineMathMatches } from './markdown-html.js';
import { isNumericCitationContent } from './text-normalization.js';

const MARKDOWN_PARSER = parser.configure(GFM);
const HIDDEN_NODE_NAMES = new Set([
    'CodeMark',
    'EmphasisMark',
    'HeaderMark',
    'LinkMark',
    'ListMark',
    'QuoteMark',
    'StrikethroughMark',
]);
const HIDDEN_SUBTREE_NAMES = new Set([
    'Comment',
    'CommentBlock',
    'LinkReference',
]);
const HIDDEN_URL_PARENT_NAMES = new Set([
    'Image',
    'Link',
    'LinkReference',
]);
const MATH_EXCLUDED_NODE_NAMES = new Set([
    'CodeBlock',
    'FencedCode',
    'HTMLBlock',
    'InlineCode',
]);

export function createVisibleMarkdownTextIndex(markdown) {
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
                sourceTo: hidden.from,
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
            sourceTo: markdown.length,
        });
    }
    const text = chunks.join('');
    return {
        text,
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
        textForSourceRange(from, to) {
            if (!Number.isSafeInteger(from)
                || !Number.isSafeInteger(to)
                || from < 0
                || to <= from
                || to > markdown.length) {
                return '';
            }
            const output = [];
            let index = findFirstSourceSegment(segments, from);
            while (index < segments.length) {
                const segment = segments[index];
                if (segment.sourceFrom >= to) break;
                const overlapFrom = Math.max(from, segment.sourceFrom);
                const overlapTo = Math.min(to, segment.sourceTo);
                if (overlapFrom < overlapTo) {
                    const visibleFrom = segment.visibleFrom
                        + overlapFrom - segment.sourceFrom;
                    output.push(text.slice(
                        visibleFrom,
                        visibleFrom + overlapTo - overlapFrom
                    ));
                }
                index++;
            }
            return output.join('');
        },
    };
}

function collectHiddenRanges(markdown) {
    const ranges = [];
    const escapeRanges = [];
    const inlineMathRanges = [];
    const mathExcludedRanges = [];
    MARKDOWN_PARSER.parse(markdown).iterate({
        enter(node) {
            if (MATH_EXCLUDED_NODE_NAMES.has(node.name)) {
                mathExcludedRanges.push({ from: node.from, to: node.to });
            }
            if (HIDDEN_SUBTREE_NAMES.has(node.name)) {
                ranges.push({ from: node.from, to: node.to });
                return false;
            }
            if (node.name === 'Escape') {
                escapeRanges.push({ from: node.from, to: node.from + 1 });
            }
            if ((HIDDEN_NODE_NAMES.has(node.name)
                && !isVisibleNumericCitationMark(node, markdown))
                || hiddenURL(node)) {
                ranges.push({ from: node.from, to: node.to });
            }
            return undefined;
        },
    });
    for (const match of findInlineMathMatches(markdown)) {
        if (overlapsAnyRange(match, mathExcludedRanges)) continue;
        inlineMathRanges.push({ from: match.start, to: match.end });
        if (match.text.startsWith('^')) continue;
        const contentOffset = match.raw.indexOf(match.text);
        if (contentOffset < 0) continue;
        const contentFrom = match.start + contentOffset;
        const contentTo = contentFrom + match.text.length;
        if (match.start < contentFrom) {
            ranges.push({ from: match.start, to: contentFrom });
        }
        if (contentTo < match.end) {
            ranges.push({ from: contentTo, to: match.end });
        }
    }
    appendMarkdownEscapeRanges(ranges, escapeRanges, inlineMathRanges);
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

function overlapsAnyRange(target, ranges) {
    return ranges.some(range => target.start < range.to && target.end > range.from);
}

function appendMarkdownEscapeRanges(output, escapeRanges, inlineMathRanges) {
    let mathIndex = 0;
    for (const escapeRange of escapeRanges) {
        while (inlineMathRanges[mathIndex]?.to <= escapeRange.from) {
            mathIndex++;
        }
        const mathRange = inlineMathRanges[mathIndex];
        if (!mathRange || escapeRange.to <= mathRange.from) {
            output.push(escapeRange);
        }
    }
}

function isVisibleNumericCitationMark(node, markdown) {
    if (node.name !== 'LinkMark') return false;
    const parent = node.node.parent;
    if (parent?.name !== 'Link') return false;
    const source = markdown.slice(parent.from, parent.to);
    return source.length <= 514
        && source[0] === '['
        && source.at(-1) === ']'
        && isNumericCitationContent(source.slice(1, -1));
}

function hiddenURL(node) {
    return node.name === 'URL'
        && HIDDEN_URL_PARENT_NAMES.has(node.node.parent?.name);
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

function findFirstSourceSegment(segments, offset) {
    let low = 0;
    let high = segments.length;
    while (low < high) {
        const middle = (low + high) >> 1;
        if (segments[middle].sourceTo <= offset) low = middle + 1;
        else high = middle;
    }
    return low;
}
