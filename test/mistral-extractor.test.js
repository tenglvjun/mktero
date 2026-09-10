import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MistralConfigurationError,
    MistralDocumentExtractor,
} from '../src/extractors/mistral-extractor.js';
import { MISTRAL_PARSER_PROFILE_ID } from '../src/mistral/parser-profile.js';

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

test('reads a PDF and delegates to synchronous Mistral conversion', async () => {
    const calls = [];
    const fileData = new Uint8Array([1, 2, 3]);
    const extractor = new MistralDocumentExtractor({
        zotero: { Items: { getAsync: async () => createPDFItem() } },
        conversion: {
            async convert(options) {
                calls.push(options);
                return {
                    result: {
                        markdown: '# Mistral result',
                        assets: [{ path: 'figure.png', mimeType: 'image/png', data: [1] }],
                        sourceMap: [],
                        chromeRanges: [{ from: 0, to: 2 }],
                        extractedPages: 2,
                        totalPages: 2,
                    },
                    origin: 'fresh',
                    warnings: [],
                };
            },
        },
        getApiKey: () => 'mistral-secret',
        readFile: async path => {
            assert.equal(path, '/tmp/paper.pdf');
            return fileData;
        },
        createCacheKey: async (value, options) => {
            assert.equal(value, fileData);
            assert.equal(options.parserProfile, MISTRAL_PARSER_PROFILE_ID);
            return 'a'.repeat(64);
        },
        createSourceHash: async value => {
            assert.equal(value, fileData);
            return 'e'.repeat(64);
        },
        isCacheEnabled: () => true,
    });
    const controller = new AbortController();

    const result = await extractor.extract(42, { signal: controller.signal });

    assert.equal(result.kind, 'markdown');
    assert.equal(result.provider, 'mistral');
    assert.equal(result.parserProfile, MISTRAL_PARSER_PROFILE_ID);
    assert.equal(result.title, 'Parent Paper');
    assert.equal(result.markdown, '# Mistral result');
    assert.equal(result.cacheHit, false);
    assert.equal(result.resumedTask, false);
    assert.equal(result.sourceHash, 'e'.repeat(64));
    assert.equal(result.extractedPages, 2);
    assert.equal(result.totalPages, 2);
    assert.deepEqual(result.chromeRanges, [{ from: 0, to: 2 }]);
    assert.deepEqual(result.assets, [{
        path: 'figure.png',
        mimeType: 'image/png',
        data: [1],
    }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].apiKey, 'mistral-secret');
    assert.equal(calls[0].key, 'a'.repeat(64));
    assert.equal(calls[0].cacheEnabled, true);
    assert.equal(calls[0].signal, controller.signal);
});

test('prepares the PDF index without delaying conversion', async () => {
    const fileData = new Uint8Array([1]);
    let indexStarted = false;
    let releaseIndex;
    const indexDone = new Promise(resolve => { releaseIndex = resolve; });
    const controller = new AbortController();
    const extractor = new MistralDocumentExtractor({
        zotero: { Items: { getAsync: async () => createPDFItem() } },
        conversion: {
            async convert() {
                assert.equal(indexStarted, true);
                return { result: { markdown: '# Indexed' }, origin: 'fresh', warnings: [] };
            },
        },
        getApiKey: () => 'secret',
        readFile: async () => fileData,
        preparePDFIndex(itemID, options) {
            assert.equal(itemID, 42);
            assert.equal(options.fileData, fileData);
            assert.equal(options.signal, controller.signal);
            indexStarted = true;
            return indexDone;
        },
    });

    const result = await extractor.extract(42, { signal: controller.signal });
    assert.equal(result.markdown, '# Indexed');
    releaseIndex();
    await indexDone;
});

test('returns a persisted correction without calling Mistral', async () => {
    const cacheKey = 'b'.repeat(64);
    let converted = false;
    const revision = {
        markdown: '# Corrected',
        assets: [],
        sourceMap: [],
        extractedPages: 1,
        totalPages: 1,
    };
    const extractor = new MistralDocumentExtractor({
        zotero: { Items: { getAsync: async () => createPDFItem() } },
        conversion: { convert: async () => { converted = true; } },
        getApiKey: () => '',
        readFile: async () => new Uint8Array([1]),
        createCacheKey: async () => cacheKey,
        readRevision: async options => {
            assert.deepEqual(options, {
                itemID: 42,
                cacheKey,
                signal: undefined,
            });
            return revision;
        },
    });

    const result = await extractor.extract(42, { onProgress: () => {} });

    assert.equal(converted, false);
    assert.equal(result.markdown, '# Corrected');
    assert.equal(result.provider, 'mistral');
    assert.equal(result.userEdited, true);
    assert.equal(result.cacheHit, true);
    assert.equal(result.resumedTask, false);
    assert.equal(result.cacheKey, cacheKey);
});

test('maps a missing Mistral API key to a configuration error', async () => {
    const extractor = new MistralDocumentExtractor({
        zotero: { Items: { getAsync: async () => createPDFItem() } },
        conversion: {
            convert: async () => {
                const error = new Error('A Mistral API key is required');
                error.code = 'MISTRAL_API_KEY_REQUIRED';
                throw error;
            },
        },
        getApiKey: () => '',
        readFile: async () => new Uint8Array([1]),
    });

    await assert.rejects(
        () => extractor.extract(42),
        error => error instanceof MistralConfigurationError
            && error.code === 'MISTRAL_API_KEY_REQUIRED'
    );
});

test('keeps cache and index failures non-fatal', async () => {
    const cacheError = new Error('hash unavailable');
    const indexError = new Error('index unavailable');
    const cacheErrors = [];
    const indexErrors = [];
    const extractor = new MistralDocumentExtractor({
        zotero: { Items: { getAsync: async () => createPDFItem() } },
        conversion: {
            async convert(options) {
                assert.equal(options.key, null);
                return {
                    result: { markdown: '# Online' },
                    origin: 'fresh',
                    warnings: [],
                };
            },
        },
        getApiKey: () => 'secret',
        readFile: async () => new Uint8Array([1]),
        createCacheKey: async () => { throw cacheError; },
        preparePDFIndex: async () => { throw indexError; },
        onCacheError: error => cacheErrors.push(error),
        onPDFIndexError: error => indexErrors.push(error),
    });

    const result = await extractor.extract(42);
    assert.equal(result.markdown, '# Online');
    assert.deepEqual(result.warnings, ['The local Markdown cache is unavailable.']);
    assert.deepEqual(cacheErrors, [cacheError]);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(indexErrors, [indexError]);
});
