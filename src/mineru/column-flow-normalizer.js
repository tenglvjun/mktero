import { isValidSourceMapEntry } from '../core/markdown-source-map.js';

const MIN_COLUMN_WIDTH = 180;
const MIN_COLUMN_MID_GAP = 80;
const COLUMN_MID_GAP_RATIO = 0.2;
const SPANNING_WIDTH_RATIO = 0.55;
const EXCLUDED_LAYOUT_BLOCK_PATTERN = /^(?: {0,3}(?:>|(?:[-+*]|\d+[.)])[ \t]+|```|~~~)| {4}\S|\t\S|<)/u;

export function reassembleMinerUColumnFlow(markdown, sourceMap) {
    const source = String(markdown || '');
    if (!source || !Array.isArray(sourceMap)) return source;

    const entries = sourceMap
        .filter(entry => isValidSourceMapEntry(entry, source.length))
        .sort((left, right) => left.markdownFrom - right.markdownFrom);
    const edits = [];
    let run = [];

    const flush = () => {
        if (run.length >= 2) {
            const edit = reorderRun(source, run);
            if (edit) edits.push(edit);
        }
        run = [];
    };

    for (const entry of entries) {
        if (!isReorderableLayoutEntry(source, entry)) {
            flush();
            continue;
        }
        const previous = run.at(-1);
        if (previous
            && (flowPageIndex(previous) !== flowPageIndex(entry)
                || source.slice(previous.markdownTo, entry.markdownFrom).trim())) {
            flush();
        }
        run.push(entry);
    }
    flush();

    return applyNonOverlappingEdits(source, edits);
}

function isReorderableLayoutEntry(source, entry) {
    if (!entry.locations.length) return false;
    if (entry.type !== 'text' && entry.type !== 'equation') return false;
    const text = source.slice(entry.markdownFrom, entry.markdownTo);
    if (!text.trim()) return false;
    if (entry.type === 'equation') return true;
    return !EXCLUDED_LAYOUT_BLOCK_PATTERN.test(text);
}

function reorderRun(source, entries) {
    const unionWidth = runUnionWidth(entries);
    const spanning = new Set(entries.filter(entry => (
        isSpanningEntry(entry, unionWidth)
    )));
    const columns = detectColumns(
        entries.filter(entry => !spanning.has(entry)),
        unionWidth
    );
    const ordered = [...entries].sort(compareLayoutPosition(columns, spanning));
    if (ordered.every((entry, index) => entry === entries[index])) return null;

    const separators = entries.slice(0, -1).map((entry, index) => (
        source.slice(entry.markdownTo, entries[index + 1].markdownFrom)
    ));
    const blocks = ordered.map(entry => (
        source.slice(entry.markdownFrom, entry.markdownTo)
    ));
    return {
        from: entries[0].markdownFrom,
        to: entries.at(-1).markdownTo,
        replacement: joinWithSeparators(blocks, separators),
    };
}

function compareLayoutPosition(columns, spanning) {
    return (left, right) => {
        const leftBox = entryStartLocation(left).bbox;
        const rightBox = entryStartLocation(right).bbox;
        if (columns && !spanning.has(left) && !spanning.has(right)) {
            const leftColumn = entryMidX(left) < columns.split ? 0 : 1;
            const rightColumn = entryMidX(right) < columns.split ? 0 : 1;
            if (leftColumn !== rightColumn) return leftColumn - rightColumn;
        }
        return leftBox[1] - rightBox[1]
            || leftBox[0] - rightBox[0]
            || left.markdownFrom - right.markdownFrom;
    };
}

function detectColumns(entries, unionWidth) {
    if (entries.length < 2) return null;
    const sorted = [...entries].sort((left, right) => (
        entryMidX(left) - entryMidX(right)
    ));
    const minMidGap = Math.max(
        MIN_COLUMN_MID_GAP,
        unionWidth * COLUMN_MID_GAP_RATIO
    );
    let best = null;
    for (let index = 0; index < sorted.length - 1; index++) {
        const leftEntries = sorted.slice(0, index + 1);
        const rightEntries = sorted.slice(index + 1);
        const leftMid = Math.max(...leftEntries.map(entryMidX));
        const rightMid = Math.min(...rightEntries.map(entryMidX));
        const midGap = rightMid - leftMid;
        if (midGap < minMidGap
            || !hasColumnWidth(leftEntries)
            || !hasColumnWidth(rightEntries)) {
            continue;
        }
        if (!best || midGap > best.gap) {
            best = {
                gap: midGap,
                split: (leftMid + rightMid) / 2,
            };
        }
    }
    return best;
}

function entryMidX(entry) {
    const bbox = entryStartLocation(entry).bbox;
    return (bbox[0] + bbox[2]) / 2;
}

function runUnionWidth(entries) {
    const left = Math.min(...entries.map(entry => (
        entryStartLocation(entry).bbox[0]
    )));
    const right = Math.max(...entries.map(entry => (
        entryStartLocation(entry).bbox[2]
    )));
    return right - left;
}

function isSpanningEntry(entry, unionWidth) {
    if (!(unionWidth > 0)) return false;
    const bbox = entryStartLocation(entry).bbox;
    return bbox[2] - bbox[0] >= unionWidth * SPANNING_WIDTH_RATIO;
}

function hasColumnWidth(entries) {
    const left = Math.min(...entries.map(entry => (
        entryStartLocation(entry).bbox[0]
    )));
    const right = Math.max(...entries.map(entry => (
        entryStartLocation(entry).bbox[2]
    )));
    return right - left >= MIN_COLUMN_WIDTH;
}

function flowPageIndex(entry) {
    return entry.locations.reduce((pageIndex, location) => (
        pageIndex === null || location.pageIndex < pageIndex
            ? location.pageIndex
            : pageIndex
    ), null);
}

function entryStartLocation(entry) {
    return entry.locations.reduce((start, location) => {
        if (!start
            || location.pageIndex < start.pageIndex
            || (location.pageIndex === start.pageIndex
                && (location.bbox[1] < start.bbox[1]
                    || (location.bbox[1] === start.bbox[1]
                        && location.bbox[0] < start.bbox[0])))) {
            return location;
        }
        return start;
    }, null);
}

function joinWithSeparators(blocks, separators) {
    let result = blocks[0];
    for (let index = 1; index < blocks.length; index++) {
        result += separators[index - 1] + blocks[index];
    }
    return result;
}

function applyNonOverlappingEdits(source, edits) {
    const sorted = [...edits].sort((left, right) => right.from - left.from);
    let result = source;
    let lastFrom = source.length + 1;
    for (const edit of sorted) {
        if (edit.to > lastFrom) continue;
        result = result.slice(0, edit.from)
            + edit.replacement
            + result.slice(edit.to);
        lastFrom = edit.from;
    }
    return result;
}
