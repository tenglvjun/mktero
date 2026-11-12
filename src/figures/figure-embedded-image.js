import { isValidNormalizedSourceBBox } from '../core/markdown-source-map.js';
import { normalizeFigureAssetPath } from './figure-model.js';

// Long OCR text inside an unnumbered figure is ambiguous from layout alone.
// Only a verified PDF image container may own it; ordinary region resolution
// must continue protecting paragraphs between unrelated panels.
export function embeddedImageRequest(input, candidate, candidates, budget) {
    if (input.provider !== 'mineru' || input.rangesExplicit !== true
        || candidate.decision !== 'preserve' || candidate.reason !== 'foreign-content-overlap'
        || candidate.captionBlockIds.length || candidate.label || candidate.panelBlockIds.length < 2) return null;
    const page = input.pages.find(value => value.pageIndex === candidate.pageIndex);
    if (!page || page.coordinateFrame !== 'display-cropbox' || !Number.isFinite(page.rotation)) return null;
    budget.remaining -= input.blocks.length + input.assets.length + candidates.length;
    if (budget.remaining < 0) return null;
    const byID = new Map(input.blocks.map(block => [block.id, block]));
    const assets = new Map(input.assets.map(asset => [normalizeFigureAssetPath(asset.path), asset]));
    const panels = candidate.panelBlockIds.map(id => byID.get(id));
    if (panels.some(block => !resolved(block) || !validBox(block.bbox))) return null;
    const panelIDs = new Set(candidate.panelBlockIds);
    const claimed = new Set(candidates.filter(other => other !== candidate)
        .flatMap(other => [...other.panelBlockIds, ...other.captionBlockIds, ...other.ownedTextBlockIds]));
    const textBlocks = [];
    const foreignLocations = [];
    for (const block of input.blocks) {
        if (block.pageIndex !== candidate.pageIndex || block.bboxKind === 'group' || panelIDs.has(block.id)) continue;
        // Unlocated or stitched text cannot be safely removed from the flow.
        if (!validBox(block.bbox)) {
            if (block.text || block.role === 'panel') return null;
            continue;
        }
        if (!claimed.has(block.id) && block.type === 'text'
            && ['unknown', 'figure-text'].includes(block.role) && block.text?.trim() && resolved(block)) {
            textBlocks.push({ id: block.id, bbox: block.bbox });
        }
        else foreignLocations.push({ bbox: block.bbox });
    }
    if (!textBlocks.length) return null;
    const requestPanels = panels.map(block => ({
        bbox: block.bbox,
        asset: assets.get(normalizeFigureAssetPath(block.assetPath, input.assetBasePath)),
    }));
    if (requestPanels.some(panel => !panel.asset)) return null;
    return { mode: 'embedded-text', pageIndex: candidate.pageIndex,
        panels: requestPanels, textBlocks, foreignLocations };
}

export function embeddedImageCandidate(candidate, request, result, page) {
    if (!validBox(result?.bbox) || result.rotation !== page.rotation
        || result.captionBBox != null || !Array.isArray(result.ownedTextBlockIds)
        || !result.ownedTextBlockIds.length) return null;
    const owned = new Set(result.ownedTextBlockIds);
    const textByID = new Map(request.textBlocks.map(block => [block.id, block]));
    if (owned.size !== result.ownedTextBlockIds.length
        || result.ownedTextBlockIds.some(id => !textByID.has(id) || !contains(result.bbox, textByID.get(id).bbox))
        || request.panels.some(panel => !contains(result.bbox, panel.bbox))
        || request.foreignLocations.some(location => intersects(result.bbox, location.bbox))
        || request.textBlocks.some(block => !owned.has(block.id) && intersects(result.bbox, block.bbox))) return null;
    return {
        ...candidate, decision: 'compose', reason: null,
        visualBBox: [...result.bbox], captionBBox: null,
        ownedTextBlockIds: [...result.ownedTextBlockIds],
        evidence: [...candidate.evidence, 'pdf-image-container', 'verified-panel-pixels', 'exact-source-ranges'],
    };
}

function resolved(block) {
    return block?.sourceRanges?.length && block.rangeEvidence !== 'unresolved';
}

function validBox(box) {
    return isValidNormalizedSourceBBox(box) && box[0] < box[2] && box[1] < box[3];
}

function contains(outer, inner) {
    return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}

function intersects(a, b) {
    return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}
