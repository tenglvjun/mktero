import { strFromU8, unzipSync } from 'fflate';
import { toUint8Array } from './binary.js';
import { isValidNormalizedSourceBBox } from '../core/markdown-source-map.js';

export const DEFAULT_MAX_MARKDOWN_BYTES = 50 * 1024 * 1024;
export const DEFAULT_MAX_CONTENT_LIST_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_CONTENT_BLOCKS = 100_000;
export const DEFAULT_MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_ASSET_BYTES = 150 * 1024 * 1024;

const IMAGE_MIME_TYPES = new Map([
    ['.gif', 'image/gif'],
    ['.jpeg', 'image/jpeg'],
    ['.jpg', 'image/jpeg'],
    ['.png', 'image/png'],
    ['.webp', 'image/webp'],
]);

export function extractMinerUResultFromZip(archive, {
    maxMarkdownBytes = DEFAULT_MAX_MARKDOWN_BYTES,
    maxContentListBytes = DEFAULT_MAX_CONTENT_LIST_BYTES,
    maxContentBlocks = DEFAULT_MAX_CONTENT_BLOCKS,
    maxAssetBytes = DEFAULT_MAX_ASSET_BYTES,
    maxTotalAssetBytes = DEFAULT_MAX_TOTAL_ASSET_BYTES,
} = {}) {
    const bytes = toUint8Array(archive, 'The MinerU result archive');
    let markdownPath;
    let contentListPath;
    let documentFiles;
    try {
        documentFiles = unzipSync(bytes, {
            filter(file) {
                if (/(^|\/)full\.md$/i.test(file.name)) {
                    if (markdownPath) {
                        throw new Error('The MinerU result contains multiple full.md files');
                    }
                    markdownPath = file.name;
                    if (file.originalSize > maxMarkdownBytes) {
                        throw markdownSizeError(maxMarkdownBytes);
                    }
                    return true;
                }
                if (isStableContentListPath(file.name)) {
                    if (contentListPath) {
                        throw new Error(
                            'The MinerU result contains multiple content_list.json files'
                        );
                    }
                    contentListPath = file.name;
                    if (file.originalSize > maxContentListBytes) {
                        throw contentListSizeError(maxContentListBytes);
                    }
                    return true;
                }
                return false;
            },
        });
    }
    catch (error) {
        throw extractionError(error);
    }

    if (!markdownPath) {
        throw new Error('The MinerU result archive does not contain full.md');
    }
    const markdownBytes = documentFiles[markdownPath];
    if (!markdownBytes || markdownBytes.length > maxMarkdownBytes) {
        throw extractionError(markdownSizeError(maxMarkdownBytes));
    }

    let contentList = [];
    if (contentListPath) {
        const contentListBytes = documentFiles[contentListPath];
        if (!contentListBytes || contentListBytes.length > maxContentListBytes) {
            throw extractionError(contentListSizeError(maxContentListBytes));
        }
        contentList = parseContentList(contentListBytes, maxContentBlocks);
    }

    let totalAssetBytes = 0;
    let assetFiles;
    try {
        assetFiles = unzipSync(bytes, {
            filter(file) {
                const mimeType = imageMimeType(file.name);
                if (!mimeType) return false;
                if (file.originalSize > maxAssetBytes) {
                    throw assetSizeError(file.name, maxAssetBytes);
                }
                totalAssetBytes += file.originalSize;
                if (totalAssetBytes > maxTotalAssetBytes) {
                    throw new Error(
                        `MinerU images exceed the ${formatMegabytes(maxTotalAssetBytes)} MB total limit`
                    );
                }
                return true;
            },
        });
    }
    catch (error) {
        throw extractionError(error);
    }

    const assets = Object.entries(assetFiles).map(([path, data]) => ({
        path,
        mimeType: imageMimeType(path),
        data,
    }));
    return {
        markdown: strFromU8(markdownBytes),
        assets,
        assetBasePath: directoryName(markdownPath),
        contentList,
    };
}

