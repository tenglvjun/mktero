import { isValidNormalizedSourceBBox } from '../core/markdown-source-map.js';
import { throwIfFigureAborted, waitForFigureOperation } from '../figures/figure-async.js';
import { normalizeFigurePanelLabel } from '../figures/figure-label-recovery.js';

import { findPDFCaptions, textBox, verifyPDFPanelPixels } from './pdfjs-figure-evidence.js';
import { inspectDocumentFigureImage } from './pdfjs-document-figure.js';
export { matchingSamples } from './pdfjs-figure-evidence.js';

// An unnumbered figure (for example a graphical abstract) is one raster image
// whose interior labels MinerU reports as ordinary text. Only this stricter
// evidence path may consume that text, and only when the PDF image container
// itself holds it.
const EMBEDDED_EDGE_TOLERANCE = 10;
const EMBEDDED_MIN_INSIDE_RATIO = 0.6;
const EMBEDDED_MAX_CROP_GROWTH = 1.25;
const EMBEDDED_MAX_PASSES = 4;
const MAX_IMAGE_AREA = 750_000;

export async function inspectPDFFigureImage(page, request, options) {
    if (request?.mode === 'document-figure') return inspectDocumentFigureImage(page, request, options);
    if (request?.mode === 'embedded-text') return inspectEmbeddedTextImage(page, request, options);
    return inspectCaptionedFigureImage(page, request, options);
}

async function inspectCaptionedFigureImage(page, request, {
    createCanvas, decodeImage, signal, limits,
}) {
    const region = request.mode === 'captioned-region';
    const foreign = request.foreignLocations || [];
    if (typeof decodeImage !== 'function' || !Array.isArray(request.panels)
        || request.panels.length < (region ? 1 : 2) || request.panels.length > limits.maxPanels
        || request.panels.some(panel => !validBox(panel?.bbox))
        || !Array.isArray(foreign) || foreign.length > limits.maxLayoutBlocks
        || foreign.some(location => !validBox(location?.bbox))
        || region && !validBox(request.visualBBox)) return null;
    const setup = pageRenderSetup(page, limits);
    if (!setup) return null;
    const { viewport, renderViewport, width, height } = setup;
    const canvas = createCanvas(width, height);
    canvas.width = width;
    canvas.height = height;
    try {
        const context = canvas.getContext?.('2d');
        if (!context) return null;
        const task = page.render({ canvas, canvasContext: context,
            viewport: renderViewport, recordImages: true, recordOperations: true,
            background: 'rgb(255,255,255)', intent: 'print', annotationMode: 0 });
        await waitForFigureOperation(task.promise, signal, () => task.cancel());
        throwIfFigureAborted(signal);
        const boxes = imageBoxes(page.imageCoordinates, limits).map(box => box.map((value, axis) => (
            Math.min(1000, value * (axis % 2 === 0 ? width / renderViewport.width : height / renderViewport.height))
        )));
        let comparisons = boxes.length * (request.panels.length + foreign.length);
        if (comparisons > limits.maxComparisons) return null;
        const containers = boxes.filter(box => (region
            ? coversPanelsWithin(box, request.panels, EMBEDDED_EDGE_TOLERANCE)
            : coversPanels(box, request.panels))
            && !foreign.some(location => intersection(region
                ? unionBoxes([box, request.visualBBox]) : box, location.bbox) > 0));
        if (containers.length !== 1) return null;
        const bbox = region ? unionBoxes([containers[0], request.visualBBox]) : containers[0];
        if (region && (area(bbox) > MAX_IMAGE_AREA || area(bbox) > area(request.visualBBox) * 1.6)) return null;
        const text = await waitForFigureOperation(page.getTextContent(), signal);
        if (!Array.isArray(text.items) || text.items.length > limits.maxLayoutBlocks) return null;
        comparisons += text.items.length * 14 + foreign.length;
        if (comparisons > limits.maxComparisons) return null;
        // OCR membership is fixed. Native text in the added strip could be
        // article prose absent from the OCR layout, so it prevents expansion.
        if (region && text.items.some(item => {
            const box = textBox(item, viewport);
            return box && intersection(box, bbox) > 1
                && !containsWithin(request.visualBBox, box, 1);
        })) return null;
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
        const clearPadding = !foreign.some(location => intersection(padded, location.bbox) > 0)
            && padded[3] < captions[0][1];
        return { bbox: clearPadding ? padded : bbox, captionBBox: captions[0], rotation: page.rotate };
    }
    finally {
        canvas.width = 0;
        canvas.height = 0;
    }
}

