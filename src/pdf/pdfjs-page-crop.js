import {
    adoptPDFJSWindowGlobals,
} from './pdfjs-bootstrap-environment.js';
import {
    getDocument,
    GlobalWorkerOptions,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
    isValidSourceLocation,
} from '../core/markdown-source-map.js';

const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_PAGES = 10_000;
const MAX_CANVAS_EDGE = 2048;
const MIN_RENDER_SCALE = 1;
const MAX_RENDER_SCALE = 2.5;
const PAGE_THUMBNAIL_MAX_WIDTH = 160;
const PAGE_THUMBNAIL_MAX_HEIGHT = 220;
const PAGE_THUMBNAIL_RENDER_SCALE = 2;
const JPEG_QUALITY = 0.82;

export function createPDFPageCropRenderer({
    loadFile,
    loadDocument = getDocument,
    workerSrc = '',
    cMapUrl = '',
    standardFontDataUrl = '',
    wasmUrl = '',
} = {}) {
    if (typeof loadFile !== 'function') {
        throw new TypeError('A PDF file loader is required');
    }
    if (workerSrc) GlobalWorkerOptions.workerSrc = workerSrc;

    const sessions = new Map();
    const destroyedTasks = new WeakSet();
    let active = true;

    const destroyLoadingTask = loadingTask => {
        if (!loadingTask || destroyedTasks.has(loadingTask)) {
            return Promise.resolve();
        }
        destroyedTasks.add(loadingTask);
        try {
            return Promise.resolve(loadingTask.destroy?.());
        }
        catch (error) {
            return Promise.reject(error);
        }
    };

    const destroySession = async session => {
        session.pages?.clear?.();
        await destroyLoadingTask(session.loadingTask).catch(() => {});
        try {
            await session.document?.destroy?.();
        }
        catch {
            // Keep shutdown non-fatal when PDF.js has already torn down.
        }
    };

    return {
        async render(itemID, location, {
            createCanvas,
            ownerDocument = null,
            signal,
        } = {}) {
            if (!active) throw unavailableError();
            throwIfAborted(signal);
            if (!isValidSourceLocation(location)) {
                throw new Error('PDF source location is unavailable');
            }
            if (typeof createCanvas !== 'function') {
                throw new TypeError('A canvas factory is required');
            }

            adoptPDFJSWindowGlobals(
                ownerDocument?.defaultView
                    || globalThis.Zotero?.getMainWindow?.()
            );
            const session = await ensureSession(itemID, {
                createCanvas,
                ownerDocument,
                signal,
            });
            throwIfAborted(signal);
            const pageNumber = location.pageIndex + 1;
            if (pageNumber < 1 || pageNumber > session.document.numPages) {
                throw new Error('PDF page is unavailable');
            }

            const page = await session.document.getPage(pageNumber);
            throwIfAborted(signal);
            try {
                const scale = pageThumbnailScale(page.getViewport({ scale: 1 }));
                const pageCanvas = await renderPageCanvas(
                    session,
                    page,
                    location.pageIndex,
                    scale,
                    createCanvas,
                    signal
                );
                return {
                    dataURL: encodePageThumbnailDataURL(pageCanvas, createCanvas),
                    pageIndex: location.pageIndex,
                };
            }
            finally {
                page.cleanup?.();
            }
        },
        async dispose(itemID) {
            const session = sessions.get(itemID);
            if (!session) return;
            sessions.delete(itemID);
            await releaseSession(session);
        },
        async disposeAll() {
            active = false;
            const pending = [...sessions.values()];
            sessions.clear();
            await Promise.allSettled(pending.map(releaseSession));
        },
    };

    async function ensureSession(itemID, { createCanvas, ownerDocument, signal }) {
        const existing = sessions.get(itemID);
        if (existing?.ready) return existing.ready;
        if (existing?.loading) return existing.loading;

        const loading = loadSession(itemID, {
            createCanvas,
            ownerDocument,
            signal,
        });
        sessions.set(itemID, { loading });
        try {
            const ready = await loading;
            if (sessions.get(itemID)?.loading === loading) {
                sessions.set(itemID, { ready });
            }
            return ready;
        }
        catch (error) {
            if (sessions.get(itemID)?.loading === loading) {
                sessions.delete(itemID);
            }
            throw error;
        }
    }

    async function releaseSession(session) {
        if (session.ready) {
            await destroySession(session.ready);
            return;
        }
        try {
            await destroySession(await session.loading);
        }
        catch {
            // Ignore a load that failed or was aborted.
        }
    }

    async function loadSession(itemID, { createCanvas, ownerDocument, signal }) {
        throwIfAborted(signal);
        const fileData = await loadFile(itemID);
        throwIfAborted(signal);
        validatePDFData(fileData);
        const pdfData = Uint8Array.from(fileData);
        throwIfAborted(signal);
        const loadingTask = loadDocument({
            data: pdfData,
            ownerDocument: ownerDocument || undefined,
            CanvasFactory: createMkteroCanvasFactory(createCanvas),
            FilterFactory: MkteroFilterFactory,
            cMapUrl: cMapUrl || undefined,
            cMapPacked: true,
            standardFontDataUrl: standardFontDataUrl || undefined,
            wasmUrl: wasmUrl || undefined,
            useWorkerFetch: false,
            isOffscreenCanvasSupported: false,
            isImageDecoderSupported: false,
            useWasm: Boolean(wasmUrl),
            verbosity: 0,
        });
        if (!loadingTask || typeof loadingTask !== 'object') {
            throw new Error('PDF.js loading task is unavailable');
        }
        const abort = () => { void destroyLoadingTask(loadingTask); };
        signal?.addEventListener?.('abort', abort, { once: true });
        try {
            const document = await loadingTask.promise;
            if (!Number.isSafeInteger(document.numPages)
                || document.numPages < 1
                || document.numPages > MAX_PAGES) {
                throw new Error('PDF page count exceeds the index limit');
            }
            return {
                loadingTask,
                document,
                pages: new Map(),
            };
        }
        catch (error) {
            await destroyLoadingTask(loadingTask).catch(() => {});
            throw error;
        }
        finally {
            signal?.removeEventListener?.('abort', abort);
        }
    }
}

