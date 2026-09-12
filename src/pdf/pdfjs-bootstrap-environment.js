import '../platform/web-streams.js';
import './pdfjs-runtime-compat.js';

const PDFJS_WINDOW_GLOBALS = [
    'Path2D',
    'Image',
    'ImageData',
    'DOMMatrix',
    'DOMPoint',
    'DOMRect',
    'OffscreenCanvas',
];

const mainWindow = globalThis.Zotero?.getMainWindow?.();
const windowAbortController = mainWindow?.AbortController;
const windowAbortSignal = mainWindow?.AbortSignal;
const windowDOMMatrix = mainWindow?.DOMMatrix;
const windowDOMException = mainWindow?.DOMException;
const windowStructuredClone = mainWindow?.structuredClone;

export function adoptPDFJSWindowGlobals(view) {
    if (!view) return;
    for (const name of PDFJS_WINDOW_GLOBALS) {
        if (typeof view[name] === 'function') {
            globalThis[name] = view[name];
        }
    }
}

export function createMkteroCanvasFactory(createCanvas, {
    maxPixels = 16_000_000, maxEdge = 8_192, maxTotalPixels = 32_000_000,
} = {}) {
    return class MkteroCanvasFactory {
        constructor() {
            this.allocations = new Map();
            this.totalPixels = 0;
        }
        validateSize(width, height, previousPixels = 0) {
            if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
                || width < 1 || height < 1 || width > maxEdge || height > maxEdge
                || width * height > maxPixels
                || this.totalPixels - previousPixels + width * height > maxTotalPixels) {
                throw new RangeError('PDF canvas exceeds the resource limit');
            }
        }
        create(width, height) {
            this.validateSize(width, height);
            const canvas = createCanvas(width, height);
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext?.('2d');
            if (!context) {
                canvas.width = 0;
                canvas.height = 0;
                throw new Error('Canvas rendering is unavailable');
            }
            this.allocations.set(canvas, width * height);
            this.totalPixels += width * height;
            return { canvas, context };
        }
        reset(canvasAndContext, width, height) {
            if (!canvasAndContext?.canvas) {
                throw new Error('Canvas is not specified');
            }
            const previousPixels = this.allocations.get(canvasAndContext.canvas) || 0;
            this.validateSize(width, height, previousPixels);
            canvasAndContext.canvas.width = width;
            canvasAndContext.canvas.height = height;
            this.totalPixels += width * height - previousPixels;
            this.allocations.set(canvasAndContext.canvas, width * height);
        }
        destroy(canvasAndContext) {
            const canvas = canvasAndContext?.canvas;
            if (!canvas) return;
            this.totalPixels -= this.allocations.get(canvas) || 0;
            this.allocations.delete(canvas);
            canvas.width = 0;
            canvas.height = 0;
            canvasAndContext.canvas = null;
            canvasAndContext.context = null;
        }
    };
}

export class MkteroFilterFactory {
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

adoptPDFJSWindowGlobals(mainWindow);

// PDF.js constructs this browser primitive while its module loads, even when
// Mktero only uses getTextContent in Zotero's DOM-free bootstrap sandbox.
if (typeof globalThis.DOMMatrix !== 'function') {
    globalThis.DOMMatrix = typeof windowDOMMatrix === 'function'
        ? windowDOMMatrix
        : class PDFTextExtractionDOMMatrix {};
}

if (typeof globalThis.DOMException !== 'function') {
    globalThis.DOMException = typeof windowDOMException === 'function'
        ? windowDOMException
        : class PDFTextExtractionDOMException extends Error {
            constructor(message = '', name = 'Error') {
                super(message);
                this.name = name;
            }
        };
}

if (typeof globalThis.AbortController !== 'function'
    && typeof windowAbortController === 'function') {
    globalThis.AbortController = windowAbortController;
}

if (typeof globalThis.AbortSignal !== 'function'
    && typeof windowAbortSignal === 'function') {
    globalThis.AbortSignal = windowAbortSignal;
}

if (typeof globalThis.structuredClone !== 'function'
    && typeof windowStructuredClone === 'function') {
    globalThis.structuredClone = windowStructuredClone.bind(mainWindow);
}
