import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMarkdownCitations } from '../src/markdown/markdown-citations.js';
import { renderMarkdownHTML } from '../src/markdown/markdown-html.js';
import { findAcademicFigures } from '../src/markdown/markdown-figures.js';
import { analyzeMarkdownFigureReferences } from '../src/markdown/markdown-figure-references.js';
import { normalizeMistralResult } from '../src/mistral/mistral-result.js';

function page(overrides = {}) {
    return {
        index: 0,
        markdown: 'A sufficiently long paragraph for mapping.',
        dimensions: { width: 1000, height: 1000 },
        ...overrides,
    };
}

test('orders pages, joins Markdown, decodes images, and normalizes block bboxes', () => {
    const result = normalizeMistralResult({
        pages: [
            page({
                index: 1,
                markdown: 'Second page with enough text for mapping.',
                dimensions: { width: 1000, height: 2000 },
                blocks: [{
                    type: 'text',
                    content: 'Second page with enough text for mapping.',
                    bbox: [100, 200, 900, 400],
                }],
            }),
            page({
                markdown: '# First page\n\n![Figure](img-0.png)',
                images: [{
                    id: 'img-0.png',
                    image_base64: 'data:image/png;base64,AQID',
                }],
                blocks: [{
                    type: 'image',
                    content: 'img-0.png',
                    bbox: [10, 20, 300, 400],
                }],
            }),
        ],
        usage_info: { pages_processed: 4 },
    });

    assert.equal(
        result.markdown,
        '# First page\n\n![Figure](img-0.png)\n\n'
            + 'Second page with enough text for mapping.'
    );
    assert.equal(result.extractedPages, 2);
    assert.equal(result.totalPages, 4);
    assert.deepEqual(result.assets.map(asset => ({
        path: asset.path,
        mimeType: asset.mimeType,
        data: [...asset.data],
    })), [{ path: 'img-0.png', mimeType: 'image/png', data: [1, 2, 3] }]);
    assert.deepEqual(result.contentList, [
        {
            type: 'image',
            pageIndex: 0,
            bbox: [10, 20, 300, 400],
            assetPath: 'img-0.png',
        },
        {
            type: 'text',
            pageIndex: 1,
            bbox: [100, 100, 900, 200],
            text: 'Second page with enough text for mapping.',
        },
    ]);
    assert.equal(result.sourceMap.length, 2);
    assert.deepEqual(result.sourceMap.map(entry => entry.type), ['image', 'text']);
});

test('normalizes official Mistral top-level block coordinates and types', () => {
    const result = normalizeMistralResult({
        pages: [page({
            markdown: '# Title\n\nBody text.\n\n[1] Reference',
            dimensions: { dpi: 200, width: 1000, height: 2000 },
            blocks: [
                {
                    type: 'title',
                    top_left_x: 100,
                    top_left_y: 100,
                    bottom_right_x: 900,
                    bottom_right_y: 220,
                    content: 'Title',
                },
                {
                    type: 'text',
                    top_left_x: 100,
                    top_left_y: 300,
                    bottom_right_x: 900,
                    bottom_right_y: 500,
                    content: 'Body text.',
                },
                {
                    type: 'references',
                    top_left_x: 100,
                    top_left_y: 600,
                    bottom_right_x: 900,
                    bottom_right_y: 900,
                    content: '[1] Reference',
                },
                {
                    type: 'aside_text',
                    top_left_x: 100,
                    top_left_y: 950,
                    bottom_right_x: 900,
                    bottom_right_y: 1_100,
                    content: 'Sidebar note',
                },
                {
                    type: 'signature',
                    top_left_x: 100,
                    top_left_y: 1_150,
                    bottom_right_x: 900,
                    bottom_right_y: 1_300,
                    content: '',
                },
            ],
        })],
    });

    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.contentList.map(block => ({
        type: block.type,
        bbox: block.bbox,
        text: block.text,
    })), [
        { type: 'heading', bbox: [100, 50, 900, 110], text: 'Title' },
        { type: 'text', bbox: [100, 150, 900, 250], text: 'Body text.' },
        { type: 'reference', bbox: [100, 300, 900, 450], text: '[1] Reference' },
        { type: 'text', bbox: [100, 475, 900, 550], text: 'Sidebar note' },
        { type: 'text', bbox: [100, 575, 900, 650], text: undefined },
    ]);
});

