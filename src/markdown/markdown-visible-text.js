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

export function createVisibleMarkdownTextIndex(markdown, extraHiddenRanges = []) {
    const hiddenRanges = collectHiddenRanges(markdown, extraHiddenRanges);
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
        visibleOffsetAt(offset) {
            if (!Number.isSafeInteger(offset) || offset >= markdown.length) {
                return text.length;
            }
            if (offset <= 0) return 0;
            const index = findFirstSourceSegment(segments, offset);
            const segment = segments[index];
            if (!segment) return text.length;
            if (offset <= segment.sourceFrom) return segment.visibleFrom;
            return segment.visibleFrom + Math.min(
                offset - segment.sourceFrom,
                segment.visibleTo - segment.visibleFrom
            );
        },
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

function collectHiddenRanges(markdown, extraHiddenRanges = []) {
    const ranges = [];
    const escapeRanges = [];
    const inlineMathRanges = [];
    const mathExcludedRanges = [];
    const tree = MARKDOWN_PARSER.parse(markdown);
    const linkReferenceLabels = collectLinkReferenceLabels(tree, markdown);
    tree.iterate({
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
                && !isVisibleMarkdownMark(
                    node,
                    markdown,
                    linkReferenceLabels
                ))
                || hiddenResolvedReferenceLabel(
                    node,
                    markdown,
                    linkReferenceLabels
                )
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
    if (Array.isArray(extraHiddenRanges)) {
        for (const range of extraHiddenRanges) {
            if (!Number.isSafeInteger(range?.from)
                || !Number.isSafeInteger(range?.to)
                || range.from < 0
                || range.to > markdown.length
                || range.from >= range.to) {
                continue;
            }
            ranges.push({ from: range.from, to: range.to });
        }
    }
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

function isVisibleMarkdownMark(node, markdown, linkReferenceLabels) {
    if (node.name !== 'LinkMark') return false;
    const parent = node.node.parent;
    if (parent?.name !== 'Link') return false;
    if (isBracketedNumericCitation(parent, markdown)) return true;
    return !hasResolvedLink(parent, markdown, linkReferenceLabels);
}

function isBracketedNumericCitation(link, markdown) {
    const source = markdown.slice(link.from, link.to);
    return source.length <= 514
        && source[0] === '['
        && source.at(-1) === ']'
        && isNumericCitationContent(source.slice(1, -1));
}

function hiddenResolvedReferenceLabel(node, markdown, linkReferenceLabels) {
    if (node.name !== 'LinkLabel') return false;
    const parent = node.node.parent;
    return parent?.name === 'Link'
        && hasResolvedLink(parent, markdown, linkReferenceLabels);
}

function hasResolvedLink(link, markdown, linkReferenceLabels) {
    const url = link.getChild('URL');
    if (url && markdown.slice(url.from, url.to)) return true;
    const label = referenceLabelForLink(link, markdown);
    return Boolean(label && linkReferenceLabels.has(label));
}

function referenceLabelForLink(link, markdown) {
    const explicitLabel = link.getChild('LinkLabel');
    const normalizedExplicitLabel = explicitLabel
        ? normalizeLinkLabel(
            markdown.slice(explicitLabel.from, explicitLabel.to)
        )
        : '';
    if (normalizedExplicitLabel) return normalizedExplicitLabel;
    const marks = link.getChildren('LinkMark');
    const closingLabel = marks.find(mark => (
        markdown.slice(mark.from, mark.to) === ']'
    ));
    if (!marks.length || !closingLabel) return '';
    return normalizeLinkLabel(markdown.slice(marks[0].to, closingLabel.from));
}

function collectLinkReferenceLabels(tree, markdown) {
    const labels = new Set();
    tree.iterate({
        enter(node) {
            if (node.name !== 'LinkReference') return;
            const label = node.node.getChild('LinkLabel');
            const url = node.node.getChild('URL');
            if (!label || !url || !markdown.slice(url.from, url.to)) return;
            const normalized = normalizeLinkLabel(
                markdown.slice(label.from, label.to)
            );
            if (normalized) labels.add(normalized);
        },
    });
    return labels;
}

function normalizeLinkLabel(label) {
    return String(label)
        .replace(/^\[|\]$/g, '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
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
