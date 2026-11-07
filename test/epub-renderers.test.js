import assert from 'node:assert/strict';
import test from 'node:test';

import { createZoteroEpubRenderers } from '../src/platform/zotero-epub-renderers.js';
import { createTestPNG } from './helpers/figure-fixtures.js';

const WEBP_BYTES = Uint8Array.from(Buffer.from(
    'UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=',
    'base64'
));
const PNG_BYTES = createTestPNG(16, 8);
const MAX_INPUT_BYTES = 25 * 1024 * 1024;

// The real EPUB and figure-canvas adapters run against this local window.
// Bitmap decoding and canvas encoding are browser API stubs, not codec tests.
function createRendererHarness({
    width = 16,
    height = 8,
    encode = callback => callback(new Blob([PNG_BYTES], { type: 'image/png' })),
} = {}) {
    const blobs = [];
    const decodedBlobs = [];
    const canvases = [];
    const bitmap = {
        width,
        height,
        closeCalls: 0,
        close() {
            this.closeCalls++;
        },
    };
    const view = {
        closed: false,
        Blob: class WindowBlob extends Blob {
            constructor(parts, options) {
                super(parts, options);
                blobs.push(this);
            }
        },
        async createImageBitmap(blob) {
            assert.equal(this, view);
            assert.ok(blob instanceof view.Blob);
            decodedBlobs.push(blob);
            return bitmap;
        },
    };
    const document = {
        defaultView: view,
        createElementNS(namespace, tag) {
            assert.equal(namespace, 'http://www.w3.org/1999/xhtml');
            assert.equal(tag, 'canvas');
            const fills = [];
            const draws = [];
            const encodings = [];
            const context = {
                fillStyle: '',
                fillRect(...args) {
                    fills.push({ color: this.fillStyle, args });
                },
                drawImage(...args) {
                    assert.equal(bitmap.closeCalls, 0);
                    draws.push(args);
                },
            };
            const canvas = {
                ownerDocument: document,
                width: 0,
                height: 0,
                fills,
                draws,
                encodings,
                getContext(type, options) {
                    assert.equal(type, '2d');
                    assert.deepEqual(options, { alpha: false });
                    return context;
                },
                toBlob(callback, type) {
                    assert.equal(bitmap.closeCalls, 0);
                    encodings.push({ type, width: this.width, height: this.height });
                    encode(callback, type);
                },
            };
            canvases.push(canvas);
            return canvas;
        },
    };
    view.document = document;
    const renderers = createZoteroEpubRenderers({ getMainWindow: () => view }, {
        services: {},
    });
    return { renderers, view, bitmap, blobs, decodedBlobs, canvases };
}

function assertReleased(harness) {
    assert.equal(harness.bitmap.closeCalls, 1);
    for (const canvas of harness.canvases) {
        assert.equal(canvas.width, 0);
        assert.equal(canvas.height, 0);
    }
}

test('converts a local WebP Blob to canvas PNG bytes and releases the bitmap and canvas', async () => {
    const h = createRendererHarness();

    const result = await h.renderers.renderImageToPNG({
        data: WEBP_BYTES,
        mimeType: 'image/webp',
    });

    assert.equal(h.blobs.length, 1);
    assert.deepEqual(h.decodedBlobs, h.blobs);
    assert.equal(h.decodedBlobs[0].type, 'image/webp');
    assert.deepEqual(new Uint8Array(await h.decodedBlobs[0].arrayBuffer()), WEBP_BYTES);
    assert.equal(h.canvases.length, 1);
    assert.deepEqual(h.canvases[0].fills, [{ color: '#fff', args: [0, 0, 16, 8] }]);
    assert.deepEqual(h.canvases[0].draws, [[h.bitmap, 0, 0, 16, 8]]);
    assert.deepEqual(h.canvases[0].encodings, [{ type: 'image/png', width: 16, height: 8 }]);
    assert.ok(result.data instanceof Uint8Array);
    assert.deepEqual(result, { mimeType: 'image/png', data: PNG_BYTES });
    assertReleased(h);
});

test('rejects image input above 25 MiB before creating a Blob or decoding', async () => {
    const h = createRendererHarness();

    await assert.rejects(h.renderers.renderImageToPNG({
        data: new Uint8Array(MAX_INPUT_BYTES + 1),
        mimeType: 'image/webp',
    }), { message: 'The EPUB image resource is invalid' });

    assert.deepEqual(h.blobs, []);
    assert.deepEqual(h.decodedBlobs, []);
    assert.deepEqual(h.canvases, []);
    assert.equal(h.bitmap.closeCalls, 0);
});

