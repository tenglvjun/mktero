import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MarkdownCache } from '../src/cache/markdown-cache.js';
import { MinerUResultStore } from '../src/cache/mineru-result-store.js';
import { ConversionProviderRouter } from '../src/core/conversion-provider.js';
import { MinerUImportIndex } from '../src/cache/mineru-import-index.js';
import { ImportedMinerUDocumentExtractor } from '../src/extractors/imported-mineru-extractor.js';
import {
    createLLMCacheIdentity,
    hashCanonicalLLMEntries,
} from '../src/mineru/llm-cache-profile.js';
import { strToU8, zipSync } from 'fflate';

function fixture(imported) {
    const calls = [];
    let failure;
    const provider = {
        extract: async () => {
            calls.push('remote');
            if (failure) throw failure;
            return { kind: 'markdown', markdown: 'Converted' };
        },
        readCached: async () => { calls.push('cached'); return null; },
    };
    return {
        calls,
        fail(error) { failure = error; },
        router: new ConversionProviderRouter({
            getProvider: () => 'mktero',
            providers: { mineru: provider, mistral: provider, mktero: provider },
            imported,
        }),
    };
}

test('selected imported content bypasses every remote provider', async () => {
    const result = { kind: 'markdown', markdown: 'Imported' };
    const f = fixture({ extract: async () => result, readCached: async () => result });
    assert.equal(await f.router.extract(1), result);
    assert.equal(await f.router.readCached(1), result);
    assert.deepEqual(f.calls, []);
});

test('failed or aborted imports never fall through to conversion', async () => {
    for (const name of ['Error', 'AbortError']) {
        const error = Object.assign(new Error('Local result unavailable'), { name });
        const fail = async () => { throw error; };
        const f = fixture({ extract: fail, readCached: fail });
        await assert.rejects(f.router.extract(1), value => value === error);
        await assert.rejects(f.router.readCached(1), value => value === error);
        assert.deepEqual(f.calls, []);
    }
});

test('a local-only open refuses an absent selection without conversion', async () => {
    const f = fixture({ extract: async () => null, readCached: async () => null });
    await assert.rejects(f.router.extract(1, { localOnly: true }), { code: 'LLM_CACHE_UNAVAILABLE' });
    assert.deepEqual(f.calls, []);
});

test('unselected attachments continue to use the configured provider', async () => {
    const f = fixture({ extract: async () => null, readCached: async () => null });
    await f.router.extract(1);
    await f.router.readCached(1);
    assert.deepEqual(f.calls, ['remote', 'cached']);
});

test('explicit reparse releases only the previous selection after success', async () => {
    const selected = { attachmentKey: 'KEY', sourceHash: 'hash' };
    const forgotten = [];
    const f = fixture({
        extract: async () => assert.fail('read imported result during reparse'),
        readCached: async () => null,
        lookup: async () => selected,
        forgetSelection: async record => forgotten.push(record),
    });
    f.fail(new Error('Provider failed'));
    await assert.rejects(f.router.extract(1, { forceRefresh: true }), /Provider failed/);
    assert.deepEqual(forgotten, []);
    f.fail(null);
    await f.router.extract(1, { forceRefresh: true });
    assert.deepEqual(forgotten, [selected]);
});

