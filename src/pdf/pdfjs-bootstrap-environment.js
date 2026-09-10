import '../platform/web-streams.js';

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
