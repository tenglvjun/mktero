import test from 'node:test';
import assert from 'node:assert/strict';
import { createZoteroTranslationAttachments, TRANSLATION_ATTACHMENT_SYNC_PREF } from '../src/platform/zotero-translation-attachments.js';

const identity = 'a'.repeat(64);
const record = { version: 1, identity, targetLanguage: 'zh-CN', blocks: [{ markdown: '译文' }] };
const newer = { ...record, blocks: [{ markdown: '新版译文' }] };
const accept = (value, language) => value.identity === identity && value.targetLanguage === language && value;

function createFixture() {
    let optedIn = true;
    let fileSync = true;
    let downloads = 0;
    let creates = 0;
    let libraryType = 'user';
    let failWrite = false;
    let failSave = false;
    let writes = 0;
    const syncState = {
        SYNC_STATE_TO_DOWNLOAD: 1,
        SYNC_STATE_IN_SYNC: 2,
        SYNC_STATE_FORCE_UPLOAD: 3,
        SYNC_STATE_FORCE_DOWNLOAD: 4,
        SYNC_STATE_IN_CONFLICT: 5,
    };
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
        Items: {
            getAsync: async id => pdfs.get(id),
            async trashTx(ids) {
                for (const item of attachments) {
                    if (ids.includes(item.id)) item.deleted = true;
                }
            },
        },
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
                id: creates,
                key: String(creates),
                libraryID,
                dateAdded: '2026-11-26',
                attachmentFilename: file,
                attachmentContentType: contentType,
                isStoredFileAttachment: () => true,
                getField: () => title,
                path: 'stored/' + creates,
                contents: files.get(file),
                attachmentSyncState: syncState.SYNC_STATE_IN_SYNC,
                getFilePathAsync: async () => item.path,
                addRelation(predicate, uri) { Object.assign(item, { predicate, uri }); },
                async saveTx() {
                    if (failSave) throw new Error('Could not save sync state');
                    if (!attachments.includes(item)) attachments.push(item);
                },
            };
            files.set(item.path, item.contents);
            return item;
        } },
        Sync: {
            Storage: { Local: syncState },
            Runner: { async downloadFile(item) {
                downloads++;
                item.path ||= 'stored/' + item.id;
                files.set(item.path, item.contents);
                item.attachmentSyncState = syncState.SYNC_STATE_IN_SYNC;
            } },
        },
    };
    const create = () => createZoteroTranslationAttachments({
        zotero,
        readFile: async filename => files.get(filename),
        writeStoredFile: async (path, data) => {
            if (failWrite) throw new Error('Could not replace file');
            writes++;
            files.set(path, data);
        },
        writeTemporaryFile: async ({ name, data }) => {
            files.set(name, data);
            return { path: name, cleanup: async () => {} };
        },
    });
    return {
        attachments, files, syncState, create,
        get creates() { return creates; },
        get downloads() { return downloads; },
        get writes() { return writes; },
        set optedIn(value) { optedIn = value; },
        set fileSync(value) { fileSync = value; },
        set libraryType(value) { libraryType = value; },
        set failWrite(value) { failWrite = value; },
        set failSave(value) { failSave = value; },
    };
}

test('stores and loads only the exact PDF translation in an opted-in personal library', async () => {
    const fixture = createFixture();
    const sender = fixture.create();
    const receiver = fixture.create();
    fixture.optedIn = false;
    await sender.publish(11, identity, record);
    assert.equal(fixture.creates, 0);
    fixture.optedIn = true;
    fixture.fileSync = false;
    await sender.publish(11, identity, record);
    assert.equal(fixture.creates, 0);
    fixture.fileSync = true;
    await Promise.all([sender.publish(11, identity, record), sender.publish(11, identity, record)]);
    assert.equal(fixture.creates, 1);
    fixture.attachments[0].path = null;
    assert.deepEqual(await receiver.read(12, identity, accept), []);
    assert.deepEqual(await receiver.read(11, 'b'.repeat(64), accept), []);
    assert.equal(fixture.downloads, 0);
    assert.deepEqual(await receiver.read(11, identity, accept), [record]);
    assert.equal(fixture.downloads, 1);
    fixture.libraryType = 'group';
    assert.deepEqual(await receiver.read(11, identity, accept), []);
    fixture.optedIn = false;
    assert.deepEqual(await receiver.read(11, identity, accept), []);
});

