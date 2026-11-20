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

test('matches PDF highlights across Markdown escapes and inline math', async () => {
    const degreeSource = 'Results: A difference of $0.30\\;^{\\circ}C$.';
    const firstSource = 'Finding minimums (MIN) using AVG\\_MCL.';
    const secondSource = 'The algorithm HALF\\_LOCS predicted ovulation.';
    const markdown = [degreeSource, firstSource, secondSource].join('\n\n');
    const annotations = [
        {
            id: 'MATH0001',
            type: 'highlight',
            text: 'Results: A difference of 0.30\\;^{\\circ}C.',
            comment: '',
            color: '#ffd400',
            pageLabel: '1',
            pageIndex: 0,
            sortIndex: '00001',
        },
        {
            id: 'ESCAPE01',
            type: 'highlight',
            text: 'Finding minimums  (MIN) using AVG_MCL.',
            comment: '',
            color: '#ffd400',
            pageLabel: '4',
            pageIndex: 3,
            sortIndex: '00001',
        },
        {
            id: 'ESCAPE02',
            type: 'highlight',
            text: 'The algorithm HALF_LOCS predicted ovulation.',
            comment: '',
            color: '#ffd400',
            pageLabel: '4',
            pageIndex: 3,
            sortIndex: '00002',
        },
    ];
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => annotations },
    });

    const result = await overlay.resolve(42, markdown);

    assert.deepEqual(
        result.matched.map(annotation => ({
            id: annotation.id,
            matchKind: annotation.matchKind,
            source: markdown.slice(
                annotation.ranges[0].from,
                annotation.ranges[0].to
            ),
        })),
        [
            {
                id: 'MATH0001',
                matchKind: 'exact',
                source: degreeSource,
            },
            {
                id: 'ESCAPE01',
                matchKind: 'normalized',
                source: firstSource,
            },
            {
                id: 'ESCAPE02',
                matchKind: 'exact',
                source: secondSource,
            },
        ]
    );
    assert.deepEqual(result.unmatched, []);
});

test('uses PDF page mappings to disambiguate repeated annotation text', async () => {
    const target = 'basal body temperature';
    const body = `The study measured ${target} during the cycle.`;
    const repeated = `Reference: ${target} time series.`;
    const markdown = [body, '', repeated].join('\n');
    const annotations = [{
        id: 'BBT0001',
        type: 'highlight',
        text: target,
        comment: '基础体温',
        color: '#ffd400',
        pageLabel: '1',
        pageIndex: 0,
        sortIndex: '00001',
    }];
    const targetFrom = markdown.indexOf(target);
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => annotations },
    });

    const result = await overlay.resolve(42, markdown, {
        sourceMap: [
            {
                type: 'text',
                markdownFrom: 0,
                markdownTo: body.length,
                locations: [{
                    pageIndex: 0,
                    bbox: [100, 100, 900, 220],
                }],
            },
            {
                type: 'text',
                markdownFrom: body.length + 2,
                markdownTo: markdown.length,
                locations: [{
                    pageIndex: 8,
                    bbox: [100, 100, 900, 220],
                }],
            },
        ],
    });

    assert.deepEqual(result.matched, [{
        ...annotations[0],
        matchKind: 'exact',
        ranges: [{ from: targetFrom, to: targetFrom + target.length }],
    }]);
    assert.deepEqual(result.unmatched, []);
});

test('uses PDF text context to disambiguate repeated text on one page', async () => {
    const target = 'repeated result';
    const first = `First finding before ${target} and first finding after.`;
    const second = `Summary before ${target} and summary after.`;
    const markdown = [first, '', second].join('\n');
    const annotation = {
        id: 'CONTEXT1',
        type: 'highlight',
        text: target,
        comment: '',
        color: '#ffd400',
        pageLabel: '1',
        pageIndex: 0,
        sortIndex: '00000|000120|00042',
    };
    const requested = [];
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
        locateTextQuote: async (itemID, value) => {
            requested.push({ itemID, value });
            return {
                prefix: 'First finding before ',
                suffix: ' and first finding after.',
            };
        },
    });

    const result = await overlay.resolve(42, markdown, {
        sourceMap: [{
            type: 'text',
            markdownFrom: 0,
            markdownTo: markdown.length,
            locations: [{
                pageIndex: 0,
                bbox: [80, 100, 920, 200],
            }],
        }],
    });

    assert.deepEqual(requested, [{ itemID: 42, value: annotation }]);
    assert.deepEqual(result.matched, [{
        ...annotation,
        matchKind: 'exact',
        ranges: [{
            from: first.indexOf(target),
            to: first.indexOf(target) + target.length,
        }],
    }]);
    assert.deepEqual(result.unmatched, []);
});

