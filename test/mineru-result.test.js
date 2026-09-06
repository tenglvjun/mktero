import test from 'node:test';
import assert from 'node:assert/strict';
import { findAcademicFigureGroups } from '../src/markdown/markdown-figures.js';
import { renderMarkdownHTML } from '../src/markdown/markdown-html.js';
import { prepareMinerUResult } from '../src/mineru/mineru-result.js';
import { MINERU_SOURCE_MAP_OPTIONS } from '../src/mineru/parser-profile.js';

test('includes figure panel reassembly in the MinerU parser profile', () => {
    assert.equal(
        MINERU_SOURCE_MAP_OPTIONS.figurePanels,
        'same-page-horizontal-or-labeled-vertical-ab-v2'
    );
    assert.equal(
        MINERU_SOURCE_MAP_OPTIONS.figureLayouts,
        'same-page-image-group-layout-v1'
    );
    assert.equal(
        MINERU_SOURCE_MAP_OPTIONS.textFlow,
        'cross-page-continuation-v1'
    );
    assert.equal(
        MINERU_SOURCE_MAP_OPTIONS.columns,
        'same-page-two-column-reading-order-v3'
    );
});

test('reassembles side-by-side MinerU panels separated by upper-page prose', () => {
    const caption = 'Fig. 1 Example data for tracking (a) menstruation and '
        + '(b) ovulation.';
    const prose = 'The intervening paragraph is positioned above both panels.';
    const result = prepareMinerUResult({
        markdown: [
            'Introduction.',
            '',
            '![](images/panel-a.jpg)',
            '',
            prose,
            '',
            `![${caption}](images/panel-b.jpg)`,
            '',
            'Following paragraph.',
        ].join('\n'),
        contentList: [{
            type: 'chart',
            assetPath: 'images/panel-a.jpg',
            pageIndex: 3,
            bbox: [100, 613, 497, 851],
        }, {
            type: 'text',
            text: prose,
            pageIndex: 3,
            bbox: [504, 184, 909, 427],
        }, {
            type: 'chart',
            assetPath: 'images/panel-b.jpg',
            pageIndex: 3,
            bbox: [500, 615, 890, 851],
        }],
    });

    assert.equal(
        result.markdown,
        [
            'Introduction.',
            '',
            prose,
            '',
            '![](images/panel-a.jpg)  ',
            '',
            `![${caption}](images/panel-b.jpg)`,
            '',
            'Following paragraph.',
        ].join('\n')
    );
    const groups = findAcademicFigureGroups(result.markdown);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].images.length, 2);
    assert.deepEqual(
        result.sourceMap.map(entry => ({
            type: entry.type,
            source: result.markdown.slice(entry.markdownFrom, entry.markdownTo),
            locations: entry.locations,
        })),
        [{
            type: 'text',
            source: prose,
            locations: [{ pageIndex: 3, bbox: [504, 184, 909, 427] }],
        }, {
            type: 'chart',
            source: '![](images/panel-a.jpg)  ',
            locations: [{ pageIndex: 3, bbox: [100, 613, 497, 851] }],
        }, {
            type: 'chart',
            source: `![${caption}](images/panel-b.jpg)`,
            locations: [{ pageIndex: 3, bbox: [500, 615, 890, 851] }],
        }]
    );
    const html = renderMarkdownHTML(
        result.markdown.slice(groups[0].from, groups[0].to),
        { resolveImageURL: path => `blob:mktero-${path}` }
    );
    assert.match(
        html,
        /<figure class="mktero-figure mktero-figure-group mktero-figure-group-horizontal">/
    );
    assert.match(html, /<div class="mktero-figure-panels-horizontal">/);
});

