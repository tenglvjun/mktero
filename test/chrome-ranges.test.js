import test from 'node:test';
import assert from 'node:assert/strict';
import {
    absorbBlankLines,
    findLeadingPublisherChromeRanges,
    mapChromeRanges,
    normalizeChromeRanges,
    subtractChromeRanges,
    visibleDocumentChromeRanges,
    visibleTextForRanges,
} from '../src/markdown/chrome-ranges.js';

const PAPER_TITLE = 'Systematic review and meta-analysis';

test('drops invalid chrome range collections', () => {
    assert.deepEqual(normalizeChromeRanges(null, 10), []);
    assert.deepEqual(normalizeChromeRanges([{ from: 1, to: 0 }], 10), []);
    assert.deepEqual(normalizeChromeRanges([{ from: 0, to: 11 }], 10), []);
    assert.deepEqual(normalizeChromeRanges([{ from: 0, to: 1 }], 0), []);
});

test('merges overlapping and adjacent chrome ranges', () => {
    assert.deepEqual(
        normalizeChromeRanges([{ from: 5, to: 8 }, { from: 0, to: 2 }, { from: 2, to: 4 }], 20),
        [{ from: 0, to: 4 }, { from: 5, to: 8 }]
    );
});

test('subtracts chrome from a selection and concatenates visible text', () => {
    const markdown = 'Hello\n\n12\n\nWorld';
    const chrome = normalizeChromeRanges([{ from: 5, to: 11 }], markdown.length);
    const ranges = subtractChromeRanges({ from: 0, to: markdown.length }, chrome);
    assert.deepEqual(ranges, [{ from: 0, to: 5 }, { from: 11, to: markdown.length }]);
    assert.equal(visibleTextForRanges(markdown, ranges), 'HelloWorld');
});

test('returns no ranges when the selection is only chrome', () => {
    assert.deepEqual(
        subtractChromeRanges({ from: 5, to: 11 }, [{ from: 5, to: 11 }]),
        []
    );
});

test('absorbs neighboring blank lines into chrome ranges', () => {
    const markdown = 'Hello\n\n12\n\nWorld';
    const absorbed = absorbBlankLines(markdown, [{ from: 7, to: 9 }]);
    assert.equal(markdown.slice(absorbed[0].from, absorbed[0].to), '\n\n12\n\n');
});

test('maps chrome ranges through an unrelated replacement and drops overlaps', () => {
    const markdown = 'AAA\nCHROME\nBBB';
    const chrome = [{ from: 4, to: 10 }];
    const shifted = mapChromeRanges(
        chrome,
        [{ from: 0, to: 3, replacementLength: 7 }],
        markdown.length + 4
    );
    assert.deepEqual(shifted, [{ from: 8, to: 14 }]);
    assert.deepEqual(
        mapChromeRanges(chrome, [{ from: 4, to: 10, replacementLength: 0 }], 8),
        []
    );
});

test('maps chrome ranges using original-document transform coordinates', () => {
    const chrome = [{ from: 4, to: 10 }];
    const shifted = mapChromeRanges(
        chrome,
        [
            { from: 0, to: 3, replacementLength: 7 },
            { from: 11, to: 14, replacementLength: 3 },
        ],
        18
    );
    assert.deepEqual(shifted, [{ from: 8, to: 14 }]);
});

test('hides leading publisher UI chrome before the paper title', () => {
    const markdown = [
        'Check for updates',
        '',
        'REVIEW ARTICLE OPEN',
        '',
        '# Systematic review and meta-analysis',
        '',
        'Han Li and authors.',
    ].join('\n');
    const ranges = findLeadingPublisherChromeRanges(markdown);
    assert.equal(
        ranges.some(range => (
            markdown.slice(range.from, range.to).includes('Check for updates')
        )),
        true
    );
    assert.equal(
        ranges.some(range => (
            markdown.slice(range.from, range.to).includes('REVIEW ARTICLE OPEN')
        )),
        true
    );
    assert.equal(
        ranges.some(range => (
            markdown.slice(range.from, range.to).includes('Systematic review')
        )),
        false
    );
});

