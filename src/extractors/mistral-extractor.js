import { MISTRAL_PARSER_PROFILE_ID } from '../mistral/parser-profile.js';

export class MistralConfigurationError extends Error {
    constructor() {
        super('Configure a Mistral API key in the Mktero preferences');
        this.name = 'MistralConfigurationError';
        this.code = 'MISTRAL_API_KEY_REQUIRED';
    }
}

export class MistralDocumentExtractor {
    constructor({
        zotero,
        conversion,
        getApiKey,
        readFile,
        preparePDFIndex = null,
        createCacheKey = null,
        parserProfile = MISTRAL_PARSER_PROFILE_ID,
        readRevision = null,
        isCacheEnabled = () => false,
        onCacheError = error => zotero.logError?.(error),
        onPDFIndexError = error => zotero.logError?.(error),
    }) {
        if (!zotero) throw new TypeError('A Zotero runtime is required');
        if (!conversion?.convert) {
            throw new TypeError('A Mistral conversion module is required');
        }
        if (!getApiKey) throw new TypeError('A Mistral API key provider is required');
        if (!readFile) throw new TypeError('A file reader is required');
        if (typeof parserProfile !== 'string' || !parserProfile) {
            throw new TypeError('A Mistral parser profile is required');
        }
        this.zotero = zotero;
        this.conversion = conversion;
        this.getApiKey = getApiKey;
        this.readFile = readFile;
        this.preparePDFIndex = preparePDFIndex;
        this.createCacheKey = createCacheKey;
        this.parserProfile = parserProfile;
        this.readRevision = readRevision;
        this.isCacheEnabled = isCacheEnabled;
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
        const cacheEnabled = Boolean(this.isCacheEnabled());
        const warnings = [];
        let cacheKey = null;
        if (this.createCacheKey) {
            try {
                cacheKey = await this.createCacheKey(fileData, {
                    parserProfile: this.parserProfile,
                });
            }
            catch (error) {
                this.#reportCacheError(error);
                warnings.push('The local Markdown cache is unavailable.');
            }
        }

        if (!forceRefresh && cacheKey && typeof this.readRevision === 'function') {
            const revision = await this.readRevision({
                itemID,
                cacheKey,
                signal,
            });
            throwIfAborted(signal);
            if (revision) {
                onProgress?.(100);
                return createResult(
                    title,
                    {
                        ...revision,
                        userEdited: true,
                    },
                    true,
                    warnings,
                    cacheKey,
                    this.parserProfile,
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
                signal,
            });
        }
        catch (error) {
            if (error?.code === 'MISTRAL_API_KEY_REQUIRED'
                || error?.message === 'A Mistral API key is required') {
                throw new MistralConfigurationError();
            }
            throw error;
        }

        warnings.push(...(converted.warnings || []));
        const result = converted.result || {};
        warnings.push(...(result.warnings || []));
        return createResult(
            title,
            result,
            converted.origin === 'cache',
            warnings,
            cacheKey,
            this.parserProfile,
        );
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
    parserProfile = MISTRAL_PARSER_PROFILE_ID,
) {
    const extracted = {
        kind: 'markdown',
        provider: 'mistral',
        parserProfile,
        title,
        markdown: parsedResult.markdown,
        assets: parsedResult.assets || [],
        assetBasePath: parsedResult.assetBasePath || '',
        extractedPages: parsedResult.extractedPages,
        totalPages: parsedResult.totalPages,
        sourceMap: parsedResult.sourceMap,
        warnings,
        cacheHit,
        resumedTask: false,
    };
    if (cacheKey) extracted.cacheKey = cacheKey;
    if (parsedResult.userEdited) extracted.userEdited = true;
    if (Array.isArray(parsedResult.chromeRanges)) {
        extracted.chromeRanges = parsedResult.chromeRanges;
    }
    return extracted;
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    if (signal.reason) throw signal.reason;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
}
