import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCacheOwnershipStorage, createCacheLibrarySnapshot, createZoteroCacheLifecycle } from '../src/platform/zotero-cache-lifecycle.js';
import { ORPHAN_CACHE_GRACE_MS } from '../src/cache/cache-lifecycle.js';
import { createZoteroMarkdownCache, createMarkdownCacheKey, createMarkdownCacheKeyFromHash } from '../src/cache/markdown-cache.js';
import { createZoteroMinerUResultStore } from '../src/cache/mineru-result-store.js';
import { createZoteroPDFTextIndexCache } from '../src/cache/pdf-text-index-cache.js';
import { createZoteroMarkdownReadingPositionStore } from '../src/cache/markdown-reading-position-store.js';
import { createZoteroMarkdownAnnotationStore } from '../src/cache/markdown-annotation-store.js';
import { createZoteroMarkdownRevisionStore } from '../src/platform/zotero-markdown-revision-store.js';
import { createZoteroMinerUImportIndex } from '../src/cache/mineru-import-index.js';
import { createMarkdownReadinessController } from '../src/cache/markdown-readiness-controller.js';
import { createLLMCacheIdentity } from '../src/mineru/llm-cache-profile.js';
import { ownedCacheResources } from '../src/cache/cache-owned-resources.js';
import { sha256Hex } from '../src/core/sha256.js';

const DATA = Uint8Array.of(1, 2, 3);
const HASH = await sha256Hex(DATA);
const pathUtils = { join: path.join, parent: path.dirname, filename: path.basename };
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mktero-cache-lifecycle-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const io = {
        async exists(file) { try { await fs.access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } },
        async stat(file) { const s = await fs.lstat(file); return { type: s.isFile() ? 'regular' : 'directory', size: s.size, lastModified: s.mtimeMs }; },
        readUTF8: file => fs.readFile(file, 'utf8'),
        read: async file => new Uint8Array(await fs.readFile(file)),
        async writeUTF8(file, data, { tmpPath } = {}) { await fs.writeFile(tmpPath || file, data); if (tmpPath) await fs.rename(tmpPath, file); },
        async write(file, data, { tmpPath } = {}) { await fs.writeFile(tmpPath || file, data); if (tmpPath) await fs.rename(tmpPath, file); },
        makeDirectory: file => fs.mkdir(file, { recursive: true }),
        getChildren: async file => (await fs.readdir(file)).map(name => path.join(file, name)),
        remove: (file, { recursive = false, ignoreAbsent = false } = {}) => fs.rm(file, { recursive, force: ignoreAbsent }),
        move: (from, to) => fs.rename(from, to),
    };
    const items = [];
    const observers = new Map();
    const zotero = { Profile: { dir }, Libraries: { getAll: () => [{ libraryID: 1 }] },
        Items: { async getAll(libraryID, top, deleted) {
            assert.equal(top, false); assert.equal(deleted, true);
            return items.filter(item => item.libraryID === libraryID);
        } },
        Notifier: { registerObserver(observer, types, id) { observers.set(id, { observer, types }); return id; },
            unregisterObserver(id) { observers.delete(id); } },
        Promise: { delay: async () => {} },
    };
    return { dir, io, zotero, items, observers, options: { zotero, ioUtils: io, pathUtils } };
}

function record() {
    return { libraryID: 1, attachmentKey: 'PDF1', itemID: 1, sourceHash: HASH, sourceBytes: 3,
        artifacts: [{ store: 'markdown', key: 'b'.repeat(64) }], orphanedAt: null };
}

test('ownership is atomic, bounded, strict and preserved on corruption', async t => {
    const f = await fixture(t);
    const storage = createCacheOwnershipStorage(f.options);
    assert.deepEqual(await storage.read(), []);
    await storage.write([record()]);
    assert.deepEqual(await storage.read(), [record()]);
    const file = path.join(f.dir, 'mktero-cache-owners/v1/index.json');
    assert.equal(await f.io.exists(`${file}.tmp`), false);
    await fs.writeFile(file, '{broken');
    await assert.rejects(storage.read());
    assert.equal(await fs.readFile(file, 'utf8'), '{broken');
    await assert.rejects(storage.write([record(), record()]), /Duplicate/);
});

test('content-hash key helper preserves shipped keys and resource mapping covers all storage kinds', async () => {
    const profile = 'existing-profile';
    assert.equal(await createMarkdownCacheKey(DATA, { parserProfile: profile }),
        await createMarkdownCacheKeyFromHash(HASH, { parserProfile: profile }));
    const imported = await createLLMCacheIdentity({ fileData: DATA, snapshotHash: 'c'.repeat(64) });
    const artifacts = await ownedCacheResources(HASH, { pdfIndexProfile: 'test-pdf-profile', imports: [imported] });
    assert.deepEqual(new Set(artifacts.map(a => a.store)), new Set(['markdown', 'raw', 'revisions', 'pdfIndex', 'readingPosition']));
    assert.ok(artifacts.some(a => a.store === 'raw' && a.key === imported.rawKey));
    assert.ok(artifacts.some(a => a.store === 'markdown' && a.key === imported.cacheKey));
    assert.ok(artifacts.length < 256);
});

