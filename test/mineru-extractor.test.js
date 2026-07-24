import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MinerUConfigurationError,
    MinerUDocumentExtractor,
} from '../src/extractors/mineru-extractor.js';

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

test('reads the current Zotero PDF and sends it to MinerU', async () => {
    const calls = [];
    const extractor = new MinerUDocumentExtractor({
        zotero: { Items: { getAsync: async () => createPDFItem() } },
        client: {
            parse: async options => {
                calls.push(options);
                return {
                    markdown: '# MinerU result',
                    extractedPages: 3,
                    totalPages: 3,
                };
            },
        },
        getApiKey: () => 'configured-token',
        readFile: async path => {
            assert.equal(path, '/tmp/paper.pdf');
            return new Uint8Array([1, 2, 3]);
        },
    });
    const progress = [];
    const controller = new AbortController();

    const result = await extractor.extract(42, {
        onProgress: value => progress.push(value),
        signal: controller.signal,
    });

    assert.equal(result.kind, 'markdown');
    assert.equal(result.title, 'Parent Paper');
    assert.equal(result.markdown, '# MinerU result');
    assert.equal(calls[0].apiKey, 'configured-token');
    assert.equal(calls[0].fileName, 'paper.pdf');
    assert.equal(calls[0].dataID, 'zotero-42');
    assert.equal(calls[0].signal, controller.signal);
    assert.deepEqual([...calls[0].fileData], [1, 2, 3]);
    calls[0].onProgress(50);
    assert.deepEqual(progress, [50]);
});

test('requires a configured MinerU API token', async () => {
    const extractor = new MinerUDocumentExtractor({
        zotero: { Items: { getAsync: async () => createPDFItem() } },
        client: { parse: async () => assert.fail('MinerU should not be called') },
        getApiKey: () => '  ',
        readFile: async () => new Uint8Array(),
    });

    await assert.rejects(
        () => extractor.extract(42),
        error => error instanceof MinerUConfigurationError
    );
});

test('reports a missing local attachment file', async () => {
    const extractor = new MinerUDocumentExtractor({
        zotero: {
            Items: {
                getAsync: async () => createPDFItem({ getFilePathAsync: async () => false }),
            },
        },
        client: { parse: async () => assert.fail('MinerU should not be called') },
        getApiKey: () => 'configured-token',
        readFile: async () => new Uint8Array(),
    });

    await assert.rejects(
        () => extractor.extract(42),
        /local PDF file is unavailable/i
    );
});

test('returns a cached result without requiring a MinerU API token', async () => {
    const progress = [];
    const cacheKey = 'a'.repeat(64);
    const extractor = new MinerUDocumentExtractor({
        zotero: { Items: { getAsync: async () => createPDFItem() } },
        client: { parse: async () => assert.fail('MinerU should not be called') },
        getApiKey: () => '',
        readFile: async () => new Uint8Array([1, 2, 3]),
        cache: {
            get: async key => {
                assert.equal(key, cacheKey);
                return {
                    markdown: '# Cached MinerU result',
                    assets: [],
                    assetBasePath: '',
                    extractedPages: 3,
                    totalPages: 3,
                };
            },
            put: async () => assert.fail('A cache hit must not be rewritten'),
        },
        createCacheKey: async fileData => {
            assert.deepEqual([...fileData], [1, 2, 3]);
            return cacheKey;
        },
        isCacheEnabled: () => true,
    });

    const result = await extractor.extract(42, {
        onProgress: value => progress.push(value),
    });

    assert.equal(result.title, 'Parent Paper');
    assert.equal(result.markdown, '# Cached MinerU result');
    assert.equal(result.cacheHit, true);
    assert.deepEqual(progress, [100]);
});

