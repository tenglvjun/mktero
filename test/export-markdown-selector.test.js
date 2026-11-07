import test from 'node:test';
import assert from 'node:assert/strict';

import {
    selectExportMarkdown,
    selectExportMarkdownLanguage,
    selectExportMarkdownView,
} from '../src/markdown/export-markdown-selector.js';

test('returns the original Markdown when no translation view is active', () => {
    const model = {
        markdown: '# Paper\n\nOriginal paragraph.',
        translationView: 'original',
    };
    assert.equal(selectExportMarkdown(model), '# Paper\n\nOriginal paragraph.');
});

test('returns the original Markdown when the translation view is missing', () => {
    const model = { markdown: '# Paper' };
    assert.equal(selectExportMarkdown(model), '# Paper');
});

test('returns the translated Markdown in the translated reading view', () => {
    const model = {
        markdown: '# Paper\n\nOriginal paragraph.',
        translatedMarkdown: '# 论文\n\n译文段落。',
        translationView: 'translated',
    };
    assert.equal(selectExportMarkdown(model), '# 论文\n\n译文段落。');
    assert.equal(selectExportMarkdownView(model), 'translated');
});

test('returns the comparison Markdown in the bilingual comparison view', () => {
    const comparison = [
        '# Paper',
        '',
        '# 论文',
        '',
        'Original paragraph.',
        '',
        '译文段落。',
    ].join('\n');
    const model = {
        markdown: '# Paper\n\nOriginal paragraph.',
        translatedMarkdown: '# 论文\n\n译文段落。',
        comparisonMarkdown: comparison,
        translationView: 'compare',
    };
    assert.equal(selectExportMarkdown(model), comparison);
});

test('falls back to the original Markdown when the translated view lacks text', () => {
    const model = {
        markdown: '# Paper',
        translatedMarkdown: '',
        translationView: 'translated',
    };
    assert.equal(selectExportMarkdown(model), '# Paper');
});

test('falls back to the original Markdown when the comparison view lacks text', () => {
    const model = {
        markdown: '# Paper',
        comparisonMarkdown: '',
        translationView: 'compare',
    };
    assert.equal(selectExportMarkdown(model), '# Paper');
});

test('selects a language tag for the Markdown actually exported', () => {
    assert.equal(selectExportMarkdownLanguage({
        markdown: '# 原文',
        translationView: 'original',
        translationTargetLanguage: 'zh-CN',
    }), 'und');
    assert.equal(selectExportMarkdownLanguage({
        markdown: '# Paper',
        translatedMarkdown: '# 论文',
        translationView: 'translated',
        translationTargetLanguage: 'zh-CN',
    }), 'zh-CN');
    assert.equal(selectExportMarkdownLanguage({
        markdown: '# Paper',
        comparisonMarkdown: ['# Paper', '', '# 论文'].join('\n'),
        translationView: 'compare',
        translationTargetLanguage: 'zh-CN',
    }), 'mul');
});

test('uses the original language marker when a requested view falls back to original text', () => {
    const translatedFallback = {
        markdown: '# 原文',
        translatedMarkdown: '',
        translationView: 'translated',
        translationTargetLanguage: 'zh-CN',
    };
    assert.equal(selectExportMarkdown(translatedFallback), '# 原文');
    assert.equal(selectExportMarkdownView(translatedFallback), 'original');
    assert.equal(selectExportMarkdownLanguage(translatedFallback), 'und');

    const comparisonFallback = {
        markdown: '# Paper',
        comparisonMarkdown: '',
        translationView: 'compare',
    };
    assert.equal(selectExportMarkdownLanguage(comparisonFallback), 'und');
});

test('returns an empty string for a missing model', () => {
    assert.equal(selectExportMarkdown(null), '');
    assert.equal(selectExportMarkdown(undefined), '');
});

test('returns a string, never a Promise, so exporters receive a real value', () => {
    const model = {
        markdown: '# Paper',
        translatedMarkdown: '# 论文',
        translationView: 'translated',
    };
    const result = selectExportMarkdown(model);
    assert.equal(typeof result, 'string');
    assert.ok(!(result instanceof Promise));
});
