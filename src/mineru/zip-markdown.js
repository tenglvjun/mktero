import { strFromU8, unzipSync } from 'fflate';
import { toUint8Array } from './binary.js';

export const DEFAULT_MAX_MARKDOWN_BYTES = 50 * 1024 * 1024;
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
    maxAssetBytes = DEFAULT_MAX_ASSET_BYTES,
    maxTotalAssetBytes = DEFAULT_MAX_TOTAL_ASSET_BYTES,
} = {}) {
    const bytes = toUint8Array(archive, 'The MinerU result archive');
    let markdownPath;
    let markdownFiles;
    try {
        markdownFiles = unzipSync(bytes, {
            filter(file) {
                if (markdownPath || !/(^|\/)full\.md$/i.test(file.name)) return false;
                markdownPath = file.name;
                if (file.originalSize > maxMarkdownBytes) {
                    throw markdownSizeError(maxMarkdownBytes);
                }
                return true;
            },
        });
    }
    catch (error) {
        throw extractionError(error);
    }

    if (!markdownPath) {
        throw new Error('The MinerU result archive does not contain full.md');
    }
    const markdownBytes = markdownFiles[markdownPath];
    if (!markdownBytes || markdownBytes.length > maxMarkdownBytes) {
        throw extractionError(markdownSizeError(maxMarkdownBytes));
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

function markdownSizeError(maxBytes) {
    return new Error(`full.md exceeds the ${formatMegabytes(maxBytes)} MB size limit`);
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