async function inspectEmbeddedTextImage(page, request, {
    createCanvas, decodeImage, signal, limits,
}) {
    const textBlocks = request.textBlocks;
    const foreign = request.foreignLocations || [];
    if (typeof decodeImage !== 'function'
        || !Array.isArray(request.panels) || request.panels.length < 2
        || request.panels.length > limits.maxPanels
        || request.panels.some(panel => !validBox(panel?.bbox))
        || !Array.isArray(textBlocks) || textBlocks.length > limits.maxLayoutBlocks
        || textBlocks.some(block => typeof block?.id !== 'string' || !block.id || !validBox(block.bbox))
        || new Set(textBlocks.map(block => block.id)).size !== textBlocks.length
        || !Array.isArray(foreign) || foreign.length > limits.maxLayoutBlocks
        // An unusable foreign box cannot be proven disjoint from the crop, so it
        // rejects the request instead of being silently dropped.
        || foreign.some(location => !validBox(location?.bbox))) return null;
    const setup = pageRenderSetup(page, limits);
    if (!setup) return null;
    const { viewport, renderViewport, width, height } = setup;
    const canvas = createCanvas(width, height);
    canvas.width = width;
    canvas.height = height;
    try {
        const context = canvas.getContext?.('2d');
        if (!context) return null;
        const task = page.render({ canvas, canvasContext: context,
            viewport: renderViewport, recordImages: true, recordOperations: true,
            background: 'rgb(255,255,255)', intent: 'print', annotationMode: 0 });
        await waitForFigureOperation(task.promise, signal, () => task.cancel());
        throwIfFigureAborted(signal);
        const boxes = imageBoxes(page.imageCoordinates, limits).map(box => box.map((value, axis) => (
            Math.min(1000, value * (axis % 2 === 0 ? width / renderViewport.width : height / renderViewport.height))
        )));
        const blocked = foreign.map(location => location.bbox);
        // Every container is tested against every panel and every foreign box,
        // and every PDF text item against the final crop; all of it is charged so
        // a huge page cannot turn these scans into unbounded work.
        let comparisons = 0;
        const charge = count => (comparisons += count) <= limits.maxComparisons;
        if (!charge(boxes.length * (request.panels.length + blocked.length))) return null;
        const containers = boxes.filter(box => coversPanelsWithin(box, request.panels, EMBEDDED_EDGE_TOLERANCE)
            && !blocked.some(location => intersection(box, location) > 1));
        if (containers.length !== 1) return null;
        const container = containers[0];
        let crop = unionBoxes([container, ...request.panels.map(panel => panel.bbox)]);
        let owned = [];
        let stable = false;
        // A few OCR text boxes sit a few units outside the rasterized edge; grow
        // the crop over them, then prove nothing foreign was pulled in.
        for (let pass = 0; pass < EMBEDDED_MAX_PASSES && !stable; pass++) {
            const current = [];
            for (const block of textBlocks) {
                if (!charge(1)) return null;
                if (intersection(crop, block.bbox) <= 0) continue;
                if (!containsWithin(crop, block.bbox, EMBEDDED_EDGE_TOLERANCE)
                    || insideRatio(container, block.bbox) < EMBEDDED_MIN_INSIDE_RATIO) return null;
                current.push(block);
            }
            const next = unionBoxes([crop, ...current.map(block => block.bbox)]);
            stable = current.length === owned.length && sameBox(next, crop);
            owned = current;
            crop = next;
        }
        if (!stable || !owned.length) return null;
        if (area(crop) > MAX_IMAGE_AREA || area(crop) > area(container) * EMBEDDED_MAX_CROP_GROWTH) return null;
        if (!charge(owned.length * blocked.length)
            || blocked.some(location => intersection(crop, location) > 1)) return null;
        const text = await waitForFigureOperation(page.getTextContent(), signal);
        if (!Array.isArray(text.items) || text.items.length > limits.maxLayoutBlocks) return null;
        if (!charge(text.items.length)) return null;
        // Real PDF text inside the container means the region is not one raster
        // image; consuming it would delete selectable article text.
        if (text.items.some(item => {
            const box = textBox(item, viewport);
            return box && intersection(box, crop) > 1;
        })) return null;
        if (!await verifyPDFPanelPixels(canvas, request.panels, viewport, { createCanvas, decodeImage, signal, limits })) return null;
        return { bbox: crop, captionBBox: null, rotation: page.rotate,
            ownedTextBlockIds: owned.map(block => block.id) };
    }
    finally {
        canvas.width = 0;
        canvas.height = 0;
    }
}

function pageRenderSetup(page, limits) {
    const viewport = page.getViewport({ scale: 1 });
    const scale = Math.min(1.5, 1200 / Math.max(viewport.width, viewport.height));
    const renderViewport = page.getViewport({ scale });
    const width = Math.ceil(renderViewport.width);
    const height = Math.ceil(renderViewport.height);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
        || width < 1 || height < 1 || width * height > limits.maxCropPixels) return null;
    return { viewport, renderViewport, width, height };
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

function coversPanelsWithin(box, panels, tolerance) {
    const union = unionBoxes(panels.map(panel => panel.bbox));
    return area(box) <= MAX_IMAGE_AREA && area(box) <= area(union) * 1.6
        && panels.every(({ bbox }) => containsWithin(box, bbox, tolerance));
}

function containsWithin(outer, inner, tolerance) {
    return inner[0] >= outer[0] - tolerance && inner[1] >= outer[1] - tolerance
        && inner[2] <= outer[2] + tolerance && inner[3] <= outer[3] + tolerance;
}

function insideRatio(outer, inner) {
    return intersection(outer, inner) / area(inner);
}

function unionBoxes(boxes) {
    const union = [...boxes[0]];
    for (const box of boxes.slice(1)) {
        union[0] = Math.min(union[0], box[0]);
        union[1] = Math.min(union[1], box[1]);
        union[2] = Math.max(union[2], box[2]);
        union[3] = Math.max(union[3], box[3]);
    }
    return union;
}

function sameBox(left, right) {
    return left.every((value, axis) => Math.abs(value - right[axis]) < 1e-6);
}

function validBox(box) { return isValidNormalizedSourceBBox(box) && box[0] < box[2] && box[1] < box[3]; }
function area(box) { return (box[2] - box[0]) * (box[3] - box[1]); }
function intersection(a, b) { return Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
    * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1])); }
