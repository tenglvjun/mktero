import test from 'node:test';
import assert from 'node:assert/strict';
import { MarkdownAnnotationOverlay } from '../src/core/markdown-annotation-overlay.js';

test('maps a PDF highlight across hidden Markdown formatting', async () => {
    const annotation = {
        id: 'HIGH0001',
        type: 'highlight',
        text: 'important result',
        comment: 'Use this claim',
        color: '#ffd400',
        pageLabel: '7',
        pageIndex: 6,
        sortIndex: '00001',
    };
    const overlay = new MarkdownAnnotationOverlay({
        extractor: {
            extract: async itemID => itemID === 42 ? [annotation] : [],
        },
    });

    const result = await overlay.resolve(
        42,
        'Intro\n\nThe **important** result changes practice.'
    );

    assert.deepEqual(result, {
        matched: [{
            ...annotation,
            matchKind: 'exact',
            ranges: [{ from: 13, to: 31 }],
        }],
        unmatched: [],
    });
});

test('matches PDF text after Unicode and whitespace normalization', async () => {
    const annotation = {
        id: 'HIGH0002',
        type: 'highlight',
        text: 'The efficient ﬁltering method',
        comment: '',
        color: '#5fb236',
        pageLabel: '8',
        pageIndex: 7,
        sortIndex: '00002',
    };
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
    });

    const result = await overlay.resolve(
        42,
        'The efficient\nfiltering method.'
    );

    assert.deepEqual(result.matched, [{
        ...annotation,
        matchKind: 'normalized',
        ranges: [{ from: 0, to: 30 }],
    }]);
    assert.deepEqual(result.unmatched, []);
});

test('uses preceding annotation order to disambiguate repeated text', async () => {
    const annotations = [
        {
            id: 'ANCHOR01',
            type: 'highlight',
            text: 'Middle anchor',
            comment: '',
            color: '#ffd400',
            pageLabel: '1',
            pageIndex: 0,
            sortIndex: '00001',
        },
        {
            id: 'REPEAT01',
            type: 'highlight',
            text: 'repeated phrase',
            comment: '',
            color: '#ff6666',
            pageLabel: '1',
            pageIndex: 0,
            sortIndex: '00002',
        },
    ];
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => annotations },
    });

    const result = await overlay.resolve(
        42,
        'repeated phrase. Middle anchor. repeated phrase.'
    );

    assert.deepEqual(
        result.matched.map(annotation => ({
            id: annotation.id,
            ranges: annotation.ranges,
        })),
        [
            { id: 'ANCHOR01', ranges: [{ from: 17, to: 30 }] },
            { id: 'REPEAT01', ranges: [{ from: 32, to: 47 }] },
        ]
    );
    assert.deepEqual(result.unmatched, []);
});

test('does not guess when repeated text remains ambiguous', async () => {
    const annotation = {
        id: 'REPEAT02',
        type: 'highlight',
        text: 'repeated phrase',
        comment: '',
        color: '#ff6666',
        pageLabel: '1',
        pageIndex: 0,
        sortIndex: '00001',
    };
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
    });

    const result = await overlay.resolve(
        42,
        'repeated phrase. Later repeated phrase.'
    );

    assert.deepEqual(result.matched, []);
    assert.deepEqual(result.unmatched, [{
        ...annotation,
        reason: 'ambiguous',
    }]);
});

test('matches visible academic figure caption text inside image markup', async () => {
    const annotation = {
        id: 'FIGURE01',
        type: 'highlight',
        text: 'Important result',
        comment: 'Figure note',
        color: '#a28ae5',
        pageLabel: '3',
        pageIndex: 2,
        sortIndex: '00001',
    };
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
    });

    const result = await overlay.resolve(
        42,
        '![Figure 1 Important result](images/figure.png)'
    );

    assert.deepEqual(result.matched, [{
        ...annotation,
        matchKind: 'exact',
        ranges: [{ from: 11, to: 27 }],
    }]);
    assert.deepEqual(result.unmatched, []);
});