test('library scan includes trashed duplicate PDFs and never requests downloads', async t => {
    const f = await fixture(t);
    const file = path.join(f.dir, 'input.pdf');
    await fs.writeFile(file, DATA);
    f.items.push({ id: 9, libraryID: 1, key: 'UNOPENED', deleted: true,
        isPDFAttachment: () => true, getFilePathAsync: async () => file });
    const scan = createCacheLibrarySnapshot(f.options);
    const result = await scan({ hashes: true });
    assert.equal(result.complete, true);
    assert.ok(result.sources.has(HASH));
    assert.ok(result.owners.has('1:UNOPENED'));
    f.items[0].getFilePathAsync = async () => false;
    assert.equal((await scan({ hashes: true })).complete, false);
    assert.equal((await scan({ hashes: false })).complete, true);
});

test('unknown libraries, oversized PDFs and files changed while hashing cannot justify cleanup', async t => {
    const f = await fixture(t);
    const scan = createCacheLibrarySnapshot(f.options);
    f.zotero.Libraries.getAll = () => [];
    assert.equal((await scan({ hashes: true })).complete, false);
    f.zotero.Libraries.getAll = () => [{ libraryID: 1 }];
    f.items.push({ id: 1, libraryID: 1, key: 'PDF1', isPDFAttachment: () => true, getFilePathAsync: async () => 'mock' });
    f.io.stat = async () => ({ type: 'regular', size: 512 * 1024 * 1024, lastModified: 1 });
    f.io.read = () => assert.fail('oversized PDF must not be read');
    assert.equal((await scan({ hashes: true })).complete, false);
    let modified = 0;
    f.io.stat = async () => ({ type: 'regular', size: 3, lastModified: ++modified });
    f.io.read = async () => DATA;
    assert.equal((await scan({ hashes: true })).complete, false);
});

test('targeted deletion preserves other entries, rejects paths, and notifies only after success', async t => {
    const f = await fixture(t);
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    const markdown = createZoteroMarkdownCache(f.options);
    const events = [];
    await markdown.put(a, { markdown: 'First', assets: [] });
    await markdown.put(b, { markdown: 'Second', assets: [] });
    markdown.setStoreChangeListener(event => events.push(event));
    await markdown.delete(a);
    await tick();
    assert.equal(await markdown.get(a), null);
    assert.equal((await markdown.get(b)).markdown, 'Second');
    assert.deepEqual(events, [{ type: 'removed', cacheKeys: [a] }]);
    assert.throws(() => markdown.delete('../escape'));
    const remove = f.io.remove;
    f.io.remove = async () => { throw new Error('permission denied'); };
    await assert.rejects(markdown.delete(b), /permission/);
    assert.equal(events.length, 1);
    f.io.remove = remove;
    await markdown.delete(b);
    await markdown.delete(b);

    const position = createZoteroMarkdownReadingPositionStore(f.options);
    await position.save(a, { cacheKey: b, anchor: { offset: 4 } });
    await position.save(b, { cacheKey: b, anchor: { offset: 8 } });
    await position.delete(a);
    assert.equal(await position.load(a, b), null);
    assert.equal((await position.load(b, b)).anchor.offset, 8);

    const pdf = createZoteroPDFTextIndexCache(f.options);
    const pdfRoot = path.join(f.dir, 'mktero-pdf-index/v1/entries');
    await fs.mkdir(path.join(pdfRoot, a), { recursive: true });
    await fs.mkdir(path.join(pdfRoot, b), { recursive: true });
    await pdf.delete(a);
    assert.equal(await f.io.exists(path.join(pdfRoot, a)), false);
    assert.equal(await f.io.exists(path.join(pdfRoot, b)), true);
    assert.throws(() => pdf.delete('../escape'));
});

test('annotation cleanup removes only exact item files and their corrupt backups', async t => {
    const f = await fixture(t);
    const store = createZoteroMarkdownAnnotationStore(f.options);
    await store.put(1, []);
    await store.put(10, []);
    const root = path.join(f.dir, 'mktero-annotations/v1');
    for (const name of ['item-1.corrupt-123.json', 'item-1.corrupt-123-2.json', 'item-10.corrupt-123.json', 'keep.txt']) {
        await fs.writeFile(path.join(root, name), 'keep');
    }
    await store.delete(1);
    assert.deepEqual((await fs.readdir(root)).sort(), ['item-10.corrupt-123.json', 'item-10.json', 'keep.txt']);
    await store.delete(1);
    assert.throws(() => store.delete('../10'));
});