test('uses the official image_id when image content is descriptive text', () => {
    const result = normalizeMistralResult({
        pages: [page({
            markdown: '![Figure](img-0.png)',
            images: [{
                id: 'img-0.png',
                image_base64: 'data:image/png;base64,AQID',
            }],
            blocks: [{
                type: 'image',
                top_left_x: 100,
                top_left_y: 100,
                bottom_right_x: 900,
                bottom_right_y: 900,
                content: 'Figure 1',
                image_id: 'img-0.png',
            }],
        })],
    });

    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.contentList, [{
        type: 'image',
        pageIndex: 0,
        bbox: [100, 100, 900, 900],
        assetPath: 'img-0.png',
    }]);
});

test('accepts camelCase coordinates from an SDK-normalized Mistral block', () => {
    const result = normalizeMistralResult({
        pages: [page({
            markdown: 'A sufficiently long paragraph for mapping.',
            blocks: [{
                type: 'text',
                topLeftX: 100,
                topLeftY: 200,
                bottomRightX: 900,
                bottomRightY: 400,
                content: 'A sufficiently long paragraph for mapping.',
            }],
        })],
    });

    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.contentList[0].bbox, [100, 200, 900, 400]);
});

test('normalizes Mistral TeX-wrapped citations before building the source map', () => {
    const result = normalizeMistralResult({
        pages: [page({
            markdown: [
                '# Paper',
                '',
                'Evidence \\( [1,2] \\) and author \\( ^{1} \\).',
                '',
                '## References',
                '',
                '[1] Alpha A. First paper. 2020.',
                '[2] Beta B. Second paper. 2021.',
            ].join('\n'),
            blocks: [{
                type: 'text',
                content: 'Evidence \\( [1,2] \\) and author \\( ^{1} \\).',
                bbox: [0, 0, 900, 900],
            }],
        })],
    });

    assert.match(result.markdown, /Evidence \$\[1,2\]\$ and author \$\^\{1\}\$\./);
    assert.equal(result.contentList[0].text, result.markdown.split('\n')[2]);
    const citations = analyzeMarkdownCitations(result.markdown).citations;
    assert.deepEqual(
        citations.slice(0, 2).map(citation => ({
            label: result.markdown.slice(citation.from, citation.to),
            referenceIds: citation.referenceIds,
        })),
        [
            { label: '1', referenceIds: ['number:1'] },
            { label: '2', referenceIds: ['number:2'] },
        ]
    );
});

test('rewrites data and remote image destinations to local or empty paths', () => {
    const result = normalizeMistralResult({
        pages: [page({
            markdown: [
                '![one](https://example.com/figure.png)',
                '![two](data:image/png;base64,AQID)',
                '![three](img%2Ftwo.png)',
            ].join('\n\n'),
            images: [{
                id: 'img/two.png',
                image_base64: 'data:image/png;base64,AQID',
            }],
        })],
    });
    assert.equal(result.markdown, [
        '![one]()',
        '![two](img/two.png)',
        '![three](img/two.png)',
    ].join('\n\n'));

    const withoutAssets = normalizeMistralResult({
        pages: [page({ markdown: '![remote](https://example.com/figure.png)' })],
    });
    assert.equal(withoutAssets.markdown, '![remote]()');
});

test('normalizes Mistral filename-alt figures before figure analysis', () => {
    const result = normalizeMistralResult({
        pages: [page({
            markdown: [
                'Ovulation',
                '',
                '![img-0.jpeg](img-0.jpeg)',
                '',
                'Figure 1. Presentation of the fertile window.',
            ].join('\n'),
            images: [{
                id: 'img-0.jpeg',
                image_base64: 'data:image/jpeg;base64,AQID',
            }],
        })],
    });

    assert.equal(
        result.markdown,
        [
            'Ovulation',
            '',
            '![Figure 1. Presentation of the fertile window.](img-0.jpeg)',
        ].join('\n')
    );
    assert.deepEqual(
        findAcademicFigures(result.markdown).map(figure => figure.caption.text),
        ['Figure 1. Presentation of the fertile window.']
    );
    const references = analyzeMarkdownFigureReferences([
        result.markdown,
        '',
        'The fertile window is shown in Figure 1.',
    ].join('\n'));
    assert.deepEqual(
        references.targets.map(target => target.label),
        ['Figure 1.']
    );
    assert.equal(
        renderMarkdownHTML(result.markdown, {
            resolveImageURL: path => `blob:mktero-${path}`,
        }).includes('<figure class="mktero-figure">'),
        true
    );
});

