import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import {
    createMinerUResultKey,
    MinerUResultStore,
} from '../src/cache/mineru-result-store.js';
import { createMinerUResultArchive, tryCreateMinerUResultArchive } from '../src/mineru/result-archive.js';
import { MinerUConversion } from '../src/mineru/mineru-conversion.js';
import { MkteroDocumentExtractor } from '../src/extractors/mktero-extractor.js';
import { extractMinerUResultFromZip } from '../src/mineru/zip-markdown.js';

const KEY = 'a'.repeat(64);
const SOURCE_HASH = 'b'.repeat(64);

function resultZip(markdown = '# Stored result') {
    return zipSync({
        'id/full.md': strToU8(markdown),
        'id/id_content_list.json': strToU8('[]'),
        'id/id_content_list_v2.json': strToU8('[]'),
        'id/id_model.json': strToU8('{"big":true}'),
        'id/id_origin.pdf': new Uint8Array(4096),
        'id/layout.json': strToU8('{"pdf_info":[]}'),
        'id/images/a.png': new Uint8Array([137, 80, 78, 71]),
    });
}

test('keys raw results by source, provider, and request profile only', async () => {
    const base = { sourceHash: SOURCE_HASH, provider: 'mineru', requestProfile: '{"batch":1}' };
    const key = await createMinerUResultKey(base);
    assert.match(key, /^[a-f0-9]{64}$/);
    assert.equal(await createMinerUResultKey(base), key);
    assert.notEqual(await createMinerUResultKey({ ...base, provider: 'mktero' }), key);
    assert.notEqual(await createMinerUResultKey({ ...base, requestProfile: '{"batch":2}' }), key);
    assert.notEqual(await createMinerUResultKey({ ...base, sourceHash: 'c'.repeat(64) }), key);
    const hashed = await createMinerUResultKey({ ...base, sourceHash: null, fileData: new Uint8Array([1]) });
    assert.match(hashed, /^[a-f0-9]{64}$/);
    await assert.rejects(createMinerUResultKey({ ...base, provider: '' }), /provider/);
    await assert.rejects(createMinerUResultKey({ ...base, requestProfile: '' }), /request profile/);
});

test('trims a MinerU archive to the files the extension reads', () => {
    const trimmed = createMinerUResultArchive(resultZip());
    const names = Object.keys(unzipSync(trimmed)).sort();
    assert.deepEqual(names, ['id/full.md', 'id/id_content_list.json', 'id/images/a.png', 'id/layout.json']);
    const extracted = extractMinerUResultFromZip(trimmed);
    assert.equal(extracted.markdown, '# Stored result');
    assert.equal(extracted.assets.length, 1);
    assert.throws(() => createMinerUResultArchive(zipSync({ 'x/a.png': new Uint8Array([1]) })), /its Markdown/);
    // A self-hosted MinerU 4.0 result keeps markdown.md and middle_json.json.
    const local = unzipSync(createMinerUResultArchive(zipSync({
        'markdown.md': new Uint8Array([1]),
        'middle_json.json': new Uint8Array([2]),
        'structured_content.json': new Uint8Array([3]),
        'images/a.png': new Uint8Array([4]),
    })));
    assert.deepEqual(Object.keys(local).sort(), ['images/a.png', 'markdown.md', 'middle_json.json']);
    assert.equal(tryCreateMinerUResultArchive(new Uint8Array([1, 2, 3])), null);
    assert.throws(() => createMinerUResultArchive(resultZip(), { maxBytes: 8 }), /too large/);
});

test('stores, reads, and clears trimmed archives atomically', async t => {
    const fixture = await createStoreFixture(t);
    const archive = createMinerUResultArchive(resultZip());
    await fixture.store.put(KEY, { archive, provider: 'mineru', extractedPages: 3, totalPages: 3 });
    const stored = await fixture.store.get(KEY);
    assert.deepEqual([...stored.archive], [...archive]);
    assert.deepEqual([stored.provider, stored.extractedPages, stored.totalPages], ['mineru', 3, 3]);
    const stats = await fixture.store.getStats();
    assert.equal(stats.entries, 1);
    assert.equal(stats.sizeBytes, archive.length);
    const files = await readdir(path.join(fixture.rootPath, 'entries', KEY));
    assert.equal(files.some(name => name.endsWith('.tmp')), false);
    await fixture.store.clear();
    assert.deepEqual(await fixture.store.getStats(), { entries: 0, sizeBytes: 0 });
    assert.equal(await fixture.store.get(KEY), null);
});

