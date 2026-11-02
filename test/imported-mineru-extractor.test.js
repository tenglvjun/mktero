import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { ImportedMinerUDocumentExtractor } from '../src/extractors/imported-mineru-extractor.js';
import {
    createLLMCacheIdentity,
    createLLMCacheParserProfile,
    hashCanonicalLLMEntries,
} from '../src/mineru/llm-cache-profile.js';
import { createMarkdownCacheKey } from '../src/cache/markdown-cache.js';
import { sha256Hex } from '../src/core/sha256.js';

const PDF = strToU8('local synthetic PDF');
const BODY = 'Synthetic paper body with precise source mapping.';
const MAP = [{ markdownFrom: 0, markdownTo: BODY.length, locations: [{ pageIndex: 0, bbox: [100, 100, 900, 300] }] }];
const item = (overrides = {}) => ({
    id: 42, key: 'ATTACH01', libraryID: 1, attachmentFilename: 'paper.pdf',
    isPDFAttachment: () => true, getFilePathAsync: async () => '/profile/paper.pdf',
    getDisplayTitle: () => 'Attachment', parentItem: { getDisplayTitle: () => 'Parent Paper' }, ...overrides,
});

async function fixture(overrides = {}) {
    const entries = [
        { path: 'full.md', data: strToU8(BODY) },
        { path: 'content_list.json', data: strToU8(JSON.stringify([{ type: 'text', text: BODY, page_idx: 0, bbox: [100, 100, 900, 300] }])) },
    ];
    const snapshotHash = await hashCanonicalLLMEntries(entries);
    const identity = await createLLMCacheIdentity({ fileData: PDF, snapshotHash });
    let selection = {
        libraryID: 1, attachmentKey: 'ATTACH01', sourceHash: identity.sourceHash,
        snapshotHash, rawKey: identity.rawKey, adapterVersion: identity.adapterVersion,
        importedAt: 100, binding: 'user-confirmed',
    };
    const cached = new Map();
    const records = new Map();
    let fileReads = 0;
    let remoteCalls = 0;
    let prepareCalls = 0;
    const index = {
        async selectionsForAttachment(key) {
            return selection && key.libraryID === selection.libraryID && key.attachmentKey === selection.attachmentKey ? [{ ...selection }] : [];
        },
        async get(key) {
            return selection && key.libraryID === selection.libraryID && key.attachmentKey === selection.attachmentKey
                && key.sourceHash === selection.sourceHash ? { ...selection } : null;
        },
        async forget(key, { expectedRecord }) {
            if (selection?.snapshotHash !== expectedRecord.snapshotHash || selection?.importedAt !== expectedRecord.importedAt) return false;
            selection = null;
            return true;
        },
    };
    const cache = { async get(key) { return cached.get(key) || null; }, async put(key, value) { cached.set(key, value); } };
    const resultStore = { async get(key) { return records.get(key) || null; } };
    const extractor = new ImportedMinerUDocumentExtractor({
        zotero: { Items: { getAsync: async () => item() } },
        readFile: async () => { fileReads++; return PDF; },
        createSourceHash: sha256Hex,
        index, cache, resultStore, isCacheEnabled: () => true,
        prepareResult: async raw => { prepareCalls++; return { ...raw, markdown: BODY, sourceMap: MAP, totalPages: 1 }; },
        recoverFigures: async result => result,
        conversion: { async convert() { remoteCalls++; throw new Error('must not access network'); } },
        ...overrides,
    });
    return {
        extractor, identity, cached, records, index, cache, entries,
        archive: zipSync(Object.fromEntries(entries.map(entry => [entry.path, entry.data]))),
        select(value) { selection = value; }, selection: () => selection,
        counts: () => ({ fileReads, remoteCalls, prepareCalls }),
    };
}

const readable = () => ({ markdown: BODY, sourceMap: MAP, assets: [], extractedPages: 1, totalPages: 1 });

test('returns null only when this attachment and current PDF have no selected import', async () => {
    const f = await fixture();
    f.select(null);
    assert.equal(await f.extractor.lookup(42), null);
    assert.equal(await f.extractor.extract(42), null);
    assert.equal(await f.extractor.readCached(42), null);
    assert.equal(await f.extractor.getIdentity(42), null);
    assert.equal(await f.extractor.cacheKeyFor(42), null);
    assert.equal(f.counts().remoteCalls, 0);
    assert.equal(f.counts().fileReads, 0);
});

