import {
    isValidNormalizedSourceBBox,
    isValidSourceMapEntry,
} from './markdown-source-map.js';

const DEFAULT_PADDING_RATIO = 0.08;

export function selectSourcePeek(
    sourceMap,
    offset,
    documentLength = Infinity
) {
    if (!Array.isArray(sourceMap)
        || !Number.isSafeInteger(offset)
        || offset < 0
        || offset > documentLength) {
        return null;
    }

    const covering = [];
    let previous = null;
    for (const entry of sourceMap) {
        if (!isValidSourceMapEntry(entry, documentLength)) continue;
        if (entry.markdownFrom <= offset && offset < entry.markdownTo) {
            covering.push(entry);
        }
        if (entry.markdownFrom <= offset
            && (!previous || entry.markdownFrom >= previous.markdownFrom)) {
            previous = entry;
        }
    }

    const entry = tightestEntry(covering) || previous;
    if (!entry) return null;

    const pageIndex = entry.locations[0].pageIndex;
    const bbox = unionBBoxes(
        entry.locations
            .filter(location => location.pageIndex === pageIndex)
            .map(location => location.bbox)
    );
    if (!isValidNormalizedSourceBBox(bbox)) return null;

    return {
        pageIndex,
        bbox,
        markdownFrom: entry.markdownFrom,
        markdownTo: entry.markdownTo,
    };
}

export function sourcePeekKey(peek) {
    if (!peek
        || !Number.isSafeInteger(peek.pageIndex)
        || peek.pageIndex < 0) {
        return '';
    }
    return String(peek.pageIndex);
}

export function paddedNormalizedBBox(
    bbox,
    paddingRatio = DEFAULT_PADDING_RATIO
) {
    if (!isValidNormalizedSourceBBox(bbox)) return null;
    const ratio = Number.isFinite(paddingRatio)
        ? Math.max(0, Math.min(0.4, paddingRatio))
        : DEFAULT_PADDING_RATIO;
    const padX = (bbox[2] - bbox[0]) * ratio;
    const padY = (bbox[3] - bbox[1]) * ratio;
    const padded = [
        Math.max(0, bbox[0] - padX),
        Math.max(0, bbox[1] - padY),
        Math.min(1000, bbox[2] + padX),
        Math.min(1000, bbox[3] + padY),
    ];
    return isValidNormalizedSourceBBox(padded) ? padded : [...bbox];
}

export function normalizedBBoxToCanvasRect(bbox, width, height) {
    if (!isValidNormalizedSourceBBox(bbox)
        || !Number.isFinite(width)
        || !Number.isFinite(height)
        || width <= 0
        || height <= 0) {
        return null;
    }
    const x = Math.max(0, Math.floor(bbox[0] / 1000 * width));
    const y = Math.max(0, Math.floor(bbox[1] / 1000 * height));
    const right = Math.min(width, Math.ceil(bbox[2] / 1000 * width));
    const bottom = Math.min(height, Math.ceil(bbox[3] / 1000 * height));
    const cropWidth = Math.max(1, right - x);
    const cropHeight = Math.max(1, bottom - y);
    return {
        x,
        y,
        width: Math.min(cropWidth, width - x),
        height: Math.min(cropHeight, height - y),
    };
}

function tightestEntry(entries) {
    if (!entries.length) return null;
    return [...entries].sort((left, right) => (
        (left.markdownTo - left.markdownFrom)
            - (right.markdownTo - right.markdownFrom)
        || left.markdownFrom - right.markdownFrom
    ))[0];
}

function unionBBoxes(bboxes) {
    if (!bboxes.length) return null;
    return [
        Math.min(...bboxes.map(bbox => bbox[0])),
        Math.min(...bboxes.map(bbox => bbox[1])),
        Math.max(...bboxes.map(bbox => bbox[2])),
        Math.max(...bboxes.map(bbox => bbox[3])),
    ];
}
