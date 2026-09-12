import { FIGURE_LIMITS } from '../figures/figure-limits.js';
import { normalizeFigureAssetPath } from '../figures/figure-model.js';
import { parseAcademicFigureCaption } from '../markdown/markdown-figures.js';
import { MINERU_FIGURE_LAYOUT_OPTIONS } from './parser-profile.js';

export function decodeMinerUFigureInput(result) {
    const input = {
        provider: 'mineru', markdown: String(result.markdown || '').replace(/\r\n?/g, '\n'),
        assets: result.assets || [], assetBasePath: result.assetBasePath || '',
        contentList: result.contentList || [], pages: [], blocks: [], providerState: {},
        extractedPages: result.extractedPages, totalPages: result.totalPages,
        warnings: Array.isArray(result.warnings) ? [...result.warnings] : [],
    };
    const pageIndexes = new Set(input.contentList.map(block => block.pageIndex));
    let detailedPages = new Map();
    if (result.detailedLayout?.schema === 'mineru-middle-v1') {
        try {
            const supported = result.detailedLayout.backend === MINERU_FIGURE_LAYOUT_OPTIONS.backend
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

function decodeFlatBlocks(contentList, pageIndex) {
    const blocks = [];
    for (const [sourceOrdinal, block] of contentList.entries()) {
        if (block.pageIndex !== pageIndex) continue;
        const image = ['image', 'chart'].includes(block.type);
        blocks.push({
            id: `mineru:p${pageIndex}:b${sourceOrdinal}`, sourceOrdinal, pageIndex,
            type: block.type, role: image ? 'panel'
                : parseAcademicFigureCaption(block.text) ? 'caption' : 'unknown',
            bboxKind: image ? 'unknown' : 'text', bbox: block.bbox ? [...block.bbox] : null,
            ...(block.assetPath ? { assetPath: block.assetPath } : {}),
            text: block.text || '', sourceRanges: [], rangeEvidence: 'unresolved',
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
        if (!Number.isSafeInteger(raw.page_idx) || raw.page_idx < 0 || pages.has(raw.page_idx)
            || !Array.isArray(raw.page_size) || raw.page_size.length !== 2
            || !raw.page_size.every(value => Number.isFinite(value) && value > 0)
            || !Array.isArray(raw.para_blocks)) throw new Error('Invalid detailed page geometry');
        const pageIndex = raw.page_idx;
        const [width, height] = raw.page_size;
        const blocks = [];
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
                const text = blockText(para);
                add({ type: para.type === 'title' ? 'heading' : para.type || 'unknown', role: parseAcademicFigureCaption(text)
                    ? 'caption' : 'unknown', bboxKind: 'text', bbox: box(para.bbox), text });
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
