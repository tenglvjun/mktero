import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createVisibleMarkdownTextIndex,
} from '../src/markdown/markdown-visible-text.js';

test('indexes rendered inline math without its delimiters', () => {
    const markdown = 'Before $n = 22$ after.';
    const index = createVisibleMarkdownTextIndex(markdown);

    assert.equal(index.text, 'Before n = 22 after.');
    assert.deepEqual(index.sourceRange(7, 6), { from: 8, to: 14 });
});

test('keeps dollar signs visible inside inline code', () => {
    const index = createVisibleMarkdownTextIndex('`price $5$` and $x$');

    assert.equal(index.text, 'price $5$ and x');
});

test('unescapes Markdown punctuation only where it renders as punctuation', () => {
    const math = '0.30\\;^{\\circ}C';
    const markdown = `\`HALF\\_LOCS\` and $${math}$ and HALF\\_LOCS`;
    const index = createVisibleMarkdownTextIndex(markdown);
    const mathFrom = index.text.indexOf(math);
    const visibleFrom = index.text.lastIndexOf('HALF_LOCS');
    const mathRange = index.sourceRange(mathFrom, math.length);
    const range = index.sourceRange(visibleFrom, 'HALF_LOCS'.length);

    assert.equal(index.text, `HALF\\_LOCS and ${math} and HALF_LOCS`);
    assert.equal(markdown.slice(mathRange.from, mathRange.to), math);
    assert.equal(markdown.slice(range.from, range.to), 'HALF\\_LOCS');
});

test('handles repeated escapes and a malformed trailing backslash', () => {
    const mathEscapeCount = 4_000;
    const escapeCount = 10_000;
    const math = '\\;'.repeat(mathEscapeCount);
    const markdown = `$${math}$\n${'\\_'.repeat(escapeCount)}\\`;
    const index = createVisibleMarkdownTextIndex(markdown);

    assert.equal(index.text, `${math}\n${'_'.repeat(escapeCount)}\\`);
    assert.deepEqual(index.sourceRange(0, 2), { from: 1, to: 3 });
    assert.deepEqual(
        index.sourceRange(index.text.length - 1, 1),
        { from: markdown.length - 1, to: markdown.length }
    );
});

test('preserves MinerU superscript math for PDF annotation matching', () => {
    const markdown = 'Sentence. $^{11}$ BOSE $^{®}$ headphones';
    const index = createVisibleMarkdownTextIndex(markdown);

    assert.equal(index.text, markdown);
});

test('extracts visible text from a Markdown source range', () => {
    const first = 'First *emphasis*, $x$ and [link](https://example.com).';
    const markdown = `${first}\n\nSecond paragraph.`;
    const index = createVisibleMarkdownTextIndex(markdown);

    assert.equal(
        index.textForSourceRange(0, first.length),
        'First emphasis, x and link.'
    );
    assert.equal(
        index.textForSourceRange(markdown.indexOf('$'), markdown.indexOf('$') + 3),
        'x'
    );
});

test('rejects invalid visible-text source ranges', () => {
    const markdown = '[label](https://example.com)';
    const index = createVisibleMarkdownTextIndex(markdown);
    const urlFrom = markdown.indexOf('https://');

    assert.equal(index.textForSourceRange(urlFrom, markdown.length - 1), '');
    assert.equal(index.textForSourceRange(-1, 1), '');
    assert.equal(index.textForSourceRange(1, 1), '');
    assert.equal(index.textForSourceRange(0, markdown.length + 1), '');
});