test('removes a corrupted stored archive instead of returning it', async t => {
    const fixture = await createStoreFixture(t);
    await fixture.store.put(KEY, { archive: new Uint8Array([1, 2, 3, 4]), provider: 'mineru' });
    const entryPath = path.join(fixture.rootPath, 'entries', KEY);
    const archiveFile = (await readdir(entryPath)).find(name => name.endsWith('.zip'));
    await writeFile(path.join(entryPath, archiveFile), new Uint8Array([1]));
    assert.equal(await fixture.store.get(KEY), null);
    assert.equal(await fixture.ioUtils.exists(entryPath), false);
});

test('expires stored archives and enforces entry and byte limits', async t => {
    let timestamp = 1_000;
    const fixture = await createStoreFixture(t, { now: () => timestamp, maxEntries: 1, maxAgeMs: 1_000 });
    await fixture.store.put(KEY, { archive: new Uint8Array([1]), provider: 'mineru' });
    timestamp = 1_500;
    await fixture.store.put('c'.repeat(64), { archive: new Uint8Array([2]), provider: 'mineru' });
    assert.equal(await fixture.store.get(KEY), null);
    assert.ok(await fixture.store.get('c'.repeat(64)));
    timestamp = 3_000;
    assert.equal(await fixture.store.get('c'.repeat(64)), null);

    const small = await createStoreFixture(t, { maxBytes: 3 });
    await small.store.put(KEY, { archive: new Uint8Array([1, 2]), provider: 'mineru' });
    await small.store.put('d'.repeat(64), { archive: new Uint8Array([1, 2]), provider: 'mineru' });
    assert.deepEqual(await small.store.getStats(), { entries: 1, sizeBytes: 2 });
    assert.throws(() => small.store.put(KEY, { archive: new Uint8Array(0) }), /store limit/);
    assert.throws(() => small.store.get('bad'), /SHA-256/);
});

test('honors an aborted signal before touching the store', async t => {
    const fixture = await createStoreFixture(t);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        fixture.store.put(KEY, { archive: new Uint8Array([1]), provider: 'mineru' }, { signal: controller.signal }),
        error => error.name === 'AbortError'
    );
    assert.deepEqual(await fixture.store.getStats(), { entries: 0, sizeBytes: 0 });
});

test('re-derives a cloud MinerU result from the store without the network', async () => {
    const store = createMemoryStore();
    await store.put(KEY, { archive: createMinerUResultArchive(resultZip()), provider: 'mineru', totalPages: 2 });
    const cache = createMemoryCache();
    const conversion = new MinerUConversion({
        client: {
            async submit() { throw new Error('must not upload'); },
            async collect() { throw new Error('must not download'); },
        },
        pendingTasks: createMemoryPendingTasks(),
        cache,
        prepareResult: async raw => ({ ...raw, markdown: `${raw.markdown} prepared` }),
        resultStore: store,
        createResultKey: async () => KEY,
    });
    const converted = await conversion.convert({
        key: 'e'.repeat(64), apiKey: 'token', fileName: 'paper.pdf', fileData: new Uint8Array([1]), cacheEnabled: true,
    });
    assert.equal(converted.origin, 'cache');
    assert.equal(converted.result.markdown, '# Stored result prepared');
    assert.equal(converted.result.totalPages, 2);
    assert.equal(cache.entries.get('e'.repeat(64)).markdown, '# Stored result prepared');
    const read = await conversion.readCached({ key: 'f'.repeat(64), fileData: new Uint8Array([1]), cacheEnabled: true });
    assert.equal(read.origin, 'cache');
});

test('restarts an unfinished figure restoration from the raw result store', async () => {
    const store = createMemoryStore();
    await store.put(KEY, { archive: createMinerUResultArchive(resultZip()), provider: 'mineru', totalPages: 2 });
    const cache = createMemoryCache();
    cache.entries.set('e'.repeat(64), {
        markdown: '# Provisional', assets: [], sourceMap: [],
        figureRestoration: { status: 'pending', source: 'mineru-result-store', completedFigureIds: [] },
    });
    const events = [];
    const conversion = new MinerUConversion({
        client: {
            async submit() { throw new Error('must not upload'); },
            async collect() { throw new Error('must not download'); },
        },
        pendingTasks: createMemoryPendingTasks(),
        cache,
        progressiveResult: async (raw, { onEvent }) => {
            onEvent?.({ type: 'complete' });
            return { ...raw, markdown: `${raw.markdown} restored` };
        },
        resultStore: store,
        createResultKey: async () => KEY,
    });
    const converted = await conversion.convert({
        key: 'e'.repeat(64), apiKey: 'token', fileName: 'paper.pdf', fileData: new Uint8Array([1]),
        cacheEnabled: true, onProgressiveFigures: event => events.push(event),
    });
    assert.equal(converted.origin, 'cache');
    assert.equal(converted.result.markdown, '# Stored result restored');
    assert.equal(cache.entries.get('e'.repeat(64)).markdown, '# Stored result restored');
    assert.deepEqual(events.map(event => event.type), ['complete']);
});

