import test from 'node:test';
import assert from 'node:assert/strict';
import { createZoteroFigureCanvasEnvironment } from '../src/platform/zotero-figure-canvas.js';
import { createTestPNG } from './helpers/figure-fixtures.js';

function environment(canvas) {
    return createZoteroFigureCanvasEnvironment({ getMainWindow: () => ({ document: {
        createElementNS(namespace, tag) {
            assert.equal(namespace, 'http://www.w3.org/1999/xhtml');
            assert.equal(tag, 'canvas');
            return canvas;
        },
    } }) });
}

test('creates XHTML canvases and encodes bounded local PNG blobs', async () => {
    const data = createTestPNG();
    const canvas = { toBlob(callback, type) { callback(new Blob([data], { type })); } };
    const env = environment(canvas);
    assert.equal(env.createCanvas(8, 8), canvas);
    assert.equal(canvas.width, 8);
    assert.deepEqual(await env.encodePNG(canvas), data);
});

test('supports the local canvas data URL fallback and rejects other image types', async () => {
    const data = createTestPNG();
    const canvas = { toDataURL: () => 'data:image/png;base64,' + Buffer.from(data).toString('base64') };
    const env = environment(canvas);
    assert.deepEqual(await env.encodePNG(canvas), data);
    canvas.toDataURL = () => 'https://example.test/image.png';
    await assert.rejects(env.encodePNG(canvas));
    canvas.toBlob = callback => callback(new Blob([data], { type: 'image/jpeg' }));
    await assert.rejects(env.encodePNG(canvas));
});

test('rejects cancellation while the browser is encoding and ignores late callbacks', async () => {
    let callback;
    const canvas = { toBlob(value) { callback = value; } };
    const controller = new AbortController();
    const encoded = environment(canvas).encodePNG(canvas, { signal: controller.signal });
    const rejected = assert.rejects(encoded, { name: 'AbortError' });
    controller.abort();
    await rejected;
    callback(new Blob([createTestPNG()], { type: 'image/png' }));
});
