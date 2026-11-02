import { createMarkdownCacheKey } from '../cache/markdown-cache.js';
import { sha256Hex } from '../core/sha256.js';
import { isValidSourceMapEntry } from '../core/markdown-source-map.js';
import { throwIfFigureAborted } from '../figures/figure-async.js';
import { FIGURE_LIMITS } from '../figures/figure-limits.js';
import { collectFigureImageNodes, normalizeFigureAssetPath } from '../figures/figure-model.js';
import { prepareMinerUResult } from '../mineru/document/prepare.js';
import { extractMinerUResultFromZip } from '../mineru/zip-markdown.js';
import {
    createLLMCacheIdentity,
    getPreviousLLMCacheParserProfiles,
    hashCanonicalLLMEntries,
    readCanonicalLLMArchiveEntries,
    LLM_CACHE_ADAPTER_VERSION,
    LLM_CACHE_PROVIDER,
} from '../mineru/llm-cache-profile.js';

export class ImportedMinerUReadError extends Error {
    constructor(reason, cause = null) {
        super('The selected local MinerU import is unavailable');
        this.name = 'ImportedMinerUReadError';
        this.code = 'LLM_CACHE_IMPORT_UNAVAILABLE';
        this.reason = reason;
        if (cause) this.cause = cause;
    }
}

// This adapter has no conversion or authentication client. A selected import
// must remain a local read even when all of its retained content has expired.
export class ImportedMinerUDocumentExtractor {
    constructor({
        zotero,
        readFile,
        index,
        cache = null,
        resultStore = null,
        isCacheEnabled = () => false,
        createSourceHash = sha256Hex,
        createCacheKey = createMarkdownCacheKey,
        readRevision = null,
        getPreviousParserProfiles = getPreviousLLMCacheParserProfiles,
        prepareResult = prepareMinerUResult,
        recoverFigures = async result => result,
        preparePDFIndex = null,
        onPDFIndexError = () => {},
    } = {}) {
        if (!zotero?.Items || typeof readFile !== 'function' || typeof index?.get !== 'function'
            || typeof index?.selectionsForAttachment !== 'function') {
            throw new TypeError('A Zotero runtime, PDF reader, and imported MinerU index are required');
        }
        this.zotero = zotero;
        this.readFile = readFile;
        this.index = index;
        this.cache = cache;
        this.resultStore = resultStore;
        this.isCacheEnabled = isCacheEnabled;
        this.createSourceHash = createSourceHash;
        this.createCacheKey = createCacheKey;
        this.readRevision = readRevision;
        this.getPreviousParserProfiles = getPreviousParserProfiles;
        this.prepareResult = prepareResult;
        this.recoverFigures = recoverFigures;
        this.preparePDFIndex = preparePDFIndex;
        this.onPDFIndexError = onPDFIndexError;
    }

    async lookup(itemID, { signal } = {}) {
        const selected = await this.#openSelected(itemID, signal);
        return selected?.record || null;
    }

    async getIdentity(itemID, { signal } = {}) {
        const selected = await this.#openSelected(itemID, signal);
        if (!selected) return null;
        return {
            ...await this.#identity(selected, signal),
            selectionIdentity: selected.selectionIdentity,
            record: selected.record,
        };
    }

    async cacheKeyFor(itemID, options = {}) {
        return (await this.getIdentity(itemID, options))?.cacheKey || null;
    }

    async forgetSelection(selection, { signal } = {}) {
        throwIfFigureAborted(signal);
        const record = selection?.record || selection;
        if (!record) return false;
        if (typeof this.index.forget !== 'function') throw new TypeError('The imported MinerU index cannot forget a selection');
        return this.index.forget(record, { signal, expectedRecord: record });
    }

    extract(itemID, options = {}) {
        return this.#read(itemID, options);
    }

    readCached(itemID, options = {}) {
        return this.#read(itemID, options);
    }