test('removes OCR text that is contained inside a Mistral image bbox', () => {
    const result = normalizeMistralResult({
        pages: [page({
            markdown: [
                'Ovulation',
                '',
                'LH surge',
                '',
                'Body text outside the figure.',
                '',
                '![img-0.png](img-0.png)',
            ].join('\n'),
            images: [{
                id: 'img-0.png',
                image_base64: 'data:image/png;base64,AQID',
            }],
            blocks: [
                {
                    type: 'image',
                    image_id: 'img-0.png',
                    bbox: [100, 100, 900, 500],
                },
                {
                    type: 'text',
                    content: 'Ovulation',
                    bbox: [180, 180, 420, 240],
                },
                {
                    type: 'text',
                    content: 'LH surge',
                    bbox: [180, 260, 420, 320],
                },
                {
                    type: 'text',
                    content: 'Body text outside the figure.',
                    bbox: [100, 600, 900, 700],
                },
            ],
        })],
    });

    assert.equal(
        result.markdown,
        'Body text outside the figure.\n\n![img-0.png](img-0.png)'
    );
    assert.deepEqual(result.contentList.map(block => block.type), [
        'image',
        'text',
    ]);
    assert.equal(
        result.sourceMap.some(entry => entry.markdownFrom >= 0
            && result.markdown.slice(entry.markdownFrom, entry.markdownTo)
                .includes('Ovulation')),
        false
    );
});

test('removes Mistral publisher mastheads and repeated page chrome', () => {
    const result = normalizeMistralResult({
        pages: [
            page({
                index: 0,
                markdown: [
                    '#',
                    '',
                    'sensors',
                    '',
                    'MDPI',
                    '',
                    'Article',
                    '',
                    '# Paper title',
                    '',
                    'Opening body paragraph.',
                    '',
                    'Sensors 2023, 23, 9730. https://doi.org/10.3390/s23249730',
                    '',
                    'https://www.mdpi.com/journal/sensors',
                ].join('\n'),
                blocks: [
                    {
                        type: 'heading',
                        content: 'Paper title',
                        bbox: [100, 100, 900, 180],
                    },
                    {
                        type: 'text',
                        content: 'Opening body paragraph.',
                        bbox: [100, 250, 900, 350],
                    },
                    {
                        type: 'footer',
                        content: 'Sensors 2023, 23, 9730. https://doi.org/10.3390/s23249730',
                        bbox: [100, 900, 900, 980],
                    },
                    {
                        type: 'footer',
                        content: 'https://www.mdpi.com/journal/sensors',
                        bbox: [100, 900, 900, 980],
                    },
                ],
            }),
            page({
                index: 1,
                markdown: [
                    'Sensors 2023, 23, 9730',
                    '',
                    '2 of 3',
                    '',
                    'Page two body.',
                    '',
                    'Sensors 2023, 23, 9730',
                    '',
                    'This is ordinary body text.',
                    '',
                    'More body text.',
                    '',
                    'Another body line.',
                    '',
                    'Yet another body line.',
                    '',
                    'RandomForestClassifier',
                ].join('\n'),
                blocks: [
                    {
                        type: 'text',
                        content: 'Page two body.',
                        bbox: [100, 300, 900, 400],
                    },
                    {
                        type: 'text',
                        content: 'RandomForestClassifier',
                        bbox: [100, 700, 900, 760],
                    },
                ],
            }),
            page({
                index: 2,
                markdown: [
                    'Sensors 2023, 23, 9730',
                    '',
                    '3 of 3',
                    '',
                    'Page three body.',
                ].join('\n'),
                blocks: [{
                    type: 'text',
                    content: 'Page three body.',
                    bbox: [100, 300, 900, 400],
                }],
            }),
        ],
    });

    assert.equal(
        result.markdown,
        '# Paper title\n\nOpening body paragraph.\n\n'
            + 'Page two body.\n\nSensors 2023, 23, 9730\n\n'
            + 'This is ordinary body text.\n\nMore body text.\n\n'
            + 'Another body line.\n\nYet another body line.\n\n'
            + 'RandomForestClassifier\n\nPage three body.'
    );
    assert.deepEqual(result.contentList.map(block => block.type), [
        'heading',
        'text',
        'text',
        'text',
        'text',
    ]);
    assert.equal(result.sourceMap.some(entry => entry.type === 'footer'), false);
    assert.equal(result.sourceMap.some(entry => (
        result.markdown.slice(entry.markdownFrom, entry.markdownTo)
            .includes('RandomForestClassifier')
    )), true);
});

