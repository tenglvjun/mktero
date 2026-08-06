const windowDOMMatrix = globalThis.Zotero
    ?.getMainWindow?.()
    ?.DOMMatrix;

// PDF.js constructs this browser primitive while its module loads, even when
// Mktero only uses getTextContent in Zotero's DOM-free bootstrap sandbox.
if (typeof globalThis.DOMMatrix !== 'function') {
    globalThis.DOMMatrix = typeof windowDOMMatrix === 'function'
        ? windowDOMMatrix
        : class PDFTextExtractionDOMMatrix {};
}