test('reads imported derived content without accessing its old source or any remote client', async () => {
    const f = await fixture();
    f.cached.set(f.identity.cacheKey, readable());
    const result = await f.extractor.extract(42);
    assert.equal(result.markdown, BODY);
    assert.equal(result.provider, 'llm-for-zotero');
    assert.equal(result.cacheKey, f.identity.cacheKey);
    assert.equal(result.parserProfile, f.identity.parserProfile);
    assert.equal(result.sourceHash, f.identity.sourceHash);
    assert.equal(result.title, 'Parent Paper');
    assert.equal(result.cacheHit, true);
    assert.equal(await f.extractor.cacheKeyFor(42), f.identity.cacheKey);
    assert.equal(f.counts().prepareCalls, 0);
    assert.equal(f.counts().remoteCalls, 0);
});

test('rebuilds derived content offline from the retained adapted package after expiry or a pipeline change', async () => {
    const f = await fixture();
    f.records.set(f.identity.rawKey, { archive: f.archive, provider: 'llm-for-zotero', totalPages: 1, extractedPages: 1 });
    const result = await f.extractor.readCached(42);
    assert.equal(result.markdown, BODY);
    assert.equal(result.totalPages, 1);
    assert.equal(f.cached.get(f.identity.cacheKey).markdown, BODY);
    assert.equal(f.counts().prepareCalls, 1);
    assert.equal(f.counts().remoteCalls, 0);
});

test('missing retained content reports the exact old selection without rereading PDF bytes', async () => {
    const f = await fixture();
    const previous = { ...f.selection() };
    // A new selection can arrive while the old raw package is being looked up.
    f.extractor.resultStore.get = async () => {
        f.select({ ...previous, importedAt: previous.importedAt + 1 });
        return null;
    };
    let missing;
    await assert.rejects(f.extractor.extract(42), error => {
        assert.equal(error.code, 'LLM_CACHE_IMPORT_UNAVAILABLE');
        assert.equal(error.reason, 'content-missing');
        assert.deepEqual(error.selection, previous);
        missing = error;
        return true;
    });
    assert.equal(f.counts().fileReads, 1);
    assert.equal(await f.extractor.forgetSelection(missing.selection), false);
    assert.equal(f.selection().importedAt, previous.importedAt + 1);
    assert.equal(f.counts().fileReads, 1);
});

test('retains a selected unavailable source and reports a typed error instead of a cache miss', async () => {
    const f = await fixture();
    for (const method of ['extract', 'readCached']) {
        await assert.rejects(f.extractor[method](42), error => {
            assert.equal(error.code, 'LLM_CACHE_IMPORT_UNAVAILABLE');
            assert.equal(error.reason, 'content-missing');
            assert.deepEqual(error.selection, f.selection());
            return true;
        });
    }
    assert.ok(f.selection());
    assert.equal(f.counts().remoteCalls, 0);
});

test('rejects a retained package that no longer matches its selected snapshot', async () => {
    const f = await fixture();
    f.records.set(f.identity.rawKey, { archive: zipSync({ 'full.md': strToU8('Tampered'), 'content_list.json': strToU8('[]') }), provider: 'llm-for-zotero' });
    await assert.rejects(f.extractor.extract(42), error => error.code === 'LLM_CACHE_IMPORT_UNAVAILABLE' && error.reason === 'snapshot-mismatch');
    assert.equal(f.cached.size, 0);
    assert.ok(f.selection());
});

test('does not turn a disabled imported cache into a miss or remote conversion', async () => {
    const f = await fixture({ isCacheEnabled: () => false });
    f.cached.set(f.identity.cacheKey, readable());
    await assert.rejects(f.extractor.extract(42), error => error.code === 'LLM_CACHE_IMPORT_UNAVAILABLE' && error.reason === 'cache-disabled');
    assert.ok(await f.extractor.lookup(42));
    assert.equal(f.counts().remoteCalls, 0);
});

test('reads same-snapshot corrected revisions even when ordinary cache content has expired', async () => {
    let key;
    const f = await fixture({
        readRevision: async options => options.cacheKey === key ? { markdown: '', sourceMap: [], assets: [] } : null,
        prepareResult: async result => result,
        recoverFigures: async () => { throw new Error('must not rewrite a saved correction'); },
    });
    key = f.identity.cacheKey;
    const corrected = await f.extractor.extract(42);
    assert.equal(corrected.userEdited, true);
    assert.equal(corrected.markdown, '');
    assert.equal(corrected.cacheKey, key);
});

