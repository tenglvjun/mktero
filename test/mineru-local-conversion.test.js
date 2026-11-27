import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarkdownCacheKey } from '../src/cache/markdown-cache.js';
import { MinerUDocumentExtractor } from '../src/extractors/mineru-extractor.js';
import { MinerULocalConversion } from '../src/mineru/local-conversion.js';
import {
    MINERU_DOCUMENT_IR_V28_FIGURE_V29_PARSER_PROFILE_ID,
    MINERU_DOCUMENT_IR_V27_FIGURE_V29_PARSER_PROFILE_ID,
    MINERU_DOCUMENT_IR_V26_FIGURE_V29_PARSER_PROFILE_ID,
    MINERU_PIPELINE_DOCUMENT_IR_V28_FIGURE_V29_PARSER_PROFILE_ID,
    MINERU_PIPELINE_DOCUMENT_IR_V27_FIGURE_V29_PARSER_PROFILE_ID,
    MINERU_PIPELINE_DOCUMENT_IR_V26_FIGURE_V29_PARSER_PROFILE_ID,
    MINERU_LOCAL_PARSER_PROFILE_ID,
    MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS,
    MINERU_LOCAL_DOCUMENT_IR_V29_FIGURE_V29_PARSER_PROFILE_ID,
    MINERU_LOCAL_DOCUMENT_IR_V28_FIGURE_V29_PARSER_PROFILE_ID,
    MINERU_LOCAL_DOCUMENT_IR_V27_FIGURE_V29_PARSER_PROFILE_ID,
    MINERU_LOCAL_DOCUMENT_IR_V26_FIGURE_V29_PARSER_PROFILE_ID,
    MINERU_LOCAL_DOCUMENT_IR_V25_FIGURE_V28_PARSER_PROFILE_ID,
    MINERU_LOCAL_DOCUMENT_IR_V24_FIGURE_V27_PARSER_PROFILE_ID,
    MINERU_LOCAL_DOCUMENT_IR_V23_FIGURE_V27_PARSER_PROFILE_ID,
    MINERU_LOCAL_DOCUMENT_IR_V22_FIGURE_V27_PARSER_PROFILE_ID,
    MINERU_LOCAL_DOCUMENT_IR_V21_FIGURE_V26_PARSER_PROFILE_ID,
    MINERU_LOCAL_DOCUMENT_IR_V20_FIGURE_V25_PARSER_PROFILE_ID,
} from '../src/mineru/parser-profile.js';

