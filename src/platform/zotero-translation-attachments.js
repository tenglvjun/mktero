import { AI_TARGET_LANGUAGES } from '../config/ai-preferences.js';

export const TRANSLATION_ATTACHMENT_SYNC_PREF = 'extensions.mktero.translationAttachmentSync';
const MAX_BYTES = 16 * 1024 * 1024;
const TITLE_PREFIX = 'Mktero Translation · ';
const MIME_TYPE = 'application/json';

export function createZoteroTranslationAttachments({
    zotero, readFile, writeTemporaryFile, writeStoredFile,
}) {
    const writes = new Map();
    const downloads = new Map();
    const pendingUploads = new Set();
    let disposed = false;
    const enabled = () => !disposed && zotero.Prefs?.get?.(TRANSLATION_ATTACHMENT_SYNC_PREF, true) === true
        && zotero.Prefs?.get?.('sync.storage.enabled') === true;

    async function scope(itemID) {
        if (!itemID || !enabled()) return null;
        const pdf = await zotero.Items.getAsync(itemID);
        if (!pdf?.isPDFAttachment?.() || pdf.deleted
            || zotero.Libraries.get(pdf.libraryID)?.libraryType !== 'user') return null;
        const predicate = zotero.Relations.relatedItemPredicate;
        const uri = zotero.URI.getItemURI(pdf);
        return predicate && uri ? { pdf, predicate, uri } : null;
    }

    async function candidates({ pdf, predicate, uri }, identity, languages) {
        if (!languages.length) return [];
        const names = new Map(languages.map(language => [
            filename(pdf, identity, language), language,
        ]));
        const items = await zotero.Relations.getByPredicateAndObject('item', predicate, uri);
        return items.filter(item => item.libraryID === pdf.libraryID && !item.deleted
            && item.isStoredFileAttachment?.()
            && item.attachmentContentType === MIME_TYPE
            && names.has(item.attachmentFilename)
            && item.getField('title') === TITLE_PREFIX + names.get(item.attachmentFilename))
            .sort((a, b) => b.dateAdded.localeCompare(a.dateAdded) || b.key.localeCompare(a.key))
            .map(item => ({ item, language: names.get(item.attachmentFilename) }));
    }

    function canWrite(libraryID) {
        const library = zotero.Libraries.get(libraryID);
        return enabled() && library?.editable && library.filesEditable;
    }

    function hasSyncState(item, name) {
        const state = zotero.Sync?.Storage?.Local?.['SYNC_STATE_' + name.toUpperCase()];
        return item.attachmentSyncState === name
            || (state !== undefined && item.attachmentSyncState === state);
    }

    function awaitingConflictResolution(item) {
        return ['in_conflict', 'force_upload', 'force_download'].some(state => hasSyncState(item, state));
    }

    function awaitingDownload(item) {
        return hasSyncState(item, 'to_download');
    }

    async function readCopy(item, language, decode, active) {
        if (!active() || item.deleted) return null;
        let path = await item.getFilePathAsync();
        if ((!path || awaitingDownload(item)) && active() && !item.deleted
            && !awaitingConflictResolution(item) && !hasSyncState(item, 'to_upload')
            && !pendingUploads.has(item.id)) {
            let request = downloads.get(item.id);
            if (!request && zotero.Sync?.Runner?.downloadFile) {
                request = zotero.Sync.Runner.downloadFile(item);
                downloads.set(item.id, request);
            }
            try {
                if (request) await request;
            }
            finally {
                if (downloads.get(item.id) === request) downloads.delete(item.id);
            }
            path = await item.getFilePathAsync();
        }
        if (!path || !active() || item.deleted || awaitingDownload(item)) return null;
        const bytes = await readFile(path, MAX_BYTES + 1);
        if (bytes.length > MAX_BYTES || !active() || item.deleted || awaitingDownload(item)) return null;
        const serialized = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const result = decode(JSON.parse(serialized), language);
        return result ? { path, serialized, result } : null;
    }

    async function queueUpload(item) {
        const previousState = item.attachmentSyncState;
        item.attachmentSyncState = 'to_upload';
        try {
            await item.saveTx({ skipAll: true });
            pendingUploads.delete(item.id);
        }
        catch (error) {
            if (hasSyncState(item, 'to_upload')) item.attachmentSyncState = previousState;
            throw error;
        }
    }

    async function updateCopy(existing, language, serialized, data, decode, active) {
        const [{ item }, ...duplicates] = existing;
        if (awaitingConflictResolution(item)) throw new Error('Zotero translation file has a sync conflict');
        const copy = await readCopy(item, language, decode, active);
        if (!active()) return;
        if (!copy || item.deleted || awaitingConflictResolution(item) || awaitingDownload(item)) {
            throw new Error('Existing Zotero translation file is unavailable');
        }
        if (copy.serialized !== serialized) {
            await writeStoredFile(copy.path, data);
            pendingUploads.add(item.id);
        }
        if (item.deleted || awaitingConflictResolution(item) || awaitingDownload(item)) {
            pendingUploads.delete(item.id);
            throw new Error('Zotero translation file changed during publication');
        }
        // The atomic replace may have succeeded before a previous save failed.
        if (pendingUploads.has(item.id)) await queueUpload(item);
        if (!active() || item.deleted || awaitingConflictResolution(item) || awaitingDownload(item)) return;
        const redundant = [];
        for (const duplicate of duplicates) {
            const old = duplicate.item;
            if (awaitingConflictResolution(old)) continue;
            try {
                if (await readCopy(old, language, decode, active)) redundant.push(old);
            }
            catch { /* Leave unreadable copies in the library. */ }
        }
        if (!active() || item.deleted || awaitingConflictResolution(item) || awaitingDownload(item)) return;
        const redundantIDs = redundant.filter(old => !old.deleted
            && !awaitingConflictResolution(old) && !awaitingDownload(old)).map(old => old.id);
        if (redundantIDs.length) await zotero.Items.trashTx(redundantIDs);
    }

    return {
        enabled,
        dispose() { disposed = true; },
        async read(itemID, identity, accept, { skipLanguages = [], signal } = {}) {
            const attachmentScope = await scope(itemID);
            if (!attachmentScope || signal?.aborted) return [];
            const active = () => enabled() && !signal?.aborted && !attachmentScope.pdf.deleted;
            const languages = new Set(AI_TARGET_LANGUAGES.filter(language => !skipLanguages.includes(language)));
            const results = [];
            for (const { item, language } of await candidates(attachmentScope, identity, [...languages])) {
                if (!active()) break;
                if (!languages.has(language)) continue;
                try {
                    const copy = await readCopy(item, language, accept, active);
                    if (!copy) continue;
                    results.push(copy.result);
                    languages.delete(language);
                }
                catch { /* An unavailable copy must not interfere with local reading. */ }
            }
            return active() ? results : [];
        },
        async publish(itemID, identity, record, { replace = false, decode, signal } = {}) {
            const attachmentScope = await scope(itemID);
            if (!attachmentScope) return;
            const { pdf, predicate, uri } = attachmentScope;
            const active = () => canWrite(pdf.libraryID) && !signal?.aborted && !pdf.deleted;
            if (!active()) return;
            const language = record.targetLanguage;
            const key = filename(pdf, identity, language);
            const previous = writes.get(key);
            const operation = (previous || Promise.resolve()).catch(() => {}).then(async () => {
                if (!active()) return;
                const existing = await candidates(attachmentScope, identity, [language]);
                if (!active() || existing.length && !replace) return;
                const serialized = JSON.stringify(record);
                const data = new TextEncoder().encode(serialized);
                if (data.length > MAX_BYTES) {
                    if (replace) throw new Error('Zotero translation file exceeds the size limit');
                    return;
                }
                if (existing.length) {
                    await updateCopy(existing, language, serialized, data, decode, active);
                    return;
                }
                const temporary = await writeTemporaryFile({ name: key, data });
                let created;
                try {
                    if (!active()) return;
                    created = await zotero.Attachments.importFromFile({
                        file: temporary.file || temporary.path,
                        libraryID: pdf.libraryID,
                        parentItemID: pdf.parentID || undefined,
                        title: TITLE_PREFIX + language,
                        contentType: MIME_TYPE,
                        saveOptions: { skipNotifier: true },
                    });
                    created.addRelation(predicate, uri);
                    await created.saveTx();
                }
                catch (error) {
                    await created?.eraseTx?.().catch(() => {});
                    throw error;
                }
                finally {
                    await temporary.cleanup();
                }
            });
            writes.set(key, operation);
            try { await operation; }
            finally { if (writes.get(key) === operation) writes.delete(key); }
        },
    };
}

function filename(pdf, identity, language) {
    return 'mktero-translation-' + pdf.key + '-' + identity + '-' + language + '.json';
}
