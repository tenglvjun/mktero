import test from 'node:test';
import assert from 'node:assert/strict';
import { MkteroDocumentExtractor } from '../src/extractors/mktero-extractor.js';
import { createMarkdownCacheKey, sha256Hex } from '../src/cache/markdown-cache.js';
import { createMinerUResultKey } from '../src/cache/mineru-result-store.js';
import { hostedCacheProfileFor, hostedRequestProfileFor } from '../src/mktero/conversion-target.js';
import { MINERU_PARSER_PROFILE_ID, MINERU_PREVIOUS_PARSER_PROFILE_IDS } from '../src/mineru/parser-profile.js';
import { SharedMkteroConversion } from '../src/mktero/shared-conversion.js';

const PDF = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
const targetFor = model => ({
    routeId: 'stable-paper-route', modelVersion: model,
    parserProfileId: `mineru/v4-batch-${model}-1`,
});

async function fixture() {
    const sourceHash = await sha256Hex(PDF);
    const state = { model: 'vlm', conversions: [], markdown: new Map(), raw: new Map(), rawWrites: [], resolveError: null, responseTarget: null, origin: 'network' };
    const keys = {};
    for (const model of ['vlm', 'pipeline']) {
        keys[model] = {
            markdown: await createMarkdownCacheKey(PDF, { parserProfile: hostedCacheProfileFor(model) }),
            raw: await createMinerUResultKey({ sourceHash, provider: 'mktero', requestProfile: hostedRequestProfileFor(model) }),
        };
    }
    const extractor = new MkteroDocumentExtractor({
        zotero: { Items: { getAsync: async () => ({
            isPDFAttachment: () => true,
            getFilePathAsync: async () => '/fixture.pdf',
            getDisplayTitle: () => 'Fixture paper',
        }) } },
        conversion: {
            async resolveTarget() {
                if (state.resolveError) throw state.resolveError;
                return targetFor(state.model);
            },
            async convert(options) {
                state.conversions.push(options.target);
                const target = state.responseTarget || options.target;
                return {
                    result: { markdown: `# Parsed with ${target.modelVersion}` },
                    resultArchive: { fixtureModel: target.modelVersion },
                    target,
                    origin: state.origin,
                };
            },
        },
        getApiBase: () => 'https://fixture.invalid',
        getAccessToken: async () => 'fixture-only',
        readFile: async () => PDF,
        createSourceHash: async () => sourceHash,
        createCacheKey: (data, options) => createMarkdownCacheKey(data, options),
        createResultKey: (fileData, options) => createMinerUResultKey({ ...options, fileData, provider: 'mktero' }),
        isCacheEnabled: () => true,
        prepareResult: async result => result,
        cache: {
            get: async key => state.markdown.get(key) || null,
            put: async (key, value) => { state.markdown.set(key, value); },
        },
        resultStore: {
            get: async key => state.raw.get(key) || null,
            put: async (key, value) => { state.rawWrites.push(key); state.raw.set(key, value); },
        },
        extractStoredResult: archive => ({ markdown: `# Parsed with ${archive.fixtureModel}` }),
    });
    return { state, keys, extractor };
}

test('a model change bypasses the other model cache, and switching back reuses the retained VLM entry', async () => {
    const { state, keys, extractor } = await fixture();
    assert.equal(hostedCacheProfileFor('vlm'), MINERU_PARSER_PROFILE_ID);
    state.markdown.set(keys.vlm.markdown, { markdown: '# Retained VLM' });
    state.model = 'pipeline';
    const pipeline = await extractor.extract(42);
    assert.equal(pipeline.markdown, '# Parsed with pipeline');
    assert.equal(pipeline.parserProfile, hostedCacheProfileFor('pipeline'));
    assert.equal(pipeline.cacheKey, keys.pipeline.markdown);
    assert.equal(state.conversions.length, 1);
    assert.deepEqual(state.rawWrites, [keys.pipeline.raw]);
    assert.equal(state.markdown.get(keys.vlm.markdown).markdown, '# Retained VLM');

    state.model = 'vlm';
    const vlm = await extractor.extract(42);
    assert.equal(vlm.markdown, '# Retained VLM');
    assert.equal(vlm.cacheHit, true);
    assert.equal(vlm.cacheKey, keys.vlm.markdown);
    assert.equal(state.conversions.length, 1);
});

test('Pipeline keeps historical VLM corrections separate and switching back finds those corrections', async () => {
    const { state, keys, extractor } = await fixture();
    const legacyProfile = MINERU_PREVIOUS_PARSER_PROFILE_IDS[0];
    const legacyKey = await createMarkdownCacheKey(PDF, { parserProfile: legacyProfile });
    const reads = [];
    extractor.readRevision = async ({ cacheKey }) => {
        reads.push(cacheKey);
        return cacheKey === legacyKey ? { markdown: '# Corrected VLM', userEdited: true } : null;
    };
    state.model = 'pipeline';
    const pipeline = await extractor.extract(42);
    assert.equal(pipeline.markdown, '# Parsed with pipeline');
    assert.deepEqual(reads, [keys.pipeline.markdown]);
    state.model = 'vlm';
    const vlm = await extractor.extract(42);
    assert.equal(vlm.markdown, '# Corrected VLM');
    assert.equal(vlm.cacheKey, legacyKey);
    assert.equal(state.conversions.length, 1);
});

