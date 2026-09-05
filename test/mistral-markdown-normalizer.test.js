import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMistralMarkdown } from '../src/mistral/markdown-normalizer.js';

test('converts numeric citations wrapped in Mistral TeX parentheses', () => {
    assert.equal(
        normalizeMistralMarkdown(
            'wristbands \\( [4,5] \\) and rings \\( [6] \\).'
        ),
        'wristbands $[4,5]$ and rings $[6]$.'
    );
});

test('converts spaced Mistral superscript markers to canonical TeX', () => {
    assert.equal(
        normalizeMistralMarkdown(
            'Alice \\( ^{1} \\), Bob \\( ^{2,*} \\).'
        ),
        'Alice $^{1}$, Bob $^{2,*}$.'
    );
});

test('does not rewrite non-numeric bracketed math', () => {
    const markdown = 'The interval is \\( [a,b] \\) and x is \\( x^2 \\).';
    assert.equal(normalizeMistralMarkdown(markdown), markdown);
});

test('does not rewrite Mistral markers inside Markdown code', () => {
    const markdown = [
        '`inline \\( [1] \\)` and prose \\( [2] \\).',
        '',
        '    indented \\( ^{3} \\)',
        '',
        '```markdown',
        'fenced \\( [4] \\)',
        '```',
    ].join('\n');
    assert.equal(
        normalizeMistralMarkdown(markdown),
        [
            '`inline \\( [1] \\)` and prose $[2]$.',
            '',
            '    indented \\( ^{3} \\)',
            '',
            '```markdown',
            'fenced \\( [4] \\)',
            '```',
        ].join('\n')
    );
});

test('associates a filename-alt image with a following academic figure caption', () => {
    assert.equal(
        normalizeMistralMarkdown([
            'Ovulation',
            '',
            '![img-0.jpeg](img-0.jpeg)',
            '',
            'Figure 1. Presentation of the fertile window.',
        ].join('\n')),
        [
            'Ovulation',
            '',
            '![Figure 1. Presentation of the fertile window.](img-0.jpeg)',
        ].join('\n')
    );
});

test('associates a filename-alt image with a preceding academic figure caption', () => {
    assert.equal(
        normalizeMistralMarkdown([
            'Figure 2. A preceding caption.',
            '',
            '![img-1.png](img-1.png)',
        ].join('\n')),
        '![Figure 2. A preceding caption.](img-1.png)'
    );
});

test('preserves filename alt text without a nearby figure caption', () => {
    const markdown = '![img-0.jpeg](img-0.jpeg)';
    assert.equal(normalizeMistralMarkdown(markdown), markdown);
});

test('does not associate remote or unsafe image destinations with captions', () => {
    for (const destination of [
        'https://example.com/img-0.jpeg',
        'https%3A%2F%2Fexample.com%2Fimg-0.jpeg',
        '/tmp/img-0.jpeg',
        '../img-0.jpeg',
    ]) {
        const markdown = [
            `![img-0.jpeg](${destination})`,
            '',
            'Figure 1. Not a local OCR asset.',
        ].join('\n');
        assert.equal(normalizeMistralMarkdown(markdown), markdown);
    }
});

test('associates a percent-encoded local image path with its caption', () => {
    assert.equal(
        normalizeMistralMarkdown([
            '![img-0.jpeg](pages%2F0%2Fimg-0.jpeg)',
            '',
            'Figure 1. A local OCR asset.',
        ].join('\n')),
        '![Figure 1. A local OCR asset.](pages%2F0%2Fimg-0.jpeg)'
    );
});

test('does not rewrite filename alt text inside a fenced code block', () => {
    const markdown = [
        '```markdown',
        '![img-0.jpeg](img-0.jpeg)',
        'Figure 1. Not a real caption.',
        '```',
    ].join('\n');
    assert.equal(normalizeMistralMarkdown(markdown), markdown);
});

test('replaces local Mistral table links with page table Markdown', () => {
    const table = '| A | B |\n| - | - |\n| 1 | 2 |';
    assert.equal(
        normalizeMistralMarkdown(
            'Table 1. Values.\n\n[tbl-0.md](tbl-0.md)',
            { tables: new Map([['tbl-0', table]]) }
        ),
        `Table 1. Values.\n\n${table}`
    );
});

test('reports missing Mistral table links without changing the source', () => {
    const markdown = '[tbl-0.md](tbl-0.md)';
    const missing = [];
    assert.equal(
        normalizeMistralMarkdown(markdown, {
            tables: new Map(),
            onMissingTable: reference => missing.push(reference),
        }),
        markdown
    );
    assert.deepEqual(missing, ['tbl-0.md']);
});

test('does not replace table-like links in code or external destinations', () => {
    const markdown = [
        '```markdown',
        '[tbl-0.md](tbl-0.md)',
        '```',
        '',
        '[tbl-0.md](https://example.com/tbl-0.md)',
        '',
        '[other.md](other.md)',
        '',
        '[download](tbl-0.md)',
        '',
        '[tbl-0.md](tbl-0.md "download")',
    ].join('\n');
    const warnings = [];
    assert.equal(
        normalizeMistralMarkdown(markdown, {
            tables: new Map([['tbl-0', '| A |\n| - |\n| 1 |']]),
            onMissingTable: reference => warnings.push(reference),
        }),
        markdown
    );
    assert.deepEqual(warnings, []);
});
