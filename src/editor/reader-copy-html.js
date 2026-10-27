// The text/html flavor of a copy from the Markdown reader.
//
// A Zotero note renders a formula only from its own math markup, so a copy
// that carries Markdown alone pastes `$…$` as text, or relies on the note
// editor guessing that the text is Markdown. The HTML here is the note markup
// of the copied passage (`renderZoteroNoteHTML`), so a paste into a note keeps
// its formulas and tables. The text/plain flavor stays the Markdown source.
// A passage with no formula and no table gets no HTML.

import { selectedMarkdownAnnotation } from './inline-rendering.js';
import { rootSelectionFor } from './root-selection.js';
import { tableElementToGFM } from '../markdown/markdown-table-export.js';
import {
    expandToFormulaBoundaries,
    MAX_NOTE_CLIPBOARD_SOURCE_LENGTH,
    zoteroNoteClipboardHTML,
    zoteroNoteTableClipboardHTML,
} from '../markdown/zotero-note-clipboard.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const TABLE_SECTION_TAGS = new Set(['thead', 'tbody', 'tfoot']);
// The rendered blocks the browser would copy as glyphs: formulas and tables.
const RENDERED_COPY_BLOCKS = [
    '.cm-mktero-math',
    '.cm-mktero-math-display',
    '.cm-mktero-table',
    '.cm-mktero-html-table',
].join(', ');

/**
 * The note HTML of what CodeMirror copied as `copiedText`: its selection, or
 * the caret's line when nothing is selected, as `copiedRange` does. Empty
 * when the copied text is not that, so the two flavors never disagree.
 */
export function codeMirrorCopyHTML(state, copiedText, { chromeRanges = [] } = {}) {
    const ranges = state.selection.ranges.filter(range => !range.empty);
    const pieces = ranges.length
        ? ranges.map(range => ({ from: range.from, to: range.to }))
        : state.selection.ranges.map(({ from }) => {
            const line = state.doc.lineAt(from);
            return { from: line.from, to: line.to };
        });
    const total = pieces.reduce((sum, range) => sum + range.to - range.from, 0);
    if (total > MAX_NOTE_CLIPBOARD_SOURCE_LENGTH) return '';
    const expected = pieces
        .map(range => state.sliceDoc(range.from, range.to))
        .join(state.lineBreak);
    if (normalizeLineBreaks(expected) !== normalizeLineBreaks(copiedText)) {
        return '';
    }
    const markdown = state.doc.toString();
    return pieces
        .map(range => zoteroNoteClipboardHTML(markdown, range, { chromeRanges }))
        .filter(Boolean)
        .join('\n');
}

/**
 * Both flavors of a copy CodeMirror leaves to the browser: a selection that
 * starts or ends inside a rendered formula or table, which the browser would
 * copy as its rendered glyphs. Returns `{ text, html }` with the passage's
 * Markdown source and note HTML, or null when the selection touches no
 * rendered formula or table, or does not map to the source, so the browser
 * copies it.
 */
export function renderedSelectionCopy(
    view,
    { chromeRanges = [], analysisCache = null } = {}
) {
    const selection = rootSelectionFor(view.dom);
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
        return null;
    }
    const range = selection.getRangeAt(0);
    if (!inRenderedCopyBlock(view, range.startContainer)
        && !inRenderedCopyBlock(view, range.endContainer)) {
        return null;
    }
    const table = selectedTableFragment(view, range);
    if (table) return table;
    const annotation = selectedMarkdownAnnotation(view, chromeRanges, {
        analysisCache,
    });
    const ranges = annotation?.ranges?.filter(item => (
        Number.isSafeInteger(item?.from) && Number.isSafeInteger(item?.to)
    ));
    if (!ranges?.length) return null;
    const markdown = view.state.doc.toString();
    const { from, to } = expandToFormulaBoundaries(markdown, {
        from: Math.min(...ranges.map(item => item.from)),
        to: Math.max(...ranges.map(item => item.to)),
    });
    const source = markdown.slice(from, to).trim();
    if (!source) return null;
    // Inside a table the paper carries as HTML, the source is tags; the
    // text a reader expects is the cell's own, with its formulas as TeX.
    const text = inHTMLTable(view, range) && annotation.text
        ? annotation.text
        : source;
    return {
        text,
        html: zoteroNoteClipboardHTML(markdown, { from, to }, { chromeRanges }),
    };
}

function normalizeLineBreaks(value) {
    return String(value || '').replace(/\r\n?/gu, '\n');
}

// A selection across cells of one rendered table copies those cells as a
// table. Within one cell it is a passage, which the caller maps to source.
function selectedTableFragment(view, range) {
    const startCell = closestCell(range.startContainer);
    const endCell = closestCell(range.endContainer);
    if (!startCell || !endCell || startCell === endCell) return null;
    const table = startCell.closest('table');
    if (!table || table !== endCell.closest('table') || !view.dom.contains(table)) {
        return null;
    }
    let fragment;
    try {
        fragment = range.cloneContents();
    }
    catch {
        return null;
    }
    const copy = tableFromFragment(table.ownerDocument, fragment);
    if (!copy) return null;
    const text = tableElementToGFM(copy);
    if (!text) return null;
    return { text, html: zoteroNoteTableClipboardHTML(text) };
}

function closestCell(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    return element?.closest?.('td, th') || null;
}

function inRenderedCopyBlock(view, node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    const block = element?.closest?.(RENDERED_COPY_BLOCKS);
    return Boolean(block && view.dom.contains(block));
}

function inHTMLTable(view, range) {
    const element = range.startContainer?.nodeType === 1
        ? range.startContainer
        : range.startContainer?.parentElement;
    const block = element?.closest?.('.cm-mktero-html-table');
    return Boolean(block && view.dom.contains(block));
}

// `cloneContents` returns the selected cells under the deepest element the
// selection shares: rows, a section, or the table itself.
function tableFromFragment(document, fragment) {
    const table = createElement(document, 'table');
    const body = createElement(document, 'tbody');
    let row = null;
    for (const node of [...fragment.childNodes]) {
        const name = node.localName;
        if (name === 'table') {
            for (const child of [...node.childNodes]) table.appendChild(child);
            continue;
        }
        if (TABLE_SECTION_TAGS.has(name)) {
            table.appendChild(node);
            continue;
        }
        if (name === 'tr') {
            body.appendChild(node);
            row = null;
            continue;
        }
        if (name === 'td' || name === 'th') {
            if (!row) {
                row = createElement(document, 'tr');
                body.appendChild(row);
            }
            row.appendChild(node);
        }
    }
    if (body.childNodes.length) table.appendChild(body);
    return table.querySelector('td, th') ? table : null;
}

function createElement(document, name) {
    return typeof document.createElementNS === 'function'
        ? document.createElementNS(XHTML_NAMESPACE, name)
        : document.createElement(name);
}
