import test from 'node:test';
import assert from 'node:assert/strict';
import { projectMinerULayout } from '../src/mineru/document/result-bundle.js';
import { buildMinerUDocumentIR } from '../src/mineru/document/prepare.js';
import {
    groupAdjacentTables,
    mergeContinuedTables,
    reassignFloatCaptions,
} from '../src/mineru/document/floats.js';
import { DOCUMENT_IR_SCHEMA } from '../src/mineru/document/ir.js';
import { serializeDocumentIR } from '../src/mineru/document/serialize.js';
import { isValidSourceMapEntry } from '../src/core/markdown-source-map.js';

function caption(id, bbox, text) {
    return {
        id,
        kind: 'caption',
        pageIndex: bbox && 0,
        bbox,
        fragments: [{
            pageIndex: 0,
            bbox,
            lines: [{ bbox, spans: [{ type: 'text', content: text }] }],
        }],
    };
}

function table(id, bbox, { pageIndex = 0, html = '<table><tr><td>a</td><td>b</td></tr></table>', captions = [], absorbed = [], fragments = null } = {}) {
    return {
        id,
        kind: 'table',
        mineruType: 'table',
        role: 'float',
        pageIndex,
        bbox,
        fragments: fragments || [{ pageIndex, bbox, lines: [] }],
        children: [
            ...captions,
            { id: `${id}:body0`, kind: 'body', pageIndex, bbox, html },
        ],
        mergedFrom: [],
        absorbed,
    };
}

function image(id, bbox, captions, { pageIndex = 0, kind = 'image' } = {}) {
    return {
        id,
        kind,
        mineruType: kind,
        role: 'float',
        pageIndex,
        bbox,
        fragments: [{ pageIndex, bbox, lines: [] }],
        children: [
            { id: `${id}:body0`, kind: 'body', pageIndex, bbox, assetPath: 'images/a.jpg' },
            ...captions,
        ],
        mergedFrom: [],
        absorbed: [],
    };
}

function text(id, bbox, content, { pageIndex = 0, role = 'body' } = {}) {
    return {
        id,
        kind: 'text',
        mineruType: 'text',
        role,
        pageIndex,
        bbox,
        fragments: [{ pageIndex, bbox, lines: [{ bbox, spans: [{ type: 'text', content }] }] }],
        children: [],
        mergedFrom: [],
        absorbed: [],
    };
}

function run(blocks, pass, pages = [0]) {
    const ir = {
        schema: DOCUMENT_IR_SCHEMA,
        pages: pages.map(pageIndex => ({ pageIndex })),
        blocks,
        diagnostics: {},
    };
    return pass(ir);
}

function captionTexts(block) {
    return block.children.filter(child => child.kind === 'caption').map(child => (
        child.fragments[0].lines[0].spans[0].content
    ));
}

test('moves a second table label that is closer to the next table than to its own body', () => {
    // Tall table above, short table below. The second label is 19 units under
    // the tall body and 45 above the short body, but closer to the short center.
    const first = table('a', [77, 105, 922, 446], {
        captions: [
            caption('a:label', [466, 72, 531, 82], 'TABLE IV'),
            caption('a:desc', [193, 82, 804, 95], 'First table.'),
            caption('a:next', [467, 465, 529, 476], 'TABLE V'),
            caption('a:tail', [200, 478, 700, 490], 'Moved with the label.'),
        ],
    });
    const second = table('b', [82, 521, 915, 581], {
        captions: [caption('b:desc', [80, 500, 917, 513], 'Second table.')],
    });
    const ir = run([first, second], reassignFloatCaptions);
    assert.deepEqual(captionTexts(first), ['TABLE IV', 'First table.']);
    assert.deepEqual(captionTexts(second), ['Second table.', 'TABLE V', 'Moved with the label.']);
    assert.deepEqual(ir.diagnostics.captionMoves, [{
        from: 'a',
        to: 'b',
        ids: ['a:next', 'a:tail'],
        pageIndex: 0,
    }]);
});

