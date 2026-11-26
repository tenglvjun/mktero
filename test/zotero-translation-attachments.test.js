import test from 'node:test';
import assert from 'node:assert/strict';
import { createZoteroTranslationAttachments, TRANSLATION_ATTACHMENT_SYNC_PREF } from '../src/platform/zotero-translation-attachments.js';

test('stores and loads only the exact PDF translation in an opted-in personal library', async () => {
    let optedIn = false;
    let fileSync = true;
    let downloads = 0;
    let creates = 0;
    let libraryType = 'user';
    const files = new Map();
    const attachments = [];
    const pdfs = new Map([11, 12].map(id => [id, {
        id, key: 'PDF0000' + id, libraryID: 1, parentID: 10,
        isPDFAttachment: () => true,
    }]));
    const preferences = {
        get(key) {
            if (key === TRANSLATION_ATTACHMENT_SYNC_PREF) return optedIn;
            assert.equal(key, 'sync.storage.enabled');
            return fileSync;
        },
    };
    const zotero = {
        Prefs: preferences,
        Items: { getAsync: async id => pdfs.get(id) },
        Libraries: { get: () => ({ libraryType, editable: true, filesEditable: true }) },
        URI: { getItemURI: pdf => 'uri/' + pdf.key },
        Relations: {
            relatedItemPredicate: 'dc:relation',
            getByPredicateAndObject: async (_type, predicate, uri) => attachments
                .filter(item => item.predicate === predicate && item.uri === uri),
        },
        Attachments: { async importFromFile({ file, parentItemID, libraryID, title, contentType }) {
            creates++;
            assert.equal(parentItemID, 10);
            const item = {
                key: String(creates),
                libraryID,
                dateAdded: '2026-11-26',
                attachmentFilename: file,
                attachmentContentType: contentType,
                isStoredFileAttachment: () => true,
                getField: () => title,
                path: null,
                getFilePathAsync: async () => item.path,
                addRelation(predicate, uri) { Object.assign(item, { predicate, uri }); },
                async saveTx() { attachments.push(item); },
            };
            return item;
        } },
        Sync: { Runner: { async downloadFile(item) {
            downloads++;
            item.path = item.attachmentFilename;
        } } },
    };
    const create = () => createZoteroTranslationAttachments({
        zotero,
        readFile: async filename => files.get(filename),
        writeTemporaryFile: async ({ name, data }) => {
            files.set(name, data);
            return { path: name, cleanup: async () => {} };
        },
    });
    const sender = create();
    const receiver = create();
    const identity = 'a'.repeat(64);
    const record = { version: 1, identity, targetLanguage: 'zh-CN', blocks: [{ markdown: '译文' }] };
    const accept = (value, language) => value.targetLanguage === language && value;
    await sender.publish(11, identity, record);
    assert.equal(creates, 0);
    optedIn = true;
    fileSync = false;
    await sender.publish(11, identity, record);
    assert.equal(creates, 0);
    fileSync = true;
    await Promise.all([sender.publish(11, identity, record), sender.publish(11, identity, record)]);
    assert.equal(creates, 1);
    assert.deepEqual(await receiver.read(12, identity, accept), []);
    assert.deepEqual(await receiver.read(11, 'b'.repeat(64), accept), []);
    assert.equal(downloads, 0);
    assert.deepEqual(await receiver.read(11, identity, accept), [record]);
    assert.equal(downloads, 1);
    libraryType = 'group';
    assert.deepEqual(await receiver.read(11, identity, accept), []);
    optedIn = false;
    assert.deepEqual(await receiver.read(11, identity, accept), []);
});