test('removes publisher footer links when Mistral omits footer blocks', () => {
    const result = normalizeMistralResult({
        pages: [
            page({
                index: 0,
                markdown: [
                    '# Paper title',
                    '',
                    'Body paragraph.',
                    '',
                    'Sensors 2023, 23, 9730. https://doi.org/10.3390/s23249730',
                    '',
                    'https://www.mdpi.com/journal/sensors',
                ].join('\n'),
            }),
            page({
                index: 1,
                markdown: [
                    'Sensors 2023, 23, 9730',
                    '',
                    '2 of 2',
                    '',
                    'Second page body.',
                ].join('\n'),
            }),
        ],
    });

    assert.equal(
        result.markdown,
        '# Paper title\n\nBody paragraph.\n\nSecond page body.'
    );
});

test('joins a paragraph that continues from the bottom of one column', () => {
    const firstBlock = 'MT has emerged as a promising approach. '
        + 'Studies showed improvements in stress coping, reduction in anxiety '
        + 'symptoms, and enhancement of overall well-being (Fancourt et al. 2014; Witte';
    const secondBlock = 'et al. 2022). The positive effects of music on stress '
        + 'recovery have also been studied and published.';
    const result = normalizeMistralResult({
        pages: [page({
            markdown: `${firstBlock}\n\n${secondBlock}`,
            blocks: [
                {
                    type: 'text',
                    content: firstBlock,
                    bbox: [72, 844, 488, 932],
                },
                {
                    type: 'text',
                    content: secondBlock,
                    bbox: [509, 38, 927, 215],
                },
            ],
        })],
    });

    assert.equal(result.markdown, `${firstBlock} ${secondBlock}`);
    const textEntries = result.sourceMap.filter(entry => entry.type === 'text');
    assert.equal(textEntries.length, 1);
    assert.equal(textEntries[0].locations.length, 2);
});

test('keeps separate column paragraphs separated when the first one ends', () => {
    const firstBlock = 'The first column paragraph ends here.';
    const secondBlock = 'The next column paragraph starts here.';
    const result = normalizeMistralResult({
        pages: [page({
            markdown: `${firstBlock}\n\n${secondBlock}`,
            blocks: [
                {
                    type: 'text',
                    content: firstBlock,
                    bbox: [72, 844, 488, 932],
                },
                {
                    type: 'text',
                    content: secondBlock,
                    bbox: [509, 38, 927, 215],
                },
            ],
        })],
    });

    assert.equal(result.markdown, `${firstBlock}\n\n${secondBlock}`);
});

test('joins a paragraph across a page footer into the next page', () => {
    const firstBlock = '... biosensor* [tiab]) AND';
    const secondBlock = '(wear* [tiab] OR worn [tiab])) AND ("menstruation" [MeSH Terms].';
    const result = normalizeMistralResult({
        pages: [
            page({
                index: 1,
                markdown: [
                    firstBlock,
                    '',
                    'https://www.jmir.org/2024/1/e45139',
                    '',
                    'J Med Internet Res 2024 | vol. 26 | e45139 | p. 2',
                ].join('\n'),
                blocks: [
                    {
                        type: 'text',
                        content: firstBlock,
                        bbox: [502, 806, 930, 922],
                    },
                ],
            }),
            page({
                index: 2,
                markdown: secondBlock,
                blocks: [{
                    type: 'text',
                    content: secondBlock,
                    bbox: [68, 84, 492, 198],
                }],
            }),
        ],
    });

    assert.equal(result.markdown, `${firstBlock} ${secondBlock}`);
    assert.equal(result.markdown.includes('jmir.org'), false);
    const textEntries = result.sourceMap.filter(entry => entry.type === 'text');
    assert.equal(textEntries.length, 1);
    assert.equal(textEntries[0].locations.length, 2);
});

