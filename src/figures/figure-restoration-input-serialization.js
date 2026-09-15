import { FIGURE_LIMITS } from './figure-limits.js';
import { validateFigureInput } from './figure-model.js';

const INPUT_SCHEMA_VERSION = 1;
const INPUT_ASSET_KEYS = ['path', 'mimeType'];

// Persists the provider figure input without duplicating image bytes. The
// cached document already stores the original assets, so only the structural
// fields and asset references are written; bytes are rehydrated by path.
export function serializeFigureRestorationInput(input, { maxBytes = FIGURE_LIMITS.maxMapBytes } = {}) {
    validateFigureInput(input);
    const projection = {
        schemaVersion: INPUT_SCHEMA_VERSION,
        provider: input.provider,
        markdown: input.markdown,
        assetBasePath: input.assetBasePath || '',
        assets: input.assets.map(asset => ({
            path: asset.path,
            mimeType: asset.mimeType,
            size: asset.data.byteLength,
        })),
        blocks: input.blocks,
        pages: input.pages,
        ...(input.contentList !== undefined ? { contentList: input.contentList } : {}),
        ...(input.providerState !== undefined ? { providerState: input.providerState } : {}),
        ...(input.detailedLayout !== undefined ? { detailedLayout: input.detailedLayout } : {}),
        ...(input.figureTables !== undefined ? { figureTables: input.figureTables } : {}),
    };
    const json = JSON.stringify(projection);
    const bytes = new TextEncoder().encode(json).length;
    if (bytes > maxBytes) {
        throw new Error('Figure restoration input exceeds the size limit');
    }
    return { json, bytes };
}

// Rebuilds the figure input from the cached projection plus the assets already
// stored with the document. Returns null when the input cannot be trusted, so
// the caller can fall back to a fresh OCR conversion instead of guessing.
export function parseFigureRestorationInputJSON(json, { document, maxBytes = FIGURE_LIMITS.maxMapBytes } = {}) {
    if (typeof json !== 'string' || new TextEncoder().encode(json).length > maxBytes) return null;
    let projection;
    try {
        projection = JSON.parse(json);
    }
    catch {
        return null;
    }
    if (!projection || projection.schemaVersion !== INPUT_SCHEMA_VERSION
        || !Array.isArray(projection.assets)) return null;
    const byPath = new Map();
    for (const asset of document?.assets || []) {
        if (typeof asset?.path === 'string' && ArrayBuffer.isView(asset.data)) {
            byPath.set(asset.path, asset);
        }
    }
    const assets = [];
    for (const reference of projection.assets) {
        if (!reference || typeof reference.path !== 'string') return null;
        const source = byPath.get(reference.path);
        if (!source) return null;
        for (const key of INPUT_ASSET_KEYS) {
            if (reference[key] !== source[key]) return null;
        }
        assets.push({ path: source.path, mimeType: source.mimeType, data: source.data });
    }
    const input = {
        provider: projection.provider,
        markdown: projection.markdown,
        assetBasePath: projection.assetBasePath || '',
        assets,
        blocks: projection.blocks,
        pages: projection.pages,
        ...(projection.contentList !== undefined ? { contentList: projection.contentList } : {}),
        ...(projection.providerState !== undefined ? { providerState: projection.providerState } : {}),
        ...(projection.detailedLayout !== undefined ? { detailedLayout: projection.detailedLayout } : {}),
        ...(projection.figureTables !== undefined ? { figureTables: projection.figureTables } : {}),
    };
    try {
        validateFigureInput(input);
    }
    catch {
        return null;
    }
    return input;
}
