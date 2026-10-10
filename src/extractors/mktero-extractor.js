import { prepareMinerUResult } from '../mineru/mineru-result.js';
import {
    MINERU_COMPATIBLE_CACHE_PROFILE_IDS,
    MINERU_PARSER_PROFILE_ID,
} from '../mineru/parser-profile.js';

export class MkteroSignInRequiredError extends Error {
    constructor() {
        super('Sign in to Mktero before converting');
        this.name = 'MkteroSignInRequiredError';
        this.code = 'MKTERO_SIGN_IN_REQUIRED';
    }
}

/**
 * Converts a PDF through the hosted Mktero service.
 *
 * The hosted worker runs the same MinerU pipeline the extension runs locally,
 * so the downloaded ZIP is decoded with the existing MinerU result adapter and
 * shares its cache identity.
 */
export class MkteroDocumentExtractor {
    constructor({
        zotero,
        conversion,
        getApiBase,
        getAccessToken,
        readFile,
        preparePDFIndex = null,
        createCacheKey = null,
        createSourceHash = null,
        readRevision = null,
        cache = null,
        isCacheEnabled = () => false,
        prepareResult = prepareMinerUResult,
        recoverFigures = async result => result,
        onCacheError = error => zotero.logError?.(error),
        onPDFIndexError = error => zotero.logError?.(error),
    }) {
        if (!zotero) throw new TypeError('A Zotero runtime is required');
        if (!conversion?.convert) {
            throw new TypeError('A Mktero conversion client is required');
        }
        if (typeof getApiBase !== 'function') {
            throw new TypeError('A Mktero API base provider is required');
        }
        if (typeof getAccessToken !== 'function') {
            throw new TypeError('A Mktero access token provider is required');
        }
        if (!readFile) throw new TypeError('A file reader is required');
        this.zotero = zotero;
        this.conversion = conversion;
        this.getApiBase = getApiBase;
        this.getAccessToken = getAccessToken;
        this.readFile = readFile;
        this.preparePDFIndex = preparePDFIndex;
        this.createCacheKey = createCacheKey;
        this.createSourceHash = createSourceHash;
        this.readRevision = readRevision;
        this.cache = cache;
        this.isCacheEnabled = isCacheEnabled;
        this.prepareResult = prepareResult;
        this.recoverFigures = recoverFigures;
        this.onCacheError = onCacheError;
        this.onPDFIndexError = onPDFIndexError;
    }