test('uses the unique following context when a PDF page header precedes a highlight', async () => {
    const target = 'Phase 4: the final product.';
    const summary = `<table><tr><td>${target} Identify a precise question.</td></tr></table>`;
    const body = `${target} Finally, you can ask yourself which option to choose.`;
    const markdown = `${summary}\n\n${body}`;
    const annotation = {
        id: 'PAGEHEAD',
        type: 'highlight',
        text: target,
        pageIndex: 1,
        sortIndex: '00001|000076|00360',
    };
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
        locateTextQuote: async () => ({
            prefix: 'Journal running header | Page 2 | Comment ',
            suffix: ' Finally, you can ask yourself which option to choose.',
        }),
    });

    const result = await overlay.resolve(42, markdown, {
        sourceMap: [{
            type: 'text',
            markdownFrom: 0,
            markdownTo: markdown.length,
            locations: [{ pageIndex: 1, bbox: [0, 0, 1000, 1000] }],
        }],
    });
    const from = markdown.lastIndexOf(target);

    assert.deepEqual(result.unmatched, []);
    assert.deepEqual(result.matched[0].ranges, [{
        from,
        to: from + target.length,
    }]);
});

test('uses the unique preceding context when the following PDF text changes reading order', async () => {
    const target = 'repeated result';
    const first = `Earlier summary before ${target} and summary after.`;
    const second = `Study findings before ${target} and body after.`;
    const markdown = `${first}\n\n${second}`;
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [{ id: 'ORDER001', text: target }] },
        locateTextQuote: async () => ({
            prefix: 'Study findings before ',
            suffix: ' A floating caption follows in PDF text order.',
        }),
    });

    const result = await overlay.resolve(42, markdown);
    const from = markdown.lastIndexOf(target);

    assert.deepEqual(result.unmatched, []);
    assert.deepEqual(result.matched[0].ranges, [{
        from,
        to: from + target.length,
    }]);
});

test('does not choose between conflicting preceding and following PDF contexts', async () => {
    const target = 'repeated result';
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [{ id: 'CONFLICT', text: target }] },
        locateTextQuote: async () => ({
            prefix: 'First finding before ',
            suffix: ' and second finding after.',
        }),
    });
    const result = await overlay.resolve(42, [
        `First finding before ${target} and first finding after.`,
        '',
        `Second finding before ${target} and second finding after.`,
    ].join('\n'));

    assert.deepEqual(result.matched, []);
    assert.equal(result.unmatched[0].reason, 'ambiguous');
});

test('does not choose when the only matching side of the PDF context is repeated', async () => {
    const target = 'repeated result';
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [{ id: 'ONESIDE1', text: target }] },
        locateTextQuote: async () => ({
            prefix: 'Journal running header | Page 2 ',
            suffix: ' and the same conclusion.',
        }),
    });
    const result = await overlay.resolve(42, [
        `First finding before ${target} and the same conclusion.`,
        '',
        `Second finding before ${target} and the same conclusion.`,
    ].join('\n'));

    assert.deepEqual(result.matched, []);
    assert.equal(result.unmatched[0].reason, 'ambiguous');
});