test('does not hide the paper title heading with publisher chrome', () => {
    const markdown = [
        'Check for updates',
        '',
        'REVIEW ARTICLE OPEN',
        '',
        '# Systematic review and meta-analysis',
        '',
        'Han Li',
    ].join('\n');
    const titleFrom = markdown.indexOf('# Systematic');
    const ranges = visibleDocumentChromeRanges(markdown, [
        { from: 0, to: titleFrom + 2 },
    ], PAPER_TITLE);
    assert.equal(ranges.some(range => range.to > titleFrom), false);
    assert.equal(markdown.slice(titleFrom, titleFrom + 2), '# ');
});

test('does not hide introduction or body as publisher chrome', () => {
    const markdown = [
        '# INTRODUCTION',
        '',
        'Conversational artificial intelligence is gaining traction.',
    ].join('\n');
    assert.deepEqual(findLeadingPublisherChromeRanges(markdown), []);
    assert.deepEqual(
        visibleDocumentChromeRanges(markdown, [{ from: 0, to: 1 }], 'INTRODUCTION'),
        []
    );
});

test('does not hide the paper title heading marks', () => {
    const markdown = [
        'MDPI',
        'sensors',
        '# Systematic review and meta-analysis',
        '',
        'Han Li and authors.',
    ].join('\n');
    const titleFrom = markdown.indexOf('# Systematic');
    const chrome = visibleDocumentChromeRanges(markdown, [], PAPER_TITLE);
    assert.equal(chrome.every(range => range.to < titleFrom), true);
    assert.equal(markdown.slice(titleFrom, titleFrom + 2), '# ');
});

test('hides content before the first paper title heading', () => {
    const markdown = [
        'MDPI',
        'sensors',
        '# Systematic review and meta-analysis',
        '',
        'Han Li and authors.',
    ].join('\n');
    const visible = visibleDocumentText(markdown);
    assert.equal(visible.includes('MDPI'), false);
    assert.equal(visible.includes('sensors'), false);
    assert.equal(
        visible.trimStart().startsWith('# Systematic review and meta-analysis'),
        true
    );
});

test('hides content before the first level-2 paper title heading', () => {
    const markdown = [
        'Journal masthead',
        '## A compact survey of sensors',
        '',
        'Introduction body.',
    ].join('\n');
    const visible = visibleDocumentText(
        markdown,
        [],
        'A compact survey of sensors'
    );
    assert.equal(visible.includes('Journal masthead'), false);
    assert.equal(
        visible.trimStart().startsWith('## A compact survey of sensors'),
        true
    );
});

test('does not treat a level-3 heading as the paper title', () => {
    const markdown = [
        'MDPI',
        '### Open access',
        '# Systematic review and meta-analysis',
        '',
        'Han Li and authors.',
    ].join('\n');
    const visible = visibleDocumentText(markdown);
    assert.equal(visible.includes('MDPI'), false);
    assert.equal(visible.includes('### Open access'), false);
    assert.equal(
        visible.trimStart().startsWith('# Systematic review and meta-analysis'),
        true
    );
});

test('does not hide a document that has no paper title heading', () => {
    const markdown = [
        'OCR running header',
        '',
        'The extracted body starts without a heading.',
    ].join('\n');
    assert.equal(
        visibleDocumentText(markdown),
        markdown
    );
});

test('keeps stored chrome after the paper title heading', () => {
    const markdown = [
        'MDPI',
        '# Systematic review and meta-analysis',
        '',
        'Body text',
        '12',
    ].join('\n');
    const pageNumberFrom = markdown.lastIndexOf('12');
    const visible = visibleDocumentText(markdown, [
        { from: pageNumberFrom, to: pageNumberFrom + 2 },
    ]);
    assert.equal(visible.includes('MDPI'), false);
    assert.equal(visible.includes('# Systematic review and meta-analysis'), true);
    assert.equal(visible.includes('12'), false);
});

