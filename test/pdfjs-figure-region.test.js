import test from 'node:test';
import assert from 'node:assert/strict';
import { createPDFFigureRegionRenderer } from '../src/pdf/pdfjs-figure-region.js';
import { createTestPNG } from './helpers/figure-fixtures.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function harness(options = {}) {
    const allocations = [];
    const renderCalls = [];
    const loads = [];
    let cleaned = 0;
    let destroyed = 0;
    const page = {
        view: [0, 0, 1000, 1000], rotate: 0, userUnit: 1,
        getViewport({ scale }) {
            return { width: 1000 * scale, height: 1000 * scale,
                transform: [scale, 0, 0, -scale, 0, 1000 * scale] };
        },
        render(request) {
            renderCalls.push(request);
            return options.render?.(request) || { promise: Promise.resolve(), cancel() {} };
        },
        cleanup() { cleaned++; },
    };
    const pdf = { numPages: 1, getPage: async () => page };
    const renderer = createPDFFigureRegionRenderer({
        loadDocument(settings) {
            loads.push(settings);
            return { promise: Promise.resolve(pdf), destroy: async () => { destroyed++; } };
        },
        createCanvas(width, height) {
            const canvas = { width, height, getContext: () => ({}) };
            allocations.push({ canvas, width, height });
            return canvas;
        },
        encodePNG: options.encodePNG || (async canvas => createTestPNG(canvas.width, canvas.height)),
        ...options,
    });
    return { renderer, allocations, renderCalls, loads, page,
        counts: () => ({ cleaned, destroyed }) };
}

const request = { pageIndex: 0, bbox: [100, 200, 700, 500],
    coordinateFrame: 'display-cropbox', rotation: 0, dpi: 72 };

test('renders only the crop canvas, copies PDF bytes and releases every resource', async () => {
    const h = harness();
    const original = Uint8Array.of(1, 2, 3);
    const session = await h.renderer.open(original);
    const geometry = await session.getPageGeometry(0);
    assert.deepEqual(geometry.viewBox, [0, 0, 1000, 1000]);
    assert.equal(geometry.mediaBox, null);
    assert.notEqual(h.loads[0].data.buffer, original.buffer);
    assert.equal(h.loads[0].useWorkerFetch, false);
    const crop = await session.renderRegion(request);
    assert.equal(crop.width, 600);
    assert.equal(crop.height, 300);
    assert.deepEqual(h.renderCalls[0].transform, [1, 0, 0, 1, -100, -200]);
    assert.equal(h.allocations[0].width * h.allocations[0].height, 180000);
    assert.equal(h.allocations[0].canvas.width, 0);
    await session.close();
    await session.close();
    await h.renderer.disposeAll();
    assert.equal(h.counts().destroyed, 1);
    assert.ok(h.counts().cleaned > 0);
});

test('limits canvas dimensions before allocation and rejects wrong coordinate frames', async () => {
    const h = harness({ limits: { maxCropPixels: 40000, maxCropEdge: 300 } });
    const session = await h.renderer.open(Uint8Array.of(1));
    const crop = await session.renderRegion({ ...request, bbox: [0, 0, 1000, 1000], dpi: 300 });
    assert.ok(crop.width * crop.height <= 40000);
    assert.ok(crop.width <= 300 && crop.height <= 300);
    await assert.rejects(session.renderRegion({ ...request, coordinateFrame: 'unknown' }));
    await assert.rejects(session.renderRegion({ ...request, rotation: 90 }));
    await assert.rejects(session.renderRegion({ ...request, bbox: [0, 0, 1100, 10] }));
    assert.equal(h.allocations.length, 1);
    await h.renderer.disposeAll();
});

