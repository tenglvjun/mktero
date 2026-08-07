const mainWindow = globalThis.Zotero?.getMainWindow?.();
const windowAbortController = mainWindow?.AbortController;
const windowAbortSignal = mainWindow?.AbortSignal;
const windowDOMMatrix = mainWindow?.DOMMatrix;
const windowDOMException = mainWindow?.DOMException;
const windowReadableStream = mainWindow?.ReadableStream;
const windowStructuredClone = mainWindow?.structuredClone;

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

if (typeof globalThis.ReadableStream !== 'function'
    && typeof windowReadableStream === 'function') {
    globalThis.ReadableStream = windowReadableStream;
}

if (typeof globalThis.structuredClone !== 'function'
    && typeof windowStructuredClone === 'function') {
    globalThis.structuredClone = windowStructuredClone.bind(mainWindow);
}
