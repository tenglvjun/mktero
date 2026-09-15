import { FIGURE_LIMITS } from '../figures/figure-limits.js';
import { figureImageDimensions } from '../figures/figure-image-dimensions.js';
import { throwIfFigureAborted, waitForFigureOperation } from '../figures/figure-async.js';

// OffscreenCanvas environment for a background worker. Mirrors the main-thread
// Zotero environment so the same PDF.js region renderer can run unchanged.
export function createOffscreenFigureCanvasEnvironment({
    createOffscreenCanvas = (width, height) => new OffscreenCanvas(width, height),
    createBitmap = (blob, options) => createImageBitmap(blob, options),
    limits: overrides,
} = {}) {
    const limits = { ...FIGURE_LIMITS, ...overrides };
    return {
        createCanvas(width, height) {
            return createOffscreenCanvas(width, height);
        },
        async decodeImage(asset, { signal } = {}) {
            throwIfFigureAborted(signal);
            const dimensions = figureImageDimensions(asset);
            if (!dimensions || dimensions.width < 1 || dimensions.height < 1
                || dimensions.width * dimensions.height > limits.maxDecodedImagePixels
                || asset.data.byteLength > 25 * 1024 * 1024) return null;
            const blob = new Blob([asset.data], { type: asset.mimeType });
            const image = await waitForFigureOperation(createBitmap(blob), signal);
            throwIfFigureAborted(signal);
            if (!image || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)
                || image.width < 1 || image.height < 1
                || image.width * image.height > limits.maxDecodedImagePixels) {
                image?.close?.();
                return null;
            }
            let closed = false;
            return {
                image, width: image.width, height: image.height,
                close() {
                    if (closed) return;
                    closed = true;
                    image.close?.();
                },
            };
        },
        async encodePNG(canvas, { signal } = {}) {
            throwIfFigureAborted(signal);
            if (typeof canvas?.convertToBlob !== 'function') {
                throw new Error('Figure PNG encoding is unavailable');
            }
            const blob = await waitForFigureOperation(canvas.convertToBlob({ type: 'image/png' }), signal);
            throwIfFigureAborted(signal);
            if (!blob || blob.type !== 'image/png' || blob.size < 1 || blob.size > limits.maxCropBytes) {
                throw new Error('Figure PNG encoding failed or exceeded the limit');
            }
            const buffer = await waitForFigureOperation(blob.arrayBuffer(), signal);
            throwIfFigureAborted(signal);
            if (buffer.byteLength !== blob.size) throw new Error('Figure PNG size does not match');
            return new Uint8Array(buffer);
        },
    };
}