test('keeps single-side evidence ambiguous when hyphen folding reveals a conflicting side', async () => {
    const target = 'repeated result';
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [{ id: 'FOLDCON1', text: target }] },
        locateTextQuote: async () => ({
            prefix: 'A specific introduction ',
            suffix: ' and evidencebased conclusions.',
        }),
    });
    const result = await overlay.resolve(42, [
        `A specific introduction ${target} and a different ending.`,
        '',
        `A different introduction ${target} and evidence-based conclusions.`,
    ].join('\n'));

    assert.deepEqual(result.matched, []);
    assert.equal(result.unmatched[0].reason, 'ambiguous');
});

test('does not use short single-side context beside an unmatched page header', async () => {
    const target = 'repeated result';
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [{ id: 'SHORTCTX', text: target }] },
        locateTextQuote: async () => ({
            prefix: 'Journal running header | Page 2 ',
            suffix: ' End.',
        }),
    });
    const result = await overlay.resolve(42, `${target} End.\n\n${target} Other.`);

    assert.deepEqual(result.matched, []);
    assert.equal(result.unmatched[0].reason, 'ambiguous');
});

test('uses unique single-side PDF context after normalizing the annotation text', async () => {
    const target = "participant's response";
    const markdown = [
        `Summary ${target} in an earlier finding.`,
        '',
        `Study ${target} supported the final conclusion.`,
    ].join('\n');
    const overlay = new MarkdownAnnotationOverlay({
        extractor: {
            extract: async () => [{ id: 'NORMCTX1', text: 'participant’s response' }],
        },
        locateTextQuote: async () => ({
            prefix: 'Journal running header | Page 2 ',
            suffix: ' supported the final conclusion.',
        }),
    });

    const result = await overlay.resolve(42, markdown);
    const from = markdown.lastIndexOf(target);

    assert.deepEqual(result.unmatched, []);
    assert.equal(result.matched[0].matchKind, 'normalized');
    assert.deepEqual(result.matched[0].ranges, [{ from, to: from + target.length }]);
});

test('uses the unique shared candidate when each PDF context matches several places', async () => {
    const target = 'repeated result';
    const markdown = [
        `Shared introduction ${target} first conclusion.`,
        '',
        `Shared introduction ${target} shared conclusion.`,
        '',
        `Different introduction ${target} shared conclusion.`,
    ].join('\n');
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [{ id: 'BOTHCTX1', text: target }] },
        locateTextQuote: async () => ({
            prefix: 'Shared introduction ',
            suffix: ' shared conclusion.',
        }),
    });

    const result = await overlay.resolve(42, markdown);
    const from = markdown.indexOf(target, markdown.indexOf(target) + target.length);

    assert.deepEqual(result.unmatched, []);
    assert.deepEqual(result.matched[0].ranges, [{ from, to: from + target.length }]);
});

test('uses folded PDF hyphen context to disambiguate Markdown text', async () => {
    const target = 'repeated result';
    const first = `self-esteem context before ${target}.`;
    const second = `other context before ${target}.`;
    const markdown = [first, '', second].join('\n');
    const annotation = {
        id: 'CONTEXT6',
        type: 'highlight',
        text: target,
        comment: '',
        color: '#ffd400',
        pageLabel: '1',
        pageIndex: 0,
        sortIndex: '00000|000120|00042',
    };
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
        locateTextQuote: async () => ({
            prefix: 'selfesteem context before ',
            suffix: '.',
        }),
    });

    const result = await overlay.resolve(42, markdown);
    const targetFrom = first.indexOf(target);

    assert.deepEqual(result.matched, [{
        ...annotation,
        matchKind: 'exact',
        ranges: [{ from: targetFrom, to: targetFrom + target.length }],
    }]);
    assert.deepEqual(result.unmatched, []);
});