    async #read(itemID, { signal, onProgress, forceRefresh = false } = {}) {
        throwIfFigureAborted(signal);
        if (forceRefresh) return null;
        const selected = await this.#openSelected(itemID, signal);
        if (!selected) return null;
        if (!this.isCacheEnabled()) throw new ImportedMinerUReadError('cache-disabled');
        const identity = await this.#identity(selected, signal);
        const context = { fileData: selected.fileData, signal, onProgress };
        const candidates = await this.#revisionCandidates(selected, identity, signal);
        const cachedByKey = new Map();
        for (const candidate of candidates) {
            const revision = typeof this.readRevision === 'function'
                ? await this.readRevision({ itemID, cacheKey: candidate.cacheKey, signal }) : null;
            throwIfFigureAborted(signal);
            if (revision) {
                const prepared = await this.prepareResult({ ...revision, userEdited: true }, context);
                throwIfFigureAborted(signal);
                return this.#result(selected, candidate, { ...prepared, userEdited: true }, onProgress);
            }
        }
        // Older user-edited cache entries are also corrections. Plain derived
        // content from an older pipeline is rebuilt from the same input package.
        for (const candidate of candidates) {
            const cached = await this.#readCached(candidate.cacheKey, signal);
            throwIfFigureAborted(signal);
            cachedByKey.set(candidate.cacheKey, cached);
            if (cached?.userEdited) return this.#result(selected, candidate, cached, onProgress);
        }
        const cached = cachedByKey.get(identity.cacheKey);
        if (cached) {
            const recovered = await this.recoverFigures(cached, context);
            throwIfFigureAborted(signal);
            if (recovered !== cached) await this.#save(identity.cacheKey, recovered, signal);
            return this.#result(selected, identity, recovered, onProgress);
        }
        const raw = await this.#readStored(selected.record, identity, signal);
        this.#preparePDFIndex(itemID, selected.fileData, signal);
        const prepared = await this.prepareResult(raw, context);
        throwIfFigureAborted(signal);
        const result = await this.recoverFigures(prepared, context);
        throwIfFigureAborted(signal);
        validateDocument(result);
        await this.#save(identity.cacheKey, result, signal);
        return this.#result(selected, identity, result, onProgress);
    }

    async #openSelected(itemID, signal) {
        throwIfFigureAborted(signal);
        const item = this.zotero.Items.getAsync
            ? await this.zotero.Items.getAsync(itemID) : this.zotero.Items.get?.(itemID);
        throwIfFigureAborted(signal);
        if (!item?.isPDFAttachment?.() || item.deleted) {
            throw new ImportedMinerUReadError('attachment-unavailable');
        }
        const candidates = await this.index.selectionsForAttachment({
            libraryID: item.libraryID,
            attachmentKey: item.key,
        }, { signal });
        throwIfFigureAborted(signal);
        if (!candidates.length) return null;
        const filePath = await item.getFilePathAsync();
        throwIfFigureAborted(signal);
        if (!filePath) throw new ImportedMinerUReadError('pdf-unavailable');
        let fileData;
        try {
            fileData = await this.readFile(filePath, { signal });
        }
        catch (error) {
            throwIfFigureAborted(signal);
            throw new ImportedMinerUReadError('pdf-unavailable', error);
        }
        throwIfFigureAborted(signal);
        if (!ArrayBuffer.isView(fileData) || fileData.BYTES_PER_ELEMENT !== 1
            || !fileData.byteLength || fileData.byteLength > FIGURE_LIMITS.maxPDFBytes) {
            throw new ImportedMinerUReadError('pdf-resource-limit');
        }
        const sourceHash = await this.createSourceHash(fileData);
        throwIfFigureAborted(signal);
        const selectionIdentity = { libraryID: item.libraryID, attachmentKey: item.key, sourceHash };
        const record = await this.index.get(selectionIdentity, { signal });
        throwIfFigureAborted(signal);
        if (!record) return null;
        return {
            item, record, selectionIdentity, fileData,
            title: item.parentItem?.getDisplayTitle?.() || item.getDisplayTitle?.() || 'PDF',
        };
    }

    async #identity(selected, signal) {
        const identity = await createLLMCacheIdentity({
            fileData: selected.fileData,
            sourceHash: selected.selectionIdentity.sourceHash,
            snapshotHash: selected.record.snapshotHash,
            adapterVersion: selected.record.adapterVersion,
        });
        throwIfFigureAborted(signal);
        if (identity.rawKey !== selected.record.rawKey) throw new ImportedMinerUReadError('identity-mismatch');
        return identity;
    }

    async #revisionCandidates(selected, identity, signal) {
        const profiles = [identity.parserProfile, ...this.getPreviousParserProfiles(identity.snapshotHash)];
        const candidates = [];
        for (const parserProfile of new Set(profiles)) {
            if (!isSameSnapshotProfile(parserProfile, identity.snapshotHash)) {
                throw new ImportedMinerUReadError('profile-mismatch');
            }
            const cacheKey = parserProfile === identity.parserProfile ? identity.cacheKey
                : await this.createCacheKey(selected.fileData, { parserProfile });
            throwIfFigureAborted(signal);
            candidates.push({ ...identity, parserProfile, cacheKey });
        }
        return candidates;
    }

    async #readStored(record, identity, signal) {
        let stored;
        try {
            stored = this.resultStore?.get ? await this.resultStore.get(record.rawKey, { signal }) : null;
        }
        catch (error) {
            throwIfFigureAborted(signal);
            throw new ImportedMinerUReadError('stored-input-unavailable', error);
        }
        throwIfFigureAborted(signal);
        if (!stored) throw new ImportedMinerUReadError('content-missing');
        try {
            if (stored.provider !== LLM_CACHE_PROVIDER) throw new ImportedMinerUReadError('identity-mismatch');
            const entries = readCanonicalLLMArchiveEntries(stored.archive, { signal });
            const snapshotHash = await hashCanonicalLLMEntries(entries, { signal });
            throwIfFigureAborted(signal);
            if (snapshotHash !== identity.snapshotHash) throw new ImportedMinerUReadError('snapshot-mismatch');
            return {
                ...extractMinerUResultFromZip(stored.archive),
                ...(Number.isSafeInteger(stored.extractedPages) ? { extractedPages: stored.extractedPages } : {}),
                ...(Number.isSafeInteger(stored.totalPages) ? { totalPages: stored.totalPages } : {}),
            };
        }
        catch (error) {
            throwIfFigureAborted(signal);
            if (error instanceof ImportedMinerUReadError) throw error;
            throw new ImportedMinerUReadError('stored-input-invalid', error);
        }
    }

    async #readCached(cacheKey, signal) {
        if (!this.cache?.get) return null;
        try {
            const cached = await this.cache.get(cacheKey);
            throwIfFigureAborted(signal);
            return cached;
        }
        catch (error) {
            throwIfFigureAborted(signal);
            throw new ImportedMinerUReadError('cache-read-failed', error);
        }
    }

    async #save(cacheKey, result, signal) {
        if (!this.cache?.put) throw new ImportedMinerUReadError('cache-unavailable');
        try {
            await this.cache.put(cacheKey, result, { signal });
        }
        catch (error) {
            throwIfFigureAborted(signal);
            throw new ImportedMinerUReadError('cache-write-failed', error);
        }
        throwIfFigureAborted(signal);
    }

    #result(selected, identity, document, onProgress) {
        validateDocument(document);
        onProgress?.(100);
        return {
            ...document,
            kind: 'markdown',
            provider: LLM_CACHE_PROVIDER,
            parserProfile: identity.parserProfile,
            sourceHash: identity.sourceHash,
            cacheKey: identity.cacheKey,
            title: selected.title,
            assets: document.assets || [],
            assetBasePath: document.assetBasePath || '',
            warnings: Array.isArray(document.warnings) ? document.warnings : [],
            cacheHit: true,
            resumedTask: false,
        };
    }

    #preparePDFIndex(itemID, fileData, signal) {
        if (typeof this.preparePDFIndex !== 'function') return;
        try {
            Promise.resolve(this.preparePDFIndex(itemID, { fileData, signal }))
                .catch(error => this.#reportPDFIndexError(error));
        }
        catch (error) {
            this.#reportPDFIndexError(error);
        }
    }

    #reportPDFIndexError(error) {
        try {
            this.onPDFIndexError(error);
        }
        catch {
            // Optional PDF indexing diagnostics cannot break an offline read.
        }
    }
}

