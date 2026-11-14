import { FIGURE_LIMITS } from './figure-limits.js';
import { isValidNormalizedSourceBBox } from '../core/markdown-source-map.js';
import { normalizeFigureAssetPath } from './figure-model.js';

// PDF captions identify possible visual groups, not permission to delete their
// OCR tables. Every candidate here stays preserved until the PDF worker proves
// one native image and verifies every original fragment against its pixels.
export function resolveDocumentFigures(input, { limits = FIGURE_LIMITS, budget, existingCandidates = [] } = {}) {
    if (input.provider !== 'mineru' || input.rangesExplicit !== true) return [];
    const groups = new Map();
    for (const block of input.blocks) {
        if (budget && --budget.remaining < 0) return [];
        if (!block.pdfFigure || block.bboxKind === 'group') continue;
        const key = `${block.pageIndex}:${block.pdfFigure.id}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(block);
    }
    const candidates = [];
    const counts = new Map();
    for (const candidate of existingCandidates) {
        counts.set(candidate.pageIndex, (counts.get(candidate.pageIndex) || 0) + 1);
    }
    for (const blocks of groups.values()) {
        const panels = blocks.filter(block => block.pdfFigurePart === 'panel');
        const captions = blocks.filter(block => block.pdfFigurePart === 'caption');
        const pageIndex = blocks[0].pageIndex;
        const count = counts.get(pageIndex) || 0;
        if (!panels.length || !captions.length || panels.length > limits.maxPanels
            || count >= limits.maxFiguresPerPage
            || candidates.length + existingCandidates.length >= limits.maxFigures) continue;
        counts.set(pageIndex, count + 1);
        const figure = blocks[0].pdfFigure;
        const usable = blocks.every(block => validBox(block.bbox) && resolved(block)
            && block.pdfFigure.id === figure.id && block.pdfFigure.text === figure.text
            && block.pdfFigure.label === figure.label);
        if (!usable) continue;
        const anchor = panels[0];
        candidates.push({
            id: `fig-p${pageIndex}-b${anchor.sourceOrdinal}`,
            pageIndex, label: figure.label, decision: 'preserve',
            reason: usable ? 'ambiguous-membership' : 'ambiguous-source-range',
            nativeFigure: true,
            panelBlockIds: panels.map(block => block.id),
            captionBlockIds: captions.map(block => block.id),
            ownedTextBlockIds: [],
            visualBBox: usable ? union(panels.map(block => block.bbox)) : null,
            captionBBox: validBox(figure.bbox) ? [...figure.bbox] : null,
            evidence: ['pdf-caption', 'exact-source-ranges'],
        });
    }
    return candidates;
}

export function documentFigureRequest(input, candidate, budget) {
    if (!candidate.nativeFigure || !['ambiguous-membership', 'ambiguous-source-range'].includes(candidate.reason)) return null;
    const page = input.pages.find(value => value.pageIndex === candidate.pageIndex);
    if (!page || page.coordinateFrame !== 'display-cropbox' || page.geometryReason
        || !Number.isFinite(page.rotation)) return null;
    budget.remaining -= input.blocks.length + input.assets.length;
    if (budget.remaining < 0) return null;
    const byID = new Map(input.blocks.map(block => [block.id, block]));
    const assets = new Map(input.assets.map(asset => [normalizeFigureAssetPath(asset.path), asset]));
    const panels = candidate.panelBlockIds.map(id => byID.get(id));
    const caption = byID.get(candidate.captionBlockIds[0]);
    if (!caption?.pdfFigure || panels.some(block => !resolved(block) || !validBox(block.bbox)
        || !block.assetPath || block.pdfFigure?.id !== caption.pdfFigure.id)) return null;
    const members = new Set([...candidate.panelBlockIds, ...candidate.captionBlockIds]);
    const foreignLocations = [];
    for (const block of input.blocks) {
        if (block.pageIndex !== candidate.pageIndex || block.bboxKind === 'group' || members.has(block.id)) continue;
        // The OCR copy of this very caption was consumed by the native one; it
        // is not foreign content that blocks the crop.
        if (block.pdfFigure?.id === caption.pdfFigure.id) continue;
        // An unlocated piece only blocks the crop when it is text or a panel;
        // a table caption's own empty range carries no picture.
        if (!validBox(block.bbox)) {
            if (block.text || block.role === 'panel') return null;
            continue;
        }
        foreignLocations.push({ bbox: [...block.bbox] });
    }
    const requestPanels = panels.map(block => ({ id: block.id, bbox: [...block.bbox],
        asset: assets.get(normalizeFigureAssetPath(block.assetPath, input.assetBasePath)) }));
    if (requestPanels.some(panel => !panel.asset)) return null;
    return {
        mode: 'document-figure', pageIndex: candidate.pageIndex, panels: requestPanels,
        caption: { label: candidate.label, text: caption.pdfFigure.text, bbox: [...candidate.captionBBox] },
        foreignLocations,
    };
}

export function documentFigureCandidate(candidate, request, result, page) {
    if (!validBox(result?.bbox) || !validBox(result.captionBBox) || result.rotation !== page.rotation
        || intersection(result.captionBBox, request.caption.bbox) <= 0
        || intersection(result.bbox, result.captionBBox) > 0
        || request.foreignLocations.some(location => intersection(result.bbox, location.bbox) > 0)) return null;
    const panelBBoxes = {};
    for (const panel of request.panels) {
        const bbox = clip(panel.bbox, result.bbox);
        // Native-image evidence can trim OCR white margins and a caption baked
        // into an OCR crop. Preserve the original source box in provenance.
        if (!validBox(bbox) || area(bbox) / area(panel.bbox) < 0.6) return null;
        panelBBoxes[panel.id] = bbox;
    }
    return {
        ...candidate, decision: 'compose', reason: null,
        visualBBox: [...result.bbox], captionBBox: [...result.captionBBox], panelBBoxes,
        evidence: [...candidate.evidence, 'pdf-image-container', 'verified-panel-pixels'],
    };
}

function resolved(block) {
    return Boolean(block?.sourceRanges?.length && block.rangeEvidence !== 'unresolved');
}

function validBox(box) {
    return isValidNormalizedSourceBBox(box) && box[0] < box[2] && box[1] < box[3];
}

function union(boxes) {
    return [Math.min(...boxes.map(box => box[0])), Math.min(...boxes.map(box => box[1])),
        Math.max(...boxes.map(box => box[2])), Math.max(...boxes.map(box => box[3]))];
}

function clip(a, b) {
    return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
}

function area(box) { return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]); }
function intersection(a, b) { return area(clip(a, b)); }
