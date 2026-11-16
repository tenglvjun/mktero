import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createMinerUFigureInput, prepareMinerUResult } from '../src/mineru/document/prepare.js';
import { projectMinerULayout } from '../src/mineru/document/result-bundle.js';
import { FigureRestorationService } from '../src/figures/figure-restoration-service.js';
import { finalizeRestoredDocument } from '../src/figures/figure-finalization.js';
import { bindFigureSourceRanges } from '../src/figures/figure-source-binding.js';
import { resolveFigureCandidates } from '../src/figures/figure-region-resolver.js';
import { documentFigureRequest, documentFigureCandidate } from '../src/figures/figure-document.js';
import { planFigureReplacement, composeFigureDraft } from '../src/figures/figure-transaction.js';
import { isValidSourceMapEntry } from '../src/core/markdown-source-map.js';
import { sha256Hex } from '../src/core/sha256.js';
import { analyzeMarkdownFigureReferences } from '../src/markdown/markdown-figure-references.js';
import { extractMarkdownAssetOutline } from '../src/markdown/markdown-asset-outline.js';
import { createTestPNG } from './helpers/figure-fixtures.js';

const hash = data => sha256Hex(data, { crypto: webcrypto });
const CAPTION = 'FIGURE 9 Sensitivity of the estimated response.';
const REAL_TABLE = '<table><tr><td>Participant</td><td>Baseline</td></tr><tr><td>A</td><td>12</td></tr></table>';
const FRAGMENT = '<table><tr><td>Study</td><td>Weight</td></tr><tr><td>A</td><td>0.5</td></tr></table>';
const VISUAL = [200, 100, 800, 400];

function text(bbox, content, type = 'text') {
    return { type, bbox, lines: [{ bbox, spans: [{ type: 'text', bbox, content }] }] };
}

function visual(type, bbox, name, html, caption) {
    return { type, bbox, blocks: [
        { type: `${type}_body`, bbox, lines: [{ bbox, spans: [{ type: html ? 'table' : 'image', bbox,
            image_path: name, ...(html ? { html } : {}) }] }] },
        ...(caption ? [text([100, 620, 600, 640], caption, `${type}_caption`)] : []),
    ] };
}

function fixture({ noPDF = false } = {}) {
    const blocks = [
        visual('table', [200, 100, 500, 400], 'left.png', FRAGMENT),
        visual('image', [550, 100, 800, 400], 'right.png'),
        text([100, 430, 470, 445], 'Sensitivity of the estimated response.'),
        visual('table', [100, 650, 900, 800], 'table.png', REAL_TABLE, 'Table 1. Baseline values.'),
        text([100, 900, 900, 940], 'Body prose refers to Figure 9 and Table 1.'),
    ];
    const pdfText = { pages: [{ pageIndex: 0,
        viewport: { width: 1000, height: 1000, transform: [1, 0, 0, -1, 0, 1000] },
        items: [
            { text: 'FIGURE 9', width: 48, height: 8, transform: [8, 0, 0, 8, 100, 575] },
            { text: 'Sensitivity of the estimated response.', width: 230, height: 10,
                transform: [10, 0, 0, 10, 100, 555] },
        ] }] };
    return createMinerUFigureInput({
        markdown: 'unused', assetBasePath: '',
        assets: ['left.png', 'right.png', 'table.png'].map(name => ({
            path: `images/${name}`, mimeType: 'image/png', data: createTestPNG(),
        })),
        layout: projectMinerULayout({ _backend: 'hybrid', _version_name: '3.4.4', pdf_info: [
            { page_idx: 0, page_size: [1000, 1000], discarded_blocks: [], para_blocks: blocks },
        ] }),
    }, { pdfText: noPDF ? null : pdfText });
}

const MIXED_LINES = [
    'Figure 12. (a) Individual profiles over time; (b) Density of measured values and participant attributes;',
    '(c) Profiles of six participants with estimated trends; (d) Autocorrelation for each participant;',
    '(e) Proportion of reported symptoms, where Yes indicates that an event was reported at least once',
    'and No indicates that it was never reported during the observation period.',
];
const MIXED_CAPTION = MIXED_LINES.join(' ');
const MIXED_BOX = [100, 100, 900, 450];

