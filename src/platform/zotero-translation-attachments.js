import { AI_TARGET_LANGUAGES } from '../config/ai-preferences.js';

export const TRANSLATION_ATTACHMENT_SYNC_PREF = 'extensions.mktero.translationAttachmentSync';
const MAX_BYTES = 16 * 1024 * 1024;
const TITLE_PREFIX = 'Mktero Translation · ';
const MIME_TYPE = 'application/json';

export function createZoteroTranslationAttachments({ zotero, readFile, writeTemporaryFile }) {
    const writes = new Map();
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

    return {
        enabled,
        dispose() { disposed = true; },
        async read(itemID, identity, accept, { skipLanguages = [], signal } = {}) {
            const attachmentScope = await scope(itemID);
            if (!attachmentScope || signal?.aborted) return [];
            const languages = new Set(AI_TARGET_LANGUAGES.filter(language => !skipLanguages.includes(language)));
            const results = [];
            for (const { item, language } of await candidates(attachmentScope, identity, [...languages])) {
                if (!enabled() || signal?.aborted) break;
                if (!languages.has(language)) continue;
                try {
                    let path = await item.getFilePathAsync();
                    if (!path && enabled() && !signal?.aborted) {
                        await zotero.Sync?.Runner?.downloadFile?.(item);
                        path = await item.getFilePathAsync();
                    }
                    if (!path || !enabled() || signal?.aborted) continue;
                    const bytes = await readFile(path, MAX_BYTES + 1);
                    if (bytes.length > MAX_BYTES || !enabled() || signal?.aborted) continue;
                    const result = accept(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), language);
                    if (!result) continue;
                    results.push(result);
                    languages.delete(language);
                }
                catch { /* An unavailable copy must not interfere with local reading. */ }
            }
            return enabled() && !signal?.aborted ? results : [];
        },
        async publish(itemID, identity, record, { replace = false, signal } = {}) {
            const attachmentScope = await scope(itemID);
            if (!attachmentScope || !enabled()) return;
            const { pdf, predicate, uri } = attachmentScope;
            const library = zotero.Libraries.get(pdf.libraryID);
            if (!library.editable || !library.filesEditable) return;
            const language = record.targetLanguage;
            const key = filename(pdf, identity, language);
            const previous = writes.get(key);
            const operation = (previous || Promise.resolve()).catch(() => {}).then(async () => {
                if (!enabled() || signal?.aborted || pdf.deleted) return;
                const existing = await candidates(attachmentScope, identity, [language]);
                if (existing.length && !replace) return;
                const serialized = JSON.stringify(record);
                const data = new TextEncoder().encode(serialized);
                if (data.length > MAX_BYTES || !enabled()) return;
                if (existing.length) {
                    try {
                        const path = await existing[0].item.getFilePathAsync();
                        if (path) {
                            const bytes = await readFile(path, MAX_BYTES + 1);
                            if (new TextDecoder().decode(bytes) === serialized) return;
                        }
                    }
                    catch { /* A missing old copy must not prevent publishing the new one. */ }
                }
                const temporary = await writeTemporaryFile({ name: key, data });
                let created;
                try {
                    if (!enabled() || signal?.aborted || pdf.deleted) return;
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