async function selectedImportFixture() {
    const fileData = strToU8('Synthetic local PDF');
    const markdown = 'Retained imported paper content.';
    const entries = {
        'full.md': strToU8(markdown),
        'content_list.json': strToU8(JSON.stringify([
            { type: 'text', text: markdown, page_idx: 0, bbox: [100, 100, 900, 300] },
        ])),
    };
    const snapshotHash = await hashCanonicalLLMEntries(Object.entries(entries).map(([path, data]) => ({ path, data })));
    const identity = await createLLMCacheIdentity({ fileData, snapshotHash });
    let serialized = null;
    const index = new MinerUImportIndex({ adapter: {
        async read() { return serialized; },
        async write(value) { serialized = value; },
    } });
    const selection = await index.publish({
        ...identity, libraryID: 1, attachmentKey: 'ATTACH01', importedAt: 100, binding: 'user-confirmed',
    });
    const cached = new Map();
    const raw = new Map();
    const fileReads = [];
    const imported = new ImportedMinerUDocumentExtractor({
        zotero: { Items: { getAsync: async () => ({
            libraryID: 1, key: 'ATTACH01', isPDFAttachment: () => true,
            getFilePathAsync: async () => '/profile/paper.pdf', getDisplayTitle: () => 'Paper',
        }) } },
        readFile: async path => {
            // Reopening an import may read the PDF, never the upstream cache.
            assert.equal(path, '/profile/paper.pdf');
            fileReads.push(path);
            return fileData;
        },
        index,
        cache: {
            async get(key) { return cached.get(key) || null; },
            async put(key, value) { cached.set(key, value); },
        },
        resultStore: { async get(key) { return raw.get(key) || null; } },
        isCacheEnabled: () => true,
    });
    const converted = { kind: 'markdown', markdown: 'Current provider content.' };
    const handlers = { extract: async () => converted, readCached: async () => null };
    const calls = [];
    let configured = 'mktero';
    const providers = Object.fromEntries(['mineru', 'mistral', 'mktero'].map(provider => [provider,
        Object.fromEntries(['extract', 'readCached'].map(method => [method, async (...args) => {
            calls.push({ provider, method, args });
            return handlers[method](...args);
        }])),
    ]));
    return {
        identity, selection, index, imported, cached, raw, fileReads, handlers, calls, converted,
        archive: zipSync(entries),
        document: {
            markdown, sourceMap: [{ type: 'text', markdownFrom: 0, markdownTo: markdown.length,
                locations: [{ pageIndex: 0, bbox: [100, 100, 900, 300] }] }],
            assets: [], totalPages: 1, extractedPages: 1,
        },
        diskSelections: () => JSON.parse(serialized).records,
        configure(value) { configured = value; },
        router: new ConversionProviderRouter({ getProvider: () => configured, providers, imported }),
    };
}

test('ordinary extraction uses the current converter after every retained imported copy is cleared', async () => {
    for (const provider of ['mktero', 'mineru', 'mistral']) {
        const f = await selectedImportFixture();
        f.configure(provider);
        // A miss must carry the record it read; a second lookup could see a new import.
        f.imported.lookup = async () => assert.fail('a cache miss must not reread the selection or PDF');
        const options = { signal: new AbortController().signal };
        assert.equal(await f.router.extract(42, options), f.converted);
        assert.deepEqual(f.calls, [{ provider, method: 'extract', args: [42, options] }]);
        assert.equal(f.fileReads.length, 1);
        assert.equal(await f.index.get(f.selection), null);
        assert.deepEqual(f.diskSelections(), []);
    }
});

test('retained derived, raw, or corrected imported content opens offline without the upstream cache', async () => {
    for (const retained of ['derived', 'raw', 'revision']) {
        const f = await selectedImportFixture();
        if (retained === 'derived') f.cached.set(f.identity.cacheKey, f.document);
        if (retained === 'raw') f.raw.set(f.identity.rawKey, {
            archive: f.archive, provider: 'llm-for-zotero', extractedPages: 1, totalPages: 1,
        });
        if (retained === 'revision') f.imported.readRevision = async ({ cacheKey }) => (
            cacheKey === f.identity.cacheKey ? f.document : null
        );
        for (const method of ['extract', 'readCached']) {
            const result = await f.router[method](42);
            assert.match(result.markdown, /Retained imported paper content/);
            assert.equal(result.provider, 'llm-for-zotero');
        }
        assert.deepEqual(f.calls, []);
        assert.deepEqual(await f.index.get(f.selection), f.selection);
        assert.ok(f.fileReads.length >= 2);
    }
});

test('an imported cache miss reuses the current provider cache without starting conversion', async () => {
    const f = await selectedImportFixture();
    f.configure('mistral');
    f.handlers.readCached = async () => f.converted;
    const options = { signal: new AbortController().signal };
    assert.equal(await f.router.readCached(42, options), f.converted);
    assert.deepEqual(f.calls, [{ provider: 'mistral', method: 'readCached', args: [42, options] }]);
    assert.equal(await f.index.get(f.selection), null);
    assert.deepEqual(f.diskSelections(), []);
});

test('a missing or unusable current provider result retains the old imported selection', async () => {
    for (const method of ['extract', 'readCached']) {
        for (const result of [null, undefined, {}, { kind: 'markdown', markdown: '  ' }]) {
            const f = await selectedImportFixture();
            f.handlers[method] = async () => result;
            assert.equal(await f.router[method](42), result);
            assert.deepEqual(f.calls.map(call => call.method), [method]);
            assert.deepEqual(await f.index.get(f.selection), f.selection);
            assert.deepEqual(f.diskSelections(), [f.selection]);
        }
    }
});