test('joins a cross-page prose continuation before an intervening chart', () => {
    const first = 'The algorithm HALF_LOCS uses (MIN +';
    const second = 'The temperature values were used by all algorithms.';
    const third = 'Based on the pilot study, menstruation was predicted.';
    const continuation = '(AVG_MCL / 4) rounded down) for the beginning.';
    const following = 'At the simplest, ovulation prediction detects a rise.';
    const figure = '![](images/figure.jpg)';
    const markdown = [
        first,
        figure,
        continuation,
        second,
        third,
        following,
    ].join('\n\n');
    const result = prepareMinerUResult({
        markdown,
        contentList: [{
            type: 'text',
            text: first,
            pageIndex: 3,
            bbox: [504, 426, 910, 594],
        }, {
            type: 'chart',
            assetPath: figure.slice('![]('.length, -1),
            pageIndex: 3,
            bbox: [100, 613, 497, 851],
        }, {
            type: 'text',
            text: continuation,
            pageIndex: 4,
            bbox: [87, 107, 489, 154],
        }, {
            type: 'text',
            text: second,
            pageIndex: 3,
            bbox: [504, 108, 907, 184],
        }, {
            type: 'text',
            text: third,
            pageIndex: 3,
            bbox: [504, 184, 909, 427],
        }],
    });

    assert.equal(result.markdown, [
        `${first} ${continuation}`,
        figure,
        second,
        third,
        following,
    ].join('\n\n'));
    assert.deepEqual(
        result.sourceMap.map(entry => ({
            type: entry.type,
            source: result.markdown.slice(entry.markdownFrom, entry.markdownTo),
            locations: entry.locations,
            ...(entry.locationRanges
                ? { locationRanges: entry.locationRanges }
                : {}),
        })),
        [{
            type: 'text',
            source: `${first} ${continuation}`,
            locations: [
                { pageIndex: 3, bbox: [504, 426, 910, 594] },
                { pageIndex: 4, bbox: [87, 107, 489, 154] },
            ],
            locationRanges: [{
                markdownFrom: 0,
                markdownTo: first.length,
                location: { pageIndex: 3, bbox: [504, 426, 910, 594] },
            }, {
                markdownFrom: first.length + 1,
                markdownTo: first.length + 1 + continuation.length,
                location: { pageIndex: 4, bbox: [87, 107, 489, 154] },
            }],
        }, {
            type: 'chart',
            source: figure,
            locations: [{ pageIndex: 3, bbox: [100, 613, 497, 851] }],
        }, {
            type: 'text',
            source: second,
            locations: [{ pageIndex: 3, bbox: [504, 108, 907, 184] }],
            locationRanges: [{
                markdownFrom: 108,
                markdownTo: 108 + second.length,
                location: { pageIndex: 3, bbox: [504, 108, 907, 184] },
            }],
        }, {
            type: 'text',
            source: third,
            locations: [{ pageIndex: 3, bbox: [504, 184, 909, 427] }],
            locationRanges: [{
                markdownFrom: 161,
                markdownTo: 161 + third.length,
                location: { pageIndex: 3, bbox: [504, 184, 909, 427] },
            }],
        }]
    );
});

test('does not reorder a continuation across an independent text block', () => {
    const first = 'A complete source block ends with an operator +';
    const independent = 'This is an independent paragraph after the anchor.';
    const continuation = '(continued text belongs to another paragraph).';
    const figure = '![](images/figure.jpg)';
    const markdown = [first, independent, figure, continuation].join('\n\n');
    const result = prepareMinerUResult({
        markdown,
        contentList: [{
            type: 'text',
            text: first,
            pageIndex: 3,
            bbox: [100, 400, 450, 500],
        }, {
            type: 'text',
            text: independent,
            pageIndex: 3,
            bbox: [100, 520, 450, 620],
        }, {
            type: 'chart',
            assetPath: 'images/figure.jpg',
            pageIndex: 3,
            bbox: [100, 650, 450, 850],
        }, {
            type: 'text',
            text: continuation,
            pageIndex: 4,
            bbox: [100, 100, 450, 180],
        }],
    });

    assert.equal(result.markdown, markdown);
});

