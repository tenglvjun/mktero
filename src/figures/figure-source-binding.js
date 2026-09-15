import { GFM, parser } from '@lezer/markdown';
import { createVisibleMarkdownTextIndex } from '../markdown/markdown-visible-text.js';
import { normalizeTolerantText, normalizeText } from '../markdown/text-normalization.js';
import { splitTrailingAcademicFigureCaption } from '../markdown/markdown-figures.js';
import { FIGURE_LIMITS } from './figure-limits.js';
import { collectFigureImageNodes, normalizeFigureAssetPath } from './figure-model.js';
import { captionNear, isLooseFigureCaption, looksLikeGapLabel } from './figure-region-resolver.js';

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
    const candidatesFor = (block, page) => {
        const exact = textIndex.exact.get(normalizeText(block.text)) || [];
        const nodes = exact.length ? exact
            : textIndex.tolerant.get(normalizeTolerantText(block.text)) || [];
        return nodes.filter(node => consume(budget) && insidePage(node, page)
            && (!node.imageCaption || block.role === 'caption'));
    };
    for (const block of blocks) {
        if (!['heading', 'title'].includes(block.type) || !block.text) continue;
        const candidates = (textIndex.exact.get(normalizeText(block.text)) || []).filter(node => (
            consume(budget) && node.heading && insidePage(node, pages.get(block.pageIndex))
        ));
        const explicit = explicitMatch(sourceBlocks.get(block.id), candidates);
        if (explicit) bind(block, explicit, 'explicit-range');
        else if (pages.get(block.pageIndex)?.markdownRange && candidates.length === 1) {
            bind(block, candidates[0], 'anchored-sequence');
        }
    }
    clearOverlappingBindings(blocks);
    bindInteriorUniqueText(blocks, pages, limits, candidatesFor);
    clearOverlappingBindings(blocks);
    bindAdjacentPanelLabels(input.markdown, blocks, pages, limits, candidatesFor);
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
        const candidates = candidatesFor(block, page);
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
    const exact = new Map();
    const tolerant = new Map();
    const visible = createVisibleMarkdownTextIndex(markdown);
    const tree = MARKDOWN_PARSER.parse(markdown);
    let count = 0;
    const add = (text, node) => {
        if (!text) return;
        append(exact, text, node);
        append(tolerant, normalizeTolerantText(text), node);
    };
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
        if (++count > limits.maxLayoutBlocks) break;
        if (node.name !== 'Paragraph' && !/^(?:ATX|Setext)Heading/u.test(node.name)) continue;
        if (node.to - node.from > limits.maxFragmentLength) continue;
        let hasImage = false;
        node.toTree().iterate({ enter(child) {
            if (child.name === 'Image') hasImage = true;
        } });
        if (hasImage) continue;
        const nodeText = visible.textForSourceRange(node.from, node.to);
        const text = normalizeText(nodeText);
        add(text, { from: node.from, to: node.to, heading: node.name !== 'Paragraph' });
        // MinerU can merge a figure caption into the tail of a body paragraph,
        // so index that trailing caption as its own bindable range.
        if (node.name === 'Paragraph') {
            const split = splitTrailingAcademicFigureCaption(nodeText);
            if (split && split.from > 0
                && !/\r?\n[ \t]*$/u.test(nodeText.slice(0, split.from))) {
                const base = visible.visibleOffsetAt(node.from);
                const captionEnd = split.from + split.caption.text.length;
                add(split.caption.text, {
                    from: visible.sourceOffsetAt(base + split.from),
                    to: visible.sourceOffsetAt(base + captionEnd - 1) + 1,
                    imageCaption: true,
                });
            }
        }
        // MinerU often glues a panel label and its caption into one paragraph
        // without a blank line, so the caption only matches a single line.
        const lines = textLineRanges(markdown, node.from, node.to);
        if (lines.length < 2) continue;
        for (const range of lines) {
            if (++count > limits.maxLayoutBlocks) return { exact, tolerant };
            const lineText = normalizeText(visible.textForSourceRange(range.from, range.to));
            if (lineText && lineText !== text) add(lineText, range);
        }
    }
    for (const image of images) {
        const range = image.captionRange;
        if (range.to <= range.from) continue;
        const text = normalizeText(visible.textForSourceRange(range.from, range.to));
        add(text, { ...range, imageCaption: true });
    }
    return { exact, tolerant };
}

function textLineRanges(markdown, from, to) {
    const ranges = [];
    let lineStart = from;
    for (let index = from; index <= to; index++) {
        if (index < to && markdown[index] !== '\n') continue;
        let lineEnd = index;
        if (lineEnd > lineStart && markdown[lineEnd - 1] === '\r') lineEnd--;
        if (lineEnd > lineStart && /\S/u.test(markdown.slice(lineStart, lineEnd))) {
            ranges.push({ from: lineStart, to: lineEnd });
        }
        lineStart = index + 1;
    }
    return ranges;
}

