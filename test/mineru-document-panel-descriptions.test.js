import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { projectMinerULayout } from '../src/mineru/document/result-bundle.js';
import { createMinerUFigureInput, prepareMinerUResult } from '../src/mineru/document/prepare.js';
import { restorePDFFigureCaptions } from '../src/mineru/document/figure-captions.js';
import { bindFigureSourceRanges } from '../src/figures/figure-source-binding.js';
import { resolveFigureCandidates } from '../src/figures/figure-region-resolver.js';
import { FigureRestorationService } from '../src/figures/figure-restoration-service.js';
import { finalizeRestoredDocument } from '../src/figures/figure-finalization.js';
import { extractMarkdownAssetOutline } from '../src/markdown/markdown-asset-outline.js';
import { analyzeMarkdownFigureReferences } from '../src/markdown/markdown-figure-references.js';
import { isValidSourceMapEntry } from '../src/core/markdown-source-map.js';
import { sha256Hex } from '../src/core/sha256.js';
import { createTestPNG } from './helpers/figure-fixtures.js';
import { renderMarkdownHTML } from '../src/markdown/markdown-html.js';
import { parseHTML } from 'linkedom';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { inspectDocumentFigureImage } from '../src/pdf/pdfjs-document-figure.js';
import { FIGURE_LIMITS } from '../src/figures/figure-limits.js';

const LINES = [
    'Figure 37. Example interaction with the study interface.',
    'Participants select a category (A), its intensity (B), and a context (C).',
    'They then complete a practice exercise (eg, D or E).',
];
const CAPTION = LINES.join(' ');
const DESCRIPTIONS = ['(C) Select a context', '(D) Complete a practice exercise'];
const BODY = 'The article refers to Figure 37 and continues after the illustrated interaction.';
const hash = data => sha256Hex(data, { crypto: webcrypto });

function text(bbox, content, type = 'text') {
    return { type, bbox, lines: [{ bbox, spans: [{ type: 'text', bbox, content }] }] };
}

function fixture(change = () => {}) {
    const image = { type: 'image', bbox: [100, 210, 900, 700], blocks: [
        { type: 'image_body', bbox: [100, 210, 900, 700], lines: [{ bbox: [100, 210, 900, 700],
            spans: [{ type: 'image', bbox: [100, 210, 900, 700], image_path: 'interaction.png' }] }] },
        text([120, 705, 440, 725], DESCRIPTIONS[0], 'image_caption'),
        text([510, 705, 890, 735], DESCRIPTIONS[1], 'image_caption'),
    ] };
    const blocks = [text([90, 150, 910, 188], CAPTION), image, text([100, 800, 900, 830], BODY)];
    const items = [...LINES.map((value, index) => ({ text: value, width: 800, height: 9,
        transform: [9, 0, 0, 9, 90, 1000 - 150 - index * 14 - 9] })),
    { text: BODY, width: 800, height: 10, transform: [10, 0, 0, 10, 100, 180] }];
    change({ blocks, items, image });
    const result = { markdown: '', assets: [{ path: 'images/interaction.png',
        mimeType: 'image/png', data: createTestPNG() }],
    layout: projectMinerULayout({ _backend: 'vlm', _version_name: '3.4.5', pdf_info: [{
        page_idx: 0, page_size: [1000, 1000], para_blocks: blocks, discarded_blocks: [],
    }] }) };
    const pdfText = { pages: [{ pageIndex: 0,
        viewport: { width: 1000, height: 1000, transform: [1, 0, 0, -1, 0, 1000] }, items,
    }] };
    return { result, pdfText };
}

function inputFor(change) {
    const { result, pdfText } = fixture(change);
    return { input: createMinerUFigureInput(result, { pdfText }), result, pdfText };
}

function harness(recover) {
    return new FigureRestorationService({ hash, openPDF: async () => ({
        getPageGeometry: async () => ({ pageIndex: 0, width: 1000, height: 1000,
            rotation: 0, userUnit: 1, coordinateFrame: 'display-cropbox',
            viewBox: [0, 0, 1000, 1000], viewportTransform: [1, 0, 0, -1, 0, 1000] }),
        recoverImageGroup: recover,
        renderRegion: async () => { throw new Error('Only a verified native crop may be used'); },
        close: async () => {},
    }) });
}

function verified(request) {
    assert.equal(request.mode, 'document-figure');
    assert.equal(request.caption.text, CAPTION);
    assert.equal(request.ownedTextLocations.length, 2);
    return { bbox: [100, 210, 900, 737], captionBBox: request.caption.bbox, rotation: 0,
        crop: { data: createTestPNG(800, 527), mimeType: 'image/png', width: 800, height: 527 } };
}

