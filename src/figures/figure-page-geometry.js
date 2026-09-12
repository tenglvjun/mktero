import { FIGURE_LIMITS } from './figure-limits.js';

const ROTATIONS = new Set([0, 90, 180, 270]);

export function alignFigureInputToPDF(input, pageGeometryByIndex, { limits = FIGURE_LIMITS } = {}) {
    const alignments = new Map();
    for (const page of input.pages) {
        const geometry = pageGeometryByIndex instanceof Map
            ? pageGeometryByIndex.get(page.pageIndex) : pageGeometryByIndex?.[page.pageIndex];
        alignments.set(page.pageIndex, createAlignment(page, geometry, limits));
    }
    const failures = new Map();
    const transform = block => {
        const alignment = alignments.get(block.pageIndex);
        if (!block.bbox || !alignment?.convert) return { ...block };
        const bbox = alignment.convert(block.bbox);
        if (!bbox) failures.set(block.pageIndex, 'coordinate-mismatch');
        return { ...block, bbox, sourceBBox: [...block.bbox] };
    };
    const blocks = input.blocks.map(transform);
    const contentList = (input.contentList || []).map(transform);
    const pages = input.pages.map(page => {
        const alignment = alignments.get(page.pageIndex);
        const geometryReason = alignment.reason || failures.get(page.pageIndex);
        if (geometryReason) {
            return { ...page, coordinateFrame: 'unknown', geometryReason };
        }
        const geometry = alignment.geometry;
        return {
            ...page,
            width: geometry.width,
            height: geometry.height,
            unit: 'pt',
            dpi: null,
            rotation: geometry.rotation,
            coordinateFrame: 'display-cropbox',
            sourceGeometry: {
                width: page.width, height: page.height, unit: page.unit, dpi: page.dpi ?? null,
                rotation: page.rotation ?? null, coordinateFrame: page.coordinateFrame,
            },
            pdfGeometry: {
                width: geometry.width, height: geometry.height,
                rotation: geometry.rotation, userUnit: geometry.userUnit,
                viewBox: [...geometry.viewBox], mediaBox: geometry.mediaBox ? [...geometry.mediaBox] : null,
                viewportTransform: [...geometry.viewportTransform],
            },
        };
    });
    const invalidPages = new Set(pages.filter(page => page.geometryReason).map(page => page.pageIndex));
    return {
        ...input, pages,
        blocks: blocks.map((block, index) => invalidPages.has(block.pageIndex)
            ? { ...input.blocks[index] } : block),
        contentList: contentList.map(block => invalidPages.has(block.pageIndex)
            ? { ...block, bbox: null } : block),
    };
}

function createAlignment(page, geometry, limits) {
    if (!geometry || geometry.pageIndex !== page.pageIndex
        || !ROTATIONS.has(geometry.rotation) || !positive(geometry.userUnit)
        || !positive(geometry.width) || !positive(geometry.height)
        || !rectangle(geometry.viewBox) || !matrix(geometry.viewportTransform)
        || geometry.coordinateFrame !== 'display-cropbox'
        || !positive(page.width) || !positive(page.height)) {
        return { reason: 'missing-geometry' };
    }
    const displayed = page.coordinateFrame === 'display-cropbox';
    let frame = geometry.viewBox;
    if (page.coordinateFrame === 'unrotated-mediabox') {
        if (!rectangle(geometry.mediaBox)) return { reason: 'missing-geometry' };
        frame = geometry.mediaBox;
    }
    else if (!displayed && page.coordinateFrame !== 'unrotated-cropbox') {
        return { reason: 'missing-geometry' };
    }
    if (page.rotation !== undefined && page.rotation !== null
        && page.rotation !== (displayed ? geometry.rotation : 0)) {
        return { reason: 'coordinate-mismatch' };
    }
    const width = displayed ? geometry.width : (frame[2] - frame[0]) * geometry.userUnit;
    const height = displayed ? geometry.height : (frame[3] - frame[1]) * geometry.userUnit;
    if (!dimensionsMatch(page, width, height, geometry.userUnit, limits.geometryTolerance)) {
        return { reason: 'coordinate-mismatch' };
    }
    return {
        geometry,
        convert(bbox) {
            if (!rectangle(bbox) || bbox[0] < 0 || bbox[1] < 0 || bbox[2] > 1000 || bbox[3] > 1000) {
                return null;
            }
            if (displayed) return [...bbox];
            // Provider frames start at the top left; PDF user space starts at
            // the bottom left and may have a nonzero visible box origin.
            const points = [
                [bbox[0], bbox[1]], [bbox[2], bbox[1]],
                [bbox[0], bbox[3]], [bbox[2], bbox[3]],
            ].map(([x, y]) => applyMatrix(geometry.viewportTransform, [
                frame[0] + x * (frame[2] - frame[0]) / 1000,
                frame[3] - y * (frame[3] - frame[1]) / 1000,
            ]));
            const xs = points.map(point => point[0] * 1000 / geometry.width);
            const ys = points.map(point => point[1] * 1000 / geometry.height);
            const result = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
            if (result.some(value => !Number.isFinite(value) || value < -1e-7 || value > 1000 + 1e-7)) {
                return null;
            }
            return result.map(value => Math.min(1000, Math.max(0, value)));
        },
    };
}

function dimensionsMatch(page, width, height, userUnit, tolerance) {
    const close = (left, right) => Math.abs(left - right) / right <= tolerance;
    if (page.unit === 'pt') return close(page.width, width) && close(page.height, height);
    if (page.unit === 'pdf-user-unit') return close(page.width * userUnit, width)
        && close(page.height * userUnit, height);
    if (page.unit !== 'px') return false;
    if (page.dpi === null || page.dpi === undefined) return close(page.width / page.height, width / height);
    return positive(page.dpi) && close(page.width * 72 / page.dpi, width)
        && close(page.height * 72 / page.dpi, height);
}

function positive(value) {
    return Number.isFinite(value) && value > 0;
}

function rectangle(value) {
    return Array.isArray(value) && value.length === 4 && value.every(Number.isFinite)
        && value[2] > value[0] && value[3] > value[1];
}

function matrix(value) {
    return Array.isArray(value) && value.length === 6 && value.every(Number.isFinite)
        && Math.abs(value[0] * value[3] - value[1] * value[2]) > 0;
}

function applyMatrix([a, b, c, d, e, f], [x, y]) {
    return [a * x + c * y + e, b * x + d * y + f];
}