test('an intentionally empty corrected provider document can replace a missing imported copy', async () => {
    const f = await selectedImportFixture();
    const result = { kind: 'markdown', markdown: '', userEdited: true };
    f.handlers.readCached = async () => result;
    assert.equal(await f.router.readCached(42), result);
    assert.equal(await f.index.get(f.selection), null);
});

test('local-only opens keep missing imported content as a local error and preserve the selection', async () => {
    const f = await selectedImportFixture();
    for (const method of ['extract', 'readCached']) {
        await assert.rejects(f.router[method](42, { localOnly: true }), error => (
            error.code === 'LLM_CACHE_IMPORT_UNAVAILABLE' && error.reason === 'content-missing'
        ));
    }
    assert.deepEqual(f.calls, []);
    assert.deepEqual(await f.index.get(f.selection), f.selection);
});

test('failed or cancelled provider fallbacks retain the selected import', async () => {
    for (const method of ['extract', 'readCached']) {
        for (const name of ['Error', 'AbortError']) {
            const f = await selectedImportFixture();
            const failure = Object.assign(new Error('Provider could not open the document'), { name });
            f.handlers[method] = async () => { throw failure; };
            await assert.rejects(f.router[method](42), error => error === failure);
            assert.deepEqual(f.calls.map(call => call.method), [method]);
            assert.deepEqual(await f.index.get(f.selection), f.selection);
            assert.deepEqual(f.diskSelections(), [f.selection]);
        }
    }
});

test('cancellation after a provider resolves still preserves the imported selection', async () => {
    for (const method of ['extract', 'readCached']) {
        const f = await selectedImportFixture();
        const controller = new AbortController();
        f.handlers[method] = async () => { controller.abort(); return f.converted; };
        await assert.rejects(f.router[method](42, { signal: controller.signal }), { name: 'AbortError' });
        assert.deepEqual(f.calls.map(call => call.method), [method]);
        assert.deepEqual(await f.index.get(f.selection), f.selection);
        assert.deepEqual(f.diskSelections(), [f.selection]);
    }
});

test('successful fallback cannot remove an import published while the current provider is running', async () => {
    for (const method of ['extract', 'readCached']) {
        const f = await selectedImportFixture();
        let newer;
        f.handlers[method] = async () => {
            // Even reimporting the same snapshot in the same clock tick is a new selection.
            newer = await f.index.publish(f.selection);
            return f.converted;
        };
        assert.equal(await f.router[method](42), f.converted);
        assert.ok(newer.importedAt > f.selection.importedAt);
        assert.deepEqual(await f.index.get(f.selection), newer);
        assert.deepEqual(f.diskSelections(), [newer]);
    }
});

test('only absent imported content permits fallback; damaged, disabled, unreadable, or aborted imports do not', async () => {
    const cases = [
        { reason: 'cache-disabled', change: f => { f.imported.isCacheEnabled = () => false; } },
        { reason: 'pdf-unavailable', change: f => { f.imported.readFile = async () => { throw new Error('PDF read failed'); }; } },
        { reason: 'cache-read-failed', change: f => { f.imported.cache.get = async () => { throw new Error('Cache I/O failed'); }; } },
        { reason: 'stored-input-unavailable', change: f => { f.imported.resultStore.get = async () => { throw new Error('Raw I/O failed'); }; } },
        { reason: 'snapshot-mismatch', change: f => { f.raw.set(f.identity.rawKey, {
            archive: zipSync({ 'full.md': strToU8('Changed'), 'content_list.json': strToU8('[]') }), provider: 'llm-for-zotero',
        }); } },
        { reason: 'document-invalid', change: f => { f.cached.set(f.identity.cacheKey, { markdown: 'Broken' }); } },
    ];
    for (const { reason, change } of cases) {
        const f = await selectedImportFixture();
        change(f);
        for (const method of ['extract', 'readCached']) {
            await assert.rejects(f.router[method](42), error => error.reason === reason);
        }
        assert.deepEqual(f.calls, []);
        assert.deepEqual(await f.index.get(f.selection), f.selection);
    }
    const broken = await selectedImportFixture();
    broken.index.adapter.read = async () => '{';
    await assert.rejects(broken.index.load(), { code: 'LLM_CACHE_IMPORT_INDEX_INVALID' });
    const aborted = await selectedImportFixture();
    const controller = new AbortController();
    controller.abort();
    for (const method of ['extract', 'readCached']) {
        await assert.rejects(broken.router[method](42), { code: 'LLM_CACHE_IMPORT_INDEX_INVALID' });
        await assert.rejects(aborted.router[method](42, { signal: controller.signal }), { name: 'AbortError' });
    }
    assert.deepEqual(broken.calls, []);
    assert.deepEqual(aborted.calls, []);
    assert.deepEqual(broken.diskSelections(), [broken.selection]);
    assert.deepEqual(await aborted.index.get(aborted.selection), aborted.selection);
});

