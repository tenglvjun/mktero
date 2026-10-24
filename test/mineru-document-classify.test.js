import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyBlocks, chromeKey } from '../src/mineru/document/classify.js';
import { DOCUMENT_IR_SCHEMA } from '../src/mineru/document/ir.js';
import { markReferenceSections } from '../src/mineru/document/reading-order.js';

let counter = 0;

function text(pageIndex, bbox, content, extra = {}) {
    return {
        id: `b${counter++}`,
        kind: extra.kind || 'text',
        mineruType: extra.mineruType || extra.kind || 'text',
        role: extra.role || 'body',
        pageIndex,
        bbox,
        fragments: [{ pageIndex, bbox, lines: [{ bbox, spans: [{ type: 'text', content }] }] }],
        children: [],
        mergedFrom: [],
        absorbed: [],
        ...extra,
    };
}

function figure(pageIndex, bodyBox) {
    return {
        id: `b${counter++}`, kind: 'image', mineruType: 'image', role: 'float', pageIndex, bbox: bodyBox,
        fragments: [{ pageIndex, bbox: bodyBox, lines: [] }],
        children: [{ id: 'x:body0', kind: 'body', pageIndex, bbox: bodyBox, assetPath: 'images/a.jpg' }],
        mergedFrom: [], absorbed: [],
    };
}

function classify(blocks, pages = 6) {
    return classifyBlocks({
        schema: DOCUMENT_IR_SCHEMA,
        pages: Array.from({ length: pages }, (_, pageIndex) => ({ pageIndex })),
        blocks,
        diagnostics: { chromeFallbacks: [] },
    });
}

const roles = ir => ir.blocks.map(block => block.role);

test('keeps MinerU discarded blocks as chrome or page notes', () => {
    const ir = classify([
        text(0, [100, 10, 900, 30], 'Running head', { kind: 'discarded', mineruType: 'header' }),
        text(0, [100, 950, 900, 980], '1 A note.', { kind: 'discarded', mineruType: 'page_footnote' }),
    ]);
    assert.deepEqual(roles(ir), ['chrome', 'page-note']);
});

test('hides an edge body block that matches a discarded header elsewhere', () => {
    const ir = classify([
        text(0, [66, 50, 434, 68], 'JOURNAL OF MEDICAL INTERNET RESEARCH', { kind: 'discarded', mineruType: 'header' }),
        text(3, [66, 52, 434, 67], 'JOURNAL OF MEDICAL INTERNET RESEARCH'),
        text(3, [66, 400, 900, 500], 'The Journal of Medical Internet Research reported this result.'),
    ]);
    assert.deepEqual(roles(ir), ['chrome', 'chrome', 'body']);
    assert.equal(ir.diagnostics.chromeFallbacks[0].rule, 'edge-matches-discarded');
});

test('hides edge text repeated across pages but not repeated body text away from the edge', () => {
    const stamp = page => text(page, [88, 2, 900, 37], `bioRxiv preprint doi: 10.1/${page}; posted May ${page}, 2026.`);
    const ir = classify([
        stamp(1), stamp(4), stamp(6),
        text(2, [100, 400, 900, 450], 'Repeated sentence in the body.'),
        text(3, [100, 400, 900, 450], 'Repeated sentence in the body.'),
        text(4, [100, 400, 900, 450], 'Repeated sentence in the body.'),
    ], 24);
    assert.deepEqual(roles(ir), ['chrome', 'chrome', 'chrome', 'body', 'body', 'body']);
});

test('keeps edge text that appears on a single page', () => {
    const ir = classify([
        text(5, [100, 20, 900, 60], 'A heading-like line at the top of one page'),
        text(5, [100, 930, 900, 980], 'The last paragraph of a page ends near the bottom margin.'),
    ]);
    assert.deepEqual(roles(ir), ['body', 'body']);
});

test('hides page numbers and publisher notices only at the edge or on the first page', () => {
    const ir = classify([
        text(2, [480, 960, 520, 980], '12'),
        text(2, [100, 500, 900, 520], '12'),
        text(0, [100, 600, 400, 640], '© 2024 The Author(s). Published by Elsevier Ltd.'),
        text(3, [100, 600, 400, 640], '© 2024 The Author(s). Published by Elsevier Ltd.'),
        text(0, [600, 100, 900, 120], 'https://doi.org/10.1038/s41746-025-02320-8'),
    ]);
    assert.deepEqual(roles(ir), ['chrome', 'body', 'chrome', 'body', 'body']);
});

test('treats short text inside an image as part of the picture', () => {
    const ir = classify([
        figure(2, [100, 100, 900, 600]),
        text(2, [150, 120, 200, 140], '(A)'),
        text(2, [150, 300, 800, 340], 'A long sentence that happens to sit inside the image box and must stay.'),
        text(2, [150, 200, 600, 220], 'Mode 4: A Titled Box', { kind: 'title' }),
        text(2, [100, 650, 900, 700], 'Body text below the figure.'),
    ]);
    assert.deepEqual(roles(ir), ['float', 'float-note', 'body', 'heading', 'body']);
    assert.equal(ir.blocks[1].floatInteriorOf, ir.blocks[0].id);
});

