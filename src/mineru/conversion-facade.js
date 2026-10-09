import { MINERU_ENDPOINT_LOCAL } from '../config/conversion-preferences.js';

// A local endpoint has no previous cloud profiles. readCached must use the
// same branch as convert so a local miss never runs cloud profile restore.
export function createMinerUConversionFacade({
    getEndpoint,
    cloud,
    local,
    getLocalApiKey,
    getLocalApiBase,
}) {
    if (typeof getEndpoint !== 'function') {
        throw new TypeError('A MinerU endpoint provider is required');
    }
    if (typeof cloud?.convert !== 'function' || typeof cloud?.readCached !== 'function') {
        throw new TypeError('A cloud MinerU conversion is required');
    }
    if (typeof local?.convert !== 'function' || typeof local?.readCached !== 'function') {
        throw new TypeError('A local MinerU conversion is required');
    }
    if (typeof getLocalApiKey !== 'function' || typeof getLocalApiBase !== 'function') {
        throw new TypeError('Local MinerU credential providers are required');
    }

    const isLocal = () => getEndpoint() === MINERU_ENDPOINT_LOCAL;
    return {
        convert(options) {
            if (!isLocal()) return cloud.convert(options);
            return local.convert({
                ...options,
                apiKey: getLocalApiKey(),
                apiBase: getLocalApiBase(),
            });
        },
        readCached(options) {
            if (!isLocal()) return cloud.readCached(options);
            return local.readCached(options);
        },
    };
}
