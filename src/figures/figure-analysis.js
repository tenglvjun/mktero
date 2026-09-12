import { FIGURE_LIMITS, FIGURE_PIPELINE_PROFILE } from './figure-limits.js';
import {
    assertFigureJSONBudget, collectFigureImageNodes, normalizeFigureAssetPath,
} from './figure-model.js';
import {
    findAcademicFigures, parseAcademicFigureCaption, unescapeImageDescription,
} from '../markdown/markdown-figures.js';

export function analyzeDocumentFigures(markdown, {
    figureMap = null, viewRanges = null, viewKind = 'original',
} = {}) {
    const source = String(markdown || '');
    const records = figureRecords(figureMap);
    const findSourceBlock = sourceBlockFinder(viewKind === 'original' ? null : viewRanges);
    const images = records.length ? collectFigureImageNodes(source) : [];
    const imagesByPath = new Map();
    for (const image of images) {
        const path = localPath(image.assetPath);
        if (!path) continue;
        if (!imagesByPath.has(path)) imagesByPath.set(path, []);
        imagesByPath.get(path).push(image);
    }
    const restored = [];
    for (const record of records) {
        const matches = imagesByPath.get(localPath(record.render.assetPath));
        if (matches?.length !== 1 || !matches[0].standalone) continue;
        const image = matches[0];
        const block = viewKind === 'original' ? null
            : findSourceBlock(record.render.range);
        const window = viewWindow(record, block, viewKind);
        if (!window || image.from < window.from || image.to > window.to) continue;
        if (viewKind === 'original'
            && (image.from !== window.from || image.to !== window.to)) continue;
        const text = unescapeImageDescription(image.caption);
        const caption = parseAcademicFigureCaption(text) || { label: '', text };
        if (record.label && (!figureLabelKey(record.label)
            || figureLabelKey(record.label) !== figureLabelKey(caption.label))) continue;
        const translatedCaption = viewKind === 'comparison'
            ? comparisonCaption(source, record, block, image) : null;
        const to = translatedCaption?.to ?? image.to;
        restored.push({
            id: `${record.id}:${viewKind}`, sourceId: record.id, viewKind,
            from: image.from, to, label: caption.label, caption,
            source: source.slice(image.from, to),
            assetPath: image.assetPath,
            imageRange: { from: image.from, to: image.to },
            translatedCaption,
            images: [{ source: source.slice(image.from, image.to) }],
            panels: record.panels.map(panel => ({ ...panel, bbox: [...panel.bbox] })),
            location: { pageIndex: record.pageIndex, bbox: [...record.visualBBox] },
        });
    }
    restored.sort((left, right) => left.from - right.from);
    // Each restored image is a boundary, including an image with no caption.
    const figures = [];
    let from = 0;
    for (const figure of restored) {
        if (figure.from < from) continue;
        figures.push(...legacyViews(source.slice(from, figure.from), from, viewKind), figure);
        from = figure.to;
    }
    figures.push(...legacyViews(source.slice(from), from, viewKind));
    return figures;
}

export function figureLabelKey(label) {
    return /^(?:fig(?:ure)?[.\uFF0E]?|\u56FE\u8868|\u56FE)\s*(s?\d{1,4}[a-z]?|[ivxlcdm]{1,12}[a-z]?)(?![a-z0-9])/iu
        .exec(String(label || '').trim())?.[1].toLowerCase() || '';
}