test('marks reference entries after a references heading until the next heading', () => {
    const ir = markReferenceSections(classify([
        text(5, [100, 100, 900, 120], 'REFERENCES', { kind: 'title' }),
        text(5, [100, 130, 900, 160], '[1] A. Author, A title, 2020.'),
        text(5, [100, 170, 900, 200], '[2] B. Author, Another, 2021.', { kind: 'reference', mineruType: 'ref_text' }),
        text(5, [100, 300, 900, 320], 'Appendix A', { kind: 'title' }),
        text(5, [100, 330, 900, 360], 'Appendix body.'),
    ]));
    assert.deepEqual(roles(ir), ['heading', 'reference', 'reference', 'heading', 'body']);
    assert.equal(ir.blocks[0].referenceHeading, true);
});

test('normalizes chrome keys across numbers and punctuation', () => {
    assert.equal(chromeKey('J Med Internet Res 2021 | vol. 23 | p. 4'), chromeKey('J Med Internet Res 2021 | vol. 23 | p. 11'));
    assert.notEqual(chromeKey('Article'), chromeKey('Articles'));
});

test('hides a running footer that sits above the edge band at its usual height', () => {
    const footer = 'Physiol Rev. Author manuscript; available in PMC 2026 February 08.';
    const ir = classify([
        text(1, [268, 899, 640, 914], footer, { kind: 'discarded', mineruType: 'footer' }),
        text(2, [268, 899, 640, 915], footer),
        text(3, [268, 500, 640, 515], footer),
    ]);
    assert.deepEqual(roles(ir), ['chrome', 'chrome', 'body']);
    assert.equal(ir.diagnostics.chromeFallbacks[0].rule, 'matches-discarded-position');
});

test('drops a running footer that MinerU attached to a float as its footnote', () => {
    const table = {
        id: `b${counter++}`, kind: 'table', mineruType: 'table', role: 'float', pageIndex: 2, bbox: [100, 100, 900, 900],
        fragments: [{ pageIndex: 2, bbox: [100, 100, 900, 900], lines: [] }],
        children: [
            { id: 't:body0', kind: 'body', pageIndex: 2, bbox: [100, 100, 900, 880], html: '<table></table>' },
            { id: 't:footnote0', kind: 'footnote', pageIndex: 2, bbox: [100, 880, 900, 900],
                fragments: [{ pageIndex: 2, bbox: [100, 880, 900, 900], lines: [{ spans: [{ type: 'text', content: 'Eur Heart J, Vol. 17, March 1996' }] }] }] },
            { id: 't:footnote1', kind: 'footnote', pageIndex: 2, bbox: [100, 860, 900, 880],
                fragments: [{ pageIndex: 2, bbox: [100, 860, 900, 880], lines: [{ spans: [{ type: 'text', content: 'Values are means.' }] }] }] },
        ],
        mergedFrom: [], absorbed: [],
    };
    const ir = classify([text(1, [120, 918, 330, 932], 'Eur Heart J. Vol. 17, March 1996', { kind: 'discarded', mineruType: 'footer' }), table]);
    assert.equal(table.children[1].role, 'chrome');
    assert.equal(table.children[2].role, undefined);
    assert.equal(ir.diagnostics.chromeFallbacks[0].rule, 'float-footnote-matches-discarded');
});

test('keeps every text box of a flowchart once one of them is a sentence', () => {
    const ir = classify([
        figure(3, [130, 280, 860, 640]),
        text(3, [460, 480, 630, 495], '73 cycles excluded due to:'),
        text(3, [470, 495, 840, 520], '14 cycles without LH result and missing temperature measurements'),
        text(3, [150, 300, 170, 315], 'b'),
    ]);
    assert.deepEqual(roles(ir), ['float', 'body', 'body', 'float-note']);
});

test('hides a first-page permission, venue, copyright, and ISBN cluster', () => {
    const ir = classify([
        text(0, [82, 720, 480, 760], 'Permission to make digital or hard copies of part or all of this work for personal or classroom use is granted without fee.'),
        text(0, [82, 770, 480, 800], "UIST '23, October 29-November 1, 2023, San Francisco, CA, USA"),
        text(0, [82, 810, 480, 840], '© 2023 Copyright held by the owner/author(s).'),
        text(0, [82, 850, 480, 880], 'ACM ISBN 979-8-4007-0132-0/23/10.'),
        text(0, [82, 890, 480, 920], 'https://doi.org/10.1145/3586183.3606763'),
        text(0, [520, 100, 900, 120], 'https://doi.org/10.1145/3586183.3606764'),
    ]);
    assert.deepEqual(roles(ir), ['chrome', 'chrome', 'chrome', 'chrome', 'chrome', 'body']);
    assert.deepEqual(ir.diagnostics.chromeFallbacks.map(entry => entry.rule), [
        'first-page-publisher-copyright',
        'first-page-publisher-copyright',
        'first-page-publisher-copyright',
        'first-page-publisher-copyright',
        'first-page-copyright-doi',
    ]);
});
