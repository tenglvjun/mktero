import {
    adoptPDFJSWindowGlobals, createMkteroCanvasFactory, MkteroFilterFactory,
} from './pdfjs-bootstrap-environment.js';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { FIGURE_LIMITS } from '../figures/figure-limits.js';
import { validateFigureCrop } from '../figures/figure-model.js';
import { inspectPDFFigureImage } from './pdfjs-figure-image.js';
import {
    createFigureAbortScope, throwIfFigureAborted, waitForFigureOperation,
} from '../figures/figure-async.js';

let renderQueue = Promise.resolve();

export function createPDFFigureRegionRenderer({
    loadDocument = getDocument,
    createCanvas,
    encodePNG,
    decodeImage = null,
    ownerDocument: defaultOwnerDocument = null,
    workerSrc = '',
    cMapUrl = '',
    standardFontDataUrl = '',
    wasmUrl = '',
    limits: overrides,
    createAbortController,
    setTimeout,
    clearTimeout,
} = {}) {
    if (typeof createCanvas !== 'function' || typeof encodePNG !== 'function') {
        throw new TypeError('Figure canvas creation and PNG encoding are required');
    }
    const limits = { ...FIGURE_LIMITS, ...overrides };
    const abortOptions = { createAbortController, setTimeout, clearTimeout };
    const sessions = new Set();
    let active = true;
    if (workerSrc) GlobalWorkerOptions.workerSrc = workerSrc;

    return {
        async open(fileData, { signal, ownerDocument = defaultOwnerDocument,
            createCanvas: sessionCreateCanvas = createCanvas,
            encodePNG: sessionEncodePNG = encodePNG,
            decodeImage: sessionDecodeImage = decodeImage } = {}) {
            if (!active) throw new Error('Figure renderer is closed');
            throwIfFigureAborted(signal);
            if (!ArrayBuffer.isView(fileData) || fileData.BYTES_PER_ELEMENT !== 1
                || !fileData.byteLength || fileData.byteLength > limits.maxPDFBytes) {
                throw new TypeError('Figure PDF exceeds the resource limit');
            }
            adoptPDFJSWindowGlobals(ownerDocument?.defaultView);
            const scope = createFigureAbortScope([signal], abortOptions);
            const pages = new Map();
            const jobs = new Set();
            let loadingTask;
            let document;
            let closePromise;
            let destroyPromise;
            const destroy = () => {
                if (!destroyPromise) {
                    destroyPromise = Promise.resolve().then(() => loadingTask?.destroy
                        ? loadingTask.destroy() : document?.destroy?.()).catch(() => {});
                }
                return destroyPromise;
            };
            const session = {
                async getPageGeometry(pageIndex, { signal: operationSignal } = {}) {
                    const operation = createFigureAbortScope([scope.signal, operationSignal], abortOptions);
                    try {
                        return pageGeometry(await getPage(pageIndex, operation.signal), pageIndex);
                    }
                    finally {
                        operation.dispose();
                    }
                },
                recoverImageGroup(request, { signal: operationSignal } = {}) {
                    const operation = createFigureAbortScope([scope.signal, operationSignal], {
                        ...abortOptions, timeoutMs: limits.cropTimeoutMs,
                    });
                    const queued = renderQueue.then(async () => {
                        throwIfFigureAborted(operation.signal);
                        const page = await getPage(request.pageIndex, operation.signal);
                        try {
                            const geometry = pageGeometry(page, request.pageIndex);
                            const recovered = await inspectPDFFigureImage(page, request, {
                                createCanvas: sessionCreateCanvas, decodeImage: sessionDecodeImage,
                                signal: operation.signal, limits,
                            });
                            if (!recovered) return null;
                            const rect = cropRectangle(geometry, { bbox: recovered.bbox }, limits);
                            return { ...recovered, crop: await renderCrop(page, rect, operation.signal) };
                        }
                        finally { page.cleanup?.(); }
                    });
                    renderQueue = queued.catch(() => {});
                    const result = waitForFigureOperation(queued, operation.signal).finally(() => {
                        operation.dispose();
                        jobs.delete(result);
                    });
                    jobs.add(result);
                    return result;
                },
                renderRegion(request, { signal: operationSignal } = {}) {
                    const operation = createFigureAbortScope([scope.signal, operationSignal], {
                        ...abortOptions, timeoutMs: limits.cropTimeoutMs,
                    });
                    const queued = renderQueue.then(async () => {
                        throwIfFigureAborted(operation.signal);
                        validateRegion(request);
                        const page = await getPage(request.pageIndex, operation.signal);
                        try {
                            const geometry = pageGeometry(page, request.pageIndex);
                            if (request.rotation !== geometry.rotation) {
                                throw new TypeError('Figure page rotation does not match');
                            }
                            const rect = cropRectangle(geometry, request, limits);
                            return await renderCrop(page, rect, operation.signal);
                        }
                        finally {
                            page.cleanup?.();
                        }
                    });
                    renderQueue = queued.catch(() => {});
                    const result = waitForFigureOperation(queued, operation.signal).finally(() => {
                        operation.dispose();
                        jobs.delete(result);
                    });
                    jobs.add(result);
                    return result;
                },
                close() {
                    if (!closePromise) {
                        scope.abort();
                        closePromise = (async () => {
                            await destroy();
                            await Promise.allSettled([...jobs]);
                            for (const pending of pages.values()) {
                                pending.then(page => page.cleanup?.(), () => {}).catch(() => {});
                            }
                            pages.clear();
                            scope.dispose();
                            sessions.delete(session);
                        })();
                    }
                    return closePromise;
                },
            };
            sessions.add(session);
            try {
                loadingTask = loadDocument({
                    data: Uint8Array.from(fileData), ownerDocument: ownerDocument || undefined,
                    CanvasFactory: createMkteroCanvasFactory(sessionCreateCanvas, {
                        maxPixels: limits.maxIntermediateCanvasPixels,
                        maxEdge: limits.maxIntermediateCanvasEdge,
                        maxTotalPixels: limits.maxActiveCanvasPixels,
                    }), FilterFactory: MkteroFilterFactory,
                    cMapUrl: cMapUrl || undefined, cMapPacked: true,
                    standardFontDataUrl: standardFontDataUrl || undefined, wasmUrl: wasmUrl || undefined,
                    useWorkerFetch: false, isOffscreenCanvasSupported: false,
                    isImageDecoderSupported: false, useWasm: Boolean(wasmUrl), verbosity: 0,
                    maxImageSize: limits.maxDecodedImagePixels,
                    canvasMaxAreaInBytes: limits.maxIntermediateCanvasPixels * 4,
                    stopAtErrors: true,
                });
                if (!loadingTask?.promise) throw new Error('Figure PDF loading task is unavailable');
                const loaded = Promise.resolve(loadingTask.promise).then(async value => {
                    if (scope.signal.aborted) {
                        await value.destroy?.();
                        throwIfFigureAborted(scope.signal);
                    }
                    return value;
                });
                document = await waitForFigureOperation(loaded, scope.signal, destroy);
                if (!Number.isSafeInteger(document.numPages) || document.numPages < 1
                    || document.numPages > limits.maxPDFPages) {
                    throw new TypeError('Figure PDF page count exceeds the resource limit');
                }
                return session;
            }
            catch (error) {
                await session.close();
                throw error;
            }

            async function getPage(pageIndex, operationSignal) {
                throwIfFigureAborted(operationSignal);
                if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex >= document.numPages) {
                    throw new TypeError('Figure page index is invalid');
                }
                if (!pages.has(pageIndex)) {
                    pages.set(pageIndex, Promise.resolve(document.getPage(pageIndex + 1)).then(page => {
                        if (scope.signal.aborted) page.cleanup?.();
                        throwIfFigureAborted(scope.signal);
                        return page;
                    }));
                }
                return waitForFigureOperation(pages.get(pageIndex), operationSignal);
            }

            async function renderCrop(page, rect, operationSignal) {
                throwIfFigureAborted(operationSignal);
                const canvas = sessionCreateCanvas(rect.width, rect.height);
                canvas.width = rect.width;
                canvas.height = rect.height;
                try {
                    const context = canvas.getContext?.('2d');
                    if (!context) throw new Error('Figure canvas context is unavailable');
                    const task = page.render({
                        canvas, canvasContext: context, viewport: page.getViewport({ scale: rect.scale }),
                        transform: [1, 0, 0, 1, -rect.x, -rect.y],
                        background: 'rgb(255,255,255)', intent: 'print', annotationMode: 0,
                    });
                    await waitForFigureOperation(task.promise, operationSignal, () => task.cancel());
                    throwIfFigureAborted(operationSignal);
                    const data = await waitForFigureOperation(
                        sessionEncodePNG(canvas, { signal: operationSignal }), operationSignal
                    );
                    throwIfFigureAborted(operationSignal);
                    return validateFigureCrop({ data, mimeType: 'image/png',
                        width: rect.width, height: rect.height }, limits);
                }
                finally {
                    canvas.width = 0;
                    canvas.height = 0;
                }
            }
        },
        async disposeAll() {
            active = false;
            await Promise.allSettled([...sessions].map(session => session.close()));
        },
    };
}