test('uses PDF text context after annotation text normalization', async () => {
    const target = "participant's response";
    const first = `Earlier evidence described the ${target} in detail.`;
    const second = `Study findings reported the ${target} as expected.`;
    const markdown = [first, '', second].join('\n');
    const annotation = {
        id: 'CONTEXT2',
        type: 'highlight',
        text: 'participant’s response',
        comment: '',
        color: '#ffd400',
        pageLabel: '1',
        pageIndex: 0,
        sortIndex: '00000|000220|00042',
    };
    const requested = [];
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
        locateTextQuote: async (itemID, value) => {
            requested.push({ itemID, value });
            return {
                prefix: 'Study findings reported the ',
                suffix: ' as expected.',
            };
        },
    });

    const result = await overlay.resolve(42, markdown);
    const targetFrom = markdown.indexOf(target, first.length);

    assert.deepEqual(requested, [{ itemID: 42, value: annotation }]);
    assert.deepEqual(result.matched, [{
        ...annotation,
        matchKind: 'normalized',
        ranges: [{ from: targetFrom, to: targetFrom + target.length }],
    }]);
    assert.deepEqual(result.unmatched, []);
});

test('uses the full normalized context when Markdown syntax compresses', async () => {
    const target = "participant's response";
    const latexContext = '\\mathrm{A}'.repeat(79);
    const firstPrefix = `X${latexContext}`;
    const secondPrefix = `Y${latexContext}`;
    const first = `${firstPrefix}${target} in the first finding.`;
    const second = `${secondPrefix}${target} in the second finding.`;
    const markdown = [first, '', second].join('\n');
    const annotation = {
        id: 'CONTEXT5',
        type: 'highlight',
        text: 'participant’s response',
        comment: '',
        color: '#ffd400',
        pageLabel: '1',
        pageIndex: 0,
        sortIndex: '00000|000520|00042',
    };
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
        locateTextQuote: async () => ({
            prefix: `X${'A'.repeat(79)}`,
            suffix: '',
        }),
    });

    const result = await overlay.resolve(42, markdown);

    assert.deepEqual(result.matched, [{
        ...annotation,
        matchKind: 'normalized',
        ranges: [{
            from: firstPrefix.length,
            to: firstPrefix.length + target.length,
        }],
    }]);
    assert.deepEqual(result.unmatched, []);
});

test('keeps repeated text ambiguous when PDF contexts are identical', async () => {
    const target = 'repeated result';
    const repeated = `Shared introduction ${target} shared conclusion.`;
    const annotation = {
        id: 'CONTEXT3',
        type: 'highlight',
        text: target,
        comment: '',
        color: '#ffd400',
        pageLabel: '1',
        pageIndex: 0,
        sortIndex: '00000|000320|00042',
    };
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
        locateTextQuote: async () => ({
            prefix: 'Shared introduction ',
            suffix: ' shared conclusion.',
        }),
    });

    const result = await overlay.resolve(
        42,
        [repeated, '', repeated].join('\n')
    );

    assert.deepEqual(result.matched, []);
    assert.deepEqual(result.unmatched, [{
        ...annotation,
        reason: 'ambiguous',
    }]);
});

test('keeps repeated text ambiguous when PDF context lookup fails', async () => {
    const failure = new Error('PDF index unavailable');
    const diagnostics = [];
    const annotation = {
        id: 'CONTEXT4',
        type: 'highlight',
        text: 'repeated result',
        comment: '',
        color: '#ffd400',
        pageLabel: '1',
        pageIndex: 0,
        sortIndex: '00000|000420|00042',
    };
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
        locateTextQuote: async () => { throw failure; },
        onError: error => diagnostics.push(error),
    });

    const result = await overlay.resolve(
        42,
        'repeated result. Later repeated result.'
    );

    assert.deepEqual(result.matched, []);
    assert.deepEqual(result.unmatched, [{
        ...annotation,
        reason: 'ambiguous',
    }]);
    assert.deepEqual(diagnostics, [failure]);
    assert.equal('warning' in result, false);
});

test('keeps repeated annotation text ambiguous when page mapping is incomplete', async () => {
    const target = 'basal body temperature';
    const markdown = [
        `The study measured ${target} during the cycle.`,
        '',
        `Reference: ${target} time series.`,
    ].join('\n');
    const annotation = {
        id: 'BBT0002',
        type: 'highlight',
        text: target,
        comment: '',
        color: '#ffd400',
        pageLabel: '1',
        pageIndex: 0,
        sortIndex: '00001',
    };
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
    });

    const result = await overlay.resolve(42, markdown, {
        sourceMap: [{
            type: 'text',
            markdownFrom: 0,
            markdownTo: markdown.indexOf('\n'),
            locations: [{
                pageIndex: 0,
                bbox: [100, 100, 900, 220],
            }],
        }],
    });

    assert.deepEqual(result.matched, []);
    assert.deepEqual(result.unmatched, [{
        ...annotation,
        reason: 'ambiguous',
    }]);
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

