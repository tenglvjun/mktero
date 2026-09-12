import { GFM, parser } from '@lezer/markdown';
import { createVisibleMarkdownTextIndex } from '../markdown/markdown-visible-text.js';
import { normalizeText } from '../markdown/text-normalization.js';
import { FIGURE_LIMITS } from './figure-limits.js';
import { collectFigureImageNodes, normalizeFigureAssetPath } from './figure-model.js';

const MARKDOWN_PARSER = parser.configure(GFM);

export function bindFigureSourceRanges(input, { limits: overrides, budget: sharedBudget } = {}) {
    const limits = { ...FIGURE_LIMITS, ...overrides };
    const blocks = input.blocks.map(block => ({
        ...block, sourceRanges: [], rangeEvidence: 'unresolved',
    }));
    const output = { ...input, blocks };
    if (limits.maxComparisons <= 0) return output;
    const budget = sharedBudget || { remaining: limits.maxComparisons };
    const images = collectFigureImageNodes(input.markdown).filter(image => image.standalone);
    const imageIndex = new Map();
    for (const image of images) {
        const path = safePath(image.assetPath, input.assetBasePath);
        if (path) append(imageIndex, path, image);
    }
    const pages = new Map(input.pages.map(page => [page.pageIndex, page]));
    const sourceBlocks = new Map(input.blocks.map(block => [block.id, block]));
    for (const block of blocks) {
        if (!block.assetPath || block.bboxKind === 'group') continue;
        const candidates = (imageIndex.get(safePath(block.assetPath, input.assetBasePath)) || [])
            .filter(image => consume(budget) && insidePage(image, pages.get(block.pageIndex)));
        const explicit = explicitMatch(sourceBlocks.get(block.id), candidates);
        if (explicit) bind(block, explicit, 'explicit-range');
        else if (candidates.length === 1) bind(block, candidates[0], 'unique-asset');
    }
    clearOverlappingBindings(blocks);
    const textIndex = collectTextNodes(input.markdown, images, limits);
    for (const block of blocks) {
        if (!['heading', 'title'].includes(block.type) || !block.text) continue;
        const candidates = (textIndex.get(normalizeText(block.text)) || []).filter(node => (
            consume(budget) && node.heading && insidePage(node, pages.get(block.pageIndex))
        ));
        const explicit = explicitMatch(sourceBlocks.get(block.id), candidates);
        if (explicit) bind(block, explicit, 'explicit-range');
        else if (pages.get(block.pageIndex)?.markdownRange && candidates.length === 1) {
            bind(block, candidates[0], 'anchored-sequence');
        }
    }
    clearOverlappingBindings(blocks);
    const ordered = blocks.slice().sort((a, b) => a.pageIndex - b.pageIndex
        || a.sourceOrdinal - b.sourceOrdinal);
    const nextAnchors = new Map();
    let next = null;
    for (const block of ordered.slice().reverse()) {
        nextAnchors.set(block.id, next);
        if (block.sourceRanges.length && Number.isSafeInteger(block.sourceOrdinal)) next = block;
    }
    const windows = new Map();
    let previous = null;
    for (const block of ordered) {
        if (block.sourceRanges.length && Number.isSafeInteger(block.sourceOrdinal)) {
            previous = block;
            continue;
        }
        if (block.assetPath || !block.text || block.bboxKind === 'group') continue;
        const page = pages.get(block.pageIndex);
        const candidates = (textIndex.get(normalizeText(block.text)) || []).filter(node => (
            consume(budget) && insidePage(node, page)
            && (!node.imageCaption || block.role === 'caption')
        ));
        const explicit = explicitMatch(sourceBlocks.get(block.id), candidates);
        if (explicit) {
            bind(block, explicit, 'explicit-range');
            continue;
        }
        if (!Number.isSafeInteger(block.sourceOrdinal)) continue;
        const next = nextAnchors.get(block.id);
        const before = previous?.pageIndex === block.pageIndex ? previous.sourceRanges[0].to : null;
        const after = next?.pageIndex === block.pageIndex ? next.sourceRanges[0].from : null;
        // An image on one side cannot establish where this PDF page ends or starts.
        if (!page?.markdownRange && (before === null || after === null)) continue;
        const from = Math.max(before ?? 0, page?.markdownRange?.from ?? 0);
        const to = Math.min(after ?? input.markdown.length, page?.markdownRange?.to ?? input.markdown.length);
        if (to < from) continue;
        const key = `${block.pageIndex}:${from}:${to}`;
        append(windows, key, { block, candidates: candidates.filter(node => (
            consume(budget) && node.from >= from && node.to <= to
        )) });
    }
    for (const entries of windows.values()) bindUniqueSequence(entries, budget);
    clearOverlappingBindings(blocks);
    if (budget.remaining < 0) {
        for (const block of blocks) {
            block.sourceRanges = [];
            block.rangeEvidence = 'unresolved';
        }
    }
    return output;
}

