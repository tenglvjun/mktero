export const OBSIDIAN_VAULT_PATH_PREF = 'extensions.mktero.obsidianVaultPath';

export function getObsidianVaultPath(zotero) {
    const value = zotero?.Prefs?.get?.(OBSIDIAN_VAULT_PATH_PREF, true);
    return typeof value === 'string' ? value.trim() : '';
}

export function setObsidianVaultPath(zotero, value) {
    const path = String(value || '').trim();
    zotero?.Prefs?.set?.(OBSIDIAN_VAULT_PATH_PREF, path, true);
    return path;
}
