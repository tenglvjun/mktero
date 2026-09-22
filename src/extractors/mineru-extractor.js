import { prepareMinerUResult } from '../mineru/mineru-result.js';
import { MINERU_PARSER_PROFILE_ID, MINERU_PREVIOUS_PARSER_PROFILE_IDS } from '../mineru/parser-profile.js';
import { LEGACY_FIGURE_PROFILES } from '../figures/legacy-figure-profiles.js';

export class MinerUConfigurationError extends Error {
    constructor() {
        super('Configure a MinerU API Token in the Mktero preferences');
        this.name = 'MinerUConfigurationError';
        this.code = 'MINERU_API_KEY_REQUIRED';
    }
}

export class MinerUDocumentExtractor {
    constructor({
        zotero,
        conversion,
        getApiKey,
        readFile,
        preparePDFIndex = null,
        createCacheKey = null,
        createSourceHash = null,
        getParserProfile = () => MINERU_PARSER_PROFILE_ID,
        getPreviousParserProfiles = () => [
            ...MINERU_PREVIOUS_PARSER_PROFILE_IDS,
            LEGACY_FIGURE_PROFILES.mineru,
        ],
        readRevision = null,
        isCacheEnabled = () => false,
        prepareResult = prepareMinerUResult,
        onCacheError = error => zotero.logError?.(error),
        onPDFIndexError = error => zotero.logError?.(error),
    }) {
        if (!zotero) throw new TypeError('A Zotero runtime is required');
        if (!conversion?.convert) {
            throw new TypeError('A MinerU conversion module is required');
        }
        if (!getApiKey) throw new TypeError('A MinerU API Token provider is required');
        if (!readFile) throw new TypeError('A file reader is required');
        this.zotero = zotero;
        this.conversion = conversion;
        this.getApiKey = getApiKey;
        this.readFile = readFile;
        this.preparePDFIndex = preparePDFIndex;
        this.createCacheKey = createCacheKey;
        this.createSourceHash = createSourceHash;
        this.getParserProfile = getParserProfile;
        this.getPreviousParserProfiles = getPreviousParserProfiles;
        this.readRevision = readRevision;
        this.isCacheEnabled = isCacheEnabled;
        this.prepareResult = prepareResult;
        this.onCacheError = onCacheError;
        this.onPDFIndexError = onPDFIndexError;
    }

    async extract(itemID, { onProgress, onProgressiveFigures = null, signal, forceRefresh = false } = {}) {
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
        const cacheEnabled = Boolean(this.isCacheEnabled());
        const warnings = [];
        const parserProfile = this.#parserProfile();
        let cacheKey = null;
        let sourceHash = null;
        if (this.createCacheKey) {
            try {
                cacheKey = await this.createCacheKey(fileData, { parserProfile });
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
        if (!forceRefresh && cacheKey && typeof this.readRevision === 'function') {
            let revisionKey = cacheKey;
            let revisionProfile = parserProfile;
            let revision = await this.readRevision({
                itemID,
                cacheKey,
                signal,
            });
            throwIfAborted(signal);
            if (!revision && this.createCacheKey) {
                try {
                    const visited = new Set([cacheKey]);
                    for (const previousProfile of this.#previousParserProfiles()) {
                        const legacyKey = await this.createCacheKey(fileData, {
                            parserProfile: previousProfile,
                        });
                        throwIfAborted(signal);
                        if (legacyKey && !visited.has(legacyKey)) {
                            visited.add(legacyKey);
                            revision = await this.readRevision({ itemID, cacheKey: legacyKey, signal });
                            throwIfAborted(signal);
                            if (revision) {
                                revisionKey = legacyKey;
                                revisionProfile = previousProfile;
                                break;
                            }
                        }
                    }
                }
                catch (error) {
                    throwIfAborted(signal);
                    this.#reportCacheError(error);
                }
            }
            throwIfAborted(signal);
            if (revision) {
                onProgress?.(100);
                const result = this.prepareResult({
                    ...revision,
                    userEdited: true,
                });
                return createResult(
                    title,
                    result,
                    true,
                    warnings,
                    revisionKey,
                    false,
                    sourceHash,
                    revisionProfile
                );
            }
        }
        const apiKey = String(this.getApiKey() || '').trim();
        let converted;
        try {
            converted = await this.conversion.convert({
                key: cacheKey,
                apiKey,
                fileName: item.attachmentFilename || `zotero-${itemID}.pdf`,
                fileData,
                cacheEnabled,
                forceRefresh,
                onProgress,
                onProgressiveFigures,
                signal,
            });
        }
        catch (error) {
            if (error?.message === 'A MinerU API Token is required') {
                throw new MinerUConfigurationError();
            }
            throw error;
        }
        warnings.push(...(converted.warnings || []));
        const result = this.prepareResult(converted.result);
        return createResult(
            title,
            result,
            converted.origin === 'cache',
            warnings,
            cacheKey,
            converted.origin === 'resumed',
            sourceHash,
            parserProfile
        );
    }

    #parserProfile() {
        const profile = this.getParserProfile();
        return typeof profile === 'string' && profile
            ? profile
            : MINERU_PARSER_PROFILE_ID;
    }

    #previousParserProfiles() {
        const profiles = this.getPreviousParserProfiles();
        return Array.isArray(profiles)
            ? profiles.filter(profile => typeof profile === 'string' && profile)
            : [];
    }

    #reportCacheError(error) {
        try {
            this.onCacheError(error);
        }
        catch {
            // Cache diagnostics must not make PDF conversion fail.
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
    sourceHash = null,
    parserProfile = MINERU_PARSER_PROFILE_ID
) {
    const extracted = {
        kind: 'markdown',
        provider: 'mineru',
        parserProfile,
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