function clearOverlappingBindings(blocks) {
    const ranges = blocks.flatMap(block => block.sourceRanges.map(range => ({ ...range, block })))
        .sort((left, right) => left.from - right.from || right.to - left.to);
    let furthest = null;
    const invalid = new Set();
    for (const range of ranges) {
        if (furthest && isCaptionWithinImage(furthest, range)) continue;
        if (furthest && isCaptionWithinImage(range, furthest)) {
            furthest = range;
            continue;
        }
        if (furthest && range.from < furthest.to) {
            invalid.add(furthest.block);
            invalid.add(range.block);
        }
        if (!furthest || range.to > furthest.to) furthest = range;
    }
    for (const block of invalid) {
        block.sourceRanges = [];
        block.rangeEvidence = 'unresolved';
    }
}

function isCaptionWithinImage(outer, inner) {
    return outer.block.assetPath && inner.block.role === 'caption'
        && outer.from <= inner.from && outer.to >= inner.to;
}

function collectTextNodes(markdown, images, limits) {
    const index = new Map();
    const visible = createVisibleMarkdownTextIndex(markdown);
    const tree = MARKDOWN_PARSER.parse(markdown);
    let count = 0;
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
        if (++count > limits.maxLayoutBlocks) break;
        if (node.name !== 'Paragraph' && !/^(?:ATX|Setext)Heading/u.test(node.name)) continue;
        if (node.to - node.from > limits.maxFragmentLength) continue;
        let hasImage = false;
        node.toTree().iterate({ enter(child) {
            if (child.name === 'Image') hasImage = true;
        } });
        if (hasImage) continue;
        const text = normalizeText(visible.textForSourceRange(node.from, node.to));
        if (text) append(index, text, { from: node.from, to: node.to, heading: node.name !== 'Paragraph' });
    }
    for (const image of images) {
        const range = image.captionRange;
        if (range.to <= range.from) continue;
        const text = normalizeText(visible.textForSourceRange(range.from, range.to));
        if (text) append(index, text, { ...range, imageCaption: true });
    }
    return index;
}

function bindUniqueSequence(entries, budget) {
    const earliest = [];
    let end = -1;
    for (const entry of entries) {
        const node = entry.candidates.find(candidate => consume(budget) && candidate.from >= end);
        if (!node) return;
        earliest.push(node);
        end = node.to;
    }
    let start = Infinity;
    for (let index = entries.length - 1; index >= 0; index--) {
        const node = entries[index].candidates.slice().reverse()
            .find(candidate => consume(budget) && candidate.to <= start);
        if (!node || node.from !== earliest[index].from || node.to !== earliest[index].to) return;
        start = node.from;
    }
    for (let index = 0; index < entries.length; index++) {
        bind(entries[index].block, earliest[index], 'anchored-sequence');
    }
}

function explicitMatch(block, candidates) {
    if (block?.sourceRanges?.length !== 1) return null;
    return candidates.find(node => node.from === block.sourceRanges[0].from
        && node.to === block.sourceRanges[0].to) || null;
}

function bind(block, range, evidence) {
    block.sourceRanges = [{ from: range.from, to: range.to }];
    block.rangeEvidence = evidence;
}

function insidePage(range, page) {
    return !page?.markdownRange || (range.from >= page.markdownRange.from
        && range.to <= page.markdownRange.to);
}

function append(map, key, value) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
}

function safePath(path, base) {
    try { return normalizeFigureAssetPath(path, base || ''); }
    catch { return null; }
}

function consume(budget) {
    return --budget.remaining >= 0;
}