test('retains the shipped local cache identities as literals after the IR v29 upgrade', () => {
    assert.equal(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS[0], MINERU_LOCAL_DOCUMENT_IR_V29_FIGURE_V29_PARSER_PROFILE_ID);
    assert.equal(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS[1], MINERU_LOCAL_DOCUMENT_IR_V28_FIGURE_V29_PARSER_PROFILE_ID);
    assert.equal(MINERU_LOCAL_DOCUMENT_IR_V28_FIGURE_V29_PARSER_PROFILE_ID, '{"transport":"local-v1","tier":"standard","ocrMode":"auto","output":"zip-middle-v2","document":"mineru-document-ir-v28","figureStructure":"figure-region-v29"}');
    assert.equal(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS[2], MINERU_LOCAL_DOCUMENT_IR_V27_FIGURE_V29_PARSER_PROFILE_ID);
    assert.equal(MINERU_LOCAL_DOCUMENT_IR_V27_FIGURE_V29_PARSER_PROFILE_ID, '{"transport":"local-v1","tier":"standard","ocrMode":"auto","output":"zip-middle-v2","document":"mineru-document-ir-v27","figureStructure":"figure-region-v29"}');
    assert.equal(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS[3], MINERU_LOCAL_DOCUMENT_IR_V26_FIGURE_V29_PARSER_PROFILE_ID);
    assert.equal(MINERU_LOCAL_DOCUMENT_IR_V26_FIGURE_V29_PARSER_PROFILE_ID, '{"transport":"local-v1","tier":"standard","ocrMode":"auto","output":"zip-middle-v2","document":"mineru-document-ir-v26","figureStructure":"figure-region-v29"}');
    assert.equal(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS[4], MINERU_LOCAL_DOCUMENT_IR_V25_FIGURE_V28_PARSER_PROFILE_ID);
    assert.equal(MINERU_LOCAL_DOCUMENT_IR_V25_FIGURE_V28_PARSER_PROFILE_ID, '{"transport":"local-v1","tier":"standard","ocrMode":"auto","output":"zip-middle-v2","document":"mineru-document-ir-v25","figureStructure":"figure-region-v28"}');
    assert.equal(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS[5], MINERU_LOCAL_DOCUMENT_IR_V24_FIGURE_V27_PARSER_PROFILE_ID);
    assert.equal(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS[6], MINERU_LOCAL_DOCUMENT_IR_V23_FIGURE_V27_PARSER_PROFILE_ID);
    assert.equal(MINERU_LOCAL_DOCUMENT_IR_V23_FIGURE_V27_PARSER_PROFILE_ID, '{"transport":"local-v1","tier":"standard","ocrMode":"auto","output":"zip-middle-v2","document":"mineru-document-ir-v23","figureStructure":"figure-region-v27"}');
    assert.equal(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS[7], MINERU_LOCAL_DOCUMENT_IR_V22_FIGURE_V27_PARSER_PROFILE_ID);
    assert.equal(MINERU_LOCAL_DOCUMENT_IR_V22_FIGURE_V27_PARSER_PROFILE_ID, '{"transport":"local-v1","tier":"standard","ocrMode":"auto","output":"zip-middle-v2","document":"mineru-document-ir-v22","figureStructure":"figure-region-v27"}');
    assert.equal(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS[8], MINERU_LOCAL_DOCUMENT_IR_V21_FIGURE_V26_PARSER_PROFILE_ID);
    assert.equal(MINERU_LOCAL_DOCUMENT_IR_V21_FIGURE_V26_PARSER_PROFILE_ID, '{"transport":"local-v1","tier":"standard","ocrMode":"auto","output":"zip-middle-v2","document":"mineru-document-ir-v21","figureStructure":"figure-region-v26"}');
    assert.equal(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS[9], MINERU_LOCAL_DOCUMENT_IR_V20_FIGURE_V25_PARSER_PROFILE_ID);
    assert.equal(MINERU_LOCAL_DOCUMENT_IR_V20_FIGURE_V25_PARSER_PROFILE_ID, '{"transport":"local-v1","tier":"standard","ocrMode":"auto","output":"zip-middle-v2","document":"mineru-document-ir-v20","figureStructure":"figure-region-v25"}');
    assert.ok(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS.every(profile => JSON.parse(profile).transport === 'local-v1'));
    assert.equal(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS.includes(MINERU_DOCUMENT_IR_V28_FIGURE_V29_PARSER_PROFILE_ID), false);
    assert.equal(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS.includes(MINERU_PIPELINE_DOCUMENT_IR_V28_FIGURE_V29_PARSER_PROFILE_ID), false);
    assert.equal(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS.includes(MINERU_DOCUMENT_IR_V27_FIGURE_V29_PARSER_PROFILE_ID), false);
    assert.equal(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS.includes(MINERU_PIPELINE_DOCUMENT_IR_V27_FIGURE_V29_PARSER_PROFILE_ID), false);
    assert.equal(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS.includes(MINERU_DOCUMENT_IR_V26_FIGURE_V29_PARSER_PROFILE_ID), false);
    assert.equal(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS.includes(MINERU_PIPELINE_DOCUMENT_IR_V26_FIGURE_V29_PARSER_PROFILE_ID), false);
});

