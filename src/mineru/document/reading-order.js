import { BLOCK_KIND, BLOCK_ROLE, blockPlainText, isFloatBlock } from './ir.js';

const SPAN_SHARE = 0.6;
const COLUMN_GAP_SHARE = 0.25;
const GUTTER_MARGIN_SHARE = 0.02;
const MAX_COLUMNS = 3;
const MAX_COLUMN_SPREAD_SHARE = 0.2;
const MIN_COLUMN_BLOCK_HEIGHT = 30;
const MIN_REFERENCE_COLUMN_ENTRIES = 3;
const ORDER_TOLERANCE = 2;
const FLOAT_OVERLAP_SHARE = 0.5;
const FLOW_ROLES = new Set([BLOCK_ROLE.BODY, BLOCK_ROLE.HEADING, BLOCK_ROLE.REFERENCE]);
export const REFERENCE_HEADING = /^(?:[0-9IVX]+\.?\s+)?(?:references?|bibliography|literature cited|works cited|reference list|参考文献)$/iu;

export function isFlowBlock(block) {
    return FLOW_ROLES.has(block?.role) && !isFloatBlock(block);
}

// MinerU's order is kept unless it contradicts the page geometry, and only
// the contradicting blocks move. On a multi-column page:
// - A pure separator (text across the gutter with no text beside it, such
//   as a centered heading) must follow all text above it and precede all
//   text below it; the page is read as slices between pure separators.
// - Inside a slice, a block must not start above the end of an earlier
//   block of a column to its right (a right-column heading read before the
//   left column), nor lie wholly above an earlier block of its own column.
// Text below both columns (back matter after a two-column body) starts
// below them, so it is never a contradiction.
export function orderReadingFlow(ir) {
    const byPage = new Map();
    for (const [position, block] of ir.blocks.entries()) {
        if (!byPage.has(block.pageIndex)) byPage.set(block.pageIndex, []);
        byPage.get(block.pageIndex).push({ block, position });
    }
    const pages = new Map(ir.pages.map(page => [page.pageIndex, page]));
    let blocks = [...ir.blocks];
    for (const [pageIndex, entries] of byPage) {
        const layout = assignPageColumns(entries.map(entry => entry.block));
        const page = pages.get(pageIndex);
        if (page) {
            page.columns = layout.columns;
            page.gutters = layout.gutters;
            page.textWidth = layout.width;
        }
        if (layout.columns < 2) {
            blocks = orderReferenceEntries(blocks, entries, ir.diagnostics, pageIndex);
            continue;
        }
        const text = entries.filter(entry => isFlowBlock(entry.block) && entry.block.bbox);
        const separators = pureSeparators(text);
        const sliced = sliceBySeparators(text, separators) || text;
        const repaired = [];
        for (const slice of splitAtSeparators(sliced, separators)) repaired.push(...repairSlice(slice));
        if (repaired.some((entry, index) => entry !== text[index])) {
            blocks = applyOrder(blocks, text, repaired, ir.diagnostics, pageIndex,
                sliced !== text ? 'separator' : 'column');
        }
    }
    ir.blocks = placeFloatsBelowText(blocks, ir.diagnostics);
    markReferenceSections(ir);
    return ir;
}

// On a single-column page, reference entries are read top to bottom. MinerU
// sometimes reads an entry before the continuation of the previous page's
// last entry at the top of the page; that entry moves after the blocks above
// it. Other text on such a page keeps MinerU's order.
function orderReferenceEntries(blocks, entries, diagnostics, pageIndex) {
    const references = entries.filter(entry => entry.block.role === BLOCK_ROLE.REFERENCE && entry.block.bbox);
    if (references.length < 2) return blocks;
    const repaired = repairSlice(references);
    return repaired.some((entry, index) => entry !== references[index])
        ? applyOrder(blocks, references, repaired, diagnostics, pageIndex, 'reference')
        : blocks;
}

