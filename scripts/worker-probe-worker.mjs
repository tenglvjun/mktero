// Worker entry for the offline-rendering feasibility probe. It is bundled with
// esbuild into a standalone worker script and loaded by the Zotero harness.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import '../src/pdf/pdfjs-runtime-compat.js';

// Zotero's sandbox registers the in-process worker; inside our worker the same
// fallback avoids a nested worker (Firefox does not support nested workers).
globalThis.pdfjsWorker = { WorkerMessageHandler };

const GLOBAL_NAMES = [
    'Worker', 'OffscreenCanvas', 'createImageBitmap', 'ImageBitmap', 'Image',
    'FontFace', 'Path2D', 'DOMMatrix', 'DOMPoint', 'DOMRect', 'ImageData',
    'fetch', 'WebAssembly', 'importScripts', 'structuredClone', 'Blob', 'URL',
    'AbortController', 'performance', 'self',
];

function capabilities() {
    const out = {};
    for (const name of GLOBAL_NAMES) out[name] = typeof globalThis[name];
    out.fonts = typeof self.fonts;
    try {
        const canvas = new OffscreenCanvas(16, 16);
        out.offscreen2d = canvas.getContext('2d') ? 'ok' : 'no-context';
    }
    catch (error) {
        out.offscreen2d = `error:${error.message}`;
    }
    return out;
}

async function offscreenTest() {
    const canvas = new OffscreenCanvas(64, 48);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 64, 48);
    context.fillStyle = '#123456';
    context.fillRect(8, 8, 20, 20);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let imageBitmap = null;
    try {
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        imageBitmap = `${bitmap.width}x${bitmap.height}`;
    }
    catch (error) {
        imageBitmap = `error:${error.message}`;
    }
    let path2d = 'skip';
    try {
        const path = new Path2D();
        path.rect(1, 1, 4, 4);
        context.fillStyle = '#ff0000';
        context.fill(path);
        path2d = 'ok';
    }
    catch (error) {
        path2d = `error:${error.message}`;
    }
    return { blobType: blob.type, bytes: bytes.length,
        pngMagic: [137, 80, 78, 71].every((value, index) => bytes[index] === value),
        imageBitmap, path2d };
}

class OffscreenCanvasFactory {
    create(width, height) {
        const canvas = new OffscreenCanvas(width, height);
        return { canvas, context: canvas.getContext('2d') };
    }
    reset(target, width, height) {
        target.canvas.width = width;
        target.canvas.height = height;
    }
    destroy(target) {
        target.canvas.width = 0;
        target.canvas.height = 0;
    }
}

async function fontFaceTest({ bytes, family }) {
    const supported = typeof FontFace === 'function' && typeof self.fonts === 'object' && self.fonts;
    if (!supported) return { supported: false, FontFace: typeof FontFace, fonts: typeof self.fonts };
    const steps = {};
    const withTimeout = async (promise, ms, name) => {
        let timer;
        try {
            const value = await Promise.race([promise,
                new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`timeout:${name}`)), ms); })]);
            steps[name] = 'ok';
            return value;
        }
        catch (error) {
            steps[name] = String((error && error.message) || error);
            throw error;
        }
        finally { clearTimeout(timer); }
    };
    let font;
    let available = null;
    let inkPixels = 0;
    try {
        font = new FontFace(family, bytes);
        steps.construct = 'ok';
        await withTimeout(font.load(), 8000, 'load');
        self.fonts.add(font);
        available = self.fonts.check(`32px "${family}"`);
        const canvas = new OffscreenCanvas(320, 64);
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, 320, 64);
        context.fillStyle = '#000000';
        context.font = `32px "${family}", monospace`;
        context.fillText('Wg123', 8, 40);
        const pixels = context.getImageData(0, 0, 320, 64).data;
        for (let index = 0; index < pixels.length; index += 4) {
            if (pixels[index] < 128 && pixels[index + 3] > 0) inkPixels++;
        }
        steps.draw = 'ok';
    }
    catch (error) {
        steps.failed = String((error && error.message) || error);
    }
    return { supported: true, available, inkPixels, steps };
}

async function fetchUrlTest({ url }) {
    try {
        const response = await fetch(url);
        const buffer = await response.arrayBuffer();
        return { ok: response.ok, status: response.status, bytes: buffer.byteLength };
    }
    catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
    }
}

async function renderStandardFontTest({ data, standardFontDataUrl }) {
    const loadingTask = getDocument({
        data: new Uint8Array(data),
        isOffscreenCanvasSupported: true,
        isImageDecoderSupported: false,
        useWorkerFetch: false,
        standardFontDataUrl: standardFontDataUrl || undefined,
        CanvasFactory: OffscreenCanvasFactory,
        verbosity: 0,
    });
    const document = await loadingTask.promise;
    const page = await document.getPage(1);
    const viewport = page.getViewport({ scale: 2 });
    const width = Math.ceil(viewport.width);
    const height = Math.ceil(viewport.height);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    await page.render({ canvas, canvasContext: context, viewport,
        background: 'rgb(255,255,255)', intent: 'print', annotationMode: 0 }).promise;
    const pixels = context.getImageData(0, 0, width, height).data;
    let inkPixels = 0;
    for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] < 128 && pixels[index + 3] > 0) inkPixels++;
    }
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const png = new Uint8Array(await blob.arrayBuffer());
    page.cleanup?.();
    await document.destroy?.();
    return { width, height, inkPixels, bytes: png.length, data: png.buffer };
}

async function renderTest({ data, pageIndex, bbox, dpi }) {
    const loadingTask = getDocument({
        data: new Uint8Array(data),
        isOffscreenCanvasSupported: true,
        isImageDecoderSupported: false,
        useWorkerFetch: false,
        CanvasFactory: OffscreenCanvasFactory,
        verbosity: 0,
    });
    const document = await loadingTask.promise;
    const page = await document.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1 });
    const scale = dpi / 72;
    const target = page.getViewport({ scale });
    const [x0, y0, x1, y1] = bbox;
    const x = Math.floor(x0 * viewport.width * scale / 1000);
    const y = Math.floor(y0 * viewport.height * scale / 1000);
    const width = Math.ceil(x1 * viewport.width * scale / 1000) - x;
    const height = Math.ceil(y1 * viewport.height * scale / 1000) - y;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    const started = performance.now();
    await page.render({ canvas, canvasContext: context, viewport: target,
        transform: [1, 0, 0, 1, -x, -y], background: 'rgb(255,255,255)',
        intent: 'print', annotationMode: 0 }).promise;
    const rendered = performance.now();
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const encoded = performance.now();
    page.cleanup?.();
    await document.destroy?.();
    return { width, height, renderMs: rendered - started, encodeMs: encoded - rendered,
        bytes: bytes.length, pngMagic: [137, 80, 78, 71].every((value, index) => bytes[index] === value),
        data: bytes.buffer };
}

const handlers = { capabilities, offscreen: offscreenTest, fontFace: fontFaceTest,
    fetchUrl: fetchUrlTest, renderStandardFont: renderStandardFontTest, render: renderTest };

globalThis.onmessage = async event => {
    const { id, type, payload } = event.data || {};
    const handler = handlers[type];
    if (!handler) {
        globalThis.postMessage({ id, ok: false, error: `unknown probe type ${type}` });
        return;
    }
    try {
        const value = await handler(payload || {});
        const transfer = value?.data ? [value.data] : [];
        globalThis.postMessage({ id, ok: true, value }, transfer);
    }
    catch (error) {
        globalThis.postMessage({ id, ok: false, error: String(error), stack: String(error?.stack) });
    }
};