async function renderPageCanvas(
    session,
    page,
    pageIndex,
    scale,
    createCanvas,
    signal
) {
    const cached = session.pages.get(pageIndex);
    if (cached && Math.abs(cached.scale - scale) < 0.05) {
        return cached.canvas;
    }

    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));
    if (Math.max(width, height) > MAX_CANVAS_EDGE) {
        throw new Error('PDF page render exceeds the safety limit');
    }
    const canvas = createCanvas(width, height);
    canvas.width = width;
    canvas.height = height;
    const renderTask = page.render({
        canvas,
        viewport,
        intent: 'print',
        annotationMode: 0,
    });
    throwIfAborted(signal);
    await renderTask.promise;
    session.pages.set(pageIndex, { canvas, scale });
    if (session.pages.size > 3) {
        const oldest = session.pages.keys().next().value;
        if (oldest !== pageIndex) session.pages.delete(oldest);
    }
    return canvas;
}

function pageThumbnailScale(viewport) {
    const pageWidth = Number(viewport?.width);
    const pageHeight = Number(viewport?.height);
    if (!Number.isFinite(pageWidth)
        || pageWidth <= 0
        || !Number.isFinite(pageHeight)
        || pageHeight <= 0) {
        throw new Error('PDF page geometry is unavailable');
    }
    let scale = Math.min(
        PAGE_THUMBNAIL_MAX_WIDTH * PAGE_THUMBNAIL_RENDER_SCALE / pageWidth,
        PAGE_THUMBNAIL_MAX_HEIGHT * PAGE_THUMBNAIL_RENDER_SCALE / pageHeight,
        MAX_RENDER_SCALE
    );
    scale = Math.max(MIN_RENDER_SCALE, scale);
    const edge = Math.max(pageWidth, pageHeight) * scale;
    if (edge > MAX_CANVAS_EDGE) scale *= MAX_CANVAS_EDGE / edge;
    return scale;
}

