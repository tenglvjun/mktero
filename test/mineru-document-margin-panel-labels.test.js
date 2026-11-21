import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createTestPNG } from './helpers/figure-fixtures.js';
import { buildMinerUDocumentIR, createMinerUFigureInput, prepareMinerUResult } from '../src/mineru/document/prepare.js';
import { ingestMinerULayout } from '../src/mineru/document/ingest-layout.js';
import { classifyBlocks } from '../src/mineru/document/classify.js';
import { restorePDFFigureCaptions } from '../src/mineru/document/figure-captions.js';
import { projectMinerULayout } from '../src/mineru/document/result-bundle.js';
import { bindFigureSourceRanges } from '../src/figures/figure-source-binding.js';
import { resolveFigureCandidates } from '../src/figures/figure-region-resolver.js';
import { FigureRestorationService } from '../src/figures/figure-restoration-service.js';
import { finalizeRestoredDocument } from '../src/figures/figure-finalization.js';
import { isValidSourceMapEntry } from '../src/core/markdown-source-map.js';
import { sha256Hex } from '../src/core/sha256.js';

const hash = data => sha256Hex(data, { crypto: webcrypto });
const PAGE = 1000;

function text(type, bbox, content) {
    return { type, bbox, lines: [{ bbox, spans: [{ type: 'text', bbox, content }] }] };
}

function line(value, bbox) {
    return { text: value, width: bbox[2] - bbox[0], height: bbox[3] - bbox[1], fontName: 'F1',
        transform: [8, 0, 0, bbox[3] - bbox[1], bbox[0], PAGE - bbox[3]] };
}

// Synthetic panels have tight crops that exclude their raster letters. OCR
// keeps each letter as that panel's caption and files the shared legend on the
// last panel. Only the numbered legend exists in the PDF text layer.
function fixture(rows = [2, 2], change = () => {}) {
    const blocks = [];
    for (const [row, count] of rows.entries()) {
        for (let column = 0; column < count; column++) {
            const index = blocks.length;
            const left = 100 + column * 316;
            const top = 180 + row * 220;
            const bbox = [left, top, left + 280, top + 180];
            const letter = text('chart_caption', [left + 4, top - 26, left + 22, top - 8],
                String.fromCharCode(65 + index));
            blocks.push({ type: 'chart', bbox, blocks: [letter,
                { type: 'chart_body', bbox, lines: [{ bbox, spans: [
                    { type: 'image', bbox, image_path: `panel-${index}.png` },
                ] }] },
            ] });
        }
    }
    const references = blocks.map((_, index) => `(${String.fromCharCode(65 + index)})`).join(' and ');
    const first = `Fig. 8 Measurements in ${references} for the experimental groups.`;
    const second = 'The boxes show the distribution of the observations.';
    const caption = `${first} ${second}`;
    const bottom = blocks.at(-1).bbox[3] + 10;
    blocks.at(-1).blocks.push(text('chart_caption', [100, bottom, 696, bottom + 20], caption));
    const items = [line(first, [100, bottom, 696, bottom + 8]),
        line(second, [100, bottom + 10, 570, bottom + 18])];
    change({ blocks, items, bottom });
    const names = blocks.filter(block => block.type === 'chart').map((_, index) => `images/panel-${index}.png`);
    const bundle = { markdown: '', assetBasePath: '',
        assets: names.map(path => ({ path, mimeType: 'image/png', data: createTestPNG() })),
        layout: projectMinerULayout({ _backend: 'hybrid', _version_name: '3.4.5',
            pdf_info: [{ page_idx: 0, page_size: [PAGE, PAGE], para_blocks: blocks, discarded_blocks: [] }] }),
    };
    const pdfText = { pages: [{ pageIndex: 0,
        viewport: { width: PAGE, height: PAGE, transform: [1, 0, 0, -1, 0, PAGE] }, items }] };
    return { bundle, pdfText, caption, blocks };
}

function candidatesFor(bundle, pdfText) {
    const input = createMinerUFigureInput(bundle, { pdfText });
    return { input, candidates: resolveFigureCandidates(bindFigureSourceRanges(input)) };
}

function harness({ fail = false } = {}) {
    const requests = [];
    const render = request => {
        requests.push(request);
        if (fail) throw new Error('Page rendering failed');
        return { data: createTestPNG(700, 400), mimeType: 'image/png', width: 700, height: 400 };
    };
    const service = new FigureRestorationService({ hash, openPDF: async () => ({
        getPageGeometry: async () => ({ pageIndex: 0, width: PAGE, height: PAGE,
            rotation: 0, userUnit: 1, coordinateFrame: 'display-cropbox',
            viewBox: [0, 0, PAGE, PAGE], viewportTransform: [1, 0, 0, -1, 0, PAGE] }),
        renderRegion: async request => render(request),
        renderPageCrops: async request => ({ crops: request.regions.map(region => ({
            id: region.id, crop: render(region),
        })) }),
        close: async () => {},
    }) });
    return { service, requests };
}

