import test from 'node:test';
import assert from 'node:assert/strict';
import { projectMinerULayout } from '../src/mineru/document/result-bundle.js';
import { createMinerUFigureInput, prepareMinerUResult } from '../src/mineru/document/prepare.js';
import { bindFigureSourceRanges } from '../src/figures/figure-source-binding.js';
import { resolveFigureCandidates } from '../src/figures/figure-region-resolver.js';
import { composeFigureDraft } from '../src/figures/figure-transaction.js';
import { isValidSourceMapEntry } from '../src/core/markdown-source-map.js';
import { createTestPNG } from './helpers/figure-fixtures.js';

// Every fixture here is synthetic. The regression pins the general shape of a
// multi-panel figure whose OCR pictures do not correspond one-to-one to the
// lettered subfigures the printed legend describes:
//
// - two float pictures hold three lettered subfigures, so the picture count
//   and the letter count disagree;
// - each float's box is its tight body, while the one printed legend spans the
//   page under both of them and is filed on the right-hand float;
// - body prose and a body sentence that opens with the figure number stay
//   outside the figure band;
// - the printed legend can exceed the eight-line read budget and print inline
//   math, ligatures and repeated words differently from the OCR copy.

const PAGE = 1000;
const LEGEND_LINES = [
    'Figure 7: Comparison of the three conditions. (a) The first condition over the trial.',
    'The same measurement is repeated for every participant in the cohort.',
    '(b) The second condition, with the same ordering and the same reference band.',
    '(c) The third condition. Intervals indicate uncertainty across independent runs.',
];
const CAPTION = LEGEND_LINES.join(' ');
const PROSE = 'An independent paragraph follows the complete figure and keeps its own text.';
// Two panel axis titles printed side by side on one baseline. MinerU files
// each as a picture caption; neither is a legend.
const LEFT_AXIS = 'share of the total';
const RIGHT_AXIS = 'count per day';
const AXIS_BASELINE = 280;
const REFERENCE = 'Figure 7b measures the same quantity and is discussed in the text below.';

// The body starts below the shared legend band so the group stays closed.
const PROSE_BOX = [60, 470, 940, 510];
const REFERENCE_BOX = [60, 520, 940, 560];

function text(type, bbox, content) {
    return { type, bbox, lines: [{ bbox, spans: [{ type: 'text', bbox, content }] }] };
}

function picture(type, bbox, name, captions = []) {
    return {
        type, bbox,
        blocks: [
            { type: `${type}_body`, bbox,
                lines: [{ bbox, spans: [{ type, bbox, image_path: name }] }] },
            ...captions.map(([captionBBox, content]) => text(`${type}_caption`, captionBBox, content)),
        ],
    };
}

// One PDF text run, positioned by its printed top edge in the IR's 0-1000
// units. `width` and `size` follow the printed line, so the run's own box
// matches the OCR box that describes the same line.
function pdfLine(value, top, { left = 60, width = 880, size = 7.5 } = {}) {
    return { text: value, width, height: size, fontName: 'F1',
        transform: [size, 0, 0, size, left, PAGE - top - size] };
}

