import test from 'node:test';
import assert from 'node:assert/strict';
import { createPDFPageCropRenderer } from '../src/pdf/pdfjs-page-crop.js';

function createCanvasRecorder() {
    const canvases = [];
    return {
        canvases,
        createCanvas(width, height) {
            const draws = [];
            const canvas = {
                width: width || 0,
                height: height || 0,
                draws,
                getContext() {
                    return {
                        drawImage(
                            source,
                            sx,
                            sy,
                            sw,
                            sh,
                            dx,
                            dy,
                            dw,
                            dh
                        ) {
                            draws.push({
                                source,
                                sx,
                                sy,
                                sw,
                                sh,
                                dx,
                                dy,
                                dw,
                                dh,
                            });
                        },
                    };
                },
                toDataURL() {
                    return `data:image/jpeg;base64,${this.width}x${this.height}`;
                },
            };
            canvases.push(canvas);
            return canvas;
        },
    };
}

function createFakeDocument({
    numPages = 2,
    pageWidth = 400,
    pageHeight = 600,
} = {}) {
    const rendered = [];
    return {
        numPages,
        rendered,
        async getPage(pageNumber) {
            return {
                getViewport({ scale }) {
                    return {
                        width: pageWidth * scale,
                        height: pageHeight * scale,
                    };
                },
                render({ canvas, viewport }) {
                    canvas.width = Math.ceil(viewport.width);
                    canvas.height = Math.ceil(viewport.height);
                    rendered.push(pageNumber);
                    return { promise: Promise.resolve() };
                },
                cleanup() {},
            };
        },
        async destroy() {
            this.destroyed = true;
        },
    };
}

test('renders a full-page thumbnail and reuses a rendered page', async () => {
    const pdf = createFakeDocument();
    const canvases = createCanvasRecorder();
    const loads = [];
    const renderer = createPDFPageCropRenderer({
        loadFile: async itemID => {
            loads.push(itemID);
            return Uint8Array.from([1, 2, 3, 4]);
        },
        loadDocument: options => {
            assert.equal(typeof options.CanvasFactory, 'function');
            assert.equal(typeof options.FilterFactory, 'function');
            const loadingTask = {
                promise: Promise.resolve(pdf),
                async destroy() {
                    loadingTask.destroyed = true;
                },
            };
            return loadingTask;
        },
    });

    const location = {
        pageIndex: 1,
        bbox: [250, 250, 750, 750],
    };
    const first = await renderer.render(42, location, {
        createCanvas: canvases.createCanvas,
    });
    const second = await renderer.render(42, location, {
        createCanvas: canvases.createCanvas,
    });

    assert.deepEqual(loads, [42]);
    assert.deepEqual(pdf.rendered, [2]);
    assert.equal(first.pageIndex, 1);
    assert.match(first.dataURL, /^data:image\/jpeg;base64,/);
    assert.equal(second.dataURL, first.dataURL);
    const thumbnail = canvases.canvases.find(canvas => canvas.draws.length);
    assert.ok(thumbnail);
    assert.equal(thumbnail.draws[0].sx, 0);
    assert.equal(thumbnail.draws[0].sy, 0);
    assert.equal(thumbnail.draws[0].sw, thumbnail.draws[0].source.width);
    assert.equal(thumbnail.draws[0].sh, thumbnail.draws[0].source.height);

    await renderer.dispose(42);
    assert.equal(pdf.destroyed, true);
});

test('rejects invalid locations and missing canvas rendering', async () => {
    const renderer = createPDFPageCropRenderer({
        loadFile: async () => Uint8Array.from([1, 2, 3, 4]),
        loadDocument: () => ({
            promise: Promise.resolve(createFakeDocument()),
            async destroy() {},
        }),
    });

    await assert.rejects(
        () => renderer.render(1, { pageIndex: 0, bbox: [0, 0, 0, 0] }, {
            createCanvas() { return {}; },
        }),
        /source location is unavailable/
    );
    await assert.rejects(
        () => renderer.render(1, {
            pageIndex: 0,
            bbox: [100, 100, 200, 200],
        }),
        /canvas factory is required/
    );
    await renderer.disposeAll();
});