test('only looks for historical corrections inside the same imported snapshot', async () => {
    let oldProfile;
    let oldKey;
    const visited = [];
    const f = await fixture({
        getPreviousParserProfiles: snapshotHash => [createLLMCacheParserProfile(snapshotHash, { document: 'older-imported-pipeline' })],
        readRevision: async ({ cacheKey }) => {
            visited.push(cacheKey);
            return cacheKey === oldKey ? { ...readable(), markdown: `${BODY} Corrected older import` } : null;
        },
        prepareResult: async value => value,
    });
    oldProfile = createLLMCacheParserProfile(f.identity.snapshotHash, { document: 'older-imported-pipeline' });
    oldKey = await createMarkdownCacheKey(PDF, { parserProfile: oldProfile });
    const result = await f.extractor.extract(42);
    assert.equal(result.markdown, `${BODY} Corrected older import`);
    assert.equal(result.cacheKey, oldKey);
    assert.equal(result.parserProfile, oldProfile);
    assert.deepEqual(visited, [f.identity.cacheKey, oldKey]);
});

test('uses exact attachment identity and PDF bytes to look up a selection', async () => {
    const otherAttachment = await fixture({ zotero: { Items: { getAsync: async () => item({ key: 'ATTACH02' }) } } });
    assert.equal(await otherAttachment.extractor.extract(42), null);
    const changedPDF = await fixture({ readFile: async () => strToU8('new PDF content') });
    assert.equal(await changedPDF.extractor.extract(42), null);
});

test('forgets only the original selection after successful explicit reparse without rereading PDF bytes', async () => {
    const f = await fixture();
    const selected = await f.extractor.lookup(42);
    const reads = f.counts().fileReads;
    f.select({ ...selected, importedAt: 200, snapshotHash: 'e'.repeat(64) });
    assert.equal(await f.extractor.forgetSelection(selected), false);
    assert.ok(f.selection());
    const next = f.selection();
    assert.equal(await f.extractor.forgetSelection(next), true);
    assert.equal(f.selection(), null);
    assert.equal(f.counts().fileReads, reads);
});

test('leaves unselected PDFs to their normal provider without reading local PDF bytes or imposing import limits', async () => {
    const f = await fixture({
        readFile: async () => { throw new Error('unselected PDF bytes must not be read'); },
    });
    f.select(null);
    assert.equal(await f.extractor.extract(42), null);
    assert.equal(await f.extractor.readCached(42), null);
});

test('checks disabled caching before opening a revision or reading any derived imported content', async () => {
    const f = await fixture({
        isCacheEnabled: () => false,
        readRevision: async () => { throw new Error('disabled imported revisions must not be read'); },
        cache: { async get() { throw new Error('disabled imported cache must not be read'); } },
    });
    await assert.rejects(f.extractor.extract(42), error => error.reason === 'cache-disabled');
});

test('rejects cached documents whose source map references a page beyond their PDF page count', async () => {
    const f = await fixture();
    f.cached.set(f.identity.cacheKey, { ...readable(), sourceMap: [{ ...MAP[0], locations: [{ pageIndex: 1, bbox: [100, 100, 900, 300] }] }] });
    await assert.rejects(f.extractor.readCached(42), error => error.reason === 'document-invalid');
});

test('rejects cached documents with missing local or remote image references', async () => {
    for (const destination of ['images/missing.png', 'https://example.invalid/tracker.png']) {
        const f = await fixture();
        f.cached.set(f.identity.cacheKey, { ...readable(), markdown: `${BODY}\n\n![Figure](${destination})` });
        await assert.rejects(f.extractor.readCached(42), error => error.reason === 'document-images-invalid');
    }
});

test('resolves image paths relative to the cached document asset base without rejecting a valid figure', async () => {
    const f = await fixture();
    f.cached.set(f.identity.cacheKey, {
        ...readable(), markdown: `${BODY}\n\n![Figure](images/figure.png)`, assetBasePath: 'paper',
        assets: [{ path: 'paper/images/figure.png', mimeType: 'image/png', data: new Uint8Array([137, 80, 78, 71]) }],
    });
    const result = await f.extractor.extract(42);
    assert.equal(result.assets.length, 1);
});

test('propagates index failure and cancellation without changing selection or using the network', async () => {
    const failure = Object.assign(new Error('broken imported index'), { code: 'LLM_CACHE_IMPORT_INDEX_INVALID' });
    const f = await fixture({ index: {
        async selectionsForAttachment() { throw failure; },
        async get() { throw failure; },
    } });
    await assert.rejects(f.extractor.extract(42), error => error === failure);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(f.extractor.extract(42, { signal: controller.signal }), error => error.name === 'AbortError');
    assert.equal(f.counts().remoteCalls, 0);
});