test('keeps separate paragraphs across a page boundary when the first ends', () => {
    const firstBlock = 'The first page paragraph ends here.';
    const secondBlock = 'The next page paragraph starts here.';
    const result = normalizeMistralResult({
        pages: [
            page({
                index: 1,
                markdown: firstBlock,
                blocks: [{
                    type: 'text',
                    content: firstBlock,
                    bbox: [502, 806, 930, 922],
                }],
            }),
            page({
                index: 2,
                markdown: secondBlock,
                blocks: [{
                    type: 'text',
                    content: secondBlock,
                    bbox: [68, 84, 492, 198],
                }],
            }),
        ],
    });

    assert.equal(result.markdown, `${firstBlock}\n\n${secondBlock}`);
});

test('keeps Mistral prose when image or text bboxes are unavailable', () => {
    const result = normalizeMistralResult({
        pages: [page({
            markdown: [
                'Ovulation',
                '',
                '![img-0.png](img-0.png)',
            ].join('\n'),
            images: [{
                id: 'img-0.png',
                image_base64: 'data:image/png;base64,AQID',
            }],
            blocks: [{
                type: 'text',
                content: 'Ovulation',
            }],
        })],
    });

    assert.match(result.markdown, /^Ovulation\n\n/u);
});

test('restores a Mistral figure grid from image block coordinates', () => {
    const imageCount = 7;
    const images = Array.from({ length: imageCount }, (_, index) => ({
        id: `img-${index}.png`,
        image_base64: 'data:image/png;base64,AQID',
    }));
    const boxes = [
        [50, 100, 300, 300],
        [350, 100, 600, 300],
        [650, 100, 900, 300],
        [50, 350, 300, 550],
        [350, 350, 600, 550],
        [650, 350, 900, 550],
        [50, 600, 300, 800],
    ];
    const result = normalizeMistralResult({
        pages: [page({
            markdown: [
                ...images.map(image => `![${image.id}](${image.id})`),
                '',
                'Figure 4. Seven menstrual cycles.',
            ].join('\n\n'),
            images,
            blocks: boxes.map((bbox, index) => ({
                type: 'image',
                image_id: `img-${index}.png`,
                bbox,
            })),
        })],
    });

    assert.match(
        result.markdown,
        /<!-- mktero-figure-layout: columns=3 rows=3,3,1 -->/u
    );
    const groups = findAcademicFigures(result.markdown);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].layout, 'grid');
    assert.equal(groups[0].gridColumns, 3);
    assert.deepEqual(groups[0].gridRows, [3, 3, 1]);
    assert.deepEqual(
        result.sourceMap
            .filter(entry => entry.type === 'image')
            .map(entry => result.markdown.slice(entry.markdownFrom, entry.markdownTo))
            .map(source => source.match(/\((img-[0-9]+\.png)\)/u)?.[1]),
        ['img-0.png', 'img-1.png', 'img-2.png', 'img-3.png', 'img-4.png', 'img-5.png', 'img-6.png']
    );
    const html = renderMarkdownHTML(result.markdown, {
        resolveImageURL: path => `blob:mktero-${path}`,
    });
    assert.match(html, /mktero-figure-group-grid/u);
    assert.match(html, /mktero-figure-panels-grid/u);
    assert.match(html, /--mktero-figure-grid-columns:3/u);
});

test('uses official Mistral image metadata coordinates for figure grids', () => {
    const boxes = [
        [50, 100, 300, 300],
        [350, 100, 600, 300],
        [650, 100, 900, 300],
        [50, 350, 300, 550],
        [350, 350, 600, 550],
        [650, 350, 900, 550],
        [50, 600, 300, 800],
    ];
    const images = boxes.map((bbox, index) => ({
        id: `img-${index}.png`,
        image_base64: 'data:image/png;base64,AQID',
        top_left_x: bbox[0],
        top_left_y: bbox[1],
        bottom_right_x: bbox[2],
        bottom_right_y: bbox[3],
    }));
    const result = normalizeMistralResult({
        pages: [page({
            markdown: [
                ...images.map(image => `![${image.id}](${image.id})`),
                '',
                'Figure 4. Seven menstrual cycles.',
            ].join('\n\n'),
            images,
        })],
    });

    assert.match(
        result.markdown,
        /<!-- mktero-figure-layout: columns=3 rows=3,3,1 -->/u
    );
    assert.equal(
        result.contentList.filter(block => block.type === 'image').length,
        7
    );
});

