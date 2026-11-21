import test from 'node:test';
import assert from 'node:assert/strict';
import { projectMinerULayout } from '../src/mineru/document/result-bundle.js';
import { createMinerUFigureInput, prepareMinerUResult } from '../src/mineru/document/prepare.js';
import { ingestMinerULayout } from '../src/mineru/document/ingest-layout.js';
import { attachPDFGeometry } from '../src/mineru/document/pdf-geometry.js';
import { classifyBlocks } from '../src/mineru/document/classify.js';
import { restorePDFFigureCaptions } from '../src/mineru/document/figure-captions.js';
import { blockPlainText } from '../src/mineru/document/ir.js';
import { bindFigureSourceRanges } from '../src/figures/figure-source-binding.js';
import { resolveFigureCandidates } from '../src/figures/figure-region-resolver.js';
import { composeFigureDraft } from '../src/figures/figure-transaction.js';
import { collectFigureImageNodes } from '../src/figures/figure-model.js';
import { isValidSourceMapEntry } from '../src/core/markdown-source-map.js';
import { createTestPNG } from './helpers/figure-fixtures.js';

// Synthetic two-column pages: two stacked OCR pictures contain (a+b) and
// (c+d), but only the lower picture carries the complete shared legend.
// Neighbouring body lines sit just 16 units away and share the first two
// caption baselines. Larger prose must not turn those lines into a new,
// truncated legend on the otherwise uncaptioned upper picture.
const PAGE = 1000;
const MARGIN = 60;
const COLUMN_WIDTH = 432;
const GUTTER = 16;
const CAPTION_SIZE = 7.5;
const CAPTION_TOP = 448;
const LINE_PITCH = 10;
const TITLE_TOP = 318;
const TITLE = 'paired response';
const LEGEND_LINES = [
    'Fig. 12. Paired measurements in four synthetic conditions.',
    '(a) The first condition uses the same scale as (b) the second.',
    '(c) The third condition repeats the reference measurement.',
    '(d) The fourth condition completes the comparison.',
    'Intervals indicate uncertainty across independent trials.',
    'The same reference is used for every measurement.',
    'All estimates follow the displayed order of conditions.',
];
const BODY_LINES = [
    'Independent prose discusses the sampling plan for the study.',
    'The following sentence keeps the assumptions in reading order.',
    'Each observation is evaluated using the stated procedure.',
    'The participants complete the tasks in a fixed sequence.',
    'The analysis retains all measurements from the cohort.',
    'The article then describes the remaining methodological details.',
    'Separate observations support the final estimate of uncertainty.',
];
// One continuous neighbouring paragraph reaches from the title baseline
// through the first two legend lines, spanning the picture and caption bands.
const BODY_LEAD_LINES = [
    'The article introduces the independent study population.',
    'These assumptions apply to the subsequent measurements.',
    ...Array.from({ length: 11 }, (_, index) =>
        `Observation ${index + 1} follows the same sampling protocol in the cohort.`),
];

function text(type, bbox, content) {
    return { type, bbox, lines: [{ bbox, spans: [{ type: 'text', bbox, content }] }] };
}

function picture(type, bbox, name, captions = []) {
    return { type, bbox, blocks: [
        { type: `${type}_body`, bbox,
            lines: [{ bbox, spans: [{ type: 'image', bbox, image_path: name }] }] },
        ...captions.map(([box, value]) => text(`${type}_caption`, box, value)),
    ] };
}

function pdfLine(value, top, { left, width = COLUMN_WIDTH, size = CAPTION_SIZE }) {
    return { text: value, width, height: size, fontName: 'F1',
        transform: [size, 0, 0, size, left, PAGE - top - size] };
}