export function extractMarkdownFromZip(archive, options) {
    return extractMinerUResultFromZip(archive, options).markdown;
}

function imageMimeType(path) {
    const match = String(path).toLowerCase().match(/\.[a-z0-9]+$/);
    return match ? IMAGE_MIME_TYPES.get(match[0]) || null : null;
}

function directoryName(path) {
    const separator = path.lastIndexOf('/');
    return separator < 0 ? '' : path.slice(0, separator);
}

function isStableContentListPath(path) {
    const fileName = String(path).split('/').pop() || '';
    return /^(?:.+_)?content_list\.json$/i.test(fileName)
        && !/_v\d+\.json$/i.test(fileName);
}

function parseContentList(bytes, maxBlocks) {
    let parsed;
    try {
        parsed = JSON.parse(strFromU8(bytes));
    }
    catch (error) {
        throw extractionError(new Error(`Invalid MinerU content list JSON: ${error.message}`));
    }
    if (!Array.isArray(parsed)) {
        throw extractionError(new Error('MinerU content list must be an array'));
    }
    if (parsed.length > maxBlocks) {
        throw extractionError(new Error(
            `MinerU content list exceeds the ${maxBlocks} block limit`
        ));
    }
    try {
        return parsed.map(normalizeContentBlock);
    }
    catch (error) {
        throw extractionError(error);
    }
}

function normalizeContentBlock(block) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
        throw new Error('Invalid MinerU content block: expected an object');
    }
    if (typeof block.type !== 'string' || !block.type) {
        throw new Error('Invalid MinerU content block type');
    }
    if (!Number.isSafeInteger(block.page_idx) || block.page_idx < 0) {
        throw new Error('Invalid MinerU content block page index');
    }
    if (!isValidNormalizedSourceBBox(block.bbox)) {
        throw new Error('Invalid MinerU content block bounding box');
    }
    const normalized = {
        type: block.type,
        pageIndex: block.page_idx,
        bbox: [...block.bbox],
    };
    if (block.type === 'image' || block.type === 'chart') {
        if (typeof block.img_path === 'string') normalized.assetPath = block.img_path;
        normalized.captions = normalizeStringList(
            block.type === 'chart' ? block.chart_caption : block.image_caption
        );
        if (block.type === 'chart' && typeof block.content === 'string') {
            normalized.text = block.content;
        }
    }
    else {
        const text = contentBlockText(block);
        if (typeof text === 'string') normalized.text = text;
        if (block.type === 'table') {
            normalized.captions = normalizeStringList(block.table_caption);
        }
        else if (block.type === 'code') {
            normalized.captions = normalizeStringList(block.code_caption);
        }
    }
    return normalized;
}

function contentBlockText(block) {
    if (block.type === 'equation') return block.text ?? block.latex;
    if (block.type === 'table') return block.table_body;
    if (block.type === 'code') return block.code_body;
    if (block.type === 'list' && Array.isArray(block.list_items)) {
        return block.list_items.filter(item => typeof item === 'string').join('\n');
    }
    return block.text;
}

function normalizeStringList(value) {
    if (Array.isArray(value)) return value.filter(item => typeof item === 'string');
    return typeof value === 'string' && value ? [value] : [];
}

function markdownSizeError(maxBytes) {
    return new Error(`full.md exceeds the ${formatMegabytes(maxBytes)} MB size limit`);
}

function contentListSizeError(maxBytes) {
    return new Error(
        `MinerU content list exceeds the ${formatMegabytes(maxBytes)} MB size limit`
    );
}

function assetSizeError(path, maxBytes) {
    return new Error(
        `MinerU image ${path} exceeds the ${formatMegabytes(maxBytes)} MB size limit`
    );
}

function extractionError(error) {
    return new Error(`Unable to extract MinerU result: ${error.message}`);
}

function formatMegabytes(bytes) {
    return Math.round(bytes / (1024 * 1024));
}
