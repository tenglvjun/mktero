import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getLocalizationMessageKeys,
    translateMessage,
} from '../src/i18n/localization.js';
import { renderMarkdownHTML } from '../src/markdown/markdown-html.js';

test('renders a note blockquote and a paired section label, never the directive text', () => {
    const html = renderMarkdownHTML([
        '<!-- mktero-section: author-biographies -->',
        '',
        'Born in 1900.',
        '',
        '<!-- /mktero-section -->',
        '',
        '<!-- mktero-note: table -->',
        '> $^{1}$ Quoted in a practitioner newsletter.',
    ].join('\n'));

    assert.match(
        html,
        /<p class="mktero-section-label"><strong>Author biographies<\/strong><\/p>/
    );
    assert.match(html, /<blockquote class="mktero-note">/);
    assert.match(html, /Quoted in a practitioner newsletter/);
    assert.doesNotMatch(html, /<!--\s*mktero-/);
});

test('renders an unpaired section directive as nothing and keeps its content', () => {
    const html = renderMarkdownHTML([
        '<!-- mktero-section: article-info -->',
        '',
        'Visible affiliation.',
    ].join('\n'));

    assert.equal(html.includes('mktero-section'), false);
    assert.match(html, /<p>Visible affiliation\.<\/p>/);
    assert.doesNotMatch(html, /mktero-section-label/);
});

test('localizes paired section labels through the renderer translate option', () => {
    const html = renderMarkdownHTML([
        '<!-- mktero-section: reporting-summary -->',
        '',
        'Summary text.',
        '',
        '<!-- /mktero-section -->',
    ].join('\n'), {
        translate: (key, variables) => translateMessage('zh-CN', key, variables),
    });

    assert.match(html, /<p class="mktero-section-label"><strong>报告摘要<\/strong><\/p>/);
    assert.match(html, /<p>Summary text\.<\/p>/);
});

test('ignores directive text that is escaped, fenced, or inside a paragraph', () => {
    const html = renderMarkdownHTML([
        'Text \\<!-- mktero-note: footnote --> more',
        '',
        '```',
        '<!-- mktero-section: article-info -->',
        '```',
        '',
        'See <!-- mktero-note: figure --> inline.',
    ].join('\n'));

    assert.match(html, /mktero-note: footnote/);
    assert.match(html, /mktero-section: article-info/);
    assert.match(html, /mktero-note: figure/);
    assert.doesNotMatch(html, /class="mktero-note"|mktero-section-label/);
});

test('keeps section label and disclosure keys in both languages', () => {
    const english = new Set(getLocalizationMessageKeys('en-US'));
    const chinese = new Set(getLocalizationMessageKeys('zh-CN'));
    const keys = [
        'markdown.section.articleInfo',
        'markdown.section.authorBiographies',
        'markdown.section.reportingSummary',
        'markdown.section.expand',
        'markdown.section.collapse',
    ];
    assert.deepEqual(
        keys.filter(key => !english.has(key) || !chinese.has(key)),
        []
    );
    assert.deepEqual(
        keys.map(key => translateMessage('en-US', key)),
        [
            'Article information',
            'Author biographies',
            'Reporting summary',
            'Expand',
            'Collapse',
        ]
    );
    assert.deepEqual(
        keys.map(key => translateMessage('zh-CN', key)),
        ['文章信息', '作者简介', '报告摘要', '展开', '收起']
    );
});

test('labels a chart data section in snapshots and notes', () => {
    const html = renderMarkdownHTML([
        '<!-- mktero-section: chart-data -->',
        '',
        '<table><tr><td>year</td></tr></table>',
        '',
        '<!-- /mktero-section -->',
    ].join('\n'));
    assert.match(html, /<p class="mktero-section-label"><strong>Chart data<\/strong><\/p>/);
    assert.equal(translateMessage('zh-CN', 'markdown.section.chartData'), '图表数据');
});
