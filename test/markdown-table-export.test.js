import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
    MAX_TABLE_EXPORT_CELLS,
    gfmTableToCSV,
    rowsToCSV,
    tableElementToCSV,
    tableElementToGFM,
} from '../src/markdown/markdown-table-export.js';

const GFM_TABLE = [
    '| Model | Acc. | Note |',
    '| --- | ---: | :---: |',
    '| A | 91.2 | **best** |',
    '| B | 88.0 | see [1] |',
].join('\n');

function tableFromHTML(html) {
    const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
    return dom.window.document.querySelector('table');
}

test('writes rows as RFC 4180 CSV', () => {
    assert.equal(
        rowsToCSV([['a', 'b'], ['c', 'd']]),
        'a,b\r\nc,d'
    );
    assert.equal(
        rowsToCSV([['a,b', 'say "hi"'], ['plain', '']]),
        '"a,b","say ""hi"""\r\nplain,'
    );
    assert.equal(
        rowsToCSV([['line\nbreak', 'tab\tkept']]),
        '"line\nbreak",tab\tkept'
    );
});

test('returns no CSV for an empty table', () => {
    assert.equal(rowsToCSV([]), null);
    assert.equal(rowsToCSV(null), null);
});

test('exports a GFM table as plain-text CSV', () => {
    assert.equal(
        gfmTableToCSV(GFM_TABLE),
        'Model,Acc.,Note\r\nA,91.2,best\r\nB,88.0,see [1]'
    );
});

test('strips inline markup and keeps the citation marker', () => {
    const csv = gfmTableToCSV([
        '| Source | Value |',
        '| --- | --- |',
        '| [Paper](https://example.com/x) | `p<0.05` |',
        '| *italic* and $a_i$ | H<sub>2</sub>O |',
    ].join('\n'));

    assert.equal(
        csv,
        'Source,Value\r\nPaper,p<0.05\r\nitalic and a_i,H 2 O'
    );
});

test('keeps an escaped pipe inside a cell', () => {
    const csv = gfmTableToCSV([
        '| Symbol | Meaning |',
        '| --- | --- |',
        '| a \\| b | union |',
    ].join('\n'));

    assert.equal(csv, 'Symbol,Meaning\r\na | b,union');
});

test('pads a ragged row to the header width', () => {
    const csv = gfmTableToCSV([
        '| A | B | C |',
        '| --- | --- | --- |',
        '| 1 |',
        '| 4 | 5 | 6 | extra |',
    ].join('\n'));

    assert.equal(csv, 'A,B,C\r\n1,,\r\n4,5,6');
});

test('accepts a table without leading and trailing pipes', () => {
    const csv = gfmTableToCSV([
        'A | B',
        '--- | ---',
        '1 | 2',
    ].join('\n'));

    assert.equal(csv, 'A,B\r\n1,2');
});

test('quotes a cell that contains a comma', () => {
    const csv = gfmTableToCSV([
        '| Metric | Value |',
        '| --- | --- |',
        '| p-value, two-sided | 0.03 |',
    ].join('\n'));

    assert.equal(csv, 'Metric,Value\r\n"p-value, two-sided",0.03');
});

test('returns no CSV when the block is not a GFM table', () => {
    assert.equal(gfmTableToCSV(''), null);
    assert.equal(gfmTableToCSV('just a paragraph'), null);
    assert.equal(gfmTableToCSV('| A | B |'), null);
    assert.equal(gfmTableToCSV('| A | B |\n| --- |\n| 1 | 2 |'), null);
    assert.equal(gfmTableToCSV('| A | B |\n| nope | nope |\n| 1 | 2 |'), null);
});

test('refuses a table past the cell budget', () => {
    const columns = 200;
    const header = `|${' h |'.repeat(columns)}`;
    const separator = `|${' --- |'.repeat(columns)}`;
    // 101 rows of 200 columns is just past MAX_TABLE_EXPORT_CELLS.
    const body = new Array(Math.ceil(MAX_TABLE_EXPORT_CELLS / columns) + 1)
        .fill(header);

    assert.equal(gfmTableToCSV([header, separator, ...body].join('\n')), null);
});

test('exports a rendered table element as CSV', () => {
    const table = tableFromHTML(
        '<table><thead><tr><th>A</th><th>B</th></tr></thead>'
        + '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>'
    );

    assert.equal(tableElementToCSV(table), 'A,B\r\n1,2');
});

test('leaves the caption of a rendered table out of the CSV', () => {
    const table = tableFromHTML(
        '<table><caption>Table 1: results</caption>'
        + '<tr><th>A</th></tr><tr><td>1</td></tr></table>'
    );

    assert.equal(tableElementToCSV(table), 'A\r\n1');
});

