import { FIGURE_LIMITS } from '../figures/figure-limits.js';
import { throwIfFigureAborted, waitForFigureOperation } from '../figures/figure-async.js';

const XHTML = 'http://www.w3.org/1999/xhtml';

export function createZoteroFigureCanvasEnvironment(zotero) {
    const ownerDocument = zotero?.getMainWindow?.()?.document;
    if (typeof ownerDocument?.createElementNS !== 'function') {
        throw new Error('Figure canvas document is unavailable');
    }
    return {
        ownerDocument,
        createCanvas(width, height) {
            const canvas = ownerDocument.createElementNS(XHTML, 'canvas');
            canvas.width = width;
            canvas.height = height;
            return canvas;
        },
        async encodePNG(canvas, { signal } = {}) {
            throwIfFigureAborted(signal);
            if (typeof canvas?.toBlob === 'function') {
                const blob = await waitForFigureOperation(new Promise((resolve, reject) => {
                    canvas.toBlob(value => {
                        if (!value || value.type !== 'image/png'
                            || value.size < 1 || value.size > FIGURE_LIMITS.maxCropBytes) {
                            reject(new Error('Figure PNG encoding failed or exceeded the limit'));
                        }
                        else resolve(value);
                    }, 'image/png');
                }), signal);
                const buffer = await waitForFigureOperation(blob.arrayBuffer(), signal);
                throwIfFigureAborted(signal);
                if (buffer.byteLength !== blob.size) throw new Error('Figure PNG size does not match');
                return new Uint8Array(buffer);
            }
            const dataURL = canvas?.toDataURL?.('image/png');
            const prefix = 'data:image/png;base64,';
            if (typeof dataURL !== 'string' || !dataURL.startsWith(prefix)
                || dataURL.length > prefix.length + Math.ceil(FIGURE_LIMITS.maxCropBytes / 3) * 4) {
                throw new Error('Figure PNG encoding is unavailable');
            }
            const decode = ownerDocument.defaultView?.atob?.bind(ownerDocument.defaultView) || globalThis.atob;
            const binary = decode(dataURL.slice(prefix.length));
            if (!binary.length || binary.length > FIGURE_LIMITS.maxCropBytes) {
                throw new Error('Figure PNG exceeds the encoding limit');
            }
            throwIfFigureAborted(signal);
            return Uint8Array.from(binary, character => character.charCodeAt(0));
        },
    };
}