for (const [source, previousProfile] of [
    ['local', MINERU_LOCAL_DOCUMENT_IR_V28_FIGURE_V29_PARSER_PROFILE_ID],
    ['vlm', MINERU_DOCUMENT_IR_V28_FIGURE_V29_PARSER_PROFILE_ID],
    ['pipeline', MINERU_PIPELINE_DOCUMENT_IR_V28_FIGURE_V29_PARSER_PROFILE_ID],
    ['local', MINERU_LOCAL_DOCUMENT_IR_V27_FIGURE_V29_PARSER_PROFILE_ID],
    ['vlm', MINERU_DOCUMENT_IR_V27_FIGURE_V29_PARSER_PROFILE_ID],
    ['pipeline', MINERU_PIPELINE_DOCUMENT_IR_V27_FIGURE_V29_PARSER_PROFILE_ID],
    ['local', MINERU_LOCAL_DOCUMENT_IR_V26_FIGURE_V29_PARSER_PROFILE_ID],
    ['vlm', MINERU_DOCUMENT_IR_V26_FIGURE_V29_PARSER_PROFILE_ID],
    ['pipeline', MINERU_PIPELINE_DOCUMENT_IR_V26_FIGURE_V29_PARSER_PROFILE_ID],
]) {
    for (const method of ['extract', 'readCached']) {
        const behavior = source === 'local' ? 'reopens the local' : `never reads the ${source}`;
        const version = JSON.parse(previousProfile).document;
        test(`${method} ${behavior} ${version} correction from local after the IR v29 upgrade`, async () => {
            const keyFor = parserProfile => createMarkdownCacheKey(new Uint8Array([1]), { parserProfile });
            const previousKey = await keyFor(previousProfile);
            const currentKey = await keyFor(MINERU_LOCAL_PARSER_PROFILE_ID);
            const reads = [];
            const extractor = new MinerUDocumentExtractor({
                zotero: {
                    Items: {
                        getAsync: async () => ({
                            isPDFAttachment: () => true,
                            getFilePathAsync: async () => '/fixture.pdf',
                            getDisplayTitle: () => 'Fixture',
                        }),
                    },
                },
                conversion: {
                    convert: async () => ({ origin: 'fresh', result: { markdown: '# Current local result' } }),
                    readCached: async () => null,
                },
                getApiKey: () => '',
                getParserProfile: () => MINERU_LOCAL_PARSER_PROFILE_ID,
                getPreviousParserProfiles: () => MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS,
                getConversionOptions: () => ({ endpoint: 'local' }),
                readFile: async () => new Uint8Array([1]),
                createCacheKey: createMarkdownCacheKey,
                readRevision: async ({ cacheKey }) => {
                    reads.push(cacheKey);
                    return cacheKey === previousKey ? { markdown: `# Corrected ${version}` } : null;
                },
                prepareResult: result => result,
            });

            const result = await extractor[method](42);

            if (source === 'local') {
                assert.equal(result.markdown, `# Corrected ${version}`);
                assert.equal(result.parserProfile, previousProfile);
                assert.equal(result.cacheKey, previousKey);
                const tried = MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS.slice(0,
                    MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS.indexOf(previousProfile) + 1);
                assert.deepEqual(reads, [currentKey, ...await Promise.all(tried.map(keyFor))]);
            }
            else {
                assert.equal(result?.markdown ?? null, method === 'extract' ? '# Current local result' : null);
                assert.deepEqual(reads, [currentKey, ...await Promise.all(
                    MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS.map(keyFor)
                )]);
                assert.equal(reads.includes(previousKey), false);
            }
        });
    }
}

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

