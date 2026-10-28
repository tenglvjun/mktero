import { renderZoteroNoteHTML } from './zotero-note-html-renderer.js';
import { findDisplayMathMatches, findInlineMathMatches } from './markdown-html.js';

// A copy is rendered while the copy event is dispatched, on Zotero's main
// thread. Past these the clipboard keeps the plain Markdown only, so a
// whole-paper copy stays quick: the source length, and the formulas KaTeX
// checks before the note may store them.
export const MAX_NOTE_CLIPBOARD_SOURCE_LENGTH = 100_000;
export const MAX_NOTE_CLIPBOARD_FORMULAS = 300;
const NOTE_MATH_MARKUP = /<(?:span|pre)\b[^>]*\bclass="math"/iu;
const UNSAFE_NOTE_CLIPBOARD_HTML = /<(?:script|img|iframe|object|embed|link|meta|style)\b|javascript:|\son[a-z]+\s*=/iu;
// Only a passage with a formula or a table needs the note markup. Without
// one, a paste keeps working as it did, Markdown editors included.
const NOTE_MARKUP_HINT = /\$|\\\(|\\\[|<table\b|^[ \t]*\|/mu;

/**
 * The Zotero note HTML of the Markdown between `from` and `to`, for the
 * text/html flavor of a copy, or '' when there is none worth adding.
 *
 * A note renders a formula only from `<span class="math">` and
 * `<pre class="math">`, so the HTML carries the formulas of the passage in
 * that form. A range that cuts a formula takes all of it. Page chrome the
 * reader hides is left out, as are the page labels between pages.
 */
export function zoteroNoteClipboardHTML(
    markdown,
    { from, to } = {},
    { chromeRanges = [] } = {}
) {
    const source = String(markdown || '');
    if (!Number.isSafeInteger(from)
        || !Number.isSafeInteger(to)
        || from < 0
        || to <= from
        || to > source.length
        || to - from > MAX_NOTE_CLIPBOARD_SOURCE_LENGTH) {
        return '';
    }
    const range = expandToFormulaBoundaries(source, { from, to });
    const slice = sliceWithoutRanges(source, range, chromeRanges);
    if (!slice.trim()
        || slice.length > MAX_NOTE_CLIPBOARD_SOURCE_LENGTH
        || !NOTE_MARKUP_HINT.test(slice)
        || formulaCount(slice) > MAX_NOTE_CLIPBOARD_FORMULAS) {
        return '';
    }
    try {
        return stripPageMarkers(renderZoteroNoteHTML(slice)).trim();
    }
    catch {
        return '';
    }
}

// HTML a hosted note may insert on paste. The note editor's content
// iframe often receives only the plain text, so the host inserts this itself.
// Anything that is not note math markup is left for the editor.
export function noteMathClipboardHTML(html) {
    const source = String(html || '').trim();
    if (!source
        || source.length > MAX_NOTE_CLIPBOARD_SOURCE_LENGTH
        || UNSAFE_NOTE_CLIPBOARD_HTML.test(source)
        || !NOTE_MATH_MARKUP.test(source)) {
        return '';
    }
    return source;
}

/**
 * The note HTML of a GFM table, or '' when the Markdown is not a table.
 * A table copied in part from the reader comes here as the GFM of the cells
 * the reader selected.
 */
export function zoteroNoteTableClipboardHTML(gfm) {
    const source = String(gfm || '');
    if (!source.trim()
        || source.length > MAX_NOTE_CLIPBOARD_SOURCE_LENGTH
        || formulaCount(source) > MAX_NOTE_CLIPBOARD_FORMULAS) {
        return '';
    }
    try {
        const html = renderZoteroNoteHTML(source);
        return /<table\b/iu.test(html) ? html.trim() : '';
    }
    catch {
        return '';
    }
}

/**
 * The note HTML of a whole Markdown text Mktero wrote for the clipboard, such
 * as a sourced quote, or '' when it is empty or past the clipboard budgets.
 * Unlike a reader passage, it gets HTML without a formula too: its escaped
 * punctuation and source link read as text and a link in a note.
 */
export function zoteroNoteMarkdownHTML(markdown) {
    const source = String(markdown || '');
    if (!source.trim()
        || source.length > MAX_NOTE_CLIPBOARD_SOURCE_LENGTH
        || formulaCount(source) > MAX_NOTE_CLIPBOARD_FORMULAS) {
        return '';
    }
    try {
        return stripPageMarkers(renderZoteroNoteHTML(source)).trim();
    }
    catch {
        return '';
    }
}

/**
 * `{ from, to }` widened to whole formulas when an end falls inside one. Only
 * the blocks around the two ends are read: a formula does not cross a blank
 * line, so a copy never scans the whole paper.
 */
export function expandToFormulaBoundaries(markdown, { from, to }) {
    const source = String(markdown || '');
    return {
        from: formulaBoundary(source, from, 'start'),
        to: formulaBoundary(source, to, 'end'),
    };
}

function formulaBoundary(source, offset, side) {
    if (offset <= 0 || offset >= source.length) return offset;
    const previous = source.lastIndexOf('\n\n', offset - 1);
    const start = previous < 0 ? 0 : previous + 2;
    const next = source.indexOf('\n\n', offset);
    const end = next < 0 ? source.length : next;
    const block = source.slice(start, end);
    if (!/[$\\]/u.test(block)) return offset;
    for (const match of [
        ...findDisplayMathMatches(block),
        ...findInlineMathMatches(block),
    ]) {
        const matchFrom = start + match.start;
        const matchTo = start + match.end;
        if (offset > matchFrom && offset < matchTo) {
            return side === 'start' ? matchFrom : matchTo;
        }
    }
    return offset;
}

function formulaCount(source) {
    if (!/[$\\]/u.test(source)) return 0;
    return findInlineMathMatches(source).length
        + findDisplayMathMatches(source).length;
}

function sliceWithoutRanges(source, range, hiddenRanges) {
    const hidden = (Array.isArray(hiddenRanges) ? hiddenRanges : [])
        .filter(item => Number.isSafeInteger(item?.from)
            && Number.isSafeInteger(item?.to)
            && item.from < range.to
            && item.to > range.from)
        .sort((left, right) => left.from - right.from);
    let output = '';
    let cursor = range.from;
    for (const item of hidden) {
        if (item.from > cursor) output += source.slice(cursor, item.from);
        cursor = Math.max(cursor, Math.min(item.to, range.to));
    }
    if (cursor < range.to) output += source.slice(cursor, range.to);
    return output;
}

// The snapshot renderer labels each page break. Pasted into a note, the label
// would read as part of the passage.
function stripPageMarkers(html) {
    return String(html || '').replace(
        /<span class="page-marker" data-page="[^"]*">[^<]*<\/span>/gu,
        ''
    );
}
