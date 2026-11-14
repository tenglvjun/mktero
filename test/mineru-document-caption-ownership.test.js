import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reassignFloatCaptions } from '../src/mineru/document/floats.js';
import { DOCUMENT_IR_SCHEMA, fragmentText } from '../src/mineru/document/ir.js';
import { projectMinerULayout } from '../src/mineru/document/result-bundle.js';
import { buildMinerUDocumentIR, createMinerUFigureInput } from '../src/mineru/document/prepare.js';
import { serializeDocumentIR } from '../src/mineru/document/serialize.js';
import { isValidSourceMapEntry } from '../src/core/markdown-source-map.js';
import { bindFigureSourceRanges } from '../src/figures/figure-source-binding.js';
import { resolveFigureCandidates } from '../src/figures/figure-region-resolver.js';
import { extractMarkdownAssetOutline } from '../src/markdown/markdown-asset-outline.js';
import { findAcademicFigures, findAcademicTableGroups } from '../src/markdown/markdown-figures.js';
import { renderMarkdownHTML } from '../src/markdown/markdown-html.js';

function caption(id, bbox, text, pageIndex = 0) {
    return {
        id, kind: 'caption', pageIndex, bbox,
        fragments: [{ pageIndex, bbox, lines: [{ bbox, spans: [{ type: 'text', content: text }] }] }],
    };
}

function float(kind, id, bbox, captions = [], pageIndex = 0) {
    return {
        id, kind, mineruType: kind, role: 'float', pageIndex, bbox,
        fragments: [{ pageIndex, bbox, lines: [] }],
        children: [
            { id: `${id}:body0`, kind: 'body', pageIndex, bbox, assetPath: `images/${id}.jpg`,
                ...(kind === 'table' ? { html: '<table><tr><td>Result</td><td>42</td></tr></table>' } : {}) },
            ...captions,
        ],
        mergedFrom: [], absorbed: [],
    };
}

function document(blocks) {
    return {
        schema: DOCUMENT_IR_SCHEMA,
        pages: [...new Set(blocks.map(block => block.pageIndex))].map(pageIndex => ({ pageIndex })),
        blocks,
        diagnostics: {},
    };
}

function captions(block) {
    return block.children.filter(child => child.kind === 'caption')
        .map(child => child.fragments.map(fragment => fragmentText(fragment)).join(' '));
}

function stacked() {
    const moved = caption('table:wrong', [100, 320, 420, 335], 'Figure 7 | Generalization results.');
    const chart = float('chart', 'chart', [140, 100, 860, 300]);
    const table = float('table', 'table', [100, 345, 900, 450], [
        moved,
        caption('table:own', [100, 460, 900, 480], 'Table 2 | Baseline results.'),
    ]);
    return { chart, table, moved };
}

test('returns a separate figure caption from a table even when the table is closer', () => {
    const { chart, table, moved } = stacked();
    const original = structuredClone(moved);
    const ir = reassignFloatCaptions(document([chart, table]));
    assert.deepEqual(captions(chart), ['Figure 7 | Generalization results.']);
    assert.deepEqual(captions(table), ['Table 2 | Baseline results.']);
    assert.equal(chart.children.at(-1), moved);
    assert.deepEqual(moved, original);
    assert.deepEqual(ir.diagnostics.captionMoves, [{
        from: 'table', to: 'chart', ids: ['table:wrong'], pageIndex: 0,
    }]);
    reassignFloatCaptions(ir);
    assert.equal(ir.diagnostics.captionMoves.length, 1);
});

test('returns a table caption from a chart and supports a receiving float below the source', () => {
    const upper = float('table', 'upper', [100, 100, 900, 300]);
    const lower = float('chart', 'lower', [100, 345, 900, 450], [
        caption('wrong', [100, 320, 900, 335], 'Table IV: Measured results.'),
        caption('own', [100, 460, 900, 480], 'Figure 9. A separate chart.'),
    ]);
    assert.equal(reassignFloatCaptions(document([upper, lower])).diagnostics.captionMoves.length, 1);
    assert.deepEqual(captions(upper), ['Table IV: Measured results.']);
    assert.deepEqual(captions(lower), ['Figure 9. A separate chart.']);

    const source = float('chart', 'source', [100, 100, 900, 300], [
        caption('own', [100, 70, 900, 90], 'Figure 8. A separate chart.'),
        caption('wrong', [100, 320, 900, 335], 'Table S2: Supplementary results.'),
    ]);
    const target = float('table', 'target', [100, 350, 900, 500]);
    assert.equal(reassignFloatCaptions(document([source, target])).diagnostics.captionMoves.length, 1);
    assert.deepEqual(captions(source), ['Figure 8. A separate chart.']);
    assert.deepEqual(captions(target), ['Table S2: Supplementary results.']);
});

