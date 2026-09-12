import { isValidNormalizedSourceBBox } from '../core/markdown-source-map.js';
import { throwIfFigureAborted, waitForFigureOperation } from '../figures/figure-async.js';
import { figureLabelKey } from '../figures/figure-analysis.js';
import { findPDFCaptions, letters, textBox, verifyPDFPanelPixels } from './pdfjs-figure-evidence.js';

export async function verifyPDFFigureOrder(page, request, options) {
    const { createCanvas, decodeImage, signal, limits } = options;
    if (typeof decodeImage !== 'function' || page.rotate !== 0 || typeof request.title !== 'string'
        || request.title.length > 512 || !Array.isArray(request.panels)
        || request.panels.length < 2 || request.panels.length > limits.maxPanels
        || request.panels.some(panel => !validBox(panel.bbox))
        || !connectedPanels(request.panels)) return null;
    const viewport = page.getViewport({ scale: 1 });
    const text = await waitForFigureOperation(page.getTextContent(), signal);
    if (!Array.isArray(text.items) || text.items.length > limits.maxLayoutBlocks
        || text.items.length * request.panels.length > limits.maxComparisons) return null;
    const titles = findTitle(text.items, viewport, request.title);
    const captions = findPDFCaptions(text.items, viewport, request.caption);
    if (titles.length !== 1 || captions.length !== 1) return null;
    const titleBBox = titles[0];
    const captionBBox = captions[0];
    const panelBoxes = request.panels.map(panel => panel.bbox);
    const bbox = union(panelBoxes);
    const titleGap = bbox[1] - titleBBox[3];
    const captionGap = captionBBox[1] - bbox[3];
    if (titleGap < 0 || titleGap > 40 || captionGap < 0 || captionGap > 40
        || projection(titleBBox, bbox) < 0.7 || projection(captionBBox, bbox) < 0.5
        || Math.abs((titleBBox[0] + titleBBox[2] - bbox[0] - bbox[2]) / 2) > Math.max(40, (bbox[2] - bbox[0]) * 0.2)) return null;
    const region = union([bbox, titleBBox, captionBBox]);
    if ((request.foreignLocations || []).some(location => validBox(location.bbox)
        && intersection(region, location.bbox) > 1)) return null;
    for (const item of text.items) {
        const box = textBox(item, viewport);
        if (!box || !letters(item.str) || !intersection(region, box)) continue;
        if (contains(titleBBox, box, 1) || contains(captionBBox, box, 1)) continue;
        if (figureLabelKey(item.str) || !coveredPanelText(box, panelBoxes)) return null;
    }
    const scale = Math.min(3, 2400 / Math.max(viewport.width, viewport.height));
    const rendered = page.getViewport({ scale });
    const width = Math.ceil(rendered.width);
    const height = Math.ceil(rendered.height);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
        || width < 1 || height < 1 || width * height > limits.maxCropPixels) return null;
    const canvas = createCanvas(width, height);
    canvas.width = width;
    canvas.height = height;
    try {
        const task = page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: rendered,
            background: 'rgb(255,255,255)', intent: 'print', annotationMode: 0 });
        await waitForFigureOperation(task.promise, signal, () => task.cancel());
        throwIfFigureAborted(signal);
        return await verifyPDFPanelPixels(canvas, request.panels, viewport, options)
            ? { titleBBox, captionBBox } : null;
    }
    finally { canvas.width = canvas.height = 0; }
}

function findTitle(items, viewport, title) {
    const expected = letters(title);
    if (expected.length < 8) return [];
    const matches = [];
    for (let index = 0; index < items.length; index++) {
        const first = letters(items[index].str);
        if (!first || !expected.startsWith(first)) continue;
        let value = '';
        let box = null;
        let previous = null;
        for (const item of items.slice(index, index + 32)) {
            const part = letters(item.str);
            if (!part) continue;
            const next = textBox(item, viewport);
            if (!next || previous && !adjacentText(previous, next)) break;
            value += part;
            if (!expected.startsWith(value)) break;
            box = box ? union([box, next]) : next;
            previous = next;
            if (value === expected) { matches.push(box); break; }
        }
        if (matches.length > 1) return matches;
    }
    return matches;
}

function adjacentText(a, b) {
    const sameLine = Math.abs(a[1] - b[1]) <= 4 && b[0] >= a[0] - 1 && b[0] - a[2] <= 30;
    const nextLine = b[1] >= a[3] - 1 && b[1] - a[3] <= Math.max(8, (a[3] - a[1]) * 0.7)
        && b[0] <= a[2] && b[2] >= a[0];
    return sameLine || nextLine;
}

function connectedPanels(panels) {
    const visited = new Set([0]);
    for (let left = 0; left < panels.length; left++) {
        for (let right = left + 1; right < panels.length; right++) {
            if (intersection(panels[left].bbox, panels[right].bbox)
                > Math.min(area(panels[left].bbox), area(panels[right].bbox)) * 0.1) return false;
        }
    }
    const pending = [0];
    while (pending.length) {
        const a = panels[pending.pop()].bbox;
        for (let index = 0; index < panels.length; index++) {
            if (visited.has(index)) continue;
            const b = panels[index].bbox;
            const x = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
            const y = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
            const width = Math.min(a[2] - a[0], b[2] - b[0]);
            const height = Math.min(a[3] - a[1], b[3] - b[1]);
            if (x / width >= 0.35 && y >= -Math.min(80, Math.max(24, height * 0.6))
                || y / height >= 0.35 && x >= -60) {
                visited.add(index);
                pending.push(index);
            }
        }
    }
    return visited.size === panels.length;
}

function coveredPanelText(box, panels) {
    const intervals = panels.filter(panel => box[1] >= panel[1] - 3 && box[3] <= panel[3] + 3)
        .map(panel => [panel[0] - 3, panel[2] + 3]).sort((a, b) => a[0] - b[0]);
    let coveredTo = box[0];
    for (const [from, to] of intervals) {
        if (from > coveredTo) return false;
        coveredTo = Math.max(coveredTo, to);
        if (coveredTo >= box[2]) return true;
    }
    return false;
}

function union(boxes) {
    return [Math.min(...boxes.map(box => box[0])), Math.min(...boxes.map(box => box[1])),
        Math.max(...boxes.map(box => box[2])), Math.max(...boxes.map(box => box[3]))];
}
function validBox(box) { return isValidNormalizedSourceBBox(box) && box[0] < box[2] && box[1] < box[3]; }
function contains(a, b, tolerance) { return b[0] >= a[0] - tolerance && b[1] >= a[1] - tolerance
    && b[2] <= a[2] + tolerance && b[3] <= a[3] + tolerance; }
function area(box) { return (box[2] - box[0]) * (box[3] - box[1]); }
function projection(a, b) { return Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
    / Math.min(a[2] - a[0], b[2] - b[0]); }
function intersection(a, b) { return Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
    * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1])); }
