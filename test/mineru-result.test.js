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
