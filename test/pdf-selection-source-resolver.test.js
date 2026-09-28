import test from 'node:test';
import assert from 'node:assert/strict';
import {
    collectSourceMapSelectionTargets,
    maximumPdfSelectionCoverage,
    pdfSelectionPagesFromAnnotation,
    resolvePdfSelectionSource,
    resolveUniqueSelectionText,
    selectionCandidatesFromTargets,
} from '../src/core/pdf-selection-source-resolver.js';

test('resolves a PDF selection to the one source region that contains it', () => {
    const match = resolvePdfSelectionSource({
        pages: [{ pageIndex: 0, rects: [[0, 0, 10, 10]] }],
        candidates: [
            candidate(0, 20, [0, 0, 10, 10]),
            candidate(40, 60, [30, 30, 40, 40]),
        ],
    });

    assert.deepEqual(match, { markdownFrom: 0, markdownTo: 20 });
});

test('rejects a selection covered by two source regions', () => {
    const match = resolvePdfSelectionSource({
        pages: [{ pageIndex: 1, rects: [[0, 0, 10, 10]] }],
        candidates: [
            candidate(0, 20, [0, 0, 10, 10], 1),
            candidate(20, 40, [0, 0, 8, 10], 1),
        ],
    });

    assert.equal(match, null);
});

test('rejects a selection that does not overlap a source region', () => {
    const match = resolvePdfSelectionSource({
        pages: [{ pageIndex: 0, rects: [[0, 0, 10, 10]] }],
        candidates: [candidate(0, 20, [20, 20, 30, 30])],
    });

    assert.equal(match, null);
});

test('accepts a two-page selection only when the Markdown ranges meet', () => {
    const adjacent = resolvePdfSelectionSource({
        pages: [
            { pageIndex: 0, rects: [[0, 0, 10, 10]] },
            { pageIndex: 1, rects: [[0, 90, 10, 100]] },
        ],
        candidates: [
            candidate(0, 20, [0, 0, 10, 10], 0),
            candidate(20, 40, [0, 90, 10, 100], 1),
            candidate(80, 90, [50, 50, 60, 60], 1),
        ],
    });
    const separated = resolvePdfSelectionSource({
        pages: [
            { pageIndex: 0, rects: [[0, 0, 10, 10]] },
            { pageIndex: 1, rects: [[0, 90, 10, 100]] },
        ],
        candidates: [
            candidate(0, 20, [0, 0, 10, 10], 0),
            candidate(40, 60, [0, 90, 10, 100], 1),
        ],
    });

    assert.deepEqual(adjacent, { markdownFrom: 0, markdownTo: 40 });
    assert.equal(separated, null);
});

test('rejects an invalid PDF rectangle instead of using the remaining text', () => {
    const match = resolvePdfSelectionSource({
        pages: [{ pageIndex: 0, rects: [[0, 0, 10, 10], [1]] }],
        candidates: [candidate(0, 20, [0, 0, 10, 10])],
    });

    assert.equal(match, null);
});

test('uses tight source ranges instead of a coarse block box', () => {
    const targets = collectSourceMapSelectionTargets([{
        markdownFrom: 0,
        markdownTo: 40,
        locations: [{ pageIndex: 0, bbox: [0, 0, 1000, 1000] }],
        locationRanges: [{
            markdownFrom: 5,
            markdownTo: 15,
            location: { pageIndex: 0, bbox: [0, 0, 100, 100] },
        }],
    }], 40);

    assert.deepEqual(targets, [{
        markdownFrom: 5,
        markdownTo: 15,
        pageIndex: 0,
        bbox: [0, 0, 100, 100],
    }]);
});

test('reads at most the selection page and the following page from Zotero', () => {
    const pages = pdfSelectionPagesFromAnnotation({
        text: 'repeated sentence',
        position: {
            pageIndex: 2,
            rects: [[1, 2, 3, 4]],
            nextPageRects: [[5, 6, 8, 9]],
        },
    });

    assert.deepEqual(pages, [
        { pageIndex: 2, rects: [[1, 2, 3, 4]] },
        { pageIndex: 3, rects: [[5, 6, 8, 9]] },
    ]);
    assert.equal(pdfSelectionPagesFromAnnotation({
        position: { pageIndex: 0, rects: [] },
    }), null);
});

test('stops when a source box cannot be converted into the PDF coordinate space', () => {
    const targets = [{
        markdownFrom: 0,
        markdownTo: 10,
        pageIndex: 0,
        bbox: [0, 0, 10, 10],
    }];

    assert.equal(selectionCandidatesFromTargets(targets, () => null), null);
    assert.deepEqual(
        selectionCandidatesFromTargets(targets, () => [1, 2, 4, 6]),
        [{
            markdownFrom: 0,
            markdownTo: 10,
            pageIndex: 0,
            rect: [1, 2, 4, 6],
        }]
    );
});

test('uses unique text when the stored box misses the selected column', () => {
    const markdown = [
        'In this study, network meta-analysis was employed.',
        'Despite all studies being randomized controlled trials, the impracticality of blinding in most non-pharmacological interventions remained.',
    ].join(' ');
    const match = resolveUniqueSelectionText({
        markdown,
        text: 'Despite all studies being randomized controlled trials, the impracticality of blinding in most non-phar-\nmacological interventions remained.',
        sourceMap: [{
            markdownFrom: 0,
            markdownTo: markdown.length,
            locations: [{ pageIndex: 12, bbox: [87, 804, 492, 926] }],
        }],
    });

    assert.equal(markdown.startsWith('Despite all studies', match.markdownFrom), true);
    assert.equal(markdown.slice(match.markdownFrom, match.markdownTo).endsWith('remained'), true);
});

test('does not use repeated selection text to choose a paragraph', () => {
    const sentence = 'Despite all studies being randomized controlled trials, the impracticality of blinding remained clear.';
    const markdown = `${sentence}\n\n${sentence}`;
    const match = resolveUniqueSelectionText({
        markdown,
        text: sentence,
        sourceMap: [
            entryRange(0, sentence.length),
            entryRange(sentence.length + 2, markdown.length),
        ],
    });

    assert.equal(match, null);
});

test('reports no geometric coverage when the selection misses every source box', () => {
    const coverage = maximumPdfSelectionCoverage({
        pages: [{ pageIndex: 12, rects: [[300, 400, 540, 620]] }],
        candidates: [candidate(0, 20, [52, 58, 293, 155], 12)],
    });

    assert.equal(coverage, 0);
});

function candidate(markdownFrom, markdownTo, rect, pageIndex = 0) {
    return { markdownFrom, markdownTo, pageIndex, rect };
}

function entryRange(markdownFrom, markdownTo) {
    return {
        markdownFrom,
        markdownTo,
        locations: [{ pageIndex: 12, bbox: [0, 0, 10, 10] }],
    };
}