test('accepts image input at the 25 MiB boundary', async () => {
    const h = createRendererHarness();

    const result = await h.renderers.renderImageToPNG({
        data: new Uint8Array(MAX_INPUT_BYTES),
        mimeType: 'image/webp',
    });

    assert.equal(h.decodedBlobs.length, 1);
    assert.equal(h.decodedBlobs[0].size, MAX_INPUT_BYTES);
    assert.equal(h.canvases.length, 1);
    assert.deepEqual(result, { mimeType: 'image/png', data: PNG_BYTES });
    assertReleased(h);
});

test('rejects decoded images above 24 million pixels and closes the bitmap without a canvas', async () => {
    const h = createRendererHarness({ width: 6_000, height: 4_001 });

    await assert.rejects(h.renderers.renderImageToPNG({
        data: WEBP_BYTES,
        mimeType: 'image/webp',
    }), { message: 'The EPUB image exceeds the decoding limit' });

    assert.equal(h.decodedBlobs.length, 1);
    assert.deepEqual(h.canvases, []);
    assertReleased(h);
});

test('accepts decoded images at the 24 million pixel boundary', async () => {
    const h = createRendererHarness({ width: 6_000, height: 4_000 });

    const result = await h.renderers.renderImageToPNG({
        data: WEBP_BYTES,
        mimeType: 'image/webp',
    });

    assert.equal(h.canvases.length, 1);
    assert.deepEqual(h.canvases[0].draws, [[h.bitmap, 0, 0, 6_000, 4_000]]);
    assert.deepEqual(h.canvases[0].encodings, [{
        type: 'image/png', width: 6_000, height: 4_000,
    }]);
    assert.deepEqual(result, { mimeType: 'image/png', data: PNG_BYTES });
    assertReleased(h);
});

test('releases the bitmap and canvas when PNG encoding fails', async t => {
    const cases = [
        {
            name: 'encoder returns no Blob',
            encode: callback => callback(null),
            message: 'Figure PNG encoding failed or exceeded the limit',
        },
        {
            name: 'encoder throws',
            encode() {
                throw new Error('Canvas encoding failed');
            },
            message: 'Canvas encoding failed',
        },
        {
            name: 'encoded Blob bytes cannot be read',
            encode(callback) {
                callback({
                    type: 'image/png',
                    size: PNG_BYTES.byteLength,
                    async arrayBuffer() {
                        throw new Error('PNG Blob read failed');
                    },
                });
            },
            message: 'PNG Blob read failed',
        },
    ];
    for (const { name, encode, message } of cases) {
        await t.test(name, async () => {
            const h = createRendererHarness({ encode });

            await assert.rejects(h.renderers.renderImageToPNG({
                data: WEBP_BYTES,
                mimeType: 'image/webp',
            }), { message });

            assert.equal(h.decodedBlobs.length, 1);
            assert.equal(h.canvases.length, 1);
            assert.deepEqual(h.canvases[0].draws, [[h.bitmap, 0, 0, 16, 8]]);
            assert.deepEqual(h.canvases[0].encodings, [{
                type: 'image/png', width: 16, height: 8,
            }]);
            assertReleased(h);
        });
    }
});

test('reports an unavailable EPUB image decoder when the local window has no createImageBitmap', async () => {
    const h = createRendererHarness();
    delete h.view.createImageBitmap;

    await assert.rejects(h.renderers.renderImageToPNG({
        data: WEBP_BYTES,
        mimeType: 'image/webp',
    }), { message: 'The EPUB image decoder is unavailable' });

    assert.deepEqual(h.blobs, []);
    assert.deepEqual(h.decodedBlobs, []);
    assert.deepEqual(h.canvases, []);
    assert.equal(h.bitmap.closeCalls, 0);
});

test('rejects invalid image MIME values explicitly before decoding', async t => {
    const cases = [
        { name: 'missing MIME', mimeType: undefined },
        { name: 'non-string MIME', mimeType: 42 },
        { name: 'empty MIME', mimeType: '' },
        { name: 'non-image MIME', mimeType: 'text/html' },
        { name: 'missing image subtype', mimeType: 'image/' },
        { name: 'MIME with parameters', mimeType: 'image/webp; charset=utf-8' },
        { name: 'markup in MIME', mimeType: 'image/<svg>' },
    ];
    for (const { name, mimeType } of cases) {
        await t.test(name, async () => {
            const h = createRendererHarness();

            await assert.rejects(h.renderers.renderImageToPNG({
                data: WEBP_BYTES,
                mimeType,
            }), { message: 'The EPUB image resource is invalid' });

            assert.deepEqual(h.blobs, []);
            assert.deepEqual(h.decodedBlobs, []);
            assert.deepEqual(h.canvases, []);
            assert.equal(h.bitmap.closeCalls, 0);
        });
    }
});
