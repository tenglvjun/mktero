import test from 'node:test';
import assert from 'node:assert/strict';
import {
    assignPageColumns,
    markReferenceSections,
    orderReadingFlow,
} from '../src/mineru/document/reading-order.js';
import { DOCUMENT_IR_SCHEMA } from '../src/mineru/document/ir.js';

function block(id, bbox, { kind = 'text', role, pageIndex = 0, fragments = null } = {}) {
    return {
        id,
        kind,
        mineruType: kind,
        role: role || (kind === 'title' ? 'heading' : kind === 'reference' ? 'reference'
            : kind === 'image' ? 'float' : 'body'),
        pageIndex,
        bbox,
        fragments: fragments || [{ pageIndex, bbox, lines: [{ bbox, spans: [{ type: 'text', content: id }] }] }],
        children: [],
        mergedFrom: [],
        absorbed: [],
    };
}

function order(blocks, pages = [0]) {
    const ir = orderReadingFlow({
        schema: DOCUMENT_IR_SCHEMA,
        pages: pages.map(pageIndex => ({ pageIndex })),
        blocks,
        diagnostics: { reorderedBands: [], chromeFallbacks: [] },
    });
    return ir;
}

const ids = ir => ir.blocks.map(entry => entry.id);

test('orders same-page two-column prose column by column', () => {
    const ir = order([
        block('left', [100, 600, 490, 850]),
        block('right-bottom', [510, 650, 900, 850]),
        block('right-top', [510, 100, 900, 300]),
        block('left-top', [100, 100, 490, 580]),
    ]);
    assert.deepEqual(ids(ir), ['left-top', 'left', 'right-top', 'right-bottom']);
    assert.equal(ir.diagnostics.reorderedBands[0].rule, 'column');
});

test('moves a right-column heading that MinerU read before the left column', () => {
    const ir = order([
        block('references', [665, 69, 761, 83], { kind: 'title' }),
        block('left-continuation', [74, 69, 493, 250]),
        block('limitations', [75, 270, 180, 284], { kind: 'title' }),
        block('left-body', [74, 289, 493, 519]),
        block('ref-1', [513, 95, 922, 129], { kind: 'reference' }),
        block('ref-2', [513, 129, 922, 173], { kind: 'reference' }),
    ]);
    assert.deepEqual(ids(ir), ['left-continuation', 'limitations', 'left-body', 'references', 'ref-1', 'ref-2']);
    assert.equal(ir.blocks[2].role, 'body');
    assert.equal(ir.blocks[3].referenceHeading, true);
});

test('moves text above a centered heading before it and keeps the rest in MinerU order', () => {
    const ir = order([
        block('ref-a', [105, 257, 480, 298], { kind: 'reference' }),
        block('heading', [461, 227, 538, 240], { kind: 'title' }),
        block('ref-b', [105, 299, 477, 341], { kind: 'reference' }),
        block('correspondence', [508, 147, 895, 207]),
        block('author-note', [652, 118, 752, 134], { kind: 'title' }),
        block('ref-c', [511, 256, 886, 298], { kind: 'reference' }),
    ]);
    assert.deepEqual(ids(ir), ['author-note', 'correspondence', 'heading', 'ref-a', 'ref-b', 'ref-c']);
    assert.equal(ir.diagnostics.reorderedBands[0].rule, 'separator');
});

test('keeps a full-width abstract and its title above two-column prose', () => {
    const ir = order([
        block('abstract-title', [80, 70, 920, 120], { kind: 'title' }),
        block('abstract', [80, 130, 920, 300]),
        block('left', [100, 320, 490, 700]),
        block('right', [510, 320, 900, 700]),
    ]);
    assert.deepEqual(ids(ir), ['abstract-title', 'abstract', 'left', 'right']);
    assert.equal(ir.diagnostics.reorderedBands.length, 0);
});

test('orders columns that share a narrow gutter', () => {
    const ir = order([
        block('right', [500, 130, 900, 480]),
        block('left', [100, 140, 505, 700]),
    ]);
    assert.deepEqual(ids(ir), ['left', 'right']);
});

test('keeps a sidebar beside a full-width abstract in MinerU order', () => {
    const ir = order([
        block('title', [61, 57, 919, 130], { kind: 'title' }),
        block('received', [61, 201, 222, 216]),
        block('accepted', [62, 222, 217, 237]),
        block('authors', [360, 180, 882, 209]),
        block('abstract', [358, 233, 939, 547]),
        block('left', [61, 575, 497, 876]),
        block('right', [508, 575, 946, 876]),
    ]);
    assert.deepEqual(ids(ir), ['title', 'received', 'accepted', 'authors', 'abstract', 'left', 'right']);
});

test('keeps text after both columns when it starts below them', () => {
    const ir = order([
        block('left', [64, 82, 492, 327]),
        block('conclusions', [506, 132, 608, 147], { kind: 'title' }),
        block('right', [503, 151, 931, 339]),
        block('acknowledgments', [67, 352, 218, 366], { kind: 'title' }),
    ]);
    assert.deepEqual(ids(ir), ['left', 'conclusions', 'right', 'acknowledgments']);
});

