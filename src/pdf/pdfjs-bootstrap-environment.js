const mainWindow = globalThis.Zotero?.getMainWindow?.();
const windowDOMMatrix = mainWindow?.DOMMatrix;
const windowDOMException = mainWindow?.DOMException;

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
