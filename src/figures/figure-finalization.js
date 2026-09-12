import { FIGURE_PIPELINE_PROFILE } from './figure-limits.js';
import { collectFigureImageNodes, normalizeFigureAssetPath, validateFigureMap } from './figure-model.js';
import { throwIfFigureAborted, waitForFigureOperation } from './figure-async.js';

export async function finalizeFigureMap(prepared, blueprints, { hash, signal, preserved = [] }) {
    throwIfFigureAborted(signal);
    const document = publicDocument(prepared);
    const images = collectFigureImageNodes(document.markdown);
    const byPath = new Map();
    for (const image of images) {
        try {
            const path = normalizeFigureAssetPath(image.assetPath, document.assetBasePath);
            if (!byPath.has(path)) byPath.set(path, []);
            byPath.get(path).push(image);
        }
        catch {
            // Nonlocal images cannot anchor a restored Figure.
        }
    }
    const figures = blueprints.map(blueprint => {
        const matches = byPath.get(normalizeFigureAssetPath(blueprint.renderAssetPath, document.assetBasePath));
        if (matches?.length !== 1 || !matches[0].standalone
            || matches[0].caption !== blueprint.renderCaption) {
            const error = new Error('Figure image anchor changed during normalization');
            error.code = 'INVALID_FIGURE_ANCHOR';
            throw error;
        }
        const image = matches[0];
        return {
            id: blueprint.id, label: blueprint.label, pageIndex: blueprint.pageIndex,
            visualBBox: blueprint.visualBBox, captionBBox: blueprint.captionBBox,
            memberBlockIds: blueprint.memberBlockIds, panels: blueprint.panels, provenance: blueprint.provenance,
            render: {
                mode: 'pdf-region', assetPath: blueprint.renderAssetPath,
                width: blueprint.width, height: blueprint.height,
                range: { from: image.from, to: image.to },
                captionRanges: image.captionRange.to > image.captionRange.from ? [{ ...image.captionRange }] : [],
            },
        };
    });
    const markdownHash = await waitForFigureOperation(hash(new TextEncoder().encode(document.markdown)), signal);
    throwIfFigureAborted(signal);
    const figureMap = { version: 1, pipeline: FIGURE_PIPELINE_PROFILE,
        markdownHash, figures, preserved };
    validateFigureMap(figureMap, { ...document, markdownHash, persisted: true });
    const restoredRanges = figures.map(figure => figure.render.range);
    const sourceMap = (document.sourceMap || []).filter(entry => !restoredRanges.some(range => (
        entry.markdownFrom < range.to && entry.markdownTo > range.from
    )));
    for (const figure of figures) {
        const entry = {
            type: 'image', markdownFrom: figure.render.range.from, markdownTo: figure.render.range.to,
            locations: [{ pageIndex: figure.pageIndex, bbox: [...figure.visualBBox] }],
        };
        if (figure.captionBBox && figure.render.captionRanges.length) {
            entry.locationRanges = figure.render.captionRanges.map(range => ({
                markdownFrom: range.from, markdownTo: range.to,
                location: { pageIndex: figure.pageIndex, bbox: [...figure.captionBBox] },
            }));
        }
        sourceMap.push(entry);
    }
    sourceMap.sort((left, right) => left.markdownFrom - right.markdownFrom);
    return { ...document, sourceMap, figureMap };
}

export async function finalizeRestoredDocument(input, draft, { prepare, hash, signal }) {
    throwIfFigureAborted(signal);
    const prepared = await waitForFigureOperation(prepare(draft.input), signal);
    throwIfFigureAborted(signal);
    try {
        return await finalizeFigureMap(prepared, draft.blueprints, { hash, signal, preserved: draft.preserved });
    }
    catch (error) {
        throwIfFigureAborted(signal);
        if (error.name === 'AbortError') throw error;
        if (!draft.blueprints.length) return { ...publicDocument(prepared), figureMap: null };
        const fallback = await waitForFigureOperation(prepare(input), signal);
        try {
            return await finalizeFigureMap(fallback, [], {
                hash, signal,
                preserved: [...draft.preserved, ...draft.blueprints.map(blueprint => ({
                    id: blueprint.id, pageIndex: blueprint.pageIndex, reason: 'ambiguous-source-range',
                }))],
            });
        }
        catch (fallbackError) {
            throwIfFigureAborted(signal);
            if (fallbackError.name === 'AbortError') throw fallbackError;
            return { ...publicDocument(fallback), figureMap: null };
        }
    }
}

function publicDocument(prepared) {
    const { blocks, pages, providerState, detailedLayout, contentList, ...document } = prepared;
    return document;
}
