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

test('reads the current Zotero PDF and delegates conversion', async () => {
    const calls = [];
    const extractor = new MinerUDocumentExtractor({
        zotero: { Items: { getAsync: async () => createPDFItem() } },
        conversion: {
            async convert(options) {
                calls.push(options);
                return {
                    result: {
                        markdown: '# MinerU result',
                        extractedPages: 3,
                        totalPages: 3,
                    },
                    origin: 'fresh',
                    warnings: [],
                };
            },
        },
        getApiKey: () => 'configured-token',
        readFile: async filePath => {
            assert.equal(filePath, '/tmp/paper.pdf');
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
    assert.equal(result.cacheHit, false);
    assert.equal(result.resumedTask, false);
    assert.equal(calls[0].apiKey, 'configured-token');
    assert.equal(calls[0].fileName, 'paper.pdf');
    assert.equal(calls[0].key, null);
    assert.equal(calls[0].cacheEnabled, false);
    assert.equal(calls[0].signal, controller.signal);
    assert.deepEqual([...calls[0].fileData], [1, 2, 3]);
    calls[0].onProgress(50);
    assert.deepEqual(progress, [50]);
});

test('prepares the offline PDF index in parallel with MinerU conversion', async () => {
    const fileData = new Uint8Array([1, 2, 3]);
    const controller = new AbortController();
    let indexStarted = false;
    let finishIndex;
    const indexFinished = new Promise(resolve => { finishIndex = resolve; });
    const extractor = new MinerUDocumentExtractor({
        zotero: { Items: { getAsync: async () => createPDFItem() } },
        conversion: {
            async convert() {
                assert.equal(indexStarted, true);
                return {
                    result: { markdown: '# Indexed result' },
                    origin: 'fresh',
                    warnings: [],
                };
            },
        },
        getApiKey: () => 'configured-token',
        readFile: async () => fileData,
        preparePDFIndex(itemID, options) {
            assert.equal(itemID, 42);
            assert.equal(options.fileData, fileData);
            assert.equal(options.signal, controller.signal);
            indexStarted = true;
            return indexFinished;
        },
    });

    const result = await extractor.extract(42, {
        signal: controller.signal,
    });

    assert.equal(result.markdown, '# Indexed result');
    finishIndex();
    await indexFinished;
});

test('requires a configured MinerU API token after a cache miss', async () => {
    const extractor = new MinerUDocumentExtractor({
        zotero: { Items: { getAsync: async () => createPDFItem() } },
        conversion: {
            async convert() {
                throw new Error('A MinerU API Token is required');
            },
        },
        getApiKey: () => '  ',
        readFile: async () => new Uint8Array(),
    });

    await assert.rejects(
        () => extractor.extract(42),
        error => error instanceof MinerUConfigurationError
    );
});

test('reports a missing local attachment file before conversion', async () => {
    const extractor = new MinerUDocumentExtractor({
        zotero: {
            Items: {
                getAsync: async () => createPDFItem({
                    getFilePathAsync: async () => false,
                }),
            },
        },
        conversion: {
            convert: async () => assert.fail('conversion must not start'),
        },
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
        conversion: {
            async convert(options) {
                assert.equal(options.apiKey, '');
                assert.equal(options.key, cacheKey);
                assert.equal(options.cacheEnabled, true);
                options.onProgress(100);
                return {
                    result: {
                        markdown: '# Cached MinerU result',
                        assets: [],
                        extractedPages: 3,
                        totalPages: 3,
                    },
                    origin: 'cache',
                    warnings: [],
                };
            },
        },
        getApiKey: () => '',
        readFile: async () => new Uint8Array([1, 2, 3]),
        createCacheKey: async () => cacheKey,
        isCacheEnabled: () => true,
    });

    const result = await extractor.extract(42, {
        onProgress: value => progress.push(value),
    });

    assert.equal(result.markdown, '# Cached MinerU result');
    assert.equal(result.cacheHit, true);
    assert.equal(result.cacheKey, cacheKey);
    assert.deepEqual(progress, [100]);
});

test('passes cache and force-refresh policy through the conversion interface', async () => {
    const calls = [];
    const extractor = new MinerUDocumentExtractor({
        zotero: { Items: { getAsync: async () => createPDFItem() } },
        conversion: {
            async convert(options) {
                calls.push(options);
                return {
                    result: { markdown: '# Reparsed result' },
                    origin: 'fresh',
                    warnings: [],
                };
            },
        },
        getApiKey: () => 'configured-token',
        readFile: async () => new Uint8Array([1]),
        createCacheKey: async () => 'b'.repeat(64),
        isCacheEnabled: () => true,
    });

    await extractor.extract(42, { forceRefresh: true });

    assert.equal(calls[0].cacheEnabled, true);
    assert.equal(calls[0].forceRefresh, true);
});

test('continues without recovery when the conversion key cannot be created', async () => {
    const cacheError = new Error('SHA-256 unavailable');
    const logged = [];
    const extractor = new MinerUDocumentExtractor({
        zotero: { Items: { getAsync: async () => createPDFItem() } },
        conversion: {
            async convert(options) {
                assert.equal(options.key, null);
                return {
                    result: { markdown: '# Online result' },
                    origin: 'fresh',
                    warnings: [],
                };
            },
        },
        getApiKey: () => 'configured-token',
        readFile: async () => new Uint8Array([1]),
        createCacheKey: async () => { throw cacheError; },
        isCacheEnabled: () => true,
        onCacheError: error => logged.push(error),
    });

    const result = await extractor.extract(42);

    assert.equal(result.markdown, '# Online result');
    assert.match(result.warnings[0], /cache/i);
    assert.deepEqual(logged, [cacheError]);
});

test('normalizes MinerU Markdown and exposes its PDF source map', async () => {
    const source = 'The framework improves the ability to change perspective on\n\n'
        + 'an event), and context engagement.';
    const extractor = new MinerUDocumentExtractor({
        zotero: { Items: { getAsync: async () => createPDFItem() } },
        conversion: {
            async convert() {
                return {
                    result: {
                        markdown: source,
                        contentList: [{
                            type: 'text',
                            text: 'The framework improves the ability to change perspective on',
                            pageIndex: 0,
                            bbox: [100, 120, 900, 220],
                        }, {
                            type: 'text',
                            text: 'an event), and context engagement.',
                            pageIndex: 1,
                            bbox: [100, 80, 900, 160],
                        }],
                    },
                    origin: 'fresh',
                    warnings: [],
                };
            },
        },
        getApiKey: () => 'configured-token',
        readFile: async () => new Uint8Array([1]),
    });

    const result = await extractor.extract(42);

    assert.equal(
        result.markdown,
        'The framework improves the ability to change perspective on '
            + 'an event), and context engagement.'
    );
    assert.equal(source.includes('\n\n'), true);
    assert.deepEqual(result.sourceMap, [{
        type: 'text',
        markdownFrom: 0,
        markdownTo: result.markdown.length,
        locations: [
            { pageIndex: 0, bbox: [100, 120, 900, 220] },
            { pageIndex: 1, bbox: [100, 80, 900, 160] },
        ],
    }]);
});

test('does not normalize Markdown explicitly edited by the user', async () => {
    const markdown = 'The user intentionally leaves this text without punctuation\n\n'
        + 'and starts the next paragraph in lowercase.';
    const extractor = new MinerUDocumentExtractor({
        zotero: { Items: { getAsync: async () => createPDFItem() } },
        conversion: {
            async convert() {
                return {
                    result: { markdown, userEdited: true },
                    origin: 'cache',
                    warnings: [],
                };
            },
        },
        getApiKey: () => '',
        readFile: async () => new Uint8Array([1]),
    });

    assert.equal((await extractor.extract(42)).markdown, markdown);
});

test('reports when a pending MinerU task was resumed', async () => {
    const extractor = new MinerUDocumentExtractor({
        zotero: { Items: { getAsync: async () => createPDFItem() } },
        conversion: {
            async convert() {
                return {
                    result: { markdown: '# Resumed result' },
                    origin: 'resumed',
                    warnings: [],
                };
            },
        },
        getApiKey: () => 'configured-token',
        readFile: async () => new Uint8Array([1]),
    });

    const result = await extractor.extract(42);

    assert.equal(result.cacheHit, false);
    assert.equal(result.resumedTask, true);
});