test('joins a prose continuation that starts with a word', () => {
    const first = 'The calculation continues from the previous page with (';
    const continuation = 'AVG_MCL / 4) rounded down for the result.';
    const figure = '![](images/figure.jpg)';
    const markdown = [first, figure, continuation].join('\n\n');
    const result = prepareMinerUResult({
        markdown,
        contentList: [{
            type: 'text',
            text: first,
            pageIndex: 3,
            bbox: [100, 400, 450, 500],
        }, {
            type: 'chart',
            assetPath: 'images/figure.jpg',
            pageIndex: 3,
            bbox: [100, 650, 450, 850],
        }, {
            type: 'text',
            text: continuation,
            pageIndex: 4,
            bbox: [100, 100, 450, 180],
        }],
    });

    assert.equal(result.markdown, [
        `${first} ${continuation}`,
        figure,
    ].join('\n\n'));
});

test('does not move a block-level HTML continuation from untrusted input', () => {
    const first = 'The source paragraph ends with an unfinished expression +';
    const continuation = '<script>alert("untrusted")</script>';
    const figure = '![](images/figure.jpg)';
    const markdown = [first, figure, continuation].join('\n\n');
    const result = prepareMinerUResult({
        markdown,
        contentList: [{
            type: 'text',
            text: first,
            pageIndex: 3,
            bbox: [100, 400, 450, 500],
        }, {
            type: 'chart',
            assetPath: 'images/figure.jpg',
            pageIndex: 3,
            bbox: [100, 650, 450, 850],
        }, {
            type: 'text',
            text: continuation,
            pageIndex: 4,
            bbox: [100, 100, 450, 180],
        }],
    });

    assert.equal(result.markdown, markdown);
});

test('does not reorder an apparent continuation without layout evidence', () => {
    const first = 'A complete enough source block ends with an operator +';
    const continuation = '(continued text without a figure in between).';
    const markdown = [first, continuation].join('\n\n');
    const result = prepareMinerUResult({
        markdown,
        contentList: [{
            type: 'text',
            text: first,
            pageIndex: 3,
            bbox: [504, 426, 910, 594],
        }, {
            type: 'text',
            text: continuation,
            pageIndex: 4,
            bbox: [87, 107, 489, 154],
        }],
    });

    assert.equal(result.markdown, markdown);
});

test('orders same-page two-column prose by PDF reading order', () => {
    const leftColumn = 'Finding locations in the menstrual cycle component.';
    const rightColumnTop = 'The temperature values were used by all algorithms.';
    const rightColumnBottom = 'Three algorithms predicting the ovulation day were defined.';
    const markdown = [leftColumn, rightColumnBottom, rightColumnTop].join('\n\n');
    const result = prepareMinerUResult({
        markdown,
        contentList: [{
            type: 'text',
            text: leftColumn,
            pageIndex: 3,
            bbox: [100, 600, 490, 850],
        }, {
            type: 'text',
            text: rightColumnTop,
            pageIndex: 3,
            bbox: [510, 100, 900, 300],
        }, {
            type: 'text',
            text: rightColumnBottom,
            pageIndex: 3,
            bbox: [510, 650, 900, 850],
        }],
    });

    assert.equal(result.markdown, [
        leftColumn,
        rightColumnTop,
        rightColumnBottom,
    ].join('\n\n'));
    assert.deepEqual(
        result.sourceMap.map(entry => ({
            source: result.markdown.slice(entry.markdownFrom, entry.markdownTo),
            locations: entry.locations,
        })),
        [{
            source: leftColumn,
            locations: [{ pageIndex: 3, bbox: [100, 600, 490, 850] }],
        }, {
            source: rightColumnTop,
            locations: [{ pageIndex: 3, bbox: [510, 100, 900, 300] }],
        }, {
            source: rightColumnBottom,
            locations: [{ pageIndex: 3, bbox: [510, 650, 900, 850] }],
        }]
    );
});