async function realStoreFixture(t, { raw = false, derived = false, ...options } = {}) {
    const f = await selectedImportFixture();
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-import-routing-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const io = {
        async exists(filePath) {
            try { await stat(filePath); return true; }
            catch (error) {
                if (error.code === 'ENOENT') return false;
                throw error;
            }
        },
        makeDirectory: (filePath, { ignoreExisting } = {}) => mkdir(filePath, { recursive: Boolean(ignoreExisting) }),
        read: async filePath => new Uint8Array(await readFile(filePath)),
        readUTF8: filePath => readFile(filePath, 'utf8'),
        getChildren: async filePath => (await readdir(filePath)).map(name => path.join(filePath, name)),
        async stat(filePath) {
            const value = await stat(filePath);
            return { type: value.isDirectory() ? 'directory' : 'regular', size: value.size };
        },
        remove: (filePath, { recursive, ignoreAbsent } = {}) => rm(filePath, {
            recursive: Boolean(recursive), force: Boolean(ignoreAbsent),
        }),
        async write(filePath, data, { tmpPath } = {}) {
            await writeFile(tmpPath || filePath, data);
            if (tmpPath) await rename(tmpPath, filePath);
        },
        async writeUTF8(filePath, data, options) { await io.write(filePath, data, options); },
    };
    const storeOptions = { ioUtils: io, pathUtils: { join: path.join, filename: path.basename, parent: path.dirname }, ...options };
    const cache = new MarkdownCache({ ...storeOptions, rootPath: path.join(rootPath, 'derived') });
    const store = new MinerUResultStore({ ...storeOptions, rootPath: path.join(rootPath, 'raw') });
    f.imported.cache = cache;
    f.imported.resultStore = store;
    if (derived) await cache.put(f.identity.cacheKey, f.document);
    if (raw) await store.put(f.identity.rawKey, {
        archive: f.archive, provider: 'llm-for-zotero', extractedPages: 1, totalPages: 1,
    });
    const rawPath = path.join(store.rootPath, 'entries', f.identity.rawKey);
    const derivedPath = path.join(cache.rootPath, 'entries', f.identity.cacheKey);
    return { ...f, io, cache, store, rawPath, derivedPath };
}

function failIO(io, method, filePath, error) {
    const original = io[method];
    io[method] = async (target, ...args) => {
        if (target === filePath) throw error;
        return original(target, ...args);
    };
    return () => { io[method] = original; };
}

test('real raw store corruption and I/O failures never become provider cache misses', async t => {
    for (const failure of ['metadata', 'size', 'read', 'stat']) {
        for (const method of ['extract', 'readCached']) {
            await t.test(`${failure}: ${method}`, async t => {
                const f = await realStoreFixture(t, { raw: true });
                const metadataPath = path.join(f.rawPath, 'entry.json');
                const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
                const archivePath = path.join(f.rawPath, metadata.archiveFile);
                const ioError = Object.assign(new Error('Raw storage read failed'), { code: 'EIO' });
                if (failure === 'metadata') await writeFile(metadataPath, '{');
                else if (failure === 'size') await writeFile(archivePath, f.archive.subarray(0, 1));
                else failIO(f.io, failure, archivePath, ioError);
                const before = await Promise.all([readFile(metadataPath), readFile(archivePath)]);
                for (let attempt = 0; attempt < 2; attempt++) {
                    await assert.rejects(f.router[method](42), error => {
                        assert.equal(error.code, 'LLM_CACHE_IMPORT_UNAVAILABLE');
                        assert.equal(error.reason, 'stored-input-unavailable');
                        assert.ok(error.cause instanceof Error);
                        if (['read', 'stat'].includes(failure)) assert.equal(error.cause, ioError);
                        return true;
                    });
                    assert.deepEqual(await Promise.all([readFile(metadataPath), readFile(archivePath)]), before);
                    assert.deepEqual(await f.index.get(f.selection), f.selection);
                    assert.deepEqual(f.diskSelections(), [f.selection]);
                    assert.deepEqual(f.calls, []);
                }
            });
        }
    }
});

