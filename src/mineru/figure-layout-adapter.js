import { FIGURE_LIMITS } from '../figures/figure-limits.js';
import { normalizeFigureAssetPath } from '../figures/figure-model.js';
import {
    parseAcademicFigureCaption,
    splitTrailingAcademicFigureCaption,
} from '../markdown/markdown-figures.js';
import { MINERU_FIGURE_LAYOUT_OPTIONS } from './parser-profile.js';

export function decodeMinerUFigureInput(result) {
    const assets = result.assets || [];
    const input = {
        provider: 'mineru',
        markdown: separateFigureImageLines(
            String(result.markdown || '').replace(/\r\n?/g, '\n'),
            assets
        ),
        assets, assetBasePath: result.assetBasePath || '',
        contentList: result.contentList || [], pages: [], blocks: [], providerState: {},
        // Detailed layout tables carry no image path, so keep the flat
        // content-list entries that identify figures exported as tables.
        figureTables: collectFigureTables(result.contentList),
        extractedPages: result.extractedPages, totalPages: result.totalPages,
        warnings: Array.isArray(result.warnings) ? [...result.warnings] : [],
    };
    const pageIndexes = new Set(input.contentList.map(block => block.pageIndex));
    let detailedPages = new Map();
    if (result.detailedLayout?.schema === 'mineru-middle-v1') {
        try {
            const supported = MINERU_FIGURE_LAYOUT_OPTIONS.backends.includes(result.detailedLayout.backend)
                && MINERU_FIGURE_LAYOUT_OPTIONS.versions.includes(result.detailedLayout.version);
            detailedPages = decodeDetailedPages(result.detailedLayout.pdfInfo, input, supported);
        }
        catch {
            detailedPages = new Map();
        }
    }
    for (const index of detailedPages.keys()) pageIndexes.add(index);
    for (const pageIndex of [...pageIndexes].sort((a, b) => a - b)) {
        const detailed = detailedPages.get(pageIndex);
        if (detailed) {
            input.pages.push(detailed.page);
            input.blocks.push(...detailed.blocks);
        }
        else {
            input.pages.push({ pageIndex, coordinateFrame: 'unknown', rotation: null,
                geometryEvidence: 'content-list-only', markdownRange: null });
            input.blocks.push(...decodeFlatBlocks(input.contentList, pageIndex));
        }
    }
    return input;
}

const MARKDOWN_IMAGE_LINE = /^( {0,3})!\[[^\]\r\n]*\]\(\s*(<[^>\r\n]+>|[^)\s]+)(?:[^)]*)\)[ \t]*$/u;


function separateFigureImageLines(markdown, assets) {
    if (!markdown) return markdown;
    const destinations = new Set();
    for (const asset of assets) {
        try {
            destinations.add(normalizeFigureAssetPath(asset?.path));
        }
        catch {
            // Unsupported asset paths cannot anchor a provider image line.
        }
    }
    if (!destinations.size) return markdown;
    const lines = markdown.split('\n');
    const output = [];
    let changed = false;
    for (const [index, line] of lines.entries()) {
        const destination = markdownImageDestination(line);
        if (destination && (destinations.has(destination)
            || destinations.has(`images/${destination}`))) {
            if (output.length && output.at(-1).trim()) {
                output.push('');
                changed = true;
            }
            output.push(line);
            if (index + 1 < lines.length && lines[index + 1].trim()) {
                output.push('');
                changed = true;
            }
            continue;
        }
        output.push(line);
    }
    return changed ? output.join('\n') : markdown;
}

