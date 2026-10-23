import { isPublisherCopyrightParagraph } from '../../markdown/publisher-copyright.js';
import { BLOCK_KIND, BLOCK_ROLE, blockPlainText } from './ir.js';

const TOP_BAND = 90;
const BOTTOM_BAND = 910;
const MAX_CHROME_WORDS = 25;
const MIN_REPEATED_PAGES = 3;
const MIN_REPEATED_SHARE = 0.3;
const MAX_INTERIOR_WORDS = 6;
const MAX_REPEATED_STAMP_WORDS = 80;
const INTERIOR_OVERLAP = 0.9;
const PANEL_LABEL = /^\(?[a-z]\)?$/iu;
const CHROME_TYPES = new Set(['header', 'footer', 'page_number', 'aside_text']);
const BARE_DOI = /^(?:https?:\/\/)?(?:dx\.)?doi\.org\/10\.\S+$/iu;
const PAGE_NUMBER = /^(?:page\s+)?(?:\d{1,4}|[ivxlcdm]{1,7})(?:\s*(?:of|\/)\s*\d{1,4})?$/iu;

// Assigns a reading role to every IR block. MinerU's discarded blocks are
// trusted first; body blocks it missed are recognized as page decoration
// only at a page edge and only when the same text repeats across pages or
// matches a discarded decoration elsewhere in the document.
export function classifyBlocks(ir) {
    const diagnostics = ir.diagnostics;
    const pageCount = Math.max(1, ir.pages.length);
    const chromeKeys = discardedChromeKeys(ir.blocks);
    const edgeRepeats = repeatedEdgeKeys(ir.blocks);
    const floatBodies = collectFloatBodies(ir.blocks);
    for (const block of ir.blocks) {
        if (block.kind === BLOCK_KIND.DISCARDED) {
            block.role = block.mineruType === 'page_footnote' ? BLOCK_ROLE.PAGE_NOTE : BLOCK_ROLE.CHROME;
            continue;
        }
        if (block.kind === BLOCK_KIND.EQUATION) {
            block.role = BLOCK_ROLE.BODY;
            continue;
        }
        if (block.role === BLOCK_ROLE.FLOAT) continue;
        const text = blockPlainText(block);
        const rule = chromeRule(block, text, { chromeKeys, edgeRepeats, pageCount });
        if (rule) {
            block.role = BLOCK_ROLE.CHROME;
            diagnostics.chromeFallbacks.push({ id: block.id, pageIndex: block.pageIndex, rule });
            continue;
        }
        const host = floatInterior(block, text, floatBodies);
        if (host) {
            block.role = BLOCK_ROLE.FLOAT_NOTE;
            block.floatInteriorOf = host;
            continue;
        }
        // Reference sections need the repaired reading order, so prose after a
        // references heading is marked later by markReferenceSections.
        block.role = block.kind === BLOCK_KIND.TITLE ? BLOCK_ROLE.HEADING
            : block.kind === BLOCK_KIND.REFERENCE ? BLOCK_ROLE.REFERENCE
                : BLOCK_ROLE.BODY;
    }
    return ir;
}

