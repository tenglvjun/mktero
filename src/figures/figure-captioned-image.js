import { isValidNormalizedSourceBBox } from '../core/markdown-source-map.js';
import { parseAcademicFigureCaption, parseLooseAcademicFigureCaption } from '../markdown/markdown-figures.js';
import { normalizeFigureAssetPath } from './figure-model.js';

// A safe OCR region can still omit a shared title or the outermost subplot.
// Expand only its crop, never its membership, after verifying the native image.
export function captionedImageRequest(input, candidate, budget) {
    if (input.provider !== 'mineru' || input.rangesExplicit !== true
        || candidate.decision !== 'compose' || !candidate.label
        || !candidate.captionBlockIds.length || !candidate.panelBlockIds.length
        || !validBox(candidate.visualBBox) || !validBox(candidate.captionBBox)) return null;
    const page = input.pages.find(value => value.pageIndex === candidate.pageIndex);
    if (!page || page.coordinateFrame !== 'display-cropbox' || !Number.isFinite(page.rotation)) return null;
    budget.remaining -= input.blocks.length + input.assets.length;
    if (budget.remaining < 0) return null;
    const byID = new Map(input.blocks.map(block => [block.id, block]));
    const captionBlock = byID.get(candidate.captionBlockIds[0]);
    if (!captionBlock || captionBlock.pageIndex !== candidate.pageIndex) return null;
    const caption = parseAcademicFigureCaption(captionBlock.text) || parseLooseAcademicFigureCaption(captionBlock.text);
    if (!caption) return null;
    const assets = new Map(input.assets.map(asset => [normalizeFigureAssetPath(asset.path), asset]));
    const panels = candidate.panelBlockIds.map(id => byID.get(id));
    if (panels.some(block => !block?.sourceRanges?.length || block.rangeEvidence === 'unresolved'
        || !validBox(block.bbox))) return null;
    const owned = new Set([...candidate.panelBlockIds, ...candidate.ownedTextBlockIds]);
    const foreignLocations = [];
    for (const block of input.blocks) {
        if (block.pageIndex !== candidate.pageIndex || block.bboxKind === 'group' || owned.has(block.id)) continue;
        if (!validBox(block.bbox)) {
            if (block.text || block.role === 'panel') return null;
            continue;
        }
        // Interior labels without Markdown ranges already belong to the safe
        // region, but cannot be consumed. Expansion leaves them unchanged.
        if (block.type === 'text' && ['unknown', 'figure-text'].includes(block.role)
            && !block.sourceRanges?.length && contains(candidate.visualBBox, block.bbox)) continue;
        foreignLocations.push({ bbox: block.bbox });
    }
    const requestPanels = panels.map(block => ({ bbox: block.bbox,
        asset: assets.get(normalizeFigureAssetPath(block.assetPath, input.assetBasePath)) }));
    if (requestPanels.some(panel => !panel.asset)) return null;
    return { mode: 'captioned-region', pageIndex: candidate.pageIndex,
        visualBBox: [...candidate.visualBBox], caption, panels: requestPanels, foreignLocations };
}

export function captionedImageCandidate(candidate, request, result, page) {
    if (!validBox(result?.bbox) || !validBox(result.captionBBox) || result.rotation !== page.rotation
        || !contains(result.bbox, candidate.visualBBox)
        || request.panels.some(panel => !contains(result.bbox, panel.bbox))
        || request.foreignLocations.some(location => intersects(result.bbox, location.bbox))
        || !intersects(result.captionBBox, candidate.captionBBox)
        || area(result.bbox) > 750_000 || area(result.bbox) > area(candidate.visualBBox) * 1.6) return null;
    return {
        ...candidate, visualBBox: [...result.bbox],
        // The PDF evidence identifies the caption's first line. Keep the full
        // OCR caption box and ranges for selection, translation and source jumps.
        evidence: [...candidate.evidence, 'pdf-image-container', 'separate-pdf-caption', 'verified-panel-pixels'],
    };
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

function area(box) { return (box[2] - box[0]) * (box[3] - box[1]); }
