import { collectFigureImageNodes } from './figure-model.js';

export function normalizeOutsideRestoredFigures(markdown, blocks, normalize) {
    const paths = new Set((blocks || []).filter(block => block.figureId && block.assetPath)
        .map(block => block.assetPath));
    if (!paths.size) return normalize(markdown);
    const images = collectFigureImageNodes(markdown)
        .filter(image => image.standalone && paths.has(image.assetPath));
    const parts = [];
    let offset = 0;
    for (const image of images) {
        parts.push(normalize(markdown.slice(offset, image.from)), markdown.slice(image.from, image.to));
        offset = image.to;
    }
    parts.push(normalize(markdown.slice(offset)));
    return parts.join('');
}
