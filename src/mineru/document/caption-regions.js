import { FIGURE_LIMITS } from '../../figures/figure-limits.js';
import { normalizePdfAnnotationText } from '../../markdown/pdf-annotation-text.js';
import { BLOCK_KIND, BLOCK_ROLE, fragmentText, unionBBox } from './ir.js';
import { itemsInBox, pdfLines } from './pdf-geometry.js';

const MAX_REGIONS = 64;
const MAX_REGION_ITEMS = 1_024;
const MAX_REGION_LINES = 64;
const EDGE_MARGIN = 6;
const ALIGNMENT_MARGIN = 24;
const NUMBERED_FIGURE = /\b(?:fig(?:ure)?|chart|scheme|algorithm)\.?\s*\d+[a-z]?\b/giu;

// A body label is only a proposed region. Keep rejected regions too: the
// weaker whole-page reader must not replace one with a shorter native prefix.
// All inspection is read-only; ownership and consumption are planned later.
export function readPDFCaptionRegions(page, items, blocks, { parseCaption, maxWork }) {
    const regions = [];
    let work = 0;
    for (const block of blocks) {
        if (block.kind !== BLOCK_KIND.TEXT || block.role !== BLOCK_ROLE.BODY || block.captionConsumed
            || block.fragments?.length !== 1 || !validBox(block.bbox)) continue;
        const fragment = block.fragments[0];
        const prefix = captionPrefix(fragment);
        if (fragment.pageIndex !== page.pageIndex || !prefix) continue;
        const labeled = parseCaption(prefix);
        if (!labeled || labeled.kind !== 'figure') continue;
        if (regions.length >= MAX_REGIONS) return { regions, work, exhausted: true };
        const region = { sourceBlock: block, label: labeled.label, kind: 'figure', caption: null };
        regions.push(region);
        // Charge scanning and text normalization before touching native items.
        work += items.length + FIGURE_LIMITS.maxCaptionLength + blocks.length;
        if (work > maxWork) return { regions, work, exhausted: true };
        const text = boundedFragmentText(fragment);
        if (!text || !parseCaption(text) || linkedLabel(fragment, labeled.label)
            || [...text.matchAll(NUMBERED_FIGURE)].length !== 1) continue;
        const localItems = itemsInBox(block.bbox, items);
        if (!localItems.length || localItems.length > MAX_REGION_ITEMS
            || localItems.some(item => item.length !== item.text.length || !inside(item.bbox, block.bbox))) continue;
        work += localItems.length * localItems.length;
        if (work > maxWork) return { regions, work, exhausted: true };
        if (localItems.reduce((length, item) => length + item.text.length + 1, 0)
            > FIGURE_LIMITS.maxCaptionLength) continue;
        const lines = pdfLines(localItems);
        if (!lines.length || lines.length > MAX_REGION_LINES || !continuousRegion(lines)) continue;
        const parts = lines.map(line => ({
            line, text: nativeLineText(line.items),
        }));
        const nativeText = parts.map(part => part.text).join(' ');
        if (nativeText.length > FIGURE_LIMITS.maxCaptionLength) continue;
        const nativeLabel = parseCaption(nativeText);
        if (!nativeLabel || number(nativeLabel.label) !== number(labeled.label)
            || regionTextKey(text) !== regionTextKey(nativeText)) continue;
        const boxes = lines.map(line => unionBBox(line.items.map(item => item.bbox)));
        const bbox = unionBBox(boxes);
        work += blocks.length * lines.length;
        if (work > maxWork) return { regions, work, exhausted: true };
        // A second layout block intersecting these lines is independent content,
        // even if OCR happened to include its words in the proposed caption.
        if (blocks.some(other => other !== block && other.role !== BLOCK_ROLE.CHROME
            && other.kind !== BLOCK_KIND.DISCARDED && !other.captionConsumed
            && validBox(other.bbox) && boxes.some(box => significantOverlap(box, other.bbox)))) continue;
        region.caption = {
            id: `pdf-caption-region-${block.id}`, pageIndex: page.pageIndex,
            label: labeled.label, kind: 'figure', text, nativeText, bbox,
            labelBBox: boxes[0], lineBBoxes: boxes, lineTexts: parts.map(part => part.text),
            description: null, sourceBlock: block,
        };
    }
    return { regions, work, exhausted: false };
}