function fixture({ legendLines = LEGEND_LINES, ocrCaption = CAPTION, captionBBox = [60, 320, 940, 400],
    extraBlocks = [] } = {}) {
    const assets = ['a.png', 'b.png', 'c.png'].map(name => ({
        path: `images/${name}`, mimeType: 'image/png', data: createTestPNG(),
    }));
    const result = {
        markdown: '', assetBasePath: '', assets,
        layout: projectMinerULayout({ _backend: 'synthetic', _version_name: '3.4.5', pdf_info: [{
            page_idx: 0, page_size: [PAGE, PAGE], discarded_blocks: [], para_blocks: [
                // Three lettered subfigures live in two OCR pictures: the
                // left picture holds (a) and (b), the right one holds (c).
                // MinerU also files each picture's panel marker as a caption.
                picture('image', [60, 100, 480, 300], 'a.png', [
                    [[80, 104, 96, 118], 'a'],
                    [[80, AXIS_BASELINE, 460, 296], LEFT_AXIS],
                ]),
                picture('chart', [520, 100, 940, 300], 'b.png', [
                    [[540, 104, 556, 118], 'b'],
                    [[540, AXIS_BASELINE, 920, 296], RIGHT_AXIS],
                    [captionBBox, ocrCaption],
                ]),
                text('text', PROSE_BOX, PROSE),
                text('text', REFERENCE_BOX, REFERENCE),
                ...extraBlocks,
            ],
        }] }),
    };
    const pdfText = { pages: [{ pageIndex: 0,
        viewport: { width: PAGE, height: PAGE, transform: [1, 0, 0, -1, 0, PAGE] },
        items: [
            pdfLine(LEFT_AXIS, AXIS_BASELINE, { left: 80, width: 380 }),
            pdfLine(RIGHT_AXIS, AXIS_BASELINE, { left: 540, width: 380 }),
            ...legendLines.map((value, index) => pdfLine(value, 320 + index * 8)),
            // The running text is set larger than the legend.
            pdfLine(PROSE, PROSE_BOX[1], { width: 880, size: 10 }),
            pdfLine(REFERENCE, REFERENCE_BOX[1], { width: 880, size: 10 }),
            // The three printed panel letters, inside their own subfigures.
            pdfLine('a', 104, { left: 80, width: 10 }),
            pdfLine('b', 104, { left: 540, width: 10 }),
            pdfLine('c', 104, { left: 800, width: 10 }),
        ],
    }] };
    return { result, pdfText };
}

function candidatesFor({ result, pdfText }) {
    const input = bindFigureSourceRanges(createMinerUFigureInput(result, { pdfText }));
    return { input, candidates: resolveFigureCandidates(input) };
}

for (const withPDF of [false, true]) {
    test(`keeps one figure when two float pictures hold three lettered subfigures ${withPDF ? 'with' : 'without'} PDF text`, () => {
        const fixtureValues = fixture();
        const input = bindFigureSourceRanges(createMinerUFigureInput(fixtureValues.result, {
            pdfText: withPDF ? fixtureValues.pdfText : null,
        }));
        const candidates = resolveFigureCandidates(input);
        assert.equal(candidates.length, 1, JSON.stringify(candidates.map(candidate => ({
            label: candidate.label,
            panels: candidate.panelBlockIds.length,
            decision: candidate.decision,
            reason: candidate.reason,
        }))));
        const candidate = candidates[0];
        assert.equal(candidate.decision, 'compose');
        assert.equal(candidate.panelBlockIds.length, 2);
        assert.equal(candidate.captionBlockIds.length, 1);
        assert.equal(input.markdown.split('Figure 7:').length - 1, 1);
        if (withPDF) {
            // The printed legend belongs to the whole component, not to the one
            // picture MinerU filed it under. Without this, the row is split
            // into a captioned fragment and a separate uncaptioned fragment,
            // which is the observed regression on the real paper.
            const ir = input.providerState.mineruDocument.ir;
            assert.equal(ir.diagnostics.pdfCaptions.groups, 1,
                JSON.stringify(ir.diagnostics.pdfCaptions));
            assert.equal(ir.diagnostics.pdfCaptions.completed, 1);
        }
    });
}

test('composes the whole group and prints its legend exactly once', () => {
    const { input, candidates } = candidatesFor(fixture());
    assert.equal(candidates.length, 1);
    const draft = composeFigureDraft(input, [{ candidate: candidates[0],
        assetPath: 'generated/figures/group.png',
        crop: { data: createTestPNG(800, 200), mimeType: 'image/png', width: 800, height: 200 } }]);
    assert.deepEqual(draft.preserved, []);
    const document = prepareMinerUResult(draft.input);
    assert.equal(document.markdown.split('Figure 7:').length - 1, 1);
    assert.ok(document.markdown.includes(`![${CAPTION}](generated/figures/group.png)`));
    assert.equal(document.markdown.includes('images/'), false);
    assert.ok(document.markdown.includes(PROSE));
    assert.ok(document.markdown.includes(REFERENCE));
    assert.ok(document.sourceMap.every(entry => isValidSourceMapEntry(entry, document.markdown.length)));
});