test('per-attachment import and readiness cleanup retains other attachments sharing the cache', async t => {
    const f = await fixture(t);
    const index = createZoteroMinerUImportIndex(f.options);
    const imported = await createLLMCacheIdentity({ fileData: DATA, snapshotHash: 'c'.repeat(64) });
    const selection = { ...imported, libraryID: 1, attachmentKey: 'PDF1', importedAt: 100, binding: 'user-confirmed' };
    await index.publish(selection);
    await index.publish({ ...selection, attachmentKey: 'PDF2' });
    assert.equal(await index.forgetAttachment({ libraryID: 1, attachmentKey: 'PDF1' }), true);
    assert.equal((await index.load()).length, 1);
    assert.equal((await index.load())[0].attachmentKey, 'PDF2');
    let records = [];
    const readiness = createMarkdownReadinessController({ store: {
        load: async () => records, save: async value => { records = value; },
    } });
    await readiness.remember({ libraryID: 1, itemKey: 'PARENT1', attachmentKey: 'PDF1',
        cacheKey: imported.cacheKey, parserProfile: imported.parserProfile, expiresAt: null });
    await readiness.remember({ libraryID: 1, itemKey: 'PARENT2', attachmentKey: 'PDF2',
        cacheKey: imported.cacheKey, parserProfile: imported.parserProfile, expiresAt: null });
    await readiness.forgetAttachment({ libraryID: 1, attachmentKey: 'PDF1' });
    assert.equal(records.length, 1);
    assert.equal(readiness.isReady({ libraryID: 1, key: 'PDF2' }, imported.parserProfile), true);
});

test('runtime registration, notifications, hourly retry and shutdown clean actual files without touching PDFs', async t => {
    const f = await fixture(t);
    const stores = { markdown: createZoteroMarkdownCache(f.options), raw: createZoteroMinerUResultStore(f.options),
        revisions: createZoteroMarkdownRevisionStore(f.options), pdfIndex: createZoteroPDFTextIndexCache(f.options),
        readingPosition: createZoteroMarkdownReadingPositionStore(f.options) };
    const annotations = createZoteroMarkdownAnnotationStore(f.options);
    const groups = createZoteroMarkdownAnnotationStore({ ...f.options, directory: 'groups-v1' });
    const importIndex = createZoteroMinerUImportIndex(f.options);
    const timers = new Map();
    const errors = [];
    let timestamp = 100;
    let serial = 0;
    const adapter = createZoteroCacheLifecycle({ ...f.options, pdfIndexProfile: 'test-profile', stores, annotations, groups,
        importIndex, readiness: { forgetAttachment: async () => {} }, isBusy: () => false, now: () => timestamp,
        timers: { setTimer(callback, delay) { timers.set(++serial, { callback, delay }); return serial; }, clearTimer: id => timers.delete(id) },
        onError: error => errors.push(error),
    });
    t.after(() => adapter.dispose());
    const item = { id: 1, libraryID: 1, key: 'PDF1' };
    await adapter.rememberPDF(item, DATA);
    const key = await createMarkdownCacheKey(DATA);
    await stores.markdown.put(key, { markdown: 'First', assets: [] });
    await annotations.put(1, []);
    await groups.put(1, []);
    await stores.readingPosition.save(HASH, { cacheKey: key, anchor: { offset: 1 } });
    adapter.start();
    adapter.start();
    assert.equal(f.observers.size, 1);
    assert.equal(timers.size, 1);
    const notification = f.observers.get('mktero-cache-ownership');
    notification.observer.notify('delete', 'item', [1], {});
    assert.equal(timers.size, 1);
    const run = async () => {
        const [id, timer] = timers.entries().next().value;
        timers.delete(id);
        await timer.callback();
    };
    await run();
    const ownership = createCacheOwnershipStorage(f.options);
    assert.equal((await ownership.read())[0].orphanedAt, 100);
    timestamp += ORPHAN_CACHE_GRACE_MS;
    const pdf = path.join(f.dir, 'unrelated.pdf');
    await fs.writeFile(pdf, DATA);
    await run();
    assert.equal(await stores.markdown.get(key), null);
    assert.equal(await f.io.exists(path.join(f.dir, 'mktero-annotations/v1/item-1.json')), false);
    assert.equal(await stores.readingPosition.load(HASH, key), null);
    assert.deepEqual(await ownership.read(), []);
    assert.deepEqual(await fs.readFile(pdf), Buffer.from(DATA));
    assert.deepEqual(errors, []);
    adapter.resume();
    assert.equal(timers.size, 1);
    await adapter.dispose();
    assert.equal(timers.size, 0);
    assert.equal(f.observers.size, 0);
});