function mixedFixture({ noPDF = false, conflict = false, prose = false, duplicate = false,
    wrongOCR = false, wrongLocation = false, wrongText = false } = {}) {
    const captionBox = [180, 470, 900, 521];
    const panel = (type, bbox, name, caption, captionBBox, html) => {
        const block = visual(type, bbox, name, html);
        if (caption) block.blocks.push(text(captionBBox, caption, `${type}_caption`));
        return block;
    };
    const blocks = [
        panel('chart', [100, 100, 350, 260], 'a.png', '(a)', [100, 100, 120, 115]),
        panel('chart', [100, 280, 350, 450], 'b.png', duplicate ? '(a)' : null, [100, 280, 120, 295]),
        panel('chart', [380, 100, 650, 450], 'cd.png', '(e)', [630, 100, 650, 115]),
        panel('table', [680, 100, 900, 310], 'e1.png', conflict ? 'Table 2. Independent results.' : null,
            [680, 80, 900, 95], FRAGMENT),
        panel('table', [680, 325, 900, 390], 'e2.png', null, null, REAL_TABLE),
        panel('table', [680, 405, 900, 450], 'e3.png',
            wrongOCR ? MIXED_CAPTION.replace('Figure 12.', 'Figure 13.')
                : wrongText ? MIXED_CAPTION.replace('Profiles of six', 'Profiles of nine') : MIXED_CAPTION,
            wrongLocation ? [180, 780, 900, 831] : captionBox),
        text([100, 600, 900, 635], 'Body prose after the caption must remain readable.'),
        text([100, 650, 900, 685], 'Another body paragraph set at the same size as the legend.'),
    ];
    if (prose) blocks.push(text([120, 266, 320, 276], 'Intervening article prose.'));
    const pdfItem = (value, left, top, width) => ({ text: value, width, height: 9,
        transform: [9, 0, 0, 9, left, 1000 - top - 9] });
    const pdfText = { pages: [{ pageIndex: 0,
        viewport: { width: 1000, height: 1000, transform: [1, 0, 0, -1, 0, 1000] },
        items: [
            ...MIXED_LINES.map((line, index) => pdfItem(line, 180, 470 + index * 14, index === 3 ? 500 : 720)),
            pdfItem('Body prose after the caption must remain readable.', 100, 600, 800),
            pdfItem('Another body paragraph set at the same size as the legend.', 100, 650, 800),
        ],
    }] };
    return createMinerUFigureInput({
        markdown: 'unused', assetBasePath: '',
        assets: ['a.png', 'b.png', 'cd.png', 'e1.png', 'e2.png', 'e3.png'].map(name => ({
            path: `images/${name}`, mimeType: 'image/png', data: createTestPNG(),
        })),
        layout: projectMinerULayout({ _backend: 'hybrid', _version_name: '3.4.4', pdf_info: [
            { page_idx: 0, page_size: [1000, 1000], discarded_blocks: [], para_blocks: blocks },
        ] }),
    }, { pdfText: noPDF ? null : pdfText });
}

function verified(request) {
    assert.equal(request.mode, 'document-figure');
    assert.equal(request.panels.length, 2);
    assert.equal(request.caption.text, CAPTION);
    return { bbox: VISUAL, captionBBox: request.caption.bbox, rotation: 0,
        crop: { data: createTestPNG(600, 300), mimeType: 'image/png', width: 600, height: 300 } };
}

function harness(recover, limits) {
    const calls = { recover: 0, close: 0 };
    const service = new FigureRestorationService({ hash, limits, openPDF: async () => ({
        getPageGeometry: async () => ({ pageIndex: 0, width: 1000, height: 1000,
            rotation: 0, userUnit: 1, coordinateFrame: 'display-cropbox',
            viewBox: [0, 0, 1000, 1000], viewportTransform: [1, 0, 0, -1, 0, 1000] }),
        recoverImageGroup: async request => { calls.recover++; return recover(request); },
        renderRegion: async () => { throw new Error('Reuse the verified native crop'); },
        close: async () => { calls.close++; },
    }) });
    return { service, calls };
}