test('keeps axis titles and panel markers inside the figure, never as legends', () => {
    const { input, candidates } = candidatesFor(fixture());
    assert.equal(candidates.length, 1);
    const candidate = candidates[0];
    assert.equal(candidate.captionBlockIds.length, 1);
    // The panel markers and the two axis titles printed on one baseline are
    // interior text owned by the group, never additional captions.
    const ir = input.providerState.mineruDocument.ir;
    const owned = new Set(candidate.ownedTextBlockIds);
    for (const block of ir.blocks.filter(block => block.pageIndex === 0)) {
        for (const child of block.children || []) {
            const text = (child.fragments || []).flatMap(fragment => (fragment.lines || [])
                .flatMap(line => (line.spans || []).map(span => span.content))).join(' ');
            if (text === LEFT_AXIS || text === RIGHT_AXIS) {
                assert.ok(owned.has(child.id), `${text} must be owned interior text`);
            }
        }
    }
    assert.equal(candidate.ownedTextBlockIds.length, 4);
    assert.equal(input.markdown.split('share of the total').length - 1, 1);
    assert.equal(input.markdown.split('count per day').length - 1, 1);
    assert.equal(input.markdown.split('Figure 7:').length - 1, 1);
    const draft = composeFigureDraft(input, [{ candidate,
        assetPath: 'generated/figures/axes.png',
        crop: { data: createTestPNG(800, 200), mimeType: 'image/png', width: 800, height: 200 } }]);
    const document = prepareMinerUResult(draft.input);
    // Axis titles belong to the restored picture, so they leave the reading
    // flow with the fragments the crop owns, and the legend prints once.
    assert.equal(document.markdown.includes('share of the total'), false);
    assert.equal(document.markdown.includes('count per day'), false);
    assert.equal(document.markdown.split('Figure 7:').length - 1, 1);
    assert.ok(document.markdown.includes(`![${CAPTION}](generated/figures/axes.png)`));
});

test('keeps a sentence that opens with the figure number as body prose', () => {
    const { input, candidates } = candidatesFor(fixture());
    const ir = input.providerState.mineruDocument.ir;
    const bodies = ir.blocks.filter(block => (block.fragments || []).length
        && (block.fragments || []).some(fragment => (fragment.lines || []).some(inner =>
            inner.spans.some(span => span.content === REFERENCE))));
    assert.equal(bodies.length, 1, 'the sentence must stay in the document');
    const body = bodies[0];
    assert.notEqual(body.role, 'caption');
    assert.equal(body.captionConsumed, undefined);
    // No printed legend is read out of the prose sentence, and the caption
    // group never claims it.
    const natives = ir.blocks.flatMap(block => block.children || []).filter(child => child.pdfNativeCaption);
    assert.equal(natives.some(child => child.nativeText === REFERENCE), false);
    for (const candidate of candidates) {
        assert.equal(candidate.captionBlockIds.some(id => body.id.startsWith(id)), false);
        assert.ok(!candidate.ownedTextBlockIds.includes(body.id));
    }
    assert.equal(candidates.filter(candidate => candidate.label === 'Figure 7:').length, 1);
});

