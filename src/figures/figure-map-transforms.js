import { cloneFigureMap, collectFigureImageNodes, normalizeFigureAssetPath } from './figure-model.js';

export function mapFigureMapThroughEdits(map, edits, markdown) {
    if (!map || map.version !== 1) return null;
    const sorted = edits.slice().sort((left, right) => left.from - right.from);
    for (let index = 0; index < sorted.length; index++) {
        const edit = sorted[index];
        if (!Number.isSafeInteger(edit.from) || !Number.isSafeInteger(edit.to)
            || !Number.isSafeInteger(edit.replacementLength) || edit.from < 0 || edit.to < edit.from
            || edit.replacementLength < 0 || (index && edit.from < sorted[index - 1].to)) {
            throw new TypeError('Figure range edits are invalid');
        }
    }
    const result = cloneFigureMap(map);
    if (!sorted.length) return result;
    const images = collectFigureImageNodes(markdown);
    result.figures = result.figures.filter(figure => {
        const range = figure.render.range;
        if (sorted.some(edit => edit.from < range.to && edit.to > range.from
            || edit.from === edit.to && edit.from > range.from && edit.from < range.to)) return false;
        const next = { from: mapOffset(range.from, sorted, 1), to: mapOffset(range.to, sorted, -1) };
        const image = images.find(image => image.from === next.from && image.to === next.to);
        try {
            if (!image || normalizeFigureAssetPath(image.assetPath) !== normalizeFigureAssetPath(figure.render.assetPath)) {
                return false;
            }
        }
        catch {
            return false;
        }
        figure.render.range = next;
        figure.render.captionRanges = figure.render.captionRanges.map(caption => ({
            from: mapOffset(caption.from, sorted, 1), to: mapOffset(caption.to, sorted, -1),
        }));
        return true;
    });
    result.markdownHash = null;
    return result;
}

function mapOffset(offset, edits, association) {
    let delta = 0;
    for (const edit of edits) {
        if (offset < edit.from || (offset === edit.from && association < 0)) break;
        if (offset < edit.to) return edit.from + delta + (association > 0 ? edit.replacementLength : 0);
        delta += edit.replacementLength - (edit.to - edit.from);
    }
    return offset + delta;
}