test('replaces all verified table and chart fragments with one figure and one complete caption', async () => {
    const input = fixture();
    const before = structuredClone(input);
    assert.ok(input.markdown.includes(FRAGMENT), 'The OCR table stays readable before verification');
    const { service, calls } = harness(verified);
    const draft = await service.restore(input, { fileData: Uint8Array.of(1) });
    assert.equal(draft.blueprints.length, 1, JSON.stringify(draft.preserved));
    const document = await finalizeRestoredDocument(input, draft, { prepare: prepareMinerUResult, hash });
    assert.ok(!document.markdown.includes(FRAGMENT));
    assert.ok(document.markdown.includes(REAL_TABLE));
    assert.ok(document.markdown.includes('Body prose refers to Figure 9 and Table 1.'));
    assert.equal(document.markdown.split(CAPTION).length - 1, 1);
    assert.equal(document.markdown.split('Sensitivity of the estimated response.').length - 1, 1,
        'Do not leave a second detached OCR description');
    assert.equal(document.markdown.includes('images/right.png'), false);
    assert.match(document.markdown, /!\[FIGURE 9[^\]]+\]\(generated\/figures\//u);
    const figure = document.figureMap.figures[0];
    assert.equal(figure.label, 'FIGURE 9');
    assert.equal(figure.panels.length, 2);
    assert.deepEqual(figure.visualBBox, VISUAL);
    const references = analyzeMarkdownFigureReferences(document.markdown);
    assert.deepEqual(references.targets.map(target => target.id), ['figure:9']);
    assert.deepEqual(references.references.map(reference => reference.targetId), ['figure:9']);
    const outline = extractMarkdownAssetOutline(document.markdown);
    assert.equal(outline.find(item => item.type === 'figure')?.text, CAPTION);
    assert.ok(figure.provenance.fragments.some(fragment => fragment.markdown.includes(FRAGMENT)));
    assert.ok(document.sourceMap.every(entry => isValidSourceMapEntry(entry, document.markdown.length)));
    assert.deepEqual(input, before);
    assert.deepEqual(calls, { recover: 1, close: 1 });
});

for (const kind of ['missing', 'failure', 'rotation', 'body-overlap', 'caption-overlap', 'caption-location', 'panel-trim']) {
    test(`keeps the table HTML and original chart when native verification has ${kind}`, async () => {
        const input = fixture();
        const { service } = harness(request => {
            if (kind === 'missing') return null;
            if (kind === 'failure') throw new Error('No native image evidence');
            const result = verified(request);
            if (kind === 'rotation') result.rotation = 90;
            if (kind === 'body-overlap') result.bbox = [100, 100, 900, 950];
            if (kind === 'caption-overlap') result.bbox = [200, 100, 800, 445];
            if (kind === 'caption-location') result.captionBBox = [100, 500, 600, 520];
            if (kind === 'panel-trim') result.bbox = [420, 100, 800, 400];
            return result;
        });
        const draft = await service.restore(input, { fileData: Uint8Array.of(1) });
        assert.equal(draft.blueprints.length, 0);
        assert.equal(draft.input.markdown, input.markdown);
        assert.ok(draft.input.markdown.includes(FRAGMENT));
        assert.ok(draft.input.markdown.includes('images/right.png'));
        const references = analyzeMarkdownFigureReferences(draft.input.markdown);
        assert.equal(references.references.length, 0, 'Preserved table fragments must not become an image reference target');
    });
}

test('does not infer a mixed figure from table shape without local PDF caption evidence', () => {
    const input = fixture({ noPDF: true });
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));
    assert.equal(candidates.some(candidate => candidate.nativeFigure), false);
    assert.ok(input.markdown.includes(FRAGMENT));
});

