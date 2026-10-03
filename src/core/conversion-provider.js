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
    constructor({ getProvider, providers } = {}) {
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
        this.getProvider = getProvider;
        this.providers = providers;
    }

    extract(itemID, options) {
        const configured = String(this.getProvider() || '').trim();
        const provider = SUPPORTED_PROVIDERS.has(configured)
            ? configured
            : MINERU_PROVIDER;
        return this.providers[provider].extract(itemID, options);
    }
}

export const CONVERSION_PROVIDER_IDS = Object.freeze({
    MINERU: MINERU_PROVIDER,
    MISTRAL: MISTRAL_PROVIDER,
    MKTERO: MKTERO_PROVIDER,
});
