import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { isValidSourceMapEntry } from '../src/core/markdown-source-map.js';
import { sha256Hex } from '../src/core/sha256.js';
import { analyzeDocumentFigures } from '../src/figures/figure-analysis.js';
import { finalizeRestoredDocument } from '../src/figures/figure-finalization.js';
import { validateFigureInput } from '../src/figures/figure-model.js';
import { resolveFigureCandidates } from '../src/figures/figure-region-resolver.js';
import {
    parseFigureRestorationInputJSON,
    serializeFigureRestorationInput,
} from '../src/figures/figure-restoration-input-serialization.js';
import { FigureRestorationService } from '../src/figures/figure-restoration-service.js';
import { bindFigureSourceRanges } from '../src/figures/figure-source-binding.js';
import { extractMarkdownAssetOutline } from '../src/markdown/markdown-asset-outline.js';
import { analyzeMarkdownFigureReferences } from '../src/markdown/markdown-figure-references.js';
import { findAcademicFigures, findAcademicTableGroups } from '../src/markdown/markdown-figures.js';
import { renderMarkdownHTML } from '../src/markdown/markdown-html.js';
import { analyzeMarkdownTableReferences } from '../src/markdown/markdown-table-references.js';
import { restorePDFFigureCaptions } from '../src/mineru/document/figure-captions.js';
import { createMinerUFigureInput, prepareMinerUResult } from '../src/mineru/document/prepare.js';
import { projectMinerULayout } from '../src/mineru/document/result-bundle.js';
import { createTestPNG } from './helpers/figure-fixtures.js';

const PAGE_SIZE = [1000, 1000];
const VIEWPORT_TRANSFORM = [1, 0, 0, -1, 0, 1000];
const hash = data => sha256Hex(data, { crypto: webcrypto });

function spanBlock(type, bbox, span) {
    return { type, bbox, lines: [{ bbox, spans: [{ bbox, ...span }] }] };
}

function text(type, bbox, content) {
    return spanBlock(type, bbox, { type: 'text', content });
}

function picture(bbox, name, children = []) {
    return { type: 'image', bbox, blocks: [
        spanBlock('image_body', bbox, { type: 'image', image_path: name }),
        ...children,
    ] };
}

function nativeLine(value, [left, top, right, bottom]) {
    const height = bottom - top;
    return { text: value, width: right - left, height, transform: [height, 0, 0, height, left, 1000 - bottom] };
}

function fixture(blocks, printed, images = []) {
    const bundle = {
        markdown: '',
        assets: images.map(name => ({ path: `images/${name}`, mimeType: 'image/png', data: createTestPNG() })),
        layout: projectMinerULayout({ _backend: 'synthetic', pdf_info: [{
            page_idx: 0, page_size: PAGE_SIZE, para_blocks: blocks, discarded_blocks: [],
        }] }),
    };
    const pdfText = { pages: [{ pageIndex: 0,
        viewport: { width: 1000, height: 1000, transform: VIEWPORT_TRANSFORM },
        items: printed.map(([value, box]) => nativeLine(value, box)),
    }] };
    return { bundle, pdfText, input: createMinerUFigureInput(bundle, { pdfText }) };
}

function imageSources(figure) {
    return figure.images.map(image => image.source.match(/\]\(([^)]+)\)$/u)?.[1]);
}

test('restores stacked legends to their own pictures when a neighboring column shares the baseline', () => {
    const upper = 'Fig. 8. Temperature measurements for the first experiment.';
    const lower = 'Fig. 9. Temperature measurements after repeating the experiment.';
    const right = 'Fig. 10. Pressure measurements from an independent experiment.';
    const upperBox = [75, 244, 463, 254];
    const lowerBox = [75, 434, 463, 444];
    const rightBox = [527, 244, 925, 254];
    const { input } = fixture([
        picture([70, 100, 465, 240], 'upper.png'),
        picture([70, 270, 465, 430], 'lower.png', [
            text('image_caption', upperBox, upper),
            text('image_caption', lowerBox, lower),
        ]),
        picture([527, 100, 925, 240], 'right.png', [text('image_caption', rightBox, right)]),
        text('text', [70, 550, 465, 630], 'A long paragraph continues the experiment in the left column.'),
        text('text', [527, 550, 925, 630], 'A different paragraph continues in the right column.'),
    ], [[upper, upperBox], [right, rightBox], [lower, lowerBox]], ['upper.png', 'lower.png', 'right.png']);
    const document = prepareMinerUResult(input);
    const figures = findAcademicFigures(document.markdown);
    assert.deepEqual(new Map(figures.map(figure => [figure.caption.text, imageSources(figure)])), new Map([
        [upper, ['images/upper.png']], [lower, ['images/lower.png']], [right, ['images/right.png']],
    ]));
    const views = analyzeDocumentFigures(document.markdown, { sourceMap: document.sourceMap });
    assert.ok(views.find(view => view.caption.text === upper).location.bbox[2] <= 465);
    assert.ok(views.find(view => view.caption.text === right).location.bbox[0] >= 527);
});