test('rejects a native transaction unless every panel carries matching verified geometry', async () => {
    const { service } = harness(verified);
    const { input } = await service.restore(fixture(), { fileData: Uint8Array.of(1), mode: 'plan' });
    const original = resolveFigureCandidates(input).find(candidate => candidate.nativeFigure);
    const request = documentFigureRequest(input, original, { remaining: 1_000_000 });
    const result = verified(request);
    const candidate = documentFigureCandidate(original, request, result, input.pages[0]);
    assert.ok(candidate);
    for (const kind of ['missing-panel', 'wrong-box', 'wrong-owner']) {
        const broken = structuredClone(candidate);
        const bound = structuredClone(input);
        if (kind === 'missing-panel') delete broken.panelBBoxes[broken.panelBlockIds[1]];
        if (kind === 'wrong-box') broken.panelBBoxes[broken.panelBlockIds[1]] = [0, 0, 10, 10];
        if (kind === 'wrong-owner') {
            const panel = bound.blocks.find(block => block.id === broken.panelBlockIds[1]);
            panel.pdfFigure.label = 'FIGURE 10';
        }
        const blueprint = { candidate: broken, crop: result.crop, assetPath: 'generated/figures/test.png' };
        assert.throws(() => planFigureReplacement(bound, blueprint), error => (
            error.preserveReason === 'ambiguous-membership'
        ));
        const draft = composeFigureDraft(bound, [blueprint]);
        assert.equal(draft.blueprints.length, 0);
        assert.equal(draft.input.markdown, input.markdown);
        assert.equal(draft.preserved[0].reason, 'ambiguous-membership');
    }
});

test('verifies a mixed group with more OCR fragments than logical panels and a body-sized caption', async () => {
    const input = mixedFixture();
    const fallback = mixedFixture({ noPDF: true });
    assert.equal(input.markdown, fallback.markdown, 'A proposal must not rewrite fallback Markdown');
    assert.ok(input.markdown.includes(FRAGMENT));
    assert.ok(input.markdown.includes(REAL_TABLE));
    assert.ok(input.markdown.includes(`![${MIXED_CAPTION}](images/e3.png)`));
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));
    const candidate = candidates.find(value => value.nativeFigure);
    assert.ok(candidate, JSON.stringify(candidates));
    assert.equal(candidate.preservePanelBounds, true);
    assert.equal(candidate.panelBlockIds.length, 6, 'Five logical panels occupy six OCR fragments');
    assert.equal(candidate.captionBlockIds.length, 1);
    assert.equal(candidate.ownedTextBlockIds.length, 2, 'The misplaced letter stays within the verified figure');
    const { service, calls } = harness(request => {
        assert.equal(request.caption.text, MIXED_CAPTION);
        assert.equal(request.preservePanelBounds, true);
        assert.equal(request.panels.length, 6);
        return { bbox: MIXED_BOX, captionBBox: request.caption.bbox, rotation: 0,
            crop: { data: createTestPNG(800, 350), mimeType: 'image/png', width: 800, height: 350 } };
    });
    const draft = await service.restore(input, { fileData: Uint8Array.of(1) });
    assert.equal(draft.blueprints.length, 1, JSON.stringify(draft.preserved));
    const document = await finalizeRestoredDocument(input, draft, { prepare: prepareMinerUResult, hash });
    assert.equal(document.figureMap.figures.length, 1);
    assert.equal(document.figureMap.figures[0].panels.length, 6);
    assert.equal(document.markdown.split(MIXED_CAPTION).length - 1, 1);
    assert.equal(document.markdown.includes(FRAGMENT), false);
    assert.equal(document.markdown.includes(REAL_TABLE), false);
    assert.equal(/images\/(?:a|b|cd|e[123])\.png/u.test(document.markdown), false);
    assert.ok(document.markdown.includes('Body prose after the caption must remain readable.'));
    assert.ok(document.sourceMap.every(entry => isValidSourceMapEntry(entry, document.markdown.length)));
    assert.deepEqual(calls, { recover: 1, close: 1 });
});

