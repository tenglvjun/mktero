import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rename, rm, access, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { MinerUDocumentExtractor } from '../src/extractors/mineru-extractor.js';
import { MinerUClient } from '../src/mineru/mineru-client.js';
import { ConversionProviderRouter } from '../src/core/conversion-provider.js';
import { MinerUConversion } from '../src/mineru/mineru-conversion.js';
import { MinerUPendingTaskStore } from '../src/mineru/pending-task-store.js';
import { createMinerUConversionFacade } from '../src/mineru/conversion-facade.js';
import { mineruCloudProfilesFor, MINERU_PARSER_PROFILE_ID } from '../src/mineru/parser-profile.js';
import { createMarkdownCacheKey, sha256Hex } from '../src/cache/markdown-cache.js';
import { createMinerUResultKey } from '../src/cache/mineru-result-store.js';
import { ownedCacheResources } from '../src/cache/cache-owned-resources.js';
import { readDiagnosticEnvironment } from '../src/platform/zotero-diagnostic-snapshot.js';

const PDF = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
const defer = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

async function fixture(t) {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cloud-model-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const state = {
        model: 'vlm', endpoint: 'cloud', markdown: new Map(), raw: new Map(),
        batches: new Map(), submissions: [], uploads: 0, failCollection: false,
        beforeRead: null, afterUpload: null, prepareEndpoints: [],
    };
    const keys = {};
    for (const model of ['vlm', 'pipeline']) {
        const profiles = mineruCloudProfilesFor(model);
        keys[model] = {
            markdown: await createMarkdownCacheKey(PDF, { parserProfile: profiles.cacheProfile }),
            raw: await createMinerUResultKey({ fileData: PDF, provider: 'mineru', requestProfile: profiles.requestProfile }),
        };
    }
    const ioUtils = {
        exists: async file => { try { await access(file); return true; } catch { return false; } },
        makeDirectory: file => mkdir(file, { recursive: true }),
        readUTF8: file => readFile(file, 'utf8'),
        writeUTF8: async (file, text, options) => {
            await writeFile(options.tmpPath, text);
            await rename(options.tmpPath, file);
        },
        getChildren: async dir => (await readdir(dir)).map(name => path.join(dir, name)),
        remove: file => rm(file, { force: true, recursive: true }),
        stat: async file => ({ type: 'regular', size: (await stat(file)).size }),
    };
    const pathUtils = { join: path.join, filename: path.basename };
    const createStore = () => new MinerUPendingTaskStore({ rootPath, ioUtils, pathUtils });
    const cache = {
        get: async key => state.markdown.get(key) || null,
        put: async (key, value) => { state.markdown.set(key, value); },
    };
    const resultStore = {
        get: async key => state.raw.get(key) || null,
        put: async (key, value) => { state.raw.set(key, value); },
    };
    const client = new MinerUClient({
        apiBase: 'https://mineru.fixture.invalid/api/v4',
        maxRetryAttempts: 1,
        fetch: async (url, options = {}) => {
            if (url.endsWith('/file-urls/batch')) {
                const body = JSON.parse(options.body);
                state.submissions.push(body.model_version);
                const batchID = `batch-${state.submissions.length}`;
                state.batches.set(batchID, { model: body.model_version, dataID: body.files[0].data_id });
                return Response.json({ code: 0, data: { batch_id: batchID, file_urls: [`https://upload.fixture.invalid/${batchID}`] } });
            }
            if (url.startsWith('https://upload.fixture.invalid/')) {
                state.uploads++;
                await state.afterUpload?.();
                return new Response(null, { status: 200 });
            }
            if (url.includes('/extract-results/batch/')) {
                if (state.failCollection) throw Object.assign(new Error('fixture interrupted'), { name: 'AbortError' });
                const batchID = url.split('/').at(-1);
                const batch = state.batches.get(batchID);
                assert.ok(batch, `known batch ${batchID}`);
                return Response.json({ code: 0, data: { extract_result: [{ state: 'done', data_id: batch.dataID, full_zip_url: `https://result.fixture.invalid/${batchID}` }] } });
            }
            if (url.startsWith('https://result.fixture.invalid/')) {
                const batch = state.batches.get(url.split('/').at(-1));
                return new Response(zipSync({ 'full.md': strToU8(`# Parsed with ${batch.model}`) }));
            }
            assert.fail(`unexpected fixture URL ${url}`);
        },
    });
    const build = () => {
        const conversion = new MinerUConversion({
            client, pendingTasks: createStore(), cache, resultStore,
            prepareResult: value => value,
            createResultKey: (fileData, { requestProfile }) => createMinerUResultKey({ fileData, provider: 'mineru', requestProfile }),
        });
        const facade = createMinerUConversionFacade({
            getEndpoint: () => state.endpoint,
            cloud: conversion,
            local: { convert: () => assert.fail('must retain cloud endpoint'), readCached: () => assert.fail('must retain cloud endpoint') },
            getLocalApiKey: () => 'local-fixture-only',
            getLocalApiBase: () => 'http://127.0.0.1:8000',
        });
        return new MinerUDocumentExtractor({
            zotero: { Items: { getAsync: async () => {
                await state.beforeRead?.();
                return { isPDFAttachment: () => true, getFilePathAsync: async () => '/fixture.pdf', getDisplayTitle: () => 'Fixture' };
            } } },
            conversion: facade,
            getApiKey: () => 'cloud-fixture-only',
            getParserProfile: () => mineruCloudProfilesFor(state.model).cacheProfile,
            getPreviousParserProfiles: () => [],
            getConversionOptions: () => ({ endpoint: state.endpoint, modelVersion: state.model }),
            prepareResult: (value, options) => { state.prepareEndpoints.push(options.endpoint); return value; },
            readFile: async () => PDF,
            createSourceHash: () => sha256Hex(PDF),
            createCacheKey: createMarkdownCacheKey,
            isCacheEnabled: () => true,
        });
    };
    return { state, keys, build, createStore, rootPath };
}

