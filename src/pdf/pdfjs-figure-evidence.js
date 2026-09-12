import { figureLabelKey } from '../figures/figure-analysis.js';
import { isValidNormalizedSourceBBox } from '../core/markdown-source-map.js';
import { throwIfFigureAborted, waitForFigureOperation } from '../figures/figure-async.js';
import { figureImageDimensions } from '../figures/figure-image-dimensions.js';

const SAMPLE_EDGE = 64;
const SAMPLE_FACTOR = 4;
const DRAW_EDGE = SAMPLE_EDGE * SAMPLE_FACTOR;

export async function verifyPDFPanelPixels(canvas, panels, viewport, { createCanvas, decodeImage, signal, limits }) {
    for (const panel of panels) {
        throwIfFigureAborted(signal);
        const dimensions = figureImageDimensions(panel.asset);
        if (!dimensions || dimensions.width < 1 || dimensions.height < 1
            || dimensions.width * dimensions.height > limits.maxDecodedImagePixels) return null;
        let decoded;
        let closed = false;
        const close = () => {
            if (!decoded || closed) return;
            closed = true;
            decoded.close?.();
        };
        try {
            const decoding = Promise.resolve(decodeImage(panel.asset, { signal })).then(value => {
                decoded = value;
                if (signal?.aborted) close();
                throwIfFigureAborted(signal);
                return value;
            });
            await waitForFigureOperation(decoding, signal);
            if (!decoded || !Number.isSafeInteger(decoded.width) || !Number.isSafeInteger(decoded.height)
                || decoded.width < 1 || decoded.height < 1
                || decoded.width * decoded.height > limits.maxDecodedImagePixels) return null;
            const box = panel.bbox;
            const panelWidth = (box[2] - box[0]) * viewport.width;
            const panelHeight = (box[3] - box[1]) * viewport.height;
            const aspectRatio = decoded.width / decoded.height / (panelWidth / panelHeight);
            if (aspectRatio < 0.95 || aspectRatio > 1.05) return null;
            if (!matchesPanelPixels(canvas, decoded.image, box, createCanvas)) return null;
        }
        finally { close(); }
    }
    return true;
}

export function findPDFCaptions(items, viewport, caption) {
    const key = figureLabelKey(caption?.label);
    const expected = letters(caption?.text).slice(0, 40);
    if (!key || expected.length < 8) return [];
    const output = [];
    for (let index = 0; index < items.length; index++) {
        const item = items[index];
        if (!/^(?:fig(?:ure)?[.\uFF0E]?|\u56FE)/iu.test(item.str?.trim() || '')) continue;
        let value = '';
        let box = null;
        for (const next of items.slice(index, index + 12)) {
            if (!String(next.str || '').trim()) continue;
            const nextBox = textBox(next, viewport);
            if (!nextBox || box && (Math.abs(nextBox[1] - box[1]) > 4
                || nextBox[0] < box[0] - 1 || nextBox[0] - box[2] > 30)) break;
            value += ' ' + next.str;
            box = box ? [box[0], Math.min(box[1], nextBox[1]),
                Math.max(box[2], nextBox[2]), Math.max(box[3], nextBox[3])] : nextBox;
        }
        if (box && figureLabelKey(value) === key && letters(value).startsWith(expected)) output.push(box);
    }
    return output;
}

export function textBox(item, viewport) {
    const matrix = item?.transform;
    if (!Array.isArray(matrix) || !matrix.every(Number.isFinite)
        || !Number.isFinite(item.width) || !Number.isFinite(item.height)
        || item.width < 0 || item.height <= 0) return null;
    const [x, y] = [matrix[4], matrix[5]];
    const transform = viewport.transform;
    const points = [[x, y], [x + item.width, y], [x, y + item.height], [x + item.width, y + item.height]]
        .map(([a, b]) => [(transform[0] * a + transform[2] * b + transform[4]) / viewport.width * 1000,
            (transform[1] * a + transform[3] * b + transform[5]) / viewport.height * 1000]);
    const box = [Math.min(...points.map(point => point[0])), Math.min(...points.map(point => point[1])),
        Math.max(...points.map(point => point[0])), Math.max(...points.map(point => point[1]))];
    return validBox(box) ? box : null;
}

function matchesPanelPixels(pageCanvas, image, box, createCanvas) {
    const sample = createCanvas(DRAW_EDGE, DRAW_EDGE);
    sample.width = sample.height = DRAW_EDGE;
    try {
        const context = sample.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, DRAW_EDGE, DRAW_EDGE);
        context.drawImage(image, 0, 0, DRAW_EDGE, DRAW_EDGE);
        const expected = grayscale(context.getImageData(0, 0, DRAW_EDGE, DRAW_EDGE).data);
        const width = (box[2] - box[0]) / 1000 * pageCanvas.width;
        const height = (box[3] - box[1]) / 1000 * pageCanvas.height;
        for (const dx of [-1, 0, 1]) {
            for (const dy of [-1, 0, 1]) {
                context.fillRect(0, 0, DRAW_EDGE, DRAW_EDGE);
                context.drawImage(pageCanvas, box[0] / 1000 * pageCanvas.width + dx,
                    box[1] / 1000 * pageCanvas.height + dy, width, height,
                    0, 0, DRAW_EDGE, DRAW_EDGE);
                if (matchingSamples(expected, grayscale(context.getImageData(0, 0, DRAW_EDGE, DRAW_EDGE).data))) return true;
            }
        }
        return false;
    }
    finally { sample.width = sample.height = 0; }
}

export function matchingSamples(a, b) {
    if (a.length !== b.length || !a.length) return false;
    const meanA = a.reduce((sum, value) => sum + value, 0) / a.length;
    const meanB = b.reduce((sum, value) => sum + value, 0) / b.length;
    let difference = 0;
    let covariance = 0;
    let varianceA = 0;
    let varianceB = 0;
    for (let index = 0; index < a.length; index++) {
        difference += Math.abs(a[index] - b[index]);
        covariance += (a[index] - meanA) * (b[index] - meanB);
        varianceA += (a[index] - meanA) ** 2;
        varianceB += (b[index] - meanB) ** 2;
    }
    return varianceA / a.length > 0.003 && varianceB / b.length > 0.003
        && difference / a.length <= 0.09
        && covariance / Math.sqrt(varianceA * varianceB) >= 0.88;
}

function grayscale(data) {
    // Area averaging retains thin chart lines across PDF and OCR rasterizers.
    const output = new Float64Array(SAMPLE_EDGE * SAMPLE_EDGE);
    for (let y = 0; y < DRAW_EDGE; y++) {
        for (let x = 0; x < DRAW_EDGE; x++) {
            const offset = (y * DRAW_EDGE + x) * 4;
            const target = Math.floor(y / SAMPLE_FACTOR) * SAMPLE_EDGE + Math.floor(x / SAMPLE_FACTOR);
            output[target] += (data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114)
                / (255 * SAMPLE_FACTOR * SAMPLE_FACTOR);
        }
    }
    return output;
}

export function letters(text) { return String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); }
function validBox(box) { return isValidNormalizedSourceBBox(box) && box[0] < box[2] && box[1] < box[3]; }