test('does not reorder single-column prose around headings or display math', () => {
    const ir = order([
        block('heading', [100, 120, 280, 160], { kind: 'title' }),
        block('before', [100, 180, 900, 260]),
        block('formula', [250, 280, 750, 360], { kind: 'equation' }),
        block('after', [100, 380, 900, 460]),
    ]);
    assert.deepEqual(ids(ir), ['heading', 'before', 'formula', 'after']);
    assert.equal(ir.pages[0].columns, 1);
});

test('orders same-page text before a block continued from the previous page', () => {
    const ir = order([
        block('previous-page', [100, 100, 490, 900], { pageIndex: 2 }),
        block('three-algorithms', [510, 650, 900, 760], { pageIndex: 3 }),
        block('based', [510, 300, 900, 620], { pageIndex: 3 }),
        block('left', [100, 100, 490, 900], { pageIndex: 3 }),
    ], [2, 3]);
    assert.deepEqual(ids(ir), ['previous-page', 'left', 'based', 'three-algorithms']);
});

test('does not trust a column that holds the spread of two columns', () => {
    // A three-column page where the middle and right columns chain together.
    const ir = order([
        block('left', [50, 34, 340, 449]),
        block('middle-name', [352, 213, 474, 229]),
        block('middle', [352, 309, 642, 562]),
        block('right', [653, 379, 943, 562]),
        block('left-refs', [57, 475, 339, 504]),
    ]);
    assert.deepEqual(ids(ir), ['left', 'middle-name', 'middle', 'right', 'left-refs']);
    assert.equal(ir.pages[0].columns, 1);
});

test('assigns full-width and gutter-crossing blocks to the span column', () => {
    const blocks = [
        block('left', [100, 100, 480, 400]),
        block('right', [520, 100, 900, 400]),
        block('centered', [440, 420, 560, 440], { kind: 'title' }),
        block('wide', [100, 460, 900, 500]),
        block('left-heading', [100, 520, 200, 540], { kind: 'title' }),
    ];
    const layout = assignPageColumns(blocks);
    assert.equal(layout.columns, 2);
    assert.deepEqual(blocks.map(entry => entry.column), [0, 1, 'span', 'span', 0]);
});

test('marks reference sections only after the repaired order', () => {
    const ir = markReferenceSections({
        blocks: [
            block('References', [0, 0, 10, 10], { kind: 'title' }),
            block('entry', [0, 0, 10, 10]),
            block('chrome', [0, 0, 10, 10], { role: 'chrome' }),
            block('appendix', [0, 0, 10, 10], { kind: 'title' }),
            block('body', [0, 0, 10, 10], { role: 'reference' }),
        ],
    });
    assert.deepEqual(ir.blocks.map(entry => entry.role), ['heading', 'reference', 'chrome', 'heading', 'body']);
});

test('places a float that MinerU read early after the text above it', () => {
    const table = block('table', [34, 294, 918, 615], { kind: 'table' });
    const note = { ...block('note', [40, 618, 600, 630]), role: 'float-note', attachedTo: 'table' };
    const ir = order([
        table,
        block('portfolio', [31, 42, 408, 91], { kind: 'title' }),
        block('intro', [36, 189, 902, 220]),
        note,
        block('statistics', [38, 277, 123, 294], { kind: 'title' }),
        block('software', [38, 629, 214, 646], { kind: 'title' }),
    ]);
    assert.deepEqual(ids(ir), ['portfolio', 'intro', 'statistics', 'table', 'note', 'software']);
    assert.deepEqual(ir.diagnostics.reorderedBands.at(-1),
        { pageIndex: 0, rule: 'float', before: ['table', 'statistics'], after: ['statistics', 'table'] });
});

test('keeps floats in order when two move after the same text', () => {
    const ir = order([
        block('first', [100, 300, 900, 400], { kind: 'image' }),
        block('second', [100, 420, 900, 520], { kind: 'code' }),
        block('heading', [100, 100, 400, 120], { kind: 'title' }),
        block('next-page', [100, 100, 900, 200], { pageIndex: 1 }),
    ], [0, 1]);
    assert.deepEqual(ids(ir), ['heading', 'first', 'second', 'next-page']);
});

test('does not move a float past text in another column or below it', () => {
    const ir = order([
        block('photo', [515, 304, 614, 419], { kind: 'image' }),
        block('reference', [78, 332, 492, 366], { kind: 'reference' }),
        block('caption-like', [639, 72, 922, 95]),
        block('below', [500, 430, 900, 600]),
    ]);
    assert.deepEqual(ids(ir), ['photo', 'reference', 'caption-like', 'below']);
});