for (const kind of ['missing', 'failure', 'trimmed-vector-edge', 'intervening-prose']) {
    test(`keeps every mixed fragment and the embedded caption after ${kind}`, async () => {
        const input = mixedFixture({ prose: kind === 'intervening-prose' });
        const before = structuredClone(input);
        const { service } = harness(request => {
            if (kind === 'missing') return null;
            if (kind === 'failure') throw new Error('Unverified PDF image');
            return { bbox: kind === 'intervening-prose' ? MIXED_BOX : [105, 100, 900, 450],
                captionBBox: request.caption.bbox, rotation: 0,
                crop: { data: createTestPNG(), mimeType: 'image/png', width: 8, height: 8 } };
        });
        const draft = await service.restore(input, { fileData: Uint8Array.of(1) });
        assert.equal(draft.blueprints.length, 0);
        const document = await finalizeRestoredDocument(input, draft, { prepare: prepareMinerUResult, hash });
        assert.equal(document.markdown, input.markdown);
        assert.ok(document.markdown.includes(FRAGMENT));
        assert.ok(document.markdown.includes(REAL_TABLE));
        assert.ok(document.markdown.includes('images/e3.png'));
        assert.deepEqual(input, before);
    });
}

for (const kind of ['noPDF', 'conflict', 'duplicate', 'wrongOCR', 'wrongLocation', 'wrongText']) {
    test(`does not propose a mixed figure with ${kind}`, () => {
        const input = mixedFixture({ [kind]: true });
        assert.equal(input.providerState.mineruDocument.ir.blocks.some(block => block.pdfFigureProposal), false);
        assert.ok(input.markdown.includes(FRAGMENT));
    });
}

test('keeps a resolved chart group when an independent uncaptioned table is beside it', () => {
    const caption = 'Figure 6. (a) Response profile; (b) Control profile.';
    const captionBox = [100, 430, 650, 445];
    const right = visual('chart', [380, 100, 650, 400], 'right.png');
    right.blocks.push(text(captionBox, caption, 'chart_caption'));
    const bundle = {
        markdown: 'unused', assetBasePath: '',
        assets: ['left.png', 'right.png', 'table.png'].map(name => ({
            path: `images/${name}`, mimeType: 'image/png', data: createTestPNG(),
        })),
        layout: projectMinerULayout({ _backend: 'hybrid', _version_name: '3.4.4', pdf_info: [{
            page_idx: 0, page_size: [1000, 1000], discarded_blocks: [], para_blocks: [
                visual('chart', [100, 100, 350, 400], 'left.png'), right,
                visual('table', [680, 100, 900, 400], 'table.png', REAL_TABLE),
            ],
        }] }),
    };
    const pdfText = { pages: [{ pageIndex: 0,
        viewport: { width: 1000, height: 1000, transform: [1, 0, 0, -1, 0, 1000] },
        items: [{ text: caption, width: 550, height: 9, transform: [9, 0, 0, 9, 100, 561] }],
    }] };
    for (const options of [{}, { pdfText }]) {
        const input = createMinerUFigureInput(bundle, options);
        const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));
        assert.ok(candidates.some(candidate => candidate.decision === 'compose' && candidate.panelBlockIds.length === 2),
            JSON.stringify(candidates));
        assert.equal(input.providerState.mineruDocument.ir.blocks.some(block => block.pdfFigureProposal), false);
        assert.ok(input.markdown.includes(REAL_TABLE));
    }
});

test('keeps the original mixed figure when a table fragment has no asset', async () => {
    const input = mixedFixture();
    input.assets = input.assets.filter(asset => asset.path !== 'images/e2.png');
    const { service, calls } = harness(() => { throw new Error('Every fragment needs its source image'); });
    const draft = await service.restore(input, { fileData: Uint8Array.of(1) });
    assert.equal(draft.blueprints.length, 0);
    assert.equal(draft.input.markdown, input.markdown);
    assert.equal(calls.recover, 0);
});