test('reparses a local incomplete-link cache entry instead of reusing it', async () => {
    let parses = 0;
    const conversion = new MinerULocalConversion({
        client: {
            async parse() {
                parses++;
                return { markdown: '# Reparsed local result' };
            },
        },
        cache: {
            async get() { return { markdown: '# Incomplete local result', pdfLinksIncomplete: true }; },
            async put() {},
        },
    });

    const result = await conversion.convert({
        key: 'd'.repeat(64),
        apiBase: 'http://127.0.0.1:8000',
        fileData: new Uint8Array([1]),
        cacheEnabled: true,
    });

    assert.equal(result.result.markdown, '# Reparsed local result');
    assert.equal(parses, 1);
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

test('the local v30 parser profile records its document pipeline and keeps the shipped literals', async () => {
    const { MINERU_DOCUMENT_PIPELINE, MINERU_LOCAL_DOCUMENT_IR_V19_FIGURE_V24_PARSER_PROFILE_ID, MINERU_LOCAL_DOCUMENT_IR_V18_FIGURE_V23_PARSER_PROFILE_ID, MINERU_LOCAL_DOCUMENT_IR_V17_FIGURE_V22_PARSER_PROFILE_ID, MINERU_LOCAL_DOCUMENT_IR_V16_FIGURE_V21_PARSER_PROFILE_ID, MINERU_LOCAL_DOCUMENT_IR_V15_FIGURE_V20_PARSER_PROFILE_ID, MINERU_LOCAL_DOCUMENT_IR_V14_FIGURE_V20_PARSER_PROFILE_ID, MINERU_LOCAL_DOCUMENT_IR_V13_FIGURE_V20_PARSER_PROFILE_ID, MINERU_LOCAL_DOCUMENT_IR_V21_FIGURE_V26_PARSER_PROFILE_ID, MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS, MINERU_LOCAL_REQUEST_PROFILE_ID } = await import('../src/mineru/parser-profile.js');
    assert.equal(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS[1], MINERU_LOCAL_DOCUMENT_IR_V28_FIGURE_V29_PARSER_PROFILE_ID);
    assert.equal(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS[2], MINERU_LOCAL_DOCUMENT_IR_V27_FIGURE_V29_PARSER_PROFILE_ID);
    assert.equal(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS[3], MINERU_LOCAL_DOCUMENT_IR_V26_FIGURE_V29_PARSER_PROFILE_ID);
    assert.equal(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS[4], MINERU_LOCAL_DOCUMENT_IR_V25_FIGURE_V28_PARSER_PROFILE_ID);
    assert.equal(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS[5], MINERU_LOCAL_DOCUMENT_IR_V24_FIGURE_V27_PARSER_PROFILE_ID);
    assert.equal(JSON.parse(MINERU_LOCAL_PARSER_PROFILE_ID).document, MINERU_DOCUMENT_PIPELINE);
    assert.equal(MINERU_DOCUMENT_PIPELINE, 'mineru-document-ir-v30');
    assert.equal(JSON.parse(MINERU_LOCAL_PARSER_PROFILE_ID).figureStructure, 'figure-region-v30');
    // Every shipped identity stays literal so corrections still open after the bump.
    assert.equal(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS[6], MINERU_LOCAL_DOCUMENT_IR_V23_FIGURE_V27_PARSER_PROFILE_ID);
    assert.equal(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS[7], MINERU_LOCAL_DOCUMENT_IR_V22_FIGURE_V27_PARSER_PROFILE_ID);
    assert.equal(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS[8], MINERU_LOCAL_DOCUMENT_IR_V21_FIGURE_V26_PARSER_PROFILE_ID);
    assert.equal(JSON.parse(MINERU_LOCAL_DOCUMENT_IR_V21_FIGURE_V26_PARSER_PROFILE_ID).document, 'mineru-document-ir-v21');
    assert.equal(JSON.parse(MINERU_LOCAL_DOCUMENT_IR_V21_FIGURE_V26_PARSER_PROFILE_ID).figureStructure, 'figure-region-v26');
    assert.equal(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS[10], MINERU_LOCAL_DOCUMENT_IR_V19_FIGURE_V24_PARSER_PROFILE_ID);
    assert.equal(JSON.parse(MINERU_LOCAL_DOCUMENT_IR_V19_FIGURE_V24_PARSER_PROFILE_ID).document, 'mineru-document-ir-v19');
    assert.equal(JSON.parse(MINERU_LOCAL_DOCUMENT_IR_V19_FIGURE_V24_PARSER_PROFILE_ID).figureStructure, 'figure-region-v24');
    assert.equal(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS[11], MINERU_LOCAL_DOCUMENT_IR_V18_FIGURE_V23_PARSER_PROFILE_ID);
    assert.equal(JSON.parse(MINERU_LOCAL_DOCUMENT_IR_V18_FIGURE_V23_PARSER_PROFILE_ID).document, 'mineru-document-ir-v18');
    assert.equal(JSON.parse(MINERU_LOCAL_DOCUMENT_IR_V18_FIGURE_V23_PARSER_PROFILE_ID).figureStructure, 'figure-region-v23');
    assert.equal(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS[12], MINERU_LOCAL_DOCUMENT_IR_V17_FIGURE_V22_PARSER_PROFILE_ID);
    // A document-pipeline bump must not touch what the local service was asked
    // to produce, which keys the stored result.
    assert.equal(MINERU_LOCAL_REQUEST_PROFILE_ID, '{"transport":"local-v1","tier":"standard","ocrMode":"auto","output":"zip"}');
    assert.equal(JSON.parse(MINERU_LOCAL_REQUEST_PROFILE_ID).output, 'zip');
    assert.equal(MINERU_LOCAL_DOCUMENT_IR_V15_FIGURE_V20_PARSER_PROFILE_ID,
        '{"transport":"local-v1","tier":"standard","ocrMode":"auto","output":"zip-middle-v2","document":"mineru-document-ir-v15","figureStructure":"figure-region-v20"}');
    assert.equal(MINERU_LOCAL_DOCUMENT_IR_V14_FIGURE_V20_PARSER_PROFILE_ID,
        '{"transport":"local-v1","tier":"standard","ocrMode":"auto","output":"zip-middle-v2","document":"mineru-document-ir-v14","figureStructure":"figure-region-v20"}');
    assert.equal(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS[13], MINERU_LOCAL_DOCUMENT_IR_V16_FIGURE_V21_PARSER_PROFILE_ID);
    assert.equal(MINERU_LOCAL_DOCUMENT_IR_V16_FIGURE_V21_PARSER_PROFILE_ID,
        '{"transport":"local-v1","tier":"standard","ocrMode":"auto","output":"zip-middle-v2","document":"mineru-document-ir-v16","figureStructure":"figure-region-v21"}');
    assert.equal(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS[14], MINERU_LOCAL_DOCUMENT_IR_V15_FIGURE_V20_PARSER_PROFILE_ID);
    assert.equal(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS[15], MINERU_LOCAL_DOCUMENT_IR_V14_FIGURE_V20_PARSER_PROFILE_ID);
    assert.equal(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS[16], MINERU_LOCAL_DOCUMENT_IR_V13_FIGURE_V20_PARSER_PROFILE_ID);
    assert.deepEqual(MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS,
        [
            MINERU_LOCAL_DOCUMENT_IR_V29_FIGURE_V29_PARSER_PROFILE_ID,
            MINERU_LOCAL_DOCUMENT_IR_V28_FIGURE_V29_PARSER_PROFILE_ID,
            MINERU_LOCAL_DOCUMENT_IR_V27_FIGURE_V29_PARSER_PROFILE_ID,
            MINERU_LOCAL_DOCUMENT_IR_V26_FIGURE_V29_PARSER_PROFILE_ID,
            MINERU_LOCAL_DOCUMENT_IR_V25_FIGURE_V28_PARSER_PROFILE_ID,
            MINERU_LOCAL_DOCUMENT_IR_V24_FIGURE_V27_PARSER_PROFILE_ID,
            MINERU_LOCAL_DOCUMENT_IR_V23_FIGURE_V27_PARSER_PROFILE_ID,
            MINERU_LOCAL_DOCUMENT_IR_V22_FIGURE_V27_PARSER_PROFILE_ID,
            MINERU_LOCAL_DOCUMENT_IR_V21_FIGURE_V26_PARSER_PROFILE_ID,
            MINERU_LOCAL_DOCUMENT_IR_V20_FIGURE_V25_PARSER_PROFILE_ID,
            MINERU_LOCAL_DOCUMENT_IR_V19_FIGURE_V24_PARSER_PROFILE_ID,
            MINERU_LOCAL_DOCUMENT_IR_V18_FIGURE_V23_PARSER_PROFILE_ID,
            MINERU_LOCAL_DOCUMENT_IR_V17_FIGURE_V22_PARSER_PROFILE_ID,
            '{"transport":"local-v1","tier":"standard","ocrMode":"auto","output":"zip-middle-v2","document":"mineru-document-ir-v16","figureStructure":"figure-region-v21"}',
            '{"transport":"local-v1","tier":"standard","ocrMode":"auto","output":"zip-middle-v2","document":"mineru-document-ir-v15","figureStructure":"figure-region-v20"}',
            '{"transport":"local-v1","tier":"standard","ocrMode":"auto","output":"zip-middle-v2","document":"mineru-document-ir-v14","figureStructure":"figure-region-v20"}',
            '{"transport":"local-v1","tier":"standard","ocrMode":"auto","output":"zip-middle-v2","document":"mineru-document-ir-v13","figureStructure":"figure-region-v20"}',
            '{"transport":"local-v1","tier":"standard","ocrMode":"auto","output":"zip-middle-v2","document":"mineru-document-ir-v13","figureStructure":"figure-region-v19"}',
            '{"transport":"local-v1","tier":"standard","ocrMode":"auto","output":"zip-middle-v2","document":"mineru-document-ir-v12","figureStructure":"figure-region-v19"}',
            '{"transport":"local-v1","tier":"standard","ocrMode":"auto","output":"zip-middle-v2","document":"mineru-document-ir-v12","figureStructure":"figure-region-v18"}',
            '{"transport":"local-v1","tier":"standard","ocrMode":"auto","output":"zip-middle-v2","document":"mineru-document-ir-v12"}',
            '{"transport":"local-v1","tier":"standard","ocrMode":"auto","output":"zip-middle-v2","document":"mineru-document-ir-v11"}',
            '{"transport":"local-v1","tier":"standard","ocrMode":"auto","output":"zip-middle-v2","document":"mineru-document-ir-v10"}',
            '{"transport":"local-v1","tier":"standard","ocrMode":"auto","output":"zip-middle-v2","document":"mineru-document-ir-v9"}',
            '{"transport":"local-v1","tier":"standard","ocrMode":"auto","output":"zip-middle-v2","document":"mineru-document-ir-v8"}',
            '{"transport":"local-v1","tier":"standard","ocrMode":"auto","output":"zip-markdown-v1"}',
        ]);
    assert.ok(!MINERU_LOCAL_PREVIOUS_PARSER_PROFILE_IDS.includes(MINERU_LOCAL_PARSER_PROFILE_ID));
    assert.equal(JSON.parse(MINERU_LOCAL_REQUEST_PROFILE_ID).document, undefined);
});