function fixture({ figureOnRight = false, lineCount = 6, bodySize = 10, baselineOffset = 0,
    bodyLineCount = 2, withTitle = true, nativeTitle = true, bodyLayout = true, separateFigure = false,
    interveningBody = false } = {}) {
    const left = MARGIN;
    const right = MARGIN + COLUMN_WIDTH + GUTTER;
    const figureLeft = figureOnRight ? right : left;
    const bodyLeft = figureOnRight ? left : right;
    const legendLines = LEGEND_LINES.slice(0, lineCount);
    const caption = legendLines.join(' ');
    const captionBBox = [figureLeft, CAPTION_TOP, figureLeft + COLUMN_WIDTH,
        CAPTION_TOP + (lineCount - 1) * LINE_PITCH + CAPTION_SIZE];
    const titleBBox = [figureLeft + 24, TITLE_TOP, figureLeft + 324, TITLE_TOP + CAPTION_SIZE];
    const blocks = [
        picture('image', [figureLeft, 100, figureLeft + COLUMN_WIDTH, 300], 'upper.png'),
        picture('chart', [figureLeft, TITLE_TOP, figureLeft + COLUMN_WIDTH, 436], 'lower.png', [
            ...(withTitle ? [[titleBBox, TITLE]] : []),
            [captionBBox, caption],
        ]),
    ];
    const items = legendLines.map((value, index) =>
        pdfLine(value, CAPTION_TOP + index * LINE_PITCH, { left: figureLeft }));
    const bodies = [];
    const addBody = (values, top, { size = bodySize, pitch = LINE_PITCH, x = bodyLeft } = {}) => {
        const bbox = [x, top, x + COLUMN_WIDTH, top + (values.length - 1) * pitch + size];
        const content = values.join(' ');
        bodies.push({ bbox, text: content, lines: values });
        if (bodyLayout) blocks.push(text('text', bbox, content));
        items.push(...values.map((value, index) => pdfLine(value, top + index * pitch,
            { left: x, size })));
    };
    // Equal bottoms, rather than equal tops, make differently sized glyphs
    // share a PDF baseline. Small offsets still enter pdfLines' same row.
    const bodyLines = BODY_LINES.slice(0, bodyLineCount);
    addBody(withTitle ? [...BODY_LEAD_LINES, ...bodyLines] : bodyLines,
        (withTitle ? TITLE_TOP : CAPTION_TOP) + CAPTION_SIZE - bodySize + baselineOffset);
    if (withTitle && nativeTitle) items.push(pdfLine(TITLE, TITLE_TOP, { left: titleBBox[0], width: 300 }));
    if (interveningBody) {
        addBody(['An independent paragraph separates the upper and lower pictures and continues the article discussion.'],
            304, { x: figureLeft, size: 7.5 });
    }
    const names = ['upper.png', 'lower.png'];
    const independentCaption = 'Fig. 13. A separate measurement with its own legend.';
    if (separateFigure) {
        names.push('separate.png');
        blocks.push(picture('chart', [bodyLeft, 100, bodyLeft + COLUMN_WIDTH, 220], 'separate.png', [
            [[bodyLeft, 232, bodyLeft + COLUMN_WIDTH, 232 + CAPTION_SIZE], independentCaption],
        ]));
        items.push(pdfLine(independentCaption, 232, { left: bodyLeft }));
    }
    const result = {
        markdown: '', assetBasePath: '',
        assets: names.map(name => ({ path: `images/${name}`, mimeType: 'image/png', data: createTestPNG() })),
        layout: projectMinerULayout({ _backend: 'synthetic', _version_name: '3.4.5', pdf_info: [{
            page_idx: 0, page_size: [PAGE, PAGE], para_blocks: blocks, discarded_blocks: [],
        }] }),
    };
    const pdfText = { pages: [{ pageIndex: 0,
        viewport: { width: PAGE, height: PAGE, transform: [1, 0, 0, -1, 0, PAGE] }, items,
    }] };
    return { result, pdfText, caption, bodies, independentCaption };
}

function candidatesFor(values) {
    const before = structuredClone(values.result.layout);
    const input = bindFigureSourceRanges(createMinerUFigureInput(values.result, { pdfText: values.pdfText }));
    assert.deepEqual(values.result.layout, before, 'native restoration must not mutate the original OCR layout');
    return { input, candidates: resolveFigureCandidates(input) };
}

function summary(candidates) {
    return JSON.stringify(candidates.map(candidate => ({ label: candidate.label,
        panels: candidate.panelBlockIds.length, decision: candidate.decision, reason: candidate.reason })));
}

