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
        this.#preparePDFIndex(itemID, fileData, signal);

        const title = item.parentItem?.getDisplayTitle?.()
            || item.getDisplayTitle?.()
            || 'Untitled PDF';
        const warnings = [];
        let cacheKey = null;
        let sourceHash = null;
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
        sourceHash = await readSourceHash(
            this.createSourceHash,
            fileData,
            error => this.#reportCacheError(error)
        );

        const cacheEnabled = Boolean(this.isCacheEnabled());
        if (!forceRefresh && cacheKey && typeof this.readRevision === 'function') {
            const revision = await this.#readRevision({
                itemID,
                cacheKey,
                fileData,
                signal,
            });
            throwIfAborted(signal);
            if (revision?.snapshot) {
                onProgress?.(100);
                const result = this.prepareResult({
                    ...revision.snapshot,
                    userEdited: true,
                });
                return createResult(
                    title,
                    result,
                    true,
                    warnings,
                    revision.cacheKey,
                    false,
                    sourceHash
                );
            }
        }
        if (!forceRefresh && cacheKey) {
            const cached = await this.#readCachedResult({
                cacheKey,
                fileData,
                cacheEnabled,
                signal,
                warnings,
                onProgress,
            });
            throwIfAborted(signal);
            if (cached) {
                onProgress?.(100);
                return createResult(
                    title,
                    cached,
                    true,
                    warnings,
                    cacheKey,
                    false,
                    sourceHash
                );
            }
        }

        let converted;
        try {
            converted = await this.conversion.convert({
                apiBase: this.getApiBase(),
                getAccessToken: this.getAccessToken,
                fileName: item.attachmentFilename || `zotero-${itemID}.pdf`,
                fileData,
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

        warnings.push(...(converted.warnings || []));
        const prepared = await this.prepareResult(converted.result, {
            fileData,
            signal,
            onProgress,
        });
        throwIfAborted(signal);
        const result = await this.recoverFigures(prepared, {
            fileData,
            signal,
            onProgress,
        });
        throwIfAborted(signal);
        if (cacheKey && cacheEnabled) {
            await this.#saveCachedResult(cacheKey, result, signal, warnings);
        }
        return createResult(
            title,
            result,
            converted.origin === 'cache',
            warnings,
            cacheKey,
            converted.origin === 'resumed',
            sourceHash
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
