import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createTestPNG } from './helpers/figure-fixtures.js';
import { buildMinerUDocumentIR, createMinerUFigureInput, prepareMinerUResult } from '../src/mineru/document/prepare.js';
import { projectMinerULayout } from '../src/mineru/document/result-bundle.js';
import { ingestMinerULayout } from '../src/mineru/document/ingest-layout.js';
import { classifyBlocks } from '../src/mineru/document/classify.js';
import { restorePDFFigureCaptions } from '../src/mineru/document/figure-captions.js';
import { bindFigureSourceRanges } from '../src/figures/figure-source-binding.js';
import { resolveFigureCandidates } from '../src/figures/figure-region-resolver.js';
import { FigureRestorationService } from '../src/figures/figure-restoration-service.js';
import { finalizeRestoredDocument } from '../src/figures/figure-finalization.js';
import { sha256Hex } from '../src/core/sha256.js';
import { blockPlainText } from '../src/mineru/document/ir.js';

// Every fixture below is synthetic: page size, panel boxes, panel letters,
// legends and PDF text lines are generated. The regression pins the general
// shape reported for captioned grids:
//
// - a chart footer is reported as `chart_caption` and is not a legend;
// - the previous figure's legend is filed on a subplot of the next figure;
// - one printed legend describes a grid of independently detected subplots,
//   written `(a–f)` or `(a–i)`, including an incomplete last row.

const PAGE = 1000;
const PANEL_SIZE = 200;
const COLUMN_GAP = 24;
const ROW_GAP = 28;
const MARGIN = 60;
const GRID_WIDTH = 3 * PANEL_SIZE + 2 * COLUMN_GAP;
const GRID_TOP = 300;
const LEGEND_HEIGHT = 6;

const ABOVE_CAPTION = 'Figure 3. Distribution of the difference between the two estimates.';
const SIX_CAPTION = 'Figure 4. (a–f) Six example cycles from the series. A blue line marks the surge day.';
const NINE_CAPTION = 'Figure 5. (a–i) Nine further example cycles from the series. A blue line marks the surge day.';
const AXIS_NOTE = '(reference day)';

const hash = data => sha256Hex(data, { crypto: webcrypto });

function text(type, bbox, content) {
    return { type, bbox, lines: [{ bbox, spans: [{ type: 'text', bbox, content }] }] };
}

function chart(bbox, name, caption = null) {
    return {
        type: 'chart', bbox: [...bbox],
        blocks: [
            { type: 'chart_body', bbox: [...bbox],
                lines: [{ bbox: [...bbox], spans: [{ type: 'image', bbox: [...bbox], image_path: name }] }] },
            ...(caption ? [text('chart_caption', caption.bbox, caption.text)] : []),
        ],
    };
}

// The single bar chart printed above the grid. Its axis footer is a chart
// caption inside its own body, and its real legend is printed below the body
// where MinerU still files it on the grid's first subplot.
function topFigure() {
    const bbox = [MARGIN, 70, MARGIN + GRID_WIDTH, 190];
    return chart(bbox, 'images/top.png', {
        bbox: [MARGIN + 120, 170, MARGIN + 320, 184], text: AXIS_NOTE,
    });
}

// A grid of separately detected chart floats, row-major and centred per row.
function gridPanels(rows) {
    const blocks = [];
    const names = [];
    for (const [row, count] of rows.entries()) {
        const width = count * PANEL_SIZE + (count - 1) * COLUMN_GAP;
        const left = MARGIN + (GRID_WIDTH - width) / 2;
        for (let column = 0; column < count; column++) {
            const panelLeft = left + column * (PANEL_SIZE + COLUMN_GAP);
            const top = GRID_TOP + row * (PANEL_SIZE + ROW_GAP);
            const name = `images/cell-${names.length}.png`;
            names.push(name);
            blocks.push(chart([panelLeft, top, panelLeft + PANEL_SIZE, top + PANEL_SIZE], name));
        }
    }
    return { blocks, names };
}

// The legend is one printed line under the whole grid. Its letter range always
// matches the number of subplots, so the fixture is a legal one.
function captionedGrid({ rows, caption, duplicateLetters = [] }) {
    const top = topFigure();
    const { blocks, names } = gridPanels(rows);
    // The bar chart's legend, filed on the first subplot at its printed place.
    blocks[0] = chart(blocks[0].bbox, names[0], {
        bbox: [MARGIN, 196, MARGIN + GRID_WIDTH, 196 + LEGEND_HEIGHT], text: ABOVE_CAPTION,
    });
    for (const index of duplicateLetters) {
        const panel = blocks[index];
        // A printed panel letter inside its own subplot.
        blocks[index] = chart(panel.bbox, names[index], {
            bbox: [panel.bbox[0] + 40, panel.bbox[1] + 40, panel.bbox[0] + 56, panel.bbox[1] + 52],
            text: '(a)',
        });
    }
    const last = blocks.at(-1);
    const legendTop = last.bbox[3] + 34;
    blocks[blocks.length - 1] = chart(last.bbox, names.at(-1), {
        bbox: [MARGIN, legendTop, MARGIN + GRID_WIDTH, legendTop + LEGEND_HEIGHT], text: caption,
    });
    return { blocks: [top, ...blocks], names: ['images/top.png', ...names], legendTop };
}

