// The text/plain flavor of a copy from the reader: standard Markdown.
//
// A copy is pasted into a Zotero note, a Markdown editor, or anything else,
// and should read the same everywhere as it does in the reader. The text is
// the passage's Markdown with three changes, so an editor that reads
// CommonMark, GFM, and TeX math shows what the reader shows:
//
// - each formula the reader typesets is `$…$` or a `$$` block around the TeX
//   the reader typesets, its OCR repairs included;
// - a table the paper carries as HTML is a GFM pipe table with its formulas,
//   since an editor does not typeset TeX inside raw HTML;
// - the page headers, footers, and page labels the reader hides, and
//   Mktero's own structural comments, are left out.
//
// The note HTML of the same passage (`zoteroNoteClipboardHTML`) is the
// text/html flavor.

import {
    findInlineMathMatches,
    portableMathSource,
} from './markdown-html.js';
import { tableElementToGFM } from './markdown-table-export.js';
import {
    htmlTableBlocksInRange,
    htmlTableRangeSourceText,
    typesetFormulasInRange,
} from './markdown-visible-text.js';
import { renderZoteroNoteHTML } from './zotero-note-html-renderer.js';
import { expandToFormulaBoundaries } from './zotero-note-clipboard.js';

// A copy is rewritten while the copy event is dispatched. Formulas cost a
// string scan each; tables are rendered and parsed, so their count is capped
// and the rest stay HTML.
export const MAX_PORTABLE_MARKDOWN_SOURCE_LENGTH = 2_000_000;
const MAX_PORTABLE_TABLES = 64;
// Page labels and structural directives Mktero writes as comments. An editor
// hides a comment, but the pasted source would still carry it.
const MKTERO_COMMENT_LINE = /^[ \t]*<!--[ \t]*(?:zotero-page:|\/?mktero-)[^\n]*?-->[ \t]*(?:\r?\n|$)/gmu;
const UNESCAPED_PERCENT = /(?<!\\)%/u;

/**
 * One formula as standard Markdown: `$tex$` inline, and a display formula as
 * a `$$` block on lines of its own. An inline formula is kept on one line, and
 * a display formula without blank lines, which would end it in most editors.
 */
export function portableMathMarkdown(tex, display = false) {
    const source = String(tex ?? '').trim();
    if (!source) return '';
    if (display) {
        return `$$\n${source.replace(/\n[ \t]*(?:\n[ \t]*)+/gu, '\n')}\n$$`;
    }
    // A TeX comment runs to the end of its line, so that formula keeps its
    // line breaks.
    const inline = UNESCAPED_PERCENT.test(source)
        ? source
        : source.replace(/[ \t]*\r?\n[ \t]*/gu, ' ');
    return `$${inline}$`;
}

/**
 * Standard Markdown for the passage between `from` and `to`, or null when
 * the range is not one of `markdown`. A range that cuts a formula takes all
 * of it. `chromeRanges` are the page chrome the reader hides. `document`
 * parses an HTML table to write it as GFM; without it the table stays HTML.
 * A passage with nothing to change is returned as written.
 */
export function portableMarkdownForRange(
    markdown,
    { from, to } = {},
    { chromeRanges = [], document = null, analyses = null } = {}
) {
    const source = String(markdown || '');
    if (!Number.isSafeInteger(from)
        || !Number.isSafeInteger(to)
        || from < 0
        || to <= from
        || to > source.length
        || to - from > MAX_PORTABLE_MARKDOWN_SOURCE_LENGTH) {
        return null;
    }
    const range = expandToFormulaBoundaries(source, { from, to });
    // Removed and rewritten blocks; a formula inside one is left to it.
    const blocks = mergedRanges(chromeRanges, range)
        .map(hidden => ({ ...hidden, text: '' }));
    let tables = 0;
    for (const block of htmlTableBlocksInRange(source, range)) {
        if (tables >= MAX_PORTABLE_TABLES) break;
        const table = htmlTableExtent(source, block);
        if (!table || overlapsAny(table, blocks)) continue;
        tables++;
        const gfm = htmlTableGFM(source.slice(table.from, table.to), document);
        if (gfm) blocks.push({ ...table, text: gfm, block: true });
    }
    for (const comment of mkteroCommentLines(source, range)) {
        if (!overlapsAny(comment, blocks)) blocks.push(comment);
    }
    const edits = [...blocks];
    for (const formula of typesetFormulasInRange(source, range, { analyses })) {
        if (overlapsAny(formula, blocks)) continue;
        const tex = portableMathSource(formula.tex);
        if (tex === null) continue;
        const text = portableMathMarkdown(tex, formula.display);
        if (text !== source.slice(formula.from, formula.to)) {
            edits.push({ from: formula.from, to: formula.to, text });
        }
    }
    if (!edits.length) return source.slice(range.from, range.to);
    edits.sort((left, right) => left.from - right.from || left.to - right.to);
    return applyEdits(source, range, edits);
}

/**
 * The text of a selection inside one cell of an HTML table, as Markdown:
 * the cell text the reader shows with each formula between `$`, written with
 * the TeX the reader typesets. Null outside an HTML table.
 */
export function portableHTMLTableRangeText(markdown, { from, to } = {}) {
    const text = htmlTableRangeSourceText(markdown, from, to);
    if (text === null) return null;
    return portableInlineFormulas(text.replace(/\s+/gu, ' ').trim());
}

