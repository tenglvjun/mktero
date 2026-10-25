import { GFM, parser } from '@lezer/markdown';
import {
    findDisplayMathMatches,
    findInlineMathMatches,
} from './markdown-html.js';
import { analyzeMarkdownCitations } from './markdown-citations.js';
import { analyzeMarkdownFootnotes } from './markdown-footnotes.js';
import { footnoteMarkKeys } from './footnote-marks.js';
import { superscriptMarkGlyphs } from './pdf-annotation-text.js';
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
// The reader does not decorate a citation inside these nodes.
const CITATION_EXCLUDED_NODE_NAMES = new Set([
    'CodeBlock',
    'FencedCode',
    'HTMLBlock',
    'Image',
    'InlineCode',
    'URL',
]);
// KaTeX draws a superscript footnote mark (`^{\dagger}`, `^{*}`, `^{\star}`,
// `^{1,\dagger}`) as its glyphs, and the reader shows them. Other
// superscripts keep their source form, which normalizePdfAnnotationText
// already flattens for the PDF text layer.
const FOOTNOTE_MATH_WRAPPER = /^(?:\$|\\\()(?:\{\s*\})?\^\s*\{\s*([^{}\r\n]{1,24}?)\s*\}(?:\$|\\\))$/u;
const HTML_TABLE_CELL_BOUNDARY = /<\/?(?:td|th|tr|caption|br|p|div|li)\b/iu;