function pageGeometry(page, pageIndex) {
    const viewport = page.getViewport({ scale: 1 });
    if (!Number.isFinite(viewport.width) || viewport.width <= 0
        || !Number.isFinite(viewport.height) || viewport.height <= 0
        || ![0, 90, 180, 270].includes(page.rotate)
        || !Number.isFinite(page.userUnit) || page.userUnit <= 0
        || !Array.isArray(page.view) || page.view.length !== 4
        || !page.view.every(Number.isFinite)
        || !Array.isArray(viewport.transform) || viewport.transform.length !== 6
        || !viewport.transform.every(Number.isFinite)) {
        throw new TypeError('Figure PDF geometry is unavailable');
    }
    return {
        pageIndex, width: viewport.width, height: viewport.height,
        rotation: page.rotate, userUnit: page.userUnit, coordinateFrame: 'display-cropbox',
        viewBox: [...page.view], mediaBox: null, viewportTransform: [...viewport.transform],
    };
}

function validateRegion(request) {
    const bbox = request?.bbox;
    if (request?.coordinateFrame !== 'display-cropbox'
        || !Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)
        || bbox[0] < 0 || bbox[1] < 0 || bbox[2] > 1000 || bbox[3] > 1000
        || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
        throw new TypeError('Figure crop coordinates are invalid');
    }
}

function cropRectangle(geometry, request, limits) {
    const dpi = request.dpi ?? limits.defaultDpi;
    if (!Number.isFinite(dpi) || dpi <= 0) throw new TypeError('Figure DPI is invalid');
    let scale = dpi / 72;
    for (let attempt = 0; attempt < 5; attempt++) {
        const [x0, y0, x1, y1] = request.bbox;
        const x = Math.floor(x0 * geometry.width * scale / 1000);
        const y = Math.floor(y0 * geometry.height * scale / 1000);
        const width = Math.ceil(x1 * geometry.width * scale / 1000) - x;
        const height = Math.ceil(y1 * geometry.height * scale / 1000) - y;
        if (![x, y, width, height].every(Number.isSafeInteger) || width < 1 || height < 1) break;
        if (width <= limits.maxCropEdge && height <= limits.maxCropEdge
            && width * height <= limits.maxCropPixels) return { x, y, width, height, scale };
        scale *= Math.min((limits.maxCropEdge - 1) / width, (limits.maxCropEdge - 1) / height,
            Math.sqrt(limits.maxCropPixels / ((width + 1) * (height + 1))));
    }
    throw new RangeError('Figure crop exceeds the pixel budget');
}
