import test from 'node:test';
import assert from 'node:assert/strict';
import { projectMinerULayout } from '../src/mineru/document/result-bundle.js';
import {
    createAssetResolver,
    ingestMinerULayout,
    normalizePageBBox,
} from '../src/mineru/document/ingest-layout.js';
import {
    ingestMinerUContentList,
    parseInlineMathSpans,
} from '../src/mineru/document/ingest-content-list.js';
import { blockPlainText, fragmentText, validateDocumentIR } from '../src/mineru/document/ir.js';

const PAGE = [600, 800];

function line(bbox, ...spans) {
    return {
        bbox,
        spans: spans.map(span => typeof span === 'string'
            ? { bbox, type: 'text', content: span }
            : { bbox, ...span }),
    };
}

function page(pageIndex, paraBlocks, discarded = [], pageSize = PAGE) {
    return { page_idx: pageIndex, page_size: pageSize, para_blocks: paraBlocks, discarded_blocks: discarded };
}

function ingest(pages, options = {}) {
    const layout = projectMinerULayout({ _backend: 'hybrid', _version_name: '3.4.4', pdf_info: pages });
    return validateDocumentIR(ingestMinerULayout(layout, options));
}

test('returns cross-page merged lines to their original page and box', () => {
    const ir = ingest([
        page(0, [{ type: 'text', bbox: [60, 700, 540, 780], index: 0, lines: [
            line([60, 700, 540, 780], 'The first half of a sentence'),
            line([60, 60, 540, 120], { type: 'text', content: 'ends on the next page.', cross_page: true }),
        ] }]),
        page(1, [{ type: 'text', bbox: [60, 60, 540, 120], index: 0, lines_deleted: true, lines: [] }]),
    ]);
    assert.equal(ir.blocks.length, 1);
    const [block] = ir.blocks;
    assert.deepEqual(block.fragments.map(fragment => fragment.pageIndex), [0, 1]);
    assert.deepEqual(block.fragments[1].bbox, [100, 75, 900, 150]);
    assert.deepEqual(block.absorbed, ['p1-0']);
    assert.equal(fragmentText(block.fragments[1]), 'ends on the next page.');
    assert.equal(ir.diagnostics.unmatchedDeleted, 0);
});

test('returns same-page column merges and prefers the earliest unused continuation', () => {
    const ir = ingest([
        page(0, [
            { type: 'text', bbox: [40, 600, 290, 780], index: 0, lines: [
                line([40, 600, 290, 780], 'left column'),
                line([310, 60, 560, 200], 'right column'),
                line([40, 60, 290, 100], 'next page'),
            ] },
            { type: 'text', bbox: [310, 60, 560, 200], index: 1, lines_deleted: true, lines: [] },
        ]),
        page(1, [{ type: 'text', bbox: [40, 60, 290, 100], index: 0, lines_deleted: true, lines: [] }]),
        page(2, [{ type: 'text', bbox: [40, 60, 290, 100], index: 0, lines_deleted: true, lines: [] }]),
    ]);
    const [block] = ir.blocks;
    assert.deepEqual(block.fragments.map(fragment => [fragment.pageIndex, fragment.sourceId]),
        [[0, 'p0-0'], [0, 'p0-1'], [1, 'p1-0']]);
    assert.equal(ir.diagnostics.unmatchedDeleted, 1);
});

test('keeps the first line with its own block even when another block shares its box', () => {
    const ir = ingest([
        page(0, [
            { type: 'text', bbox: [40, 60, 290, 100], index: 0, lines: [line([40, 60, 290, 100], 'own line')] },
            { type: 'text', bbox: [40, 60, 290, 100], index: 1, lines_deleted: true, lines: [] },
        ]),
    ]);
    assert.equal(ir.blocks[0].fragments.length, 1);
    assert.equal(ir.blocks[0].fragments[0].sourceId, 'p0-0');
});

test('normalizes boxes by each page size', () => {
    const ir = ingest([
        page(0, [{ type: 'text', bbox: [60, 80, 540, 160], lines: [line([60, 80, 540, 160], 'A')] }]),
        page(1, [{ type: 'text', bbox: [60, 80, 540, 160], lines: [line([60, 80, 540, 160], 'B')] }], [], [1200, 1600]),
    ]);
    assert.deepEqual(ir.blocks[0].bbox, [100, 100, 900, 200]);
    assert.deepEqual(ir.blocks[1].bbox, [50, 50, 450, 100]);
    assert.equal(normalizePageBBox([0, 0, 0, 10], PAGE), null);
    assert.deepEqual(normalizePageBBox([-5, -5, 700, 900], PAGE), [0, 0, 1000, 1000]);
});

