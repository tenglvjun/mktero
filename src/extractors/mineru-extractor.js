import { prepareMinerUResult } from '../mineru/mineru-result.js';

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
        createCacheKey = null,
        isCacheEnabled = () => false,
        onCacheError = error => zotero.logError?.(error),
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
        this.createCacheKey = createCacheKey;
        this.isCacheEnabled = isCacheEnabled;
        this.onCacheError = onCacheError;
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
        const title = item.parentItem?.getDisplayTitle?.()
            || item.getDisplayTitle?.()
            || 'Untitled PDF';
        const cacheEnabled = Boolean(this.isCacheEnabled());
        const warnings = [];
        let cacheKey = null;
        if (this.createCacheKey) {
            try {
                cacheKey = await this.createCacheKey(fileData);
            }
            catch (error) {
                this.#reportCacheError(error);
                warnings.push('The local Markdown cache is unavailable.');
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
            if (error?.message === 'A MinerU API Token is required') {
                throw new MinerUConfigurationError();
            }
            throw error;
        }
        warnings.push(...(converted.warnings || []));
        const result = prepareMinerUResult(converted.result);
        return createResult(
            title,
            result,
            converted.origin === 'cache',
            warnings,
            cacheKey,
            converted.origin === 'resumed'
        );
    }

    #reportCacheError(error) {
        try {
            this.onCacheError(error);
        }
        catch {
            // Cache diagnostics must not make PDF conversion fail.
        }
    }
}

function createResult(
    title,
    parsedResult,
    cacheHit,
    warnings = [],
    cacheKey = null,
    resumedTask = false
) {
    const extracted = {
        kind: 'markdown',
        title,
        markdown: parsedResult.markdown,
        assets: parsedResult.assets || [],
        assetBasePath: parsedResult.assetBasePath || '',
        extractedPages: parsedResult.extractedPages,
        totalPages: parsedResult.totalPages,
        sourceMap: parsedResult.sourceMap,
        warnings,
        cacheHit,
        resumedTask,
    };
    if (cacheKey) extracted.cacheKey = cacheKey;
    if (parsedResult.userEdited) extracted.userEdited = true;
    return extracted;
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    if (signal.reason) throw signal.reason;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
}
