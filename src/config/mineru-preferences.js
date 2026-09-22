import { translateEnglish } from '../i18n/localization.js';
import {
    AI_MAX_REQUEST_TIMEOUT_MS,
} from './ai-preferences.js';
import {
    CONVERSION_PROVIDER_MINERU,
    CONVERSION_PROVIDER_MISTRAL,
    CONVERSION_PROVIDER_PREF,
    getConversionProvider,
    getMinerUApiKey,
    getMinerUCacheEnabled,
    getMinerUEndpoint,
    getMinerULocalApiBase,
    getMinerULocalApiKey,
    getMistralApiKey,
    MINERU_API_KEY_PREF,
    MINERU_CACHE_ENABLED_PREF,
    MINERU_ENDPOINT_LOCAL,
    MISTRAL_API_KEY_PREF,
    normalizeConversionProvider,
} from './conversion-preferences.js';

export const MINERU_PREFERENCE_PANE_ID = 'mktero-preferences';

export {
    CONVERSION_PROVIDER_MINERU,
    CONVERSION_PROVIDER_MISTRAL,
    CONVERSION_PROVIDER_PREF,
    getConversionProvider,
    getMinerUApiKey,
    getMinerUCacheEnabled,
    getMinerUEndpoint,
    getMinerULocalApiBase,
    getMinerULocalApiKey,
    getMistralApiKey,
    MINERU_API_KEY_PREF,
    MINERU_CACHE_ENABLED_PREF,
    MINERU_ENDPOINT_LOCAL,
    MISTRAL_API_KEY_PREF,
    normalizeConversionProvider,
};

export const PREFERENCE_CONTROL_LIMITS = Object.freeze({
    aiRequestTimeoutMs: AI_MAX_REQUEST_TIMEOUT_MS,
});

export function getZoteroLocale(zotero, services) {
    return String(
        zotero?.locale
        || services?.locale?.appLocaleAsBCP47
        || ''
    );
}

export function registerMinerUPreferencesPane({
    zotero,
    pluginID,
    rootURI,
    translate = translateEnglish,
}) {
    if (!zotero.PreferencePanes?.register) {
        throw new Error(translate('error.preferencesUnavailable'));
    }
    return zotero.PreferencePanes.register({
        pluginID,
        id: MINERU_PREFERENCE_PANE_ID,
        label: 'Mktero',
        image: `${rootURI}ui/icons/mktero.svg`,
        src: `${rootURI}ui/preferences.xhtml`,
        scripts: [`${rootURI}ui/preferences.js`],
        stylesheets: [`${rootURI}ui/preferences.css`],
        helpURL: 'https://mineru.net/apiManage/docs',
    });
}

export function openMinerUPreferences(zotero) {
    zotero.Utilities?.Internal?.openPreferences?.(MINERU_PREFERENCE_PANE_ID);
}
