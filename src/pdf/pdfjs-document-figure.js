import { isValidNormalizedSourceBBox } from '../core/markdown-source-map.js';
import { throwIfFigureAborted, waitForFigureOperation } from '../figures/figure-async.js';
import { textBox, verifyPDFPanelPixels } from './pdfjs-figure-evidence.js';

// A document figure is one native PDF image whose OCR fragments may have been
// split across block kinds (a forest plot can arrive as a table plus a chart).
// Only this path may put them back together, and only after the page proves a
// single image container owns every fragment, each fragment's own pixels match
// the page, and the caption found in the PDF's own text is complete, unique,
// and printed outside the image. The crop is the native container, never the
// OCR boxes: an OCR box may include white margins and a baked-in caption.
const MIN_INSIDE_RATIO = 0.6;
const MAX_CROP_GROWTH = 1.6;
const MAX_IMAGE_AREA = 750_000;
const CAPTION_PROXIMITY = 60;
const CAPTION_LINE_GAP = 15;
const MAX_CAPTION_ITEMS = 12;

export async function inspectDocumentFigureImage(page, request, {
    createCanvas, decodeImage, signal, limits,
}) {
    if (typeof decodeImage !== 'function' || !Array.isArray(request?.panels)
        || request.panels.length < 1 || request.panels.length > limits.maxPanels
        || request.panels.some(panel => !validBox(panel?.bbox) || !panel.asset)
        || new Set(request.panels.map(panel => panel.id)).size !== request.panels.length
        || !validCaption(request.caption)
        || !Array.isArray(request.foreignLocations)
        || request.foreignLocations.length > limits.maxLayoutBlocks
        // An unusable foreign box cannot be proven disjoint from the crop, so it
        // rejects the request instead of being silently dropped.
        || request.foreignLocations.some(location => !validBox(location?.bbox))) return null;
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
        const boxes = imageBoxes(page.imageCoordinates, limits);
        const blocked = request.foreignLocations.map(location => location.bbox);
        // Every container is tested against every panel and every foreign box,
        // and every PDF text item against the final crop; all of it is charged so
        // a huge page cannot turn these scans into unbounded work.
        let comparisons = 0;
        const charge = count => (comparisons += count) <= limits.maxComparisons;
        if (!charge(boxes.length * (request.panels.length + blocked.length))) return null;
        // The container must own every fragment: each OCR box keeps at least
        // MIN_INSIDE_RATIO of its area inside it. A fragment may extend outside
        // only over a caption the OCR crop swallowed, which is checked below.
        const union = unionBoxes(request.panels.map(panel => panel.bbox));
        const containers = boxes.filter(box => area(box) <= MAX_IMAGE_AREA
            && area(box) <= area(union) * MAX_CROP_GROWTH
            && request.panels.every(panel => insideRatio(box, panel.bbox) >= MIN_INSIDE_RATIO)
            && !blocked.some(location => intersection(box, location) > 1));
        if (containers.length !== 1) return null;
        const container = containers[0];
        const text = await waitForFigureOperation(page.getTextContent(), signal);
        if (!Array.isArray(text.items) || text.items.length > limits.maxLayoutBlocks) return null;
        if (!charge(text.items.length * MAX_CAPTION_ITEMS)) return null;
        const captionBoxes = captionBoxesIn(text.items, viewport, request.caption);
        if (captionBoxes.length !== 1) return null;
        const captionBox = captionBoxes[0];
        // The caption must be printed outside the picture and near it, not
        // inside the image or on another part of the page.
        if (intersection(container, captionBox) > 1
            || !nearContainer(container, captionBox)) return null;
        // Real PDF text inside the container means the region is not one raster
        // image; consuming it would delete selectable article text. The verified
        // caption and its first line are the only permitted native text.
        if (text.items.some(item => {
            const box = textBox(item, viewport);
            return box && intersection(box, container) > 1
                && intersection(box, captionBox) <= 0;
        })) return null;
        // Verify every original OCR fragment against the page over its own
        // full box, including any caption it baked in, so a wrong or stale
        // fragment can never be replaced by the native image.
        if (!charge(request.panels.length)) return null;
        if (!await verifyPDFPanelPixels(canvas, request.panels, viewport,
            { createCanvas, decodeImage, signal, limits })) return null;
        return {
            bbox: container.map(value => Math.max(0, Math.min(1000, value))),
            captionBBox: [...captionBox],
            rotation: page.rotate,
        };
    }
    finally {
        canvas.width = 0;
        canvas.height = 0;
    }
}

function validCaption(caption) {
    return caption && typeof caption.text === 'string' && caption.text.trim()
        && caption.text.length <= 8192 && validBox(caption.bbox);
}

// The native text that spells this figure's complete caption, exactly once.
// The label and its description can be printed on separate lines, so adjacent
// items in reading order are joined and compared on letters only. A label alone
// is never enough: a caption OCR truncated, or a neighbouring figure's label,
// must not unlock the native image.
function captionBoxesIn(items, viewport, caption) {
    const expected = letters(caption.text);
    const label = figureLabelKey(caption.label);
    if (expected.length < 4 || !label) return [];
    const boxes = [];
    for (let index = 0; index < items.length; index++) {
        const item = items[index];
        if (!/^(?:fig(?:ure)?[.\uFF0E]?|图)/iu.test(item.str?.trim() || '')) continue;
        let value = '';
        let box = null;
        for (const next of items.slice(index, index + MAX_CAPTION_ITEMS)) {
            if (!String(next.str || '').trim()) continue;
            const nextBox = textBox(next, viewport);
            if (!nextBox || box && !continuesCaption(box, nextBox)) break;
            value += ' ' + next.str;
            box = box ? unionBoxes([box, nextBox]) : nextBox;
            const actual = letters(value);
            if (actual.length > expected.length + 8) break;
            if (figureLabelKey(value) === label && actual === expected) {
                boxes.push(box);
                break;
            }
        }
    }
    return boxes;
}

// Same line, or the next line of the same caption printed directly below it.
function continuesCaption(box, next) {
    if (Math.abs(next[1] - box[1]) <= 4
        && next[0] >= box[0] - 1 && next[0] - box[2] <= 30) return true;
    return next[1] >= box[3] - 2 && next[1] - box[3] <= CAPTION_LINE_GAP
        && next[0] >= box[0] - 4 && next[0] - box[0] <= 30;
}

function nearContainer(container, caption) {
    const gap = caption[1] >= container[3]
        ? caption[1] - container[3]
        : container[1] - caption[3];
    return gap >= 0 && gap <= CAPTION_PROXIMITY;
}

function figureLabelKey(value) {
    const match = String(value || '').normalize('NFKC').trim()
        .match(/^(?:(?:extended\s+data|supplement(?:ary|al)?|suppl\.?)\s+)?(?:algorithm|chart|fig\.?|figure|scheme|table)\s*([A-Z]?\d+[a-z]?)/iu);
    return match ? `figure:${match[1].toLowerCase()}` : null;
}

function letters(text) {
    return String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
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
        const values = Array.from(coordinates.subarray(index, index + 6), value => value * 1000);
        const [ax, ay, bx, by, cx, cy] = values;
        if (!values.every(Number.isFinite)) return [];
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

function validBox(box) {
    return isValidNormalizedSourceBBox(box) && box[0] < box[2] && box[1] < box[3];
}

function area(box) { return (box[2] - box[0]) * (box[3] - box[1]); }
function intersection(a, b) {
    return Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
        * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
}