function findFlatContentBlock(contentList, pageIndex, type, bbox) {
    let best = null;
    let bestOverlap = 0;
    for (const block of contentList || []) {
        if (block?.pageIndex !== pageIndex || block.type !== type
            || !Array.isArray(block.bbox) || block.bbox.length !== 4) {
            continue;
        }
        const overlapWidth = Math.min(block.bbox[2], bbox[2])
            - Math.max(block.bbox[0], bbox[0]);
        const overlapHeight = Math.min(block.bbox[3], bbox[3])
            - Math.max(block.bbox[1], bbox[1]);
        if (overlapWidth <= 0 || overlapHeight <= 0) continue;
        const overlap = overlapWidth * overlapHeight;
        if (overlap > bestOverlap) {
            bestOverlap = overlap;
            best = block;
        }
    }
    return best;
}

function collectFigureTables(contentList) {
    const tables = [];
    for (const block of contentList || []) {
        if (block?.type !== 'table' || typeof block.assetPath !== 'string'
            || !block.assetPath || typeof block.text !== 'string' || !block.text) {
            continue;
        }
        const captions = Array.isArray(block.captions) ? block.captions : [];
        if (!captions.some(caption => /^(?:fig|figure)\b/iu.test(
            parseAcademicFigureCaption(caption)?.label || ''
        ))) {
            continue;
        }
        tables.push({ text: block.text, assetPath: block.assetPath, captions });
    }
    return tables;
}

function markdownImageDestination(line) {
    const match = MARKDOWN_IMAGE_LINE.exec(line);
    if (!match) return null;
    let destination = match[2];
    if (destination.startsWith('<') && destination.endsWith('>')) {
        destination = destination.slice(1, -1);
    }
    try {
        return normalizeFigureAssetPath(destination);
    }
    catch {
        return null;
    }
}

function decodeFlatBlocks(contentList, pageIndex) {
    const blocks = [];
    for (const [sourceOrdinal, block] of contentList.entries()) {
        if (block.pageIndex !== pageIndex) continue;
        const image = ['image', 'chart'].includes(block.type);
        const embedded = image ? null : splitTrailingAcademicFigureCaption(block.text);
        blocks.push({
            id: `mineru:p${pageIndex}:b${sourceOrdinal}`, sourceOrdinal, pageIndex,
            type: block.type, role: image ? 'panel'
                : embedded ? 'caption'
                    : parseAcademicFigureCaption(block.text) ? 'caption' : 'unknown',
            bboxKind: image ? 'unknown' : 'text', bbox: block.bbox ? [...block.bbox] : null,
            ...(block.assetPath ? { assetPath: block.assetPath } : {}),
            ...(embedded ? { embeddedCaption: true } : {}),
            text: embedded ? embedded.caption.text : block.text || '',
            sourceRanges: [], rangeEvidence: 'unresolved',
        });
    }
    return blocks;
}

