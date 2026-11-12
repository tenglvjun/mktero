import test from 'node:test';
import assert from 'node:assert/strict';
import { captionedImageCandidate, captionedImageRequest } from '../src/figures/figure-captioned-image.js';
import { bindFigureSourceRanges } from '../src/figures/figure-source-binding.js';
import { resolveFigureCandidates } from '../src/figures/figure-region-resolver.js';
import { FigureRestorationService } from '../src/figures/figure-restoration-service.js';
import { sha256Hex } from '../src/core/sha256.js';
import { createTestPNG, makeFigureInput } from './helpers/figure-fixtures.js';

function fixture() {
    const original = makeFigureInput({ boxes: [[200, 150, 450, 450], [500, 150, 750, 450]] });
    const input = { ...bindFigureSourceRanges(original.input), rangesExplicit: true };
    const [candidate] = resolveFigureCandidates(input);
    assert.equal(candidate.decision, 'compose');
    const budget = { remaining: 10000 };
    const request = captionedImageRequest(input, candidate, budget);
    return { input, candidate, request, page: input.pages[0], budget };
}

function evidence() {
    return { bbox: [190, 100, 780, 470], captionBBox: [100, 880, 900, 900], rotation: 0,
        crop: { data: createTestPNG(590, 370), mimeType: 'image/png', width: 590, height: 370 } };
}

function service(recover, limits) {
    const calls = { recover: 0, render: 0, close: 0 };
    const restoration = new FigureRestorationService({
        hash: sha256Hex, limits,
        openPDF: async () => ({
            getPageGeometry: async () => ({ pageIndex: 0, width: 1000, height: 1000,
                rotation: 0, userUnit: 1, coordinateFrame: 'display-cropbox',
                viewBox: [0, 0, 1000, 1000], viewportTransform: [1, 0, 0, -1, 0, 1000] }),
            recoverImageGroup: async request => { calls.recover++; return recover(request); },
            renderRegion: async () => {
                calls.render++;
                return { data: createTestPNG(80, 60), mimeType: 'image/png', width: 80, height: 60 };
            },
            close: async () => { calls.close++; },
        }),
    });
    return { restoration, calls };
}

test('requests native image evidence without claiming any additional article text', () => {
    const { input, candidate, request, page, budget } = fixture();
    assert.equal(request.mode, 'captioned-region');
    assert.equal(request.panels.length, 2);
    assert.equal(request.caption.label, candidate.label);
    assert.ok(budget.remaining < 10000);
    for (const block of input.blocks.filter(block => ['caption', 'body'].includes(block.role))) {
        assert.ok(request.foreignLocations.some(location => location.bbox === block.bbox));
    }
    const before = structuredClone(candidate);
    const expanded = captionedImageCandidate(candidate, request, evidence(), page);
    assert.deepEqual(expanded.visualBBox, evidence().bbox);
    assert.deepEqual(expanded.captionBBox, candidate.captionBBox, 'Keep every caption line, not just the PDF first line');
    assert.deepEqual(expanded.panelBlockIds, candidate.panelBlockIds);
    assert.deepEqual(expanded.ownedTextBlockIds, candidate.ownedTextBlockIds);
    assert.deepEqual(candidate, before);
});

test('requires a resolved MinerU caption, geometry, assets and a comparison budget', () => {
    const mutations = [
        (input) => { input.provider = 'mistral'; },
        (input) => { input.rangesExplicit = false; },
        (_, candidate) => { candidate.decision = 'preserve'; },
        (_, candidate) => { candidate.label = null; },
        (_, candidate) => { candidate.captionBlockIds = []; },
        (input) => { input.pages[0].rotation = null; },
        (input) => { input.assets = []; },
        (input) => { input.blocks.find(block => block.role === 'body').bbox = null; },
        (input) => { input.blocks.find(block => block.role === 'panel').sourceRanges = []; },
    ];
    for (const mutate of mutations) {
        const { input, candidate } = fixture();
        mutate(input, candidate);
        assert.equal(captionedImageRequest(input, candidate, { remaining: 10000 }), null);
    }
    const { input, candidate } = fixture();
    assert.equal(captionedImageRequest(input, candidate, { remaining: 0 }), null);
});

for (const kind of ['missing', 'failure', 'shrink', 'foreign', 'wrong-rotation', 'wrong-caption', 'excess-growth', 'bad-crop']) {
    test(`retains the safe region and caption when boundary evidence is ${kind}`, async () => {
        const { input, candidate } = fixture();
        const before = structuredClone(input);
        const { restoration, calls } = service(() => {
            if (kind === 'missing') return null;
            if (kind === 'failure') throw new Error('Unavailable');
            const result = evidence();
            if (kind === 'shrink') result.bbox[0] = 220;
            if (kind === 'foreign') result.bbox[3] = 980;
            if (kind === 'wrong-rotation') result.rotation = 90;
            if (kind === 'wrong-caption') result.captionBBox = [100, 40, 900, 70];
            if (kind === 'excess-growth') result.bbox = [0, 0, 1000, 870];
            if (kind === 'bad-crop') result.crop.data = new Uint8Array();
            return result;
        });
        const draft = await restoration.restore(input, { fileData: Uint8Array.of(1) });
        assert.equal(draft.blueprints.length, 1);
        assert.deepEqual(draft.blueprints[0].visualBBox, candidate.visualBBox);
        assert.deepEqual(draft.blueprints[0].captionBBox, candidate.captionBBox);
        assert.deepEqual(input, before);
        assert.deepEqual(calls, { recover: 1, render: 1, close: 1 });
    });
}

test('publishes the verified expanded crop and skips evidence during planning or exhausted storage', async () => {
    const { input } = fixture();
    const { restoration, calls } = service(evidence);
    const events = [];
    const draft = await restoration.restore(input, { fileData: Uint8Array.of(1), onFigure: event => events.push(event) });
    assert.deepEqual(draft.blueprints[0].visualBBox, evidence().bbox);
    assert.deepEqual(events[0].candidate.visualBBox, evidence().bbox);
    assert.deepEqual(calls, { recover: 1, render: 0, close: 1 });
    for (const mode of ['plan', 'render']) {
        const run = service(evidence, mode === 'render' ? { maxAssets: input.assets.length } : undefined);
        await run.restoration.restore(input, { fileData: Uint8Array.of(1), mode });
        assert.equal(run.calls.recover, 0);
    }
});

test('cancels captioned image verification without mutating the source document', async () => {
    const { input } = fixture();
    const before = structuredClone(input);
    const controller = new AbortController();
    const { restoration, calls } = service(() => {
        controller.abort();
        return new Promise(() => {});
    });
    await assert.rejects(restoration.restore(input, { fileData: Uint8Array.of(1), signal: controller.signal }),
        { name: 'AbortError' });
    assert.deepEqual(input, before);
    assert.equal(calls.close, 1);
});