test('restores every multi-image figure shape, including a horizontal pair', () => {
    const images = [0, 1].map(index => ({
        id: `img-${index}.png`,
        image_base64: 'data:image/png;base64,AQID',
        bbox: [50 + index * 450, 100, 400 + index * 450, 450],
    }));
    const result = normalizeMistralResult({
        pages: [page({
            markdown: [
                ...images.map(image => `![${image.id}](${image.id})`),
                '',
                'Figure 1. Two panels.',
            ].join('\n\n'),
            images,
        })],
    });

    assert.match(
        result.markdown,
        /<!-- mktero-figure-layout: columns=2 rows=2 -->/u
    );
    const groups = findAcademicFigures(result.markdown);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].layout, 'horizontal');
    assert.equal(groups[0].gridColumns, 2);
});

test('restores a full-width main panel above a multi-column panel grid', () => {
    const boxes = [
        [80, 80, 920, 360],
        [80, 410, 480, 650],
        [520, 410, 920, 650],
        [80, 700, 480, 940],
        [520, 700, 920, 940],
    ];
    const images = boxes.map((bbox, index) => ({
        id: `img-${index}.png`,
        image_base64: 'data:image/png;base64,AQID',
        bbox,
    }));
    const result = normalizeMistralResult({
        pages: [page({
            markdown: [
                ...images.map(image => `![${image.id}](${image.id})`),
                '',
                'Figure 2. A composite figure.',
            ].join('\n\n'),
            images,
        })],
    });

    assert.match(
        result.markdown,
        /<!-- mktero-figure-layout: columns=2 rows=1,2,2 spans=2,1,1,1,1 -->/u
    );
    const groups = findAcademicFigures(result.markdown);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].layout, 'grid');
    assert.deepEqual(groups[0].gridRows, [1, 2, 2]);
    assert.deepEqual(groups[0].gridSpans, [2, 1, 1, 1, 1]);

    const html = renderMarkdownHTML(result.markdown, {
        resolveImageURL: path => `blob:mktero-${path}`,
    });
    assert.match(html, /grid-column:1 \/ -1/u);
});

test('uses a conservative grid fallback when Mistral omits image bboxes', () => {
    const images = Array.from({ length: 9 }, (_, index) => ({
        id: `img-${index}.png`,
        image_base64: 'data:image/png;base64,AQID',
    }));
    const result = normalizeMistralResult({
        pages: [page({
            markdown: [
                ...images.map(image => `![${image.id}](${image.id})`),
                '',
                'Figure 3. Nine repeated panels.',
            ].join('\n\n'),
            images,
        })],
    });

    assert.match(
        result.markdown,
        /<!-- mktero-figure-layout: columns=3 rows=3,3,3 -->/u
    );
    const groups = findAcademicFigures(result.markdown);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].layout, 'grid');
    assert.deepEqual(groups[0].gridRows, [3, 3, 3]);
});

test('groups a vertically stacked figure without forcing its panels wider', () => {
    const images = [0, 1, 2].map(index => ({
        id: `img-${index}.png`,
        image_base64: 'data:image/png;base64,AQID',
        bbox: [300, 100 + index * 300, 700, 320 + index * 300],
    }));
    const result = normalizeMistralResult({
        pages: [page({
            markdown: [
                ...images.map(image => `![${image.id}](${image.id})`),
                '',
                'Figure 4. Three vertically stacked panels.',
            ].join('\n\n'),
            images,
        })],
    });

    assert.match(
        result.markdown,
        /<!-- mktero-figure-layout: columns=1 rows=1,1,1 -->/u
    );
    const groups = findAcademicFigures(result.markdown);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].layout, 'vertical');
    const html = renderMarkdownHTML(result.markdown, {
        resolveImageURL: path => `blob:mktero-${path}`,
    });
    assert.match(html, /mktero-figure-group-vertical/u);
    assert.doesNotMatch(html, /mktero-figure-panels-grid/u);
});

test('does not merge an already captioned image with the following figure', () => {
    const images = Array.from({ length: 10 }, (_, index) => ({
        id: `img-${index}.jpeg`,
        image_base64: 'data:image/jpeg;base64,AQID',
    }));
    const result = normalizeMistralResult({
        pages: [page({
            markdown: [
                `![Figure 2. Histogram.](${images[0].id})`,
                '',
                ...images.slice(1).map(image => `![](${image.id})`),
                '',
                'Figure 3. Nine cycle panels.',
            ].join('\n\n'),
            images,
        })],
    });

    assert.match(
        result.markdown,
        /Figure 2\. Histogram\./u
    );
    assert.match(
        result.markdown,
        /<!-- mktero-figure-layout: columns=3 rows=3,3,3 -->/u
    );
    const groups = findAcademicFigures(result.markdown);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].caption.label, 'Figure 2.');
    assert.equal(groups[1].caption.label, 'Figure 3.');
});