test('keeps a second label that is closer to its own body, already claimed, or on another class', () => {
    const own = table('a', [50, 100, 900, 200], {
        captions: [
            caption('a:one', [50, 40, 200, 55], 'TABLE I'),
            caption('a:two', [50, 210, 200, 225], 'TABLE II'),
        ],
    });
    const far = table('b', [50, 700, 900, 900], { captions: [] });
    assert.deepEqual(captionTexts(run([own, far], reassignFloatCaptions).blocks[0]), ['TABLE I', 'TABLE II']);

    const claimed = table('c', [80, 520, 900, 580], {
        captions: [caption('c:label', [80, 490, 200, 505], 'TABLE VI')],
    });
    const source = table('d', [77, 105, 922, 446], {
        captions: [
            caption('d:one', [466, 72, 531, 82], 'TABLE IV'),
            caption('d:two', [467, 465, 529, 476], 'TABLE V'),
        ],
    });
    const claimedIR = run([source, claimed], reassignFloatCaptions);
    assert.deepEqual(captionTexts(claimedIR.blocks[0]), ['TABLE IV', 'TABLE V']);
    assert.equal(claimedIR.diagnostics.captionMoves.length, 0);

    const figure = image('fig', [82, 521, 915, 581], [
        caption('fig:cap', [80, 500, 400, 515], 'Fig. 9. A plot.'),
    ]);
    const tableSource = table('e', [77, 105, 922, 446], {
        captions: [
            caption('e:one', [466, 72, 531, 82], 'TABLE IV'),
            caption('e:two', [467, 465, 529, 476], 'TABLE V'),
        ],
    });
    assert.equal(run([tableSource, figure], reassignFloatCaptions).diagnostics.captionMoves.length, 0);

    const otherPage = table('f', [82, 521, 915, 581], { pageIndex: 1, captions: [] });
    otherPage.children[1] = caption('f:none', [80, 500, 200, 515], '');
    const crossPage = table('g', [77, 105, 922, 446], {
        captions: [
            caption('g:one', [466, 72, 531, 82], 'TABLE IV'),
            caption('g:two', [467, 465, 529, 476], 'TABLE V'),
        ],
    });
    assert.equal(run([crossPage, otherPage], reassignFloatCaptions, [0, 1]).diagnostics.captionMoves.length, 0);
});

test('moves a second figure label onto the unlabeled figure it is closer to', () => {
    const first = image('a', [100, 100, 400, 500], [
        caption('a:one', [100, 510, 400, 530], 'Fig. 1. First plot.'),
        caption('a:two', [100, 700, 400, 720], 'Fig. 2. Second plot.'),
    ]);
    const second = image('b', [100, 740, 400, 900], [], { kind: 'chart' });
    const ir = run([first, second], reassignFloatCaptions);
    assert.deepEqual(captionTexts(first), ['Fig. 1. First plot.']);
    assert.deepEqual(captionTexts(second), ['Fig. 2. Second plot.']);
    assert.equal(ir.diagnostics.captionMoves[0].to, 'b');
});

test('writes an uncaptioned table directly below a captioned table immediately after it', () => {
    const host = table('host', [77, 128, 922, 277], {
        captions: [
            caption('host:label', [466, 72, 531, 82], 'TABLE III'),
            caption('host:desc', [78, 82, 918, 120], 'Overview of the orders.'),
        ],
    });
    const middle = table('middle', [77, 283, 920, 429], {
        html: '<table><tr><td colspan="2">Order 2</td></tr></table>',
    });
    const last = table('last', [77, 437, 922, 581], {
        html: '<table><tr><td colspan="2">Order 3</td></tr></table>',
    });
    const chart = image('chart', [75, 593, 922, 807], []);
    const ir = run([middle, host, chart, last], groupAdjacentTables);
    assert.deepEqual(ir.blocks.map(block => block.id), ['host', 'middle', 'last', 'chart']);
    assert.deepEqual(ir.diagnostics.tableGroups, [{
        id: 'host',
        pageIndex: 0,
        members: ['host', 'middle', 'last'],
    }]);
});

test('does not group a table that is too far, too narrow, captioned, or separated by prose', () => {
    const host = table('host', [100, 100, 900, 200], {
        captions: [caption('host:label', [100, 70, 300, 90], 'Table 1 Results.')],
    });
    const far = table('far', [100, 231, 900, 300]);
    const narrow = table('narrow', [100, 210, 500, 280]);
    const labeled = table('labeled', [100, 210, 900, 280], {
        captions: [caption('labeled:label', [100, 200, 300, 208], 'Table 2 Other.')],
    });
    const prose = text('prose', [100, 205, 900, 220], 'A sentence between the tables.');
    const below = table('below', [100, 225, 900, 300]);
    const otherPage = table('page', [100, 210, 900, 280], { pageIndex: 1 });
    assert.equal(run([host, far], groupAdjacentTables).diagnostics.tableGroups.length, 0);
    assert.equal(run([host, narrow], groupAdjacentTables).diagnostics.tableGroups.length, 0);
    assert.equal(run([host, labeled], groupAdjacentTables).diagnostics.tableGroups.length, 0);
    assert.deepEqual(run([host, prose, below], groupAdjacentTables).blocks.map(block => block.id), ['host', 'prose', 'below']);
    assert.equal(run([host, otherPage], groupAdjacentTables, [0, 1]).diagnostics.tableGroups.length, 0);
});