test('orders a same-page block before a cross-page paragraph continuation', () => {
    const threeAlgorithms = 'Three algorithms predicting the ovulation day were '
        + 'defined. The algorithm HALF_LOCS predicted ovulation similarly to the '
        + 'algorithm MENSES as the middle day between the adjacent MIN and MAX.';
    const threeAlgorithmsStart = 'Three algorithms predicting the ovulation day were defined.';
    const threeAlgorithmsContinuation = 'The algorithm HALF_LOCS predicted ovulation similarly '
        + 'to the algorithm MENSES as the middle day between the adjacent MIN and MAX.';
    const based = 'Based on our separate pilot study, the start of menstruation was associated '
        + 'with the middle time point between the adjacent MAX and MIN.';
    const result = prepareMinerUResult({
        markdown: [threeAlgorithms, based].join('\n\n'),
        contentList: [{
            type: 'text',
            text: threeAlgorithmsStart,
            pageIndex: 3,
            bbox: [510, 650, 900, 760],
        }, {
            type: 'text',
            text: threeAlgorithmsContinuation,
            pageIndex: 4,
            bbox: [100, 100, 490, 220],
        }, {
            type: 'text',
            text: based,
            pageIndex: 3,
            bbox: [510, 300, 900, 620],
        }],
    });

    assert.equal(result.markdown, [based, threeAlgorithms].join('\n\n'));
});

test('restores column order after relocating an intervening figure panel', () => {
    const temperature = 'The temperature values of the menstrual cycle component were used '
        + 'by all the algorithms in menstrual cycle phase tracking.';
    const threeAlgorithms = 'Three algorithms predicting the ovulation day were defined.';
    const based = 'Based on our separate pilot study, the start of menstruation was associated '
        + 'with the middle time point between the adjacent MAX and MIN.';
    const leftPanel = '![](images/panel-a.jpg)';
    const caption = 'Fig. 1 Example data for tracking (a) menstruation and (b) ovulation.';
    const rightPanel = `![${caption}](images/panel-b.jpg)`;
    const result = prepareMinerUResult({
        markdown: [
            temperature,
            threeAlgorithms,
            leftPanel,
            based,
            rightPanel,
        ].join('\n\n'),
        contentList: [{
            type: 'text',
            text: temperature,
            pageIndex: 3,
            bbox: [504, 108, 907, 184],
        }, {
            type: 'text',
            text: threeAlgorithms,
            pageIndex: 3,
            bbox: [504, 426, 910, 594],
        }, {
            type: 'chart',
            assetPath: 'images/panel-a.jpg',
            pageIndex: 3,
            bbox: [100, 613, 497, 851],
        }, {
            type: 'text',
            text: based,
            pageIndex: 3,
            bbox: [504, 184, 909, 427],
        }, {
            type: 'chart',
            assetPath: 'images/panel-b.jpg',
            pageIndex: 3,
            bbox: [500, 615, 890, 851],
        }],
    });

    assert.equal(result.markdown, [
        temperature,
        based,
        threeAlgorithms,
        `${leftPanel}  `,
        rightPanel,
    ].join('\n\n'));
    assert.deepEqual(
        result.sourceMap.slice(0, 3).map(entry => ({
            source: result.markdown.slice(entry.markdownFrom, entry.markdownTo),
            locations: entry.locations,
        })),
        [{
            source: temperature,
            locations: [{ pageIndex: 3, bbox: [504, 108, 907, 184] }],
        }, {
            source: based,
            locations: [{ pageIndex: 3, bbox: [504, 184, 909, 427] }],
        }, {
            source: threeAlgorithms,
            locations: [{ pageIndex: 3, bbox: [504, 426, 910, 594] }],
        }]
    );
});

