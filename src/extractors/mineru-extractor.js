import { prepareMinerUResult } from '../mineru/document/prepare.js';
import { MINERU_PARSER_PROFILE_ID, MINERU_PREVIOUS_PARSER_PROFILE_IDS } from '../mineru/parser-profile.js';
import { LEGACY_FIGURE_PROFILES } from '../figures/legacy-figure-profiles.js';

const SELECTION = Symbol('mineru-conversion-selection');

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
        onPDFRead = null,
        createCacheKey = null,
        createSourceHash = null,
        getParserProfile = () => MINERU_PARSER_PROFILE_ID,
        getConversionOptions = () => ({}),
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
        this.onPDFRead = onPDFRead;
        this.preparePDFIndex = preparePDFIndex;
        this.createCacheKey = createCacheKey;
        this.createSourceHash = createSourceHash;
        this.getParserProfile = getParserProfile;
        this.getConversionOptions = getConversionOptions;
        this.getPreviousParserProfiles = getPreviousParserProfiles;
        this.readRevision = readRevision;
        this.isCacheEnabled = isCacheEnabled;
        this.prepareResult = prepareResult;
        this.onCacheError = onCacheError;
        this.onPDFIndexError = onPDFIndexError;
    }

    captureOptions(options = {}) {
        return { ...options, [SELECTION]: options[SELECTION] || this.#captureSelection() };
    }

    async extract(itemID, options = {}) {
        const { onProgress, onProgressiveFigures = null, signal, forceRefresh = false } = options;
        const selection = options[SELECTION] || this.#captureSelection();
        const opened = await this.#openPDF(itemID, signal);
        this.#preparePDFIndex(itemID, opened.fileData, signal);
        const prepared = await this.#prepareCachedRead(opened, {
            itemID,
            signal,
            forceRefresh,
            selection,
        });
        if (prepared.revision) {
            onProgress?.(100);
            return this.#revisionResult(opened, prepared);
        }
        const apiKey = prepared.conversionOptions.apiKey;
        let converted;
        try {
            converted = await this.conversion.convert({
                ...prepared.conversionOptions,
                key: prepared.cacheKey,
                apiKey,
                fileName: opened.item.attachmentFilename || `zotero-${itemID}.pdf`,
                fileData: opened.fileData,
                cacheEnabled: prepared.cacheEnabled,
                forceRefresh,
                onProgress,
                onProgressiveFigures: typeof onProgressiveFigures === 'function'
                    ? event => onProgressiveFigures({ ...event, parserProfile: prepared.parserProfile })
                    : null,
                signal,
            });
        }
        catch (error) {
            if (error?.message === 'A MinerU API Token is required') {
                throw new MinerUConfigurationError();
            }
            throw error;
        }
        prepared.warnings.push(...(converted.warnings || []));
        const result = this.prepareResult(converted.result, prepared.conversionOptions);
        return createResult(
            opened.title,
            result,
            converted.origin === 'cache',
            prepared.warnings,
            prepared.cacheKey,
            converted.origin === 'resumed',
            prepared.sourceHash,
            prepared.parserProfile
        );
    }

    async readCached(itemID, options = {}) {
        const { signal, onProgress } = options;
        const selection = options[SELECTION] || this.#captureSelection();
        const opened = await this.#openPDF(itemID, signal);
        const prepared = await this.#prepareCachedRead(opened, {
            itemID,
            signal,
            forceRefresh: false,
            selection,
        });
        if (prepared.revision) {
            onProgress?.(100);
            return this.#revisionResult(opened, prepared);
        }
        const converted = await this.conversion.readCached({
            ...prepared.conversionOptions,
            key: prepared.cacheKey,
            fileData: opened.fileData,
            cacheEnabled: prepared.cacheEnabled,
            signal,
            onProgress,
        });
        if (!converted) return null;
        onProgress?.(100);
        prepared.warnings.push(...(converted.warnings || []));
        const result = this.prepareResult(converted.result, prepared.conversionOptions);
        return createResult(
            opened.title,
            result,
            true,
            prepared.warnings,
            prepared.cacheKey,
            false,
            prepared.sourceHash,
            prepared.parserProfile
        );
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
        await this.onPDFRead?.(item, fileData);
        throwIfAborted(signal);
        const title = item.parentItem?.getDisplayTitle?.()
            || item.getDisplayTitle?.()
            || 'Untitled PDF';
        return { item, fileData, title };
    }

    async #prepareCachedRead({ fileData, title }, { itemID, signal, forceRefresh, selection }) {
        const cacheEnabled = Boolean(this.isCacheEnabled());
        const warnings = [];
        const { parserProfile, previousParserProfiles, conversionOptions } = selection;
        let cacheKey = null;
        if (this.createCacheKey) {
            try {
                cacheKey = await this.createCacheKey(fileData, { parserProfile });
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
        const revision = await this.#findRevision({
            itemID,
            cacheKey,
            fileData,
            signal,
            forceRefresh,
            parserProfile,
            previousParserProfiles,
        });
        return {
            title,
            conversionOptions,
            cacheEnabled,
            warnings,
            parserProfile,
            cacheKey,
            sourceHash,
            revision,
        };
    }

    async #findRevision({
        itemID,
        cacheKey,
        fileData,
        signal,
        forceRefresh,
        parserProfile,
        previousParserProfiles,
    }) {
        if (forceRefresh || !cacheKey || typeof this.readRevision !== 'function') return null;
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
                for (const previousProfile of previousParserProfiles) {
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
        if (!revision) return null;
        return {
            snapshot: revision,
            cacheKey: revisionKey,
            parserProfile: revisionProfile,
        };
    }

    #revisionResult(opened, prepared) {
        const result = this.prepareResult({
            ...prepared.revision.snapshot,
            userEdited: true,
        }, prepared.conversionOptions);
        return createResult(
            opened.title,
            result,
            true,
            prepared.warnings,
            prepared.revision.cacheKey,
            false,
            prepared.sourceHash,
            prepared.revision.parserProfile
        );
    }

    #parserProfile() {
        const profile = this.getParserProfile();
        return typeof profile === 'string' && profile
            ? profile
            : MINERU_PARSER_PROFILE_ID;
    }

    // Capture before the first await: changing preferences while a PDF is
    // loading cannot pair one model's request with another model's cache key.
    #captureSelection() {
        const parserProfile = this.#parserProfile();
        return {
            parserProfile,
            previousParserProfiles: this.#previousParserProfiles(parserProfile),
            conversionOptions: Object.freeze({
                ...this.getConversionOptions(),
                apiKey: String(this.getApiKey() || '').trim(),
            }),
        };
    }

    #previousParserProfiles(parserProfile) {
        const profiles = this.getPreviousParserProfiles(parserProfile);
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
    if (typeof parsedResult.documentStructure === 'string') {
        extracted.documentStructure = parsedResult.documentStructure;
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