export function encodePageThumbnailDataURL(pageCanvas, createCanvas) {
    const sourceWidth = Number(pageCanvas?.width);
    const sourceHeight = Number(pageCanvas?.height);
    if (!Number.isFinite(sourceWidth)
        || sourceWidth <= 0
        || !Number.isFinite(sourceHeight)
        || sourceHeight <= 0) {
        throw new Error('PDF page thumbnail is unavailable');
    }
    const scale = Math.min(
        PAGE_THUMBNAIL_MAX_WIDTH / sourceWidth,
        PAGE_THUMBNAIL_MAX_HEIGHT / sourceHeight,
        1
    );
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const thumbnail = createCanvas(width, height);
    thumbnail.width = width;
    thumbnail.height = height;
    const context = thumbnail.getContext?.('2d');
    if (!context?.drawImage) {
        throw new Error('Canvas rendering is unavailable');
    }
    context.drawImage(
        pageCanvas,
        0,
        0,
        sourceWidth,
        sourceHeight,
        0,
        0,
        width,
        height
    );
    const dataURL = thumbnail.toDataURL?.('image/jpeg', JPEG_QUALITY)
        || thumbnail.toDataURL?.('image/png');
    if (typeof dataURL !== 'string' || !dataURL.startsWith('data:image/')) {
        throw new Error('PDF page thumbnail encoding is unavailable');
    }
    return dataURL;
}

function createMkteroCanvasFactory(createCanvas) {
    return class MkteroCanvasFactory {
        create(width, height) {
            if (!(width > 0) || !(height > 0)) {
                throw new Error('Invalid canvas size');
            }
            const canvas = createCanvas(width, height);
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext?.('2d');
            if (!context) {
                throw new Error('Canvas rendering is unavailable');
            }
            return { canvas, context };
        }
        reset(canvasAndContext, width, height) {
            if (!canvasAndContext?.canvas) {
                throw new Error('Canvas is not specified');
            }
            if (!(width > 0) || !(height > 0)) {
                throw new Error('Invalid canvas size');
            }
            canvasAndContext.canvas.width = width;
            canvasAndContext.canvas.height = height;
        }
        destroy(canvasAndContext) {
            const canvas = canvasAndContext?.canvas;
            if (!canvas) return;
            canvas.width = 0;
            canvas.height = 0;
            canvasAndContext.canvas = null;
            canvasAndContext.context = null;
        }
    };
}

class MkteroFilterFactory {
    addFilter() { return 'none'; }
    addHCMFilter() { return 'none'; }
    addAlphaFilter() { return 'none'; }
    addLuminosityFilter() { return 'none'; }
    addKnockoutFilter() { return 'none'; }
    addHighlightHCMFilter() { return 'none'; }
    addSelectionHCMFilter() { return 'none'; }
    addSelectionFilter() { return 'none'; }
    createSelectionStyle() { return null; }
    destroy() {}
}

function validatePDFData(fileData) {
    if (!ArrayBuffer.isView(fileData)
        || fileData.BYTES_PER_ELEMENT !== 1
        || fileData.length !== fileData.byteLength
        || !fileData.length
        || fileData.length > MAX_PDF_BYTES) {
        throw new TypeError('PDF data is unavailable or exceeds the safety limit');
    }
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    if (signal.reason) throw signal.reason;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
}

function unavailableError() {
    const error = new Error('PDF source peek renderer is unavailable');
    error.code = 'MKTERO_SOURCE_PEEK_UNAVAILABLE';
    return error;
}