test('retranslation updates the stored file under the same key and queues it for upload', async () => {
    const fixture = createFixture();
    const store = fixture.create();
    const options = { replace: true, decode: accept };
    await store.publish(11, identity, record);
    const [item] = fixture.attachments;
    const originalPath = item.path;
    await store.publish(11, identity, newer);
    assert.deepEqual(await store.read(11, identity, accept), [record]);
    await store.publish(11, identity, newer, options);
    assert.equal(fixture.creates, 1);
    assert.equal(item.key, '1');
    assert.equal(item.path, originalPath);
    assert.equal(item.attachmentSyncState, 'to_upload');
    assert.deepEqual(await store.read(11, identity, accept), [newer]);
    await store.publish(11, identity, newer, options);
    assert.equal(fixture.writes, 1);
});

test('loads a pending remote update even when the old file is present', async () => {
    const fixture = createFixture();
    const store = fixture.create();
    await store.publish(11, identity, record);
    const [item] = fixture.attachments;
    item.contents = new TextEncoder().encode(JSON.stringify(newer));
    item.attachmentSyncState = fixture.syncState.SYNC_STATE_TO_DOWNLOAD;
    assert.deepEqual(await store.read(11, identity, accept), [newer]);
    assert.equal(fixture.downloads, 1);

    item.attachmentSyncState = fixture.syncState.SYNC_STATE_IN_CONFLICT;
    assert.deepEqual(await store.read(11, identity, accept), [newer]);
    await assert.rejects(store.publish(11, identity, record, { replace: true, decode: accept }), /sync conflict/);
    assert.equal(fixture.downloads, 1);
    assert.equal(fixture.writes, 0);
});

test('trashes only verified duplicates after a successful replacement and upload queue save', async () => {
    const fixture = createFixture();
    const store = fixture.create();
    const options = { replace: true, decode: accept };
    await store.publish(11, identity, record);
    const [older] = fixture.attachments.splice(0);
    await store.publish(11, identity, record);
    const [unverified] = fixture.attachments.splice(0);
    await store.publish(11, identity, record);
    const [current] = fixture.attachments;
    fixture.attachments.push(older, unverified);
    fixture.files.set(unverified.path, new TextEncoder().encode('{}'));
    await store.publish(11, identity, { ...record, targetLanguage: 'ja-JP' });
    await store.publish(12, identity, record);
    const unrelated = fixture.attachments.slice(3);

    fixture.failWrite = true;
    await assert.rejects(store.publish(11, identity, newer, options), /Could not replace file/);
    assert.deepEqual(await store.read(11, identity, accept, { skipLanguages: ['ja-JP'] }), [record]);
    assert.ok(!older.deleted);

    fixture.failWrite = false;
    fixture.failSave = true;
    await assert.rejects(store.publish(11, identity, newer, options), /Could not save sync state/);
    assert.deepEqual(await store.read(11, identity, accept, { skipLanguages: ['ja-JP'] }), [newer]);
    assert.ok(!older.deleted);

    fixture.failSave = false;
    await store.publish(11, identity, newer, options);
    assert.equal(current.attachmentSyncState, 'to_upload');
    assert.equal(current.key, '3');
    assert.equal(fixture.writes, 1);
    assert.ok(older.deleted);
    assert.ok(!current.deleted && !unverified.deleted);
    assert.ok(unrelated.every(item => !item.deleted));
});