test('matches PDF citation ranges against MinerU superscript markup', async () => {
    const annotation = {
        id: 'CITE0004',
        type: 'highlight',
        text: [
            'According to several studies 11-14, the menstrual cycle length',
            'can be classified into two groups.',
        ].join(' '),
        comment: '',
        color: '#ffd400',
        pageLabel: '1',
        pageIndex: 0,
        sortIndex: '00016',
    };
    const markdown = [
        'According to several studies $^{11-14}$ , the menstrual cycle length',
        'can be classified into two groups.',
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

test('matches PDF citation digits against inline MinerU superscripts', async () => {
    const annotation = {
        id: 'CITE0005',
        type: 'highlight',
        text: 'According to these authors 16, state-space models are useful.',
        comment: '',
        color: '#ffd400',
        pageLabel: '1',
        pageIndex: 0,
        sortIndex: '00017',
    };
    const markdown = [
        'According to these authors $^{16}$ , state-space models are useful.',
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

test('preserves lexical line-end hyphens when reopening page-split PDF highlights', async () => {
    const secondText = 'The next page records the result.';
    const firstSource = 'The **multi-site** workflow uses a PLAN-CHECK cycle.';
    const markdown = `Intro\n\n${firstSource} ${secondText}`;
    const annotations = [{
        id: 'WRAPPED1', type: 'highlight',
        text: 'The multi-\nsite workflow uses a PLAN-\nCHECK cycle.',
        comment: 'Keep this comment', color: '#ffd400',
        pageIndex: 0, pageLabel: '1', sortIndex: '00000',
    }, {
        id: 'WRAPPED2', type: 'highlight', text: secondText,
        comment: '', color: '#ffd400',
        pageIndex: 1, pageLabel: '2', sortIndex: '00001',
    }];
    const saved = structuredClone(annotations);
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => annotations },
    });

    const result = await overlay.resolve(42, markdown);

    assert.deepEqual(result.unmatched, []);
    assert.deepEqual(result.matched.map(annotation => ({
        id: annotation.id, kind: annotation.matchKind,
        source: markdown.slice(annotation.ranges[0].from, annotation.ranges[0].to),
    })), [
        { id: 'WRAPPED1', kind: 'normalized', source: firstSource },
        { id: 'WRAPPED2', kind: 'exact', source: secondText },
    ]);
    assert.deepEqual(annotations, saved);
});

test('maps retained line-end hyphens through Markdown source offsets in either direction', async () => {
    for (const [source, text] of [
        ['A **multi-site** protocol.', 'A multi- site protocol.'],
        ['A **multi-\nsite** protocol.', 'A multi-site protocol.'],
        ['A 🧪 **𐐀-𐐁** protocol.', 'A 🧪 𐐀-\n𐐁 protocol.'],
    ]) {
        const markdown = `A different introduction.\n\n${source}\n\nUnselected ending.`;
        const annotation = { id: 'HYPHEN03', text, pageIndex: 0 };
        const overlay = new MarkdownAnnotationOverlay({
            extractor: { extract: async () => [annotation] },
        });

        const result = await overlay.resolve(42, markdown);

        assert.deepEqual(result.unmatched, []);
        assert.equal(result.matched.length, 1);
        assert.deepEqual(result.matched[0].ranges, [{
            from: markdown.indexOf(source), to: markdown.indexOf(source) + source.length,
        }]);
        assert.equal(result.matched[0].text, text);
    }
});

test('keeps repeated retained-hyphen matches ambiguous without independent context', async () => {
    const annotation = { id: 'HYPHEN04', text: 'A multi- site protocol.', pageIndex: 0 };
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
    });

    const result = await overlay.resolve(42, 'A multi-site protocol.\n\nA multi-site protocol.');

    assert.deepEqual(result.matched, []);
    assert.deepEqual(result.unmatched, [{ ...annotation, reason: 'ambiguous' }]);
});

test('uses page evidence for repeated retained-hyphen matches', async () => {
    const text = 'A multi-site protocol.';
    const markdown = `${text}\n\n${text}`;
    const annotation = { id: 'HYPHEN05', text: 'A multi- site protocol.', pageIndex: 1 };
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
    });
    const sourceMap = [{
        type: 'text', markdownFrom: 0, markdownTo: text.length,
        locations: [{ pageIndex: 0, bbox: [100, 100, 900, 220] }],
    }, {
        type: 'text', markdownFrom: text.length + 2, markdownTo: markdown.length,
        locations: [{ pageIndex: 1, bbox: [100, 100, 900, 220] }],
    }];

    const result = await overlay.resolve(42, markdown, { sourceMap });

    assert.deepEqual(result.unmatched, []);
    assert.deepEqual(result.matched[0].ranges, [{ from: text.length + 2, to: markdown.length }]);
});