export function chromeKey(text) {
    return String(text || '').normalize('NFKC').toLowerCase()
        .replace(/\d+/gu, '#')
        .replace(/[^\p{L}#]+/gu, '');
}

function edgeOf(block) {
    if (!block.bbox) return null;
    if (block.bbox[3] <= TOP_BAND) return 'top';
    if (block.bbox[1] >= BOTTOM_BAND) return 'bottom';
    return null;
}

function wordCount(text) {
    return String(text || '').trim().split(/\s+/u).filter(Boolean).length;
}

function discardedChromeKeys(blocks) {
    const keys = new Set();
    for (const block of blocks) {
        if (block.kind !== BLOCK_KIND.DISCARDED || !CHROME_TYPES.has(block.mineruType)) continue;
        const key = chromeKey(blockPlainText(block));
        if (key.replace(/#/gu, '').length >= 4) keys.add(key);
    }
    return keys;
}

function repeatedEdgeKeys(blocks) {
    const pages = new Map();
    for (const block of blocks) {
        const edge = edgeOf(block);
        if (!edge || block.role === BLOCK_ROLE.FLOAT || block.kind === BLOCK_KIND.EQUATION) continue;
        const key = chromeKey(blockPlainText(block));
        if (key.replace(/#/gu, '').length < 4) continue;
        const name = `${edge}:${key}`;
        if (!pages.has(name)) pages.set(name, new Set());
        pages.get(name).add(block.pageIndex);
    }
    return pages;
}

function chromeRule(block, text, { chromeKeys, edgeRepeats, pageCount }) {
    const edge = edgeOf(block);
    const trimmed = text.trim();
    if (!trimmed) return null;
    // ACM and IEEE stamp the copyright notice beside the first-page abstract.
    if (!edge) {
        return block.pageIndex === 0 && block.kind !== BLOCK_KIND.TITLE
            && isPublisherCopyrightParagraph(trimmed) && !BARE_DOI.test(trimmed)
            ? 'first-page-publisher-copyright'
            : null;
    }
    if (PAGE_NUMBER.test(trimmed)) return 'edge-page-number';
    const words = wordCount(trimmed);
    const key = chromeKey(trimmed);
    if (key.replace(/#/gu, '').length >= 4) {
        if (words <= MAX_CHROME_WORDS && chromeKeys.has(key)) return 'edge-matches-discarded';
        // A repeated stamp (a preprint notice, a download watermark) can be
        // long, but the same words at the same edge of several pages are
        // never reading prose.
        const repeats = edgeRepeats.get(`${edge}:${key}`)?.size || 0;
        if (words <= MAX_REPEATED_STAMP_WORDS
            && (repeats >= MIN_REPEATED_PAGES || repeats >= 2 && repeats >= pageCount * MIN_REPEATED_SHARE)) {
            return 'edge-repeated';
        }
    }
    if (words <= MAX_CHROME_WORDS && block.kind !== BLOCK_KIND.TITLE
        && isPublisherCopyrightParagraph(trimmed) && !BARE_DOI.test(trimmed)) {
        return 'edge-publisher-copyright';
    }
    return null;
}

function collectFloatBodies(blocks) {
    const bodies = new Map();
    for (const block of blocks) {
        if (block.kind !== BLOCK_KIND.IMAGE && block.kind !== BLOCK_KIND.CHART) continue;
        for (const child of block.children) {
            if (child.kind !== 'body' || !child.bbox) continue;
            if (!bodies.has(block.pageIndex)) bodies.set(block.pageIndex, []);
            bodies.get(block.pageIndex).push({ id: block.id, bbox: child.bbox });
        }
    }
    return bodies;
}

// Panel letters and axis labels that MinerU emits as separate text inside an
// image are part of the picture, not reading prose.
function floatInterior(block, text, floatBodies) {
    if (block.kind !== BLOCK_KIND.TEXT || !block.bbox || block.fragments.length !== 1
        || wordCount(text) > MAX_INTERIOR_WORDS) {
        return null;
    }
    // A lone panel letter ("a", "(b)") next to a figure is part of it even
    // when MinerU's image box stops short of it.
    const figures = floatBodies.get(block.pageIndex) || [];
    if (PANEL_LABEL.test(text.trim()) && figures.length) {
        return figures.reduce((best, body) => (
            distance(block.bbox, body.bbox) < distance(block.bbox, best.bbox) ? body : best
        )).id;
    }
    for (const body of floatBodies.get(block.pageIndex) || []) {
        if (overlapShare(block.bbox, body.bbox) >= INTERIOR_OVERLAP) return body.id;
    }
    return null;
}

function distance(left, right) {
    const dx = Math.max(0, left[0] - right[2], right[0] - left[2]);
    const dy = Math.max(0, left[1] - right[3], right[1] - left[3]);
    return Math.hypot(dx, dy);
}

function overlapShare(inner, outer) {
    const width = Math.min(inner[2], outer[2]) - Math.max(inner[0], outer[0]);
    const height = Math.min(inner[3], outer[3]) - Math.max(inner[1], outer[1]);
    if (width <= 0 || height <= 0) return 0;
    return width * height / ((inner[2] - inner[0]) * (inner[3] - inner[1]));
}