test('cancels active renders and aborts queued work before another allocation', async () => {
    const started = deferred();
    const rendered = deferred();
    let cancelled = 0;
    const h = harness({ render() {
        started.resolve();
        return { promise: rendered.promise, cancel() { cancelled++; rendered.reject(new Error('cancelled')); } };
    } });
    const session = await h.renderer.open(Uint8Array.of(1));
    const firstController = new AbortController();
    const first = session.renderRegion(request, { signal: firstController.signal });
    const firstRejected = assert.rejects(first, { name: 'AbortError' });
    await started.promise;
    const queuedController = new AbortController();
    const second = session.renderRegion(request, { signal: queuedController.signal });
    const secondRejected = assert.rejects(second, { name: 'AbortError' });
    queuedController.abort();
    await secondRejected;
    firstController.abort();
    await firstRejected;
    await h.renderer.disposeAll();
    assert.equal(cancelled, 1);
    assert.equal(h.allocations.length, 1);
    assert.equal(h.allocations[0].canvas.width, 0);
});

test('serializes figure renders across renderer instances and discards cancelled encodings', async () => {
    const encoding = deferred();
    const started = deferred();
    const firstHarness = harness({ encodePNG: () => { started.resolve(); return encoding.promise; } });
    const secondHarness = harness();
    const firstSession = await firstHarness.renderer.open(Uint8Array.of(1));
    const secondSession = await secondHarness.renderer.open(Uint8Array.of(2));
    const controller = new AbortController();
    const first = firstSession.renderRegion(request, { signal: controller.signal });
    const rejected = assert.rejects(first, { name: 'AbortError' });
    await started.promise;
    const second = secondSession.renderRegion(request);
    await Promise.resolve();
    assert.equal(secondHarness.allocations.length, 0);
    controller.abort();
    await rejected;
    encoding.resolve(createTestPNG(600, 300));
    assert.equal((await second).width, 600);
    await firstHarness.renderer.disposeAll();
    await secondHarness.renderer.disposeAll();
});

test('aborts a loading task and destroys a document that arrives after cancellation', async () => {
    const loading = deferred();
    let destroyed = 0;
    let lateDestroyed = 0;
    const h = harness({ loadDocument: () => ({ promise: loading.promise,
        destroy: async () => { destroyed++; } }) });
    const controller = new AbortController();
    const opened = h.renderer.open(Uint8Array.of(1), { signal: controller.signal });
    const rejected = assert.rejects(opened, { name: 'AbortError' });
    controller.abort();
    await rejected;
    loading.resolve({ numPages: 1, destroy: async () => { lateDestroyed++; } });
    await Promise.resolve();
    await h.renderer.disposeAll();
    assert.equal(destroyed, 1);
    assert.equal(lateDestroyed, 1);
});

test('bounds decoded images and all intermediate canvas allocations before rendering', async () => {
    const h = harness({ limits: { maxDecodedImagePixels: 500, maxIntermediateCanvasPixels: 200,
        maxIntermediateCanvasEdge: 20, maxActiveCanvasPixels: 300 } });
    const session = await h.renderer.open(Uint8Array.of(1));
    assert.equal(h.loads[0].maxImageSize, 500);
    assert.equal(h.loads[0].canvasMaxAreaInBytes, 800);
    assert.equal(h.loads[0].stopAtErrors, true);
    const factory = new h.loads[0].CanvasFactory();
    assert.throws(() => factory.create(21, 1), RangeError);
    assert.throws(() => factory.create(20, 20), RangeError);
    assert.equal(h.allocations.length, 0);
    const first = factory.create(10, 20);
    assert.throws(() => factory.reset(first, 100, 100), RangeError);
    assert.equal(first.canvas.width, 10);
    assert.throws(() => factory.create(10, 20), RangeError);
    factory.reset(first, 10, 10);
    const second = factory.create(10, 20);
    factory.destroy(first);
    factory.destroy(second);
    const third = factory.create(10, 20);
    factory.destroy(third);
    assert.ok(h.allocations.every(({ canvas }) => canvas.width === 0 && canvas.height === 0));
    await session.close();
});
