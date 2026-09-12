import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MistralConversion,
} from '../src/mistral/mistral-conversion.js';
import { MISTRAL_PARSER_PROFILE_ID } from '../src/mistral/parser-profile.js';

const KEY = 'a'.repeat(64);

test('returns a cached Mistral result without an OCR request', async () => {
    let requests = 0;
    const progress = [];
    const conversion = new MistralConversion({
        client: {
            ocr: async () => {
                requests++;
                throw new Error('OCR must not run for a cache hit');
            },
        },
        cache: {
            get: async key => {
                assert.equal(key, KEY);
                return { markdown: '# Cached', assets: [] };
            },
            put: async () => assert.fail('cache writes are not expected on a hit'),
        },
        prepareResult: value => value,
    });

    const result = await conversion.convert({
        key: KEY,
        apiKey: '',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1]),
        cacheEnabled: true,
        onProgress: value => progress.push(value),
    });

    assert.equal(result.origin, 'cache');
    assert.equal(result.result.markdown, '# Cached');
    assert.equal(result.result.provider, 'mistral');
    assert.equal(result.result.parserProfile, MISTRAL_PARSER_PROFILE_ID);
    assert.deepEqual(progress, [100]);
    assert.equal(requests, 0);
});

test('normalizes and caches a fresh Mistral result', async () => {
    const calls = [];
    let cached;
    const raw = { pages: [{ index: 0, markdown: '# Fresh' }] };
    const conversion = new MistralConversion({
        client: {
            async ocr(options) {
                calls.push(options);
                return raw;
            },
        },
        cache: {
            get: async () => null,
            put: async (key, value) => { cached = { key, value }; },
        },
        prepareResult: value => ({
            markdown: value.pages[0].markdown,
            assets: [],
            sourceMap: [],
        }),
    });
    const signal = new AbortController().signal;
    const onProgress = () => {};

    const result = await conversion.convert({
        key: KEY,
        apiKey: 'mistral-secret',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1, 2]),
        cacheEnabled: true,
        onProgress,
        signal,
    });

    assert.equal(result.origin, 'fresh');
    assert.equal(result.result.markdown, '# Fresh');
    assert.equal(result.result.provider, 'mistral');
    assert.equal(cached.key, KEY);
    assert.equal(cached.value.provider, 'mistral');
    assert.equal(cached.value.parserProfile, MISTRAL_PARSER_PROFILE_ID);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].apiKey, 'mistral-secret');
    assert.equal(calls[0].fileName, 'paper.pdf');
    assert.equal(calls[0].signal, signal);
    assert.equal(typeof calls[0].onProgress, 'function');
});

test('does not read or write cache when disabled or forced', async () => {
    let reads = 0;
    let writes = 0;
    let requests = 0;
    const conversion = new MistralConversion({
        client: {
            async ocr() {
                requests++;
                return { pages: [{ index: 0, markdown: '# Fresh' }] };
            },
        },
        cache: {
            get: async () => { reads++; return { markdown: '# Old' }; },
            put: async () => { writes++; },
        },
        prepareResult: value => ({ markdown: value.pages[0].markdown }),
    });

    await conversion.convert({
        key: KEY,
        apiKey: 'secret',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1]),
        cacheEnabled: false,
    });
    await conversion.convert({
        key: KEY,
        apiKey: 'secret',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1]),
        cacheEnabled: true,
        forceRefresh: true,
    });

    assert.equal(requests, 2);
    assert.equal(reads, 0);
    assert.equal(writes, 1);
});

test('reports cache read and write failures without failing OCR', async () => {
    const readError = new Error('cache read failed');
    const writeError = new Error('cache write failed');
    const reported = [];
    let reads = 0;
    const conversion = new MistralConversion({
        client: {
            ocr: async () => ({ pages: [{ index: 0, markdown: '# Fresh' }] }),
        },
        cache: {
            get: async () => {
                reads++;
                throw readError;
            },
            put: async () => { throw writeError; },
        },
        prepareResult: value => ({ markdown: value.pages[0].markdown }),
        onError: error => reported.push(error),
    });

    const result = await conversion.convert({
        key: KEY,
        apiKey: 'secret',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1]),
        cacheEnabled: true,
    });

    assert.equal(result.result.markdown, '# Fresh');
    assert.deepEqual(result.warnings, [
        'The local Markdown cache could not be read.',
        'The Markdown result could not be saved to the local cache.',
    ]);
    assert.deepEqual(reported, [readError, writeError]);
    assert.equal(reads, 1);
});

test('propagates caller cancellation before starting OCR', async () => {
    let requests = 0;
    const conversion = new MistralConversion({
        client: {
            ocr: async () => {
                requests++;
                return { pages: [{ index: 0, markdown: '# Never' }] };
            },
        },
        prepareResult: value => value,
    });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
        () => conversion.convert({
            apiKey: 'secret',
            fileName: 'paper.pdf',
            fileData: new Uint8Array([1]),
            signal: controller.signal,
        }),
        error => error.name === 'AbortError'
    );
    assert.equal(requests, 0);
});