test('real cloud request, Markdown and ZIP caches follow the selected model and switching back reuses VLM', async t => {
    const { state, keys, build } = await fixture(t);
    const extractor = build();
    const vlm = await extractor.extract(42);
    state.model = 'pipeline';
    const pipeline = await extractor.extract(42);
    assert.deepEqual(state.submissions, ['vlm', 'pipeline']);
    assert.equal(state.uploads, 2);
    assert.equal(vlm.parserProfile, MINERU_PARSER_PROFILE_ID);
    assert.equal(pipeline.cacheKey, keys.pipeline.markdown);
    assert.equal(pipeline.markdown.trim(), '# Parsed with pipeline');
    assert.ok(state.raw.has(keys.pipeline.raw));
    assert.ok(state.raw.has(keys.vlm.raw));
    state.model = 'vlm';
    const cached = await build().extract(42);
    assert.equal(cached.cacheHit, true);
    assert.equal(cached.cacheKey, keys.vlm.markdown);
    assert.equal(cached.markdown.trim(), '# Parsed with vlm');
    assert.equal(state.uploads, 2);

    // Re-derive from the corresponding raw ZIP if just the Markdown was evicted.
    state.model = 'pipeline';
    state.markdown.delete(keys.pipeline.markdown);
    const raw = await build().readCached(42);
    assert.equal(raw.markdown.trim(), '# Parsed with pipeline');
    assert.equal(raw.cacheKey, keys.pipeline.markdown);
    assert.equal(state.uploads, 2);
});

test('a preference change during PDF loading or upload cannot move a cloud operation to another endpoint/model', async t => {
    const { state, keys, build } = await fixture(t);
    const gate = defer();
    const started = defer();
    state.beforeRead = () => { started.resolve(); return gate.promise; };
    const pending = build().extract(42);
    await started.promise;
    state.model = 'pipeline';
    state.endpoint = 'local';
    state.afterUpload = () => { state.model = 'vlm'; };
    gate.resolve();
    const result = await pending;
    assert.deepEqual(state.submissions, ['vlm']);
    assert.equal(result.cacheKey, keys.vlm.markdown);
    assert.equal(result.parserProfile, mineruCloudProfilesFor('vlm').cacheProfile);
    assert.deepEqual(state.prepareEndpoints, ['cloud']);
    assert.ok(state.raw.has(keys.vlm.raw));
    assert.equal(state.raw.has(keys.pipeline.raw), false);
});

