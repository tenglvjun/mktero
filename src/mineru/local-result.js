import { strFromU8, unzipSync } from 'fflate';
import { toUint8Array } from './binary.js';
import { assertFigureJSONBudget } from '../figures/figure-model.js';
import { FIGURE_LIMITS } from '../figures/figure-limits.js';
import { projectMinerUMiddleJSON } from './document/ingest-middle-v2.js';
import {
    DEFAULT_MAX_ASSET_BYTES,
    DEFAULT_MAX_MARKDOWN_BYTES,
    DEFAULT_MAX_TOTAL_ASSET_BYTES,
} from './zip-markdown.js';

const MARKDOWN_NAME = 'markdown.md';
const MIDDLE_NAME = 'middle_json.json';
const MAX_MIDDLE_DEPTH = 32;
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

    const assetBasePath = directoryName(markdownPath);
    const layout = readMiddleJSON(bytes, assetBasePath);
    return {
        markdown: strFromU8(markdownBytes),
        assets: Object.entries(assetFiles).map(([path, data]) => ({
            path,
            mimeType: imageMimeType(path),
            data,
        })),
        assetBasePath,
        contentList: [],
        ...(layout ? { layout } : {}),
    };
}

// MinerU 4.0 writes the document structure next to markdown.md as
// middle_json.json (DocVortex Middle JSON 2.0). It is projected to the
// layout the document pipeline reads. The structure is optional: without
// it, or when it cannot be read, the result keeps MinerU's own Markdown.
function readMiddleJSON(bytes, root) {
    try {
        let name = null;
        let size = 0;
        unzipSync(bytes, { filter(file) {
            if (directoryName(file.name) === root && file.name.split('/').at(-1) === MIDDLE_NAME) {
                if (name) throw resultError('The MinerU result contains multiple middle_json.json files');
                name = file.name;
                size = file.originalSize;
            }
            return false;
        } });
        if (!name || size > FIGURE_LIMITS.maxLayoutBytes) return null;
        const data = unzipSync(bytes, { filter: file => file.name === name })[name];
        if (!data || data.length > FIGURE_LIMITS.maxLayoutBytes) return null;
        const parsed = JSON.parse(strFromU8(data));
        // Inline spans and nested lists sit deeper than 3.x lines.
        assertFigureJSONBudget(parsed, { maxBytes: FIGURE_LIMITS.maxLayoutBytes, maxDepth: MAX_MIDDLE_DEPTH });
        return projectMinerUMiddleJSON(parsed);
    }
    catch {
        return null;
    }
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
