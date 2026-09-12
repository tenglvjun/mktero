import { isValidNormalizedSourceBBox } from '../core/markdown-source-map.js';
import { throwIfFigureAborted, waitForFigureOperation } from '../figures/figure-async.js';
import { normalizeFigurePanelLabel } from '../figures/figure-label-recovery.js';

import { findPDFCaptions, textBox, verifyPDFPanelPixels } from './pdfjs-figure-evidence.js';
export { matchingSamples } from './pdfjs-figure-evidence.js';

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
        if (!await verifyPDFPanelPixels(canvas, request.panels, viewport, { createCanvas, decodeImage, signal, limits })) return null;
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

function validBox(box) { return isValidNormalizedSourceBBox(box) && box[0] < box[2] && box[1] < box[3]; }
function area(box) { return (box[2] - box[0]) * (box[3] - box[1]); }
function intersection(a, b) { return Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
    * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1])); }