test('stores a successful MinerU result after a cache miss', async () => {
    const cacheKey = 'b'.repeat(64);
    let stored;
    const minerUResult = {
        markdown: '# Fresh MinerU result',
        assets: [{
            path: 'result/images/figure.png',
            mimeType: 'image/png',
            data: new Uint8Array([1, 2, 3]),
        }],
        assetBasePath: 'result',
        extractedPages: 2,
        totalPages: 2,
    };
    const extractor = new MinerUDocumentExtractor({
        zotero: { Items: { getAsync: async () => createPDFItem() } },
        client: { parse: async () => minerUResult },
        getApiKey: () => 'configured-token',
        readFile: async () => new Uint8Array([4, 5, 6]),
        cache: {
            get: async key => {
                assert.equal(key, cacheKey);
                return null;
            },
            put: async (key, value) => {
                stored = { key, value };
            },
        },
        createCacheKey: async () => cacheKey,
        isCacheEnabled: () => true,
    });

    const result = await extractor.extract(42);

    assert.equal(result.markdown, '# Fresh MinerU result');
    assert.equal(result.cacheHit, false);
    assert.equal(stored.key, cacheKey);
    assert.equal(stored.value, minerUResult);
});

test('still returns MinerU Markdown when the cache cannot be written', async () => {
    const cacheError = new Error('disk full');
    const logged = [];
    const extractor = new MinerUDocumentExtractor({
        zotero: { Items: { getAsync: async () => createPDFItem() } },
        client: {
            parse: async () => ({
                markdown: '# Available result',
                extractedPages: 1,
                totalPages: 1,
            }),
        },
        getApiKey: () => 'configured-token',
        readFile: async () => new Uint8Array([1]),
        cache: {
            get: async () => null,
            put: async () => { throw cacheError; },
        },
        createCacheKey: async () => 'c'.repeat(64),
        isCacheEnabled: () => true,
        onCacheError: error => logged.push(error),
    });

    const result = await extractor.extract(42);

    assert.equal(result.markdown, '# Available result');
    assert.match(result.warnings[0], /cache/i);
    assert.deepEqual(logged, [cacheError]);
});

test('force refresh bypasses and replaces an existing cache entry', async () => {
    let stored;
    const extractor = new MinerUDocumentExtractor({
        zotero: { Items: { getAsync: async () => createPDFItem() } },
        client: {
            parse: async () => ({
                markdown: '# Reparsed result',
                extractedPages: 1,
                totalPages: 1,
            }),
        },
        getApiKey: () => 'configured-token',
        readFile: async () => new Uint8Array([1]),
        cache: {
            get: async () => assert.fail('force refresh must skip cache reads'),
            put: async (key, value) => { stored = { key, value }; },
        },
        createCacheKey: async () => 'd'.repeat(64),
        isCacheEnabled: () => true,
    });

    const result = await extractor.extract(42, { forceRefresh: true });

    assert.equal(result.markdown, '# Reparsed result');
    assert.equal(result.cacheHit, false);
    assert.equal(stored.key, 'd'.repeat(64));
    assert.equal(stored.value.markdown, '# Reparsed result');
});

test('falls back to MinerU when reading the local cache fails', async () => {
    const cacheError = new Error('cache permission denied');
    const logged = [];
    let parseCalls = 0;
    const extractor = new MinerUDocumentExtractor({
        zotero: { Items: { getAsync: async () => createPDFItem() } },
        client: {
            parse: async () => {
                parseCalls++;
                return {
                    markdown: '# Online result',
                    extractedPages: 1,
                    totalPages: 1,
                };
            },
        },
        getApiKey: () => 'configured-token',
        readFile: async () => new Uint8Array([1]),
        cache: {
            get: async () => { throw cacheError; },
            put: async () => {},
        },
        createCacheKey: async () => 'e'.repeat(64),
        isCacheEnabled: () => true,
        onCacheError: error => logged.push(error),
    });

    const result = await extractor.extract(42);

    assert.equal(parseCalls, 1);
    assert.equal(result.markdown, '# Online result');
    assert.match(result.warnings[0], /cache/i);
    assert.deepEqual(logged, [cacheError]);
});