test('keeps spatially ambiguous MinerU charts in their original order', () => {
    const cases = [{
        caption: 'Fig. 2 Results from the first chart.',
        proseBBox: [504, 184, 909, 427],
    }, {
        caption: 'Fig. 2 Results for (a) baseline and (b) follow-up.',
        proseBBox: [504, 650, 909, 720],
    }];

    for (const { caption, proseBBox } of cases) {
        const prose = 'This paragraph must remain between the two charts.';
        const markdown = [
            '![](images/first.jpg)',
            '',
            prose,
            '',
            `![${caption}](images/second.jpg)`,
        ].join('\n');
        const result = prepareMinerUResult({
            markdown,
            contentList: [{
                type: 'chart',
                assetPath: 'images/first.jpg',
                pageIndex: 2,
                bbox: [100, 610, 495, 850],
            }, {
                type: 'text',
                text: prose,
                pageIndex: 2,
                bbox: proseBBox,
            }, {
                type: 'chart',
                assetPath: 'images/second.jpg',
                pageIndex: 2,
                bbox: [500, 612, 895, 850],
            }],
        });

        assert.equal(result.markdown, markdown, caption);
        assert.equal(findAcademicFigureGroups(result.markdown).length, 0);
    }
});

test('does not group adjacent panels without bbox-backed layout evidence', () => {
    const markdown = '![](images/panel-a.jpg)\n\n'
        + '![Fig. 1 Results for (a) baseline and (b) follow-up.]'
        + '(images/panel-b.jpg)';
    const result = prepareMinerUResult({ markdown });

    assert.equal(result.markdown, markdown);
    assert.equal(findAcademicFigureGroups(result.markdown).length, 0);
});

test('does not reassemble a partner chart that has an independent caption', () => {
    const prose = 'This paragraph is positioned above both independent charts.';
    const markdown = [
        '![Fig. 2 Independent result.](images/independent.jpg)',
        '',
        prose,
        '',
        '![Fig. 1 Results for (a) baseline and (b) follow-up.]'
            + '(images/shared-caption.jpg)',
    ].join('\n');
    const result = prepareMinerUResult({
        markdown,
        contentList: [{
            type: 'chart',
            assetPath: 'images/independent.jpg',
            pageIndex: 2,
            bbox: [100, 610, 495, 850],
        }, {
            type: 'text',
            text: prose,
            pageIndex: 2,
            bbox: [504, 184, 909, 427],
        }, {
            type: 'chart',
            assetPath: 'images/shared-caption.jpg',
            pageIndex: 2,
            bbox: [500, 612, 895, 850],
        }],
    });

    assert.equal(result.markdown, markdown);
    assert.equal(findAcademicFigureGroups(result.markdown).length, 0);
});

test('marks already adjacent bbox-backed panels as horizontal', () => {
    const caption = 'Fig. 1 Results for (a) baseline and (b) follow-up.';
    const result = prepareMinerUResult({
        markdown: '![](images/panel-a.jpg)\n\n'
            + `![${caption}](images/panel-b.jpg)`,
        contentList: [{
            type: 'chart',
            assetPath: 'images/panel-a.jpg',
            pageIndex: 2,
            bbox: [100, 610, 495, 850],
        }, {
            type: 'chart',
            assetPath: 'images/panel-b.jpg',
            pageIndex: 2,
            bbox: [500, 612, 895, 850],
        }],
    });

    assert.equal(
        result.markdown,
        '![](images/panel-a.jpg)  \n\n'
            + `![${caption}](images/panel-b.jpg)`
    );
    assert.equal(findAcademicFigureGroups(result.markdown)[0]?.layout, 'horizontal');
});

test('restores a MinerU multi-image grid from content-list coordinates', () => {
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
        type: 'image',
        assetPath: `images/mineru-${index}.png`,
        pageIndex: 4,
        bbox,
    }));
    const result = prepareMinerUResult({
        markdown: [
            ...images.map(image => `![](${image.assetPath})`),
            '',
            'Figure 4. Seven MinerU panels.',
        ].join('\n\n'),
        contentList: images,
    });

    assert.match(
        result.markdown,
        /<!-- mktero-figure-layout: columns=3 rows=3,3,1 -->/u
    );
    const groups = findAcademicFigureGroups(result.markdown);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].layout, 'grid');
    assert.equal(groups[0].gridColumns, 3);
    assert.deepEqual(groups[0].gridRows, [3, 3, 1]);
    const html = renderMarkdownHTML(result.markdown, {
        resolveImageURL: path => `blob:mktero-${path}`,
    });
    assert.match(html, /mktero-figure-group-grid/u);
    assert.match(html, /mktero-figure-panels-grid/u);
});