test('proposes one verified figure without confusing lettered panel descriptions with its external legend', () => {
    const { input, result, pdfText } = inputFor();
    const ir = input.providerState.mineruDocument.ir;
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));
    assert.equal(candidates.length, 1);
    const [candidate] = candidates;
    assert.equal(candidate.nativeFigure, true);
    assert.equal(candidate.decision, 'preserve', 'the proposal cannot consume content before PDF image verification');
    assert.equal(candidate.label, 'Figure 37.');
    assert.equal(candidate.panelBlockIds.length, 1);
    assert.equal(candidate.captionBlockIds.length, 1);
    assert.equal(candidate.ownedTextBlockIds.length, 2);
    assert.deepEqual(candidate.ownedTextBlockIds.map(id => input.blocks.find(block => block.id === id).text), DESCRIPTIONS);
    assert.equal(input.markdown, createMinerUFigureInput(result).markdown);
    assert.equal(ir.blocks.find(block => block.id === 'p0-0').captionConsumed, undefined);
    const before = JSON.stringify(ir.blocks);
    restorePDFFigureCaptions(ir, pdfText);
    assert.equal(JSON.stringify(ir.blocks), before, 'proposal planning must be idempotent');
});

test('restores the complete picture, one selectable caption, its outline entry and body reference together', async () => {
    const { input } = inputFor();
    const draft = await harness(verified).restore(input, { fileData: Uint8Array.of(1) });
    assert.equal(draft.blueprints.length, 1, JSON.stringify(draft.preserved));
    const document = await finalizeRestoredDocument(input, draft, { prepare: prepareMinerUResult, hash });
    assert.equal(document.markdown.split(CAPTION).length - 1, 1);
    assert.ok(document.markdown.includes(BODY));
    assert.equal(document.markdown.includes(DESCRIPTIONS[0]), false);
    assert.equal(document.markdown.includes(DESCRIPTIONS[1]), false);
    assert.equal(document.markdown.includes('images/interaction.png'), false);
    assert.deepEqual(extractMarkdownAssetOutline(document.markdown).map(item => item.text), [CAPTION]);
    const references = analyzeMarkdownFigureReferences(document.markdown);
    assert.deepEqual(references.targets.map(target => target.id), ['figure:37']);
    assert.deepEqual(references.references.map(reference => reference.targetId), ['figure:37']);
    assert.ok(document.sourceMap.every(entry => isValidSourceMapEntry(entry, document.markdown.length)));
    const figure = document.figureMap.figures[0];
    assert.equal(figure.label, 'Figure 37.');
    assert.deepEqual(figure.visualBBox, [100, 210, 900, 737]);
    assert.ok(figure.provenance.fragments.some(fragment => fragment.markdown.includes(DESCRIPTIONS[0])));
});

for (const range of ['(a-f)', '(a–f)', '(A to F)']) {
    test(`accepts panel descriptions named by the complete caption range ${range}`, () => {
        const lines = [LINES[0], `The six alternatives are labeled ${range}.`, LINES[2]];
        const { input } = inputFor(({ blocks, items }) => {
            blocks[0].lines[0].spans[0].content = lines.join(' ');
            for (let index = 0; index < lines.length; index++) items[index].text = lines[index];
        });
        assert.equal(resolveFigureCandidates(bindFigureSourceRanges(input))[0].nativeFigure, true);
    });
}

for (const [formula, glyph] of [['\\alpha', 'α'], ['x^2', 'x²']]) {
    test(`verifies native PDF glyph ${glyph} while preserving the source TeX caption`, async () => {
        const lines = [...LINES];
        lines[0] = `Figure 37. Example interaction with ${glyph} in the study interface.`;
        const { result, pdfText } = fixture(({ blocks, items }) => {
            blocks[0].lines[0].spans = [
                { type: 'text', content: 'Figure 37. Example interaction with ' },
                { type: 'inline_equation', content: formula },
                { type: 'text', content: ' in the study interface. ' + LINES.slice(1).join(' ') },
            ];
            items[0].text = lines[0];
        });
        const raster = createCanvas(800, 490);
        const context = raster.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, 800, 490);
        context.fillStyle = '#111111';
        for (let index = 0; index < 8; index++) context.fillRect(20 + index * 100, 30, 50, 430);
        result.assets[0].data = new Uint8Array(raster.toBuffer('image/png'));
        const input = createMinerUFigureInput(result, { pdfText });
        const page = {
            rotate: 0, imageCoordinates: Float64Array.of(0.1, 0.21, 0.9, 0.21, 0.1, 0.737),
            getViewport: ({ scale }) => ({ width: 1000 * scale, height: 1000 * scale,
                transform: [scale, 0, 0, -scale, 0, 1000 * scale] }),
            getTextContent: async () => ({ items: pdfText.pages[0].items.map(item => ({ ...item, str: item.text })) }),
            render: ({ canvasContext, viewport }) => {
                const scale = viewport.width / 1000;
                canvasContext.fillStyle = '#ffffff';
                canvasContext.fillRect(0, 0, viewport.width, viewport.height);
                canvasContext.drawImage(raster, 100 * scale, 210 * scale, 800 * scale, 490 * scale);
                return { promise: Promise.resolve() };
            },
        };
        const decodeImage = async asset => {
            const image = await loadImage(Buffer.from(asset.data));
            return { image, width: image.width, height: image.height };
        };
        const draft = await harness(async request => {
            const evidence = await inspectDocumentFigureImage(page, request, {
                createCanvas, decodeImage, limits: FIGURE_LIMITS,
            });
            assert.ok(evidence, 'native caption, container, owned text and panel pixels must verify together');
            return { ...evidence,
                crop: { data: createTestPNG(800, 527), mimeType: 'image/png', width: 800, height: 527 } };
        }).restore(input, { fileData: Uint8Array.of(1) });
        assert.equal(draft.blueprints.length, 1, JSON.stringify(draft.preserved));
        const document = await finalizeRestoredDocument(input, draft, { prepare: prepareMinerUResult, hash });
        const { document: rendered } = parseHTML(renderMarkdownHTML(document.markdown));
        assert.equal(rendered.querySelector('.katex annotation')?.textContent, formula,
            'the native matching text must not overwrite source TeX');
        raster.width = raster.height = 0;
    });
}

