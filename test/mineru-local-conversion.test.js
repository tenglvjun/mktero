import test from 'node:test';
import assert from 'node:assert/strict';
import { MinerULocalConversion } from '../src/mineru/local-conversion.js';
import { MINERU_LOCAL_PARSER_PROFILE_ID } from '../src/mineru/parser-profile.js';

test('uses the local cache without creating a pending MinerU task', async () => {
    const calls = [];
    const cache = {
        async get() {
            return { markdown: '# Cached local', assets: [] };
        },
        async put() {
            throw new Error('cache put should not run');
        },
    };
    const conversion = new MinerULocalConversion({
        client: { async parse() { throw new Error('network should not run'); } },
        cache,
    });

    const converted = await conversion.convert({
        key: 'a'.repeat(64),
        apiBase: 'http://127.0.0.1:8000',
        fileData: new Uint8Array([1]),
        cacheEnabled: true,
        onProgress: value => calls.push(value),
    });

    assert.equal(converted.origin, 'cache');
    assert.equal(converted.result.markdown, '# Cached local');
    assert.equal(converted.result.parserProfile, MINERU_LOCAL_PARSER_PROFILE_ID);
    assert.equal(converted.result.detailedLayout, undefined);
    assert.deepEqual(calls, [100]);
});

test('stores a fresh local result and does not keep figure layout', async () => {
    const stored = [];
    const conversion = new MinerULocalConversion({
        client: {
            async parse() {
                return {
                    markdown: '# Fresh local',
                    assets: [],
                    assetBasePath: '',
                    layout: { schema: 'mineru-layout-v2', pages: [] },
                    figureMap: { figures: [] },
                };
            },
        },
        cache: {
            async get() { return null; },
            async put(key, result) { stored.push({ key, result }); },
        },
    });

    const converted = await conversion.convert({
        key: 'b'.repeat(64),
        apiBase: 'http://127.0.0.1:8000',
        fileData: new Uint8Array([1]),
        cacheEnabled: true,
    });

    assert.equal(converted.origin, 'fresh');
    assert.equal(converted.result.layout, undefined);
    assert.equal(converted.result.figureMap, undefined);
    assert.equal(stored[0].result.markdown, '# Fresh local');
    assert.equal(stored[0].result.figureMap, undefined);
});

test('readCached returns null without parsing when the local cache has no entry', async () => {
    const calls = { submit: 0, parse: 0, collect: 0 };
    const conversion = new MinerULocalConversion({
        client: {
            async submit() { calls.submit += 1; },
            async parse() { calls.parse += 1; },
            async collect() { calls.collect += 1; },
        },
        cache: { async get() { return null; } },
    });

    assert.equal(await conversion.readCached({
        key: 'a'.repeat(64),
        fileData: new Uint8Array([1]),
        cacheEnabled: true,
    }), null);
    assert.deepEqual(calls, { submit: 0, parse: 0, collect: 0 });
});

test('a new document pipeline reads a stored local result again without the service', async () => {
    const stored = new Map();
    const resultStore = {
        async get(key) { return stored.get(key) || null; },
        async put(key, record) { stored.set(key, record); },
    };
    const put = [];
    let parses = 0;
    const archive = new Uint8Array([7]);
    const make = () => new MinerULocalConversion({
        client: {
            async parse({ includeArchive }) {
                parses++;
                assert.equal(includeArchive, true);
                return { markdown: '# From the service', assets: [], assetBasePath: '', resultArchive: archive };
            },
        },
        cache: { async get() { return null; }, async put(key, result) { put.push({ key, result }); } },
        resultStore,
        createResultKey: async () => 'r'.repeat(64),
        extractStoredResult: bytes => {
            assert.equal(bytes, archive);
            return { markdown: '# From the store', assets: [], assetBasePath: '' };
        },
    });
    const first = await make().convert({ key: 'a'.repeat(64), fileData: new Uint8Array([1]), cacheEnabled: true });
    assert.equal(first.origin, 'fresh');
    assert.equal(first.result.markdown, '# From the service');
    assert.equal(first.result.resultArchive, undefined);
    assert.equal(stored.get('r'.repeat(64)).provider, 'mineru-local');

    const second = await make().convert({ key: 'b'.repeat(64), fileData: new Uint8Array([1]), cacheEnabled: true });
    assert.equal(second.origin, 'cache');
    assert.equal(second.result.markdown, '# From the store');
    assert.equal(parses, 1);
    assert.equal(put.at(-1).key, 'b'.repeat(64));

    const refreshed = await make().convert({ key: 'b'.repeat(64), fileData: new Uint8Array([1]), cacheEnabled: true, forceRefresh: true });
    assert.equal(refreshed.origin, 'fresh');
    assert.equal(parses, 2);
});

test('the local parser profile records its document pipeline and keeps the shipped literal', async () => {
    const { MINERU_DOCUMENT_PIPELINE, MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS, MINERU_LOCAL_REQUEST_PROFILE_ID } = await import('../src/mineru/parser-profile.js');
    assert.equal(JSON.parse(MINERU_LOCAL_PARSER_PROFILE_ID).document, MINERU_DOCUMENT_PIPELINE);
    assert.deepEqual(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS,
        ['{"transport":"local-v1","tier":"standard","ocrMode":"auto","output":"zip-markdown-v1"}']);
    assert.ok(!MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS.includes(MINERU_LOCAL_PARSER_PROFILE_ID));
    assert.equal(JSON.parse(MINERU_LOCAL_REQUEST_PROFILE_ID).document, undefined);
});