test('maps figure, table, code, and equation children', () => {
    const assets = [{ path: 'images/a.jpg' }, { path: 'images/t.jpg' }, { path: 'images/e.jpg' }];
    const ir = ingest([page(0, [
        { type: 'image', bbox: [60, 80, 540, 400], index: 0, blocks: [
            { type: 'image_body', bbox: [60, 80, 540, 360], lines: [line([60, 80, 540, 360], { type: 'image', image_path: 'a.jpg' })] },
            { type: 'image_caption', bbox: [60, 370, 540, 390], lines: [line([60, 370, 540, 390], 'Fig. 1. A ', { type: 'inline_equation', content: 'x' })] },
            { type: 'image_footnote', bbox: [60, 392, 540, 400], lines: [line([60, 392, 540, 400], 'Source: test.')] },
        ] },
        { type: 'table', bbox: [60, 420, 540, 600], index: 1, blocks: [
            { type: 'table_caption', bbox: [60, 420, 540, 430], lines: [line([60, 420, 540, 430], 'TABLE I')] },
            { type: 'table_body', bbox: [60, 432, 540, 600], lines: [line([60, 432, 540, 600],
                { type: 'table', html: '<table><tr><td>1</td></tr></table>', image_path: 't.jpg' })] },
        ] },
        { type: 'code', sub_type: 'algorithm', bbox: [60, 610, 540, 700], index: 2, blocks: [
            { type: 'code_body', bbox: [60, 610, 540, 700], lines: [line([60, 610, 540, 700],
                'Algorithm 1\n  for ', { type: 'inline_equation', content: 'i' }, ' do')] },
        ] },
        { type: 'interline_equation', bbox: [200, 710, 400, 740], index: 3, lines: [line([200, 710, 400, 740],
            { type: 'interline_equation', content: 'E=mc^2 \\tag{1}', image_path: 'e.jpg' })] },
    ])], { assets });
    const [image, table, algorithm, equation] = ir.blocks;
    assert.deepEqual(image.children.map(child => child.kind), ['body', 'caption', 'footnote']);
    assert.equal(image.children[0].assetPath, 'images/a.jpg');
    assert.equal(fragmentText(image.children[1].fragments[0]), 'Fig. 1. A $x$');
    assert.equal(table.children[1].html, '<table><tr><td>1</td></tr></table>');
    assert.equal(table.children[1].assetPath, 'images/t.jpg');
    assert.equal(algorithm.kind, 'algorithm');
    assert.equal(algorithm.children[0].code, 'Algorithm 1\n  for $i$ do');
    assert.equal(equation.kind, 'equation');
    assert.equal(equation.latex, 'E=mc^2 \\tag{1}');
    assert.equal(equation.assetPath, 'images/e.jpg');
    assert.equal(ir.diagnostics.unresolvedAssets, 0);
});

test('attaches an emptied table continuation to the previous page table', () => {
    const ir = ingest([
        page(0, [{ type: 'table', bbox: [60, 400, 540, 780], blocks: [
            { type: 'table_body', bbox: [60, 400, 540, 780], lines: [line([60, 400, 540, 780], { type: 'table', html: '<table></table>' })] },
        ] }]),
        page(1, [{ type: 'table', bbox: [60, 60, 540, 300], blocks: [
            { type: 'table_body', bbox: [60, 60, 540, 300], lines: [], lines_deleted: true },
        ] }]),
    ]);
    assert.equal(ir.blocks.length, 1);
    assert.deepEqual(ir.blocks[0].fragments.map(fragment => fragment.pageIndex), [0, 1]);
    assert.equal(ir.diagnostics.mergedTables, 1);
});

