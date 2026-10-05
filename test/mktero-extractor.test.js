import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MkteroDocumentExtractor,
    MkteroSignInRequiredError,
} from '../src/extractors/mktero-extractor.js';
import { MINERU_PARSER_PROFILE_ID } from '../src/mineru/parser-profile.js';

function createPDFItem(overrides = {}) {
    return {
        id: 42,
        parentItem: { getDisplayTitle: () => 'Parent Paper' },
        attachmentFilename: 'paper.pdf',
        isPDFAttachment: () => true,
        getDisplayTitle: () => 'Attachment Title',
        getFilePathAsync: async () => '/tmp/paper.pdf',
        ...overrides,
    };
}

function createExtractor(overrides = {}) {
    return new MkteroDocumentExtractor({
        zotero: { Items: { getAsync: async () => createPDFItem() } },
        conversion: {
            async convert() {
                return {
                    result: { markdown: '# Hosted result' },
                    origin: 'network',
                    warnings: [],
                };
            },
        },
        getApiBase: () => 'http://127.0.0.1:8080',
        getAccessToken: () => 'access-token',
        readFile: async () => new Uint8Array([1, 2, 3]),
        ...overrides,
    });
}

test('converts through the hosted service and tags the MinerU profile', async () => {
    const calls = [];
    const fileData = new Uint8Array([1, 2, 3]);
    const extractor = createExtractor({
        conversion: {
            async convert(options) {
                calls.push(options);
                return {
                    result: { markdown: '# Hosted result' },
                    origin: 'network',
                    warnings: [],
                };
            },
        },
        readFile: async path => {
            assert.equal(path, '/tmp/paper.pdf');
            return fileData;
        },
        createCacheKey: async (value, options) => {
            assert.equal(value, fileData);
            assert.equal(options.parserProfile, MINERU_PARSER_PROFILE_ID);
            return 'a'.repeat(64);
        },
        createSourceHash: async () => 'e'.repeat(64),
        isCacheEnabled: () => true,
    });
    const controller = new AbortController();

    const result = await extractor.extract(42, { signal: controller.signal });

    assert.equal(result.provider, 'mktero');
    assert.equal(result.parserProfile, MINERU_PARSER_PROFILE_ID);
    assert.equal(result.title, 'Parent Paper');
    assert.equal(result.markdown, '# Hosted result');
    assert.equal(result.cacheHit, false);
    assert.equal(result.sourceHash, 'e'.repeat(64));
    assert.equal(calls[0].apiBase, 'http://127.0.0.1:8080');
    assert.equal(calls[0].getAccessToken(), 'access-token');
    assert.equal(calls[0].fileName, 'paper.pdf');
    assert.equal(calls[0].fileData, fileData);
});

test('runs the shared figure pipeline on the hosted result', async () => {
    const prepared = [];
    const extractor = createExtractor({
        prepareResult: async (raw, context) => {
            prepared.push(['prepare', raw.markdown, context.signal]);
            return { ...raw, markdown: `${raw.markdown} prepared` };
        },
        recoverFigures: async (result, context) => {
            prepared.push(['figures', result.markdown, context.signal]);
            return { ...result, markdown: `${result.markdown} figures` };
        },
    });
    const controller = new AbortController();

    const result = await extractor.extract(42, { signal: controller.signal });

    assert.equal(result.markdown, '# Hosted result prepared figures');
    assert.deepEqual(prepared.map(entry => entry[0]), ['prepare', 'figures']);
    assert.ok(prepared.every(entry => entry[2] === controller.signal));
});

test('surfaces a signed-out user as a configuration error', async () => {
    const extractor = createExtractor({
        conversion: {
            async convert() {
                const error = new Error('Sign in to Mktero before converting');
                error.code = 'MKTERO_SIGN_IN_REQUIRED';
                throw error;
            },
        },
    });

    await assert.rejects(
        extractor.extract(42, {}),
        error => error instanceof MkteroSignInRequiredError
            && error.code === 'MKTERO_SIGN_IN_REQUIRED'
    );
});

test('reuses a cached conversion without calling the hosted service', async () => {
    let converted = false;
    const extractor = createExtractor({
        conversion: {
            async convert() {
                converted = true;
                return { result: { markdown: 'fresh' }, origin: 'network' };
            },
        },
        createCacheKey: async () => 'a'.repeat(64),
        isCacheEnabled: () => true,
        cache: {
            async get(key) {
                assert.equal(key, 'a'.repeat(64));
                return { markdown: '# Cached' };
            },
            async put() {
                throw new Error('a cache hit must not be written again');
            },
        },
    });

    const result = await extractor.extract(42, {});

    assert.equal(converted, false);
    assert.equal(result.markdown, '# Cached');
    assert.equal(result.cacheHit, true);
    assert.equal(result.cacheKey, 'a'.repeat(64));
});

test('saves a hosted conversion to the local cache', async () => {
    const saved = [];
    const extractor = createExtractor({
        createCacheKey: async () => 'b'.repeat(64),
        isCacheEnabled: () => true,
        cache: {
            async get() {
                return null;
            },
            async put(key, result) {
                saved.push([key, result.markdown]);
            },
        },
        prepareResult: async raw => ({ ...raw, markdown: `${raw.markdown} prepared` }),
        recoverFigures: async result => ({ ...result, markdown: `${result.markdown} figures` }),
    });

    const result = await extractor.extract(42, {});

    assert.equal(result.cacheHit, false);
    assert.deepEqual(saved, [['b'.repeat(64), '# Hosted result prepared figures']]);
});

test('does not read or write the cache when reuse is disabled', async () => {
    let reads = 0;
    let writes = 0;
    const extractor = createExtractor({
        createCacheKey: async () => 'c'.repeat(64),
        isCacheEnabled: () => false,
        cache: {
            async get() {
                reads += 1;
                return { markdown: '# Cached' };
            },
            async put() {
                writes += 1;
            },
        },
    });

    const result = await extractor.extract(42, {});

    assert.equal(result.markdown, '# Hosted result');
    assert.equal(result.cacheHit, false);
    assert.equal(reads, 1);
    assert.equal(writes, 0);
});

test('still opens a user-edited cache entry when reuse is disabled', async () => {
    let converted = false;
    const extractor = createExtractor({
        conversion: {
            async convert() {
                converted = true;
                return { result: { markdown: 'fresh' }, origin: 'network' };
            },
        },
        createCacheKey: async () => 'd'.repeat(64),
        isCacheEnabled: () => false,
        cache: {
            async get() {
                return { markdown: '# Edited locally', userEdited: true };
            },
        },
    });

    const result = await extractor.extract(42, {});

    assert.equal(converted, false);
    assert.equal(result.markdown, '# Edited locally');
    assert.equal(result.cacheHit, true);
});

test('reuses a stored revision without calling the hosted service', async () => {
    let converted = false;
    const extractor = createExtractor({
        conversion: {
            async convert() {
                converted = true;
                return { result: { markdown: 'fresh' }, origin: 'network' };
            },
        },
        createCacheKey: async () => 'a'.repeat(64),
        readRevision: async () => ({ markdown: '# Edited', userEdited: true }),
    });

    const result = await extractor.extract(42, {});

    assert.equal(converted, false);
    assert.equal(result.markdown, '# Edited');
    assert.equal(result.cacheHit, true);
});

test('rejects a non-PDF attachment', async () => {
    const extractor = createExtractor({
        zotero: {
            Items: { getAsync: async () => createPDFItem({ isPDFAttachment: () => false }) },
        },
    });

    await assert.rejects(extractor.extract(42, {}), /Only PDF attachments/);
});