test('moves caption continuations together and stops before a different academic label', () => {
    const { chart, table } = stacked();
    table.children.find(child => child.id === 'table:wrong').fragments[0].lines[0].spans[0].content = 'Figure VII';
    table.children.push(caption('continued', [100, 335, 420, 340], 'Generalization results.'));
    const ir = reassignFloatCaptions(document([chart, table]));
    assert.deepEqual(captions(chart), ['Figure VII', 'Generalization results.']);
    assert.deepEqual(captions(table), ['Table 2 | Baseline results.']);
    assert.deepEqual(ir.diagnostics.captionMoves[0].ids, ['table:wrong', 'continued']);
});

test('keeps uncertain cross-type associations unchanged', async t => {
    const cases = [
        ['target already captioned', ({ chart }) => chart.children.push(caption('claimed', [140, 302, 860, 315], 'Figure 6. Existing caption.'))],
        ['target has an unlabeled caption', ({ chart }) => chart.children.push(caption('claimed', [140, 302, 860, 315], 'An existing legend.'))],
        ['no independent source label', ({ table }) => { table.children = table.children.filter(child => child.id !== 'table:own'); }],
        ['missing caption geometry', ({ moved }) => { moved.bbox = null; }],
        ['caption inside the source body', ({ moved }) => { moved.bbox = [100, 360, 420, 375]; }],
        ['target too far', ({ chart }) => { chart.children[0].bbox = [140, 100, 860, 290]; }],
        ['source too far', ({ table }) => { table.children[0].bbox = [100, 380, 900, 450]; }],
        ['source has multiple panels', ({ table }) => table.children.push({
            id: 'panel', kind: 'body', pageIndex: 0, bbox: [100, 345, 900, 450], assetPath: 'images/panel.jpg',
        })],
        ['different column', ({ chart }) => { chart.children[0].bbox = [600, 100, 900, 300]; }],
        ['different page', ({ chart }) => { chart.pageIndex = 1; }],
        ['ambiguous target', ({ blocks }) => blocks.push(float('image', 'other', [100, 100, 860, 300]))],
        ['intervening prose', ({ blocks }) => blocks.push({
            id: 'paragraph', kind: 'text', role: 'body', pageIndex: 0, bbox: [100, 302, 900, 315],
            fragments: [], children: [],
        })],
        ['intervening heading', ({ blocks }) => blocks.push({
            id: 'heading', kind: 'title', role: 'heading', pageIndex: 0, bbox: [100, 302, 900, 315],
            fragments: [], children: [],
        })],
    ];
    for (const [name, mutate] of cases) {
        await t.test(name, () => {
            const state = stacked();
            state.blocks = [state.chart, state.table];
            mutate(state);
            const ir = document(state.blocks);
            const original = structuredClone(ir.blocks);
            reassignFloatCaptions(ir);
            assert.deepEqual(ir.blocks, original);
            assert.deepEqual(ir.diagnostics.captionMoves, []);
        });
    }
});

test('does not split a caption that refers to a table, including a separate continuation', () => {
    const table = float('table', 'table', [100, 100, 900, 300]);
    const chart = float('chart', 'chart', [100, 345, 900, 450], [
        caption('reference', [100, 320, 900, 335], 'Table 1 reports the same measurements.'),
        caption('own', [100, 460, 900, 480], 'Figure 2. Results compared with Table 1; see Table 1 for details.'),
    ]);
    const ir = document([table, chart]);
    const original = structuredClone(ir.blocks);
    reassignFloatCaptions(ir);
    assert.deepEqual(ir.blocks, original);
    assert.equal(ir.diagnostics.captionMoves.length, 0);
    const markdown = serializeDocumentIR(ir).markdown;
    assert.ok(markdown.includes('Results compared with Table 1; see Table 1 for details.'));
});