test('reassembles vertically stacked MinerU panels with leading A/B labels', () => {
    const caption = 'Fig. 5 Ovulation prediction (a) sensitivities and '
        + '(b) positive predictive values (PPV).';
    const markdown = [
        '(A)  ',
        '![](images/panel-a.jpg)  ',
        '(B)',
        '',
        `![${caption}](images/panel-b.jpg)`,
        '',
        '![Fig. 6 Independent result.](images/figure-6.jpg)',
    ].join('\n');
    const result = prepareMinerUResult({
        markdown,
        contentList: [{
            type: 'chart',
            assetPath: 'images/panel-a.jpg',
            pageIndex: 7,
            bbox: [213, 139, 786, 293],
        }, {
            type: 'chart',
            assetPath: 'images/panel-b.jpg',
            pageIndex: 7,
            bbox: [213, 312, 786, 475],
        }, {
            type: 'chart',
            assetPath: 'images/figure-6.jpg',
            pageIndex: 7,
            bbox: [99, 631, 482, 865],
        }],
    });

    assert.equal(result.markdown, [
        '(A)   ',
        '![](images/panel-a.jpg)   ',
        '(B)',
        '',
        `![${caption}](images/panel-b.jpg)`,
        '',
        '![Fig. 6 Independent result.](images/figure-6.jpg)',
    ].join('\n'));
    const groups = findAcademicFigureGroups(result.markdown);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].layout, 'vertical');
    assert.deepEqual(
        groups[0].images.map(image => ({
            source: image.source,
            panelLabel: image.panelLabel,
            panelLabelPosition: image.panelLabelPosition,
        })),
        [{
            source: '![](images/panel-a.jpg)',
            panelLabel: '(A)',
            panelLabelPosition: 'before',
        }, {
            source: `![${caption}](images/panel-b.jpg)`,
            panelLabel: '(B)',
            panelLabelPosition: 'before',
        }]
    );
    assert.deepEqual(
        result.sourceMap.slice(0, 2).map(entry => ({
            type: entry.type,
            source: result.markdown.slice(entry.markdownFrom, entry.markdownTo),
            locations: entry.locations,
        })),
        [{
            type: 'chart',
            source: '(A)   \n![](images/panel-a.jpg)   \n(B)',
            locations: [{ pageIndex: 7, bbox: [213, 139, 786, 293] }],
        }, {
            type: 'chart',
            source: `![${caption}](images/panel-b.jpg)`,
            locations: [{ pageIndex: 7, bbox: [213, 312, 786, 475] }],
        }]
    );

    const html = renderMarkdownHTML(
        result.markdown.slice(groups[0].from, groups[0].to),
        { resolveImageURL: path => `blob:mktero-${path}` }
    );
    assert.match(
        html,
        /<figure class="mktero-figure mktero-figure-group mktero-figure-group-vertical">/
    );
    assert.match(
        html,
        /mktero-figure-panel-label-before">\(A\)<\/div><img/
    );
    assert.match(
        html,
        /mktero-figure-panel-label-before">\(B\)<\/div><img/
    );
    assert.equal((html.match(/<figcaption>/g) || []).length, 1);
});