for (const rows of [[2, 2], [2], [1, 1]]) {
    test(`keeps raster letters outside tight panel crops in one ${rows.join('+')} figure`, () => {
        const { bundle, pdfText } = fixture(rows);
        const original = structuredClone(bundle);
        const { input, candidates } = candidatesFor(bundle, pdfText);
        assert.equal(candidates.length, 1);
        const [candidate] = candidates;
        assert.equal(candidate.decision, 'compose', candidate.reason);
        assert.equal(candidate.label, 'Fig. 8');
        assert.equal(candidate.panelBlockIds.length, rows.reduce((sum, count) => sum + count, 0));
        assert.equal(candidate.captionBlockIds.length, 1);
        assert.equal(candidate.ownedTextBlockIds.length, candidate.panelBlockIds.length);
        const labels = input.blocks.filter(block => block.role === 'figure-text');
        assert.deepEqual(candidate.ownedTextBlockIds.sort(), labels.map(block => block.id).sort());
        assert.ok(candidate.visualBBox[1] <= Math.min(...labels.map(block => block.bbox[1])));
        assert.ok(labels.every(block => block.sourceRanges.length === 1));
        assert.equal(input.blocks.some(block => block.pdfFigure), false);
        assert.deepEqual(bundle, original);
    });
}

test('emits one selectable total legend and retains exact letter provenance after cropping', async () => {
    const { bundle, pdfText, caption } = fixture();
    const { input } = candidatesFor(bundle, pdfText);
    const { service } = harness();
    const draft = await service.restore(structuredClone(input), { fileData: Uint8Array.of(1) });
    assert.equal(draft.blueprints.length, 1, JSON.stringify(draft.preserved));
    const document = await finalizeRestoredDocument(input, draft, { prepare: prepareMinerUResult, hash });
    assert.equal(document.figureMap.figures.length, 1);
    const [figure] = document.figureMap.figures;
    assert.equal(figure.label, 'Fig. 8');
    assert.equal(document.markdown.split(caption).length - 1, 1);
    assert.equal(document.markdown.includes('images/panel-'), false);
    assert.equal(document.markdown.includes('![A]'), false);
    for (const letter of ['A', 'B', 'C', 'D']) {
        assert.ok(figure.provenance.fragments.some(fragment => fragment.markdown === letter));
    }
    assert.ok(document.sourceMap.every(entry => isValidSourceMapEntry(entry, document.markdown.length)));
});

test('keeps the complete caption and all letters readable if cropping fails', async () => {
    const { bundle, pdfText } = fixture();
    const { input } = candidatesFor(bundle, pdfText);
    const { service } = harness({ fail: true });
    const draft = await service.restore(input, { fileData: Uint8Array.of(1) });
    const document = await finalizeRestoredDocument(input, draft, { prepare: prepareMinerUResult, hash });
    assert.equal(document.figureMap.figures.length, 0);
    assert.equal(document.markdown, input.markdown);
});

test('does not change a repaired group on a second caption pass', () => {
    const { bundle, pdfText } = fixture();
    const ir = buildMinerUDocumentIR(bundle, { pdfText });
    const before = structuredClone(ir.blocks);
    restorePDFFigureCaptions(ir, pdfText);
    assert.deepEqual(ir.blocks, before);
    assert.equal(ir.diagnostics.pdfCaptions.restored, 0);
    assert.equal(ir.diagnostics.pdfCaptions.completed, 0);
});

for (const [reason, change] of [
    ['a repeated letter', ({ blocks }) => { blocks[1].blocks[0].lines[0].spans[0].content = 'A'; }],
    ['a letter the legend does not describe', ({ blocks }) => { blocks[0].blocks[0].lines[0].spans[0].content = 'Z'; }],
    ['a letter too far from its panel', ({ blocks }) => { blocks[0].blocks[0].bbox = [104, 90, 122, 108]; }],
    ['an oversized letter box', ({ blocks }) => { blocks[0].blocks[0].bbox = [0, 120, 226, 206]; }],
    ['a letter with two possible owners', ({ blocks }) => { blocks[0].blocks[0].bbox = [389, 154, 407, 172]; }],
    ['a raster letter filed under a different panel', ({ blocks }) => { blocks[0].blocks[0].bbox = [440, 154, 458, 172]; }],
    ['body text inside the added letter margin', ({ blocks }) => {
        blocks.push(text('text', [100, 154, 180, 170], 'An independent article paragraph.'));
    }],
]) {
    test(`preserves the whole group with ${reason}`, () => {
        const { bundle, pdfText } = fixture([2, 2], change);
        const ir = ingestMinerULayout(bundle.layout);
        classifyBlocks(ir);
        const before = structuredClone(ir.blocks);
        restorePDFFigureCaptions(ir, pdfText);
        assert.deepEqual(ir.blocks, before);
        assert.equal(ir.diagnostics.pdfCaptions.completed, 0);
        assert.equal(ir.diagnostics.pdfCaptions.groups, 0);
    });
}

test('moves a marginal letter to a different panel only when native text verifies it', () => {
    const { bundle, pdfText } = fixture([2], ({ blocks, items }) => {
        const bbox = [440, 154, 458, 172];
        blocks[0].blocks[0].bbox = bbox;
        items.push(line('A', bbox));
    });
    const { input, candidates } = candidatesFor(bundle, pdfText);
    assert.equal(candidates[0].decision, 'compose', candidates[0].reason);
    const ir = input.providerState.mineruDocument.ir;
    assert.ok(ir.captionMoves.some(move => move.reason === 'panel-label' && move.from === 'p0-0' && move.to === 'p0-1'));
    const before = structuredClone(ir.blocks);
    const moves = structuredClone(ir.captionMoves);
    const markdown = prepareMinerUResult(input).markdown;
    restorePDFFigureCaptions(ir, pdfText);
    assert.deepEqual(ir.blocks, before);
    assert.deepEqual(ir.captionMoves, moves);
    assert.equal(prepareMinerUResult(input).markdown, markdown);
    assert.equal(ir.diagnostics.pdfCaptions.completed, 0);
});