function bundle({ blocks, names }) {
    return {
        markdown: '', assetBasePath: '',
        assets: names.map(name => ({ path: name, mimeType: 'image/png', data: createTestPNG() })),
        layout: projectMinerULayout({
            _backend: 'synthetic', _version_name: '3.4.5',
            pdf_info: [{ page_idx: 0, page_size: [PAGE, PAGE],
                para_blocks: blocks, discarded_blocks: [] }],
        }),
    };
}

// One PDF line in the IR's 0-1000 units; `top` is the printed box top.
function pdfLine(value, top, { left = MARGIN, width = GRID_WIDTH, size = 6 } = {}) {
    return { text: value, width, height: size, fontName: 'F1',
        transform: [size, 0, 0, size, left, PAGE - top - size] };
}

function pdfWith(...entries) {
    return { pages: [{ pageIndex: 0,
        viewport: { width: PAGE, height: PAGE, transform: [1, 0, 0, -1, 0, PAGE] },
        items: entries }] };
}

// Both printed legends plus the axis footer, exactly where the layout says.
function printedText(fixture) {
    return pdfWith(
        pdfLine(AXIS_NOTE, 170, { left: MARGIN + 120, width: 200 }),
        pdfLine(ABOVE_CAPTION, 196),
        pdfLine(fixture.caption, fixture.legendTop),
    );
}

function documentFor(result, pdfText) {
    const input = createMinerUFigureInput(result, { pdfText });
    return { input, candidates: resolveFigureCandidates(bindFigureSourceRanges(input)) };
}

function summary(list) {
    return list.map(candidate => [candidate.label, candidate.panelBlockIds.length,
        candidate.decision, candidate.reason]);
}

// A restoration service whose PDF report is supplied per test. It returns one
// page geometry and records every request.
function restorationService(render) {
    const regions = [];
    const service = new FigureRestorationService({ hash, openPDF: async () => ({
        getPageGeometry: async () => ({ pageIndex: 0, width: PAGE, height: PAGE,
            rotation: 0, userUnit: 1, coordinateFrame: 'display-cropbox',
            viewBox: [0, 0, PAGE, PAGE], mediaBox: null,
            viewportTransform: [1, 0, 0, -1, 0, PAGE] }),
        renderPageCrops: async request => {
            regions.push(request);
            return { crops: request.regions.map(region => ({ id: region.id, crop: render(region) })) };
        },
        renderRegion: async request => { regions.push(request); return render(request); },
        close: async () => {},
    }) });
    return { service, regions };
}

// Ordinary image/chart figures are cropped from the page, so the test supplies
// a valid PNG for the requested region.
function renderedRegion() {
    return { data: createTestPNG(600, 400), mimeType: 'image/png', width: 600, height: 400 };
}

function fixtureFor({ rows, caption, duplicateLetters = [] }) {
    const fixture = captionedGrid({ rows, caption, duplicateLetters });
    return { ...fixture, caption, result: bundle(fixture) };
}

test('restores a top figure and a six-cell captioned grid', () => {
    const fixture = fixtureFor({ rows: [3, 3], caption: SIX_CAPTION });
    const pdfText = printedText(fixture);
    const { input, candidates } = documentFor(fixture.result, pdfText);
    assert.deepEqual(summary(candidates), [
        ['Figure 3.', 1, 'compose', null],
        ['Figure 4.', 6, 'compose', null],
    ]);
    // The chart footer stays interior text of the top figure: it is no longer a
    // caption of its own, and the figure's only caption is the printed legend.
    const top = input.blocks.find(block => block.id === 'p0-0');
    assert.equal(top.pdfFigure, undefined);
    const footer = input.blocks.find(block => block.id === 'p0-0:caption0');
    assert.equal(footer.role, 'figure-text');
    assert.equal(footer.parentId, 'p0-0');
    assert.equal(footer.text, AXIS_NOTE);
    const printed = input.blocks.find(block => block.id === 'p0-0:pdf-caption');
    assert.equal(printed.role, 'caption');
    assert.equal(printed.embeddedCaption, true);
    assert.equal(printed.text, ABOVE_CAPTION);
});