test('retained-hyphen matching does not remove ordinary word boundaries or lexical hyphens', async () => {
    for (const [text, markdown] of [
        ['A two- site method.', 'A two-sitemethod.'],
        ['A multisite method.', 'A multi-site method.'],
        ['The range is 10-\n20.', 'The range is 1020.'],
    ]) {
        const annotation = { id: 'HYPHEN06', text, pageIndex: 0 };
        const overlay = new MarkdownAnnotationOverlay({
            extractor: { extract: async () => [annotation] },
        });

        const result = await overlay.resolve(42, markdown);

        assert.deepEqual(result.matched, []);
        assert.deepEqual(result.unmatched, [{ ...annotation, reason: 'not-found' }]);
    }
});

test('keeps an existing exact match ahead of retained-hyphen fallbacks', async () => {
    const text = 'A multi- site protocol.';
    const markdown = `${text}\n\nA multi-site protocol.`;
    const annotation = { id: 'HYPHEN07', text, pageIndex: 0 };
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
    });

    const result = await overlay.resolve(42, markdown);

    assert.deepEqual(result.unmatched, []);
    assert.equal(result.matched[0].matchKind, 'exact');
    assert.deepEqual(result.matched[0].ranges, [{ from: 0, to: text.length }]);
});

test('matches mixed discretionary and retained line-end hyphens without folding lexical hyphens', async () => {
    const source = 'The multi-site method records actions and preserves the re-sign step.';
    const markdown = `Before.\n\n${source}\n\nAfter.`;
    const annotation = {
        id: 'HYPHEN08', pageIndex: 0,
        text: 'The multi-\nsite method records ac-\ntions and preserves the re-sign step.',
    };
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
    });

    const result = await overlay.resolve(42, markdown);

    assert.deepEqual(result.unmatched, []);
    assert.deepEqual(result.matched[0].ranges, [{
        from: markdown.indexOf(source), to: markdown.indexOf(source) + source.length,
    }]);
});

test('rejects conflicting retained and removed interpretations of a line-end hyphen', async () => {
    const annotation = { id: 'HYPHEN09', text: 'A re-\nsign step.', pageIndex: 0 };
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
    });

    const result = await overlay.resolve(42, 'A re-sign step.\n\nA resign step.');

    assert.deepEqual(result.matched, []);
    assert.deepEqual(result.unmatched, [{ ...annotation, reason: 'ambiguous' }]);
});