function assertBodiesPreserved(document, bodies) {
    assert.ok(document.sourceMap.length > 0);
    assert.ok(document.sourceMap.every(entry => isValidSourceMapEntry(entry, document.markdown.length)));
    for (const body of bodies) {
        assert.equal(document.markdown.split(body.text).length - 1, 1, body.text);
        assert.ok(document.sourceMap.some(entry =>
            document.markdown.slice(entry.markdownFrom, entry.markdownTo).includes(body.text)
            && entry.locations.some(location => location.pageIndex === 0
                && JSON.stringify(location.bbox) === JSON.stringify(body.bbox))),
        'body text must retain its own source location');
    }
}

function assertNoBodyCaptions(input, bodies) {
    for (const block of input.blocks.filter(block => block.role === 'caption')) {
        for (const body of bodies) {
            assert.ok(body.lines.every(line => !block.text.includes(line)),
                `body prose leaked into caption: ${block.text}`);
        }
    }
}

function assertSharedFigure(values) {
    const { input, candidates } = candidatesFor(values);
    assertNoBodyCaptions(input, values.bodies);
    assert.equal(candidates.length, 1, summary(candidates));
    const [candidate] = candidates;
    assert.equal(candidate.decision, 'compose', summary(candidates));
    assert.equal(candidate.panelBlockIds.length, 2);
    assert.equal(candidate.captionBlockIds.length, 1);
    assert.equal(input.blocks.find(block => block.id === candidate.captionBlockIds[0]).text, values.caption);
    assert.equal(input.markdown.split('Fig. 12.').length - 1, 1);
    assertBodiesPreserved(prepareMinerUResult(input), values.bodies);
    return { input, candidate };
}

function compose(input, candidates) {
    const draft = composeFigureDraft(input, candidates.map((candidate, index) => ({ candidate,
        assetPath: `generated/figures/columns-${index}.png`,
        crop: { data: createTestPNG(432, 336), mimeType: 'image/png', width: 432, height: 336 },
    })));
    assert.deepEqual(draft.preserved, []);
    assert.equal(draft.blueprints.length, candidates.length);
    return { draft, document: prepareMinerUResult(draft.input) };
}

for (const figureOnRight of [false, true]) {
    for (const [lineCount, baselineOffset] of [[4, 0], [6, -2], [7, 2]]) {
        test(`keeps the complete ${lineCount}-line shared caption in the ${figureOnRight ? 'right' : 'left'} column with baseline offset ${baselineOffset}`, () => {
            assertSharedFigure(fixture({ figureOnRight, lineCount, baselineOffset }));
        });
    }
}

for (const figureOnRight of [false, true]) {
    test(`separates same-size caption and body runs across a narrow gutter with figures on the ${figureOnRight ? 'right' : 'left'}`, () => {
        assertSharedFigure(fixture({ figureOnRight, bodySize: CAPTION_SIZE, bodyLineCount: 6 }));
    });
}

test('composes two OCR pictures into one image with one full legend and unchanged neighbouring prose', () => {
    const values = fixture();
    const { input, candidate } = assertSharedFigure(values);
    const { document } = compose(input, [candidate]);
    const images = collectFigureImageNodes(document.markdown);
    assert.equal(images.length, 1);
    assert.equal(images[0].assetPath, 'generated/figures/columns-0.png');
    assert.ok(document.markdown.includes(`![${values.caption}](generated/figures/columns-0.png)`));
    assert.equal(document.markdown.split('Fig. 12.').length - 1, 1);
    assert.equal(document.markdown.includes('images/upper.png'), false);
    assert.equal(document.markdown.includes('images/lower.png'), false);
    assertBodiesPreserved(document, values.bodies);
});

test('owns a native short title at the lower picture edge without reading the prose on its baseline', () => {
    const values = fixture();
    const { input, candidate } = assertSharedFigure(values);
    const title = input.blocks.find(block => block.text === TITLE);
    assert.ok(title, 'the lower picture title must remain available before composition');
    assert.equal(title.role, 'figure-text');
    assert.ok(candidate.ownedTextBlockIds.includes(title.id));
    const ownedText = candidate.ownedTextBlockIds.map(id => input.blocks.find(block => block.id === id).text);
    assert.deepEqual(ownedText, [TITLE]);
    const { document } = compose(input, [candidate]);
    assert.equal(document.markdown.includes(TITLE), false);
    assertBodiesPreserved(document, values.bodies);
});

