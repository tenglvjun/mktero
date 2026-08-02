import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarkdownSourceMap } from '../src/core/markdown-source-map.js';

test('maps unique MinerU content to Markdown blocks and keeps merged locations', () => {
    const markdown = [
        '# Results',
        '',
        'The first extracted segment contains enough words to identify it second segment continues the same paragraph.',
        '',
        '$$',
        'E = mc^2',
        '$$',
        '',
        '![Figure 1](images/figure.png)',
        '',
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 |',
        '',
        '<table><tr><td>Raw table value</td></tr></table>',
        '',
        'Repeated source sentence with enough detail.',
        '',
        'Repeated source sentence with enough detail.',
        '',
        'Intro',
    ].join('\n');
    const contentList = [
        {
            type: 'text',
            text: 'The first extracted segment contains enough words to identify it',
            pageIndex: 0,
            bbox: [100, 120, 900, 220],
        },
        {
            type: 'text',
            text: 'second segment continues the same paragraph.',
            pageIndex: 1,
            bbox: [100, 80, 900, 160],
        },
        {
            type: 'equation',
            text: '$$\nE = mc^2\n$$',
            pageIndex: 2,
            bbox: [250, 300, 750, 420],
        },
        {
            type: 'image',
            assetPath: 'images/figure.png',
            captions: ['Figure 1'],
            pageIndex: 3,
            bbox: [80, 100, 920, 700],
        },
        {
            type: 'table',
            text: '| A | B |\n| --- | --- |\n| 1 | 2 |',
            captions: [],
            pageIndex: 4,
            bbox: [120, 180, 880, 760],
        },
        {
            type: 'table',
            text: '<table><tr><td>Raw table value</td></tr></table>',
            captions: [],
            pageIndex: 5,
            bbox: [120, 180, 880, 760],
        },
        {
            type: 'text',
            text: 'Repeated source sentence with enough detail.',
            pageIndex: 6,
            bbox: [100, 100, 900, 180],
        },
        {
            type: 'text',
            text: 'Intro',
            pageIndex: 7,
            bbox: [100, 100, 300, 160],
        },
    ];

    const sourceMap = createMarkdownSourceMap(markdown, contentList);
    const mapped = sourceMap.map(entry => ({
        type: entry.type,
        markdown: markdown.slice(entry.markdownFrom, entry.markdownTo),
        locations: entry.locations,
    }));

    assert.deepEqual(mapped, [
        {
            type: 'text',
            markdown: 'The first extracted segment contains enough words to identify it second segment continues the same paragraph.',
            locations: [
                { pageIndex: 0, bbox: [100, 120, 900, 220] },
                { pageIndex: 1, bbox: [100, 80, 900, 160] },
            ],
        },
        {
            type: 'equation',
            markdown: '$$\nE = mc^2\n$$',
            locations: [{ pageIndex: 2, bbox: [250, 300, 750, 420] }],
        },
        {
            type: 'image',
            markdown: '![Figure 1](images/figure.png)',
            locations: [{ pageIndex: 3, bbox: [80, 100, 920, 700] }],
        },
        {
            type: 'table',
            markdown: '| A | B |\n| --- | --- |\n| 1 | 2 |',
            locations: [{ pageIndex: 4, bbox: [120, 180, 880, 760] }],
        },
        {
            type: 'table',
            markdown: '<table><tr><td>Raw table value</td></tr></table>',
            locations: [{ pageIndex: 5, bbox: [120, 180, 880, 760] }],
        },
    ]);
});

test('maps unique prose across PDF and Markdown notation differences', () => {
    const markdown = 'The Kaiser-Meyer result used Bartlett\'s statistic '
        + '$\\chi^2(12) = 34.5$ , explaining $46.48\\%$ of the variance.';
    const contentText = 'The KaiserMeyer result used Bartlett\u2019s statistic '
        + '\u03c72(12) = 34.5, explaining 46.48% of the variance.';

    const sourceMap = createMarkdownSourceMap(markdown, [{
        type: 'text',
        text: contentText,
        pageIndex: 5,
        bbox: [100, 120, 900, 260],
    }]);

    assert.deepEqual(sourceMap, [{
        type: 'text',
        markdownFrom: 0,
        markdownTo: markdown.length,
        locations: [{ pageIndex: 5, bbox: [100, 120, 900, 260] }],
    }]);
});

test('does not guess when tolerant source text matches multiple blocks', () => {
    const paragraphs = [
        'The Kaiser-Meyer result used Bartlett\'s statistic $\\chi^2(12)$.',
        'The KaiserMeyer result used Bartlett\'s statistic $\\chi^2(12)$.',
    ];

    assert.deepEqual(createMarkdownSourceMap(paragraphs.join('\n\n'), [{
        type: 'text',
        text: 'The KaiserMeyer result used Bartlett\u2019s statistic \u03c72(12).',
        pageIndex: 0,
        bbox: [100, 100, 900, 200],
    }]), []);
});

test('prefers an exact source match over tolerant alternatives', () => {
    const first = 'A well-being measure contains enough source text.';
    const second = 'A wellbeing measure contains enough source text.';
    const markdown = `${first}\n\n${second}`;

    assert.deepEqual(createMarkdownSourceMap(markdown, [{
        type: 'text',
        text: second,
        pageIndex: 1,
        bbox: [100, 100, 900, 200],
    }]), [{
        type: 'text',
        markdownFrom: first.length + 2,
        markdownTo: markdown.length,
        locations: [{ pageIndex: 1, bbox: [100, 100, 900, 200] }],
    }]);
});