test('keeps existing captions when a competing caption assignment cannot be completed', () => {
    const upper = 'Fig. 8. Temperature measurements for the first experiment.';
    const lower = 'Fig. 9. Pressure measurements in conditions (a) and (b).';
    const upperBox = [75, 244, 463, 254];
    const lowerBox = [75, 434, 463, 444];
    const copy = text('image_caption', lowerBox, lower);
    const { bundle, input } = fixture([
        picture([70, 100, 465, 240], 'upper.png', [copy]),
        picture([70, 270, 465, 430], 'lower.png', [structuredClone(copy)]),
    ], [[upper, upperBox], [lower, lowerBox]], ['upper.png', 'lower.png']);
    assert.equal(prepareMinerUResult(input).markdown, prepareMinerUResult(bundle).markdown);
});

const SHARED = 'Fig. 12. Simulated response curves for three experimental conditions.';
const PANEL_NAMES = ['first.png', 'second.png', 'third.png'];
const PANEL_TEXT = ['(a) Unmodified signal', '(b) Filtered signal', '(c) Averaged signal'];

function describedGrid({ descriptions = PANEL_TEXT, caption = SHARED } = {}) {
    const boxes = [[95, 250, 290, 395], [313, 250, 508, 395], [201, 453, 396, 606]];
    const descriptionBoxes = [[105, 399, 280, 411], [320, 399, 489, 411], [210, 611, 370, 623]];
    const main = [96, 637, 506, 647];
    const blocks = boxes.map((box, index) => picture(box, PANEL_NAMES[index], [
        ...(index === 1 ? [] : [text('image_caption', descriptionBoxes[index], descriptions[index])]),
        ...(index === 2 ? [text('image_caption', main, caption)] : []),
    ]));
    blocks.push(text('text', [96, 690, 508, 735], 'The next paragraph discusses the stated response curves.'));
    return fixture(blocks, [[caption, main], ...descriptions.map((value, index) => [value, descriptionBoxes[index]])],
        PANEL_NAMES);
}

function restorationService(renderRegion) {
    return new FigureRestorationService({ hash, openPDF: async () => ({
        getPageGeometry: async () => ({ pageIndex: 0, width: 1000, height: 1000, rotation: 0, userUnit: 1,
            coordinateFrame: 'display-cropbox', viewBox: [0, 0, 1000, 1000], viewportTransform: VIEWPORT_TRANSFORM }),
        renderRegion,
        close: async () => {},
    }) });
}

test('keeps a verified multi-row set and its numbered legend through a cache round trip and crop fallback', async () => {
    const { input, pdfText } = describedGrid();
    validateFigureInput(input);
    const { ir } = input.providerState.mineruDocument;
    const before = structuredClone(ir.blocks);
    restorePDFFigureCaptions(ir, pdfText);
    assert.deepEqual(ir.blocks, before);

    const resumed = parseFigureRestorationInputJSON(serializeFigureRestorationInput(input).json, { document: input });
    assert.ok(resumed);
    assert.equal(resumed.rangesExplicit, true);
    const bound = bindFigureSourceRanges(resumed);
    const [candidate] = resolveFigureCandidates(bound);
    assert.equal(candidate.label, 'Fig. 12.');
    assert.equal(candidate.decision, 'compose');
    assert.equal(candidate.panelBlockIds.length, 3);
    const ownedText = candidate.ownedTextBlockIds.map(id => bound.blocks.find(block => block.id === id));
    assert.deepEqual(ownedText.map(block => block.text), PANEL_TEXT);
    for (const [index, block] of ownedText.entries()) {
        const [range] = block.sourceRanges;
        const panel = bound.blocks.find(member => member.assetPath === `images/${PANEL_NAMES[index]}`);
        assert.equal(block.parentId, panel.parentId);
        assert.equal(resumed.markdown.slice(range.from, range.to), PANEL_TEXT[index]);
        assert.ok(panel.sourceRanges[0].from < range.from && range.to < panel.sourceRanges[0].to);
    }
    const invalid = structuredClone(resumed);
    const embedded = invalid.blocks.find(block => block.id === ownedText[0].id);
    const image = invalid.blocks.find(block => block.assetPath === 'images/first.png');
    const pathFrom = image.sourceRanges[0].to - 'images/first.png)'.length;
    embedded.sourceRanges = [{ from: pathFrom, to: pathFrom + 6 }];
    assert.throws(() => bindFigureSourceRanges(invalid), { code: 'INVALID_EXPLICIT_RANGE' });

    const failed = await restorationService(async () => { throw new Error('Crop failed'); })
        .restore(resumed, { fileData: Uint8Array.of(1) });
    const fallback = await finalizeRestoredDocument(resumed, failed, { prepare: prepareMinerUResult, hash });
    assert.equal(fallback.figureMap.figures.length, 0);
    assert.equal(fallback.markdown, input.markdown);
    const [figure] = findAcademicFigures(fallback.markdown);
    assert.equal(figure.caption.text, SHARED);
    assert.deepEqual(figure.gridRows, [2, 1]);
    assert.deepEqual(figure.images.map(image => image.panelLabel), PANEL_TEXT);
    assert.deepEqual(imageSources(figure), PANEL_NAMES.map(name => `images/${name}`));
});

