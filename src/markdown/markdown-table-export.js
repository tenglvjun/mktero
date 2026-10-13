import { parseGFMTable } from './markdown-tables.js';
import { createVisibleMarkdownTextIndex } from './markdown-visible-text.js';

// Exported tables are bounded like every other reader resource: a wildly
// padded OCR table must not build an unbounded string on a click.
export const MAX_TABLE_EXPORT_CELLS = 20_000;
export const MAX_TABLE_EXPORT_LENGTH = 2_000_000;
// A colspan/rowspan is an attribute from untrusted OCR output, so it is
// clamped to the number of columns and rows the table actually has.
const MAX_TABLE_SPAN = 200;
const CELL_HTML_TAG = /<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\/?>/giu;
const MATH_ANNOTATION = 'annotation[encoding="application/x-tex"]';
const SAFE_LINK_HREF = /^(?:https?:\/\/|zotero:\/\/|#)/iu;
const GFM_ALIGNMENTS = Object.freeze({
    left: ':---',
    right: '---:',
    center: ':---:',
});

/**
 * Write rows of already-plain cell text as RFC 4180 CSV.
 *
 * Returns null for an empty table and for output past the export budget; the
 * caller reports that as a failed copy rather than handing over half a table.
 */
export function rowsToCSV(rows) {
    const lines = [];
    let length = 0;
    for (const row of rows || []) {
        const line = (Array.isArray(row) ? row : []).map(csvCell).join(',');
        length += line.length + 2;
        if (length > MAX_TABLE_EXPORT_LENGTH) return null;
        lines.push(line);
    }
    return lines.length ? lines.join('\r\n') : null;
}

/**
 * Export a GFM table block as CSV with plain-text cells.
 *
 * The cell text comes from the Markdown source, so a citation keeps its
 * `[1]` marker and inline markup is stripped to what the reader displays.
 */
export function gfmTableToCSV(source) {
    const value = String(source ?? '');
    const model = parseGFMTable(value);
    if (!model) return null;
    const columnCount = model.header.length;
    const rowCount = 1 + model.body.length;
    if (columnCount === 0
        || rowCount * columnCount > MAX_TABLE_EXPORT_CELLS) {
        return null;
    }
    // One parse for the whole table: every cell is read from its source range.
    const text = createVisibleMarkdownTextIndex(value);
    const rows = [];
    for (let row = 0; row < rowCount; row++) {
        const cells = [];
        for (let column = 0; column < columnCount; column++) {
            const range = model.cellRanges[row * columnCount + column];
            cells.push(range
                ? normalizeCellText(text.textForSourceRange(range.from, range.to))
                : '');
        }
        rows.push(cells);
    }
    return rowsToCSV(rows);
}

/**
 * Export a rendered `<table>` element as CSV with plain-text cells.
 *
 * Merged cells are expanded so every row has one value per column, and their
 * value repeats across the merge. This is the only table form a saved snapshot
 * and a paper's own HTML table can offer, and it is the CSV counterpart of
 * `tableElementToGFM`.
 */
export function tableElementToCSV(table) {
    const grid = tableGrid(table, tableCellText);
    if (!grid) return null;
    const width = grid.values.reduce(
        (max, row) => Math.max(max, row.length),
        0
    );
    if (width === 0) return null;
    return rowsToCSV(grid.values.map(row => Array.from(
        { length: width },
        (_, column) => row[column] ?? ''
    )));
}

/**
 * Export a rendered `<table>` element as a GFM table.
 *
 * Publisher and OCR tables reach the reader as HTML, and this turns one back
 * into the pipe table a Markdown editor expects. The conversion keeps what GFM
 * can express and reports the rest as faithfully as it can:
 *
 * - a `<thead>` row becomes the header, and the first row of a table without
 *   one is promoted, because GFM has no headerless table;
 * - merged cells expand, so a value repeats across the columns or rows it
 *   covered;
 * - column alignment comes from the cells' own `align` attribute;
 * - bold, italic, code, links, formulas, and superscripts keep their meaning,
 *   and every other element contributes its text.
 *
 * The caption is not part of the table data, matching the CSV export.
 */
export function tableElementToGFM(table) {
    const rows = tableRows(table);
    if (!rows.length) return null;
    const grid = tableGrid(table, tableCellMarkdown, rows);
    if (!grid) return null;
    const width = grid.values.reduce(
        (max, row) => Math.max(max, row.length),
        0
    );
    if (width === 0) return null;
    const cellsAt = index => Array.from(
        { length: width },
        (_, column) => grid.values[index]?.[column] ?? ''
    );
    const headerIndex = rows.findIndex(row => row.closest?.('thead'));
    const header = headerIndex === -1 ? 0 : headerIndex;
    const lines = [
        formatGFMRow(cellsAt(header)),
        formatGFMRow(Array.from(
            { length: width },
            (_, column) => GFM_ALIGNMENTS[grid.alignments[column]] ?? '---'
        )),
    ];
    for (const index of grid.values.keys()) {
        if (index === header) continue;
        lines.push(formatGFMRow(cellsAt(index)));
    }
    const output = lines.join('\n');
    return output.length > MAX_TABLE_EXPORT_LENGTH ? null : output;
}

function formatGFMRow(cells) {
    return `| ${cells.join(' | ')} |`;
}

/**
 * Build one value per column from a rendered table, expanding merged cells.
 *
 * Returns null when the table has no rows or grows past the export budget, so
 * a caller never hands over part of a table.
 */
function tableGrid(table, read, knownRows = null) {
    const rows = knownRows || tableRows(table);
    if (!rows.length) return null;
    const values = [];
    const alignments = [];
    let cellCount = 0;
    for (const [rowIndex, row] of rows.entries()) {
        const target = values[rowIndex] || (values[rowIndex] = []);
        let column = 0;
        for (const cell of tableCells(row)) {
            while (target[column] !== undefined) column++;
            const value = read(cell);
            const columns = tableSpan(cell, 'colspan', MAX_TABLE_SPAN);
            const rowSpan = Math.min(
                tableSpan(cell, 'rowspan', MAX_TABLE_SPAN),
                rows.length - rowIndex
            );
            cellCount += columns * rowSpan;
            if (cellCount > MAX_TABLE_EXPORT_CELLS) return null;
            if (!alignments[column]) {
                const alignment = String(cell.getAttribute?.('align') || '')
                    .toLowerCase();
                if (Object.hasOwn(GFM_ALIGNMENTS, alignment)) {
                    alignments[column] = alignment;
                }
            }
            for (let offset = 0; offset < rowSpan; offset++) {
                const spanned = values[rowIndex + offset]
                    || (values[rowIndex + offset] = []);
                for (let width = 0; width < columns; width++) {
                    spanned[column + width] = value;
                }
            }
            column += columns;
        }
    }
    return { values, alignments };
}

function tableRows(table) {
    if (typeof table?.querySelectorAll !== 'function') return [];
    return [...table.querySelectorAll('tr')].filter(row => (
        row.closest?.('table') === table
    ));
}

function tableCells(row) {
    return [...(row.children || [])].filter(element => (
        element.localName === 'th' || element.localName === 'td'
    ));
}

function tableSpan(cell, attribute, maximum) {
    const value = Number.parseInt(cell.getAttribute?.(attribute) || '1', 10);
    if (!Number.isFinite(value) || value < 1) return 1;
    return Math.min(value, maximum);
}

/**
 * One cell of plain text: inline HTML becomes its text, and whitespace runs
 * collapse to a single space so a cell never breaks the line it sits on.
 */
function tableCellText(cell) {
    const clone = cell.cloneNode(true);
    // KaTeX paints MathML and keeps the source in an `annotation`; without this
    // a formula would export as its flattened glyphs.
    for (const annotation of clone.querySelectorAll?.(
        MATH_ANNOTATION
    ) || []) {
        const rendered = annotation.closest?.('.katex')
            || annotation.closest?.('math');
        if (!rendered) continue;
        rendered.replaceWith(
            cell.ownerDocument.createTextNode(mathSource(annotation))
        );
    }
    for (const br of clone.querySelectorAll?.('br') || []) {
        br.replaceWith(cell.ownerDocument.createTextNode(' '));
    }
    return normalizeCellText(clone.textContent || '');
}

/**
 * One cell of GFM inline Markdown.
 *
 * Text is escaped, and the markup GFM can express is rebuilt from the elements
 * around it. Unknown elements are transparent: their text is what the reader
 * already displays.
 */
function tableCellMarkdown(cell) {
    return renderCellChildren(cell).replace(/\s+/gu, ' ').trim();
}

function renderCellChildren(element) {
    let output = '';
    for (const node of element.childNodes || []) {
        output += renderCellNode(node);
    }
    return output;
}

function renderCellNode(node) {
    if (node.nodeType === 3) return escapeCellText(node.nodeValue || '');
    if (node.nodeType !== 1) return '';
    if (node.classList?.contains?.('katex') || node.localName === 'math') {
        const annotation = node.querySelector?.(MATH_ANNOTATION);
        const source = annotation ? mathSource(annotation) : '';
        if (source) return source;
    }
    const name = node.localName;
    if (name === 'br') return ' ';
    if (name === 'strong' || name === 'b') return emphasize(node, '**');
    if (name === 'em' || name === 'i') return emphasize(node, '*');
    if (name === 'code') return codeSpan(node);
    if (name === 'a') return linkMarkup(node);
    if (name === 'sup' || name === 'sub') {
        return `<${name}>${renderCellChildren(node)}</${name}>`;
    }
    return renderCellChildren(node);
}

function emphasize(node, marker) {
    const inner = renderCellChildren(node);
    if (!inner.trim()) return inner;
    // A marker inside its own emphasis would produce a broken run.
    return inner.includes(marker[0]) ? inner : `${marker}${inner}${marker}`;
}

function codeSpan(node) {
    // A code span is not entity-decoded, so its text stays as written and only
    // the cell separator needs escaping.
    const text = String(node.textContent || '')
        .replace(/\s+/gu, ' ')
        .trim();
    if (!text) return '';
    const escaped = escapeCellPipes(text);
    return escaped.includes('`') ? escaped : `\`${escaped}\``;
}

function linkMarkup(node) {
    const label = renderCellChildren(node).trim();
    const href = String(node.getAttribute?.('href') || '').trim();
    if (!label || !SAFE_LINK_HREF.test(href) || /[()\s]/u.test(href)) {
        return label;
    }
    return `[${label}](${escapeCellPipes(href)})`;
}

function mathSource(annotation) {
    const text = String(annotation.textContent || '').trim();
    return text ? `$${text}$` : '';
}

function escapeCellText(value) {
    return String(value ?? '')
        .replace(/[<>]/gu, character => (
            character === '<' ? '&lt;' : '&gt;'
        ))
        .replace(/(?<!\\)\|/gu, '\\|');
}

function escapeCellPipes(value) {
    return String(value ?? '').replace(/(?<!\\)\|/gu, '\\|');
}

function normalizeCellText(value) {
    return String(value ?? '')
        .replace(CELL_HTML_TAG, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

function csvCell(value) {
    const text = String(value ?? '');
    return /[",\r\n]/u.test(text)
        ? `"${text.replace(/"/gu, '""')}"`
        : text;
}