/**
 * `text` with each inline formula written as `portableMathMarkdown` does.
 * `escapeText` escapes the text between formulas, for a caller that writes
 * text as Markdown.
 */
export function portableInlineFormulas(text, { escapeText = value => value } = {}) {
    const source = String(text ?? '');
    if (!/[$\\]/u.test(source)) return escapeText(source);
    let output = '';
    let cursor = 0;
    for (const match of findInlineMathMatches(source)) {
        const tex = portableMathSource(match.text);
        if (tex === null) continue;
        output += escapeText(source.slice(cursor, match.start));
        output += portableMathMarkdown(tex, false);
        cursor = match.end;
    }
    return output + escapeText(source.slice(cursor));
}

function applyEdits(source, range, edits) {
    let output = '';
    let cursor = range.from;
    // The source between the last text kept and the next: the blocks removed
    // and the whitespace around them, which decides the line breaks that
    // join the two. Null while nothing was removed.
    let gap = null;
    let paragraphBreak = false;
    const write = text => {
        if (!text) return;
        if (gap === null && !paragraphBreak) {
            output += text;
            return;
        }
        const leading = /^\s*/u.exec(text)[0];
        const rest = text.slice(leading.length);
        gap = (gap ?? '') + leading;
        if (!rest) return;
        if (output) output += paragraphBreak ? '\n\n' : gapSeparator(gap);
        output += rest;
        gap = null;
        paragraphBreak = false;
    };
    const openGap = removed => {
        if (gap === null) {
            const length = trailingWhitespaceLength(output);
            gap = output.slice(output.length - length);
            output = output.slice(0, output.length - length);
        }
        gap += removed;
    };
    for (const edit of edits) {
        if (edit.from < cursor) continue;
        write(source.slice(cursor, edit.from));
        const removed = source.slice(edit.from, edit.to);
        cursor = edit.to;
        if (!edit.text) {
            openGap(removed);
        }
        else if (edit.block) {
            // A table stands apart from the text around it.
            openGap('');
            paragraphBreak = true;
            write(edit.text);
            openGap('');
            paragraphBreak = true;
        }
        else {
            write(edit.text);
        }
    }
    write(source.slice(cursor, range.to));
    return output;
}

// A blank line in what was removed keeps two blocks apart; a line break
// alone continues the paragraph, as hidden page chrome inside one does.
function gapSeparator(gap) {
    if (/\n[ \t]*\n/u.test(gap)) return '\n\n';
    if (gap.includes('\n')) return '\n';
    return /\s/u.test(gap) ? ' ' : '';
}

function trailingWhitespaceLength(text) {
    let index = text.length;
    while (index > 0 && /\s/u.test(text[index - 1])) index--;
    return text.length - index;
}

// The `<table>…</table>` of an HTML block, which runs on to any text after
// the table up to a blank line.
function htmlTableExtent(source, block) {
    const text = source.slice(block.from, block.to);
    const start = text.search(/<table\b/iu);
    const end = text.toLowerCase().lastIndexOf('</table>');
    if (start < 0 || end < start) return null;
    return {
        from: block.from + start,
        to: block.from + end + '</table>'.length,
    };
}

function mergedRanges(ranges, within) {
    const clipped = (Array.isArray(ranges) ? ranges : [])
        .filter(item => Number.isSafeInteger(item?.from)
            && Number.isSafeInteger(item?.to)
            && item.from < within.to
            && item.to > within.from)
        .map(item => ({
            from: Math.max(item.from, within.from),
            to: Math.min(item.to, within.to),
        }))
        .sort((left, right) => left.from - right.from);
    const merged = [];
    for (const item of clipped) {
        const last = merged.at(-1);
        if (last && item.from <= last.to) last.to = Math.max(last.to, item.to);
        else merged.push(item);
    }
    return merged;
}

function overlapsAny(range, ranges) {
    return ranges.some(item => range.from < item.to && range.to > item.from);
}

function mkteroCommentLines(source, range) {
    const slice = source.slice(range.from, range.to);
    if (!slice.includes('<!--')) return [];
    const lines = [];
    for (const match of slice.matchAll(MKTERO_COMMENT_LINE)) {
        lines.push({
            from: range.from + match.index,
            to: range.from + match.index + match[0].length,
            text: '',
        });
    }
    return lines;
}

// The GFM of one HTML table, written from the note HTML the reader's table
// would paste as, so its formulas carry the same TeX. Null for anything but
// one plain table, which then stays HTML.
function htmlTableGFM(tableSource, document) {
    const DOMParserType = document?.defaultView?.DOMParser;
    if (typeof DOMParserType !== 'function') return null;
    const trimmed = String(tableSource || '').trim();
    if (!/^<table\b[\s\S]*<\/table>$/iu.test(trimmed)
        || (trimmed.match(/<table\b/giu) || []).length !== 1) {
        return null;
    }
    try {
        const parsed = new DOMParserType().parseFromString(
            `<!doctype html><html><body>${renderZoteroNoteHTML(trimmed)}</body></html>`,
            'text/html'
        );
        const tables = parsed.body?.querySelectorAll?.('table') || [];
        if (tables.length !== 1 || tables[0].querySelector('caption')) return null;
        return tableElementToGFM(tables[0]);
    }
    catch {
        return null;
    }
}