test('a target changed during create publishes both raw and Markdown results under the actual model only', async () => {
    const { state, keys, extractor } = await fixture();
    state.model = 'vlm';
    state.responseTarget = targetFor('pipeline');
    const result = await extractor.extract(42);
    assert.equal(result.parserProfile, hostedCacheProfileFor('pipeline'));
    assert.equal(result.cacheKey, keys.pipeline.markdown);
    assert.deepEqual(state.rawWrites, [keys.pipeline.raw]);
    assert.equal(state.markdown.has(keys.vlm.markdown), false);
    assert.equal(state.raw.has(keys.vlm.raw), false);
});

test('resuming an accepted VLM task preserves its snapshot while current resolution selects Pipeline', async () => {
    const { state, keys, extractor } = await fixture();
    state.model = 'pipeline';
    state.responseTarget = targetFor('vlm');
    state.origin = 'resumed';
    const result = await extractor.extract(42);
    assert.equal(result.resumedTask, true);
    assert.equal(result.parserProfile, MINERU_PARSER_PROFILE_ID);
    assert.equal(result.cacheKey, keys.vlm.markdown);
    assert.deepEqual(state.rawWrites, [keys.vlm.raw]);
    assert.equal(state.markdown.has(keys.pipeline.markdown), false);
});

for (const code of ['MKTERO_SIGN_IN_REQUIRED', 'MKTERO_INVALID_TARGET', 'MKTERO_TARGET_MISMATCH', 'MKTERO_RESOLVE_UNSUPPORTED']) {
    test(`a resolve failure ${code} is surfaced even when retained Markdown exists`, async () => {
        const { state, keys, extractor } = await fixture();
        state.markdown.set(keys.vlm.markdown, { markdown: '# Retained VLM' });
        state.resolveError = Object.assign(new Error('fixture resolve rejected'), { code });
        await assert.rejects(extractor.extract(42), error => error.code === code);
        assert.equal(state.conversions.length, 0);
    });
}

test('simultaneous models own separate publication streams while a same-model conversion supersedes retained reads', async () => {
    const sourceHash = await sha256Hex(PDF);
    const finish = new Map();
    const writes = [];
    const shared = new SharedMkteroConversion({
        conversion: { convert: ({ target }) => new Promise(resolve => finish.set(target.modelVersion, () => resolve({
            result: { markdown: `# ${target.modelVersion}` },
            target,
            origin: 'network',
            resultArchive: { fixtureModel: target.modelVersion },
        }))) },
        resultStore: { get: async () => null, put: async key => { writes.push(key); } },
    });
    const retainedVLM = shared.captureCachePublication({ sourceHash, byteLength: PDF.byteLength, model: 'vlm' });
    const acquire = model => shared.acquire({
        apiBase: 'https://fixture.invalid',
        getAccessToken: async () => 'fixture',
        fileData: PDF, sourceHash, target: targetFor(model),
        resultKey: `raw-${model}`, cacheEnabled: true,
    });
    const pipeline = acquire('pipeline');
    assert.equal(retainedVLM.canPublish(), true);
    const vlm = acquire('vlm');
    try {
        assert.equal(retainedVLM.canPublish(), false);
        // Let the two independent transports begin before completing either.
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(finish.size, 2);
        finish.get('vlm')();
        finish.get('pipeline')();
        await Promise.all([vlm.result, pipeline.result]);
        assert.equal(vlm.canPublish(), true);
        assert.equal(pipeline.canPublish(), true);
        assert.deepEqual(writes.sort(), ['raw-pipeline', 'raw-vlm']);
    }
    finally {
        retainedVLM.release();
        vlm.release();
        pipeline.release();
        await shared.dispose();
    }
});

test('a transport failure permits a retained local Pipeline entry with its own cache identity', async () => {
    const { state, keys, extractor } = await fixture();
    state.markdown.set(keys.pipeline.markdown, { markdown: '# Retained Pipeline' });
    state.resolveError = Object.assign(new Error('fixture offline'), { code: 'MKTERO_NETWORK_ERROR' });
    const result = await extractor.extract(42);
    assert.equal(result.markdown, '# Retained Pipeline');
    assert.equal(result.parserProfile, hostedCacheProfileFor('pipeline'));
    assert.equal(result.cacheKey, keys.pipeline.markdown);
    assert.equal(state.conversions.length, 0);
    assert.ok(result.warnings.length > 0);
});
