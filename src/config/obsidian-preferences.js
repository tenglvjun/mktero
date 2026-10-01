import { normalizeObsidianSubdirectory } from '../markdown/obsidian-note.js';

export const OBSIDIAN_VAULT_PATH_PREF = 'extensions.mktero.obsidianVaultPath';
export const OBSIDIAN_SUBDIRECTORY_PREF
    = 'extensions.mktero.obsidianSubdirectory';

export function getObsidianVaultPath(zotero) {
    const value = zotero?.Prefs?.get?.(OBSIDIAN_VAULT_PATH_PREF, true);
    return typeof value === 'string' ? value.trim() : '';
}

export function setObsidianVaultPath(zotero, value) {
    const path = String(value || '').trim();
    zotero?.Prefs?.set?.(OBSIDIAN_VAULT_PATH_PREF, path, true);
    return path;
}

export function getObsidianSubdirectory(zotero) {
    try {
        return normalizeObsidianSubdirectory(
            zotero?.Prefs?.get?.(OBSIDIAN_SUBDIRECTORY_PREF, true)
        );
    }
    catch {
        return normalizeObsidianSubdirectory('');
    }
}

export function setObsidianSubdirectory(zotero, value) {
    let folder;
    try {
        folder = normalizeObsidianSubdirectory(value);
    }
    catch {
        folder = normalizeObsidianSubdirectory('');
    }
    zotero?.Prefs?.set?.(OBSIDIAN_SUBDIRECTORY_PREF, folder, true);
    return folder;
}
