import { GFM, parser } from '@lezer/markdown';
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
            if ((HIDDEN_NODE_NAMES.has(node.name)
                && !isVisibleNumericCitationMark(node, markdown))
                || hiddenURL(node)) {
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