test('restores the real six-fragment chart and table figure with its complete caption', {
    skip: !process.env.MKTERO_FIGURE_CORPUS,
}, async t => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { createCanvas, loadImage, DOMMatrix, Path2D, ImageData } = await import('@napi-rs/canvas');
    Object.assign(globalThis, { DOMMatrix, Path2D, ImageData });
    const { createPDFJSTextEngine } = await import('../src/pdf/pdfjs-text-engine.js');
    const { createPDFFigureRegionRenderer } = await import('../src/pdf/pdfjs-figure-region.js');
    const { extractMinerUResultFromZip } = await import('../src/mineru/zip-markdown.js');
    const { readOriginPDFFromArchive } = await import('../scripts/reading-corpus-check.mjs');
    let archive;
    try {
        archive = new Uint8Array(await readFile(join(process.env.MKTERO_FIGURE_CORPUS,
            'oliveira-2021-modelling.zip')));
    }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        t.skip('The local corpus has no mixed chart-and-table fixture');
        return;
    }
    const fileData = readOriginPDFFromArchive(archive);
    assert.ok(fileData, 'The local corpus archive must include its original PDF');
    const engine = createPDFJSTextEngine({ standardFontDataUrl: fileURLToPath(
        new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)
    ) });
    let pdfText;
    try { pdfText = await engine.extract(fileData); }
    finally { await engine.dispose(); }
    const input = createMinerUFigureInput(extractMinerUResultFromZip(archive), { pdfText });
    const renderer = createPDFFigureRegionRenderer({
        createCanvas,
        encodePNG: async canvas => new Uint8Array(await canvas.encode('png')),
        decodeImage: async asset => {
            const image = await loadImage(asset.data);
            return { image, width: image.width, height: image.height, close() {} };
        },
    });
    try {
        const service = new FigureRestorationService({ hash, openPDF: (...args) => renderer.open(...args) });
        const draft = await service.restore(input, { fileData });
        const document = await finalizeRestoredDocument(input, draft, { prepare: prepareMinerUResult, hash });
        const figure = document.figureMap.figures.find(item => item.pageIndex === 8 && item.label === 'Figure 7.');
        assert.ok(figure, JSON.stringify(document.figureMap.preserved));
        assert.equal(figure.panels.length, 6);
        for (const panel of figure.panels) {
            assert.ok(figure.visualBBox[0] <= panel.bbox[0] && figure.visualBBox[1] <= panel.bbox[1]
                && figure.visualBBox[2] >= panel.bbox[2] && figure.visualBBox[3] >= panel.bbox[3]);
            assert.equal(document.markdown.includes(panel.originalAssetPath), false);
        }
        assert.equal(document.markdown.split('Individual profiles of 2125 women over time').length - 1, 1);
        assert.ok(document.markdown.includes('otherwise.'));
        assert.ok(document.sourceMap.every(entry => isValidSourceMapEntry(entry, document.markdown.length)));
    }
    finally { await renderer.disposeAll(); }
});

test('keeps native recovery within planning, asset and comparison budgets', async () => {
    const input = fixture();
    for (const mode of ['plan', 'render']) {
        const { service, calls } = harness(verified, mode === 'render' ? { maxAssets: input.assets.length } : {});
        await service.restore(input, { fileData: Uint8Array.of(1), mode });
        assert.equal(calls.recover, 0);
    }
    const bound = bindFigureSourceRanges(input);
    const candidate = resolveFigureCandidates(bound).find(value => value.nativeFigure);
    assert.ok(candidate);
    assert.equal(documentFigureRequest(bound, candidate, { remaining: 0 }), null);
    assert.equal(resolveFigureCandidates(bound, { limits: { maxFigures: 0 } }).length, 0);
    assert.equal(resolveFigureCandidates(bound, { limits: { maxFiguresPerPage: 0 } }).length, 0);
    assert.equal(documentFigureCandidate(candidate, { panels: [], caption: { bbox: [0, 0, 1, 1] },
        foreignLocations: [] }, null, { rotation: 0 }), null);
});
