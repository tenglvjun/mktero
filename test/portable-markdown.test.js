import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
    portableHTMLTableRangeText,
    portableInlineFormulas,
    portableMarkdownForRange,
    portableMathMarkdown,
} from '../src/markdown/portable-markdown.js';

function withDocument(run) {
    const dom = new JSDOM('<!doctype html><body></body>');
    try {
        return run(dom.window.document);
    }
    finally {
        dom.window.close();
    }
}

function wholeRange(markdown) {
    return { from: 0, to: markdown.length };
}

test('a formula is `$\u2026$` inline and a `$$` block on lines of its own', () => {
    assert.equal(portableMathMarkdown('x_i'), '$x_i$');
    assert.equal(portableMathMarkdown(' a\n  + b '), '$a + b$');
    assert.equal(portableMathMarkdown('E = mc^2', true), '$$\nE = mc^2\n$$');
    // A blank line would end the block in most editors.
    assert.equal(portableMathMarkdown('a\n\n  \nb', true), '$$\na\nb\n$$');
    // A TeX comment runs to the end of its line, so its breaks stay.
    assert.equal(portableMathMarkdown('a % note\n+ b'), '$a % note\n+ b$');
    assert.equal(portableMathMarkdown('  '), '');
});

test('a passage keeps its Markdown and writes each formula as the reader typesets it', () => {
    const markdown = [
        '# Results',
        '',
        'We estimate $\\hat {G} _ {t}$ with **care** and \\(a + b\\).',
        '',
        '\\[x^2\\]',
        '',
        '$$',
        '\\int_ {0} ^ {1} f',
        '$$',
    ].join('\n');

    assert.equal(portableMarkdownForRange(markdown, wholeRange(markdown)), [
        '# Results',
        '',
        'We estimate $\\hat{G} _{t}$ with **care** and $a + b$.',
        '',
        '$$',
        'x^2',
        '$$',
        '',
        '$$',
        '\\int_{0} ^{1} f',
        '$$',
    ].join('\n'));
});

test('a passage with nothing to change is returned as written', () => {
    const markdown = 'Plain **bold** text, $x$ and `$y$` code.\n';
    assert.equal(
        portableMarkdownForRange(markdown, wholeRange(markdown)),
        markdown
    );
});

test('a range that cuts a formula takes all of it', () => {
    const markdown = 'Mean $\\mu_i$ here.';
    const from = markdown.indexOf('\\mu') + 1;
    assert.equal(
        portableMarkdownForRange(markdown, { from, to: markdown.length }),
        '$\\mu_i$ here.'
    );
});

test('code, an unsafe formula, and an image description keep their text', () => {
    const markdown = [
        'Code `$a _ {b}$` and $\\def\\x{1} _ {y}$.',
        '',
        '```',
        '$c _ {d}$',
        '```',
        '',
        '![Error of $\\\\alpha _ {t}$](images/figure.png)',
    ].join('\n');

    assert.equal(portableMarkdownForRange(markdown, wholeRange(markdown)), markdown);
});

test('hidden page chrome and page labels are left out without merging paragraphs', () => {
    const markdown = [
        'First paragraph ends.',
        '<!-- zotero-page: 2 -->',
        'Journal Running Header',
        '',
        'Second paragraph runs',
        'Journal Running Header',
        'across a page break.',
        '',
        '<!-- mktero-note: footnote -->',
        '> A footnote.',
    ].join('\n');
    const headers = [...markdown.matchAll(/Journal Running Header\n/gu)]
        .map(match => ({ from: match.index, to: match.index + match[0].length }));

    assert.equal(
        portableMarkdownForRange(markdown, wholeRange(markdown), {
            chromeRanges: headers,
        }),
        [
            'First paragraph ends.',
            '',
            'Second paragraph runs',
            'across a page break.',
            '',
            '> A footnote.',
        ].join('\n')
    );
});

test('an HTML table becomes a GFM table with its formulas', () => withDocument(document => {
    const markdown = [
        'Before.',
        '',
        '<table><tr><th>Norm</th><th>Set</th></tr>'
            + '<tr><td rowspan="1">$\\|x\\| _ {2}$</td><td>$a|b$ &amp; <b>bold</b></td></tr></table>',
        'After $x$.',
    ].join('\n');

    assert.equal(
        portableMarkdownForRange(markdown, wholeRange(markdown), { document }),
        [
            'Before.',
            '',
            '| Norm | Set |',
            '| --- | --- |',
            '| $\\Vert x\\Vert _{2}$ | $a\\vert b$ & **bold** |',
            '',
            'After $x$.',
        ].join('\n')
    );
}));

test('an HTML table stays HTML without a document, and with a caption', () => withDocument(document => {
    const table = '<table><tr><td>$a$</td></tr></table>';
    assert.equal(portableMarkdownForRange(table, wholeRange(table)), table);
    const captioned = '<table><caption>Table 1</caption><tr><td>$a$</td></tr></table>';
    assert.equal(
        portableMarkdownForRange(captioned, wholeRange(captioned), { document }),
        captioned
    );
}));

test('a selection inside an HTML table reads as its cell text with formulas', () => {
    const markdown = '<table><tr><td>Norm $\\| x \\| _ {2}$</td><td>$a$ &amp; b</td></tr></table>';
    const from = markdown.indexOf('Norm');
    const to = markdown.indexOf('</td><td>$a$') + '</td><td>$a$ &amp; b'.length;

    assert.equal(
        portableHTMLTableRangeText(markdown, { from, to }),
        'Norm $\\| x \\| _{2}$ $a$ & b'
    );
    assert.equal(portableHTMLTableRangeText('Plain $x$', { from: 0, to: 9 }), null);
});

test('inline formulas in plain text are rewritten and the text around them escaped', () => {
    assert.equal(
        portableInlineFormulas('Error *of* $\\alpha _ {t}$!', {
            escapeText: value => value.replace(/\*/gu, '\\*'),
        }),
        'Error \\*of\\* $\\alpha _{t}$!'
    );
    assert.equal(portableInlineFormulas('No math.'), 'No math.');
});

test('a bad range has no portable Markdown', () => {
    assert.equal(portableMarkdownForRange('abc', { from: 2, to: 1 }), null);
    assert.equal(portableMarkdownForRange('abc', { from: 0, to: 4 }), null);
    assert.equal(portableMarkdownForRange('abc', {}), null);
});
