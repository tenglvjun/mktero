import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdownHTML } from '../src/markdown/markdown-html.js';
import { extractMarkdownAssetOutline } from '../src/markdown/markdown-asset-outline.js';
import {
    findAcademicFigures,
    normalizeMisassignedAcademicCaptions,
    splitTrailingAcademicFigureCaption,
} from '../src/markdown/markdown-figures.js';
import { prepareMinerUResult } from '../src/mineru/mineru-result.js';

function shiftedABFigureMarkdown() {
    return [
        '![](images/acf.jpg)  ',
        '(a) ACF',
        '',
        '![](images/residual.jpg)  ',
        '(b) Residual vs. Age  ',
        '![Figure 4. (a) Residual autocorrelation plot, and (b) residual versus age.](images/figure5.jpg)',
        '![Figure 5. Age versus fitted menstrual cycle length for six women.](images/figure6.jpg)',
        'Figure 6. Age versus fitted menstrual cycle length without the overdispersion term.',
    ].join('\n');
}

test('keeps adjacent (a)/(b) panels and the next two figures as separate captions', () => {
    const markdown = shiftedABFigureMarkdown();
    const figures = findAcademicFigures(markdown);

    assert.deepEqual(
        figures.map(figure => ({
            label: figure.caption.label,
            images: figure.images.map(image => image.source),
            layout: figure.layout || '',
        })),
        [{
            label: 'Figure 4.',
            images: [
                '![](images/acf.jpg)',
                '![](images/residual.jpg)',
            ],
            layout: 'horizontal',
        }, {
            label: 'Figure 5.',
            images: [
                '![Figure 5. Age versus fitted menstrual cycle length for six women.](images/figure5.jpg)',
            ],
            layout: '',
        }, {
            label: 'Figure 6.',
            images: [
                '![Figure 6. Age versus fitted menstrual cycle length without the overdispersion term.](images/figure6.jpg)',
            ],
            layout: '',
        }]
    );
});

test('lists the recovered (a)/(b) figure and the following figures in the outline', () => {
    const markdown = shiftedABFigureMarkdown();

    assert.deepEqual(
        extractMarkdownAssetOutline(markdown).map(item => ({
            type: item.type,
            text: item.text,
            imageSource: item.imageSource,
        })),
        [{
            type: 'figure',
            text: 'Figure 4. (a) Residual autocorrelation plot, and (b) residual versus age.',
            imageSource: 'images/acf.jpg',
        }, {
            type: 'figure',
            text: 'Figure 5. Age versus fitted menstrual cycle length for six women.',
            imageSource: 'images/figure5.jpg',
        }, {
            type: 'figure',
            text: 'Figure 6. Age versus fitted menstrual cycle length without the overdispersion term.',
            imageSource: 'images/figure6.jpg',
        }]
    );
});

test('renders recovered (a)/(b) panels side by side under the preceding figure caption', () => {
    const markdown = shiftedABFigureMarkdown();
    const figure = findAcademicFigures(markdown)[0];
    const html = renderMarkdownHTML(figure.renderSource || figure.source, {
        resolveImageURL: path => `blob:mktero-${path}`,
    });

    assert.match(html, /mktero-figure-group-horizontal/);
    assert.match(html, /blob:mktero-images\/acf\.jpg/);
    assert.match(html, /blob:mktero-images\/residual\.jpg/);
    assert.doesNotMatch(html, /figure5\.jpg/);
    assert.match(
        html,
        /<span class="mktero-figure-label">Figure 4\.<\/span>/
    );
});

test('moves a shared (a)/(b) caption off the following figure images', () => {
    const markdown = shiftedABFigureMarkdown();
    const normalized = normalizeMisassignedAcademicCaptions(markdown);
    const figures = findAcademicFigures(normalized);

    assert.match(
        normalized,
        /!\[\]\(images\/acf\.jpg\)[^\n]*\n\(a\) ACF[\s\S]*!\[\]\(images\/residual\.jpg\)[^\n]*\n\(b\) Residual vs\. Age[\s\S]*Figure 4\. \(a\) Residual autocorrelation plot/
    );
    assert.match(
        normalized,
        /!\[Figure 5\. Age versus fitted menstrual cycle length for six women\.\]\(images\/figure5\.jpg\)/
    );
    assert.match(
        normalized,
        /!\[Figure 6\. Age versus fitted menstrual cycle length without the overdispersion term\.\]\(images\/figure6\.jpg\)/
    );
    assert.doesNotMatch(
        normalized,
        /!\[Figure 4\.[\s\S]*\]\(images\/figure5\.jpg\)/
    );
    assert.deepEqual(
        figures.map(figure => ({
            label: figure.caption.label,
            layout: figure.layout || '',
        })),
        [
            { label: 'Figure 4.', layout: 'horizontal' },
            { label: 'Figure 5.', layout: '' },
            { label: 'Figure 6.', layout: '' },
        ]
    );
});

