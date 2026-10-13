// Landmarks are the reading positions a single key can jump to: headings,
// figures and tables, and annotations. The view already computes each list
// for the outline and the notes panel; this module merges and searches them.
// It is pure: no Zotero globals, no DOM.

export const LANDMARK_TYPE_HEADING = 'heading';
export const LANDMARK_TYPE_FIGURE = 'figure';
export const LANDMARK_TYPE_NOTE = 'note';

// One landmark per offset. When a heading, a figure and a note share an
// offset, the heading wins: it is the outline's anchor, and the outline
// click would land on the same place.
const TYPE_PRIORITY = Object.freeze([
    LANDMARK_TYPE_HEADING,
    LANDMARK_TYPE_FIGURE,
    LANDMARK_TYPE_NOTE,
]);

const VALID_TYPES = new Set(TYPE_PRIORITY);

export function mergeLandmarks({ headings = [], assets = [], noteOffsets = [] } = {}) {
    const entries = [];
    collectEntries(entries, headings, LANDMARK_TYPE_HEADING);
    collectEntries(entries, assets, LANDMARK_TYPE_FIGURE);
    collectEntries(entries, noteOffsets, LANDMARK_TYPE_NOTE);
    entries.sort(compareEntries);
    return dedupeByOffset(entries);
}

function collectEntries(entries, items, type) {
    for (const item of items || []) {
        const offset = normalizeOffset(item);
        if (offset === null) continue;
        entries.push({
            type,
            text: typeof item === 'object' && item !== null
                ? String(item.text || '')
                : '',
            offset,
        });
    }
}

function normalizeOffset(item) {
    const value = typeof item === 'object' && item !== null
        ? item.offset
        : item;
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return value;
}

function compareEntries(left, right) {
    if (left.offset !== right.offset) return left.offset - right.offset;
    return TYPE_PRIORITY.indexOf(left.type)
        - TYPE_PRIORITY.indexOf(right.type);
}

function dedupeByOffset(entries) {
    const merged = [];
    for (const entry of entries) {
        const previous = merged[merged.length - 1];
        if (previous && previous.offset === entry.offset) {
            // Entries arrive sorted, so a collision is adjacent. The earlier
            // entry already has the higher type priority.
            continue;
        }
        merged.push(entry);
    }
    return merged;
}

// The first landmark strictly after `offset`. Equal does not count: pressing
// "next" while sitting on a heading must move past it.
export function nextLandmark(items, offset) {
    return searchLandmarks(items, offset, 1);
}

// The last landmark strictly before `offset`.
export function previousLandmark(items, offset) {
    return searchLandmarks(items, offset, -1);
}

function searchLandmarks(items, offset, direction) {
    const list = Array.isArray(items) ? items : [];
    const current = Number(offset);
    if (!Number.isFinite(current)) return null;
    if (direction > 0) {
        for (const item of list) {
            if (item.offset > current) return item;
        }
        return null;
    }
    for (let index = list.length - 1; index >= 0; index -= 1) {
        if (list[index].offset < current) return list[index];
    }
    return null;
}