test('keeps the provisional document when the raw result is gone', async () => {
    const cache = createMemoryCache();
    cache.entries.set('e'.repeat(64), {
        markdown: '# Provisional', assets: [], sourceMap: [],
        figureRestoration: { status: 'pending', source: 'mineru-result-store', completedFigureIds: [] },
    });
    const conversion = new MinerUConversion({
        client: {
            async submit() { throw new Error('must not upload'); },
            async collect() { throw new Error('must not download'); },
        },
        pendingTasks: createMemoryPendingTasks(),
        cache,
        progressiveResult: async () => { throw new Error('must not restore'); },
        resultStore: createMemoryStore(),
        createResultKey: async () => KEY,
    });
    const read = await conversion.readCached({ key: 'e'.repeat(64), fileData: new Uint8Array([1]), cacheEnabled: true });
    assert.equal(read.result.markdown, '# Provisional');
});

test('stores a downloaded cloud archive and strips it before preparation', async () => {
    const store = createMemoryStore();
    const prepared = [];
    const collects = [];
    const conversion = new MinerUConversion({
        client: {
            async submit({ dataID }) { return { batchID: 'batch', dataID, fileName: 'paper.pdf' }; },
            async collect(options) {
                collects.push(options);
                return { markdown: '# Fresh', totalPages: 1, resultArchive: new Uint8Array([9, 9]) };
            },
        },
        pendingTasks: createMemoryPendingTasks(),
        cache: createMemoryCache(),
        prepareResult: async raw => {
            prepared.push(raw);
            return raw;
        },
        resultStore: store,
        createResultKey: async () => KEY,
    });
    const converted = await conversion.convert({
        key: 'e'.repeat(64), apiKey: 'token', fileName: 'paper.pdf', fileData: new Uint8Array([1]), cacheEnabled: true,
    });
    assert.equal(converted.origin, 'fresh');
    assert.equal(collects[0].includeArchive, true);
    assert.equal('resultArchive' in prepared[0], false);
    assert.equal('resultArchive' in converted.result, false);
    assert.deepEqual([...store.records.get(KEY).archive], [9, 9]);
    assert.equal(store.records.get(KEY).totalPages, 1);
});

test('does not store or read raw results when the cache is disabled', async () => {
    const store = createMemoryStore();
    await store.put(KEY, { archive: createMinerUResultArchive(resultZip()), provider: 'mineru' });
    const collects = [];
    const conversion = new MinerUConversion({
        client: {
            async submit({ dataID }) { return { batchID: 'batch', dataID, fileName: 'paper.pdf' }; },
            async collect(options) {
                collects.push(options);
                return { markdown: '# Fresh' };
            },
        },
        pendingTasks: createMemoryPendingTasks(),
        prepareResult: async raw => raw,
        resultStore: store,
        createResultKey: async () => KEY,
    });
    const converted = await conversion.convert({
        key: 'e'.repeat(64), apiKey: 'token', fileName: 'paper.pdf', fileData: new Uint8Array([1]), cacheEnabled: false,
    });
    assert.equal(converted.result.markdown, '# Fresh');
    assert.equal(collects[0].includeArchive, undefined);
});

test('keeps converting when the raw result store fails', async () => {
    const errors = [];
    const conversion = new MinerUConversion({
        client: {
            async submit({ dataID }) { return { batchID: 'batch', dataID, fileName: 'paper.pdf' }; },
            async collect() { return { markdown: '# Fresh', resultArchive: new Uint8Array([1]) }; },
        },
        pendingTasks: createMemoryPendingTasks(),
        prepareResult: async raw => raw,
        resultStore: {
            async get() { throw new Error('read failed'); },
            async put() { throw new Error('write failed'); },
            async delete() {},
        },
        createResultKey: async () => KEY,
        onError: error => errors.push(error.message),
    });
    const converted = await conversion.convert({
        key: 'e'.repeat(64), apiKey: 'token', fileName: 'paper.pdf', fileData: new Uint8Array([1]), cacheEnabled: true,
    });
    assert.equal(converted.result.markdown, '# Fresh');
    assert.deepEqual(errors, ['read failed', 'write failed']);
});

