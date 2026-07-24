export const MINERU_API_KEY_PREF = 'extensions.mktero.mineruApiKey';
export const MINERU_PREFERENCE_PANE_ID = 'mktero-preferences';

export function getMinerUApiKey(zotero) {
    return String(zotero.Prefs.get(MINERU_API_KEY_PREF, true) || '').trim();
}

export function registerMinerUPreferencesPane({ zotero, pluginID, rootURI }) {
    if (!zotero.PreferencePanes?.register) {
        throw new Error('Zotero preference panes are unavailable');
    }
    return zotero.PreferencePanes.register({
        pluginID,
        id: MINERU_PREFERENCE_PANE_ID,
        label: 'Mktero',
        src: `${rootURI}ui/preferences.xhtml`,
        stylesheets: [`${rootURI}ui/preferences.css`],
        helpURL: 'https://mineru.net/apiManage/docs',
    });
}

export function openMinerUPreferences(zotero) {
    zotero.Utilities?.Internal?.openPreferences?.(MINERU_PREFERENCE_PANE_ID);
}
