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

test('matches PDF smart quotes against Markdown ASCII quotes', async () => {
    const annotation = {
        id: 'QUOTE001',
        type: 'highlight',
        text: [
            'No audio features were significantly associated with',
            'participants’ desired recovery emotions.',
        ].join(' '),
        comment: '',
        color: '#ffd400',
        pageLabel: '1',
        pageIndex: 0,
        sortIndex: '00003',
    };
    const markdown = [
        'No audio features were significantly associated with',
        "participants' desired recovery emotions.",
    ].join(' ');
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
    });

    const result = await overlay.resolve(42, markdown);

    assert.deepEqual(result.matched, [{
        ...annotation,
        matchKind: 'normalized',
        ranges: [{ from: 0, to: markdown.length }],
    }]);
    assert.deepEqual(result.unmatched, []);
});

test('matches PDF citations against MinerU dollar-wrapped citations', async () => {
    const annotation = {
        id: 'CITE0001',
        type: 'highlight',
        text: [
            'positive emotions interact with our stress systems,',
            'lowering cortisol [26, 27], significantly.',
        ].join(' '),
        comment: '',
        color: '#ffd400',
        pageLabel: '2',
        pageIndex: 1,
        sortIndex: '00004',
    };
    const markdown = [
        'positive emotions interact with our stress systems,',
        'lowering cortisol $[26, 27]$ , significantly.',
    ].join(' ');
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
    });

    const result = await overlay.resolve(42, markdown);

    assert.deepEqual(result.matched, [{
        ...annotation,
        matchKind: 'normalized',
        ranges: [{ from: 0, to: markdown.length }],
    }]);
    assert.deepEqual(result.unmatched, []);
});

test('matches PDF footnote digits against MinerU sentence superscripts', async () => {
    const annotation = {
        id: 'FOOT0001',
        type: 'highlight',
        text: 'named skills is a system that composes.11',
        comment: '',
        color: '#ffd400',
        pageLabel: '12',
        pageIndex: 11,
        sortIndex: '00012',
    };
    const markdown = 'named skills is a system that composes. $^{11}$';
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
    });

    const result = await overlay.resolve(42, markdown);

    assert.deepEqual(result.matched, [{
        ...annotation,
        matchKind: 'normalized',
        ranges: [{ from: 0, to: markdown.length }],
    }]);
    assert.deepEqual(result.unmatched, []);
});

test('does not flatten ordinary numeric superscript math into PDF text', async () => {
    const annotation = {
        id: 'MATH0002',
        type: 'highlight',
        text: 'x2',
        comment: '',
        color: '#ffd400',
        pageLabel: '12',
        pageIndex: 11,
        sortIndex: '00013',
    };
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
    });

    const result = await overlay.resolve(42, 'The value is x $^{2}$.');

    assert.deepEqual(result.matched, []);
    assert.deepEqual(result.unmatched, [{
        ...annotation,
        reason: 'not-found',
    }]);
});

test('does not treat a new paragraph numeric superscript as a footnote', async () => {
    const annotation = {
        id: 'MATH0003',
        type: 'highlight',
        text: 'finished.2',
        comment: '',
        color: '#ffd400',
        pageLabel: '12',
        pageIndex: 11,
        sortIndex: '00014',
    };
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
    });

    const result = await overlay.resolve(42, 'The sentence finished.\n\n$^{2}$');

    assert.deepEqual(result.matched, []);
    assert.deepEqual(result.unmatched, [{
        ...annotation,
        reason: 'not-found',
    }]);
});

test('rejects oversized malformed sentence superscript markup', async () => {
    const annotation = {
        id: 'LIMIT003',
        type: 'highlight',
        text: 'finished.1111',
        comment: '',
        color: '#ffd400',
        pageLabel: '12',
        pageIndex: 11,
        sortIndex: '00015',
    };
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
    });
    const markdown = 'The sentence finished. $^{' + '1'.repeat(100_000);

    const result = await overlay.resolve(42, markdown);

    assert.deepEqual(result.matched, []);
    assert.deepEqual(result.unmatched, [{
        ...annotation,
        reason: 'not-found',
    }]);
});

test('keeps plain numeric citation brackets visible to PDF annotations', async () => {
    const annotation = {
        id: 'CITE0003',
        type: 'highlight',
        text: [
            'breathing was gradually slowed to encourage deeper breathing)',
            '[30], and patients were invited to focus.',
        ].join(' '),
        comment: '',
        color: '#ffd400',
        pageLabel: '4',
        pageIndex: 3,
        sortIndex: '00008',
    };
    const markdown = [
        'breathing was gradually slowed to encourage deeper breathing)',
        '[30], and patients were invited to focus.',
    ].join(' ');
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
    });

    const result = await overlay.resolve(42, markdown);

    assert.deepEqual(result.matched, [{
        ...annotation,
        matchKind: 'exact',
        ranges: [{ from: 0, to: markdown.length }],
    }]);
    assert.deepEqual(result.unmatched, []);
});