const HOST_HTML = '<table><tr><td colspan="2">Name</td><td>Value</td></tr><tr><td>A</td><td>B</td><td>1</td></tr></table>';
const CONTINUED_HTML = '<table><tr><td colspan="2">Name</td><td>Value</td></tr><tr><td>C</td><td>D</td><td>2</td></tr></table>';
const OTHER_HEADER = '<table><tr><td colspan="2">Item</td><td>Value</td></tr><tr><td>C</td><td>D</td><td>2</td></tr></table>';

test('appends a page-top uncaptioned table and drops a repeated header', () => {
    const host = table('host', [80, 400, 900, 800], {
        html: HOST_HTML,
        captions: [caption('host:label', [80, 370, 300, 390], 'Table 1 Results.')],
    });
    const note = text('note', [80, 80, 400, 100], 'Values are means.', { pageIndex: 1, role: 'float-note' });
    note.attachedTo = 'next';
    const next = table('next', [80, 110, 900, 300], {
        pageIndex: 1,
        html: CONTINUED_HTML,
    });
    next.children.push({
        id: 'next:note',
        kind: 'footnote',
        pageIndex: 1,
        bbox: [80, 300, 400, 320],
        fragments: [{ pageIndex: 1, bbox: [80, 300, 400, 320], lines: [{ bbox: [80, 300, 400, 320], spans: [{ type: 'text', content: 'Continued note.' }] }] }],
    });
    const ir = run([host, note, next], mergeContinuedTables, [0, 1]);
    assert.deepEqual(ir.blocks.map(block => block.id), ['host', 'note']);
    assert.equal(note.attachedTo, 'host');
    assert.equal(host.children.some(child => child.id === 'next:note'), true);
    assert.equal(host.children.find(child => child.kind === 'body').html,
        '<table><tr><td colspan="2">Name</td><td>Value</td></tr><tr><td>A</td><td>B</td><td>1</td></tr><tr><td>C</td><td>D</td><td>2</td></tr></table>');
    assert.deepEqual(host.fragments.map(fragment => fragment.pageIndex), [0, 1]);
    assert.deepEqual(ir.diagnostics.continuedTables, [{
        id: 'next',
        into: 'host',
        pageIndex: 1,
        droppedHeader: true,
    }]);
    const serialized = serializeDocumentIR(ir);
    const entry = serialized.sourceMap.find(item => item.type === 'table');
    assert.deepEqual(entry.locations.map(location => location.pageIndex), [0, 1]);
    assert.equal(entry.locationRanges, undefined);
    assert.equal(isValidSourceMapEntry(entry, serialized.markdown.length), true);
    assert.equal((serialized.markdown.match(/<table\b/g) || []).length, 1);
    assert.doesNotMatch(serialized.markdown, /Name[\s\S]*Name/);
});