test('reassigns shifted (a)/(b) figure captions during MinerU preparation', () => {
    const result = prepareMinerUResult({ markdown: shiftedABFigureMarkdown() });

    assert.deepEqual(
        findAcademicFigures(result.markdown).map(figure => figure.caption.label),
        ['Figure 4.', 'Figure 5.', 'Figure 6.']
    );
    assert.match(result.markdown, /Figure 4\. \(a\) Residual autocorrelation plot/);
    assert.doesNotMatch(
        result.markdown,
        /!\[Figure 4\.[\s\S]*\]\(images\/figure5\.jpg\)/
    );
});

test('does not merge captioned images under a later trailing figure caption', () => {
    const markdown = [
        '![Figure 4. First result.](images/one.jpg)',
        '![Figure 5. Second result.](images/two.jpg)',
        'Figure 6. Third result.',
    ].join('\n');

    assert.deepEqual(
        findAcademicFigures(markdown).map(figure => ({
            label: figure.caption.label,
            images: figure.images.length,
        })),
        [
            { label: 'Figure 4.', images: 1 },
            { label: 'Figure 5.', images: 1 },
        ]
    );
});

function figureWithTrailingTableMarkdown() {
    return [
        '(a)  ',
        '![](images/profiles.jpg)',
        '',
        '![](images/density.jpg)',
        '',
        '(e)  ',
        '![](images/six-women.jpg)',
        '',
        '<table><tr><td>Symptoms</td><td>No</td><td>Yes</td></tr>'
            + '<tr><td>Bloating</td><td>0.82</td><td>0.18</td></tr></table>',
        '',
        '<table><tr><td colspan="3">Levels of flow amount:</td></tr>'
            + '<tr><td>Heavy</td><td>0.78</td><td>0.22</td></tr></table>',
        '',
        'Figure 7. (a) Individual profiles over time; (b) Bivariate density plot; '
            + '(c) Individual profiles for six women; (d) autocorrelation plot; '
            + '(e) Proportion of symptoms reported.',
    ].join('\n');
}

test('keeps uncaptioned tables inside a lettered figure instead of splitting it', () => {
    const markdown = figureWithTrailingTableMarkdown();
    const [figure] = findAcademicFigures(markdown);

    assert.equal(figure?.caption.label, 'Figure 7.');
    assert.deepEqual(
        figure.images.map(image => ({
            source: image.source,
            panelLabel: image.panelLabel || '',
        })),
        [
            { source: '![](images/profiles.jpg)', panelLabel: '(a)' },
            { source: '![](images/density.jpg)', panelLabel: '' },
            { source: '![](images/six-women.jpg)', panelLabel: '' },
        ]
    );
    assert.equal(figure.tablePanels?.length, 1);
    assert.equal(figure.tablePanels[0].panelLabel, '(e)');
    assert.match(figure.tablePanels[0].sources.join('\n'), /Bloating/);
    assert.match(figure.tablePanels[0].sources.join('\n'), /Levels of flow amount/);
});

test('renders a lettered figure table panel under the figure caption', () => {
    const markdown = figureWithTrailingTableMarkdown();
    const figure = findAcademicFigures(markdown)[0];
    const html = renderMarkdownHTML(figure.source, {
        resolveImageURL: path => `blob:mktero-${path}`,
    });

    assert.match(html, /mktero-figure-group/);
    assert.match(html, /blob:mktero-images\/profiles\.jpg/);
    assert.match(html, /blob:mktero-images\/six-women\.jpg/);
    assert.match(html, /<td>Bloating<\/td>/);
    assert.match(
        html,
        /mktero-figure-table-panel[\s\S]*mktero-figure-panel-label-before">\(e\)<\/div>/
    );
    assert.doesNotMatch(
        html,
        /six-women\.jpg" alt=""><\/div><div class="mktero-figure-panel">/
    );
    assert.match(
        html,
        /<span class="mktero-figure-label">Figure 7\.<\/span>/
    );
});

test('lists a figure that contains a table panel in the outline', () => {
    const markdown = figureWithTrailingTableMarkdown();

    assert.deepEqual(
        extractMarkdownAssetOutline(markdown).map(item => ({
            type: item.type,
            text: item.text.slice(0, 20),
            imageSource: item.imageSource || '',
        })),
        [{
            type: 'figure',
            text: 'Figure 7. (a) Indivi',
            imageSource: 'images/profiles.jpg',
        }]
    );
});