// A float that MinerU read before flow text lying wholly above it, in the
// same horizontal range of the same page, moves to just after the last such
// text (a table read before the heading above it). Its attached notes move
// with it. Text beside the float, in another column, never moves it, and a
// float is never moved earlier.
function placeFloatsBelowText(blocks, diagnostics) {
    let output = blocks;
    const lastPlaced = new Map();
    for (const float of blocks.filter(block => isFloatBlock(block) && block.bbox)) {
        const from = output.indexOf(float);
        let anchor = -1;
        for (let index = from + 1; index < output.length; index++) {
            const block = output[index];
            if (block.pageIndex !== float.pageIndex) continue;
            if (isFlowBlock(block) && block.bbox && block.bbox[3] <= float.bbox[1] + ORDER_TOLERANCE
                && overlapShare(block.bbox, float.bbox) >= FLOAT_OVERLAP_SHARE) {
                anchor = index;
            }
        }
        if (anchor < 0) continue;
        const moving = [float, ...output.slice(from + 1, anchor + 1)
            .filter(block => block.attachedTo === float.id)];
        const target = output[anchor];
        const rest = output.filter(block => !moving.includes(block));
        rest.splice(rest.indexOf(lastPlaced.get(target) || target) + 1, 0, ...moving);
        lastPlaced.set(target, moving.at(-1));
        diagnostics.reorderedBands.push({
            pageIndex: float.pageIndex,
            rule: 'float',
            before: [float.id, target.id],
            after: [target.id, float.id],
        });
        output = rest;
    }
    return output;
}

function overlapShare(left, right) {
    const overlap = Math.min(left[2], right[2]) - Math.max(left[0], right[0]);
    const narrower = Math.min(left[2] - left[0], right[2] - right[0]);
    return overlap > 0 && narrower > 0 ? overlap / narrower : 0;
}

// Column layout of one page from the boxes of its flow text. Each block gets
// `column` (0-based, or 'span' for a block across the gutter); the page
// records the column count.
export function assignPageColumns(blocks) {
    const text = blocks.filter(block => isFlowBlock(block) && block.bbox);
    if (!text.length) return { columns: 1, width: 0, gutters: [] };
    const left = Math.min(...text.map(block => block.bbox[0]));
    const right = Math.max(...text.map(block => block.bbox[2]));
    const width = Math.max(1, right - left);
    const narrow = text.filter(block => block.bbox[2] - block.bbox[0] < SPAN_SHARE * width);
    const gutters = findGutters(narrow, width);
    const margin = GUTTER_MARGIN_SHARE * width;
    for (const block of blocks) {
        if (!block.bbox || !gutters.length) {
            block.column = 0;
            continue;
        }
        const crosses = gutters.some(gutter => (
            block.bbox[0] < gutter.from - margin && block.bbox[2] > gutter.to + margin
        ));
        block.column = crosses || block.bbox[2] - block.bbox[0] >= SPAN_SHARE * width
            ? 'span'
            : gutters.filter(gutter => (gutter.from + gutter.to) / 2 < center(block.bbox)).length;
    }
    return { columns: gutters.length + 1, width, gutters };
}

// Column of any box on a page with the given layout: 'span' across a
// gutter, otherwise the 0-based column.
export function columnOfBox(bbox, page) {
    const gutters = page?.gutters || [];
    if (!bbox || !gutters.length) return 0;
    const width = page.textWidth || 1000;
    const margin = GUTTER_MARGIN_SHARE * width;
    if (bbox[2] - bbox[0] >= SPAN_SHARE * width
        || gutters.some(gutter => bbox[0] < gutter.from - margin && bbox[2] > gutter.to + margin)) {
        return 'span';
    }
    return gutters.filter(gutter => (gutter.from + gutter.to) / 2 < center(bbox)).length;
}

