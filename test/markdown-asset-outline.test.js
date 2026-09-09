import test from 'node:test';
import assert from 'node:assert/strict';
import {
    extractMarkdownAssetOutline,
} from '../src/markdown/markdown-asset-outline.js';

test('returns an empty asset outline when Markdown has no captioned figures or tables', () => {
    assert.deepEqual(
        extractMarkdownAssetOutline('Paragraph only.\n\n![](images/logo.png)'),
        []
    );
});

test('lists captioned figures and tables in document order', () => {
    const markdown = [
        'See Figure 1.',
        '',
        '![Figure 1. PRISMA flowchart](images/flow.png)',
        '',
        '| Model | Accuracy |',
        '| --- | ---: |',
        '| LLaMA | 0.72 |',
        '',
        'Table 1. Open-source model performance',
    ].join('\n');

    assert.deepEqual(extractMarkdownAssetOutline(markdown), [
        {
            type: 'figure',
            text: 'Figure 1. PRISMA flowchart',
            offset: markdown.indexOf('![Figure 1.'),
            imageSource: 'images/flow.png',
        },
        {
            type: 'table',
            text: 'Table 1. Open-source model performance',
            offset: markdown.indexOf('| Model |'),
            tablePreviewSource: [
                '| Model | Accuracy |',
                '| --- | ---: |',
                '| LLaMA | 0.72 |',
            ].join('\n'),
        },
    ]);
});

test('omits captioned figures whose offset is inside chromeRanges', () => {
    const markdown = [
        '![Figure 1. Publisher logo](images/logo.png)',
        '',
        '![Figure 2. PRISMA flowchart](images/flow.png)',
    ].join('\n');

    assert.deepEqual(
        extractMarkdownAssetOutline(markdown, [{
            from: 0,
            to: markdown.indexOf('\n\n'),
        }]),
        [{
            type: 'figure',
            text: 'Figure 2. PRISMA flowchart',
            offset: markdown.indexOf('![Figure 2.'),
            imageSource: 'images/flow.png',
        }]
    );
});

test('clips oversized GFM tables in the asset outline preview', () => {
    const rows = Array.from({ length: 20 }, (_, index) => (
        `| r${index} | ${index} |`
    ));
    const markdown = [
        '| A | B |',
        '| --- | --- |',
        ...rows,
        '',
        'Table 1. Long table',
    ].join('\n');

    assert.deepEqual(
        extractMarkdownAssetOutline(markdown)[0].tablePreviewSource.split('\n'),
        [
            '| A | B |',
            '| --- | --- |',
            ...rows.slice(0, 6),
        ]
    );
});

test('omits remote figure destinations from the asset outline', () => {
    const markdown = '![Figure 1. Remote plot](https://example.com/plot.png)';
    assert.deepEqual(extractMarkdownAssetOutline(markdown), [{
        type: 'figure',
        text: 'Figure 1. Remote plot',
        offset: 0,
    }]);
});