function decodeDetailedPages(pdfInfo, input, supported) {
    if (!Array.isArray(pdfInfo)) throw new Error('Invalid detailed pages');
    const pages = new Map();
    const assetPaths = new Set(input.assets.map(asset => normalizeFigureAssetPath(asset.path)));
    let totalBlocks = 0;
    for (const raw of pdfInfo) {
        if (!Number.isSafeInteger(raw?.page_idx) || raw.page_idx < 0 || pages.has(raw.page_idx)
            || !Array.isArray(raw.page_size) || raw.page_size.length !== 2
            || !raw.page_size.every(value => Number.isFinite(value) && value > 0)
            || !Array.isArray(raw.para_blocks)) continue;
        const pageIndex = raw.page_idx;
        const [width, height] = raw.page_size;
        const blocks = [];
        try {
            const add = value => {
                if (++totalBlocks > FIGURE_LIMITS.maxLayoutBlocks) throw new Error('Detailed block limit');
                const sourceOrdinal = blocks.length;
                const block = { id: `mineru:p${pageIndex}:b${sourceOrdinal}`, sourceOrdinal,
                    pageIndex, text: '', sourceRanges: [], rangeEvidence: 'unresolved', ...value };
                blocks.push(block);
                return block;
            };
            const box = value => normalizedBox(value, width, height);
            for (const para of raw.para_blocks) {
                if (!['image', 'chart'].includes(para.type)) {
                    const bbox = box(para.bbox);
                    // The detailed layout drops compact fields such as a table
                    // image path; inherit them from the flat content list.
                    const flat = findFlatContentBlock(input.contentList, pageIndex, para.type, bbox);
                    const text = blockText(para) || flat?.text || '';
                    const embedded = para.type === 'text'
                        ? splitTrailingAcademicFigureCaption(text)
                        : null;
                    add({ type: para.type === 'title' ? 'heading' : para.type || 'unknown',
                        role: embedded
                            ? 'caption'
                            : parseAcademicFigureCaption(text) ? 'caption' : 'unknown',
                        bboxKind: 'text', bbox,
                        ...(flat?.assetPath ? { assetPath: flat.assetPath } : {}),
                        ...(flat?.captions?.length ? { captions: [...flat.captions] } : {}),
                        ...(embedded ? { embeddedCaption: true } : {}),
                        text: embedded ? embedded.caption.text : text });
                    continue;
                }
                const parent = add({ type: para.type, role: 'unknown', bboxKind: 'group', bbox: box(para.bbox) });
                let panelCount = 0;
                for (const child of para.blocks || []) {
                    if (/^(?:image|chart)_body$/u.test(child.type)) {
                        for (const line of child.lines || []) {
                            for (const span of line.spans || []) {
                                if (!span.image_path) continue;
                                const destination = resolveSpanAsset(span.image_path, input.assetBasePath, assetPaths);
                                if (!destination) throw new Error('Detailed image asset is unavailable');
                                add({ type: para.type, role: 'panel', bboxKind: 'visual-body',
                                    bbox: box(span.bbox || child.bbox), assetPath: destination, parentId: parent.id });
                                panelCount++;
                            }
                        }
                    }
                    else {
                        const caption = /^(?:image|chart)_caption$/u.test(child.type);
                        add({ type: caption ? 'caption' : 'text', role: caption ? 'caption' : 'figure-text',
                            bboxKind: caption ? 'caption' : 'text', bbox: box(child.bbox),
                            text: blockText(child), parentId: parent.id });
                    }
                }
                if (!panelCount) throw new Error('Detailed figure has no image body');
            }
            pages.set(pageIndex, { blocks, page: { pageIndex, width, height, unit: MINERU_FIGURE_LAYOUT_OPTIONS.unit, dpi: null,
                coordinateFrame: supported ? 'display-cropbox' : 'unknown', rotation: null,
                ...(supported ? {} : { geometryReason: 'unsupported-layout-schema' }),
                geometryEvidence: 'mineru-middle-v1',
                markdownRange: null } });
        }
        catch {
            // A malformed page or figure falls back to the stable list without
            // discarding the validated geometry of the other pages.
        }
    }
    return pages;
}

function blockText(block) {
    if (typeof block.content === 'string') return block.content;
    return (block.lines || []).map(line => (line.spans || [])
        .map(span => typeof span.content === 'string' ? span.content : '').join('')).join('\n');
}

function normalizedBox(value, width, height) {
    if (!Array.isArray(value) || value.length !== 4 || !value.every(Number.isFinite)) return null;
    const bbox = [value[0] * 1000 / width, value[1] * 1000 / height,
        value[2] * 1000 / width, value[3] * 1000 / height];
    return bbox[0] >= 0 && bbox[1] >= 0 && bbox[2] <= 1000 && bbox[3] <= 1000
        && bbox[2] > bbox[0] && bbox[3] > bbox[1] ? bbox : null;
}

function resolveSpanAsset(path, basePath, assets) {
    const destinations = [path, `images/${path}`];
    const found = new Set();
    for (const destination of destinations) {
        const resolved = normalizeFigureAssetPath(destination, basePath);
        if (assets.has(resolved)) found.add(resolved);
    }
    if (found.size !== 1) return null;
    const resolved = [...found][0];
    return basePath && resolved.startsWith(basePath + '/') ? resolved.slice(basePath.length + 1) : resolved;
}