// `readerMarkup` also hides the superscript wrappers the reader hides and
// shows a footnote glyph for its TeX source. Selection text uses it, so a
// saved annotation equals what the reader shows. `keepLinkTitles` is for
// text saved before a link title was hidden.
export function createVisibleMarkdownTextIndex(
    markdown,
    extraHiddenRanges = [],
    { readerMarkup = false, analyses = null, keepLinkTitles = false } = {}
) {
    const { hiddenRanges, mathRanges } = collectHiddenRanges(
        markdown,
        extraHiddenRanges,
        readerMarkup,
        analyses,
        keepLinkTitles
    );
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
        if (hidden.text) {
            chunks.push(hidden.text);
            segments.push({
                visibleFrom,
                visibleTo: visibleFrom + hidden.text.length,
                sourceFrom: hidden.from,
                sourceTo: hidden.to,
                replaced: true,
            });
            visibleFrom += hidden.text.length;
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
        expandSourceRangeToMathBoundaries(range) {
            return expandRangeToMathSourceRanges(range, mathRanges);
        },
        // The text a replaced segment shows when it spans exactly `from..to`.
        replacedTextForSourceRange(from, to) {
            const segment = segments[findFirstSourceSegment(segments, from)];
            return segment?.replaced
                && segment.sourceFrom === from
                && segment.sourceTo === to
                ? text.slice(segment.visibleFrom, segment.visibleTo)
                : null;
        },
        visibleOffsetAt(offset) {
            if (!Number.isSafeInteger(offset) || offset >= markdown.length) {
                return text.length;
            }
            if (offset <= 0) return 0;
            const index = findFirstSourceSegment(segments, offset);
            const segment = segments[index];
            if (!segment) return text.length;
            if (offset <= segment.sourceFrom) return segment.visibleFrom;
            if (segment.replaced) return segment.visibleTo;
            return segment.visibleFrom + Math.min(
                offset - segment.sourceFrom,
                segment.visibleTo - segment.visibleFrom
            );
        },
        sourceOffsetAt(offset) {
            const segment = findSegment(segments, offset);
            if (segment?.replaced) return segment.sourceFrom;
            return segment
                ? segment.sourceFrom + offset - segment.visibleFrom
                : markdown.length;
        },
        sourceRange(from, length) {
            const last = findSegment(segments, from + length - 1);
            return {
                from: this.sourceOffsetAt(from),
                to: last?.replaced
                    ? last.sourceTo
                    : this.sourceOffsetAt(from + length - 1) + 1,
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
                if (overlapFrom < overlapTo && segment.replaced) {
                    output.push(text.slice(
                        segment.visibleFrom,
                        segment.visibleTo
                    ));
                }
                else if (overlapFrom < overlapTo) {
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

export function expandMarkdownRangeToMathBoundaries(markdown, range) {
    const source = String(markdown || '');
    return createVisibleMarkdownTextIndex(source)
        .expandSourceRangeToMathBoundaries(range);
}

const PAIRED_MARK_PARENTS = new Set([
    'Autolink',
    'Emphasis',
    'StrongEmphasis',
    'Strikethrough',
    'InlineCode',
    'Link',
]);
const HTML_TABLE_CELL_TAGS = new Set(['td', 'th', 'caption']);
const NAMED_HTML_ENTITIES = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: '\u00A0',
    quot: '"',
};
// The reader-markup index runs the citation analysis, which costs a few
// hundred milliseconds on a long paper. A selection in compare mode reads the
// comparison document and its check reads the source, so keep both, plus the
// last document of another open tab, instead of rebuilding on every mouseup.
const VISIBLE_INDEX_CACHE_LIMIT = 4;
const visibleIndexCache = new Map();
let htmlTableBlockCache = null;

// Segments of one selection split around hidden page chrome are joined with
// a space, as the reader shows them on separate lines.
// `analyses` may supply the document's citation and footnote analyses, as
// `{ citations(), footnotes() }`. The reader already holds them for the text it
// shows; without them the first selection in a long paper reparses every
// citation on mouseup.
export function visibleMarkdownTextForRanges(markdown, ranges, { analyses = null } = {}) {
    const source = String(markdown || '');
    if (!Array.isArray(ranges)) return '';
    const index = visibleIndexFor(source, analyses);
    let text = '';
    let previous = null;
    for (const range of ranges) {
        const part = visibleRangeText(source, index, range);
        if (!part) continue;
        if (text
            && needsSegmentSeparator(source, index, previous, range)
            && !/\s$/u.test(text)
            && !/^\s/u.test(part)) {
            text += ' ';
        }
        text += part;
        previous = range;
    }
    return text;
}

// Selections used to re-parse each slice on its own and joined segments
// without a separator. A slice that cut a paired marker stored the marker as
// text, and a superscript kept its wrapper. Those saved annotations still
// have to match; new selections use the whole-document index instead.
export function legacyVisibleMarkdownTextForRanges(markdown, ranges) {
    const source = String(markdown || '');
    if (!Array.isArray(ranges)) return '';
    return ranges.map(range => {
        if (!validSourceRange(range, source.length)) return '';
        return visibleTextForMarkdownSlice(source.slice(range.from, range.to));
    }).join('');
}

// Drop hidden marks whose pair lies outside the selection. A single stored
// range cannot contain a hole, so each visible run becomes its own range.
// The marks of an autolink are left out even when both are selected: the
// reader shows only its URL.
export function trimDanglingMarkdownMarkRanges(markdown, ranges) {
    const source = String(markdown || '');
    const selection = (Array.isArray(ranges) ? ranges : [])
        .filter(range => validSourceRange(range, source.length))
        .map(range => ({ from: range.from, to: range.to }));
    if (!selection.length) return [];
    const dangling = danglingMarkdownMarkRanges(source, selection);
    if (!dangling.length) return selection;
    return selection.flatMap(range => subtractSourceRanges(range, dangling));
}

export function htmlTableVisibleSourceAtoms(source) {
    const text = String(source || '');
    const atoms = [];
    const tagPattern = /<\/?([a-zA-Z][\w:-]*)\b[^<>]*>/g;
    let cellDepth = 0;
    let cell = -1;
    let index = 0;
    for (const match of text.matchAll(tagPattern)) {
        if (cellDepth > 0 && match.index > index) {
            appendDecodedHTMLAtoms(atoms, text, index, match.index, cell);
        }
        const name = match[1].toLowerCase();
        if (HTML_TABLE_CELL_TAGS.has(name)) {
            if (match[0].startsWith('</')) {
                cellDepth = Math.max(0, cellDepth - 1);
            }
            else if (!match[0].endsWith('/>')) {
                cellDepth += 1;
                cell += 1;
            }
        }
        index = match.index + match[0].length;
    }
    if (cellDepth > 0 && index < text.length) {
        appendDecodedHTMLAtoms(atoms, text, index, text.length, cell);
    }
    return atoms;
}

function visibleIndexFor(source, analyses = null) {
    const cached = visibleIndexCache.get(source);
    if (cached) {
        // Refresh its position so the documents in use stay cached.
        visibleIndexCache.delete(source);
        visibleIndexCache.set(source, cached);
        return cached;
    }
    const index = createVisibleMarkdownTextIndex(source, [], {
        readerMarkup: true,
        analyses,
    });
    visibleIndexCache.set(source, index);
    while (visibleIndexCache.size > VISIBLE_INDEX_CACHE_LIMIT) {
        visibleIndexCache.delete(visibleIndexCache.keys().next().value);
    }
    return index;
}

// A gap only of hidden marks sits inside a line ("foo**bar**"); a gap that
// crosses a line or holds visible text is hidden chrome between segments.
// Inside an HTML table the tags are not shown, so a gap separates segments
// when it crosses a cell boundary or holds cell text.
function needsSegmentSeparator(source, index, previous, range) {
    if (!previous || range.from <= previous.to) return false;
    const gap = source.slice(previous.to, range.from);
    if (/[\r\n]/u.test(gap)) return true;
    const table = htmlTableBlockContaining(source, previous.from, range.to);
    if (table) {
        return HTML_TABLE_CELL_BOUNDARY.test(gap)
            || visibleHTMLTableRangeText(source, previous.to, range.from) !== '';
    }
    return index.textForSourceRange(previous.to, range.from) !== '';
}

function visibleRangeText(source, index, range) {
    if (!validSourceRange(range, source.length)) return '';
    const slice = source.slice(range.from, range.to);
    const trimmedFrom = range.from + slice.length - slice.trimStart().length;
    const replaced = index.replacedTextForSourceRange(
        trimmedFrom,
        trimmedFrom + slice.trim().length
    );
    if (replaced !== null) return replaced;
    const mark = readerMathMarkText(slice.trim());
    if (mark !== null) return mark;
    const math = wholeSliceMathText(slice);
    if (math !== null) return math;
    const html = visibleHTMLTableRangeText(source, range.from, range.to);
    if (html !== null) return html;
    return index.textForSourceRange(range.from, range.to);
}

function visibleTextForMarkdownSlice(source) {
    const math = wholeSliceMathText(source);
    if (math !== null) return math;
    return createVisibleMarkdownTextIndex(source, [], {
        keepLinkTitles: true,
    }).text;
}

// The glyphs the reader shows for a whole inline-math footnote mark such as
// `$^{\dagger}$` or `$^{1,*}$`, or null.
export function readerMathMarkText(source) {
    const inline = findInlineMathMatches(String(source || ''));
    if (inline.length !== 1
        || inline[0].start !== 0
        || inline[0].end !== source.length) {
        return null;
    }
    return readerMathMarkForContent(inline[0].text);
}

function readerMathMarkForContent(content) {
    return superscriptMarkGlyphs(content);
}

// The footnote layer draws a linked mark itself instead of KaTeX: a TeX
// command as its first symbol (`\star` is "*"), any other mark as written.
// Keyed by the mark's source range.
function footnoteWidgetTexts(markdown, footnotes) {
    const texts = new Map();
    for (const note of footnotes().notes || []) {
        if (!note.citation) continue;
        const endpoints = [
            {
                from: note.citation.wrapperFrom,
                to: note.citation.wrapperTo,
                contentFrom: note.citation.from,
                contentTo: note.citation.to,
            },
            footnoteMarkEndpoint(markdown, note.mark),
        ];
        for (const endpoint of endpoints) {
            if (!endpoint
                || !(endpoint.from < endpoint.contentFrom
                    || endpoint.contentTo < endpoint.to)) {
                continue;
            }
            const content = markdown.slice(endpoint.contentFrom, endpoint.contentTo);
            const text = content.includes('\\')
                ? footnoteMarkKeys(content)[0]
                : content;
            if (text) texts.set(`${endpoint.from}:${endpoint.to}`, text);
        }
    }
    return texts;
}

function footnoteMarkEndpoint(markdown, mark) {
    if (!Number.isSafeInteger(mark?.from) || !Number.isSafeInteger(mark?.to)) {
        return null;
    }
    const raw = markdown.slice(mark.from, mark.to);
    const math = FOOTNOTE_MATH_WRAPPER.exec(raw);
    if (!math) return null;
    const contentFrom = mark.from + math[0].indexOf(math[1]);
    return {
        from: mark.from,
        to: mark.to,
        contentFrom,
        contentTo: contentFrom + math[1].length,
    };
}

function wholeSliceMathText(source) {
    const display = findDisplayMathMatches(source);
    if (coversWholeSource(source, display[0])) return display[0].text;
    const inline = findInlineMathMatches(source);
    if (coversWholeSource(source, inline[0]) && !inline[0].text.startsWith('^')) {
        return inline[0].text;
    }
    return null;
}

function validSourceRange(range, length) {
    return Number.isInteger(range?.from)
        && Number.isInteger(range?.to)
        && range.from >= 0
        && range.to > range.from
        && range.to <= length;
}

function danglingMarkdownMarkRanges(source, selection) {
    const tree = MARKDOWN_PARSER.parse(source);
    const labels = collectLinkReferenceLabels(tree, source);
    const dangling = [];
    tree.iterate({
        enter(node) {
            if (!PAIRED_MARK_PARENTS.has(node.name)) return;
            const hidden = hiddenMarkChildren(node.node, source, labels);
            if (!hidden.length) return;
            const covered = node.name !== 'Autolink'
                && hidden.every(child => selection.some(range => (
                    range.from <= child.from && range.to >= child.to
                )));
            if (covered) return;
            for (const child of hidden) {
                if (selection.some(range => (
                    child.from < range.to && child.to > range.from
                ))) {
                    dangling.push(child);
                }
            }
        },
    });
    return dangling;
}

function hiddenMarkChildren(node, markdown, labels) {
    const hidden = [];
    for (let child = node.firstChild; child; child = child.nextSibling) {
        if (isHiddenPairedMark(child, markdown, labels)) {
            hidden.push({ from: child.from, to: child.to });
        }
        const title = hiddenLinkTitleRange(child, markdown, labels);
        if (title) hidden.push(title);
    }
    return hidden;
}

// A resolved link does not show its title. Hide it with the spaces around
// it, up to the URL before and the closing mark after.
function hiddenLinkTitleRange(node, markdown, labels) {
    if (node.name !== 'LinkTitle') return null;
    const link = node.parent;
    if (link?.name !== 'Link' || !hasResolvedLink(link, markdown, labels)) {
        return null;
    }
    return {
        from: node.prevSibling ? node.prevSibling.to : node.from,
        to: node.nextSibling ? node.nextSibling.from : node.to,
    };
}

function isHiddenPairedMark(node, markdown, labels) {
    if (HIDDEN_NODE_NAMES.has(node.name)) {
        return !isVisibleLinkMarkNode(node, markdown, labels);
    }
    if (node.name === 'URL' && HIDDEN_URL_PARENT_NAMES.has(node.parent?.name)) {
        return true;
    }
    return node.name === 'LinkLabel'
        && node.parent?.name === 'Link'
        && hasResolvedLink(node.parent, markdown, labels);
}

function isVisibleLinkMarkNode(node, markdown, labels) {
    if (node.name !== 'LinkMark') return false;
    const parent = node.parent;
    if (parent?.name !== 'Link') return false;
    if (isBracketedNumericCitation(parent, markdown)) return true;
    return !hasResolvedLink(parent, markdown, labels);
}

function subtractSourceRanges(range, hidden) {
    const cuts = hidden
        .filter(item => item.from < range.to && item.to > range.from)
        .sort((left, right) => left.from - right.from || left.to - right.to);
    const visible = [];
    let cursor = range.from;
    for (const cut of cuts) {
        if (cut.to <= cursor) continue;
        if (cut.from >= range.to) break;
        if (cut.from > cursor) {
            visible.push({
                from: cursor,
                to: Math.min(cut.from, range.to),
            });
        }
        cursor = Math.max(cursor, cut.to);
        if (cursor >= range.to) break;
    }
    if (cursor < range.to) visible.push({ from: cursor, to: range.to });
    return visible;
}

function visibleHTMLTableRangeText(source, from, to) {
    const block = htmlTableBlockContaining(source, from, to);
    if (!block) return null;
    let text = '';
    for (const atom of htmlTableVisibleSourceAtoms(
        source.slice(block.from, block.to)
    )) {
        const atomFrom = block.from + atom.from;
        const atomTo = block.from + atom.to;
        if (atomFrom >= from && atomTo <= to) text += atom.text;
    }
    return text;
}

function htmlTableBlockContaining(source, from, to) {
    return htmlTableBlocks(source).find(block => (
        from >= block.from && to <= block.to
    )) || null;
}

function htmlTableBlocks(source) {
    if (htmlTableBlockCache?.source === source) return htmlTableBlockCache.blocks;
    const blocks = [];
    if (/<table\b/i.test(source)) {
        MARKDOWN_PARSER.parse(source).iterate({
            enter(node) {
                if (node.name !== 'HTMLBlock') return;
                const text = source.slice(node.from, node.to);
                if (/^\s*<table\b/i.test(text)) {
                    blocks.push({ from: node.from, to: node.to });
                }
            },
        });
    }
    htmlTableBlockCache = { source, blocks };
    return blocks;
}

function appendDecodedHTMLAtoms(atoms, source, from, to, cell = 0) {
    let index = from;
    while (index < to) {
        const entity = source[index] === '&'
            ? decodeHTMLEntityAt(source, index, to)
            : null;
        if (entity) {
            atoms.push({
                text: entity.decoded,
                from: index,
                to: index + entity.length,
                cell,
            });
            index += entity.length;
            continue;
        }
        atoms.push({ text: source[index], from: index, to: index + 1, cell });
        index += 1;
    }
}

function decodeHTMLEntityAt(source, index, limit) {
    if (source[index] !== '&') return null;
    const end = source.indexOf(';', index + 1);
    if (end < 0 || end >= limit || end - index > 32) return null;
    const body = source.slice(index + 1, end);
    let decoded = null;
    if (body[0] === '#') {
        const hex = body[1] === 'x' || body[1] === 'X';
        const digits = hex ? body.slice(2) : body.slice(1);
        if (!digits || (hex ? /[^0-9a-f]/i : /\D/).test(digits)) return null;
        const codePoint = Number.parseInt(digits, hex ? 16 : 10);
        if (!Number.isInteger(codePoint)
            || codePoint < 0
            || codePoint > 0x10FFFF
            || (codePoint >= 0xD800 && codePoint <= 0xDFFF)) {
            return null;
        }
        decoded = String.fromCodePoint(codePoint);
    }
    else decoded = NAMED_HTML_ENTITIES[body.toLowerCase()] || null;
    if (!decoded || decoded.length !== 1) return null;
    return { decoded, length: end - index + 1 };
}

function coversWholeSource(source, match) {
    return Boolean(match)
        && !source.slice(0, match.start).trim()
        && !source.slice(match.end).trim();
}

function collectHiddenRanges(
    markdown,
    extraHiddenRanges = [],
    readerMarkup = false,
    analyses = null,
    keepLinkTitles = false
) {
    const ranges = [];
    const replacements = [];
    const escapeRanges = [];
    const inlineMathRanges = [];
    const mathSourceRanges = [];
    const mathExcludedRanges = [];
    const citationExcludedRanges = [];
    let footnoteAnalysis = null;
    const footnotes = () => footnoteAnalysis ??= (
        analyses?.footnotes?.() || analyzeMarkdownFootnotes(markdown)
    );
    let widgetTexts = null;
    const tree = MARKDOWN_PARSER.parse(markdown);
    const linkReferenceLabels = collectLinkReferenceLabels(tree, markdown);
    tree.iterate({
        enter(node) {
            if (MATH_EXCLUDED_NODE_NAMES.has(node.name)) {
                mathExcludedRanges.push({ from: node.from, to: node.to });
            }
            if (readerMarkup
                && (CITATION_EXCLUDED_NODE_NAMES.has(node.name)
                    || (node.name === 'Link'
                        && !isBracketedNumericCitation(node, markdown)))) {
                citationExcludedRanges.push({ from: node.from, to: node.to });
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
            const title = keepLinkTitles
                ? null
                : hiddenLinkTitleRange(node.node, markdown, linkReferenceLabels);
            if (title) ranges.push(title);
            return undefined;
        },
    });
    for (const match of findInlineMathMatches(markdown)) {
        if (overlapsAnyRange(match, mathExcludedRanges)) continue;
        const mathRange = { from: match.start, to: match.end };
        inlineMathRanges.push(mathRange);
        mathSourceRanges.push(mathRange);
        let mark = readerMarkup ? readerMathMarkForContent(match.text) : null;
        if (mark) {
            widgetTexts ??= footnoteWidgetTexts(markdown, footnotes);
            mark = widgetTexts.get(`${match.start}:${match.end}`) ?? mark;
            replacements.push({ ...mathRange, text: mark });
            // MinerU writes "Smith $^{*}$"; the PDF text layer has
            // "Smith*". The space is not part of the mark's text.
            let spaceFrom = match.start;
            while (spaceFrom > 0 && /[ \t]/u.test(markdown[spaceFrom - 1])) {
                spaceFrom--;
            }
            if (spaceFrom < match.start
                && /[\p{L}\p{N})\]]/u.test(markdown[spaceFrom - 1] || '')) {
                ranges.push({ from: spaceFrom, to: match.start });
            }
            continue;
        }
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
    for (const match of findDisplayMathMatches(markdown)) {
        if (overlapsAnyRange(match, mathExcludedRanges)) continue;
        mathSourceRanges.push({ from: match.start, to: match.end });
    }
    appendMarkdownEscapeRanges(ranges, escapeRanges, inlineMathRanges);
    if (readerMarkup) {
        appendHTMLSuperscriptWrappers(
            ranges,
            markdown,
            citationExcludedRanges,
            analyses,
            footnotes
        );
    }
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
    return {
        hiddenRanges: mergeHiddenRanges(ranges, replacements),
        mathRanges: mergeMathSourceRanges(mathSourceRanges),
    };
}

// A replacement shows its text for its whole source range. One that a hidden
// range, such as page chrome, overlaps is left to that range.
function mergeHiddenRanges(ranges, replacements) {
    const kept = replacements.filter(replacement => !ranges.some(range => (
        range.from < replacement.to && range.to > replacement.from
    )));
    const sorted = [...ranges, ...kept].sort((left, right) => (
        left.from - right.from || left.to - right.to
    ));
    const merged = [];
    for (const range of sorted) {
        const previous = merged.at(-1);
        if (!previous || range.from > previous.to || range.text || previous.text) {
            merged.push({ ...range });
        }
        else {
            previous.to = Math.max(previous.to, range.to);
        }
    }
    return merged;
}

// The reader hides the tags around an HTML superscript it decorates as a
// citation or an affiliation mark. A footnote owns its own marks.
function appendHTMLSuperscriptWrappers(
    output,
    markdown,
    excludedRanges,
    analyses = null,
    footnotes = () => analyses?.footnotes?.() || analyzeMarkdownFootnotes(markdown)
) {
    if (!/<sup\b/iu.test(markdown)) return;
    const citations = analyses?.citations?.() || analyzeMarkdownCitations(markdown);
    const footnoteRanges = footnotes().notes
        .filter(note => note.citation)
        .flatMap(note => [
            { from: note.citation.wrapperFrom, to: note.citation.wrapperTo },
            note.mark,
        ]);
    const markups = [
        ...citations.citations.map(citation => citation.superscriptMarkup),
        ...citations.affiliations.map(affiliation => affiliation.markerMarkup),
    ];
    for (const markup of markups) {
        if (!markup?.raiseContent
            || markdown[markup.wrapperFrom] !== '<'
            || markup.wrapperFrom >= markup.contentFrom
            || markup.contentTo >= markup.wrapperTo
            || excludedRanges.some(range => (
                markup.contentFrom >= range.from && markup.contentFrom < range.to
            ))
            || footnoteRanges.some(range => (
                markup.wrapperFrom < range.to && range.from < markup.wrapperTo
            ))) {
            continue;
        }
        output.push(
            { from: markup.wrapperFrom, to: markup.contentFrom },
            { from: markup.contentTo, to: markup.wrapperTo }
        );
    }
}

function mergeMathSourceRanges(ranges) {
    const sorted = [...ranges].sort((left, right) => (
        left.from - right.from || right.to - left.to
    ));
    const merged = [];
    for (const range of sorted) {
        const previous = merged.at(-1);
        if (!previous || range.from >= previous.to) {
            merged.push({ ...range });
        }
        else {
            previous.to = Math.max(previous.to, range.to);
        }
    }
    return merged;
}

function expandRangeToMathSourceRanges(range, mathRanges) {
    if (!Number.isSafeInteger(range?.from)
        || !Number.isSafeInteger(range?.to)
        || range.from < 0
        || range.to <= range.from) {
        return range;
    }
    let from = range.from;
    let to = range.to;
    for (const mathRange of mathRanges) {
        if (from > mathRange.from && from < mathRange.to) {
            from = mathRange.from;
        }
        if (to > mathRange.from && to < mathRange.to) {
            to = mathRange.to;
        }
    }
    return { from, to };
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