function bindInteriorUniqueText(blocks, pages, limits, candidatesFor) {
    const panels = [];
    const panelsByPage = new Map();
    const parents = new Set();
    for (const block of blocks) {
        if (!block.sourceRanges.length || block.bboxKind !== 'visual-body'
            || !validBox(block.bbox)) continue;
        panels.push(block);
        if (block.parentId) parents.add(block.parentId);
        if (!panelsByPage.has(block.pageIndex)) panelsByPage.set(block.pageIndex, []);
        panelsByPage.get(block.pageIndex).push(block);
    }
    const textByPage = new Map();
    for (const block of blocks) {
        if (block.role !== 'figure-text' || !block.parentId || !parents.has(block.parentId)
            || !validBox(block.bbox)) continue;
        if (!textByPage.has(block.pageIndex)) textByPage.set(block.pageIndex, []);
        textByPage.get(block.pageIndex).push(block);
    }
    const bands = new Map();
    for (const [pageIndex, pagePanels] of panelsByPage) {
        // Figure-text children (such as a shared legend) extend the band so
        // sibling text on the same row can bind too.
        bands.set(pageIndex, panelBand([...pagePanels, ...(textByPage.get(pageIndex) || [])]));
    }
    for (const block of blocks) {
        if (block.sourceRanges.length || block.assetPath || !block.text
            || block.bboxKind === 'group' || !validBox(block.bbox)) continue;
        const insideParent = block.parentId && parents.has(block.parentId);
        const insidePanel = panels.some(panel => panel.pageIndex === block.pageIndex
            && containsBox(panel.bbox, block.bbox));
        const inBand = intersectsBox(bands.get(block.pageIndex), block.bbox);
        const nearPanel = (block.role === 'caption' || isLooseFigureCaption(block.text))
            && captionNearBox(panelsByPage.get(block.pageIndex), block.bbox, limits);
        if (!insideParent && !insidePanel && !inBand && !nearPanel) continue;
        const candidates = candidatesFor(block, pages.get(block.pageIndex));
        if (candidates.length === 1) bind(block, candidates[0], 'unique-text');
    }
}

function bindAdjacentPanelLabels(markdown, blocks, pages, limits, candidatesFor) {
    const panelsByPage = new Map();
    for (const block of blocks) {
        if (block.bboxKind !== 'visual-body' || !block.sourceRanges.length || !validBox(block.bbox)) {
            continue;
        }
        if (!panelsByPage.has(block.pageIndex)) panelsByPage.set(block.pageIndex, []);
        panelsByPage.get(block.pageIndex).push(block);
    }
    for (const block of blocks) {
        if (block.sourceRanges.length || block.assetPath || !block.text
            || block.bboxKind === 'group' || !looksLikeGapLabel(block.text, limits)) continue;
        const pagePanels = panelsByPage.get(block.pageIndex) || [];
        if (!pagePanels.length) continue;
        if (block.parentId) {
            if (block.role !== 'figure-text' && block.role !== 'caption') continue;
        }
        else if (!containsBox(panelBand(pagePanels), block.bbox)) continue;
        const parentPanels = block.parentId
            ? pagePanels.filter(candidate => candidate.parentId === block.parentId)
            : pagePanels;
        if (!parentPanels.length) continue;
        const candidates = candidatesFor(block, pages.get(block.pageIndex));
        const adjacent = block.parentId
            ? candidates.find(node => adjacentToPanel(markdown, node, parentPanels))
            : uniqueAdjacentNode(markdown, candidates, parentPanels);
        if (adjacent) bind(block, adjacent, 'anchored-sequence');
    }
}

function panelBand(panels) {
    return panels.reduce((result, panel) => [
        Math.min(result[0], panel.bbox[0]), Math.min(result[1], panel.bbox[1]),
        Math.max(result[2], panel.bbox[2]), Math.max(result[3], panel.bbox[3]),
    ], [1000, 1000, 0, 0]);
}

function adjacentToPanel(markdown, node, panels) {
    return panels.some(panel => {
        const range = panel.sourceRanges[0];
        return (node.to <= range.from
            && /^\s*$/u.test(markdown.slice(node.to, range.from)))
            || (node.from >= range.to
                && /^\s*$/u.test(markdown.slice(range.to, node.from)));
    });
}

function uniqueAdjacentNode(markdown, candidates, panels) {
    const matches = candidates.filter(node => adjacentToPanel(markdown, node, panels));
    return matches.length === 1 ? matches[0] : null;
}

function captionNearBox(panels, box, limits) {
    if (!panels?.length) return false;
    const panelBox = panels.reduce((result, panel) => [
        Math.min(result[0], panel.bbox[0]), Math.min(result[1], panel.bbox[1]),
        Math.max(result[2], panel.bbox[2]), Math.max(result[3], panel.bbox[3]),
    ], [1000, 1000, 0, 0]);
    return captionNear(box, panelBox, limits);
}

function containsBox(outer, inner) {
    return inner[0] >= outer[0] && inner[1] >= outer[1]
        && inner[2] <= outer[2] && inner[3] <= outer[3];
}

function intersectsBox(outer, inner) {
    return Array.isArray(outer) && Array.isArray(inner)
        && Math.min(outer[2], inner[2]) > Math.max(outer[0], inner[0])
        && Math.min(outer[3], inner[3]) > Math.max(outer[1], inner[1]);
}

function validBox(box) {
    return Array.isArray(box) && box.length === 4 && box.every(Number.isFinite)
        && box[2] > box[0] && box[3] > box[1];
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