test('expands merged cells so every row has one value per column', () => {
    const table = tableFromHTML(
        '<table>'
        + '<tr><th colspan="2">Merged</th><th>C</th></tr>'
        + '<tr><td rowspan="2">A</td><td>B</td><td>C1</td></tr>'
        + '<tr><td>B2</td></tr>'
        + '</table>'
    );

    assert.equal(
        tableElementToCSV(table),
        'Merged,Merged,C\r\nA,B,C1\r\nA,B2,'
    );
});

test('ignores a nested table and a table without rows', () => {
    const nested = tableFromHTML(
        '<table><tr><td>outer '
        + '<table><tr><td>inner</td></tr></table>'
        + '</td></tr></table>'
    );
    assert.equal(tableElementToCSV(nested), 'outer inner');
    assert.equal(tableElementToCSV(tableFromHTML('<table></table>')), null);
    assert.equal(tableElementToCSV(null), null);
});

test('reads KaTeX math from its annotation instead of its glyphs', () => {
    const table = tableFromHTML(
        '<table><tr><td>'
        + '<span class="math-inline"><span class="katex">'
        + '<math xmlns="http://www.w3.org/1998/Math/MathML"><semantics>'
        + '<mrow><msub><mi>a</mi><mi>i</mi></msub></mrow>'
        + '<annotation encoding="application/x-tex">a_i</annotation>'
        + '</semantics></math></span></span>'
        + '</td></tr></table>'
    );

    assert.equal(tableElementToCSV(table), '$a_i$');
});

test('collapses line breaks and whitespace inside a cell', () => {
    const table = tableFromHTML(
        '<table><tr><td>first<br>second</td><td>  spaced   out  </td></tr></table>'
    );

    assert.equal(tableElementToCSV(table), 'first second,spaced out');
});

test('clamps an absurd merged span instead of allocating it', () => {
    const table = tableFromHTML(
        '<table><tr><td colspan="400">wide</td></tr></table>'
    );
    const csv = tableElementToCSV(table);

    assert.equal(csv.split(',').length, 200);
    assert.equal(csv.startsWith('wide,wide'), true);
});

test('refuses a table whose cells pass the export budget', () => {
    const rows = new Array(200)
        .fill('<tr><td colspan="200">wide</td></tr>')
        .join('');

    assert.equal(tableElementToCSV(tableFromHTML(`<table>${rows}</table>`)), null);
});

test('converts a rendered table back into a GFM pipe table', () => {
    const table = tableFromHTML(
        '<table><thead><tr><th>Model</th><th align="right">Acc.</th></tr></thead>'
        + '<tbody><tr><td>A</td><td align="right">91.2</td></tr>'
        + '<tr><td>B</td><td align="right">88.0</td></tr></tbody></table>'
    );

    assert.equal(
        tableElementToGFM(table),
        '| Model | Acc. |\n| --- | ---: |\n| A | 91.2 |\n| B | 88.0 |'
    );
});

test('promotes the first row when a rendered table has no header', () => {
    const table = tableFromHTML(
        '<table><tr><td>Name</td><td>Value</td></tr>'
        + '<tr><td>one</td><td>1</td></tr></table>'
    );

    assert.equal(
        tableElementToGFM(table),
        '| Name | Value |\n| --- | --- |\n| one | 1 |'
    );
});

test('keeps inline meaning in a converted table', () => {
    const table = tableFromHTML(
        '<table><tr><th>Cell</th><th>Note</th></tr>'
        + '<tr><td><strong>best</strong> and <em>fast</em></td>'
        + '<td>H<sub>2</sub>O</td></tr>'
        + '<tr><td><code>p&lt;0.05</code></td>'
        + '<td><a href="https://example.com/x">Paper</a></td></tr>'
        + '<tr><td><span class="katex"><math><semantics><mrow><mi>a</mi></mrow>'
        + '<annotation encoding="application/x-tex">a_i</annotation>'
        + '</semantics></math></span></td>'
        + '<td>a | b &amp; c &lt; 5</td></tr>'
        + '</table>'
    );

    assert.equal(
        tableElementToGFM(table),
        '| Cell | Note |\n'
        + '| --- | --- |\n'
        + '| **best** and *fast* | H<sub>2</sub>O |\n'
        + '| `p<0.05` | [Paper](https://example.com/x) |\n'
        + '| $a_i$ | a \\| b & c &lt; 5 |'
    );
});

test('expands merged cells and drops an unsafe link target', () => {
    const table = tableFromHTML(
        '<table><tr><th colspan="2">Merged</th></tr>'
        + '<tr><td><a href="javascript:alert(1)">unsafe</a></td>'
        + '<td><a href="#frag">fragment</a></td></tr></table>'
    );

    assert.equal(
        tableElementToGFM(table),
        '| Merged | Merged |\n| --- | --- |\n| unsafe | [fragment](#frag) |'
    );
});

test('returns no GFM for a table without rows', () => {
    assert.equal(tableElementToGFM(tableFromHTML('<table></table>')), null);
    assert.equal(tableElementToGFM(null), null);
});