function splitLetteredPanelMarkdown() {
    return [
        '![Figure 9. Model selection.](images/figure9.jpg)',
        '',
        '![](images/panel-a.jpg)  ',
        '(a)',
        '',
        '![](images/panel-b1.jpg)',
        '',
        '![](images/panel-b2.jpg)  ',
        '(b)  ',
        '',
        '![Figure 10. (a) One-step-ahead training; (b) time series cross validation.]'
            + '(images/panel-b3.jpg)',
    ].join('\n');
}

test('joins trailing (a)/(b) image runs under one shared figure caption', () => {
    const markdown = splitLetteredPanelMarkdown();
    const figures = findAcademicFigures(markdown).filter(figure => (
        figure.caption.label === 'Figure 10.'
    ));

    assert.equal(figures.length, 1);
    assert.deepEqual(
        figures[0].images.map(image => ({
            source: image.source.replace(/^!\[[^\]]*\]/u, '![]'),
            panelRun: image.panelRun || '',
            panelLabel: image.panelLabel || '',
        })),
        [
            { source: '![](images/panel-a.jpg)', panelRun: 'a', panelLabel: '(a)' },
            { source: '![](images/panel-b1.jpg)', panelRun: 'b', panelLabel: '' },
            { source: '![](images/panel-b2.jpg)', panelRun: 'b', panelLabel: '' },
            { source: '![](images/panel-b3.jpg)', panelRun: 'b', panelLabel: '(b)' },
        ]
    );
    assert.equal(figures[0].layout, 'horizontal');
});

test('renders (a) beside a multi-image (b) run with one figure caption', () => {
    const markdown = splitLetteredPanelMarkdown();
    const figure = findAcademicFigures(markdown).find(item => (
        item.caption.label === 'Figure 10.'
    ));
    const html = renderMarkdownHTML(figure.source, {
        resolveImageURL: path => `blob:mktero-${path}`,
    });

    assert.match(html, /mktero-figure-group-horizontal/);
    assert.match(html, /blob:mktero-images\/panel-a\.jpg/);
    assert.match(html, /blob:mktero-images\/panel-b1\.jpg/);
    assert.match(html, /blob:mktero-images\/panel-b3\.jpg/);
    assert.match(html, /mktero-figure-panel-label">\(a\)</);
    assert.match(html, /mktero-figure-panel-label">\(b\)</);
    assert.match(html, /<span class="mktero-figure-label">Figure 10\.<\/span>/);
    assert.equal((html.match(/<figure /g) || []).length, 1);
});

test('does not absorb the next figure when lettered runs are followed by consecutive captions', () => {
    const markdown = [
        '![](images/acf.jpg)  ',
        '(a) ACF',
        '',
        '![](images/residual.jpg)  ',
        '(b) Residual vs. Age  ',
        '![Figure 4. (a) Residual autocorrelation plot, and (b) residual versus age.](images/figure5.jpg)',
        '![Figure 5. Next result.](images/figure6.jpg)',
        'Figure 6. Later result.',
    ].join('\n');

    assert.deepEqual(
        findAcademicFigures(markdown).map(figure => figure.caption.label),
        ['Figure 4.', 'Figure 5.', 'Figure 6.']
    );
});

test('does not absorb a captioned table into the preceding figure', () => {
    const markdown = [
        '![](images/plot.jpg)',
        '',
        '<table><tr><td>N</td><td>RMSE</td></tr></table>',
        '',
        'Table 1. Forecast error.',
        '',
        'Figure 2. Residual plot.',
    ].join('\n');

    assert.deepEqual(
        findAcademicFigures(markdown).map(figure => ({
            label: figure.caption.label,
            tables: figure.tablePanels?.length || 0,
        })),
        []
    );
});

test('splits a trailing academic caption that MinerU merged into a paragraph', () => {
    const body = 'A task is converted into executable evaluation examples by binding '
        + 'its specification to a concrete data context. Each resulting instance identifies the dataset';
    const caption = 'Figure 2: Construction of a reusable task and its data-bound '
        + 'instances across heterogeneous recordings.';
    const split = splitTrailingAcademicFigureCaption(`${body} ${caption}`);

    assert.ok(split);
    assert.equal(split.body, body);
    assert.equal(split.caption.text, caption);
    assert.equal(split.caption.label, 'Figure 2:');
    assert.equal(split.from, body.length + 1);
});

test('does not split prose mentions, bare labels or short bodies', () => {
    assert.equal(
        splitTrailingAcademicFigureCaption('Body text for grid-2x2 page 1. See Fig. 1.'),
        null
    );
    assert.equal(
        splitTrailingAcademicFigureCaption('Figure 2: Only a caption.'),
        null
    );
    assert.equal(
        splitTrailingAcademicFigureCaption('Short prose Figure 2: A caption.'),
        null
    );
});