test('uses full PDF text context to resolve retained-hyphen candidates and refuses conflicting sides', async () => {
    const target = 'A multi-site protocol';
    const firstPrefix = 'Before the first finding: ';
    const firstSuffix = ' completes the first finding.';
    const secondSuffix = ' completes the later summary.';
    const markdown = `${firstPrefix}${target}${firstSuffix}\n\nBefore the later summary: ${target}${secondSuffix}`;
    const annotation = { id: 'HYPHEN10', text: 'A multi-\nsite protocol', pageIndex: 0 };
    for (const suffix of [firstSuffix, secondSuffix]) {
        let calls = 0;
        const overlay = new MarkdownAnnotationOverlay({
            extractor: { extract: async () => [annotation] },
            locateTextQuote: async () => {
                calls++;
                return { prefix: firstPrefix, suffix };
            },
        });

        const result = await overlay.resolve(42, markdown);

        assert.equal(calls, 1);
        if (suffix === firstSuffix) {
            assert.deepEqual(result.unmatched, []);
            assert.deepEqual(result.matched[0].ranges, [{
                from: firstPrefix.length, to: firstPrefix.length + target.length,
            }]);
        }
        else {
            assert.deepEqual(result.matched, []);
            assert.deepEqual(result.unmatched, [{ ...annotation, reason: 'ambiguous' }]);
        }
    }
});

test('refuses line-wrap matching when candidate or verification work exceeds its budget', async () => {
    for (const [text, markdown] of [
        ['A multi- site protocol.', 'A multi-site protocol.\n\n'.repeat(10_001)],
        [`${'a'.repeat(1_024)}- a`, 'a'.repeat(10_000)],
    ]) {
        const annotation = { id: 'HYPHEN11', text, pageIndex: 0 };
        const overlay = new MarkdownAnnotationOverlay({
            extractor: { extract: async () => [annotation] },
        });

        const result = await overlay.resolve(42, markdown);

        assert.deepEqual(result.matched, []);
        assert.deepEqual(result.unmatched, [{ ...annotation, reason: 'ambiguous' }]);
    }
});

test('matches PDF highlights split by a line-end hyphen', async () => {
    const markdown = [
        'Current LLM agent runtimes execute procedural skills by repeatedly',
        ' appending reasoning traces, actions, observations, and tool outputs',
        ' to a growing conversational history. Consequently, the execution',
        ' state is represented implicitly within natural language and must be',
        ' reconstructed by the language model at every interaction.',
    ].join('');
    const annotations = [{
        id: 'HYPHEN01',
        type: 'highlight',
        text: 'Current LLM agent runtimes execute procedural skills by repeatedly appending reasoning traces, ac- tions, observations, and tool outputs to a growing conversational history.',
        comment: '',
        color: '#ff6666',
        pageLabel: '2',
        pageIndex: 1,
        sortIndex: '00002',
    }, {
        id: 'HYPHEN02',
        type: 'highlight',
        text: 'state is represented implicitly within natural lan- guage and must be reconstructed by the language model at every interaction.',
        comment: '',
        color: '#ff6666',
        pageLabel: '3',
        pageIndex: 2,
        sortIndex: '00003',
    }];
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => annotations },
    });

    const result = await overlay.resolve(42, markdown);
    const first = annotations[0].text.replace('ac- tions', 'actions');
    const second = annotations[1].text.replace('lan- guage', 'language');

    assert.deepEqual(result.unmatched, []);
    assert.equal(result.matched[0].id, 'HYPHEN01');
    assert.equal(markdown.slice(
        result.matched[0].ranges[0].from,
        result.matched[0].ranges[0].to
    ), first);
    assert.equal(result.matched[1].id, 'HYPHEN02');
    assert.equal(markdown.slice(
        result.matched[1].ranges[0].from,
        result.matched[1].ranges[0].to
    ), second);
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