test('keeps leading and trailing captions on adjacent figures separate', () => {
    const result = normalizeMistralResult({
        pages: [page({
            markdown: 'Figure 2. First result.\n\n'
                + '![img-0.png](img-0.png)\n\n'
                + '![img-1.png](img-1.png)\n\n'
                + 'Figure 3. Second result.',
            images: [{
                id: 'img-0.png',
                image_base64: 'data:image/png;base64,AQID',
            }, {
                id: 'img-1.png',
                image_base64: 'data:image/png;base64,AQID',
            }],
        })],
    });

    const figures = findAcademicFigures(result.markdown);
    assert.equal(figures.length, 2);
    assert.deepEqual(
        figures.map(figure => ({
            caption: figure.caption.label,
            images: figure.images.length,
        })),
        [{ caption: 'Figure 2.', images: 1 }, { caption: 'Figure 3.', images: 1 }]
    );
    assert.doesNotMatch(result.markdown, /mktero-figure-layout/u);
});

test('keeps a preceding caption attached to the complete Mistral image group', () => {
    const images = [0, 1, 2].map(index => ({
        id: `img-${index}.png`,
        image_base64: 'data:image/png;base64,AQID',
    }));
    const result = normalizeMistralResult({
        pages: [page({
            markdown: [
                'Figure 5. A caption before the panels.',
                '',
                ...images.map(image => `![${image.id}](${image.id})`),
            ].join('\n\n'),
            images,
        })],
    });

    assert.match(
        result.markdown,
        /<!-- mktero-figure-layout: columns=3 rows=3 -->\nFigure 5\./u
    );
    const groups = findAcademicFigures(result.markdown);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].caption.label, 'Figure 5.');
    assert.equal(groups[0].layout, 'horizontal');
});

test('orders panels by their page coordinates when OCR emits column-major order', () => {
    const boxesBySourceOrder = [
        [50, 100, 300, 300],
        [50, 350, 300, 550],
        [50, 600, 300, 800],
        [350, 100, 600, 300],
        [350, 350, 600, 550],
        [350, 600, 600, 800],
    ];
    const images = boxesBySourceOrder.map((bbox, index) => ({
        id: `img-${index}.png`,
        image_base64: 'data:image/png;base64,AQID',
        bbox,
    }));
    const result = normalizeMistralResult({
        pages: [page({
            markdown: [
                ...images.map(image => `![${image.id}](${image.id})`),
                '',
                'Figure 6. Six panels.',
            ].join('\n\n'),
            images,
        })],
    });

    assert.deepEqual(
        [...result.markdown.matchAll(/!\[[^\]]*\]\((img-[0-9]+\.png)\)/gu)]
            .map(match => match[1]),
        ['img-0.png', 'img-3.png', 'img-1.png', 'img-4.png', 'img-2.png', 'img-5.png']
    );
});

test('skips optional malformed blocks and keeps source locations bounded', () => {
    const result = normalizeMistralResult({
        pages: [page({
            blocks: [
                null,
                { type: 'unknown', bbox: [0, 0, 1, 1] },
                { type: 'text', content: 'invalid dimensions', bbox: [0, 0, 0, 0] },
                { type: 'text', content: 'A sufficiently long paragraph for mapping.', bbox: [0, 0, 900, 900] },
            ],
        })],
        usage_info: { pages_processed: 'not-a-number' },
    }, { maxSourceLocations: 1 });
    assert.equal(result.contentList.length, 1);
    assert.equal(result.extractedPages, 1);
    assert.equal(result.totalPages, 1);
    assert.ok(result.warnings.length >= 3);
});

test('rejects malformed pages, images, Markdown, and resource limits', () => {
    assert.throws(
        () => normalizeMistralResult({ pages: [{ index: 0, markdown: 'x' }, { index: 0, markdown: 'y' }] }),
        error => error.code === 'MISTRAL_INVALID_RESULT'
    );
    assert.throws(
        () => normalizeMistralResult({ pages: [page({ markdown: ' ', images: [{ id: '../x.png', image_base64: 'AQID' }] })] }),
        error => error.code === 'MISTRAL_INVALID_RESULT'
    );
    assert.throws(
        () => normalizeMistralResult({ pages: [page({ images: [{ id: 'x.png', image_base64: 'not-base64' }] })] }),
        error => error.code === 'MISTRAL_INVALID_RESULT'
    );
    assert.throws(
        () => normalizeMistralResult({ pages: [page()] }, { maxMarkdownBytes: 1 }),
        error => error.code === 'MISTRAL_INVALID_RESULT'
    );
});