test('composes the full panel set with its own legend and a valid source map', async () => {
    const { input } = describedGrid();
    const service = restorationService(async () => ({
        data: createTestPNG(420, 400), mimeType: 'image/png', width: 420, height: 400,
    }));
    const draft = await service.restore(input, { fileData: Uint8Array.of(1) });
    assert.equal(draft.blueprints.length, 1, JSON.stringify(draft.preserved));
    const document = await finalizeRestoredDocument(input, draft, { prepare: prepareMinerUResult, hash });
    const [figure] = analyzeDocumentFigures(document.markdown, { figureMap: document.figureMap });
    assert.equal(figure.caption.text, SHARED);
    assert.deepEqual(figure.panels.map(panel => panel.originalAssetPath), PANEL_NAMES.map(name => `images/${name}`));
    assert.ok(figure.location.bbox[3] >= 623);
    assert.ok(document.markdown.includes('The next paragraph discusses the stated response curves.'));
    assert.ok(document.sourceMap.every(entry => isValidSourceMapEntry(entry, document.markdown.length)));
});

test('retains the OCR panel descriptions when the PDF leaves a conflicting panel sequence', () => {
    const { input } = describedGrid({
        descriptions: ['(a) Unmodified signal', '(b) Filtered signal', '(b) Averaged signal'],
    });
    const { ir } = input.providerState.mineruDocument;
    assert.ok(ir.blocks.every(block => !block.verifiedFigure));
    assert.match(input.markdown, /\(a\) Unmodified signal/u);
    assert.match(input.markdown, /\(b\) Averaged signal/u);
    assert.equal(input.markdown.match(/images\/(?:first|second|third)\.png/gu)?.length, 3);
});

test('rejects a group whose printed legend names different panel letters', () => {
    const { input } = describedGrid({ caption: 'Fig. 12. Simulated response curves for conditions (b–d).' });
    const { ir } = input.providerState.mineruDocument;
    assert.ok(ir.blocks.every(block => !block.verifiedFigure));
    assert.match(input.markdown, /\(a\) Unmodified signal/u);
    assert.match(input.markdown, /\(c\) Averaged signal/u);
});

const TABLE_BODY = '<table><tr><th>Method</th><th>Score</th></tr><tr><td>A &amp; B</td><td>3.40</td></tr></table>';
const TABLE_LABEL = 'TABLE IV';
const TABLE_TITLE = 'Median scores on the held-out set';
const TABLE_REFERENCE = 'Table II reports a separate experiment.';
const TABLE_BOX = [100, 320, 760, 440];
const TITLE_BOX = [100, 297, 570, 307];
const LABEL_BOX = [100, 280, 169, 290];
const REFERENCE_BOX = [100, 446, 760, 456];

function titledTable(printedTitle, labels = [[TABLE_LABEL, LABEL_BOX]]) {
    return fixture([
        { type: 'table', bbox: TABLE_BOX, blocks: [
            text('table_caption', TITLE_BOX, TABLE_TITLE),
            spanBlock('table_body', TABLE_BOX, { type: 'table', html: TABLE_BODY }),
        ] },
        text('text', REFERENCE_BOX, TABLE_REFERENCE),
    ], [...labels, [printedTitle, TITLE_BOX], [TABLE_REFERENCE, REFERENCE_BOX]]);
}