test('keeps a near header and refuses a merge on any parse or position doubt', () => {
    const host = table('host', [80, 400, 900, 800], { html: HOST_HTML });
    const differentHeader = table('next', [80, 40, 900, 200], { pageIndex: 1, html: OTHER_HEADER });
    const kept = run([host, differentHeader], mergeContinuedTables, [0, 1]);
    assert.equal(kept.blocks.length, 1);
    const keptHTML = kept.blocks[0].children.find(child => child.kind === 'body').html;
    assert.match(keptHTML, /colspan="2">Name</);
    assert.match(keptHTML, /colspan="2">Item</);
    assert.equal(kept.diagnostics.continuedTables[0].droppedHeader, false);

    const mismatched = table('wide', [80, 40, 900, 200], {
        pageIndex: 1,
        html: '<table><tr><td>Only</td></tr><tr><td>Row</td></tr></table>',
    });
    assert.equal(run([
        table('host2', [80, 400, 900, 800], { html: HOST_HTML }),
        mismatched,
    ], mergeContinuedTables, [0, 1]).blocks.length, 2);

    const low = table('low', [80, 151, 900, 300], { pageIndex: 1, html: CONTINUED_HTML });
    assert.equal(run([
        table('host3', [80, 400, 900, 800], { html: HOST_HTML }),
        low,
    ], mergeContinuedTables, [0, 1]).diagnostics.continuedTables.length, 0);

    const heading = text('heading', [80, 40, 300, 60], 'Results', { pageIndex: 1, role: 'heading' });
    const afterHeading = table('after', [80, 70, 900, 200], { pageIndex: 1, html: CONTINUED_HTML });
    assert.equal(run([
        table('host4', [80, 400, 900, 800], { html: HOST_HTML }),
        heading,
        afterHeading,
    ], mergeContinuedTables, [0, 1]).blocks.length, 3);

    const picture = image('pic', [80, 400, 900, 800], []);
    assert.equal(run([
        picture,
        table('top', [80, 40, 900, 200], { pageIndex: 1, html: CONTINUED_HTML }),
    ], mergeContinuedTables, [0, 1]).blocks.length, 2);

    const captioned = table('cap', [80, 40, 900, 200], {
        pageIndex: 1,
        html: CONTINUED_HTML,
        captions: [caption('cap:label', [80, 20, 300, 35], 'Table 4 Continued.')],
    });
    captioned.pageIndex = 1;
    captioned.children.forEach(child => { child.pageIndex = 1; });
    assert.equal(run([
        table('host5', [80, 400, 900, 800], { html: HOST_HTML }),
        captioned,
    ], mergeContinuedTables, [0, 1]).blocks.length, 2);

    const broken = table('broken', [80, 40, 900, 200], {
        pageIndex: 1,
        html: '<table><tr><td colspan="2">Name</td><td>Value</td><tr><td>open</table>',
    });
    assert.equal(run([
        table('host6', [80, 400, 900, 800], { html: HOST_HTML }),
        broken,
    ], mergeContinuedTables, [0, 1]).blocks.length, 2);

    const already = table('merged', [80, 400, 900, 800], {
        html: HOST_HTML,
        absorbed: ['p1-0'],
        fragments: [
            { pageIndex: 0, bbox: [80, 400, 900, 800], lines: [] },
            { pageIndex: 1, bbox: [80, 40, 900, 120], lines: [] },
        ],
    });
    assert.equal(run([
        already,
        table('again', [80, 130, 900, 200], { pageIndex: 1, html: CONTINUED_HTML }),
    ], mergeContinuedTables, [0, 1]).blocks.length, 2);
});

test('wires caption reassignment through the document IR', () => {
    const pageSize = [1000, 1000];
    const line = (bbox, ...spans) => ({
        bbox,
        spans: spans.map(span => typeof span === 'string' ? { bbox, type: 'text', content: span } : { bbox, ...span }),
    });
    const layout = projectMinerULayout({
        pdf_info: [{
            page_idx: 0,
            page_size: pageSize,
            para_blocks: [
                {
                    type: 'table',
                    bbox: [77, 105, 922, 446],
                    blocks: [
                        { type: 'table_caption', bbox: [466, 72, 531, 82], lines: [line([466, 72, 531, 82], 'TABLE IV')] },
                        { type: 'table_caption', bbox: [193, 82, 804, 95], lines: [line([193, 82, 804, 95], 'First table.')] },
                        { type: 'table_body', bbox: [77, 105, 922, 446], lines: [line([77, 105, 922, 446], { type: 'table', html: '<table><tr><td>A</td></tr></table>' })] },
                        { type: 'table_caption', bbox: [467, 465, 529, 476], lines: [line([467, 465, 529, 476], 'TABLE V')] },
                    ],
                },
                {
                    type: 'table',
                    bbox: [82, 521, 915, 581],
                    blocks: [
                        { type: 'table_caption', bbox: [80, 476, 917, 513], lines: [line([80, 476, 917, 513], 'Second table.')] },
                        { type: 'table_body', bbox: [82, 521, 915, 581], lines: [line([82, 521, 915, 581], { type: 'table', html: '<table><tr><td>B</td></tr></table>' })] },
                    ],
                },
            ],
            discarded_blocks: [],
        }],
    });
    const ir = buildMinerUDocumentIR({ layout, assets: [] });
    assert.deepEqual(ir.diagnostics.captionMoves.map(move => move.ids), [['p0-0:caption2']]);
    assert.equal(ir.blocks[1].children.some(child => child.id === 'p0-0:caption2'), true);
});
