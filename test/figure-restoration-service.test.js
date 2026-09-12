import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { makeFigureInput, createTestPNG } from './helpers/figure-fixtures.js';
import { FigureRestorationService } from '../src/figures/figure-restoration-service.js';
import { finalizeRestoredDocument } from '../src/figures/figure-finalization.js';
import { prepareMinerUResult } from '../src/mineru/mineru-result.js';
import { sha256Hex } from '../src/core/sha256.js';

const hash = data => sha256Hex(data, { crypto: webcrypto });
function service(options = {}) {
    let closed = 0;
    let opened = 0;
    let rendered = 0;
    const restoration = new FigureRestorationService({
        hash,
        openPDF: async () => {
            opened++;
            return {
                getPageGeometry: async () => ({ pageIndex: 0, width: 1000, height: 1000,
                    rotation: 0, userUnit: 1, coordinateFrame: 'display-cropbox',
                    viewBox: [0, 0, 1000, 1000], mediaBox: null,
                    viewportTransform: [1, 0, 0, -1, 0, 1000] }),
                renderRegion: async (...args) => {
                    rendered++;
                    if (options.render) return options.render(...args);
                    return { data: createTestPNG(800, 750), mimeType: 'image/png', width: 800, height: 750 };
                },
                close: async () => { closed++; },
            };
        },
        ...options,
    });
    return { restoration, counts: () => ({ opened, closed, rendered }) };
}

test('restores all panels and interior labels before prose preparation', async () => {
    const { input, bodyText, axisLabel } = makeFigureInput();
    const { restoration, counts } = service();
    const draft = await restoration.restore(input, { fileData: Uint8Array.of(1) });
    const document = await finalizeRestoredDocument(input, draft, { prepare: prepareMinerUResult, hash });
    assert.equal(document.figureMap.figures.length, 1);
    assert.equal(document.figureMap.figures[0].panels.length, 4);
    assert.ok(document.markdown.includes(bodyText));
    assert.ok(!document.markdown.includes(axisLabel));
    assert.deepEqual(counts(), { opened: 1, closed: 1, rendered: 1 });
});

test('retains original content when figure rendering fails or coordinates are missing', async () => {
    for (const missingGeometry of [false, true]) {
        const { input } = makeFigureInput();
        if (missingGeometry) input.pages[0].coordinateFrame = 'unknown';
        const { restoration, counts } = service({ render: async () => { throw new Error('failed'); } });
        const draft = await restoration.restore(input, { fileData: Uint8Array.of(1) });
        assert.equal(draft.input.markdown, input.markdown);
        assert.deepEqual(draft.input.assets, input.assets);
        assert.equal(draft.blueprints.length, 0);
        assert.equal(draft.preserved[0].reason, missingGeometry ? 'missing-geometry' : 'render-failed');
        assert.equal(counts().opened, missingGeometry ? 0 : 1);
    }
});

test('propagates cancellation during rendering and closes the PDF session', async () => {
    const { input } = makeFigureInput();
    const controller = new AbortController();
    const { restoration, counts } = service({ render: async () => {
        controller.abort();
        return { data: createTestPNG(8, 8), mimeType: 'image/png', width: 8, height: 8 };
    } });
    await assert.rejects(restoration.restore(input, { fileData: Uint8Array.of(1), signal: controller.signal }), {
        name: 'AbortError',
    });
    assert.equal(counts().closed, 1);
});

test('times out an unresponsive renderer without losing original content', async () => {
    const { input } = makeFigureInput();
    const timers = new Map();
    const { restoration, counts } = service({
        setTimeout(callback, ms) { timers.set(ms, callback); return ms; },
        clearTimeout(id) { timers.delete(id); },
        render: async () => { timers.get(20000)(); return new Promise(() => {}); },
    });
    const draft = await restoration.restore(input, { fileData: Uint8Array.of(1) });
    assert.equal(draft.preserved[0].reason, 'render-timeout');
    assert.equal(draft.input.markdown, input.markdown);
    assert.equal(counts().closed, 1);
    assert.equal(timers.size, 0);
});

test('respects storage and comparison budgets before adding generated images', async () => {
    const { input } = makeFigureInput();
    for (const limits of [{ maxAssets: input.assets.length }, { maxComparisons: 0 }]) {
        const { restoration, counts } = service({ limits });
        const draft = await restoration.restore(input, { fileData: Uint8Array.of(1) });
        assert.equal(draft.preserved[0].reason, 'resource-limit');
        assert.equal(draft.input.markdown, input.markdown);
        assert.equal(counts().rendered, 0);
    }
});

test('allocates a readable noncolliding image beneath every supported archive root', async () => {
    for (const basePath of ['', 'result', 'generated', 'generated/figures']) {
        const { input } = makeFigureInput();
        input.assetBasePath = basePath;
        input.assets = input.assets.map(asset => ({ ...asset,
            path: basePath ? `${basePath}/${asset.path}` : asset.path }));
        const { restoration } = service();
        const first = await restoration.restore(input, { fileData: Uint8Array.of(1) });
        const occupied = first.input.assets.at(-1);
        assert.equal(first.blueprints.length, 1);
        input.assets.push(occupied);
        const before = structuredClone(input);
        const draft = await restoration.restore(input, { fileData: Uint8Array.of(1) });
        const document = await finalizeRestoredDocument(input, draft, { prepare: prepareMinerUResult, hash });
        assert.equal(document.figureMap.figures.length, 1);
        const destination = document.figureMap.figures[0].render.assetPath;
        const assetPath = basePath ? `${basePath}/${destination}` : destination;
        assert.equal(document.assets.at(-1).path, assetPath);
        assert.notEqual(assetPath, occupied.path);
        assert.match(assetPath, /-1\.png$/u);
        assert.equal(document.assets.filter(asset => asset.path === occupied.path).length, 1);
        assert.deepEqual(input, before);
    }
});
