import test from 'node:test';
import assert from 'node:assert/strict';
import { revealPdfSelectionAsMarkdown } from '../src/ui/pdf-selection-markdown.js';

test('does not open Markdown when the cached source map has no unique passage', async () => {
    const opened = [];
    const queued = [];
    const result = await revealPdfSelectionAsMarkdown({
        reader: { type: 'pdf', itemID: 7 },
        annotation: {
            position: { pageIndex: 0, rects: [[0, 0, 10, 10]] },
        },
        loadSource: async () => ({
            documentLength: 40,
            sourceMap: [entry(0, 20, [0, 0, 10, 10]), entry(20, 40, [0, 0, 8, 10])],
        }),
        rectForBBox: (_pageIndex, bbox) => bbox,
        queueReveal: (...args) => queued.push(args),
        openMarkdown: async itemID => opened.push(itemID),
    });

    assert.deepEqual(result, { status: 'unresolved' });
    assert.deepEqual(opened, []);
    assert.deepEqual(queued, []);
});

test('does not start reading when no cached source is available', async () => {
    const opened = [];
    const result = await revealPdfSelectionAsMarkdown({
        reader: { type: 'pdf', itemID: 7 },
        annotation: {
            position: { pageIndex: 0, rects: [[0, 0, 10, 10]] },
        },
        loadSource: async () => null,
        rectForBBox: (_pageIndex, bbox) => bbox,
        queueReveal: () => {},
        openMarkdown: async itemID => opened.push(itemID),
    });

    assert.equal(result.status, 'unresolved');
    assert.deepEqual(opened, []);
});

test('ignores source boxes on pages outside the PDF selection', async () => {
    const opened = [];
    const result = await revealPdfSelectionAsMarkdown({
        reader: { type: 'pdf', itemID: 7 },
        annotation: {
            position: { pageIndex: 0, rects: [[0, 0, 10, 10]] },
        },
        loadSource: async () => ({
            documentLength: 40,
            sourceMap: [
                entry(4, 18, [0, 0, 10, 10]),
                {
                    markdownFrom: 20,
                    markdownTo: 30,
                    locations: [{ pageIndex: 3, bbox: [0, 0, 10, 10] }],
                },
            ],
        }),
        rectForBBox: (pageIndex, bbox) => (
            pageIndex === 0 ? bbox : null
        ),
        queueReveal: () => {},
        openMarkdown: async itemID => opened.push(itemID),
    });

    assert.equal(result.status, 'opened');
    assert.deepEqual(opened, [7]);
});

test('does not report success when the Markdown tab cannot reveal the passage', async () => {
    const result = await revealPdfSelectionAsMarkdown({
        reader: { type: 'pdf', itemID: 7 },
        annotation: {
            position: { pageIndex: 0, rects: [[0, 0, 10, 10]] },
        },
        loadSource: async () => ({
            documentLength: 20,
            sourceMap: [entry(4, 18, [0, 0, 10, 10])],
        }),
        rectForBBox: (_pageIndex, bbox) => bbox,
        queueReveal: () => {},
        openMarkdown: async () => false,
    });

    assert.deepEqual(result, { status: 'unresolved' });
});

test('opens a column-merged paragraph when its text is unique but its box misses the selection', async () => {
    const markdown = 'In this study, network meta-analysis was employed. Despite all studies being randomized controlled trials, the impracticality of blinding in most non-pharmacological interventions remained.';
    const opened = [];
    const queued = [];
    const result = await revealPdfSelectionAsMarkdown({
        reader: { type: 'pdf', itemID: 7 },
        annotation: {
            text: 'Despite all studies being randomized controlled trials, the impracticality of blinding in most non-phar- macological interventions remained.',
            position: { pageIndex: 12, rects: [[300, 400, 540, 620]] },
        },
        loadSource: async () => ({
            markdown,
            documentLength: markdown.length,
            sourceMap: [{
                markdownFrom: 0,
                markdownTo: markdown.length,
                locations: [{ pageIndex: 12, bbox: [87, 804, 492, 926] }],
            }],
        }),
        rectForBBox: () => [52, 58, 293, 155],
        queueReveal: (itemID, range) => queued.push([itemID, range.markdownFrom]),
        openMarkdown: async itemID => opened.push(itemID),
    });

    assert.equal(result.status, 'opened');
    assert.deepEqual(opened, [7]);
    assert.equal(markdown[queued[0][1]], 'D');
});

test('does not use text to choose between two overlapping source boxes', async () => {
    const markdown = 'Despite all studies being randomized controlled trials, the impracticality of blinding in most non-pharmacological interventions remained.';
    const opened = [];
    const result = await revealPdfSelectionAsMarkdown({
        reader: { type: 'pdf', itemID: 7 },
        annotation: {
            text: markdown,
            position: { pageIndex: 0, rects: [[0, 0, 10, 10]] },
        },
        loadSource: async () => ({
            markdown,
            documentLength: markdown.length,
            sourceMap: [
                entry(0, 40, [0, 0, 10, 10]),
                entry(40, markdown.length, [0, 0, 8, 10]),
            ],
        }),
        rectForBBox: (_pageIndex, bbox) => bbox,
        queueReveal: () => {},
        openMarkdown: async itemID => opened.push(itemID),
    });

    assert.equal(result.status, 'unresolved');
    assert.deepEqual(opened, []);
});

test('opens Markdown at the unique cached passage without translating it', async () => {
    const opened = [];
    const queued = [];
    const result = await revealPdfSelectionAsMarkdown({
        reader: { type: 'pdf', itemID: 7 },
        annotation: {
            text: 'same words elsewhere',
            position: { pageIndex: 0, rects: [[0, 0, 10, 10]] },
        },
        loadSource: async () => ({
            documentLength: 40,
            sourceMap: [entry(4, 18, [0, 0, 10, 10])],
        }),
        rectForBBox: (_pageIndex, bbox) => bbox,
        queueReveal: (itemID, range) => queued.push([itemID, range]),
        openMarkdown: async itemID => opened.push(itemID),
    });

    assert.equal(result.status, 'opened');
    assert.deepEqual(opened, [7]);
    assert.deepEqual(queued, [[7, { markdownFrom: 4, markdownTo: 18 }]]);
});

function entry(markdownFrom, markdownTo, bbox) {
    return {
        markdownFrom,
        markdownTo,
        locations: [{ pageIndex: 0, bbox }],
    };
}
