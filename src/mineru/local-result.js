import { strFromU8, unzipSync } from 'fflate';
import { toUint8Array } from './binary.js';
import {
    DEFAULT_MAX_ASSET_BYTES,
    DEFAULT_MAX_MARKDOWN_BYTES,
    DEFAULT_MAX_TOTAL_ASSET_BYTES,
} from './zip-markdown.js';

const MARKDOWN_NAME = 'markdown.md';
const IMAGE_MIME_TYPES = new Map([
    ['.gif', 'image/gif'],
    ['.jpeg', 'image/jpeg'],
    ['.jpg', 'image/jpeg'],
    ['.png', 'image/png'],
    ['.webp', 'image/webp'],
]);

export function extractMinerULocalResultFromZip(archive, {
    maxMarkdownBytes = DEFAULT_MAX_MARKDOWN_BYTES,
    maxAssetBytes = DEFAULT_MAX_ASSET_BYTES,
    maxTotalAssetBytes = DEFAULT_MAX_TOTAL_ASSET_BYTES,
} = {}) {
    const bytes = toUint8Array(archive, 'The MinerU result archive');
    let markdownPath;
    let documentFiles;
    try {
        documentFiles = unzipSync(bytes, {
            filter(file) {
                assertSafeZipPath(file.name);
                if (file.name.split('/').at(-1) !== MARKDOWN_NAME) return false;
                if (markdownPath) {
                    throw resultError('The MinerU result contains multiple markdown.md files');
                }
                markdownPath = file.name;
                if (file.originalSize > maxMarkdownBytes) {
                    throw resultError(
                        `markdown.md exceeds the ${formatMegabytes(maxMarkdownBytes)} MB size limit`
                    );
                }
                return true;
            },
        });
    }
    catch (error) {
        throw extractionError(error);
    }
    if (!markdownPath) {
        throw resultError('The MinerU result archive does not contain markdown.md');
    }
    const markdownBytes = documentFiles[markdownPath];
    if (!markdownBytes || markdownBytes.length > maxMarkdownBytes) {
        throw resultError(
            `markdown.md exceeds the ${formatMegabytes(maxMarkdownBytes)} MB size limit`
        );
    }

    let totalAssetBytes = 0;
    let assetFiles;
    try {
        assetFiles = unzipSync(bytes, {
            filter(file) {
                assertSafeZipPath(file.name);
                const mimeType = imageMimeType(file.name);
                if (!mimeType) return false;
                if (file.originalSize > maxAssetBytes) {
                    throw resultError(
                        `MinerU image exceeds the ${formatMegabytes(maxAssetBytes)} MB size limit`
                    );
                }
                totalAssetBytes += file.originalSize;
                if (totalAssetBytes > maxTotalAssetBytes) {
                    throw resultError(
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

    return {
        markdown: strFromU8(markdownBytes),
        assets: Object.entries(assetFiles).map(([path, data]) => ({
            path,
            mimeType: imageMimeType(path),
            data,
        })),
        assetBasePath: directoryName(markdownPath),
        contentList: [],
    };
}

function assertSafeZipPath(path) {
    if (typeof path !== 'string' || !path || path.length > 1_024
        || /[\u0000-\u001f\u007f\\]/.test(path)
        || path.startsWith('/') || path.startsWith('//')) {
        throw resultError('The MinerU result archive contains an unsafe path');
    }
    const segments = path.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
        throw resultError('The MinerU result archive contains an unsafe path');
    }
}

function imageMimeType(path) {
    const match = String(path).toLowerCase().match(/\.[a-z0-9]+$/);
    return match ? IMAGE_MIME_TYPES.get(match[0]) || null : null;
}

function directoryName(path) {
    const separator = path.lastIndexOf('/');
    return separator < 0 ? '' : path.slice(0, separator);
}

function resultError(message) {
    const error = new Error(message);
    error.code = 'MINERU_LOCAL_INVALID_RESULT';
    return error;
}

function extractionError(error) {
    if (error?.code === 'MINERU_LOCAL_INVALID_RESULT') return error;
    return resultError('The MinerU result archive is invalid');
}

function formatMegabytes(bytes) {
    return Math.round(bytes / (1024 * 1024));
}
