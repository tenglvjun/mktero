import { figureLabelKey } from '../figures/figure-analysis.js';
import { isValidNormalizedSourceBBox } from '../core/markdown-source-map.js';
import { throwIfFigureAborted, waitForFigureOperation } from '../figures/figure-async.js';
import { figureImageDimensions } from '../figures/figure-image-dimensions.js';
import { normalizeFigurePanelLabel } from '../figures/figure-label-recovery.js';

const SAMPLE_EDGE = 64;

export async function inspectPDFFigureImage(page, request, {
    createCanvas, decodeImage, signal, limits,
}) {
    if (typeof decodeImage !== 'function' || !Array.isArray(request.panels)
        || request.panels.length < 2 || request.panels.length > limits.maxPanels
        || request.panels.some(panel => !validBox(panel.bbox))) return null;
    const viewport = page.getViewport({ scale: 1 });
    const scale = Math.min(1.5, 1200 / Math.max(viewport.width, viewport.height));
    const renderViewport = page.getViewport({ scale });
    const width = Math.ceil(renderViewport.width);
    const height = Math.ceil(renderViewport.height);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
        || width < 1 || height < 1 || width * height > limits.maxCropPixels) return null;
    const canvas = createCanvas(width, height);
    canvas.width = width;
    canvas.height = height;
    try {
        const task = page.render({ canvas, canvasContext: canvas.getContext('2d'),
            viewport: renderViewport, recordImages: true, recordOperations: true,
            background: 'rgb(255,255,255)', intent: 'print', annotationMode: 0 });
        await waitForFigureOperation(task.promise, signal, () => task.cancel());
        throwIfFigureAborted(signal);
        const boxes = imageBoxes(page.imageCoordinates, limits).map(box => box.map((value, axis) => (
            Math.min(1000, value * (axis % 2 === 0 ? width / renderViewport.width : height / renderViewport.height))
        )));
        const containers = boxes.filter(box => coversPanels(box, request.panels)
            && !(request.foreignLocations || []).some(location => validBox(location.bbox)
                && intersection(box, location.bbox) > 1));
        if (containers.length !== 1) return null;
        const bbox = containers[0];
        const text = await waitForFigureOperation(page.getTextContent(), signal);
        if (!Array.isArray(text.items) || text.items.length > limits.maxLayoutBlocks) return null;
        const captions = findPDFCaptions(text.items, viewport, request.caption).filter(box => (
            box[1] >= bbox[3] - 1 && box[1] - bbox[3] <= 40
            && box[0] < bbox[2] && box[2] > bbox[0]
        ));
        if (captions.length !== 1) return null;
        const labels = new Set(request.panels.map(panel => panel.label));
        if (text.items.some(item => {
            if (!labels.has(normalizeFigurePanelLabel(item.str))) return false;
            const box = textBox(item, viewport);
            if (box && captions.some(caption => box[0] >= caption[0] && box[1] >= caption[1]
                && box[2] <= caption[2] && box[3] <= caption[3])) return false;
            return box && box[0] < bbox[2] + 30 && box[2] > bbox[0] - 30
                && box[1] < bbox[3] + 30 && box[3] > bbox[1] - 30
                && (box[0] < bbox[0] || box[1] < bbox[1] || box[2] > bbox[2] || box[3] > bbox[3]);
        })) return null;
        for (const panel of request.panels) {
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
        const padded = bbox.map((value, axis) => Math.max(0, Math.min(1000, value + (axis < 2 ? -0.5 : 0.5))));
        const clearPadding = !(request.foreignLocations || []).some(location => validBox(location.bbox)
            && intersection(padded, location.bbox) > 0) && padded[3] < captions[0][1];
        return { bbox: clearPadding ? padded : bbox, captionBBox: captions[0], rotation: page.rotate };
    }
    finally {
        canvas.width = 0;
        canvas.height = 0;
    }
}

function imageBoxes(coordinates, limits) {
    if (!ArrayBuffer.isView(coordinates) || coordinates.length % 6
        || coordinates.length / 6 > limits.maxLayoutBlocks) return [];
    const boxes = [];
    for (let index = 0; index < coordinates.length; index += 6) {
        const [ax, ay, bx, by, cx, cy] = Array.from(coordinates.subarray(index, index + 6), value => value * 1000);
        if (![ax, ay, bx, by, cx, cy].every(Number.isFinite)) return [];
        // Skewed image rectangles do not establish ownership of their empty corners.
        if (Math.abs(ax - bx) > 1 && Math.abs(ay - by) > 1
            || Math.abs(ax - cx) > 1 && Math.abs(ay - cy) > 1) continue;
        const dx = bx + cx - ax;
        const dy = by + cy - ay;
        const box = [Math.min(ax, bx, cx, dx), Math.min(ay, by, cy, dy),
            Math.max(ax, bx, cx, dx), Math.max(ay, by, cy, dy)]
            .map(value => Math.max(0, Math.min(1000, value)));
        if (validBox(box)) boxes.push(box);
    }
    return boxes;
}

function coversPanels(box, panels) {
    const union = [Math.min(...panels.map(panel => panel.bbox[0])),
        Math.min(...panels.map(panel => panel.bbox[1])),
        Math.max(...panels.map(panel => panel.bbox[2])),
        Math.max(...panels.map(panel => panel.bbox[3]))];
    return area(box) <= 750_000 && area(box) <= area(union) * 1.6
        && panels.every(({ bbox }) => bbox[0] >= box[0] - 2 && bbox[1] >= box[1] - 2
            && bbox[2] <= box[2] + 2 && bbox[3] <= box[3] + 2);
}

function findPDFCaptions(items, viewport, caption) {
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

function textBox(item, viewport) {
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
    const sample = createCanvas(SAMPLE_EDGE, SAMPLE_EDGE);
    sample.width = sample.height = SAMPLE_EDGE;
    try {
        const context = sample.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, SAMPLE_EDGE, SAMPLE_EDGE);
        context.drawImage(image, 0, 0, SAMPLE_EDGE, SAMPLE_EDGE);
        const expected = grayscale(context.getImageData(0, 0, SAMPLE_EDGE, SAMPLE_EDGE).data);
        const width = (box[2] - box[0]) / 1000 * pageCanvas.width;
        const height = (box[3] - box[1]) / 1000 * pageCanvas.height;
        for (const dx of [-1, 0, 1]) {
            for (const dy of [-1, 0, 1]) {
                context.fillRect(0, 0, SAMPLE_EDGE, SAMPLE_EDGE);
                context.drawImage(pageCanvas, box[0] / 1000 * pageCanvas.width + dx,
                    box[1] / 1000 * pageCanvas.height + dy, width, height,
                    0, 0, SAMPLE_EDGE, SAMPLE_EDGE);
                if (matchingSamples(expected, grayscale(context.getImageData(0, 0, SAMPLE_EDGE, SAMPLE_EDGE).data))) return true;
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
    return Array.from({ length: data.length / 4 }, (_, index) => (
        (data[index * 4] * 0.299 + data[index * 4 + 1] * 0.587 + data[index * 4 + 2] * 0.114) / 255
    ));
}

function letters(text) { return String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); }
function validBox(box) { return isValidNormalizedSourceBBox(box) && box[0] < box[2] && box[1] < box[3]; }
function area(box) { return (box[2] - box[0]) * (box[3] - box[1]); }
function intersection(a, b) { return Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
    * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1])); }