    async extract(itemID, { onProgress, signal, forceRefresh = false } = {}) {
        const opened = await this.#openPDF(itemID, signal);
        this.#preparePDFIndex(itemID, opened.fileData, signal);
        const prepared = await this.#prepareCachedRead(opened, {
            itemID,
            signal,
            forceRefresh,
        });
        const cached = await this.#cachedExtractResult(opened, prepared, {
            signal,
            onProgress,
            forceRefresh,
        });
        if (cached) return cached;

        let converted;
        try {
            converted = await this.conversion.convert({
                apiBase: this.getApiBase(),
                getAccessToken: this.getAccessToken,
                fileName: opened.item.attachmentFilename || `zotero-${itemID}.pdf`,
                fileData: opened.fileData,
                onProgress,
                signal,
            });
        }
        catch (error) {
            if (error?.code === 'MKTERO_SIGN_IN_REQUIRED') {
                throw new MkteroSignInRequiredError();
            }
            throw error;
        }

        prepared.warnings.push(...(converted.warnings || []));
        const preparedResult = await this.prepareResult(converted.result, {
            fileData: opened.fileData,
            signal,
            onProgress,
        });
        throwIfAborted(signal);
        const result = await this.recoverFigures(preparedResult, {
            fileData: opened.fileData,
            signal,
            onProgress,
        });
        throwIfAborted(signal);
        if (prepared.cacheKey && prepared.cacheEnabled) {
            await this.#saveCachedResult(
                prepared.cacheKey,
                result,
                signal,
                prepared.warnings
            );
        }
        return createResult(
            opened.title,
            result,
            converted.origin === 'cache',
            prepared.warnings,
            prepared.cacheKey,
            converted.origin === 'resumed',
            prepared.sourceHash
        );
    }

    async readCached(itemID, { signal, onProgress } = {}) {
        const opened = await this.#openPDF(itemID, signal);
        const prepared = await this.#prepareCachedRead(opened, {
            itemID,
            signal,
            forceRefresh: false,
        });
        return this.#cachedExtractResult(opened, prepared, {
            signal,
            onProgress,
            forceRefresh: false,
        });
    }

    async #openPDF(itemID, signal) {
        throwIfAborted(signal);
        const item = await this.zotero.Items.getAsync(itemID);
        if (!item?.isPDFAttachment?.()) {
            throw new Error('Only PDF attachments can be converted');
        }
        const filePath = await item.getFilePathAsync();
        if (!filePath) {
            throw new Error('The local PDF file is unavailable');
        }
        const fileData = await this.readFile(filePath);
        throwIfAborted(signal);
        const title = item.parentItem?.getDisplayTitle?.()
            || item.getDisplayTitle?.()
            || 'Untitled PDF';
        return { item, fileData, title };
    }

    async #prepareCachedRead({ fileData }, { itemID, signal, forceRefresh }) {
        const warnings = [];
        let cacheKey = null;
        if (this.createCacheKey) {
            try {
                cacheKey = await this.createCacheKey(fileData, {
                    parserProfile: MINERU_PARSER_PROFILE_ID,
                });
            }
            catch (error) {
                this.#reportCacheError(error);
                warnings.push('The local Markdown cache is unavailable.');
            }
        }
        const sourceHash = await readSourceHash(
            this.createSourceHash,
            fileData,
            error => this.#reportCacheError(error)
        );
        let revision = null;
        if (!forceRefresh && cacheKey && typeof this.readRevision === 'function') {
            revision = await this.#readRevision({
                itemID,
                cacheKey,
                fileData,
                signal,
            });
            throwIfAborted(signal);
        }
        return {
            cacheEnabled: Boolean(this.isCacheEnabled()),
            warnings,
            cacheKey,
            sourceHash,
            revision,
        };
    }

    async #cachedExtractResult(opened, prepared, { signal, onProgress, forceRefresh }) {
        if (prepared.revision?.snapshot) {
            onProgress?.(100);
            const result = await this.prepareResult({
                ...prepared.revision.snapshot,
                userEdited: true,
            }, {
                fileData: opened.fileData,
                signal,
                onProgress,
            });
            return createResult(
                opened.title,
                result,
                true,
                prepared.warnings,
                prepared.revision.cacheKey,
                false,
                prepared.sourceHash
            );
        }
        if (forceRefresh || !prepared.cacheKey) return null;
        const cached = await this.#readCachedResult({
            cacheKey: prepared.cacheKey,
            fileData: opened.fileData,
            cacheEnabled: prepared.cacheEnabled,
            signal,
            warnings: prepared.warnings,
            onProgress,
        });
        throwIfAborted(signal);
        if (!cached) return null;
        onProgress?.(100);
        return createResult(
            opened.title,
            cached,
            true,
            prepared.warnings,
            prepared.cacheKey,
            false,
            prepared.sourceHash
        );
    }

    async #readRevision({ itemID, cacheKey, fileData, signal }) {
        let revision = await this.readRevision({ itemID, cacheKey, signal });
        throwIfAborted(signal);
        if (revision || !this.createCacheKey) {
            return revision ? { snapshot: revision, cacheKey } : null;
        }
        const visited = new Set([cacheKey]);
        for (const parserProfile of MINERU_COMPATIBLE_CACHE_PROFILE_IDS) {
            const legacyKey = await this.createCacheKey(fileData, {
                parserProfile,
            });
            throwIfAborted(signal);
            if (!legacyKey || visited.has(legacyKey)) continue;
            visited.add(legacyKey);
            revision = await this.readRevision({
                itemID,
                cacheKey: legacyKey,
                signal,
            });
            throwIfAborted(signal);
            if (revision) return { snapshot: revision, cacheKey: legacyKey };
        }
        return null;
    }

    // #readCachedResult uses the same local Markdown cache as MinerU. A disabled
    // cache still returns a user-edited entry so corrections are not discarded.
    async #readCachedResult({
        cacheKey,
        fileData,
        cacheEnabled,
        signal,
        warnings,
        onProgress,
    }) {
        if (!this.cache?.get) return null;
        const cached = await this.#getCachedResult(cacheKey, warnings);
        throwIfAborted(signal);
        if (cached && (cacheEnabled || cached.userEdited)) {
            return this.#finishCachedResult({
                cached,
                cacheKey,
                storedKey: cacheKey,
                fileData,
                cacheEnabled,
                signal,
                warnings,
                onProgress,
            });
        }
        if (!cacheEnabled || !this.createCacheKey) return null;
        const visited = new Set([cacheKey]);
        for (const parserProfile of MINERU_COMPATIBLE_CACHE_PROFILE_IDS) {
            let legacyKey = null;
            try {
                legacyKey = await this.createCacheKey(fileData, { parserProfile });
            }
            catch (error) {
                this.#reportCacheError(error);
                continue;
            }
            throwIfAborted(signal);
            if (!legacyKey || visited.has(legacyKey)) continue;
            visited.add(legacyKey);
            const legacy = await this.#getCachedResult(legacyKey, warnings);
            throwIfAborted(signal);
            if (!legacy) continue;
            return this.#finishCachedResult({
                cached: legacy,
                cacheKey,
                storedKey: legacyKey,
                fileData,
                cacheEnabled,
                signal,
                warnings,
                onProgress,
            });
        }
        return null;
    }

    async #getCachedResult(cacheKey, warnings) {
        try {
            return await this.cache.get(cacheKey);
        }
        catch (error) {
            if (error?.name === 'AbortError') throw error;
            this.#reportCacheError(error);
            warnings.push('The local Markdown cache could not be read.');
            return null;
        }
    }

    async #finishCachedResult({
        cached,
        cacheKey,
        storedKey,
        fileData,
        cacheEnabled,
        signal,
        warnings,
        onProgress,
    }) {
        const recovered = await this.recoverFigures(cached, {
            fileData,
            signal,
            onProgress,
        });
        throwIfAborted(signal);
        if (cacheEnabled && (storedKey !== cacheKey || recovered !== cached)) {
            await this.#saveCachedResult(cacheKey, recovered, signal, warnings);
        }
        return recovered;
    }

    async #saveCachedResult(cacheKey, result, signal, warnings) {
        if (!this.cache?.put) return;
        try {
            await this.cache.put(cacheKey, result, { signal });
        }
        catch (error) {
            throwIfAborted(signal);
            this.#reportCacheError(error);
            warnings.push('The Markdown result could not be saved to the local cache.');
        }
    }

    #preparePDFIndex(itemID, fileData, signal) {
        if (typeof this.preparePDFIndex !== 'function') return;
        try {
            Promise.resolve(this.preparePDFIndex(itemID, {
                fileData,
                signal,
            })).catch(error => this.#reportPDFIndexError(error));
        }
        catch (error) {
            this.#reportPDFIndexError(error);
        }
    }

    #reportCacheError(error) {
        try {
            this.onCacheError(error);
        }
        catch {
            // Cache diagnostics must not make PDF conversion fail.
        }
    }

    #reportPDFIndexError(error) {
        try {
            this.onPDFIndexError(error);
        }
        catch {
            // PDF index diagnostics must not make conversion fail.
        }
    }
}

