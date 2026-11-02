import { unzipSync } from 'fflate';
import { createMarkdownCacheKey } from '../cache/markdown-cache.js';
import { createMinerUResultKey } from '../cache/mineru-result-store.js';
import { sha256Hex } from '../core/sha256.js';
import { FIGURE_PIPELINE_PROFILE, FIGURE_LIMITS } from '../figures/figure-limits.js';
import { normalizeFigureAssetPath } from '../figures/figure-model.js';
import { throwIfFigureAborted } from '../figures/figure-async.js';
import { toUint8Array } from './binary.js';
import { MINERU_DOCUMENT_PIPELINE } from './parser-profile.js';

export const LLM_CACHE_ADAPTER_VERSION = 'llm-cache-v1';
export const LLM_CACHE_PROVIDER = 'llm-for-zotero';
const HASH = /^[a-f0-9]{64}$/;
const MAX_INPUT_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 5_000;
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const IMAGE = /\.(?:gif|jpe?g|png|webp)$/i;
const STRUCTURE = /(?:^|\/)(?:.+_)?(?:content_list|middle|layout)\.json$/i;

// Keep shipped pipeline values literal: later document changes must still find
// corrections made for this snapshot under its original imported profile.
const SHIPPED_PIPELINES = Object.freeze([
    Object.freeze({ document: 'mineru-document-ir-v11', figureStructure: 'figure-region-v17' }),
]);

export function createLLMCacheParserProfile(snapshotHash, {
    document = MINERU_DOCUMENT_PIPELINE,
    figureStructure = FIGURE_PIPELINE_PROFILE,
    adapterVersion = LLM_CACHE_ADAPTER_VERSION,
} = {}) {
    requireHash(snapshotHash, 'snapshot hash');
    requireAdapter(adapterVersion);
    for (const value of [document, figureStructure]) {
        if (typeof value !== 'string' || !value || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
            throw new TypeError('An imported MinerU processing profile is required');
        }
    }
    return JSON.stringify({
        source: LLM_CACHE_PROVIDER,
        adapter: adapterVersion,
        snapshotHash,
        document,
        figureStructure,
    });
}

export const parserProfileForLLMCache = createLLMCacheParserProfile;

export function getPreviousLLMCacheParserProfiles(snapshotHash) {
    const current = createLLMCacheParserProfile(snapshotHash);
    return [...new Set(SHIPPED_PIPELINES.map(pipeline => (
        createLLMCacheParserProfile(snapshotHash, pipeline)
    )))].filter(profile => profile !== current);
}

export function createLLMCacheRequestProfile(snapshotHash, {
    adapterVersion = LLM_CACHE_ADAPTER_VERSION,
} = {}) {
    requireHash(snapshotHash, 'snapshot hash');
    requireAdapter(adapterVersion);
    return JSON.stringify({ adapter: adapterVersion, snapshotHash });
}

export async function createLLMCacheRawKey({
    sourceHash,
    snapshotHash,
    adapterVersion = LLM_CACHE_ADAPTER_VERSION,
    crypto = globalThis.crypto,
}) {
    requireHash(sourceHash, 'source hash');
    return createMinerUResultKey({
        sourceHash,
        provider: LLM_CACHE_PROVIDER,
        requestProfile: createLLMCacheRequestProfile(snapshotHash, { adapterVersion }),
        crypto,
    });
}

export async function createLLMCacheIdentity({
    fileData,
    sourceHash = null,
    snapshotHash,
    adapterVersion = LLM_CACHE_ADAPTER_VERSION,
    crypto = globalThis.crypto,
}) {
    requireHash(snapshotHash, 'snapshot hash');
    requireAdapter(adapterVersion);
    const actualHash = await sha256Hex(fileData, { crypto });
    if (sourceHash !== null && (!HASH.test(sourceHash) || sourceHash !== actualHash)) {
        throw new TypeError('The imported PDF source hash does not match its bytes');
    }
    const parserProfile = createLLMCacheParserProfile(snapshotHash, { adapterVersion });
    const [rawKey, cacheKey] = await Promise.all([
        createLLMCacheRawKey({ sourceHash: actualHash, snapshotHash, adapterVersion, crypto }),
        createMarkdownCacheKey(fileData, { parserProfile, crypto }),
    ]);
    return {
        provider: LLM_CACHE_PROVIDER,
        adapterVersion,
        parserProfile,
        requestProfile: createLLMCacheRequestProfile(snapshotHash, { adapterVersion }),
        rawKey,
        cacheKey,
        sourceHash: actualHash,
        snapshotHash,
    };
}

