import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createMarkdownFragmentIndex,
    createMarkdownReadingPositionAnchor,
    extractMarkdownOutline,
    resolveMarkdownReadingPosition,
} from '../src/markdown/markdown-outline.js';

test('extracts visible Markdown headings and their source offsets', () => {
    const markdown = [
        '# Overview',
        '',
        '## Methods *and* [data](https://example.com)',
        '',
        '```markdown',
        '# Not a heading',
        '```',
        '',
        'Results',
        '-------',
    ].join('\n');

    assert.deepEqual(extractMarkdownOutline(markdown), [
        { level: 1, text: 'Overview', offset: markdown.indexOf('# Overview') },
        {
            level: 2,
            text: 'Methods and data',
            offset: markdown.indexOf('## Methods'),
        },
        { level: 2, text: 'Results', offset: markdown.indexOf('Results') },
    ]);
});

test('returns an empty outline when the document has no headings', () => {
    assert.deepEqual(extractMarkdownOutline('Paragraph only.'), []);
});

test('preserves visible angle-bracket text in outline labels', () => {
    const markdown = [
        '# Visit <https://example.com>',
        '',
        '## 2 < 3 and 4 > 1',
        '',
        '### <span>Wrapped</span>',
        '',
        '#### FTP <ftp://example.com/a>',
        '',
        '##### Left<br>Right',
    ].join('\n');

    assert.deepEqual(
        extractMarkdownOutline(markdown).map(heading => heading.text),
        [
            'Visit https://example.com',
            '2 < 3 and 4 > 1',
            'Wrapped',
            'FTP ftp://example.com/a',
            'Left Right',
        ]
    );
});

test('creates stable Markdown fragment targets for headings and duplicates', () => {
    const markdown = [
        '# Methods and Results',
        '',
        '## Methods and Results',
        '',
        '### 中文 标题！',
    ].join('\n');
    const index = createMarkdownFragmentIndex(markdown);

    assert.deepEqual([...index.entries()], [
        ['methods-and-results', markdown.indexOf('# Methods')],
        ['methods-and-results-1', markdown.indexOf('## Methods')],
        ['中文-标题', markdown.indexOf('### 中文')],
    ]);
});

test('uses safe, collision-free fragment fallbacks for boundary headings', () => {
    const markdown = [
        '# heading-1',
        '',
        '# !!!',
        '',
        '# <script>alert(1)</script>',
    ].join('\n');
    const index = createMarkdownFragmentIndex(markdown);

    assert.deepEqual([...index.keys()], [
        'heading-1',
        'heading-1-1',
        'alert1',
    ]);
    assert.doesNotMatch([...index.keys()].join(' '), /script|</i);
});

test('anchors restored reading position to the matching section after reparse', () => {
    const previous = [
        '# Overview',
        '',
        'Original overview.',
        '',
        '# Methods',
        '',
        'Original methods.',
    ].join('\n');
    const updated = [
        '# Overview',
        '',
        'Added overview context.',
        '',
        '# Methods',
        '',
        'Updated methods.',
    ].join('\n');
    const anchor = createMarkdownReadingPositionAnchor(
        previous,
        previous.indexOf('Original methods.')
    );

    assert.equal(
        resolveMarkdownReadingPosition(updated, anchor),
        updated.indexOf('Updated methods.')
    );
});