test('keeps a left-column introduction before right-column prose split by display math', () => {
    const ir = order([
        block('right-top', [510, 250, 900, 400]),
        block('left-heading', [100, 240, 280, 280], { kind: 'title' }),
        block('left-intro', [100, 300, 490, 520]),
        block('equation', [510, 420, 900, 480], { kind: 'equation' }),
        block('right-bottom', [510, 500, 900, 700]),
    ]);
    assert.deepEqual(ids(ir), ['left-heading', 'left-intro', 'right-top', 'equation', 'right-bottom']);
});

test('keeps a full-width abstract heading above columns that MinerU read right-first', () => {
    const ir = order([
        block('abstract', [80, 70, 920, 120], { kind: 'title' }),
        block('right', [510, 130, 900, 480]),
        block('left', [100, 140, 490, 700]),
    ]);
    assert.deepEqual(ids(ir), ['abstract', 'left', 'right']);
});

test('moves an early appendix code float to after the heading directly above it', () => {
    const ir = order([
        block('last-ref', [512, 237, 884, 303], { kind: 'reference', pageIndex: 8 }),
        block('code', [114, 760, 884, 920], { kind: 'code', pageIndex: 9 }),
        block('appendix', [114, 83, 386, 101], { kind: 'title', pageIndex: 9 }),
        block('intro', [112, 108, 884, 158], { pageIndex: 9 }),
        block('a4', [114, 728, 322, 745], { kind: 'title', pageIndex: 9 }),
        block('note', [112, 85, 885, 149], { pageIndex: 10 }),
    ], [8, 9, 10]);
    assert.deepEqual(ids(ir), ['last-ref', 'appendix', 'intro', 'a4', 'code', 'note']);
    assert.equal(ir.diagnostics.reorderedBands.at(-1).rule, 'float');
});

test('keeps code under its heading and moves an early bottom code after the heading above it', () => {
    const ir = order([
        block('last-ref', [512, 237, 884, 303], { kind: 'reference', pageIndex: 8 }),
        block('bottom-code', [114, 760, 884, 920], { kind: 'code', pageIndex: 9 }),
        block('appendix', [114, 83, 386, 101], { kind: 'title', pageIndex: 9 }),
        block('intro', [112, 108, 884, 158], { pageIndex: 9 }),
        block('a1', [114, 166, 391, 181], { kind: 'title', pageIndex: 9 }),
        block('a1-code', [114, 190, 884, 400], { kind: 'code', pageIndex: 9 }),
        block('a4', [114, 728, 322, 745], { kind: 'title', pageIndex: 9 }),
        block('note', [112, 85, 885, 149], { pageIndex: 10 }),
    ], [8, 9, 10]);
    assert.deepEqual(ids(ir), [
        'last-ref', 'appendix', 'intro', 'a1', 'a1-code', 'a4', 'bottom-code', 'note',
    ]);
});

test('orders one column top to bottom when its paragraphs are interleaved with images', () => {
    const ir = order([
        block('right-bottom', [520, 420, 900, 620]),
        block('image-left', [80, 500, 470, 820], { kind: 'image' }),
        block('right-top', [520, 80, 900, 200]),
        block('image-right', [520, 500, 900, 820], { kind: 'image' }),
        block('right-mid', [520, 220, 900, 400]),
        block('left', [80, 80, 470, 400]),
    ]);
    assert.deepEqual(ids(ir), [
        'left', 'image-left', 'right-top', 'right-mid', 'image-right', 'right-bottom',
    ]);
    assert.deepEqual(
        ids(ir).filter(id => id.startsWith('right-')),
        ['right-top', 'right-mid', 'right-bottom'],
    );
    assert.deepEqual(
        ids(ir).filter(id => id.startsWith('image-')),
        ['image-left', 'image-right'],
    );
});

test('treats a stack of short reference entries as a column', () => {
    const entry = (id, bbox) => block(id, bbox, { kind: 'reference' });
    const ir = order([
        entry('l1', [61, 82, 486, 111]),
        entry('l2', [61, 111, 486, 140]),
        entry('l3', [61, 141, 486, 163]),
        entry('r1', [533, 82, 938, 101]),
        entry('r2', [511, 101, 938, 131]),
        entry('r3', [511, 131, 938, 160]),
    ]);
    assert.equal(ir.pages[0].columns, 2);
    assert.deepEqual(ir.blocks.map(entry => entry.column), [0, 0, 0, 1, 1, 1]);
});

test('reads the reference entries of a single-column page from top to bottom', () => {
    const entry = (id, bbox) => block(id, bbox, { kind: 'reference' });
    const ir = order([
        entry('161', [242, 503, 850, 547]),
        entry('continued', [270, 74, 822, 105]),
        entry('152', [242, 105, 855, 149]),
        entry('153', [242, 149, 855, 206]),
        entry('162', [242, 548, 843, 591]),
    ]);
    assert.deepEqual(ids(ir), ['continued', '152', '153', '161', '162']);
    assert.equal(ir.diagnostics.reorderedBands[0].rule, 'reference');
});
