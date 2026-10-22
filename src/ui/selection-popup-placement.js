// Zotero anchors the text-selection popup on the character where the selection
// ended. When that point is near a horizontal edge — a full-width figure
// caption ends at the right edge — it abandons above/below placement and drops
// the popup onto the selected lines. These helpers only describe a less
// covering rectangle; the guard applies it.

const OVERLAP_SLOP = 1;
const MIN_OVERLAP_REDUCTION = 8;
const DEFAULT_GAP = 12;
const DEFAULT_PADDING = 8;
const MIN_VIEW_SIZE = 20;

export function selectionPopupShift(popup, selectionRects, view, options = {}) {
    const lines = usableRects(selectionRects);
    const bounds = usableRect(view);
    const current = usableRect(popup);
    if (!current || !bounds || !lines.length) return null;
    if (bounds.right - bounds.left < MIN_VIEW_SIZE
        || bounds.bottom - bounds.top < MIN_VIEW_SIZE) {
        return null;
    }
    const currentArea = coveredArea(current, lines);
    if (currentArea <= 0) return null;

    const gap = finiteOption(options.gap, DEFAULT_GAP);
    const padding = finiteOption(options.padding, DEFAULT_PADDING);
    const width = current.right - current.left;
    const height = current.bottom - current.top;
    const selection = unionRect(lines);
    const centeredLeft = selection.left + (selection.right - selection.left - width) / 2;
    const candidates = [
        { left: centeredLeft, top: selection.bottom + gap },
        { left: centeredLeft, top: selection.top - gap - height },
        { left: bounds.left + padding, top: bounds.top + padding },
        { left: bounds.right - padding - width, top: bounds.top + padding },
        { left: bounds.left + padding, top: bounds.bottom - padding - height },
        { left: bounds.right - padding - width, top: bounds.bottom - padding - height },
    ];

    let best = null;
    for (const candidate of candidates) {
        const rect = clampRect(candidate, width, height, bounds, padding);
        const area = coveredArea(rect, lines);
        const distance = Math.abs(
            (rect.top + height / 2) - ((selection.top + selection.bottom) / 2)
        );
        if (!best || area < best.area || (area === best.area && distance < best.distance)) {
            best = { rect, area, distance };
        }
    }
    if (!best || best.area > currentArea - MIN_OVERLAP_REDUCTION) return null;
    const dx = best.rect.left - current.left;
    const dy = best.rect.top - current.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return null;
    return {
        dx,
        dy,
        side: best.rect.top + height / 2 < (selection.top + selection.bottom) / 2
            ? 'top'
            : 'bottom',
    };
}

export function translateClientRects(rects, origin) {
    if (!origin || !Number.isFinite(origin.left) || !Number.isFinite(origin.top)) {
        return [];
    }
    const scaleX = positiveScale(origin.scaleX);
    const scaleY = positiveScale(origin.scaleY);
    const translated = [];
    for (const rect of rects || []) {
        if (!Number.isFinite(rect?.left) || !Number.isFinite(rect?.top)
            || !Number.isFinite(rect?.right) || !Number.isFinite(rect?.bottom)) {
            continue;
        }
        const next = {
            left: origin.left + rect.left * scaleX,
            top: origin.top + rect.top * scaleY,
            right: origin.left + rect.right * scaleX,
            bottom: origin.top + rect.bottom * scaleY,
        };
        if (next.right - next.left > 0 && next.bottom - next.top > 0) {
            translated.push(next);
        }
    }
    return translated;
}

export function intersectRects(first, second) {
    const a = usableRect(first);
    const b = usableRect(second);
    if (!a) return b;
    if (!b) return a;
    const rect = {
        left: Math.max(a.left, b.left),
        top: Math.max(a.top, b.top),
        right: Math.min(a.right, b.right),
        bottom: Math.min(a.bottom, b.bottom),
    };
    if (rect.right - rect.left < 1 || rect.bottom - rect.top < 1) return a;
    return rect;
}

function clampRect(candidate, width, height, view, padding) {
    const minLeft = view.left + padding;
    const minTop = view.top + padding;
    const maxLeft = Math.max(minLeft, view.right - padding - width);
    const maxTop = Math.max(minTop, view.bottom - padding - height);
    const left = clamp(candidate.left, minLeft, maxLeft);
    const top = clamp(candidate.top, minTop, maxTop);
    return {
        left,
        top,
        right: left + width,
        bottom: top + height,
    };
}

function coveredArea(rect, lines) {
    let area = 0;
    for (const line of lines) {
        const width = Math.min(rect.right, line.right) - Math.max(rect.left, line.left);
        const height = Math.min(rect.bottom, line.bottom) - Math.max(rect.top, line.top);
        if (width > OVERLAP_SLOP && height > OVERLAP_SLOP) area += width * height;
    }
    return area;
}

function unionRect(rects) {
    return {
        left: Math.min(...rects.map(rect => rect.left)),
        top: Math.min(...rects.map(rect => rect.top)),
        right: Math.max(...rects.map(rect => rect.right)),
        bottom: Math.max(...rects.map(rect => rect.bottom)),
    };
}

function usableRects(rects) {
    if (!Array.isArray(rects)) return [];
    return rects.map(usableRect).filter(Boolean);
}

function usableRect(rect) {
    if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.top)
        || !Number.isFinite(rect.right) || !Number.isFinite(rect.bottom)) {
        return null;
    }
    if (rect.right - rect.left <= 0 || rect.bottom - rect.top <= 0) return null;
    return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
    };
}

function finiteOption(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}

function positiveScale(value) {
    return Number.isFinite(value) && value > 0 ? value : 1;
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
