import {
    isValidSourceLocation,
} from '../core/markdown-source-map.js';
import { encodePageThumbnailDataURL } from '../pdf/pdfjs-page-crop.js';

export function createZoteroSourcePeekRenderer({
    zotero,
    cropRenderer,
} = {}) {
    if (!cropRenderer || typeof cropRenderer.render !== 'function') {
        throw new TypeError('A PDF crop renderer is required');
    }
    return {
        async render(itemID, location, options = {}) {
            const captured = captureReaderPageCrop(
                zotero,
                itemID,
                location,
                options.createCanvas
            );
            if (captured) return captured;
            return cropRenderer.render(itemID, location, {
                ...options,
                ...readerCanvasEnvironment(zotero, itemID),
            });
        },
        dispose(itemID) {
            return cropRenderer.dispose?.(itemID);
        },
        disposeAll() {
            return cropRenderer.disposeAll?.();
        },
    };
}

export function captureReaderPageCrop(
    zotero,
    itemID,
    location,
    createCanvas
) {
    if (typeof createCanvas !== 'function'
        || !isValidSourceLocation(location)) {
        return null;
    }
    const canvas = findReaderPageCanvas(zotero, itemID, location.pageIndex);
    if (!canvas?.width || !canvas.height) return null;
    try {
        return {
            dataURL: encodePageThumbnailDataURL(canvas, createCanvas),
            pageIndex: location.pageIndex,
        };
    }
    catch {
        return null;
    }
}

function readerCanvasEnvironment(zotero, itemID) {
    const document = findReaderDocument(zotero, itemID);
    if (typeof document?.createElement !== 'function') return {};
    return {
        ownerDocument: document,
        createCanvas(width, height) {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            return canvas;
        },
    };
}

function findReaderPageCanvas(zotero, itemID, pageIndex) {
    const pageView = findReaderPageView(zotero, itemID, pageIndex);
    if (pageView?.canvas?.width && pageView.canvas.height) {
        return pageView.canvas;
    }
    return pageView?.div?.querySelector?.('canvas') || null;
}

function findReaderPageView(zotero, itemID, pageIndex) {
    try {
        return findReaderIframeWindow(zotero, itemID)
            ?.PDFViewerApplication
            ?.pdfViewer
            ?.getPageView?.(pageIndex) || null;
    }
    catch {
        return null;
    }
}

function findReaderDocument(zotero, itemID) {
    return findReaderIframeWindow(zotero, itemID)?.document || null;
}

function findReaderIframeWindow(zotero, itemID) {
    const targetID = String(itemID);
    const readers = zotero?.Reader?._readers || [];
    for (const reader of readers) {
        if (String(reader?.itemID) !== targetID) continue;
        if (reader?.type && reader.type !== 'pdf') continue;
        const iframeWindow = reader?._internalReader?._primaryView
            ?._iframeWindow;
        if (iframeWindow) return iframeWindow;
    }
    return null;
}