// Gutters between column clusters. Cluster edges use the median of the
// paragraph boxes, so a short heading or a wide outlier does not move them.
function findGutters(blocks, width) {
    const sorted = blocks.map(block => ({ center: center(block.bbox), block }))
        .sort((left, right) => left.center - right.center);
    const clusters = [];
    for (const entry of sorted) {
        const last = clusters.at(-1);
        if (last && entry.center - last.lastCenter < COLUMN_GAP_SHARE * width) {
            last.blocks.push(entry.block);
            last.lastCenter = entry.center;
        }
        else {
            clusters.push({ blocks: [entry.block], lastCenter: entry.center });
        }
    }
    // A column needs a paragraph, so a short label beside the text does not
    // make one. Reference entries are short but several of them stacked are a
    // column of their own.
    const columns = clusters
        .map(cluster => {
            const paragraphs = cluster.blocks.filter(block => (
                block.kind !== BLOCK_KIND.TITLE && block.bbox[3] - block.bbox[1] >= MIN_COLUMN_BLOCK_HEIGHT
            ));
            if (paragraphs.length) return paragraphs;
            const entries = cluster.blocks.filter(block => block.role === BLOCK_ROLE.REFERENCE);
            return entries.length >= MIN_REFERENCE_COLUMN_ENTRIES ? entries : [];
        })
        .filter(paragraphs => paragraphs.length);
    if (columns.length < 2 || columns.length > MAX_COLUMNS) return [];
    // A column whose paragraphs spread across most of a column width holds
    // two columns that chained together (a three-column page read as two);
    // such a layout is not trusted.
    if (columns.some(paragraphs => {
        const centers = paragraphs.map(block => center(block.bbox));
        return Math.max(...centers) - Math.min(...centers) > MAX_COLUMN_SPREAD_SHARE * width;
    })) {
        return [];
    }
    const gutters = [];
    for (let index = 1; index < columns.length; index++) {
        const leftEdge = median(columns[index - 1].map(block => block.bbox[2]));
        const rightEdge = median(columns[index].map(block => block.bbox[0]));
        gutters.push({ from: Math.min(leftEdge, rightEdge), to: Math.max(leftEdge, rightEdge) });
    }
    return gutters;
}

function median(values) {
    const sorted = [...values].sort((left, right) => left - right);
    const half = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
}

function center(bbox) {
    return (bbox[0] + bbox[2]) / 2;
}

function middle(bbox) {
    return (bbox[1] + bbox[3]) / 2;
}

function pureSeparators(text) {
    return text.filter(entry => entry.block.column === 'span' && !text.some(other => (
        other !== entry && other.block.column !== 'span'
        && other.block.bbox[1] < entry.block.bbox[3] - ORDER_TOLERANCE
        && other.block.bbox[3] > entry.block.bbox[1] + ORDER_TOLERANCE
    )));
}

// Text on the wrong side of a pure separator. The page is then cut at every
// pure separator, and the slices are read top to bottom with MinerU's order
// kept inside each slice.
function sliceBySeparators(text, separators) {
    if (!separators.length) return null;
    const violated = separators.some(separator => text.some(entry => {
        if (entry === separator) return false;
        if (entry.position < separator.position) return entry.block.bbox[1] >= separator.block.bbox[3] - ORDER_TOLERANCE;
        return entry.block.bbox[3] <= separator.block.bbox[1] + ORDER_TOLERANCE;
    }));
    if (!violated) return null;
    const cuts = [...separators].sort((left, right) => left.block.bbox[1] - right.block.bbox[1]);
    const slice = entry => {
        if (cuts.includes(entry)) return cuts.indexOf(entry) * 2 + 1;
        const below = cuts.filter(cut => middle(entry.block.bbox) > middle(cut.block.bbox)).length;
        return below * 2;
    };
    return [...text].sort((left, right) => slice(left) - slice(right) || left.position - right.position);
}

function splitAtSeparators(entries, separators) {
    const slices = [[]];
    for (const entry of entries) {
        if (separators.includes(entry)) {
            slices.push([entry], []);
            continue;
        }
        slices.at(-1).push(entry);
    }
    return slices.filter(slice => slice.length);
}