test('hides content before the second copy of a repeated paper title', () => {
    const markdown = [
        'MDPI',
        '# Systematic review and meta-analysis',
        'Article',
        '# Systematic review and meta-analysis',
        '',
        'Han Li and authors.',
    ].join('\n');
    const secondTitleFrom = markdown.lastIndexOf('# Systematic');
    const visible = visibleDocumentText(markdown);
    assert.equal(visible.includes('MDPI'), false);
    assert.equal(visible.includes('Article'), false);
    assert.equal(
        [...visible.matchAll(/# Systematic review and meta-analysis/g)].length,
        1
    );
    assert.equal(
        visibleDocumentChromeRanges(markdown, [], PAPER_TITLE).every(range => (
            range.to < secondTitleFrom
        )),
        true
    );
    assert.equal(
        visible.trimStart().startsWith('# Systematic review and meta-analysis'),
        true
    );
});

test('treats a repeated title as the same heading across # and ##', () => {
    const markdown = [
        '## Systematic review and meta-analysis',
        'Article',
        '# Systematic review and meta-analysis',
        '',
        'Han Li and authors.',
    ].join('\n');
    const visible = visibleDocumentText(markdown);
    assert.equal(visible.includes('Article'), false);
    assert.equal(
        visible.trimStart().startsWith('# Systematic review and meta-analysis'),
        true
    );
});

test('does not skip a unique paper title when a later heading is different', () => {
    const markdown = [
        'MDPI',
        '# Systematic review and meta-analysis',
        '',
        '## Abstract',
        '',
        'Body.',
    ].join('\n');
    const visible = visibleDocumentText(markdown);
    assert.equal(
        visible.trimStart().startsWith('# Systematic review and meta-analysis'),
        true
    );
    assert.equal(visible.includes('## Abstract'), true);
});

test('hides publisher headings that do not match the Zotero item title', () => {
    const itemTitle = 'The effect of music interventions in autism spectrum disorder: a systematic review and meta-analysis';
    const markdown = [
        'Check for updates',
        '',
        '## OPEN ACCESS',
        '',
        'EDITED BY',
        'Takao Yamasaki',
        '',
        '## CITATION',
        '',
        `Navarro L (2025) ${itemTitle}. Front. Integr. Neurosci.`,
        '',
        '## COPYRIGHT',
        '',
        '© 2025 Navarro.',
        '',
        `# ${itemTitle}`,
        '',
        'Laura Navarro',
    ].join('\n');
    const visible = visibleDocumentText(markdown, [], itemTitle);
    assert.equal(visible.includes('OPEN ACCESS'), false);
    assert.equal(visible.includes('EDITED BY'), false);
    assert.equal(visible.includes('CITATION'), false);
    assert.equal(visible.includes('COPYRIGHT'), false);
    assert.equal(visible.trimStart().startsWith(`# ${itemTitle}`), true);
});

test('does not treat a fenced code heading as the paper title', () => {
    const markdown = [
        '```',
        '# not the title',
        '```',
        '',
        '# Systematic review and meta-analysis',
        '',
        'Han Li and authors.',
    ].join('\n');
    const visible = visibleDocumentText(markdown);
    assert.equal(visible.includes('# not the title'), false);
    assert.equal(
        visible.trimStart().startsWith('# Systematic review and meta-analysis'),
        true
    );
});

function visibleDocumentText(markdown, storedRanges = [], itemTitle = PAPER_TITLE) {
    const chrome = visibleDocumentChromeRanges(markdown, storedRanges, itemTitle);
    return visibleTextForRanges(
        markdown,
        subtractChromeRanges({ from: 0, to: markdown.length }, chrome)
    );
}