test('still composes the whole figure when the lower picture title has no native PDF text', () => {
    const values = fixture({ nativeTitle: false });
    const { input, candidate } = assertSharedFigure(values);
    const { document } = compose(input, [candidate]);
    assert.equal(collectFigureImageNodes(document.markdown).length, 1);
    assert.equal(document.markdown.split(values.caption).length - 1, 1);
    assert.equal(document.markdown.includes(TITLE), false);
    assertBodiesPreserved(document, values.bodies);
});

test('repeating native caption restoration leaves the repaired blocks and caption ownership unchanged', () => {
    const values = fixture();
    const { input } = assertSharedFigure(values);
    const ir = input.providerState.mineruDocument.ir;
    const blocks = structuredClone(ir.blocks);
    const moves = structuredClone(ir.captionMoves || []);
    const released = structuredClone(ir.releasedCaptions || []);
    restorePDFFigureCaptions(ir, values.pdfText);
    assert.deepEqual(ir.blocks, blocks);
    assert.deepEqual(ir.captionMoves || [], moves);
    assert.deepEqual(ir.releasedCaptions || [], released);
});

test('does not absorb a neighbouring independently captioned figure into the stacked pair', () => {
    const values = fixture({ separateFigure: true });
    const { input, candidates } = candidatesFor(values);
    assertNoBodyCaptions(input, values.bodies);
    assert.equal(candidates.length, 2, summary(candidates));
    const shared = candidates.find(candidate => candidate.label === 'Fig. 12.');
    const independent = candidates.find(candidate => candidate.label === 'Fig. 13.');
    assert.ok(shared && independent, summary(candidates));
    assert.equal(shared.panelBlockIds.length, 2);
    assert.equal(independent.panelBlockIds.length, 1);
    assert.ok(candidates.every(candidate => candidate.decision === 'compose'), summary(candidates));
    assert.ok(shared.panelBlockIds.every(id => !independent.panelBlockIds.includes(id)));
    const { document } = compose(input, candidates);
    assert.equal(collectFigureImageNodes(document.markdown).length, 2);
    assert.equal(document.markdown.split(values.caption).length - 1, 1);
    assert.equal(document.markdown.split(values.independentCaption).length - 1, 1);
    assertBodiesPreserved(document, values.bodies);
});

test('keeps body prose between the upper and lower pictures outside every composed group', () => {
    const values = fixture({ interveningBody: true, withTitle: false });
    const { input, candidates } = candidatesFor(values);
    assertNoBodyCaptions(input, values.bodies);
    const panels = input.blocks.filter(block => block.role === 'panel');
    assert.equal(panels.length, 2);
    assert.ok(candidates.every(candidate => candidate.decision !== 'compose'
        || candidate.panelBlockIds.length < 2), summary(candidates));
    const composable = candidates.filter(candidate => candidate.decision === 'compose');
    const document = composable.length ? compose(input, composable).document : prepareMinerUResult(input);
    assertBodiesPreserved(document, values.bodies);
    assert.equal(document.markdown.split(values.caption).length - 1, 1);
});

for (const bodySize of [10, CAPTION_SIZE]) {
    test(`uses the complete numbered OCR caption box to separate columns without body layout at size ${bodySize}`, () => {
        const values = fixture({ bodySize, bodyLayout: false, withTitle: false, bodyLineCount: 6 });
        const { input, candidates } = candidatesFor(values);
        assertNoBodyCaptions(input, values.bodies);
        assert.equal(input.markdown.split('Fig. 12.').length - 1, 1);
        assert.equal(candidates.length, 1, summary(candidates));
        const [candidate] = candidates;
        assert.equal(candidate.decision, 'compose', summary(candidates));
        assert.equal(candidate.panelBlockIds.length, 2);
        assert.equal(candidate.captionBlockIds.length, 1);
        assert.equal(input.blocks.find(block => block.id === candidate.captionBlockIds[0]).text, values.caption);
        const { document } = compose(input, [candidate]);
        assert.equal(collectFigureImageNodes(document.markdown).length, 1);
        assert.equal(document.markdown.split(values.caption).length - 1, 1);
        assert.ok(document.sourceMap.length > 0);
        assert.ok(document.sourceMap.every(entry => isValidSourceMapEntry(entry, document.markdown.length)));
    });
}