function createResult(
    title,
    parsedResult,
    cacheHit,
    warnings = [],
    cacheKey = null,
    resumedTask = false,
    sourceHash = null
) {
    const extracted = {
        kind: 'markdown',
        provider: 'mktero',
        parserProfile: MINERU_PARSER_PROFILE_ID,
        title,
        markdown: parsedResult.markdown,
        assets: parsedResult.assets || [],
        assetBasePath: parsedResult.assetBasePath || '',
        extractedPages: parsedResult.extractedPages,
        totalPages: parsedResult.totalPages,
        sourceMap: parsedResult.sourceMap,
        ...(parsedResult.figureMap ? { figureMap: parsedResult.figureMap } : {}),
        warnings,
        cacheHit,
        resumedTask,
    };
    if (cacheKey) extracted.cacheKey = cacheKey;
    if (sourceHash) extracted.sourceHash = sourceHash;
    if (parsedResult.userEdited) extracted.userEdited = true;
    if (Array.isArray(parsedResult.chromeRanges)) {
        extracted.chromeRanges = parsedResult.chromeRanges;
    }
    return extracted;
}

async function readSourceHash(createSourceHash, fileData, onError) {
    if (typeof createSourceHash !== 'function') return null;
    try {
        const sourceHash = await createSourceHash(fileData);
        return typeof sourceHash === 'string' && sourceHash ? sourceHash : null;
    }
    catch (error) {
        onError(error);
        return null;
    }
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    if (signal.reason) throw signal.reason;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
}
