import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCacheOwnershipStorage, createCacheLibrarySnapshot, createZoteroCacheLifecycle,
    CACHE_DELETE_DELAY_MS, CACHE_STARTUP_DELAY_MS, CACHE_SWEEP_INTERVAL_MS } from '../src/platform/zotero-cache-lifecycle.js';
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

async function runtimeFixture(t, { isBusy = () => false } = {}) {
    const f = await fixture(t);
    const stores = { markdown: createZoteroMarkdownCache(f.options), raw: createZoteroMinerUResultStore(f.options),
        revisions: createZoteroMarkdownRevisionStore(f.options), pdfIndex: createZoteroPDFTextIndexCache(f.options),
        readingPosition: createZoteroMarkdownReadingPositionStore(f.options) };
    const annotations = createZoteroMarkdownAnnotationStore(f.options);
    const groups = createZoteroMarkdownAnnotationStore({ ...f.options, directory: 'groups-v1' });
    const importIndex = createZoteroMinerUImportIndex(f.options);
    const timers = new Map();
    const errors = [];
    const summaries = [];
    let timestamp = 100;
    let serial = 0;
    const adapter = createZoteroCacheLifecycle({ ...f.options, pdfIndexProfile: 'test-profile', stores, annotations, groups,
        importIndex, readiness: { forgetAttachment: async () => {} }, isBusy, now: () => timestamp,
        timers: { setTimer(callback, delay) { timers.set(++serial, { callback, delay, at: timestamp + delay }); return serial; },
            clearTimer: id => timers.delete(id) },
        onError: error => errors.push(error), onSummary: summary => summaries.push(summary),
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
    const notify = (event = 'delete', type = 'item', ids = [1]) => (
        f.observers.get('mktero-cache-ownership').observer.notify(event, type, ids, {})
    );
    const run = async () => {
        const [id, timer] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        timers.delete(id);
        timestamp = timer.at;
        await timer.callback();
    };
    return { ...f, stores, annotations, groups, importIndex, adapter, timers, errors, summaries, item, key, notify, run,
        ownership: createCacheOwnershipStorage(f.options), now: () => timestamp,
        nextDelay: () => Math.min(...[...timers.values()].map(timer => timer.at - timestamp)) };
}

test('delete events coalesce for five seconds and clean real files in the first check', async t => {
    const f = await runtimeFixture(t);
    f.adapter.start();
    assert.equal(f.observers.size, 1);
    assert.equal(f.nextDelay(), CACHE_STARTUP_DELAY_MS);
    f.notify();
    f.notify();
    assert.equal(f.timers.size, 1);
    assert.equal(f.nextDelay(), CACHE_DELETE_DELAY_MS);
    const pdf = path.join(f.dir, 'unrelated.pdf');
    await fs.writeFile(pdf, DATA);
    await f.run();
    assert.equal(await f.stores.markdown.get(f.key), null);
    assert.equal(await f.io.exists(path.join(f.dir, 'mktero-annotations/v1/item-1.json')), false);
    assert.equal(await f.io.exists(path.join(f.dir, 'mktero-annotations/groups-v1/item-1.json')), false);
    assert.equal(await f.stores.readingPosition.load(HASH, f.key), null);
    assert.deepEqual(await f.ownership.read(), []);
    assert.deepEqual(await fs.readFile(pdf), Buffer.from(DATA));
    assert.equal(f.summaries[0].removed, 1);
    assert.deepEqual(f.errors, []);
    await f.adapter.dispose();
    assert.equal(f.timers.size, 0);
    assert.equal(f.observers.size, 0);
});

test('startup reconciles missed deletions and old future-dated tombstones without waiting', async t => {
    const f = await runtimeFixture(t);
    const records = await f.ownership.read();
    records[0].orphanedAt = Date.now() + 90 * 86400_000;
    await f.ownership.write(records);
    await f.run();
    assert.equal(f.now(), 100 + CACHE_STARTUP_DELAY_MS);
    assert.deepEqual(await f.ownership.read(), []);
    assert.equal(await f.stores.markdown.get(f.key), null);
    assert.equal(f.nextDelay(), CACHE_SWEEP_INTERVAL_MS);
});

test('hourly fallback catches deletion when the notification was missed', async t => {
    const f = await runtimeFixture(t);
    f.items.push({ ...f.item, isPDFAttachment: () => true });
    await f.run();
    assert.equal((await f.ownership.read())[0].orphanedAt, null);
    f.items.length = 0;
    assert.equal(f.nextDelay(), CACHE_SWEEP_INTERVAL_MS);
    await f.run();
    assert.equal(await f.stores.markdown.get(f.key), null);
});

test('trash, collection removal and restoration never delete a live attachment', async t => {
    const f = await runtimeFixture(t);
    f.items.push({ ...f.item, deleted: true, isPDFAttachment: () => true });
    f.notify('trash');
    f.notify('remove', 'collection-item');
    assert.equal(f.nextDelay(), CACHE_STARTUP_DELAY_MS);
    await f.run();
    assert.ok(await f.stores.markdown.get(f.key));
    f.items.length = 0;
    f.notify();
    f.items.push({ ...f.item, deleted: false, isPDFAttachment: () => true });
    f.notify('add');
    await f.run();
    assert.ok(await f.stores.markdown.get(f.key));
    assert.equal((await f.ownership.read())[0].orphanedAt, null);
});

test('unrelated readers do not block cleanup and releasing the affected reader retries promptly', async t => {
    let busyID = 2;
    const f = await runtimeFixture(t, { isBusy: record => record.itemID === busyID });
    f.notify();
    await f.run();
    assert.equal(await f.stores.markdown.get(f.key), null);
    await f.adapter.rememberPDF(f.item, DATA);
    await f.stores.markdown.put(f.key, { markdown: 'Again', assets: [] });
    busyID = 1;
    f.notify();
    await f.run();
    assert.ok(await f.stores.markdown.get(f.key));
    assert.equal(f.summaries.at(-1).busy, 1);
    busyID = null;
    f.adapter.retry();
    assert.equal(f.nextDelay(), CACHE_DELETE_DELAY_MS);
    await f.run();
    assert.equal(await f.stores.markdown.get(f.key), null);
});

test('a resource lease release schedules retry without requiring a Zotero notification', async t => {
    const f = await runtimeFixture(t);
    let release;
    const active = f.adapter.use(() => new Promise(resolve => { release = resolve; }), { itemID: 1 });
    f.notify();
    await f.run();
    assert.ok(await f.stores.markdown.get(f.key));
    release();
    await active;
    assert.equal(f.nextDelay(), CACHE_DELETE_DELAY_MS);
    await f.run();
    assert.equal(await f.stores.markdown.get(f.key), null);
});

test('hash batches retain progress and protect a duplicate found in a later batch', async t => {
    const f = await runtimeFixture(t);
    const file = path.join(f.dir, 'duplicate.pdf');
    await fs.writeFile(file, DATA);
    for (let i = 0; i < 101; i++) f.items.push({ id: i + 10, libraryID: 1, key: `ITEM${i}`, isPDFAttachment: () => false });
    f.items.push({ id: 200, libraryID: 1, key: 'DUP', deleted: true,
        isPDFAttachment: () => true, getFilePathAsync: async () => file });
    f.notify();
    await f.run();
    assert.equal(f.summaries.at(-1).continuation, true);
    assert.equal(f.nextDelay(), 250);
    assert.ok(await f.stores.markdown.get(f.key));
    assert.equal(await f.io.exists(path.join(f.dir, 'mktero-annotations/v1/item-1.json')), false);
    await f.run();
    assert.equal(f.summaries.at(-1).referenced, 1);
    assert.ok(await f.stores.markdown.get(f.key));
    f.items.pop();
    f.notify('delete', 'item', [200]);
    await f.run();
    await f.run();
    assert.equal(await f.stores.markdown.get(f.key), null);
    assert.deepEqual(await f.ownership.read(), []);
});

test('resumable hashing reads each PDF once and invalidates its cursor on library changes', async t => {
    const f = await fixture(t);
    const file = path.join(f.dir, 'duplicate.pdf');
    await fs.writeFile(file, DATA);
    for (let i = 1; i <= 5; i++) f.items.push({ id: i, libraryID: 1, key: `PDF${i}`,
        isPDFAttachment: () => true, getFilePathAsync: async () => file });
    let reads = 0;
    const read = f.io.read;
    f.io.read = async value => { reads++; return read(value); };
    const scan = createCacheLibrarySnapshot({ ...f.options, batchItems: 2 });
    assert.equal((await scan({ hashes: true, generation: 1 })).continuation, true);
    assert.equal(reads, 2);
    await scan({ hashes: false, generation: 1 });
    assert.equal((await scan({ hashes: true, generation: 1 })).continuation, true);
    let complete;
    for (let i = 0; i < 10; i++) {
        complete = await scan({ hashes: true, generation: 1 });
        if (complete.complete) break;
        assert.equal(complete.continuation, true);
    }
    assert.equal(complete.complete, true);
    assert.equal(reads, 5);
    assert.ok(complete.sources.has(HASH));
    await scan({ hashes: true, generation: 2 });
    assert.equal(reads, 7);
    await scan({ hashes: true, generation: 3 });
    assert.equal(reads, 9);
});

for (const initial of [Uint8Array.of(9, 9, 9), Uint8Array.of(9, 9, 9, 9)]) {
    test(`resumed scans recheck a changed ${initial.length === DATA.length ? 'hashed' : 'size-skipped'} PDF without a notification`, async t => {
        const f = await fixture(t);
        const file = path.join(f.dir, 'changed.pdf');
        await fs.writeFile(file, initial);
        await fs.utimes(file, 1, 1);
        f.items.push({ id: 2, libraryID: 1, key: 'SURVIVOR',
            isPDFAttachment: () => true, getFilePathAsync: async () => file });
        const scan = createCacheLibrarySnapshot({ ...f.options, batchItems: 1 });
        const options = { hashes: true, sourceSizes: [DATA.length], generation: 1 };
        const first = await scan(options);
        assert.equal(first.continuation, true);
        assert.equal(first.sources.has(HASH), false);
        await fs.writeFile(file, DATA);
        await fs.utimes(file, 2, 2);
        let result;
        for (let i = 0; i < 10; i++) {
            result = await scan(options);
            if (result.complete) break;
            assert.equal(result.continuation, true);
        }
        assert.equal(result.complete, true);
        assert.equal(result.sources.has(HASH), true);
    });
}

test('membership enumeration yields even when no PDFs need hashing', async t => {
    const f = await fixture(t);
    for (let i = 1; i <= 250; i++) f.items.push({ id: i, libraryID: 1, isPDFAttachment: () => false });
    let yields = 0;
    const scan = createCacheLibrarySnapshot({ ...f.options, yieldControl: async () => { yields++; } });
    assert.equal((await scan({ hashes: false })).complete, true);
    assert.equal(yields, 2);
});