export async function hashCanonicalLLMEntries(entries, {
    signal,
    crypto = globalThis.crypto,
    maxBytes = MAX_INPUT_BYTES,
    maxEntries = MAX_FILES,
} = {}) {
    throwIfFigureAborted(signal);
    if (!Array.isArray(entries) || !entries.length || entries.length > Math.min(maxEntries, MAX_FILES)) {
        throw new TypeError('The imported input entries exceed the file limit');
    }
    const paths = new Set();
    let total = 0;
    const ordered = entries.map(entry => {
        const path = canonicalPath(entry?.path);
        if (paths.has(path)) throw new Error('The imported input contains duplicate paths');
        paths.add(path);
        const data = toUint8Array(entry?.data, 'Imported input data');
        total += data.byteLength;
        if (total > Math.min(maxBytes, MAX_INPUT_BYTES)) throw new Error('The imported input exceeds its byte limit');
        return { path, data };
    }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    const descriptor = ['llm-cache-input:1'];
    for (const { path, data } of ordered) {
        throwIfFigureAborted(signal);
        descriptor.push(JSON.stringify([path, data.byteLength, await sha256Hex(data, { crypto })]));
    }
    throwIfFigureAborted(signal);
    return sha256Hex(new TextEncoder().encode(descriptor.join('\n')), { crypto });
}

export function readCanonicalLLMArchiveEntries(archive, {
    signal,
    maxBytes = MAX_INPUT_BYTES,
    maxEntries = MAX_FILES,
} = {}) {
    throwIfFigureAborted(signal);
    const bytes = toUint8Array(archive, 'Imported result archive');
    const byteLimit = Math.min(maxBytes, MAX_INPUT_BYTES);
    if (!bytes.length || bytes.length > byteLimit) throw new Error('The imported archive exceeds its byte limit');
    const names = new Set();
    let total = 0;
    let totalImages = 0;
    let images = 0;
    const files = unzipSync(bytes, {
        filter(file) {
            throwIfFigureAborted(signal);
            const name = canonicalPath(file.name);
            if (names.has(name)) throw new Error('The imported archive contains duplicate paths');
            names.add(name);
            if (names.size > Math.min(maxEntries, MAX_FILES)) throw new Error('The imported archive exceeds its file limit');
            const isImage = IMAGE.test(name);
            const isMarkdown = /(?:^|\/)full\.md$/i.test(name);
            const isStructure = STRUCTURE.test(name);
            if (!isImage && !isMarkdown && !isStructure) throw new Error('The imported archive contains an unsupported file');
            const limit = isImage ? MAX_ASSET_BYTES
                : isMarkdown ? FIGURE_LIMITS.maxMarkdownBytes : FIGURE_LIMITS.maxLayoutBytes;
            if (!Number.isSafeInteger(file.originalSize) || file.originalSize < 0 || file.originalSize > limit) {
                throw new Error('An imported archive file exceeds its byte limit');
            }
            total += file.originalSize;
            if (isImage) {
                totalImages += file.originalSize;
                if (++images > FIGURE_LIMITS.maxInputAssets || totalImages > FIGURE_LIMITS.maxTotalAssetBytes) {
                    throw new Error('The imported archive images exceed their resource limit');
                }
            }
            if (total > byteLimit) throw new Error('The imported archive exceeds its expanded byte limit');
            return true;
        },
    });
    throwIfFigureAborted(signal);
    return Object.entries(files).map(([path, data]) => ({ path, data }));
}

function canonicalPath(value) {
    const path = normalizeFigureAssetPath(value);
    if (path !== value) throw new TypeError('An imported input path must be canonical');
    return path;
}

function requireHash(value, label) {
    if (typeof value !== 'string' || !HASH.test(value)) throw new TypeError(`An imported ${label} is required`);
}

function requireAdapter(value) {
    if (value !== LLM_CACHE_ADAPTER_VERSION) throw new TypeError('The imported cache adapter version is unsupported');
}
