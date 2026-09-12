import test from 'node:test';
import assert from 'node:assert/strict';
import { createZoteroFigureCanvasEnvironment } from '../src/platform/zotero-figure-canvas.js';
import { createTestPNG } from './helpers/figure-fixtures.js';

function environment(canvas, view = {}) {
    return createZoteroFigureCanvasEnvironment({ getMainWindow: () => ({ document: {
        defaultView: view,
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

function imageEnvironment({ fail = false, pending = false } = {}) {
    const images = [];
    const urls = [];
    const revoked = [];
    const view = {
        Blob,
        URL: {
            createObjectURL(blob) { assert.equal(blob.type, 'image/png'); urls.push('blob:local-figure'); return urls.at(-1); },
            revokeObjectURL(url) { revoked.push(url); },
        },
        Image: class {
            constructor() { images.push(this); this.naturalWidth = 8; this.naturalHeight = 8; }
            set src(value) {
                assert.equal(value, 'blob:local-figure');
                this.source = value;
                if (!pending) queueMicrotask(() => fail ? this.onerror?.() : this.onload?.());
            }
            removeAttribute(name) { assert.equal(name, 'src'); this.source = null; }
        },
    };
    return { env: environment({}, view), images, urls, revoked };
}

test('decodes only bounded local images and revokes the URL when the decoded image closes', async () => {
    const h = imageEnvironment();
    const decoded = await h.env.decodeImage({ mimeType: 'image/png', data: createTestPNG() });
    assert.equal(decoded.width, 8);
    assert.equal(decoded.image, h.images[0]);
    assert.equal(h.revoked.length, 0);
    decoded.close();
    decoded.close();
    assert.deepEqual(h.revoked, h.urls);
    assert.equal(decoded.image.source, null);
    assert.equal(decoded.image.onload, null);
    assert.equal(decoded.image.onerror, null);
});

test('rejects malformed or oversized image headers before constructing an image or a URL', async () => {
    const h = imageEnvironment();
    const data = createTestPNG();
    new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(16, 0xffffffff);
    for (const asset of [{ mimeType: 'image/png', data },
        { mimeType: 'image/png', data: Uint8Array.of(1) },
        { mimeType: 'image/svg+xml', data: new TextEncoder().encode('<svg onload="alert(1)" />') }]) {
        assert.equal(await h.env.decodeImage(asset), null);
    }
    assert.equal(h.images.length, 0);
    assert.equal(h.urls.length, 0);
});

test('cleans image handlers and URLs after decode failures and cancellation', async () => {
    for (const cancel of [false, true]) {
        const h = imageEnvironment({ fail: !cancel, pending: cancel });
        const controller = new AbortController();
        const decoding = h.env.decodeImage({ mimeType: 'image/png', data: createTestPNG() },
            { signal: controller.signal });
        const rejected = assert.rejects(decoding, cancel ? { name: 'AbortError' } : /decoding failed/u);
        if (cancel) controller.abort();
        await rejected;
        assert.deepEqual(h.revoked, h.urls);
        assert.equal(h.images[0].source, null);
        assert.equal(h.images[0].onload, null);
        assert.equal(h.images[0].onerror, null);
    }
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