test('does not discard numeric minus signs during tolerant matching', () => {
    const markdown = 'The reported interval was 10\u221220 points in this sample.';

    assert.deepEqual(createMarkdownSourceMap(markdown, [{
        type: 'text',
        text: 'The reported interval was 1020 points in this sample.',
        pageIndex: 0,
        bbox: [100, 100, 900, 200],
    }]), []);
});

test('handles long punctuation whitespace within the tolerant work budget', () => {
    const whitespace = ' '.repeat(4 * 1024);
    const markdown = `A uniquely mapped result${whitespace}, with enough text.`;

    assert.equal(createMarkdownSourceMap(markdown, [{
        type: 'text',
        text: 'A uniquely mapped result, with enough text.',
        pageIndex: 0,
        bbox: [100, 100, 900, 200],
    }], {
        maxMatchWork: markdown.length * 2,
    }).length, 1);
});

test('handles dense LaTeX tolerance within the matching budget', () => {
    const terms = 16 * 1024;
    const markdown = `A unique sequence starts ${'\\chi '.repeat(terms)}and ends here.`;
    const contentText = `A unique sequence starts ${'\u03c7 '.repeat(terms)}and ends here.`;

    assert.equal(createMarkdownSourceMap(markdown, [{
        type: 'text',
        text: contentText,
        pageIndex: 0,
        bbox: [100, 100, 900, 200],
    }], {
        maxMatchWork: markdown.length * 2,
    }).length, 1);
});

test('skips source-map indexing when no block can spend matching work', () => {
    const markdown = '\\chi'.repeat(64 * 1024);
    const contentBlock = {
        type: 'text',
        text: 'A source block that cannot spend matching work.',
        pageIndex: 0,
        bbox: [100, 100, 900, 200],
    };

    assert.deepEqual(createMarkdownSourceMap(markdown, []), []);
    assert.deepEqual(createMarkdownSourceMap(markdown, [contentBlock], {
        maxContentBlocks: 0,
    }), []);
    assert.deepEqual(createMarkdownSourceMap(markdown, [contentBlock], {
        maxMatchWork: 0,
    }), []);
});

test('returns no mappings for malformed inputs', () => {
    assert.deepEqual(createMarkdownSourceMap(null, []), []);
    assert.deepEqual(createMarkdownSourceMap('# Paper', null), []);
    assert.deepEqual(createMarkdownSourceMap('Long enough mapped text.', [{
        type: 'text',
        text: 'Long enough mapped text.',
        pageIndex: 0,
        bbox: [100, 100, 1001, 200],
    }]), []);
});

test('does not map typed MinerU blocks to incompatible Markdown syntax', () => {
    const markdown = [
        'The prose mentions E = mc^2 + 1 without displaying an equation.',
        '',
        'The prose also mentions images/figure.png as a file path.',
        '',
        'A | B | 1 | 2 appears as ordinary prose.',
        '',
        '```text',
        '$$',
        'x = fenced + math',
        '$$',
        '```',
        '',
        '<div>ordinary HTML block content</div>',
    ].join('\n');

    assert.deepEqual(createMarkdownSourceMap(markdown, [{
        type: 'equation',
        text: 'E = mc^2 + 1',
        pageIndex: 0,
        bbox: [100, 100, 900, 200],
    }, {
        type: 'image',
        assetPath: 'images/figure.png',
        pageIndex: 0,
        bbox: [100, 220, 900, 600],
    }, {
        type: 'table',
        text: 'A | B | 1 | 2',
        pageIndex: 0,
        bbox: [100, 620, 900, 800],
    }, {
        type: 'equation',
        text: '$$\nx = fenced + math\n$$',
        pageIndex: 1,
        bbox: [100, 100, 900, 200],
    }, {
        type: 'table',
        text: '<div>ordinary HTML block content</div>',
        pageIndex: 1,
        bbox: [100, 220, 900, 400],
    }]), []);
});

test('bounds source-map memory and matching work independently of extraction', () => {
    const first = 'First source paragraph contains enough unique mapped text.';
    const second = 'Second source paragraph contains enough unique mapped text.';
    const markdown = `${first}\n\n${second}`;
    const contentList = [first, second].map((text, index) => ({
        type: 'text',
        text,
        pageIndex: index,
        bbox: [100, 100, 900, 200],
    }));

    assert.deepEqual(createMarkdownSourceMap(markdown, contentList, {
        maxMarkdownLength: markdown.length - 1,
    }), []);
    assert.equal(createMarkdownSourceMap(markdown, contentList, {
        maxContentBlocks: 1,
    }).length, 1);
    assert.equal(createMarkdownSourceMap(markdown, contentList, {
        maxMatchWork: markdown.length,
    }).length, 1);

    const tolerantMarkdown = 'A Kaiser-Meyer result used $\\chi^2(12)$ '
        + 'and explained $46.48\\%$ of the variance.';
    const tolerantContent = [{
        type: 'text',
        text: 'A KaiserMeyer result used \u03c72(12) '
            + 'and explained 46.48% of the variance.',
        pageIndex: 0,
        bbox: [100, 100, 900, 200],
    }];
    assert.equal(createMarkdownSourceMap(tolerantMarkdown, tolerantContent, {
        maxMatchWork: tolerantMarkdown.length,
    }).length, 0);
    assert.equal(createMarkdownSourceMap(tolerantMarkdown, tolerantContent, {
        maxMatchWork: tolerantMarkdown.length * 2,
    }).length, 1);
});