test('does not mark ambiguous vertical charts as one A/B figure', () => {
    const caption = 'Fig. 5 Results for (a) baseline and (b) follow-up.';
    const cases = [{
        firstLabel: '(A)',
        secondLabel: '(C)',
        firstBBox: [213, 139, 786, 293],
        secondBBox: [213, 312, 786, 475],
    }, {
        firstLabel: '(A)',
        secondLabel: '(B)',
        firstBBox: [213, 139, 786, 293],
        secondBBox: [213, 520, 786, 683],
    }, {
        firstLabel: '(A)',
        secondLabel: '(B)',
        firstBBox: [100, 139, 430, 293],
        secondBBox: [500, 312, 830, 475],
    }];

    for (const { firstLabel, secondLabel, firstBBox, secondBBox } of cases) {
        const markdown = [
            `${firstLabel}  `,
            '![](images/panel-a.jpg)  ',
            secondLabel,
            '',
            `![${caption}](images/panel-b.jpg)`,
        ].join('\n');
        const result = prepareMinerUResult({
            markdown,
            contentList: [{
                type: 'chart',
                assetPath: 'images/panel-a.jpg',
                pageIndex: 7,
                bbox: firstBBox,
            }, {
                type: 'chart',
                assetPath: 'images/panel-b.jpg',
                pageIndex: 7,
                bbox: secondBBox,
            }],
        });

        assert.equal(result.markdown, markdown);
        assert.equal(findAcademicFigureGroups(result.markdown).length, 0);
    }
});

test('requires the exact bbox-backed marker for a vertical A/B figure', () => {
    const caption = 'Fig. 5 Results for (a) baseline and (b) follow-up.';
    for (const spaces of ['  ', '    ']) {
        const markdown = [
            `(A)${spaces}`,
            `![](images/panel-a.jpg)${spaces}`,
            '(B)',
            '',
            `![${caption}](images/panel-b.jpg)`,
        ].join('\n');

        assert.equal(findAcademicFigureGroups(markdown).length, 0);
    }
});

test('does not absorb a third hard-break image into an A/B figure group', () => {
    const markdown = '![](images/unrelated.jpg)  \n\n'
        + '![](images/panel-a.jpg)  \n\n'
        + '![Fig. 1 Results for (a) baseline and (b) follow-up.]'
        + '(images/panel-b.jpg)';

    const groups = findAcademicFigureGroups(markdown);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].images.length, 2);
    assert.doesNotMatch(
        groups[0].images.map(image => image.source).join('\n'),
        /unrelated/
    );
});

test('preserves indentation after a relocated panel', () => {
    const prose = 'Indented content must remain a Markdown code block.';
    const markdown = [
        'Introduction.',
        '',
        '![](images/panel-a.jpg)',
        '',
        `    ${prose}`,
        '',
        '![Fig. 1 Results for (a) baseline and (b) follow-up.]'
            + '(images/panel-b.jpg)',
    ].join('\n');
    const result = prepareMinerUResult({
        markdown,
        contentList: [{
            type: 'chart',
            assetPath: 'images/panel-a.jpg',
            pageIndex: 2,
            bbox: [100, 610, 495, 850],
        }, {
            type: 'text',
            text: prose,
            pageIndex: 2,
            bbox: [504, 184, 909, 427],
        }, {
            type: 'chart',
            assetPath: 'images/panel-b.jpg',
            pageIndex: 2,
            bbox: [500, 612, 895, 850],
        }],
    });

    assert.equal(
        result.markdown,
        [
            'Introduction.',
            '',
            `    ${prose}`,
            '',
            '![](images/panel-a.jpg)  ',
            '',
            '![Fig. 1 Results for (a) baseline and (b) follow-up.]'
                + '(images/panel-b.jpg)',
        ].join('\n')
    );
});

test('ignores malformed figure panel source geometry', () => {
    const markdown = '![](images/panel-a.jpg)\n\n'
        + '![Fig. 1 Results for (a) baseline and (b) follow-up.]'
        + '(images/panel-b.jpg)';
    const result = prepareMinerUResult({
        markdown,
        contentList: [{
            type: 'chart',
            assetPath: 'images/panel-a.jpg',
            pageIndex: 2,
            bbox: [-1, 610, 495, 850],
        }, {
            type: 'chart',
            assetPath: 'images/panel-b.jpg',
            pageIndex: 2,
            bbox: [500, 612, 895, 850],
        }],
    });

    assert.equal(result.markdown, markdown);
    assert.equal(findAcademicFigureGroups(result.markdown).length, 0);
});
