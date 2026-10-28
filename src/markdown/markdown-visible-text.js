import { GFM, parser } from '@lezer/markdown';
import {
    findDisplayMathMatches,
    findInlineMathMatches,
    zoteroNoteMathSource,
} from './markdown-html.js';
import { analyzeMarkdownCitations } from './markdown-citations.js';
import { analyzeMarkdownFootnotes } from './markdown-footnotes.js';
import { footnoteMarkDisplayText } from './footnote-marks.js';
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
// The marks of emphasis and strikethrough. Inside a formula `_`, `*` and `~`
// are TeX, but the Markdown parser does not know about `$`, so it can pair
// the `_` of `\mathcal{D}_{t}` with the `_` of a later `x_{i}`.
const MATH_PAIRABLE_MARK_NAMES = new Set([
    'EmphasisMark',
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
// text saved before a link title was hidden. `imageMath` reads a formula in
// an image description as the reader typesets it: the description doubles
// the formula's backslashes ("$\\Delta$"), and the reader undoes that.
export function createVisibleMarkdownTextIndex(
    markdown,
    extraHiddenRanges = [],
    {
        readerMarkup = false,
        analyses = null,
        keepLinkTitles = false,
        imageMath = false,
        legacyMathEmphasis = false,
    } = {}
) {
    const { hiddenRanges, mathRanges, imageRanges, formulas } = collectHiddenRanges(
        markdown,
        extraHiddenRanges,
        readerMarkup,
        analyses,
        keepLinkTitles,
        imageMath,
        legacyMathEmphasis
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
        // Whether `from..to` lies in an image description, when `imageMath`
        // is on.
        insideImage(from, to) {
            return imageRanges.some(range => (
                from >= range.from && to <= range.to
            ));
        },
        expandSourceRangeToMathBoundaries(range) {
            return expandRangeToMathSourceRanges(range, mathRanges);
        },
        // The formulas the reader typesets that lie wholly inside
        // `from..to`, in source order, as `{ from, to, tex, display }`.
        // Footnote marks, a superscript the reader shows as source, and a
        // dollar-wrapped citation are text, not formulas.
        formulasInRange(from, to) {
            return formulas.filter(formula => (
                formula.from >= from && formula.to <= to
            ));
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

// Formulas a note can hold in one selection. Past it the note gets the text.
const MAX_NOTE_FORMULAS = 200;

/**
 * The formulas the reader typesets wholly inside `range`, in source order, as
 * `{ from, to, tex, display }`. A formula in an image description is the
 * image's text, not one the reader typesets, so it is left out.
 */
export function typesetFormulasInRange(markdown, range, { analyses = null } = {}) {
    const source = String(markdown || '');
    if (!validSourceRange(range, source.length) || !/[$\\]/u.test(source)) {
        return [];
    }
    const index = visibleIndexFor(source, analyses);
    return index.formulasInRange(range.from, range.to)
        .filter(formula => !index.insideImage(formula.from, formula.to));
}

// The HTML tables (`HTMLBlock`s that open with `<table`) wholly inside
// `range`, as `{ from, to }`.
export function htmlTableBlocksInRange(markdown, range) {
    const source = String(markdown || '');
    if (!validSourceRange(range, source.length)) return [];
    return htmlTableBlocks(source).filter(block => (
        block.from >= range.from && block.to <= range.to
    ));
}

/**
 * The text a selection inside one HTML table shows, with each formula the
 * renderer typesets still between its delimiters, or null when `from..to` is
 * not inside an HTML table. Tags are left out and entities decoded, as the
 * reader shows them.
 */
export function htmlTableRangeSourceText(markdown, from, to) {
    return visibleHTMLTableRangeText(String(markdown || ''), from, to, {
        keepFormulaDelimiters: true,
    });
}

/**
 * The text and formulas of Markdown `ranges`, as the reader shows them, for a
 * Zotero note: `[{ type: 'text', text }, { type: 'math', tex, display }]`.
 * The visible text of the segments, joined, is the selection's visible text
 * with each formula's TeX in place of its delimited source.
 *
 * Returns null when the ranges hold no formula a note can typeset, so a caller
 * keeps its plain-text path.
 */
export function noteMathSegmentsForRanges(
    markdown,
    ranges,
    { analyses = null } = {}
) {
    const source = String(markdown || '');
    if (!Array.isArray(ranges) || !ranges.length) return null;
    const index = visibleIndexFor(source, analyses);
    const segments = [];
    const pushText = text => {
        if (!text) return;
        const last = segments.at(-1);
        if (last?.type === 'text') last.text += text;
        else segments.push({ type: 'text', text });
    };
    const textBefore = () => {
        const last = segments.at(-1);
        return last?.type === 'text' ? last.text : '';
    };
    let formulaCount = 0;
    let previous = null;
    for (const range of ranges) {
        if (!validSourceRange(range, source.length)) continue;
        const parts = [];
        let cursor = range.from;
        for (const formula of index.formulasInRange(range.from, range.to)) {
            // Every formula checked counts, typeset or not, so a passage of
            // broken TeX cannot run KaTeX without end. An image description
            // doubles every backslash; the reader typesets the undone form.
            // `source` stays doubled so a highlight saved from the alt still
            // matches. Feeding the doubled form to KaTeX makes a leading
            // doubled backslash a row break and drops the command.
            const readerTex = index.insideImage(formula.from, formula.to)
                ? unescapeImageMathText(formula.tex)
                : formula.tex;
            const tex = formulaCount++ < MAX_NOTE_FORMULAS
                ? zoteroNoteMathSource(readerTex, formula.display)
                : null;
            if (cursor < formula.from) {
                parts.push({ type: 'text', range: { from: cursor, to: formula.from } });
            }
            if (tex) {
                parts.push({
                    type: 'math',
                    tex,
                    source: formula.tex,
                    display: formula.display,
                });
            }
            else {
                parts.push({ type: 'text', range: { from: formula.from, to: formula.to } });
            }
            cursor = formula.to;
        }
        if (cursor < range.to) {
            parts.push({ type: 'text', range: { from: cursor, to: range.to } });
        }
        const separate = previous
            && needsSegmentSeparator(source, index, previous, range);
        let first = true;
        for (const part of parts) {
            const text = part.type === 'text'
                ? visibleRangeText(source, index, part.range)
                : '';
            if (part.type === 'text' && !text) continue;
            if (first && separate && segments.length) {
                const before = textBefore();
                const spaced = /\s$/u.test(before)
                    || (part.type === 'text' && /^\s/u.test(text));
                if (!spaced) pushText(' ');
            }
            first = false;
            if (part.type === 'text') pushText(text);
            else {
                segments.push({
                    type: 'math',
                    tex: part.tex,
                    source: part.source,
                    display: part.display,
                });
            }
        }
        previous = range;
    }
    if (!segments.some(segment => segment.type === 'math')) return null;
    const trimmed = trimNoteSegments(segments);
    // A caption selection saves the undone TeX. Keep it beside the doubled
    // source so either saved text still names this passage.
    const raw = noteMathSegmentsText(trimmed);
    const reader = unescapeImageMathText(raw);
    if (reader !== raw) trimmed.readerSavedText = reader;
    return trimmed;
}

// The text a reader saw for `segments`: each formula as the TeX the source
// wrote. A selection's saved text compares equal through
// `noteSegmentTextKey`.
export function noteMathSegmentsText(segments) {
    return (segments || []).map(segment => (
        segment.type === 'math' ? segment.source ?? segment.tex : segment.text
    )).join('');
}

// Whitespace and the formula delimiters do not decide whether two texts of
// one selection agree: a saved annotation keeps a display formula's `$$`
// when other text shares its range, and its TeX alone otherwise.
export function noteSegmentTextKey(text) {
    return String(text || '').replace(/[\s$]+/gu, '');
}

function trimNoteSegments(segments) {
    const output = segments.map(segment => ({ ...segment }));
    const first = output[0];
    if (first?.type === 'text') first.text = first.text.trimStart();
    const last = output.at(-1);
    if (last?.type === 'text') last.text = last.text.trimEnd();
    return output.filter(segment => segment.type !== 'text' || segment.text);
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
const legacyMathEmphasisIndexCache = new Map();
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
    return joinedRangeText(source, visibleIndexFor(source, analyses), ranges);
}

// Selections used to hide the `_` of a formula the Markdown parser paired
// with a `_` in another formula as emphasis ("\mathcal{T}{t}" for
// "$\mathcal{T}_{t}$"). Those saved annotations still have to match.
export function legacyMathEmphasisVisibleTextForRanges(markdown, ranges) {
    const source = String(markdown || '');
    if (!Array.isArray(ranges)) return '';
    let index = legacyMathEmphasisIndexCache.get(source);
    if (!index) {
        index = createVisibleMarkdownTextIndex(source, [], {
            readerMarkup: true,
            imageMath: true,
            legacyMathEmphasis: true,
        });
        legacyMathEmphasisIndexCache.clear();
        legacyMathEmphasisIndexCache.set(source, index);
    }
    return joinedRangeText(source, index, ranges);
}

function joinedRangeText(source, index, ranges) {
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
    return htmlTableSourceCells(source).flatMap(cell => cell.atoms);
}

// Every `td`, `th` and `caption` of an HTML table, in source order, with the
// decoded characters it shows. Text after a nested cell closes stays with the
// last cell opened. Each character records the run of text between two tags
// it belongs to, and whether the renderer typesets formulas there: inside a
// `td` or `th` and outside `code`, as sanitizeRawHTMLTable does.
export function htmlTableSourceCells(source) {
    const text = String(source || '');
    const cells = [];
    const tagPattern = /<\/?([a-zA-Z][\w:-]*)\b[^<>]*>/g;
    let cellDepth = 0;
    let typesetCellDepth = 0;
    let codeDepth = 0;
    let segment = 0;
    let index = 0;
    const appendText = to => {
        const atoms = cells.at(-1).atoms;
        const first = atoms.length;
        appendDecodedHTMLAtoms(atoms, text, index, to, cells.length - 1);
        for (let atom = first; atom < atoms.length; atom++) {
            atoms[atom].segment = segment;
            atoms[atom].typeset = typesetCellDepth > 0 && codeDepth === 0;
        }
    };
    for (const match of text.matchAll(tagPattern)) {
        if (cellDepth > 0 && match.index > index) appendText(match.index);
        segment++;
        const name = match[1].toLowerCase();
        const closing = match[0].startsWith('</');
        if (name === 'td' || name === 'th') {
            typesetCellDepth = Math.max(0, typesetCellDepth + (closing ? -1 : 1));
        }
        if (name === 'code') codeDepth = Math.max(0, codeDepth + (closing ? -1 : 1));
        if (HTML_TABLE_CELL_TAGS.has(name)) {
            if (closing) {
                cellDepth = Math.max(0, cellDepth - 1);
            }
            else if (!match[0].endsWith('/>')) {
                cellDepth += 1;
                cells.push({ tag: name, atoms: [] });
            }
        }
        index = match.index + match[0].length;
    }
    if (cellDepth > 0 && index < text.length) appendText(text.length);
    return cells;
}

// The formulas the renderer typesets in one cell: each with the indexes of
// its first and last character, and the indexes of the delimiters around its
// TeX, which the reader does not show. A superscript mark keeps its
// delimiters, as in the visible-text index. `source` is the table source the
// atom offsets point into.
export function htmlCellTypesetFormulas(source, atoms) {
    const formulas = [];
    let first = 0;
    while (first < atoms.length) {
        let last = first;
        while (last + 1 < atoms.length
            && atoms[last + 1].segment === atoms[first].segment) {
            last++;
        }
        if (atoms[first].typeset) {
            const from = atoms[first].from;
            const raw = String(source).slice(from, atoms[last].to);
            for (const match of findInlineMathMatches(raw)) {
                const start = from + match.start;
                const end = from + match.end;
                const startIndex = atoms.findIndex((atom, atomIndex) => (
                    atomIndex >= first && atomIndex <= last
                    && atom.from <= start && atom.to > start
                ));
                const endIndex = atoms.findIndex((atom, atomIndex) => (
                    atomIndex >= first && atomIndex <= last
                    && atom.from < end && atom.to >= end
                ));
                if (startIndex < 0 || endIndex < startIndex) continue;
                const delimiters = [];
                const contentOffset = match.raw.indexOf(match.text);
                if (!match.text.startsWith('^') && contentOffset >= 0) {
                    const contentFrom = start + contentOffset;
                    const contentTo = contentFrom + match.text.length;
                    for (let atom = startIndex; atom <= endIndex; atom++) {
                        if (atoms[atom].to <= contentFrom || atoms[atom].from >= contentTo) {
                            delimiters.push(atom);
                        }
                    }
                }
                formulas.push({ startIndex, endIndex, delimiters });
            }
        }
        first = last + 1;
    }
    return formulas;
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
        imageMath: true,
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
    if (math !== null) {
        return index.insideImage(range.from, range.to)
            ? unescapeImageMathText(math)
            : math;
    }
    const html = visibleHTMLTableRangeText(source, range.from, range.to);
    if (html !== null) return html;
    return index.textForSourceRange(range.from, range.to);
}

// The reader collapses the escaping an image description gives a formula.
export function unescapeImageMathText(value) {
    return String(value).replace(/\\\\/gu, '\\');
}

// The source of `range` as the reader typesets it. An image description
// stores a doubled backslash for each TeX backslash; undoing that here is
// what the caption renderer does before KaTeX. A real TeX row break outside
// an image is left alone. `text` is the slice when page chrome has already
// been removed from it.
export function imageDescriptionSource(markdown, range, text = null) {
    const source = String(markdown || '');
    const slice = text == null
        ? validSourceRange(range, source.length)
            ? source.slice(range.from, range.to)
            : ''
        : String(text);
    if (!slice.includes('\\\\') || !validSourceRange(range, source.length)) {
        return slice;
    }
    return visibleIndexFor(source).insideImage(range.from, range.to)
        ? unescapeImageMathText(slice)
        : slice;
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
                ? footnoteMarkDisplayText(content)
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
    let formulas = null;
    tree.iterate({
        enter(node) {
            if (!PAIRED_MARK_PARENTS.has(node.name)) return;
            const hidden = hiddenMarkChildren(node.node, source, labels);
            if (!hidden.length) return;
            // A pair with a mark inside a formula is TeX, shown as written.
            if (MATH_PAIRABLE_PARENT_NAMES.has(node.name)) {
                formulas ??= formulaSourceRanges(source, tree);
                if (hidden.some(mark => overlapsAnyRange(
                    { start: mark.from, end: mark.to },
                    formulas
                ))) {
                    return;
                }
            }
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

const MATH_PAIRABLE_PARENT_NAMES = new Set([
    'Emphasis',
    'StrongEmphasis',
    'Strikethrough',
]);

// The source of every inline and display formula outside code and HTML.
function formulaSourceRanges(source, tree) {
    const excluded = [];
    tree.iterate({
        enter(node) {
            if (!MATH_EXCLUDED_NODE_NAMES.has(node.name)) return undefined;
            excluded.push({ from: node.from, to: node.to });
            return false;
        },
    });
    return [...findInlineMathMatches(source), ...findDisplayMathMatches(source)]
        .filter(match => !overlapsAnyRange(match, excluded))
        .map(match => ({ from: match.start, to: match.end }));
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

// A cell shows its decoded text with each formula the renderer typesets, so
// the `$` around such a formula is not text it shows, as in a GFM cell.
// `keepFormulaDelimiters` keeps them, for a copy that is Markdown.
function visibleHTMLTableRangeText(
    source,
    from,
    to,
    { keepFormulaDelimiters = false } = {}
) {
    const block = htmlTableBlockContaining(source, from, to);
    if (!block) return null;
    const table = source.slice(block.from, block.to);
    let text = '';
    for (const cell of htmlTableSourceCells(table)) {
        const hidden = keepFormulaDelimiters
            ? new Set()
            : new Set(htmlCellTypesetFormulas(table, cell.atoms)
                .flatMap(formula => formula.delimiters));
        // A copy that keeps the formulas keeps cells apart too, so the `$`
        // of one cell cannot pair with the next.
        if (keepFormulaDelimiters && text && !/\s$/u.test(text)
            && cell.atoms.some(atom => (
                block.from + atom.from >= from && block.from + atom.to <= to
            ))) {
            text += ' ';
        }
        cell.atoms.forEach((atom, index) => {
            const atomFrom = block.from + atom.from;
            const atomTo = block.from + atom.to;
            if (atomFrom >= from && atomTo <= to && !hidden.has(index)) {
                text += atom.text;
            }
        });
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
    keepLinkTitles = false,
    imageMath = false,
    legacyMathEmphasis = false
) {
    const ranges = [];
    // Emphasis and strikethrough marks, grouped by the node they pair in.
    const pairedMarks = new Map();
    const replacements = [];
    const escapeRanges = [];
    const imageRanges = [];
    const inlineMathRanges = [];
    const mathSourceRanges = [];
    const mathExcludedRanges = [];
    const citationExcludedRanges = [];
    const formulas = [];
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
            if (imageMath && node.name === 'Image') {
                imageRanges.push({ from: node.from, to: node.to });
            }
            if (HIDDEN_SUBTREE_NAMES.has(node.name)) {
                ranges.push({ from: node.from, to: node.to });
                return false;
            }
            if (node.name === 'Escape') {
                escapeRanges.push({ from: node.from, to: node.from + 1 });
            }
            if (!legacyMathEmphasis
                && MATH_PAIRABLE_MARK_NAMES.has(node.name)
                && node.node.parent) {
                const parent = node.node.parent;
                const key = `${parent.from}:${parent.to}:${parent.name}`;
                let marks = pairedMarks.get(key);
                if (!marks) pairedMarks.set(key, marks = []);
                marks.push({ from: node.from, to: node.to });
                return undefined;
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
        if (!isDollarWrappedCitation(match.text)) {
            formulas.push({
                ...mathRange,
                tex: match.text,
                display: false,
            });
        }
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
        // A display formula's match runs through its closing line break; a
        // selection that ends at the closing `$$` still holds all of it.
        formulas.push({
            from: match.start,
            to: match.start + match.raw.trimEnd().length,
            tex: match.text,
            display: true,
        });
    }
    // A pair with a mark inside a formula is TeX, not emphasis: the reader
    // typesets the formula and shows the other mark as written.
    for (const marks of pairedMarks.values()) {
        if (marks.some(mark => overlapsAnyRange(
            { start: mark.from, end: mark.to },
            mathSourceRanges
        ))) {
            continue;
        }
        ranges.push(...marks);
    }
    appendMarkdownEscapeRanges(
        ranges,
        escapeRanges,
        inlineMathRanges,
        imageRanges,
        markdown
    );
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
        imageRanges,
        formulas: selectFormulas(formulas),
    };
}

// `$[12]$` is how OCR wraps a numeric citation; the reader shows the citation.
function isDollarWrappedCitation(text) {
    const content = String(text || '').trim();
    return content.startsWith('[')
        && content.endsWith(']')
        && isNumericCitationContent(content.slice(1, -1).trim());
}

// One formula per stretch of source, a display formula before an inline one
// that starts there.
function selectFormulas(formulas) {
    const sorted = [...formulas].sort((left, right) => (
        left.from - right.from
        || Number(right.display) - Number(left.display)
        || right.to - left.to
    ));
    const selected = [];
    let end = 0;
    for (const formula of sorted) {
        if (formula.from < end) continue;
        selected.push(formula);
        end = formula.to;
    }
    return selected;
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

// A formula keeps its escapes: TeX reads them. In an image description the
// one escape the description added, a doubled backslash, is not the
// formula's, so its first backslash is hidden like any other escape.
function appendMarkdownEscapeRanges(
    output,
    escapeRanges,
    inlineMathRanges,
    imageRanges = [],
    markdown = ''
) {
    let mathIndex = 0;
    for (const escapeRange of escapeRanges) {
        while (inlineMathRanges[mathIndex]?.to <= escapeRange.from) {
            mathIndex++;
        }
        const mathRange = inlineMathRanges[mathIndex];
        if (!mathRange || escapeRange.to <= mathRange.from) {
            output.push(escapeRange);
        }
        else if (markdown[escapeRange.to] === '\\'
            && imageRanges.some(range => (
                escapeRange.from >= range.from && escapeRange.to < range.to
            ))) {
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