function isSameSnapshotProfile(parserProfile, snapshotHash) {
    if (typeof parserProfile !== 'string' || parserProfile.length > 4096) return false;
    try {
        const parsed = JSON.parse(parserProfile);
        return parsed.source === LLM_CACHE_PROVIDER
            && parsed.adapter === LLM_CACHE_ADAPTER_VERSION
            && parsed.snapshotHash === snapshotHash;
    }
    catch {
        return false;
    }
}

function validateDocument(document) {
    const totalPages = document?.totalPages;
    const sourceMap = document?.sourceMap;
    if (typeof document?.markdown !== 'string'
        || !document.markdown.trim() && !document.userEdited
        || new TextEncoder().encode(document.markdown).length > FIGURE_LIMITS.maxMarkdownBytes
        || !Array.isArray(sourceMap)
        || !document.userEdited && !sourceMap.length
        || sourceMap.length && (!Number.isSafeInteger(totalPages) || totalPages < 1 || totalPages > FIGURE_LIMITS.maxPDFPages)
        || sourceMap.some(entry => !isValidSourceMapEntry(entry, document.markdown.length)
            || entry.locations.some(location => location.pageIndex >= totalPages))) {
        throw new ImportedMinerUReadError('document-invalid');
    }
    try {
        const assets = document.assets || [];
        if (!Array.isArray(assets) || assets.length > FIGURE_LIMITS.maxInputAssets) throw new Error('Invalid assets');
        const paths = new Set();
        let bytes = 0;
        for (const asset of assets) {
            const path = normalizeFigureAssetPath(asset?.path);
            if (paths.has(path) || !ArrayBuffer.isView(asset.data) || asset.data.BYTES_PER_ELEMENT !== 1
                || !asset.data.byteLength || asset.data.byteLength > 25 * 1024 * 1024
                || !/^image\/(?:gif|jpeg|png|webp)$/.test(asset.mimeType)) throw new Error('Invalid asset');
            bytes += asset.data.byteLength;
            if (bytes > FIGURE_LIMITS.maxTotalAssetBytes) throw new Error('Asset byte limit');
            paths.add(path);
        }
        for (const image of collectFigureImageNodes(document.markdown)) {
            const path = normalizeFigureAssetPath(image.assetPath, document.assetBasePath || '');
            if (!paths.has(path)) throw new Error('Missing image');
        }
    }
    catch (error) {
        throw new ImportedMinerUReadError('document-images-invalid', error);
    }
}
