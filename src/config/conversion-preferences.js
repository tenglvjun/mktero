export const CONVERSION_PROVIDER_MINERU = 'mineru';
export const CONVERSION_PROVIDER_MISTRAL = 'mistral';
export const MINERU_ENDPOINT_CLOUD = 'cloud';
export const MINERU_ENDPOINT_LOCAL = 'local';
export const DEFAULT_MINERU_LOCAL_API_BASE = 'http://127.0.0.1:8000';

export const CONVERSION_PROVIDER_PREF =
    'extensions.mktero.conversionProvider';
export const MINERU_API_KEY_PREF = 'extensions.mktero.mineruApiKey';
export const MINERU_ENDPOINT_PREF = 'extensions.mktero.mineruEndpoint';
export const MINERU_LOCAL_API_BASE_PREF = 'extensions.mktero.mineruLocalApiBase';
export const MINERU_LOCAL_API_KEY_PREF = 'extensions.mktero.mineruLocalApiKey';
export const MISTRAL_API_KEY_PREF = 'extensions.mktero.mistralApiKey';
export const MINERU_CACHE_ENABLED_PREF = 'extensions.mktero.cacheEnabled';

const SUPPORTED_MINERU_ENDPOINTS = new Set([
    MINERU_ENDPOINT_CLOUD,
    MINERU_ENDPOINT_LOCAL,
]);

const SUPPORTED_CONVERSION_PROVIDERS = new Set([
    CONVERSION_PROVIDER_MINERU,
    CONVERSION_PROVIDER_MISTRAL,
]);

export function normalizeConversionProvider(value) {
    const provider = String(value || '').trim();
    return SUPPORTED_CONVERSION_PROVIDERS.has(provider)
        ? provider
        : CONVERSION_PROVIDER_MINERU;
}

export function getConversionProvider(zotero) {
    return normalizeConversionProvider(
        zotero?.Prefs?.get?.(CONVERSION_PROVIDER_PREF, true)
    );
}

export function normalizeMinerUEndpoint(value) {
    const endpoint = String(value || '').trim();
    return SUPPORTED_MINERU_ENDPOINTS.has(endpoint)
        ? endpoint
        : MINERU_ENDPOINT_CLOUD;
}

export function getMinerUEndpoint(zotero) {
    return normalizeMinerUEndpoint(
        zotero?.Prefs?.get?.(MINERU_ENDPOINT_PREF, true)
    );
}

export function getMinerUApiKey(zotero) {
    return readPreferenceString(zotero, MINERU_API_KEY_PREF);
}

export function getMinerULocalApiKey(zotero) {
    return readPreferenceString(zotero, MINERU_LOCAL_API_KEY_PREF);
}

export function getMinerULocalApiBase(zotero) {
    const value = readPreferenceString(zotero, MINERU_LOCAL_API_BASE_PREF);
    return value || DEFAULT_MINERU_LOCAL_API_BASE;
}

export function getMistralApiKey(zotero) {
    return readPreferenceString(zotero, MISTRAL_API_KEY_PREF);
}

export function getMinerUCacheEnabled(zotero) {
    return zotero?.Prefs?.get?.(MINERU_CACHE_ENABLED_PREF, true) !== false;
}

export function observeConversionProfile(zotero, onChange) {
    if (typeof onChange !== 'function') return () => {};
    const stops = [
        observePreference(zotero, CONVERSION_PROVIDER_PREF, onChange),
        observePreference(zotero, MINERU_ENDPOINT_PREF, onChange),
    ];
    return () => {
        for (const stop of stops) stop();
    };
}

function observePreference(zotero, pref, onChange) {
    if (typeof zotero?.Prefs?.registerObserver !== 'function') return () => {};
    const observer = zotero.Prefs.registerObserver(pref, onChange, true);
    return () => zotero.Prefs.unregisterObserver?.(observer);
}

function readPreferenceString(zotero, key) {
    return String(zotero?.Prefs?.get?.(key, true) || '').trim();
}