function nativeLineText(items) {
    let text = '';
    let previous = null;
    for (const item of items) {
        const height = Math.min(item.bbox[3] - item.bbox[1],
            previous ? previous.bbox[3] - previous.bbox[1] : Infinity);
        const gap = previous ? item.bbox[0] - previous.bbox[2] : Infinity;
        const script = previous && item.size < previous.size * 0.85
            && /^[\p{L}\p{N}+−±]{1,8}$/u.test(item.text);
        const sameType = previous && Math.abs(item.size - previous.size) <= previous.size * 0.15;
        const touching = previous && !previous.spaceAfter && !item.spaceBefore
            && gap >= -height * 0.25 && gap < height * 0.15
            && (script || sameType && Math.abs(item.bbox[3] - previous.bbox[3]) < height * 0.2);
        text += `${text && !touching ? ' ' : ''}${item.text}`;
        previous = item;
    }
    return text.replace(/\s+/gu, ' ').trim();
}

function captionPrefix(fragment) {
    let prefix = '';
    for (const line of fragment.lines || []) {
        for (const span of line.spans || []) {
            if (typeof span.content !== 'string') continue;
            prefix += `${span.content.slice(0, 512 - prefix.length)} `;
            if (prefix.length >= 512) return prefix.slice(0, 512);
        }
    }
    return prefix.trim();
}

// Image captions need a plain academic label for discovery. If a link wraps
// that label, keep the original body paragraph so its target stays accessible.
function linkedLabel(fragment, label) {
    const compact = text => text.replace(/\s+/gu, '').toLowerCase();
    const target = compact(label);
    let prefix = '';
    for (const line of fragment.lines || []) {
        for (const span of line.spans || []) {
            if (typeof span.content !== 'string' || !span.content.trim()) continue;
            if (span.nativeLinkURL || span.linkURL) return true;
            prefix += span.content;
            if (compact(prefix).startsWith(target)) return false;
        }
    }
    return false;
}

function boundedFragmentText(fragment) {
    let length = 0;
    for (const line of fragment.lines || []) {
        for (const span of line.spans || []) {
            length += typeof span.content === 'string' ? span.content.length + 3 : 0;
            if (length > FIGURE_LIMITS.maxCaptionLength) return null;
        }
    }
    const text = fragmentText(fragment).trim();
    return text.length <= FIGURE_LIMITS.maxCaptionLength ? text : null;
}

// Exact ordered coverage retains repeated words and numeric/math operators.
// Hyphen spacing and line-end word breaks differ between PDF items and OCR;
// neither a matching prefix nor a set of shared words proves a whole region.
function regionTextKey(text) {
    return normalizePdfAnnotationText(text).normalize('NFKC').toLowerCase()
        .replace(/(?<=\p{L})\s*[-\u00ad\u2010\u2011]\s*(?=\p{L})/gu, '')
        .replace(/[$]/gu, '')
        .match(/[\p{L}\p{N}]+|[\p{S}=%*\/−-]/gu)?.join(' ') || '';
}

function continuousRegion(lines) {
    const sizes = lines.map(line => dominantSize(line.items));
    const size = median(sizes);
    if (!(size > 0)) return false;
    const pitches = lines.slice(1).map((line, index) => line.bottom - lines[index].bottom);
    const pitch = median(pitches);
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (Math.abs(sizes[index] - size) / size > (index === 0 ? 0.4 : 0.25)) return false;
        if (!index) continue;
        const previous = lines[index - 1];
        // Absolute glyph heights can change with bold type and superscripts;
        // the region's own margins and baseline rhythm define its continuity.
        if (Math.abs(line.left - lines[0].left) > ALIGNMENT_MARGIN
            || pitches[index - 1] <= 0 || pitches[index - 1] > Math.max(pitch * 1.8, line.height * 2)
            || pitches[index - 1] < pitch * 0.5
            || line.bottom <= previous.bottom) return false;
    }
    return true;
}

function dominantSize(items) {
    const sorted = [...items].sort((a, b) => a.size - b.size);
    const total = sorted.reduce((sum, item) => sum + item.text.length, 0);
    let length = 0;
    for (const item of sorted) {
        length += item.text.length;
        if (length >= total / 2) return item.size;
    }
    return 0;
}

function number(label) {
    return /\d+[a-z]?/iu.exec(label)?.[0]?.toLowerCase();
}

function inside(inner, outer) {
    return inner[0] >= outer[0] - EDGE_MARGIN && inner[1] >= outer[1] - EDGE_MARGIN
        && inner[2] <= outer[2] + EDGE_MARGIN && inner[3] <= outer[3] + EDGE_MARGIN;
}

function significantOverlap(line, box) {
    const x = Math.min(line[2], box[2]) - Math.max(line[0], box[0]);
    const y = Math.min(line[3], box[3]) - Math.max(line[1], box[1]);
    return x > EDGE_MARGIN && y > EDGE_MARGIN
        && x * y / ((line[2] - line[0]) * (line[3] - line[1])) > 0.5;
}

function validBox(box) {
    return Array.isArray(box) && box.length === 4 && box.every(Number.isFinite)
        && box[0] < box[2] && box[1] < box[3];
}

function median(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}