function figureRecords(map) {
    if (map?.version !== 1 || map.pipeline !== FIGURE_PIPELINE_PROFILE
        || !Array.isArray(map.figures) || map.figures.length > FIGURE_LIMITS.maxFigures) return [];
    try {
        assertFigureJSONBudget(map);
    }
    catch {
        return [];
    }
    const ids = new Map();
    const paths = new Map();
    for (const record of map.figures) {
        const path = localPath(record?.render?.assetPath);
        ids.set(record?.id, (ids.get(record?.id) || 0) + 1);
        paths.set(path, (paths.get(path) || 0) + 1);
    }
    return map.figures.filter(record => {
        const path = localPath(record?.render?.assetPath);
        return /^fig-p\d+-b[\w-]{1,100}$/u.test(record?.id || '')
            && ids.get(record.id) === 1 && path && paths.get(path) === 1
            && record.render.mode === 'pdf-region'
            && validRange(record.render.range) && validBBox(record.visualBBox)
            && Number.isSafeInteger(record.pageIndex) && record.pageIndex >= 0
            && record.pageIndex < FIGURE_LIMITS.maxPDFPages
            && (record.label === null || typeof record.label === 'string'
                && record.label.length <= FIGURE_LIMITS.maxCaptionLength)
            && Array.isArray(record.panels) && record.panels.length > 0
            && record.panels.length <= FIGURE_LIMITS.maxPanels
            && Array.isArray(record.memberBlockIds)
            && record.panels.every(panel => (
                validBBox(panel?.bbox) && typeof panel.blockId === 'string'
                && record.memberBlockIds.includes(panel.blockId)
                && (panel.label == null || typeof panel.label === 'string'
                    && panel.label.length <= FIGURE_LIMITS.maxCaptionLength)
                && panel.bbox[0] >= record.visualBBox[0]
                && panel.bbox[1] >= record.visualBBox[1]
                && panel.bbox[2] <= record.visualBBox[2]
                && panel.bbox[3] <= record.visualBBox[3]
            ));
    });
}

function sourceBlockFinder(viewRanges) {
    if (!Array.isArray(viewRanges) || viewRanges.length > FIGURE_LIMITS.maxLayoutBlocks) return () => null;
    const blocks = viewRanges.filter(block => validRange({ from: block?.sourceFrom, to: block?.sourceTo }))
        .sort((a, b) => a.sourceFrom - b.sourceFrom);
    const longest = [];
    const second = [];
    let first = null;
    let runnerUp = null;
    for (const block of blocks) {
        if (!first || block.sourceTo >= first.sourceTo) {
            runnerUp = first;
            first = block;
        }
        else if (!runnerUp || block.sourceTo > runnerUp.sourceTo) runnerUp = block;
        longest.push(first);
        second.push(runnerUp);
    }
    return range => {
        let from = 0;
        let to = blocks.length;
        while (from < to) {
            const mid = Math.floor((from + to) / 2);
            if (blocks[mid].sourceFrom <= range.from) from = mid + 1;
            else to = mid;
        }
        const block = longest[from - 1];
        return block?.sourceTo >= range.to && !(second[from - 1]?.sourceTo >= range.to) ? block : null;
    };
}

function viewWindow(record, block, kind) {
    if (kind === 'original') return record.render.range;
    if (!block) return null;
    const range = kind === 'translation'
        ? { from: block.translatedFrom, to: block.translatedTo }
        : kind === 'comparison'
            ? { from: block.comparisonSourceFrom, to: block.comparisonSourceTo } : null;
    return validRange(range) ? range : null;
}

function comparisonCaption(source, record, block, image) {
    if (block?.sourceFrom !== record.render.range.from || block.sourceTo !== record.render.range.to
        || block.comparisonSourceFrom !== image.from || block.comparisonSourceTo !== image.to) return null;
    const range = { from: block.comparisonTranslationFrom, to: block.comparisonTranslationTo };
    if (!validRange(range) || range.to > source.length || range.from < image.to
        || source.slice(image.to, range.from).trim()) return null;
    const text = source.slice(range.from, range.to);
    const caption = parseAcademicFigureCaption(unescapeImageDescription(text));
    if (!caption || !record.label || figureLabelKey(caption.label) !== figureLabelKey(record.label)) return null;
    return { ...range, text };
}

function legacyViews(source, offset, viewKind) {
    return findAcademicFigures(source).map(figure => ({
        ...figure, from: offset + figure.from, to: offset + figure.to,
        id: `legacy-figure-${offset + figure.from}:${viewKind}`,
        sourceId: null, viewKind, label: figure.caption?.label || '',
        imageRange: null, translatedCaption: null, panels: [], location: null,
    }));
}

function localPath(value) {
    try {
        return normalizeFigureAssetPath(value);
    }
    catch {
        return null;
    }
}

function validRange(range) {
    return Number.isSafeInteger(range?.from) && Number.isSafeInteger(range?.to)
        && range.from >= 0 && range.to > range.from;
}

function validBBox(bbox) {
    return Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite)
        && bbox[0] >= 0 && bbox[1] >= 0 && bbox[2] <= 1000 && bbox[3] <= 1000
        && bbox[2] > bbox[0] && bbox[3] > bbox[1];
}
