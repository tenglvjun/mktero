import '../pdf/pdfjs-runtime-compat.js';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import { createPDFFigureRegionRenderer } from '../pdf/pdfjs-figure-region.js';
import { createOffscreenFigureCanvasEnvironment } from '../platform/offscreen-figure-canvas.js';
import { createFigureRenderWorkerRuntime } from './figure-render-worker-runtime.js';

// Firefox does not support nested workers, so PDF.js runs its in-process
// handler here instead of spawning its own worker from inside this worker.
globalThis.pdfjsWorker = { WorkerMessageHandler };
if (GlobalWorkerOptions) GlobalWorkerOptions.workerSrc = '';

// PDF.js binds standard/embedded fonts through `document.fonts`. This worker
// has no document, so without a minimal one non-embedded text falls back to
// unrelated glyphs and figure crops become unreadable. `self.fonts` is the
// worker's FontFaceSet.
if (typeof globalThis.document === 'undefined' && globalThis.self?.fonts) {
    globalThis.document = {
        fonts: globalThis.self.fonts,
        baseURI: globalThis.location?.href || '',
        adoptedStyleSheets: undefined,
    };
}

const environment = createOffscreenFigureCanvasEnvironment();
const runtime = createFigureRenderWorkerRuntime({
    createRenderer({ cMapUrl = '', standardFontDataUrl = '', wasmUrl = '', assets = null, limits } = {}) {
        const assetMap = assets instanceof Map
            ? assets
            : new Map(Object.entries(assets || {}));
        const readBinaryAsset = assetMap.size
            ? (kind, filename) => assetMap.get(`${kind}:${filename}`) || null
            : null;
        return createPDFFigureRegionRenderer({
            ...environment,
            cMapUrl, standardFontDataUrl, wasmUrl, limits,
            ...(readBinaryAsset ? { readBinaryAsset } : {}),
        });
    },
});

globalThis.onmessage = async event => {
    const message = event.data || {};
    try {
        const value = await runtime.handle(message);
        globalThis.postMessage({ id: message.id, ok: true, value }, collectTransferables(value));
    }
    catch (error) {
        globalThis.postMessage({ id: message.id, ok: false, error: serializeError(error) });
    }
};

function collectTransferables(value) {
    const buffers = [];
    const seen = new WeakSet();
    const visit = current => {
        if (!current || typeof current !== 'object') return;
        if (ArrayBuffer.isView(current)) {
            if (!seen.has(current.buffer)) {
                seen.add(current.buffer);
                buffers.push(current.buffer);
            }
            return;
        }
        if (current instanceof ArrayBuffer) {
            if (!seen.has(current)) {
                seen.add(current);
                buffers.push(current);
            }
            return;
        }
        if (Array.isArray(current)) {
            for (const item of current) visit(item);
            return;
        }
        for (const item of Object.values(current)) visit(item);
    };
    visit(value);
    return buffers;
}

function serializeError(error) {
    return {
        name: String(error?.name || 'Error'),
        code: error?.code ? String(error.code) : null,
        message: String(error?.message || error),
    };
}