test('restores a complete three-by-three grid', () => {
    const fixture = fixtureFor({ rows: [3, 3, 3], caption: NINE_CAPTION });
    const { candidates } = documentFor(fixture.result, printedText(fixture));
    assert.deepEqual(summary(candidates), [
        ['Figure 3.', 1, 'compose', null],
        ['Figure 5.', 9, 'compose', null],
    ]);
});

test('restores a seven-cell grid whose last row is one panel', () => {
    const caption = NINE_CAPTION.replace('(a–i)', '(a–g)').replace('Nine', 'Seven');
    const fixture = fixtureFor({ rows: [3, 3, 1], caption });
    const { candidates } = documentFor(fixture.result, printedText(fixture));
    assert.deepEqual(summary(candidates), [
        ['Figure 3.', 1, 'compose', null],
        ['Figure 5.', 7, 'compose', null],
    ]);
});

for (const range of ['(a-f)', '( a — f )', '(a to f)']) {
    test(`restores a shared grid with the panel range ${range}`, () => {
        const fixture = fixtureFor({ rows: [3, 3], caption: SIX_CAPTION.replace('(a–f)', range) });
        assert.deepEqual(summary(documentFor(fixture.result, printedText(fixture)).candidates), [
            ['Figure 3.', 1, 'compose', null], ['Figure 4.', 6, 'compose', null],
        ]);
    });
}

test('repairs a shared legend printed above its complete grid', () => {
    const fixture = fixtureFor({ rows: [3, 3], caption: SIX_CAPTION });
    const last = fixture.blocks.at(-1);
    fixture.legendTop = 270;
    fixture.blocks[fixture.blocks.length - 1] = chart(last.bbox, fixture.names.at(-1), {
        bbox: [MARGIN, 270, MARGIN + GRID_WIDTH, 276], text: SIX_CAPTION,
    });
    const { candidates } = documentFor(bundle(fixture), printedText(fixture));
    assert.deepEqual(summary(candidates), [
        ['Figure 3.', 1, 'compose', null], ['Figure 4.', 6, 'compose', null],
    ]);
});

test('does not move a legend across body prose separating panel rows', () => {
    const fixture = fixtureFor({ rows: [3, 3], caption: SIX_CAPTION });
    fixture.blocks.push(text('text', [MARGIN, 505, MARGIN + GRID_WIDTH, 520],
        'This paragraph belongs to the article body and separates the two visual bands.'));
    const ir = ingestMinerULayout(bundle(fixture).layout);
    classifyBlocks(ir);
    const before = structuredClone(ir.blocks);
    restorePDFFigureCaptions(ir, printedText(fixture));
    assert.deepEqual(ir.blocks, before);
    assert.equal(ir.diagnostics.pdfCaptions.reassigned, 0);
    assert.equal(ir.releasedCaptions, undefined);
});

test('keeps two captioned rows separate at their printed legend boundary', () => {
    const fixture = gridPanels([3, 3]);
    const upper = 'Figure 6. (a–c) Three independently measured conditions.';
    const lower = 'Figure 7. (a–c) Three further measured conditions.';
    for (const [index, caption, top] of [[2, upper, 510], [5, lower, 762]]) {
        const panel = fixture.blocks[index];
        fixture.blocks[index] = chart(panel.bbox, fixture.names[index], {
            bbox: [MARGIN, top, MARGIN + GRID_WIDTH, top + LEGEND_HEIGHT], text: caption,
        });
    }
    const { candidates } = documentFor(bundle(fixture), pdfWith(pdfLine(upper, 510), pdfLine(lower, 762)));
    assert.deepEqual(summary(candidates), [
        ['Figure 6.', 3, 'compose', null], ['Figure 7.', 3, 'compose', null],
    ]);
});

test('is idempotent for the repaired page', () => {
    const fixture = fixtureFor({ rows: [3, 3], caption: SIX_CAPTION });
    const pdfText = printedText(fixture);
    const ir = buildMinerUDocumentIR(fixture.result, { pdfText });
    assert.equal(ir.blocks.filter(block => block.pdfFigure).length, 0);
    const before = structuredClone(ir.blocks);
    const moves = structuredClone(ir.captionMoves || []);
    const released = structuredClone(ir.releasedCaptions || []);
    restorePDFFigureCaptions(ir, pdfText);
    assert.deepEqual(ir.blocks, before);
    assert.deepEqual(ir.captionMoves || [], moves);
    assert.deepEqual(ir.releasedCaptions || [], released);
});

