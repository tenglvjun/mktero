import { normalizeLanguagePreference } from '../i18n/localization.js';

export const MKTERO_LANGUAGE_PREF = 'extensions.mktero.language';
export const MINERU_API_KEY_PREF = 'extensions.mktero.mineruApiKey';
export const MINERU_CACHE_ENABLED_PREF = 'extensions.mktero.cacheEnabled';
export const MINERU_PREFERENCE_PANE_ID = 'mktero-preferences';

export function getMkteroLanguagePreference(zotero) {
    return normalizeLanguagePreference(
        zotero.Prefs.get(MKTERO_LANGUAGE_PREF, true)
    );
}

export function setMkteroLanguagePreference(zotero, value) {
    const preference = normalizeLanguagePreference(value);
    zotero.Prefs.set(MKTERO_LANGUAGE_PREF, preference, true);
    return preference;
}

export function getZoteroLocale(zotero, services) {
    return String(
        zotero?.locale
        || services?.locale?.appLocaleAsBCP47
        || ''
    );
}

export function observeMkteroLanguagePreference(zotero, listener) {
    if (!zotero.Prefs?.registerObserver) return () => {};
    const observerID = zotero.Prefs.registerObserver(
        MKTERO_LANGUAGE_PREF,
        listener,
        true
    );
    let active = true;
    return () => {
        if (!active) return;
        active = false;
        if (observerID !== undefined && observerID !== null) {
            zotero.Prefs.unregisterObserver?.(observerID);
        }
    };
}

export function getMinerUApiKey(zotero) {
    return String(zotero.Prefs.get(MINERU_API_KEY_PREF, true) || '').trim();
}

export function getMinerUCacheEnabled(zotero) {
    return zotero.Prefs.get(MINERU_CACHE_ENABLED_PREF, true) !== false;
}

export function registerMinerUPreferencesPane({
    zotero,
    pluginID,
    rootURI,
    translate,
}) {
    if (!zotero.PreferencePanes?.register) {
        throw new Error(translate?.('error.preferencesUnavailable')
            || 'Zotero preference panes are unavailable');
    }
    return zotero.PreferencePanes.register({
        pluginID,
        id: MINERU_PREFERENCE_PANE_ID,
        label: 'Mktero',
        src: `${rootURI}ui/preferences.xhtml`,
        scripts: [`${rootURI}ui/preferences.js`],
        stylesheets: [`${rootURI}ui/preferences.css`],
        helpURL: 'https://mineru.net/apiManage/docs',
    });
}

export function openMinerUPreferences(zotero) {
    zotero.Utilities?.Internal?.openPreferences?.(MINERU_PREFERENCE_PANE_ID);
}