test('keeps an internal table panel and its label inside a figure', () => {
    const table = float('table', 'table', [100, 100, 900, 300]);
    const chart = float('chart', 'chart', [100, 310, 900, 450], [
        caption('panel-label', [100, 320, 900, 335], 'Table 1 | Statistics inside panel (b).'),
        caption('own', [100, 460, 900, 480], 'Figure 2. (a) Plot; (b) summary table.'),
    ]);
    const ir = document([table, chart]);
    const original = structuredClone(ir.blocks);
    reassignFloatCaptions(ir);
    assert.deepEqual(ir.blocks, original);
    assert.equal(ir.diagnostics.captionMoves.length, 0);
    assert.equal(chart.children.filter(child => child.kind === 'caption').length, 2);
});

test('retains the image fallback for a real figure recognized as a table', () => {
    const source = float('table', 'source', [100, 350, 900, 500], [
        caption('figure', [100, 320, 900, 340], 'Figure 5. Forest plot; see Table 1 for the source values.'),
    ]);
    const nearby = float('chart', 'nearby', [100, 100, 900, 300]);
    const ir = reassignFloatCaptions(document([nearby, source]));
    assert.equal(ir.diagnostics.captionMoves.length, 0);
    const markdown = serializeDocumentIR(ir).markdown;
    assert.ok(markdown.includes('![Figure 5. Forest plot; see Table 1 for the source values.](images/source.jpg)'));
    assert.ok(!markdown.includes('<table>'));
});

test('keeps an internal table panel in a figure that OCR misclassified as a table', () => {
    const source = float('table', 'source', [100, 310, 900, 450], [
        caption('figure', [100, 280, 900, 300], 'Figure 2. (a) Plot; (b) summary table.'),
        caption('panel', [100, 320, 900, 335], 'Table 1 | Statistics inside panel (b).'),
    ]);
    const nearby = float('chart', 'nearby', [100, 100, 900, 260]);
    const ir = reassignFloatCaptions(document([nearby, source]));
    assert.equal(ir.diagnostics.captionMoves.length, 0);
    const markdown = serializeDocumentIR(ir).markdown;
    assert.ok(markdown.includes('![Figure 2. (a) Plot; (b) summary table. Table 1 | Statistics inside panel (b).](images/source.jpg)'));
    assert.ok(!markdown.includes('<table>'));
});

test('keeps a split table reference on a real figure misclassified as a table', () => {
    const source = float('table', 'source', [100, 345, 900, 450], [
        caption('figure', [100, 320, 900, 335], 'Figure 5. Forest plot.'),
        caption('reference', [100, 460, 900, 480], 'Table 1 reports the source values.'),
    ]);
    const nearby = float('chart', 'nearby', [100, 100, 900, 300]);
    const ir = reassignFloatCaptions(document([nearby, source]));
    assert.equal(ir.diagnostics.captionMoves.length, 0);
    const markdown = serializeDocumentIR(ir).markdown;
    assert.ok(markdown.includes('![Figure 5. Forest plot. Table 1 reports the source values.](images/source.jpg)'));
    assert.ok(!markdown.includes('<table>'));
});

test('leaves the existing same-type correction available for unpunctuated captions', () => {
    const first = float('table', 'first', [100, 100, 900, 300], [
        caption('own', [100, 70, 900, 90], 'Table 1. First table.'),
        caption('next', [100, 320, 900, 335], 'Table 2 Results'),
    ]);
    const second = float('table', 'second', [100, 350, 900, 450]);
    const ir = reassignFloatCaptions(document([first, second]));
    assert.equal(ir.diagnostics.captionMoves.length, 1);
    assert.deepEqual(captions(first), ['Table 1. First table.']);
    assert.deepEqual(captions(second), ['Table 2 Results']);
});

test('moves a split table reference together with an existing same-type figure correction', () => {
    const first = float('chart', 'first', [100, 100, 900, 300], [
        caption('own', [100, 70, 900, 90], 'Figure 1. First chart.'),
        caption('next', [100, 320, 900, 335], 'Figure 2. Second chart.'),
        caption('reference', [100, 336, 900, 340], 'Table 1 reports the source values.'),
    ]);
    const second = float('chart', 'second', [100, 350, 900, 450]);
    const ir = reassignFloatCaptions(document([first, second]));
    assert.equal(ir.diagnostics.captionMoves.length, 1);
    assert.deepEqual(captions(first), ['Figure 1. First chart.']);
    assert.deepEqual(captions(second), ['Figure 2. Second chart.', 'Table 1 reports the source values.']);
});

