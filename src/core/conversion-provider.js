const MINERU_PROVIDER = 'mineru';
const MISTRAL_PROVIDER = 'mistral';
const MKTERO_PROVIDER = 'mktero';
const SUPPORTED_PROVIDERS = new Set([
    MINERU_PROVIDER,
    MISTRAL_PROVIDER,
    MKTERO_PROVIDER,
]);

/**
 * Selects the configured document extractor for each new conversion.
 *
 * Extractors are deliberately kept behind this tiny adapter so the document
 * service and its lifecycle remain independent of any provider implementation.
 */
export class ConversionProviderRouter {
    constructor({ getProvider, providers, imported = null } = {}) {
        if (typeof getProvider !== 'function') {
            throw new TypeError('A conversion provider getter is required');
        }
        if (!providers || typeof providers !== 'object') {
            throw new TypeError('Conversion provider extractors are required');
        }
        for (const provider of SUPPORTED_PROVIDERS) {
            if (typeof providers[provider]?.extract !== 'function') {
                throw new TypeError(
                    `A ${provider} document extractor is required`
                );
            }
        }
        for (const provider of SUPPORTED_PROVIDERS) {
            if (typeof providers[provider]?.readCached !== 'function') {
                throw new TypeError(
                    `A ${provider} document extractor is required`
                );
            }
        }
        this.getProvider = getProvider;
        this.providers = providers;
        this.imported = imported;
    }

    async extract(itemID, options) {
        if (options?.forceRefresh) {
            const selection = await this.imported?.lookup?.(itemID, options);
            return this.#readProvider('extract', itemID, options, selection);
        }
        const { result, selection } = await this.#readImported('extract', itemID, options);
        if (result) return result;
        if (options?.localOnly) {
            throw Object.assign(new Error('The selected local import is unavailable'), {
                code: 'LLM_CACHE_UNAVAILABLE',
            });
        }
        return this.#readProvider('extract', itemID, options, selection);
    }

    async readCached(itemID, options) {
        const { result, selection } = await this.#readImported('readCached', itemID, options);
        if (result) return result;
        if (options?.localOnly) return null;
        return this.#readProvider('readCached', itemID, options, selection);
    }

    async #readImported(method, itemID, options) {
        try {
            return { result: await this.imported?.[method](itemID, options), selection: null };
        }
        catch (error) {
            throwIfAborted(options?.signal);
            if (options?.localOnly || error?.name === 'AbortError'
                || error?.code !== 'LLM_CACHE_IMPORT_UNAVAILABLE'
                || error.reason !== 'content-missing' || !error.selection) {
                throw error;
            }
            return { result: null, selection: error.selection };
        }
    }

    async #readProvider(method, itemID, options, selection) {
        throwIfAborted(options?.signal);
        const result = await this.#extractor()[method](itemID, options);
        throwIfAborted(options?.signal);
        if (selection && isUsableMarkdown(result)) {
            // The record came from the failed read. Conditional removal preserves
            // any import published while the provider was opening this document.
            await this.imported.forgetSelection(selection, options);
        }
        return result;
    }

    #extractor() {
        const configured = String(this.getProvider() || '').trim();
        const provider = SUPPORTED_PROVIDERS.has(configured)
            ? configured
            : MKTERO_PROVIDER;
        return this.providers[provider];
    }
}

function isUsableMarkdown(result) {
    return result?.kind === 'markdown' && typeof result.markdown === 'string'
        && (result.markdown.trim().length > 0 || result.userEdited === true);
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    if (signal.reason) throw signal.reason;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
}

export const CONVERSION_PROVIDER_IDS = Object.freeze({
    MINERU: MINERU_PROVIDER,
    MISTRAL: MISTRAL_PROVIDER,
    MKTERO: MKTERO_PROVIDER,
});