test('matches PDF trademark symbols against MinerU superscript markup', async () => {
    const annotation = {
        id: 'MARK0001',
        type: 'highlight',
        text: [
            'Participants listened via headphones',
            '(BOSE® quiet comfort 35 II) from an iPod®,',
            'and the volume was controlled.',
        ].join(' '),
        comment: '',
        color: '#ffd400',
        pageLabel: '4',
        pageIndex: 3,
        sortIndex: '00009',
    };
    const markdown = [
        'Participants listened via headphones',
        '(BOSE $^{®}$ quiet comfort 35 II) from an iPod $^{®}$ ,',
        'and the volume was controlled.',
    ].join(' ');
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
    });

    const result = await overlay.resolve(42, markdown);

    assert.deepEqual(result.matched, [{
        ...annotation,
        matchKind: 'normalized',
        ranges: [{ from: 0, to: markdown.length }],
    }]);
    assert.deepEqual(result.unmatched, []);
});

test('maps a PDF trademark symbol to its complete MinerU source markup', async () => {
    const annotation = {
        id: 'MARK0004',
        type: 'highlight',
        text: '®',
        comment: '',
        color: '#ffd400',
        pageLabel: '4',
        pageIndex: 3,
        sortIndex: '00010',
    };
    const markdown = 'BOSE $^{®}$ headphones';
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
    });

    const result = await overlay.resolve(42, markdown);

    assert.deepEqual(result.matched, [{
        ...annotation,
        matchKind: 'exact',
        ranges: [{ from: 5, to: 11 }],
    }]);
    assert.deepEqual(result.unmatched, []);
});

test('maps PDF text ending in a trademark to complete MinerU markup', async () => {
    const annotation = {
        id: 'MARK0006',
        type: 'highlight',
        text: 'BOSE®',
        comment: '',
        color: '#ffd400',
        pageLabel: '4',
        pageIndex: 3,
        sortIndex: '00011',
    };
    const markdown = 'BOSE $^{®}$ headphones';
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
    });

    const result = await overlay.resolve(42, markdown);

    assert.deepEqual(result.matched, [{
        ...annotation,
        matchKind: 'normalized',
        ranges: [{ from: 0, to: 11 }],
    }]);
    assert.deepEqual(result.unmatched, []);
});

test('does not treat ordinary superscript math as a trademark symbol', async () => {
    const annotation = {
        id: 'MARK0002',
        type: 'highlight',
        text: 'BOSE®',
        comment: '',
        color: '#ffd400',
        pageLabel: '4',
        pageIndex: 3,
        sortIndex: '00010',
    };
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
    });

    const result = await overlay.resolve(42, 'BOSE $^{R}$');

    assert.deepEqual(result.matched, []);
    assert.deepEqual(result.unmatched, [{
        ...annotation,
        reason: 'not-found',
    }]);
});

test('still hides actual numeric Markdown link destinations', async () => {
    const annotation = {
        id: 'LINK0001',
        type: 'highlight',
        text: 'https://hidden.example',
        comment: '',
        color: '#ffd400',
        pageLabel: '4',
        pageIndex: 3,
        sortIndex: '00011',
    };
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
    });

    const result = await overlay.resolve(
        42,
        '[30](https://hidden.example)'
    );

    assert.deepEqual(result.matched, []);
    assert.deepEqual(result.unmatched, [{
        ...annotation,
        reason: 'not-found',
    }]);
});

test('ignores repeated MinerU whitespace before citation punctuation', async () => {
    const annotation = {
        id: 'CITE0002',
        type: 'highlight',
        text: 'lowering cortisol [26, 27], significantly.',
        comment: '',
        color: '#ffd400',
        pageLabel: '2',
        pageIndex: 1,
        sortIndex: '00005',
    };
    const markdown = 'lowering cortisol $[26, 27]$   , significantly.';
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
    });

    const result = await overlay.resolve(42, markdown);

    assert.deepEqual(result.matched, [{
        ...annotation,
        matchKind: 'normalized',
        ranges: [{ from: 0, to: markdown.length }],
    }]);
    assert.deepEqual(result.unmatched, []);
});

test('does not guess when PDF quote normalization leaves repeated matches', async () => {
    const annotation = {
        id: 'QUOTE002',
        type: 'highlight',
        text: 'participant’s response',
        comment: '',
        color: '#ffd400',
        pageLabel: '2',
        pageIndex: 1,
        sortIndex: '00005',
    };
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
    });

    const result = await overlay.resolve(
        42,
        "participant's response and participant's response"
    );

    assert.deepEqual(result.matched, []);
    assert.deepEqual(result.unmatched, [{
        ...annotation,
        reason: 'ambiguous',
    }]);
});