test('matches PDF highlights containing statistical confidence intervals', async () => {
    const markdownHighlights = [
        [
            'The meta-analysis revealed that AI-based CAs significantly reduce',
            "symptoms of depression (Hedge's g 0.64 [95% CI 0.17–1.12]) and",
            "distress (Hedge's g 0.7 [95% CI 0.18–1.22]).",
        ].join(' '),
        [
            'However, CA-based interventions showed no significant improvement',
            "in overall psychological well-being (Hedge's g 0.32",
            '[95% CI –0.13 to 0.78]).',
        ].join(' '),
    ];
    const annotations = [
        {
            id: 'N67BW385',
            type: 'highlight',
            text: markdownHighlights[0].replaceAll("Hedge's", 'Hedge’s'),
            comment: '',
            color: '#ffd400',
            pageLabel: '1',
            pageIndex: 0,
            sortIndex: '00001',
        },
        {
            id: 'GWTLAXP3',
            type: 'highlight',
            text: markdownHighlights[1].replaceAll("Hedge's", 'Hedge’s'),
            comment: '',
            color: '#ffd400',
            pageLabel: '1',
            pageIndex: 0,
            sortIndex: '00002',
        },
    ];
    const markdown = markdownHighlights.join(' ');
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => annotations },
    });

    const result = await overlay.resolve(42, markdown);

    assert.deepEqual(
        result.matched.map(annotation => ({
            id: annotation.id,
            matchKind: annotation.matchKind,
            source: markdown.slice(
                annotation.ranges[0].from,
                annotation.ranges[0].to
            ),
        })),
        markdownHighlights.map((source, index) => ({
            id: annotations[index].id,
            matchKind: 'normalized',
            source,
        }))
    );
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

// An image description doubles a formula's backslash. A caption highlight
// saved before the reader undid that reads "\\Delta"; one saved after reads
// "\Delta". Both land on the same caption text.
test('matches a caption highlight saved with or without the doubled backslash', async () => {
    const markdown = 'Intro.\n\n![Figure 4: Heatmaps report the corresponding '
        + '$\\\\Delta$ in points.)](generated/figures/f.png)\n';
    const from = markdown.indexOf('Heatmaps');
    const to = markdown.indexOf('](generated');
    for (const text of [
        'Heatmaps report the corresponding \\\\Delta in points.)',
        'Heatmaps report the corresponding \\Delta in points.)',
    ]) {
        const overlay = new MarkdownAnnotationOverlay({
            extractor: {
                extract: async () => [{
                    id: 'CAPTION1',
                    type: 'highlight',
                    text,
                    comment: '',
                    color: '#ffd400',
                    pageLabel: '8',
                    pageIndex: 7,
                    sortIndex: '00007',
                }],
            },
        });

        const result = await overlay.resolve(42, markdown);

        assert.equal(result.unmatched.length, 0, text);
        assert.equal(result.matched[0].text, text);
        assert.deepEqual(result.matched[0].ranges, [{ from, to }], text);
    }
});

test('does not move an old caption highlight onto the same text elsewhere', async () => {
    const markdown = 'See code `\\\\Delta` here.\n\n![Figure 1: $\\\\Delta$](a.png)\n';
    const overlay = new MarkdownAnnotationOverlay({
        extractor: {
            extract: async () => [{
                id: 'CAPTION2',
                type: 'highlight',
                text: '\\\\Delta',
                comment: '',
                color: '#ffd400',
                pageLabel: '1',
                pageIndex: 0,
                sortIndex: '00001',
            }],
        },
    });

    const result = await overlay.resolve(42, markdown);

    assert.deepEqual(result.matched, []);
    assert.equal(result.unmatched[0].reason, 'ambiguous');
});

test('matches a Zotero highlight whose text layer misencodes a big operator', async () => {
    // Zotero copies the PDF text layer, where this font maps \bigcup to "Ð".
    const annotation = {
        id: 'BIGCUP01',
        type: 'highlight',
        text: 'Ð\n𝑣∈𝐶𝑚,𝑘\n𝑖\nChild(𝑣; T𝑖, T 𝑚,𝑘\n𝑖 ) where nodes',
        comment: '',
        color: '#ffd400',
        pageLabel: '6',
        pageIndex: 5,
        sortIndex: '00005',
    };
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
    });
    const formula = '$\\bigcup_{\\nu\\in C_{i}^{m,k}}\\text{Child}(\\nu;\\mathcal{T}_{i},\\mathcal{T}_{i}^{m,k})$';
    const markdown = `Tree is ${formula} where nodes appear.`;

    const result = await overlay.resolve(1, markdown);

    assert.equal(result.unmatched.length, 0);
    const [range] = result.matched[0].ranges;
    assert.equal(
        markdown.slice(range.from, result.matched[0].ranges.at(-1).to),
        `${formula} where nodes`
    );
});
