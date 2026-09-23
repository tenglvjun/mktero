import test from 'node:test';
import assert from 'node:assert/strict';
import { createPDFFigureRegionRenderer } from '../src/pdf/pdfjs-figure-region.js';
import { createTestPNG } from './helpers/figure-fixtures.js';

function inkContext() {
    return {
        drawImage() {},
        fillStyle: '',
        fillRect() {},
        getImageData(x, y, width, height) {
            const data = new Uint8ClampedArray(width * height * 4).fill(255);
            if (data.length) {
                data[0] = 0;
                data[1] = 0;
                data[2] = 0;
            }
            return { data };
        },
    };
}

function harness() {
    const pageRenders = [];
    const drawCalls = [];
    const allocations = [];
    const page = {
        view: [0, 0, 1000, 1000], rotate: 0, userUnit: 1,
        getViewport({ scale }) {
            return { width: 1000 * scale, height: 1000 * scale, scale,
                transform: [scale, 0, 0, -scale, 0, 1000 * scale] };
        },
        render(request) {
            pageRenders.push(request);
            return { promise: Promise.resolve(), cancel() {} };
        },
        cleanup() {},
    };
    const pdf = { numPages: 1, getPage: async () => page };
    const renderer = createPDFFigureRegionRenderer({
        loadDocument: () => ({ promise: Promise.resolve(pdf), destroy: async () => {} }),
        createCanvas(width, height) {
            const context = inkContext();
            context.drawImage = (...args) => drawCalls.push({ width, height, args });
            const canvas = { width, height, getContext: () => context };
            allocations.push(canvas);
            return canvas;
        },
        encodePNG: async canvas => createTestPNG(canvas.width, canvas.height),
    });
    return { renderer, pageRenders, drawCalls, allocations, page };
}

test('renders one page once and crops every region from the page canvas', async () => {
    const h = harness();
    const session = await h.renderer.open(Uint8Array.of(1, 2, 3));
    await session.getPageGeometry(0);
    const result = await session.renderPageCrops({
        pageIndex: 0, dpi: 72, rotation: 0, coordinateFrame: 'display-cropbox',
        regions: [
            { id: 'a', bbox: [100, 200, 400, 500] },
            { id: 'b', bbox: [500, 200, 900, 500] },
        ],
    });
    assert.equal(h.pageRenders.length, 1, 'the page must render exactly once');
    assert.equal(result.crops.length, 2);
    assert.equal(h.drawCalls.length, 2, 'each region is copied from the page canvas');
    assert.deepEqual(result.crops.map(crop => crop.id), ['a', 'b']);
    assert.equal(result.crops[0].crop.width, 300);
    assert.equal(result.crops[0].crop.height, 300);
    assert.equal(result.crops[1].crop.width, 400);
    await session.close();
});

test('rejects invalid page crop requests and duplicate regions', async () => {
    const h = harness();
    const session = await h.renderer.open(Uint8Array.of(1));
    await session.getPageGeometry(0);
    await assert.rejects(session.renderPageCrops({ pageIndex: 0, rotation: 0,
        coordinateFrame: 'display-cropbox', regions: [] }), /request is invalid/u);
    await assert.rejects(session.renderPageCrops({ pageIndex: 0, rotation: 0,
        coordinateFrame: 'display-cropbox', regions: [
            { id: 'a', bbox: [0, 0, 10, 10] }, { id: 'a', bbox: [0, 0, 10, 10] }],
    }), /region is invalid/u);
    await session.close();
});

test('caps the page scale so the largest region stays inside the crop budget', async () => {
    const h = harness();
    const session = await h.renderer.open(Uint8Array.of(1));
    await session.getPageGeometry(0);
    const result = await session.renderPageCrops({
        pageIndex: 0, dpi: 1_000, rotation: 0, coordinateFrame: 'display-cropbox',
        regions: [{ id: 'a', bbox: [0, 0, 1000, 1000] }],
    });
    assert.ok(result.dpi <= 72 * 4096 / 1000 + 1);
    await session.close();
});

test('defaults to 144 DPI for a small crop', async () => {
    const h = harness();
    const session = await h.renderer.open(Uint8Array.of(1));
    await session.getPageGeometry(0);
    await session.renderPageCrops({
        pageIndex: 0, rotation: 0, coordinateFrame: 'display-cropbox',
        regions: [{ id: 'small', bbox: [0, 0, 100, 100] }],
    });
    assert.equal(h.pageRenders[0].viewport.scale, 144 / 72);
    await session.close();
});

test('caps a wide crop long edge at 1600 pixels', async () => {
    const h = harness();
    const session = await h.renderer.open(Uint8Array.of(1));
    await session.getPageGeometry(0);
    const result = await session.renderPageCrops({
        pageIndex: 0, rotation: 0, coordinateFrame: 'display-cropbox',
        regions: [{ id: 'wide', bbox: [0, 0, 1000, 100] }],
    });
    assert.ok(result.crops[0].crop.width <= 1600);
    assert.ok(result.crops[0].crop.width >= 1400);
    await session.close();
});