test('native caption repair preserves the neighbouring OCR body blocks byte for byte', () => {
    const values = fixture();
    const ir = ingestMinerULayout(values.result.layout, { assets: values.result.assets });
    attachPDFGeometry(ir, values.pdfText);
    classifyBlocks(ir);
    const bodies = ir.blocks.filter(block => values.bodies.some(body => blockPlainText(block) === body.text));
    assert.equal(bodies.length, values.bodies.length);
    const before = structuredClone(bodies);
    const legendTexts = () => ir.blocks.flatMap(block => block.children || [])
        .filter(child => child.kind === 'caption')
        .map(child => child.nativeText || blockPlainText(child))
        .filter(value => value.startsWith('Fig. 12.'));
    assert.deepEqual(legendTexts(), [values.caption], 'the original OCR has one complete legend');
    assert.equal(ir.blocks[0].children.some(child => child.kind === 'caption'), false);
    restorePDFFigureCaptions(ir, values.pdfText);
    assert.deepEqual(bodies, before);
    assert.deepEqual(legendTexts(), [values.caption], 'native recovery must not invent a competing legend');
    assert.equal(ir.blocks[0].children.some(child => child.kind === 'caption'), false);
    for (const block of ir.blocks) {
        for (const child of block.children || []) {
            if (child.kind !== 'caption') continue;
            const value = child.nativeText || blockPlainText(child);
            assert.ok(values.bodies.every(body => body.lines.every(line => !value.includes(line))), value);
        }
    }
});

for (const gutter of [GUTTER, 160]) {
    test(`keeps superscript caption continuations when only the first line shares a column baseline across gap ${gutter}`, () => {
        const left = 60;
        const right = left + COLUMN_WIDTH + gutter;
        const neighbour = BODY_LINES[0];
        const first = 'Fig. 14. Measurements across the reference conditions';
        const second = 'The complete description includes both independent trials';
        const result = {
            assets: [{ path: 'images/single.png', mimeType: 'image/png', data: createTestPNG() }],
            layout: projectMinerULayout({ _backend: 'synthetic', _version_name: '3.4.5', pdf_info: [{
                page_idx: 0, page_size: [PAGE, PAGE], discarded_blocks: [], para_blocks: [
                    picture('image', [left, 100, left + COLUMN_WIDTH, 288], 'single.png'),
                    text('text', [right, 300, right + 240, 310], neighbour),
                ],
            }] }),
        };
        const pdfText = { pages: [{ pageIndex: 0,
            viewport: { width: PAGE, height: PAGE, transform: [1, 0, 0, -1, 0, PAGE] },
            items: [
                pdfLine(first, 300, { left, width: 410, size: 10 }),
                pdfLine('2', 302, { left: left + 416, width: 6, size: 6 }),
                pdfLine(second, 310, { left, width: 410, size: 10 }),
                pdfLine('3', 312, { left: left + 416, width: 6, size: 6 }),
                pdfLine(neighbour, 300, { left: right, width: 240, size: 10 }),
            ],
        }] };
        const ir = ingestMinerULayout(result.layout, { assets: result.assets });
        attachPDFGeometry(ir, pdfText);
        classifyBlocks(ir);
        restorePDFFigureCaptions(ir, pdfText);
        const legends = ir.blocks.flatMap(block => block.children || [])
            .filter(child => child.kind === 'caption').map(blockPlainText);
        assert.deepEqual(legends, [`${first} 2 ${second} 3`]);
        const original = ir.blocks.find(block => blockPlainText(block) === neighbour);
        assert.equal(original.role, 'body');
        assert.equal(original.captionConsumed, undefined);
    });
}