test('recovers a Roman table label from the printed title without rewriting the table or taking adjacent prose', () => {
    const { bundle, input } = titledTable(TABLE_TITLE);
    const original = prepareMinerUResult(bundle);
    const document = prepareMinerUResult(input);
    const tableHTML = markdown => /<table>[\s\S]+?<\/table>/u.exec(markdown)?.[0];
    assert.ok(tableHTML(original.markdown));
    assert.equal(tableHTML(document.markdown), tableHTML(original.markdown));
    assert.ok(document.markdown.includes(TABLE_REFERENCE));
    const [table] = findAcademicTableGroups(document.markdown);
    assert.equal(table.caption.label, TABLE_LABEL);
    assert.equal(table.caption.description, TABLE_TITLE);
    assert.deepEqual(analyzeMarkdownTableReferences(document.markdown).targets.map(target => target.id), ['table:iv']);
});

test('keeps an unlabeled table when the printed title disagrees or multiple labels could belong to it', () => {
    for (const { input } of [
        titledTable('Scores on the training set'),
        titledTable(TABLE_TITLE, [[TABLE_LABEL, LABEL_BOX], ['TABLE V', [100, 273, 169, 281]]]),
    ]) {
        const document = prepareMinerUResult(input);
        assert.ok(document.markdown.includes(TABLE_TITLE));
        assert.ok(document.markdown.includes(TABLE_REFERENCE));
        assert.deepEqual(findAcademicTableGroups(document.markdown), []);
    }
});

test('keeps a verified text-only figure selectable and linked to its PDF region in reading order', () => {
    const above = 'The previous discussion introduces the design principles.';
    const below = 'The next paragraph resumes the discussion.';
    const caption = 'Fig. 15. A checklist for reproducible measurements.';
    const title = ['Experimental checklist', [245, 206, 495, 216]];
    const rows = [
        ['• Record the reference measurement.', [172, 232, 525, 242]],
        ['• Repeat the measurement in every condition.', [172, 247, 551, 257]],
        ['• Keep the intermediate data.', [172, 262, 439, 272]],
    ];
    const captionBox = [100, 290, 620, 301];
    const { input, pdfText } = fixture([
        text('text', captionBox, caption),
        text('text', [100, 120, 800, 163], above),
        text('title', title[1], title[0]),
        ...rows.map(([value, box]) => text('text', box, value)),
        text('text', [100, 343, 800, 380], below),
    ], [title, ...rows, [caption, captionBox]]);
    const { ir } = input.providerState.mineruDocument;
    const before = structuredClone(ir.blocks);
    restorePDFFigureCaptions(ir, pdfText);
    assert.deepEqual(ir.blocks, before);
    const document = prepareMinerUResult(input);
    const { markdown, sourceMap } = document;
    const figureViews = analyzeDocumentFigures(markdown, { sourceMap });
    assert.equal(figureViews.length, 1);
    const [figure] = figureViews;
    assert.equal(figure.caption.text, caption);
    assert.deepEqual(figure.images, []);
    assert.ok(markdown.indexOf(above) < figure.from && figure.to < markdown.indexOf(below));
    const html = renderMarkdownHTML(markdown);
    assert.match(html, /<figure[^>]*>[\s\S]*<li>Record the reference measurement\.<\/li>[\s\S]*<figcaption>/u);
    assert.deepEqual(figure.location, { pageIndex: 0, bbox: [100, 206, 620, 301] });
    assert.deepEqual(extractMarkdownAssetOutline(markdown, [], { figureViews }).map(entry => entry.text), [caption]);
    const [target] = analyzeMarkdownFigureReferences(markdown, { figureViews }).targets;
    assert.deepEqual(target.location, figure.location);
    assert.ok(sourceMap.every(entry => isValidSourceMapEntry(entry, markdown.length)));
});

test('sanitizes markup and unsafe links inside a marked text figure', () => {
    const markdown = [
        '<!-- mktero-text-figure -->',
        '> <img src=x onerror=alert(1)>',
        '>',
        '> - [unsafe](javascript:alert%281%29)',
        '>',
        '> Fig. 2. Checklist.',
    ].join('\n');
    const html = renderMarkdownHTML(markdown);
    assert.match(html, /<figcaption>/u);
    assert.doesNotMatch(html, /<img\b|href="javascript:/iu);
});