for (const method of ['extract', 'readCached']) {
    test(`${method} captures Cloud selection before waiting for local-import lookup`, async t => {
        const { state, build, keys } = await fixture(t);
        state.markdown.set(keys.vlm.markdown, { markdown: '# Retained VLM' });
        const lookup = defer();
        const started = defer();
        let provider = 'mineru';
        const unexpected = { extract: () => assert.fail('provider changed mid-operation'), readCached: () => assert.fail('provider changed mid-operation') };
        const router = new ConversionProviderRouter({
            getProvider: () => provider,
            providers: { mineru: build(), mktero: unexpected, mistral: unexpected },
            imported: { [method]: () => { started.resolve(); return lookup.promise; } },
        });
        const result = router[method](42);
        await started.promise;
        state.model = 'pipeline';
        state.endpoint = 'local';
        provider = 'mistral';
        lookup.resolve(null);
        const retained = await result;
        assert.equal(retained.markdown, '# Retained VLM');
        assert.equal(retained.cacheKey, keys.vlm.markdown);
        assert.equal(retained.parserProfile, MINERU_PARSER_PROFILE_ID);
        assert.equal(state.uploads, 0);
    });
}

test('both models persist interrupted tasks and resume their own accepted batches after restart and switching back', async t => {
    const { state, keys, build, createStore } = await fixture(t);
    state.failCollection = true;
    await assert.rejects(build().extract(42), { name: 'AbortError' });
    state.model = 'pipeline';
    await assert.rejects(build().extract(42), { name: 'AbortError' });
    assert.deepEqual(state.submissions, ['vlm', 'pipeline']);
    assert.equal((await createStore().get(keys.vlm.markdown)).modelVersion, 'vlm');
    assert.equal((await createStore().get(keys.pipeline.markdown)).modelVersion, 'pipeline');
    state.failCollection = false;
    const pipeline = await build().extract(42);
    assert.equal(pipeline.resumedTask, true);
    assert.equal(pipeline.markdown.trim(), '# Parsed with pipeline');
    assert.equal(await createStore().get(keys.pipeline.markdown), null);
    assert.ok(await createStore().get(keys.vlm.markdown));
    state.model = 'vlm';
    const vlm = await build().extract(42);
    assert.equal(vlm.resumedTask, true);
    assert.equal(vlm.markdown.trim(), '# Parsed with vlm');
    assert.equal(await createStore().get(keys.vlm.markdown), null);
    assert.equal(state.uploads, 2);
});

test('an old on-disk task without model metadata resumes as VLM without a new upload', async t => {
    const { state, keys, build, rootPath } = await fixture(t);
    state.batches.set('legacy-batch', { model: 'vlm', dataID: 'legacy-data' });
    await mkdir(path.join(rootPath, 'tasks'), { recursive: true });
    await writeFile(path.join(rootPath, 'tasks', `${keys.vlm.markdown}.json`), JSON.stringify({
        schemaVersion: 1, conversionKey: keys.vlm.markdown,
        batchID: 'legacy-batch', dataID: 'legacy-data', uploadedAt: Date.now(),
    }));
    const result = await build().extract(42);
    assert.equal(result.resumedTask, true);
    assert.equal(result.markdown.trim(), '# Parsed with vlm');
    assert.deepEqual(state.submissions, []);
    assert.equal(state.uploads, 0);
});

test('cache ownership includes both models and provider-separated ZIP keys', async t => {
    const { keys } = await fixture(t);
    const owned = await ownedCacheResources(await sha256Hex(PDF));
    for (const model of ['vlm', 'pipeline']) {
        assert.ok(owned.some(value => value.store === 'raw' && value.key === keys[model].raw));
        assert.ok(owned.some(value => value.store === 'markdown' && value.key === keys[model].markdown));
        assert.ok(owned.some(value => value.store === 'revisions' && value.key === keys[model].markdown));
    }
});

test('diagnostics reflect the selected Cloud profile, while a hosted provider ignores that preference', async () => {
    const prefs = new Map([
        ['extensions.mktero.conversionProvider', 'mineru'],
        ['extensions.mktero.mineruEndpoint', 'cloud'],
        ['extensions.mktero.mineruCloudModelVersion', 'pipeline'],
    ]);
    const hashInputs = [];
    const read = () => readDiagnosticEnvironment({
        zotero: { Prefs: { get: key => prefs.get(key) } },
        hash: async value => { hashInputs.push(value); return 'a'.repeat(64); },
    });
    await read();
    assert.equal(hashInputs.at(-1), mineruCloudProfilesFor('pipeline').cacheProfile);
    prefs.set('extensions.mktero.conversionProvider', 'mktero');
    await read();
    assert.equal(hashInputs.at(-1), MINERU_PARSER_PROFILE_ID);
});
