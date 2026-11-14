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