test('real derived store corruption and I/O failures never become provider cache misses', async t => {
    for (const failure of ['metadata', 'read']) {
        for (const method of ['extract', 'readCached']) {
            await t.test(`${failure}: ${method}`, async t => {
                const f = await realStoreFixture(t, { derived: true });
                const metadataPath = path.join(f.derivedPath, 'entry.json');
                const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
                const documentPath = path.join(f.derivedPath, metadata.markdownFile);
                const ioError = Object.assign(new Error('Derived storage read failed'), { code: 'EIO' });
                if (failure === 'metadata') await writeFile(metadataPath, '{');
                else failIO(f.io, 'readUTF8', documentPath, ioError);
                const before = await Promise.all([readFile(metadataPath), readFile(documentPath)]);
                for (let attempt = 0; attempt < 2; attempt++) {
                    await assert.rejects(f.router[method](42), error => {
                        assert.equal(error.code, 'LLM_CACHE_IMPORT_UNAVAILABLE');
                        assert.equal(error.reason, 'cache-read-failed');
                        assert.ok(error.cause instanceof Error);
                        if (failure === 'read') assert.equal(error.cause, ioError);
                        return true;
                    });
                    assert.deepEqual(await Promise.all([readFile(metadataPath), readFile(documentPath)]), before);
                    assert.deepEqual(await f.index.get(f.selection), f.selection);
                    assert.deepEqual(f.diskSelections(), [f.selection]);
                    assert.deepEqual(f.calls, []);
                }
            });
        }
    }
});

test('real stores still allow fallback when imported copies are missing', async t => {
    for (const method of ['extract', 'readCached']) {
        await t.test(`missing: ${method}`, async t => {
            const f = await realStoreFixture(t, {
                raw: false,
                derived: false,
            });
            f.handlers.readCached = async () => f.converted;
            assert.equal(await f.router[method](42), f.converted);
            assert.deepEqual(f.calls.map(call => call.method), [method]);
            assert.equal(await f.index.get(f.selection), null);
            assert.deepEqual(f.diskSelections(), []);
            assert.equal(await f.io.exists(f.rawPath), false);
            assert.equal(await f.io.exists(f.derivedPath), false);
        });
    }
});

test('a retained real raw package can be retried offline after a temporary I/O failure', async t => {
    for (const method of ['extract', 'readCached']) {
        await t.test(method, async t => {
            const f = await realStoreFixture(t, { raw: true });
            const metadata = JSON.parse(await readFile(path.join(f.rawPath, 'entry.json'), 'utf8'));
            const archivePath = path.join(f.rawPath, metadata.archiveFile);
            const restore = failIO(f.io, 'read', archivePath, new Error('Temporary disk failure'));
            await assert.rejects(f.router[method](42), { reason: 'stored-input-unavailable' });
            assert.deepEqual(new Uint8Array(await readFile(archivePath)), f.archive);
            restore();
            const result = await f.router[method](42);
            assert.equal(result.provider, 'llm-for-zotero');
            assert.equal(result.markdown, f.document.markdown);
            assert.equal((await f.cache.get(f.identity.cacheKey)).markdown, f.document.markdown);
            assert.deepEqual(await f.index.get(f.selection), f.selection);
            assert.deepEqual(f.calls, []);
        });
    }
});

test('real store read AbortErrors reach the router without cleanup or provider fallback', async t => {
    for (const retained of ['raw', 'derived']) {
        for (const method of ['extract', 'readCached']) {
            await t.test(`${retained}: ${method}`, async t => {
                const f = await realStoreFixture(t, { [retained]: true });
                const entryPath = retained === 'raw' ? f.rawPath : f.derivedPath;
                const metadata = JSON.parse(await readFile(path.join(entryPath, 'entry.json'), 'utf8'));
                const contentPath = path.join(entryPath, metadata.archiveFile || metadata.markdownFile);
                const error = Object.assign(new Error('Storage read cancelled'), { name: 'AbortError' });
                failIO(f.io, retained === 'raw' ? 'read' : 'readUTF8', contentPath, error);
                await assert.rejects(f.router[method](42), value => value === error);
                assert.ok(await f.io.exists(contentPath));
                assert.deepEqual(await f.index.get(f.selection), f.selection);
                assert.deepEqual(f.calls, []);
            });
        }
    }
});