test('retains inline links from the verified source paragraph when the complete figure replaces it', async () => {
    const { input } = inputFor(({ blocks }) => {
        const bbox = blocks[0].bbox;
        const [before, after] = CAPTION.split('Participants');
        blocks[0].lines[0].spans = [
            { type: 'text', bbox, content: before },
            { type: 'hyperlink', bbox, content: 'Participants', url: 'https://example.org/study' },
            { type: 'text', bbox, content: after },
        ];
    });
    const draft = await harness(verified).restore(input, { fileData: Uint8Array.of(1) });
    assert.equal(draft.blueprints.length, 1, JSON.stringify(draft.preserved));
    const document = await finalizeRestoredDocument(input, draft, { prepare: prepareMinerUResult, hash });
    const { document: rendered } = parseHTML(renderMarkdownHTML(document.markdown));
    assert.deepEqual([...rendered.querySelectorAll('a')].map(link => ({
        text: link.textContent, href: link.getAttribute('href'),
    })), [{ text: 'Participants', href: 'https://example.org/study' }]);
});

for (const failure of ['missing', 'exception', 'incomplete-picture', 'caption-overlap']) {
    test(`preserves every original fragment when native image verification has ${failure}`, async () => {
        const { input } = inputFor();
        const before = structuredClone(input);
        const draft = await harness(request => {
            if (failure === 'missing') return null;
            if (failure === 'exception') throw new Error('Native evidence unavailable');
            const value = verified(request);
            if (failure === 'incomplete-picture') value.bbox[3] = 700;
            if (failure === 'caption-overlap') value.bbox[1] = 150;
            return value;
        }).restore(input, { fileData: Uint8Array.of(1) });
        assert.equal(draft.blueprints.length, 0);
        assert.equal(prepareMinerUResult(draft.input).markdown, input.markdown);
        assert.deepEqual(input, before);
    });
}

for (const [reason, change] of [
    ['an unrelated numbered legend', ({ image }) => { image.blocks[1].lines[0].spans[0].content = 'Figure 38. Independent figure.'; }],
    ['an unmentioned panel', ({ image }) => { image.blocks[1].lines[0].spans[0].content = '(Z) Another measurement'; }],
    ['duplicate panel letters', ({ image }) => { image.blocks[2].lines[0].spans[0].content = '(C) Duplicate context'; }],
    ['a distant description', ({ image }) => { image.blocks[2].bbox = [510, 760, 890, 790]; }],
    ['an oversized description', ({ image }) => { image.blocks[2].lines[0].spans[0].content = '(D) ' + 'Unbounded description '.repeat(20); }],
    ['intervening body prose', ({ blocks }) => { blocks.push(text([100, 190, 900, 205], 'Independent body prose between the legend and its picture.')); }],
    ['body prose inside the alleged figure', ({ blocks }) => { blocks.push(text([100, 710, 900, 720], 'Independent article text cannot become image content.')); }],
    ['a second equally plausible picture', ({ blocks, image }) => { blocks.push(structuredClone(image)); }],
    ['incomplete native caption evidence', ({ items }) => { items.splice(2, 1); }],
]) {
    test(`does not propose a repair with ${reason}`, () => {
        const { input } = inputFor(change);
        assert.equal(resolveFigureCandidates(bindFigureSourceRanges(input)).some(candidate => candidate.nativeFigure), false);
        assert.ok(input.markdown.includes('images/interaction.png'));
    });
}

test('does not infer panel-description ownership without a PDF text layer', () => {
    const { result } = fixture();
    const input = createMinerUFigureInput(result);
    assert.equal(resolveFigureCandidates(bindFigureSourceRanges(input)).some(candidate => candidate.nativeFigure), false);
    assert.ok(input.markdown.includes(CAPTION));
    assert.ok(input.markdown.includes(DESCRIPTIONS[0]));
});