test('keeps the original ownership when two panels claim the same letter', () => {
    // The shared legend covers (a–f) and one subplot carries its complete copy,
    // but two subplots claim the same printed letter, so the group is not a
    // closed one-to-one reading and nothing is reassigned across groups.
    const fixture = fixtureFor({ rows: [3, 3], caption: SIX_CAPTION, duplicateLetters: [1, 2] });
    const ir = ingestMinerULayout(fixture.result.layout);
    classifyBlocks(ir);
    const before = structuredClone(ir.blocks);
    restorePDFFigureCaptions(ir, printedText(fixture));
    // The two `(a)` claims make the shared reading ambiguous: the caption pass
    // leaves the IR byte-identical instead of repairing half of the page.
    assert.deepEqual(ir.blocks, before);
    assert.equal(ir.diagnostics.pdfCaptions.restored, 0);
    assert.equal(ir.diagnostics.pdfCaptions.groups, 0);
    assert.equal(ir.diagnostics.pdfCaptions.reassigned, 0);
    assert.equal(ir.captionMoves, undefined);
    assert.equal(ir.releasedCaptions, undefined);
});

test('leaves the IR untouched when no legend belongs to the grid', () => {
    // The grid prints no legend of its own. The PDF only has the top figure's
    // legend, so the pass must not move it onto the grid or rewrite any child.
    const fixture = fixtureFor({ rows: [3, 3, 1], caption: NINE_CAPTION });
    const blocks = fixture.blocks.map(block => ({
        ...block,
        blocks: block.blocks.filter(child => child.type !== 'chart_caption'
            || !child.lines.some(line => line.spans.some(span => span.content === fixture.caption))),
    }));
    const result = bundle({ blocks, names: fixture.names });
    const ir = ingestMinerULayout(result.layout);
    classifyBlocks(ir);
    const before = structuredClone(ir.blocks);
    restorePDFFigureCaptions(ir, pdfWith(
        pdfLine(AXIS_NOTE, 170, { left: MARGIN + 120, width: 200 }),
        pdfLine(ABOVE_CAPTION, 196),
    ));
    assert.deepEqual(ir.blocks, before);
    assert.equal(ir.captionMoves, undefined);
    assert.equal(ir.releasedCaptions, undefined);
    assert.equal(ir.diagnostics.pdfCaptions.restored, 0);
    assert.equal(ir.diagnostics.pdfCaptions.groups, 0);
});

test('keeps the page untouched when a displaced caption has no destination', () => {
    const fixture = fixtureFor({ rows: [3, 3], caption: SIX_CAPTION });
    const pdfText = pdfWith(pdfLine('Figure 9. A legend for another page.', fixture.legendTop));
    const { input, candidates } = documentFor(fixture.result, pdfText);
    assert.equal(input.blocks.some(block => block.pdfFigure), false);
    assert.ok(candidates.every(candidate => candidate.reason !== 'ambiguous-membership'),
        JSON.stringify(summary(candidates)));
});

test('consumes the chart footer only after a successful region crop', async () => {
    const fixture = fixtureFor({ rows: [3, 3], caption: SIX_CAPTION });
    const { service, regions } = restorationService(renderedRegion);
    const { input } = documentFor(fixture.result, printedText(fixture));
    const draft = await service.restore(input, { fileData: Uint8Array.of(1) });
    const document = await finalizeRestoredDocument(input, draft, { prepare: prepareMinerUResult, hash });
    assert.equal(draft.blueprints.length, 2, JSON.stringify(draft.preserved));
    assert.ok(regions.length >= 1);
    assert.deepEqual(document.figureMap.figures.map(figure => figure.label), ['Figure 3.', 'Figure 4.']);
    // The axis footer belongs to the restored picture, so it leaves the reading
    // flow with the fragments that composite owns.
    assert.equal(document.markdown.includes(AXIS_NOTE), false);
    assert.equal(document.markdown.split(SIX_CAPTION).length - 1, 1);
});

test('keeps the chart footer when the figure crop fails', async () => {
    const fixture = fixtureFor({ rows: [3, 3], caption: SIX_CAPTION });
    const { service } = restorationService(() => {
        throw new Error('page rasterization failed');
    });
    const { input } = documentFor(fixture.result, printedText(fixture));
    const draft = await service.restore(input, { fileData: Uint8Array.of(1) });
    const document = await finalizeRestoredDocument(input, draft, { prepare: prepareMinerUResult, hash });
    assert.deepEqual(draft.blueprints, []);
    assert.deepEqual(document.figureMap.figures, []);
    assert.ok(document.markdown.includes(AXIS_NOTE));
    assert.ok(document.markdown.includes('images/cell-0.png'));
    assert.ok(document.markdown.includes(SIX_CAPTION));
});
