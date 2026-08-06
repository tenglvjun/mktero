const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

export function createZoteroPDFFileLoader(zotero, readFile) {
    if (typeof readFile !== 'function') {
        throw new TypeError('A PDF file reader is required');
    }
    return async itemID => {
        const item = await zotero.Items.getAsync(itemID);
        if (!item?.isPDFAttachment?.()) {
            throw new Error('PDF attachment is unavailable');
        }
        const filePath = await item.getFilePathAsync?.();
        if (!filePath) throw new Error('The local PDF file is unavailable');
        return readFile(filePath);
    };
}

export function createZoteroTextMeasurer(zotero) {
    let context = null;
    let ownerDocument = null;
    return ({ text, fontFamily }) => {
        const document = zotero.getMainWindow?.()?.document || null;
        if (document !== ownerDocument) {
            ownerDocument = document;
            context = null;
        }
        context ||= createCanvasContext(document);
        if (!context) return [...String(text)].length;
        context.font = '100px sans-serif';
        const family = String(fontFamily || 'sans-serif').slice(0, 512);
        context.font = `100px ${family}`;
        const width = context.measureText(String(text)).width;
        return Number.isFinite(width) ? width : [...String(text)].length;
    };
}

function createCanvasContext(document) {
    const canvas = document?.createElementNS?.(HTML_NAMESPACE, 'canvas');
    return canvas?.getContext?.('2d') || null;
}