// Moves only the blocks that contradict the columns. Full-width blocks are
// barriers: blocks are compared only within a run of column text.
function repairSlice(slice) {
    let sequence = [...slice];
    const limit = sequence.length * 4;
    for (let step = 0; step < limit; step++) {
        const index = firstViolation(sequence);
        if (index < 0) return sequence;
        sequence = resolveViolation(sequence, index);
    }
    return slice;
}

function firstViolation(sequence) {
    for (let index = 1; index < sequence.length; index++) {
        const previous = sequence[index - 1].block;
        const current = sequence[index].block;
        if (previous.column === 'span' || current.column === 'span') continue;
        if (current.column < previous.column && current.bbox[1] < previous.bbox[3] - ORDER_TOLERANCE) return index;
        if (current.column === previous.column && current.bbox[3] <= previous.bbox[1] + ORDER_TOLERANCE) return index;
    }
    return -1;
}

function resolveViolation(sequence, index) {
    const current = sequence[index];
    const previous = sequence[index - 1];
    if (current.block.column === previous.block.column) {
        // Move the higher block back above every earlier block of its column
        // that it lies above.
        let target = index - 1;
        while (target > 0) {
            const before = sequence[target - 1].block;
            if (before.column !== current.block.column
                || current.block.bbox[3] > before.bbox[1] + ORDER_TOLERANCE) break;
            target--;
        }
        const output = sequence.filter(entry => entry !== current);
        output.splice(target, 0, current);
        return output;
    }
    // A run of right-column text read too early moves to just before the
    // next text of its column.
    let start = index - 1;
    while (start > 0) {
        const before = sequence[start - 1].block;
        if (before.column === 'span' || before.column <= current.block.column) break;
        start--;
    }
    const run = sequence.slice(start, index);
    const rest = [...sequence.slice(0, start), ...sequence.slice(index)];
    let insert = rest.length;
    for (let position = start + 1; position < rest.length; position++) {
        const block = rest[position].block;
        if (block.column === 'span' || block.column > current.block.column) {
            insert = position;
            break;
        }
    }
    rest.splice(insert, 0, ...run);
    return rest;
}

// Moves the given entries into the slots they already occupy, in the wanted
// order; every other block keeps its position.
function applyOrder(blocks, current, wanted, diagnostics, pageIndex, rule) {
    const ordered = wanted.filter(entry => current.includes(entry));
    const slots = current.map(entry => blocks.indexOf(entry.block)).sort((left, right) => left - right);
    if (ordered.every((entry, index) => blocks[slots[index]] === entry.block)) return blocks;
    const output = [...blocks];
    for (const [index, entry] of ordered.entries()) output[slots[index]] = entry.block;
    diagnostics.reorderedBands.push({
        pageIndex,
        rule,
        before: slots.map(slot => blocks[slot].id),
        after: ordered.map(entry => entry.block.id),
    });
    return output;
}

// Reference entries follow a references heading until the next heading.
// This needs the repaired order: a right-column "References" heading that
// MinerU put first would otherwise claim the left column's prose.
export function markReferenceSections(ir) {
    let inReferences = false;
    for (const block of ir.blocks) {
        if (block.kind === BLOCK_KIND.DISCARDED || block.role === BLOCK_ROLE.CHROME
            || block.role === BLOCK_ROLE.FLOAT || block.role === BLOCK_ROLE.FLOAT_NOTE) {
            continue;
        }
        if (block.role === BLOCK_ROLE.HEADING) {
            inReferences = REFERENCE_HEADING.test(blockPlainText(block).trim());
            if (inReferences) block.referenceHeading = true;
            else delete block.referenceHeading;
            continue;
        }
        if (block.kind === BLOCK_KIND.REFERENCE || inReferences && block.kind === BLOCK_KIND.TEXT) {
            block.role = BLOCK_ROLE.REFERENCE;
        }
        else if (block.role === BLOCK_ROLE.REFERENCE) {
            block.role = BLOCK_ROLE.BODY;
        }
    }
    return ir;
}