test('keeps HTML for a table with independent mixed labels when reassignment is uncertain', () => {
    for (const bare of [false, true]) {
        const { table } = stacked();
        if (bare) {
            table.children = table.children.filter(child => child.id !== 'table:own');
            table.children.push(caption('bare-label', [100, 460, 900, 470], 'Table 2'));
            table.children.push(caption('description', [100, 470, 900, 480], 'Baseline results.'));
        }
        const ir = reassignFloatCaptions(document([table]));
        const markdown = serializeDocumentIR(ir).markdown;
        assert.equal(ir.diagnostics.captionMoves.length, 0);
        assert.ok(markdown.includes('<table>'));
        assert.ok(markdown.includes('Figure 7 | Generalization results.'));
        assert.ok(markdown.includes('Table 2'));
        assert.ok(!markdown.includes('](images/table.jpg)'));
    }
});

function rrsiBundle() {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/figures/rrsi-caption-ownership.layout.json', import.meta.url), 'utf8'));
    return {
        markdown: '',
        assets: ['rrsi-figure.jpg', 'rrsi-table.jpg'].map(name => ({
            path: `images/${name}`, mimeType: 'image/jpeg', data: new Uint8Array([1]),
        })),
        layout: projectMinerULayout(fixture),
    };
}

test('RRSI page 8 keeps Figure 3 and Table 1 independent through serialization and rendering', () => {
    const bundle = rrsiBundle();
    const ir = buildMinerUDocumentIR(bundle);
    const chart = ir.blocks.find(block => block.kind === 'chart');
    const table = ir.blocks.find(block => block.kind === 'table');
    assert.deepEqual(captions(chart), ['Figure 3 | Main results in all three domains.']);
    assert.deepEqual(captions(table), ['Table 1 | Comparison with prior harness evolution methods on agentic workspace tasks.']);
    assert.deepEqual(ir.diagnostics.captionMoves, [{
        from: 'p7-1', to: 'p7-0', ids: ['p7-1:caption0'], pageIndex: 7,
    }]);
    const serialized = serializeDocumentIR(ir);
    const figures = findAcademicFigures(serialized.markdown);
    const tables = findAcademicTableGroups(serialized.markdown);
    assert.equal(figures.length, 1);
    assert.equal(tables.length, 1);
    assert.equal(figures[0].images.length, 1);
    assert.ok(figures[0].to <= tables[0].from);
    assert.equal(figures[0].caption.text, captions(chart)[0]);
    assert.equal(tables[0].caption.text, captions(table)[0]);
    assert.ok(serialized.markdown.includes('<table>'));
    assert.ok(!serialized.markdown.includes('](images/rrsi-table.jpg)'));
    assert.deepEqual(extractMarkdownAssetOutline(serialized.markdown).map(item => item.type), ['figure', 'table']);
    const html = renderMarkdownHTML(serialized.markdown, { resolveImageURL: path => `data:image/jpeg;base64,${path}` });
    assert.ok(html.includes('<table'));
    assert.ok(html.includes('Main results in all three domains.'));
    assert.ok(serialized.sourceMap.every(entry => isValidSourceMapEntry(entry, serialized.markdown.length)));
    const moved = serialized.pieces.find(piece => piece.key === 'p7-1:caption0');
    assert.equal(moved.parentId, chart.id);
    assert.deepEqual(moved.bbox, chart.children.find(child => child.id === moved.key).bbox);
    assert.equal(serialized.markdown.slice(moved.from, moved.to), captions(chart)[0]);

    const input = bindFigureSourceRanges(createMinerUFigureInput(bundle));
    const candidate = resolveFigureCandidates(input).find(item => item.pageIndex === 7);
    assert.equal(candidate.decision, 'compose');
    assert.equal(candidate.label, 'Figure 3 |');
    assert.equal(candidate.panelBlockIds.length, 1);
    assert.deepEqual(candidate.captionBlockIds, ['p7-1:caption0']);
    assert.ok(candidate.visualBBox[3] < table.children.find(child => child.kind === 'body').bbox[1]);
});