test('supports object pixel boxes and table/equation block text', () => {
    const result = normalizeMistralResult({
        pages: [page({
            markdown: [
                '| A | B |',
                '| - | - |',
                '| 1 | 2 |',
                '',
                '$$x^2$$',
            ].join('\n'),
            blocks: [
                {
                    type: 'table',
                    markdown: '| A | B |\n| - | - |\n| 1 | 2 |',
                    bbox: { x: 100, y: 100, width: 800, height: 300 },
                },
                {
                    type: 'equation',
                    latex: '$$x^2$$',
                    bbox: {
                        top_left_x: 100,
                        top_left_y: 500,
                        bottom_right_x: 900,
                        bottom_right_y: 800,
                    },
                },
            ],
        })],
    });
    assert.deepEqual(result.contentList.map(block => ({
        type: block.type,
        bbox: block.bbox,
        text: block.text,
    })), [
        { type: 'table', bbox: [100, 100, 900, 400], text: '| A | B |\n| - | - |\n| 1 | 2 |' },
        { type: 'equation', bbox: [100, 500, 900, 800], text: '$$x^2$$' },
    ]);
});

test('resolves page table content for Markdown and table blocks', () => {
    const table = '| A | B |\n| - | - |\n| 1 | 2 |';
    const result = normalizeMistralResult({
        pages: [page({
            markdown: `Table 1. Values.\n\n[tbl-0.md](tbl-0.md)`,
            tables: [{
                id: 'tbl-0',
                format: 'markdown',
                content: table,
            }],
            blocks: [{
                type: 'table',
                table_id: 'tbl-0',
                bbox: [100, 100, 900, 400],
            }],
        })],
    });

    assert.equal(result.markdown, `Table 1. Values.\n\n${table}`);
    assert.deepEqual(result.warnings, []);
    const html = renderMarkdownHTML(result.markdown);
    assert.match(html, /<table>/u);
    assert.doesNotMatch(html, /href="tbl-0\.md"/u);
    assert.deepEqual(result.contentList, [{
        type: 'table',
        pageIndex: 0,
        bbox: [100, 100, 900, 400],
        text: table,
    }]);
});

test('keeps unresolved table links and reports malformed page tables', () => {
    const result = normalizeMistralResult({
        pages: [page({
            markdown: '[tbl-0.md](tbl-0.md)',
            tables: [
                { id: '../tbl-0', content: '| unsafe |' },
                { id: 'tbl-0', format: 'html', content: '<table></table>' },
                { id: 'tbl-1', format: 'markdown', content: ' ' },
            ],
            blocks: [{
                type: 'text',
                content: 'Unmapped text block.',
                bbox: [0, 0, 100, 100],
            }],
        })],
    });

    assert.equal(result.markdown, '[tbl-0.md](tbl-0.md)');
    assert.equal(result.warnings.length, 4);
    assert.match(result.warnings[0], /invalid ID/u);
    assert.match(result.warnings[1], /unsupported format/u);
    assert.match(result.warnings[2], /has no content/u);
    assert.match(result.warnings[3], /has no table content/u);
});

test('bounds Mistral page table count and aggregate content', () => {
    assert.throws(
        () => normalizeMistralResult({
            pages: [page({
                tables: [
                    { id: 'tbl-0', content: '| A |' },
                    { id: 'tbl-1', content: '| B |' },
                ],
            })],
        }, { maxBlocks: 1 }),
        error => error.code === 'MISTRAL_INVALID_RESULT'
            && /tables exceed/u.test(error.message)
    );
    assert.throws(
        () => normalizeMistralResult({
            pages: [page({
                markdown: 'Body',
                tables: [{ id: 'tbl-0', content: '| oversized |' }],
                blocks: [],
            })],
        }, { maxMarkdownBytes: 8 }),
        error => error.code === 'MISTRAL_INVALID_RESULT'
            && /table content exceeds/u.test(error.message)
    );
});