test('does not treat ordinary numeric math as a PDF citation', async () => {
    const annotation = {
        id: 'MATH0001',
        type: 'highlight',
        text: '[20]',
        comment: '',
        color: '#ffd400',
        pageLabel: '2',
        pageIndex: 1,
        sortIndex: '00006',
    };
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
    });

    const result = await overlay.resolve(42, 'The measured value was $20$.');

    assert.deepEqual(result.matched, []);
    assert.deepEqual(result.unmatched, [{
        ...annotation,
        reason: 'not-found',
    }]);
});

test('handles oversized malformed citation markup without guessing', async () => {
    const annotation = {
        id: 'LIMIT002',
        type: 'highlight',
        text: '[20]',
        comment: '',
        color: '#ffd400',
        pageLabel: '2',
        pageIndex: 1,
        sortIndex: '00007',
    };
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
    });
    const markdown = '$[' + '20,'.repeat(100_000);

    const result = await overlay.resolve(42, markdown);

    assert.deepEqual(result.matched, []);
    assert.deepEqual(result.unmatched, [{
        ...annotation,
        reason: 'not-found',
    }]);
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

test('matches visible bare and autolink URLs but hides link destinations', async () => {
    const annotations = [
        {
            id: 'BARE0001',
            type: 'highlight',
            text: 'https://visible.example',
            comment: '',
            color: '#ffd400',
            pageLabel: '1',
            pageIndex: 0,
            sortIndex: '00001',
        },
        {
            id: 'AUTO0001',
            type: 'underline',
            text: 'https://auto.example',
            comment: '',
            color: '#2ea8e5',
            pageLabel: '1',
            pageIndex: 0,
            sortIndex: '00002',
        },
        {
            id: 'HIDDEN01',
            type: 'highlight',
            text: 'https://hidden.example',
            comment: '',
            color: '#ff6666',
            pageLabel: '1',
            pageIndex: 0,
            sortIndex: '00003',
        },
    ];
    const markdown = [
        'Bare https://visible.example',
        '',
        'Auto <https://auto.example>',
        '',
        'Inline [label](https://hidden.example)',
        '',
        '[label][ref]',
        '',
        '[ref]: https://hidden.example',
    ].join('\n');
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => annotations },
    });

    const result = await overlay.resolve(42, markdown);

    assert.deepEqual(
        result.matched.map(annotation => ({
            id: annotation.id,
            text: markdown.slice(
                annotation.ranges[0].from,
                annotation.ranges[0].to
            ),
        })),
        [
            { id: 'BARE0001', text: 'https://visible.example' },
            { id: 'AUTO0001', text: 'https://auto.example' },
        ]
    );
    assert.deepEqual(result.unmatched, [{
        ...annotations[2],
        reason: 'not-found',
    }]);
});

test('does not guess after the occurrence candidate budget is exhausted', async () => {
    const before = 'x '.repeat(9_999);
    const markdown = `${before}anchor x x`;
    const annotations = [
        {
            id: 'ANCHOR02',
            type: 'highlight',
            text: 'anchor',
            comment: '',
            color: '#ffd400',
            pageLabel: '1',
            pageIndex: 0,
            sortIndex: '00001',
        },
        {
            id: 'REPEAT03',
            type: 'highlight',
            text: 'x',
            comment: '',
            color: '#ffd400',
            pageLabel: '1',
            pageIndex: 0,
            sortIndex: '00002',
        },
    ];
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => annotations },
    });

    const result = await overlay.resolve(42, markdown);

    assert.deepEqual(result.matched.map(annotation => annotation.id), [
        'ANCHOR02',
    ]);
    assert.equal(result.unmatched[0].id, 'REPEAT03');
    assert.equal(result.unmatched[0].reason, 'ambiguous');
});

test('fails annotation matching softly above the Markdown size budget', async () => {
    const overlay = new MarkdownAnnotationOverlay({
        extractor: {
            extract: async () => [{
                id: 'LIMIT001',
                type: 'highlight',
                text: 'result',
                comment: '',
                color: '#ffd400',
                pageLabel: '1',
                pageIndex: 0,
                sortIndex: '00001',
            }],
        },
    });

    const result = await overlay.resolve(42, 'x'.repeat(8 * 1024 * 1024 + 1));

    assert.deepEqual(result.matched, []);
    assert.deepEqual(result.unmatched, []);
    assert.equal(
        result.warning,
        'Zotero PDF annotations could not be loaded.'
    );
});