test('keeps discarded blocks with a chrome or page-note role', () => {
    const ir = ingest([page(0, [], [
        { type: 'header', bbox: [60, 10, 540, 30], lines: [line([60, 10, 540, 30], 'Journal')] },
        { type: 'page_footnote', bbox: [60, 760, 540, 790], lines: [line([60, 760, 540, 790], '1 Note.')] },
        { type: 'page_number', bbox: [290, 780, 310, 795], lines: [] },
    ])]);
    assert.deepEqual(ir.blocks.map(block => [block.kind, block.mineruType, block.role]), [
        ['discarded', 'header', 'chrome'],
        ['discarded', 'page_footnote', 'page-note'],
    ]);
    assert.equal(ir.diagnostics.droppedBlocks, 1);
});

test('keeps text of unknown block types and drops empty or malformed blocks', () => {
    const ir = ingest([page(0, [
        { type: 'mystery', bbox: [60, 80, 540, 100], lines: [line([60, 80, 540, 100], 'still readable')] },
        { type: 'text', bbox: [60, 120, 540, 140], lines: [] },
        { type: 'image', bbox: [60, 150, 540, 300], blocks: [{ type: 'image_body', lines: [] }] },
        { type: 'text', bbox: [Number.NaN, 0, 1, 1], lines: [line(undefined, 'no box')] },
    ])]);
    assert.deepEqual(ir.blocks.map(block => blockPlainText(block)), ['still readable', 'no box']);
    assert.deepEqual(ir.diagnostics.unknownTypes, { mystery: 1 });
    assert.equal(ir.diagnostics.droppedBlocks, 2);
});

test('rejects unsafe image paths and ambiguous assets', () => {
    const resolve = createAssetResolver([{ path: 'r/images/a.jpg' }, { path: 'r/b.jpg' }, { path: 'r/images/b.jpg' }], 'r');
    assert.equal(resolve('a.jpg'), 'images/a.jpg');
    assert.equal(resolve('b.jpg'), null);
    assert.equal(resolve('../a.jpg'), null);
    assert.equal(resolve('https://example.test/a.jpg'), null);
    assert.equal(resolve(''), null);
});

test('marks pages with distinct per-line boxes as line geometry', () => {
    const ir = ingest([
        page(0, [{ type: 'text', bbox: [60, 80, 540, 120], lines: [
            line([60, 80, 540, 98], 'first line of a'),
            line([60, 100, 400, 118], 'paragraph'),
        ] }]),
        page(1, [{ type: 'text', bbox: [60, 80, 540, 120], lines: [line([60, 80, 540, 120], 'one line')] }]),
    ]);
    assert.deepEqual(ir.pages.map(entry => entry.geometry), ['line', 'block']);
});

test('builds the IR from a content list when no layout exists', () => {
    const ir = validateDocumentIR(ingestMinerUContentList([
        { type: 'text', text: 'Title', textLevel: 1, pageIndex: 0, bbox: [100, 50, 900, 80] },
        { type: 'text', text: 'With $x$ math.', pageIndex: 0, bbox: [100, 100, 900, 200] },
        { type: 'equation', text: '$$\nE\n$$', pageIndex: 0, bbox: [300, 210, 700, 240] },
        { type: 'image', assetPath: 'images/a.jpg', captions: ['Fig. 1'], pageIndex: 1, bbox: [100, 100, 900, 500] },
        { type: 'code', subType: 'algorithm', text: '<div class="mineru-algorithm" style="x">\nStep\n</div>',
            pageIndex: 1, bbox: [100, 600, 900, 700] },
        { type: 'header', text: 'Running head', pageIndex: 1, bbox: [100, 10, 900, 30] },
    ], { assets: [{ path: 'images/a.jpg' }] }));
    assert.deepEqual(ir.blocks.map(block => block.kind), ['title', 'text', 'equation', 'image', 'algorithm', 'discarded']);
    assert.equal(ir.blocks[2].latex, 'E');
    assert.equal(ir.blocks[4].children[0].code, 'Step');
    assert.deepEqual(ir.blocks[1].fragments[0].lines[0].spans.map(span => span.type), ['text', 'math', 'text']);
    assert.equal(ir.source.origin, 'content-list');
});

test('parses only single-dollar inline math', () => {
    assert.deepEqual(parseInlineMathSpans('a $x$ b $$y$$ c \\$5'), [
        { type: 'text', content: 'a ' },
        { type: 'math', content: 'x' },
        { type: 'text', content: ' b $$y$$ c \\$5' },
    ]);
});
