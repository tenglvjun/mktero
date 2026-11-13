export const CONVERSION_PROVIDER_MINERU = 'mineru';
export const CONVERSION_PROVIDER_MISTRAL = 'mistral';
export const CONVERSION_PROVIDER_MKTERO = 'mktero';
export const MINERU_ENDPOINT_CLOUD = 'cloud';
export const MINERU_ENDPOINT_LOCAL = 'local';
export const MINERU_CLOUD_MODEL_VLM = 'vlm';
export const MINERU_CLOUD_MODEL_PIPELINE = 'pipeline';
export const DEFAULT_MINERU_LOCAL_API_BASE = 'http://127.0.0.1:8000';

export const CONVERSION_PROVIDER_PREF =
    'extensions.mktero.conversionProvider';
export const MINERU_API_KEY_PREF = 'extensions.mktero.mineruApiKey';
export const MINERU_ENDPOINT_PREF = 'extensions.mktero.mineruEndpoint';
// Only the direct MinerU cloud request reads this. Hosted Mktero conversion
// picks its model on the server, and the local MinerU service has its own
// request profile, so neither may be affected by this preference.
export const MINERU_CLOUD_MODEL_VERSION_PREF =
    'extensions.mktero.mineruCloudModelVersion';
export const MINERU_LOCAL_API_BASE_PREF = 'extensions.mktero.mineruLocalApiBase';
export const MINERU_LOCAL_API_KEY_PREF = 'extensions.mktero.mineruLocalApiKey';
export const MISTRAL_API_KEY_PREF = 'extensions.mktero.mistralApiKey';
export const MINERU_CACHE_ENABLED_PREF = 'extensions.mktero.cacheEnabled';

const SUPPORTED_MINERU_ENDPOINTS = new Set([
    MINERU_ENDPOINT_CLOUD,
    MINERU_ENDPOINT_LOCAL,
]);

const SUPPORTED_MINERU_CLOUD_MODEL_VERSIONS = new Set([
    MINERU_CLOUD_MODEL_VLM,
    MINERU_CLOUD_MODEL_PIPELINE,
]);

const SUPPORTED_CONVERSION_PROVIDERS = new Set([
    CONVERSION_PROVIDER_MINERU,
    CONVERSION_PROVIDER_MISTRAL,
    CONVERSION_PROVIDER_MKTERO,
]);

export function normalizeConversionProvider(value) {
    const provider = String(value || '').trim();
    return SUPPORTED_CONVERSION_PROVIDERS.has(provider)
        ? provider
        : CONVERSION_PROVIDER_MKTERO;
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

// An unknown or empty stored value reads as vlm: the MinerU cloud default,
// and the identity every cache entry written before this choice existed uses.
export function normalizeMinerUCloudModelVersion(value) {
    const modelVersion = String(value || '').trim();
    return SUPPORTED_MINERU_CLOUD_MODEL_VERSIONS.has(modelVersion)
        ? modelVersion
        : MINERU_CLOUD_MODEL_VLM;
}

export function getMinerUCloudModelVersion(zotero) {
    return normalizeMinerUCloudModelVersion(
        zotero?.Prefs?.get?.(MINERU_CLOUD_MODEL_VERSION_PREF, true)
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
        // The cloud model is part of the requested parse, so a change to it
        // invalidates the same readiness a provider or endpoint change does.
        observePreference(zotero, MINERU_CLOUD_MODEL_VERSION_PREF, onChange),
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