test('keeps a legend longer than the eight-line read budget intact and unrepeated', () => {
    const lines = [
        LEGEND_LINES[0],
        ...Array.from({ length: 9 }, (_, index) =>
            `The ${index + 1}th printed line repeats the same measured result in the same order.`),
    ];
    const caption = lines.join(' ');
    const { input, candidates } = candidatesFor(fixture({
        legendLines: lines,
        ocrCaption: caption,
        captionBBox: [60, 320, 940, 420],
    }));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].decision, 'compose');
    assert.equal(candidates[0].captionBlockIds.length, 1);
    assert.equal(input.markdown.split('Figure 7:').length - 1, 1);
    assert.ok(input.markdown.includes(caption));
    const draft = composeFigureDraft(input, [{ candidate: candidates[0],
        assetPath: 'generated/figures/long.png',
        crop: { data: createTestPNG(800, 200), mimeType: 'image/png', width: 800, height: 200 } }]);
    const document = prepareMinerUResult(draft.input);
    assert.equal(document.markdown.split('Figure 7:').length - 1, 1);
    assert.ok(document.markdown.includes(caption));
});

test('keeps one legend when OCR and PDF print inline math, ligatures and repeated words differently', () => {
    const ocr = 'Figure 7: Comparison of the three conditions. Probability that ε<0.07 holds. '
        + '(a) The first condition. (b) The second condition, the same in the same cohort. '
        + 'Probability that N≥30 holds. (c) The third condition. Intervals indicate uncertainty.';
    const printed = [
        'Figure 7: Comparison of the three conditions. Probability that',
        'ε < 0.07 holds. (a) The first condition. (b) The second condition, the same in the same',
        'cohort. Probability that N ≥ 30 holds. (c) The third condition. Intervals indicate uncertainty.',
    ];
    const { input, candidates } = candidatesFor(fixture({
        legendLines: printed,
        ocrCaption: ocr,
        captionBBox: [60, 320, 940, 350],
    }));
    assert.equal(candidates.length, 1, JSON.stringify(candidates.map(candidate => ({
        label: candidate.label, decision: candidate.decision, reason: candidate.reason,
    }))));
    assert.equal(candidates[0].decision, 'compose');
    assert.equal(candidates[0].captionBlockIds.length, 1);
    // One legend, and the repeated words survive in the OCR copy.
    assert.equal(input.markdown.split('Figure 7:').length - 1, 1);
    assert.ok(input.markdown.includes(ocr));
});

test('does not merge two stacked figures that each print their own legend', () => {
    // A second picture row below the prose, with its own printed legend under
    // it. Nothing here overlaps the first group or its body text.
    const fixtureValues = fixture({ extraBlocks: [
        picture('chart', [60, 640, 480, 820], 'c.png', [
            [[60, 830, 480, 870], 'Figure 8: A separate condition. (a) First. (b) Second.'],
        ]),
    ] });
    const { result, pdfText } = fixtureValues;
    pdfText.pages[0].items.push(
        pdfLine('Figure 8: A separate condition. (a) First. (b) Second.', 830, { width: 420 }));
    const { candidates } = candidatesFor({ result, pdfText });
    const labels = candidates.map(candidate => candidate.label);
    assert.ok(labels.includes('Figure 7:'), JSON.stringify(labels));
    assert.ok(labels.includes('Figure 8:'), JSON.stringify(labels));
    assert.equal(labels.filter(label => label === 'Figure 8:').length, 1);
    assert.ok(candidates.every(candidate => candidate.decision === 'compose'));
});

test('does not reuse a printed legend that names another figure number', () => {
    const { result, pdfText } = fixture();
    result.layout.pages[0].blocks[1].blocks.splice(1, 1,
        text('chart_caption', [60, 320, 940, 400], CAPTION.replace('Figure 7:', 'Figure 9:')));
    const input = createMinerUFigureInput(result, { pdfText });
    const ir = input.providerState.mineruDocument.ir;
    const attached = ir.blocks.flatMap(block => block.children || [])
        .filter(child => child.pdfNativeCaption)
        .map(child => child.nativeText);
    assert.equal(attached.some(value => value.startsWith('Figure 9:')), false);
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));
    assert.ok(candidates.every(candidate => candidate.label !== 'Figure 9:'
        || candidate.captionBlockIds.length === 1));
});