test('re-derives a hosted Mktero result from the store without the network', async () => {
    const store = createMemoryStore();
    await store.put(KEY, { archive: createMinerUResultArchive(resultZip('# Hosted stored')), provider: 'mktero' });
    const cache = createMemoryCache();
    const keyCalls = [];
    const extractor = createMkteroExtractor({
        conversion: { async convert() { throw new Error('must not convert'); } },
        cache,
        resultStore: store,
        createResultKey: async (fileData, options) => {
            keyCalls.push(options);
            return KEY;
        },
    });
    const result = await extractor.extract(42);
    assert.equal(result.markdown, '# Hosted stored');
    assert.equal(result.cacheHit, true);
    assert.deepEqual(keyCalls, [{ sourceHash: SOURCE_HASH }]);
    assert.equal(cache.entries.get('c'.repeat(64)).markdown, '# Hosted stored');
    cache.entries.clear();
    const read = await extractor.readCached(42);
    assert.equal(read.markdown, '# Hosted stored');
});

test('stores a hosted archive and strips it before preparation', async () => {
    const store = createMemoryStore();
    const converts = [];
    const prepared = [];
    const extractor = createMkteroExtractor({
        conversion: {
            async convert(options) {
                converts.push(options);
                return { result: { markdown: '# Hosted' }, origin: 'network', warnings: [], resultArchive: new Uint8Array([7]) };
            },
        },
        prepareResult: async raw => {
            prepared.push(raw);
            return raw;
        },
        resultStore: store,
        createResultKey: async () => KEY,
    });
    const result = await extractor.extract(42, { forceRefresh: true });
    assert.equal(result.cacheHit, false);
    assert.equal(converts[0].includeArchive, true);
    assert.equal('resultArchive' in prepared[0], false);
    assert.deepEqual([...store.records.get(KEY).archive], [7]);
    assert.equal(store.records.get(KEY).provider, 'mktero');
});

function createMkteroExtractor(overrides) {
    return new MkteroDocumentExtractor({
        zotero: { Items: { getAsync: async () => ({
            isPDFAttachment: () => true,
            getFilePathAsync: async () => '/tmp/paper.pdf',
            getDisplayTitle: () => 'Paper',
            attachmentFilename: 'paper.pdf',
        }) } },
        getApiBase: () => 'https://api.example.test',
        getAccessToken: () => 'token',
        readFile: async () => new Uint8Array([1, 2, 3]),
        createCacheKey: async () => 'c'.repeat(64),
        createSourceHash: async () => SOURCE_HASH,
        isCacheEnabled: () => true,
        cache: createMemoryCache(),
        prepareResult: async raw => raw,
        ...overrides,
    });
}

function createMemoryStore() {
    const records = new Map();
    return {
        records,
        async get(key) { return records.get(key) || null; },
        async put(key, record) { records.set(key, record); },
        async delete(key) { records.delete(key); },
    };
}

function createMemoryCache() {
    const entries = new Map();
    return {
        entries,
        async get(key) { return entries.get(key) || null; },
        async put(key, value) { entries.set(key, value); },
    };
}

function createMemoryPendingTasks() {
    const tasks = new Map();
    return {
        async get(key) { return tasks.get(key) || null; },
        async put(key, task) { tasks.set(key, task); },
        async delete(key) { return tasks.delete(key); },
    };
}

async function createStoreFixture(t, options = {}) {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-mineru-results-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const ioUtils = createNodeIOUtils();
    return {
        rootPath,
        ioUtils,
        store: new MinerUResultStore({
            rootPath,
            ioUtils,
            pathUtils: { join: path.join, filename: path.basename, parent: path.dirname },
            ...options,
        }),
    };
}

function createNodeIOUtils() {
    return {
        async exists(filePath) {
            try {
                await stat(filePath);
                return true;
            }
            catch {
                return false;
            }
        },
        async makeDirectory(filePath, { ignoreExisting } = {}) {
            await mkdir(filePath, { recursive: Boolean(ignoreExisting) });
        },
        readUTF8: filePath => readFile(filePath, 'utf8'),
        read: async filePath => new Uint8Array(await readFile(filePath)),
        async writeUTF8(filePath, data, { tmpPath } = {}) {
            if (!tmpPath) return writeFile(filePath, data, 'utf8');
            await writeFile(tmpPath, data, 'utf8');
            await rename(tmpPath, filePath);
        },
        async write(filePath, data, { tmpPath } = {}) {
            if (!tmpPath) return writeFile(filePath, data);
            await writeFile(tmpPath, data);
            await rename(tmpPath, filePath);
        },
        async stat(filePath) {
            const fileStat = await stat(filePath);
            return { size: fileStat.size, type: fileStat.isDirectory() ? 'directory' : 'regular' };
        },
        async getChildren(filePath) {
            return (await readdir(filePath)).map(child => path.join(filePath, child));
        },
        async remove(filePath, { recursive, ignoreAbsent } = {}) {
            await rm(filePath, { recursive: Boolean(recursive), force: Boolean(ignoreAbsent) });
        },
    };
}

