import test from 'node:test';
import assert from 'node:assert/strict';
import {
    checkReadingCorpus,
    collectLayoutSignals,
    countChromeLeaks,
    countMarkdownFloats,
    countParagraphBreaks,
    countVisibleNotes,
    diffSummaries,
    measureSourceMapCoverage,
    measureTextCoverage,
    normalizeMetricText,
    READING_CORPUS_ENV,
    READING_CORPUS_FALLBACK_ENV,
    summarizeMarkdownBlocks,
    textShingles,
} from '../scripts/reading-corpus-check.mjs';

const corpusDir = process.env[READING_CORPUS_ENV] || process.env[READING_CORPUS_FALLBACK_ENV];

function loc(pageIndex, bbox) {
    return { pageIndex, bbox };
}

test('normalizes metric text to case-folded letters and digits', () => {
    assert.equal(normalizeMetricText('Fig. 1 — Ünïcode ﬁt'), 'fig1ünïcodefit');
    assert.deepEqual(textShingles('abc'), []);
    assert.deepEqual(textShingles('abcdefghij', { size: 8, step: 4 }), ['abcdefgh', 'cdefghij']);
});

test('classifies top-level Markdown blocks and skips directives', () => {
    const blocks = summarizeMarkdownBlocks([
        '# Title',
        '<!-- mktero-figure-layout: {} -->',
        '![Fig. 1 caption](images/a.jpg) ![](images/b.jpg)',
        '$$\nx=1\n$$',
        '<table><tr><td>1</td></tr></table>',
        'Plain prose.',
        '- item',
    ].join('\n\n'));
    assert.deepEqual(blocks.map(block => block.kind), ['heading', 'image', 'math', 'table', 'text', 'list']);
    assert.equal(blocks[1].images, 2);
    assert.deepEqual(countMarkdownFloats(blocks), {
        image: 2, captionedImage: 1, table: 1, algorithm: 0, code: 0, math: 1,
    });
});

test('counts open sentence breaks by the PDF boundary that separated them', () => {
    const markdown = [
        'The model learns',
        'across pages without loss',
        '![Fig. 2](images/a.jpg)',
        'and across floats in one column',
        'Next sentence starts upper case.',
        'Lower case after a period is fine.',
    ].join('\n\n');
    const blocks = summarizeMarkdownBlocks(markdown);
    const at = text => markdown.indexOf(text);
    const sourceMap = [
        { markdownFrom: at('The model'), markdownTo: at('The model') + 16, locations: [loc(0, [100, 900, 480, 950])] },
        { markdownFrom: at('across pages'), markdownTo: at('across pages') + 25, locations: [loc(1, [100, 80, 480, 120])] },
        { markdownFrom: at('and across'), markdownTo: at('and across') + 31, locations: [loc(1, [100, 400, 480, 450])] },
    ];
    const breaks = countParagraphBreaks(blocks, sourceMap);
    assert.equal(breaks.total, 2);
    assert.equal(breaks.page, 1);
    assert.equal(breaks.float, 1);
});

test('treats headings and lists as hard boundaries for breaks', () => {
    const blocks = summarizeMarkdownBlocks('An open line\n\n## Heading\n\nlower start\n\n- item\n\nlower again');
    assert.equal(countParagraphBreaks(blocks, []).total, 0);
});

test('counts discarded decorations that survive as visible blocks', () => {
    const blocks = summarizeMarkdownBlocks([
        'JOURNAL OF MEDICAL INTERNET RESEARCH',
        'Body prose mentions the Journal of Medical Internet Research in passing, which is not a leak.',
        'JOURNAL OF MEDICAL INTERNET RESEARCH Smith et al',
    ].join('\n\n'));
    const chrome = [
        { type: 'header', text: 'JOURNAL OF MEDICAL INTERNET RESEARCH' },
        { type: 'header', text: 'JOURNAL OF MEDICAL INTERNET RESEARCH' },
        { type: 'header', text: 'JOURNAL OF MEDICAL INTERNET RESEARCH' },
        { type: 'page_number', text: '3' },
    ];
    assert.deepEqual(countChromeLeaks(blocks, chrome), { candidates: 3, leaks: 2 });
});

test('measures span coverage and footnote visibility with shingles', () => {
    const visible = 'The quick brown fox jumps over the lazy dog near the river bank.';
    assert.deepEqual(measureTextCoverage(visible, ['quick brown fox jumps']), { total: 4, found: 4, ratio: 1 });
    const missing = measureTextCoverage(visible, ['completely different words here']);
    assert.equal(missing.found, 0);
    assert.deepEqual(countVisibleNotes(visible, ['lazy dog near the river', 'not present anywhere at all']), {
        total: 2, found: 1,
    });
});

test('measures source map coverage and cross-page entries', () => {
    const markdown = 'First paragraph.\n\nSecond paragraph.';
    const blocks = summarizeMarkdownBlocks(markdown);
    const coverage = measureSourceMapCoverage(blocks, [{
        markdownFrom: 0,
        markdownTo: 16,
        locations: [loc(0, [0, 0, 10, 10]), loc(1, [0, 0, 10, 10])],
        locationRanges: [
            { markdownFrom: 0, markdownTo: 6, location: loc(0, [0, 0, 10, 10]) },
            { markdownFrom: 6, markdownTo: 16, location: loc(1, [0, 0, 10, 10]) },
        ],
    }], markdown.length);
    assert.deepEqual(coverage, { total: 2, covered: 1, ratio: 0.5, crossPage: 1 });
});

test('collects layout signals from discarded and nested blocks', () => {
    const span = content => ({ lines: [{ spans: [{ type: 'text', content }] }] });
    const signals = collectLayoutSignals({ pdf_info: [{
        discarded_blocks: [
            { type: 'header', ...span('Running header') },
            { type: 'page_footnote', ...span('1 A footnote') },
        ],
        para_blocks: [
            { type: 'text', ...span('Body text') },
            { type: 'ref_text', ...span('[1] Ref') },
            { type: 'image', blocks: [
                { type: 'image_body', lines: [{ spans: [{ type: 'image', image_path: 'a.jpg' }] }] },
                { type: 'image_caption', ...span('Fig. 1 caption') },
            ] },
            { type: 'interline_equation', lines: [{ spans: [{ type: 'interline_equation', content: 'x' }] }] },
        ],
    }] });
    assert.equal(signals.pages, 1);
    assert.deepEqual(signals.chrome, [{ type: 'header', text: 'Running header' }]);
    assert.deepEqual(signals.pageNotes, ['1 A footnote']);
    assert.deepEqual(signals.bodySpans, ['Body text', '[1] Ref', 'Fig. 1 caption']);
    assert.equal(signals.references, 1);
    assert.equal(signals.floats.image, 1);
    assert.equal(signals.floats.captioned, 1);
});

test('reports nested metric differences', () => {
    assert.deepEqual(diffSummaries({ a: { b: 1 }, c: [1] }, { a: { b: 2 }, c: [2] }), [
        'a.b expected 1, actual 2',
        'c changed',
    ]);
});

test('matches committed reading expectations for every local corpus archive', {
    skip: corpusDir ? false : `set ${READING_CORPUS_ENV} to a directory of MinerU result archives`,
}, async () => {
    for (const pipeline of ['legacy']) {
        const report = await checkReadingCorpus({ corpusDir, pipeline, log: () => {} });
        assert.equal(report.failures.length, 0,
            report.failures.map(failure => failure.message).join('\n'));
    }
});
