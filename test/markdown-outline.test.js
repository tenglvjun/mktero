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

test('ignores empty ATX heading markers in the outline', () => {
    const markdown = [
        '#',
        '',
        '## Valid heading',
    ].join('\n');

    assert.deepEqual(
        extractMarkdownOutline(markdown).map(heading => heading.text),
        ['Valid heading']
    );
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

test('infers outline depth from section numbers when Markdown headings are flat', () => {
    const markdown = [
        '## 1. Introduction',
        '',
        '## 3. Methodology',
        '',
        '## 3.1 Three-Layer',
        '',
        '## 3.2.1 Skill Provisioning',
        '',
        '## Limitations',
        '',
        '## References',
    ].join('\n');

    assert.deepEqual(
        extractMarkdownOutline(markdown).map(heading => [heading.text, heading.level]),
        [
            ['1. Introduction', 1],
            ['3. Methodology', 1],
            ['3.1 Three-Layer', 2],
            ['3.2.1 Skill Provisioning', 3],
            ['Limitations', 1],
            ['References', 1],
        ]
    );
});

test('infers numbered outline depth among same-level section headings', () => {
    const markdown = [
        '# WikiSkill: Compiling Agent Experience',
        '',
        '## 1. Introduction',
        '',
        '## 3. Methodology',
        '',
        '## 3.1 Three-Layer',
        '',
        '## 3.2.1 Skill Provisioning',
        '',
        '## Limitations',
    ].join('\n');

    assert.deepEqual(
        extractMarkdownOutline(markdown).map(heading => [heading.text, heading.level]),
        [
            ['WikiSkill: Compiling Agent Experience', 1],
            ['1. Introduction', 1],
            ['3. Methodology', 1],
            ['3.1 Three-Layer', 2],
            ['3.2.1 Skill Provisioning', 3],
            ['Limitations', 1],
        ]
    );
});

test('infers outline depth from appendix letter numbers', () => {
    const markdown = [
        '## A. Method Details',
        '',
        '## A.1. Algorithm',
        '',
        '## B. Dataset Details and Splits',
        '',
        '## D.1. Baseline Methods',
        '',
        '## AI Disclosure',
    ].join('\n');

    assert.deepEqual(
        extractMarkdownOutline(markdown).map(heading => [heading.text, heading.level]),
        [
            ['A. Method Details', 1],
            ['A.1. Algorithm', 2],
            ['B. Dataset Details and Splits', 1],
            ['D.1. Baseline Methods', 2],
            ['AI Disclosure', 1],
        ]
    );
});

test('infers outline depth from Roman sections and letter subsections', () => {
    const markdown = [
        '# Tiny Spiking Neural Network',
        '',
        '## I. INTRODUCTION AND RELATED WORK',
        '',
        '## A. PPG-based Blood-Pressure Estimation',
        '',
        '## B. Spiking Neural Networks',
        '',
        '## II. BACKGROUND',
        '',
        '## III. METHODOLOGY',
        '',
        '## A. Spiking Neural Network for Blood Pressure',
        '',
        '## D. Benchmarking Datasets',
        '',
        '## IV. EXPERIMENTAL RESULTS',
        '',
        '## V. CONCLUSIONS',
        '',
        '## REFERENCES',
    ].join('\n');

    assert.deepEqual(
        extractMarkdownOutline(markdown).map(heading => [heading.text, heading.level]),
        [
            ['Tiny Spiking Neural Network', 1],
            ['I. INTRODUCTION AND RELATED WORK', 1],
            ['A. PPG-based Blood-Pressure Estimation', 2],
            ['B. Spiking Neural Networks', 2],
            ['II. BACKGROUND', 1],
            ['III. METHODOLOGY', 1],
            ['A. Spiking Neural Network for Blood Pressure', 2],
            ['D. Benchmarking Datasets', 2],
            ['IV. EXPERIMENTAL RESULTS', 1],
            ['V. CONCLUSIONS', 1],
            ['REFERENCES', 1],
        ]
    );
});

test('keeps Markdown heading levels when they already vary', () => {
    const markdown = '# Overview\n\n## Methods\n\n### Results';

    assert.deepEqual(
        extractMarkdownOutline(markdown).map(heading => heading.level),
        [1, 2, 3]
    );
});

test('omits headings whose offset is inside chromeRanges', () => {
    const markdown = '# Nature\n\n# Methods';
    assert.deepEqual(
        extractMarkdownOutline(markdown, [{ from: 0, to: markdown.indexOf('\n\n') }])
            .map(heading => heading.text),
        ['Methods']
    );
});

test('levels numbered Wiley headings across different Markdown heading marks', () => {
    const markdown = [
        '# Paper title',
        '',
        '# 1 | INTRODUCTION',
        '',
        'Coronary angiography is an invasive diagnostic procedure.',
        '',
        '## 2 | METHODS',
        '',
        'This trial was single-blind.',
        '',
        '### 2.1 | Design',
        '',
        'Patients were randomized.',
        '',
        '#### 2.4.1 | Breathing group',
        '',
        'Exercises started 30 min before angiography.',
    ].join('\n');

    assert.deepEqual(
        extractMarkdownOutline(markdown).map(heading => [heading.text, heading.level]),
        [
            ['Paper title', 1],
            ['1 | INTRODUCTION', 1],
            ['2 | METHODS', 1],
            ['2.1 | Design', 2],
            ['2.4.1 | Breathing group', 3],
        ]
    );
});

test('omits a KEYWORDS heading that only introduces a term list', () => {
    const markdown = [
        '# Paper title',
        '',
        '# KEYWORDS',
        '',
        'anxiety, breathing exercise, coronary angiography, music therapy, pain',
        '',
        '# 1 | INTRODUCTION',
        '',
        'Coronary angiography is invasive.',
    ].join('\n');

    assert.deepEqual(
        extractMarkdownOutline(markdown).map(heading => heading.text),
        ['Paper title', '1 | INTRODUCTION']
    );
});

test('omits a short bullet box heading before the next section', () => {
    const markdown = [
        '# 1 | INTRODUCTION',
        '',
        'Music therapy utilizes rhythm, melody and harmony to',
        '',
        '# What is known about the topic',
        '',
        '- Previous research studied music therapy.',
        '',
        '# What this paper adds',
        '',
        '- This study compares music and breathing exercises.',
        '',
        'aid in the treatment of illnesses.',
        '',
        '## 2 | METHODS',
        '',
        'This trial was single-blind.',
    ].join('\n');

    assert.deepEqual(
        extractMarkdownOutline(markdown).map(heading => heading.text),
        ['1 | INTRODUCTION', '2 | METHODS']
    );
});
