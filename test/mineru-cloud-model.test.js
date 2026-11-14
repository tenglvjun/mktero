import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    MINERU_BATCH_OPTIONS,
    MINERU_CLOUD_CACHE_PROFILE_IDS,
    MINERU_CLOUD_MODEL_VERSIONS,
    MINERU_CLOUD_REQUEST_PROFILE_IDS,
    MINERU_DOCUMENT_IR_V13_FIGURE_V19_PARSER_PROFILE_ID,
    MINERU_DOCUMENT_IR_V13_FIGURE_V20_PARSER_PROFILE_ID,
    MINERU_DOCUMENT_IR_V14_FIGURE_V20_PARSER_PROFILE_ID,
    MINERU_DOCUMENT_IR_V15_FIGURE_V20_PARSER_PROFILE_ID,
    MINERU_DOCUMENT_PIPELINE,
    MINERU_LOCAL_PARSER_PROFILE_ID,
    MINERU_PARSER_PROFILE_ID,
    MINERU_PIPELINE_DOCUMENT_IR_V13_FIGURE_V19_PARSER_PROFILE_ID,
    MINERU_PIPELINE_DOCUMENT_IR_V13_FIGURE_V20_PARSER_PROFILE_ID,
    MINERU_PIPELINE_DOCUMENT_IR_V14_FIGURE_V20_PARSER_PROFILE_ID,
    MINERU_PIPELINE_DOCUMENT_IR_V15_FIGURE_V20_PARSER_PROFILE_ID,
    MINERU_PIPELINE_PREVIOUS_PARSER_PROFILE_IDS,
    MINERU_PREVIOUS_PARSER_PROFILE_IDS,
    MINERU_REQUEST_PROFILE_ID,
    mineruBatchOptionsFor,
    mineruCloudPreviousParserProfilesFor,
    mineruCloudProfilesFor,
} from '../src/mineru/parser-profile.js';
import { createMarkdownCacheKey } from '../src/cache/markdown-cache.js';
import { MinerUDocumentExtractor } from '../src/extractors/mineru-extractor.js';
import { MinerUConversion } from '../src/mineru/mineru-conversion.js';
import { MinerUPendingTaskStore } from '../src/mineru/pending-task-store.js';
import { FIGURE_PIPELINE_PROFILE } from '../src/figures/figure-limits.js';

const CONVERSION_KEY = 'a'.repeat(64);

test('keeps the historical vlm identities byte for byte', () => {
    const vlm = mineruCloudProfilesFor();

    assert.equal(vlm.modelVersion, 'vlm');
    assert.equal(vlm.cacheProfile, MINERU_PARSER_PROFILE_ID);
    assert.equal(vlm.requestProfile, MINERU_REQUEST_PROFILE_ID);
    assert.equal(mineruCloudProfilesFor('vlm').cacheProfile, MINERU_PARSER_PROFILE_ID);
    assert.deepEqual(MINERU_BATCH_OPTIONS, {
        model_version: 'vlm',
        enable_formula: true,
        enable_table: true,
    });
    assert.deepEqual(JSON.parse(vlm.requestProfile), {
        batch: { model_version: 'vlm', enable_formula: true, enable_table: true },
        file: { is_ocr: true },
    });
});

test('derives a separate pipeline identity from the same document and figure versions', () => {
    const pipeline = mineruCloudProfilesFor('pipeline');
    const cache = JSON.parse(pipeline.cacheProfile);
    const request = JSON.parse(pipeline.requestProfile);

    assert.equal(pipeline.modelVersion, 'pipeline');
    assert.notEqual(pipeline.cacheProfile, MINERU_PARSER_PROFILE_ID);
    assert.notEqual(pipeline.requestProfile, MINERU_REQUEST_PROFILE_ID);
    assert.deepEqual(cache.batch, {
        model_version: 'pipeline',
        enable_formula: true,
        enable_table: true,
    });
    assert.deepEqual(cache.file, { is_ocr: true });
    assert.equal(cache.document, MINERU_DOCUMENT_PIPELINE);
    assert.equal(cache.figureStructure, FIGURE_PIPELINE_PROFILE);
    // The raw-result identity names only what MinerU was asked to produce.
    assert.deepEqual(request, {
        batch: { model_version: 'pipeline', enable_formula: true, enable_table: true },
        file: { is_ocr: true },
    });
    assert.equal('document' in request, false);
});

test('keeps the shipped IR v15 figure v20 Pipeline identity as an independent literal', () => {
    assert.equal(MINERU_PIPELINE_DOCUMENT_IR_V15_FIGURE_V20_PARSER_PROFILE_ID,
        '{"batch":{"model_version":"pipeline","enable_formula":true,"enable_table":true},"file":{"is_ocr":true},"document":"mineru-document-ir-v15","figureStructure":"figure-region-v20"}');
    assert.deepEqual(JSON.parse(MINERU_PIPELINE_DOCUMENT_IR_V15_FIGURE_V20_PARSER_PROFILE_ID), {
        batch: { model_version: 'pipeline', enable_formula: true, enable_table: true },
        file: { is_ocr: true },
        document: 'mineru-document-ir-v15',
        figureStructure: 'figure-region-v20',
    });
    assert.deepEqual(MINERU_PIPELINE_PREVIOUS_PARSER_PROFILE_IDS, [
        MINERU_PIPELINE_DOCUMENT_IR_V15_FIGURE_V20_PARSER_PROFILE_ID,
        MINERU_PIPELINE_DOCUMENT_IR_V14_FIGURE_V20_PARSER_PROFILE_ID,
        MINERU_PIPELINE_DOCUMENT_IR_V13_FIGURE_V20_PARSER_PROFILE_ID,
        MINERU_PIPELINE_DOCUMENT_IR_V13_FIGURE_V19_PARSER_PROFILE_ID,
    ]);
    assert.ok(Object.isFrozen(MINERU_PIPELINE_PREVIOUS_PARSER_PROFILE_IDS));
    assert.equal(MINERU_PIPELINE_DOCUMENT_IR_V13_FIGURE_V20_PARSER_PROFILE_ID,
        '{"batch":{"model_version":"pipeline","enable_formula":true,"enable_table":true},"file":{"is_ocr":true},"document":"mineru-document-ir-v13","figureStructure":"figure-region-v20"}');
    assert.equal(MINERU_PIPELINE_DOCUMENT_IR_V13_FIGURE_V19_PARSER_PROFILE_ID,
        '{"batch":{"model_version":"pipeline","enable_formula":true,"enable_table":true},"file":{"is_ocr":true},"document":"mineru-document-ir-v13","figureStructure":"figure-region-v19"}');
    assert.equal(JSON.parse(mineruCloudProfilesFor('pipeline').cacheProfile).figureStructure, 'figure-region-v21');
    assert.equal(JSON.parse(mineruCloudProfilesFor('pipeline').cacheProfile).document, MINERU_DOCUMENT_PIPELINE);
    assert.equal(MINERU_DOCUMENT_PIPELINE, 'mineru-document-ir-v16');
});

test('selects previous profiles only for the exact current cloud model identity', () => {
    for (const [modelVersion, expected] of [
        ['vlm', MINERU_PREVIOUS_PARSER_PROFILE_IDS],
        ['pipeline', MINERU_PIPELINE_PREVIOUS_PARSER_PROFILE_IDS],
    ]) {
        const current = mineruCloudProfilesFor(modelVersion).cacheProfile;
        const previous = mineruCloudPreviousParserProfilesFor(current);
        assert.equal(previous, expected);
        assert.ok(previous.every(profile => JSON.parse(profile).batch.model_version === modelVersion));
        assert.equal(previous.includes(current), false);
    }
    for (const unknown of [
        undefined, null, '', 'vlm', 'pipeline', {},
        MINERU_LOCAL_PARSER_PROFILE_ID,
        MINERU_REQUEST_PROFILE_ID,
        mineruCloudProfilesFor('pipeline').requestProfile,
        MINERU_DOCUMENT_IR_V15_FIGURE_V20_PARSER_PROFILE_ID,
        MINERU_DOCUMENT_IR_V14_FIGURE_V20_PARSER_PROFILE_ID,
        MINERU_DOCUMENT_IR_V13_FIGURE_V20_PARSER_PROFILE_ID,
        MINERU_DOCUMENT_IR_V13_FIGURE_V19_PARSER_PROFILE_ID,
        MINERU_PIPELINE_DOCUMENT_IR_V15_FIGURE_V20_PARSER_PROFILE_ID,
        MINERU_PIPELINE_DOCUMENT_IR_V13_FIGURE_V20_PARSER_PROFILE_ID,
        MINERU_PIPELINE_DOCUMENT_IR_V13_FIGURE_V19_PARSER_PROFILE_ID,
        mineruCloudProfilesFor('pipeline').cacheProfile.replace('"enable_table":true', '"enable_table":false'),
    ]) {
        assert.deepEqual(mineruCloudPreviousParserProfilesFor(unknown), []);
    }
});

for (const [modelVersion, previousProfile, otherPreviousProfile] of [
    ['vlm', MINERU_DOCUMENT_IR_V15_FIGURE_V20_PARSER_PROFILE_ID, MINERU_PIPELINE_DOCUMENT_IR_V15_FIGURE_V20_PARSER_PROFILE_ID],
    ['pipeline', MINERU_PIPELINE_DOCUMENT_IR_V15_FIGURE_V20_PARSER_PROFILE_ID, MINERU_DOCUMENT_IR_V15_FIGURE_V20_PARSER_PROFILE_ID],
]) {
    const currentProfile = mineruCloudProfilesFor(modelVersion).cacheProfile;
    const fileData = new Uint8Array([1]);
    const keyFor = parserProfile => createMarkdownCacheKey(fileData, { parserProfile });

    for (const method of ['extract', 'readCached']) {
        test(`${method} reopens the ${modelVersion} v15 correction after the v16 upgrade`, async () => {
            const currentKey = await keyFor(currentProfile);
            const previousKey = await keyFor(previousProfile);
            const reads = [];
            const extractor = createRevisionExtractor(modelVersion, async ({ cacheKey }) => {
                reads.push(cacheKey);
                return cacheKey === previousKey ? { markdown: '# Corrected v15' } : null;
            });

            const result = await extractor[method](42);

            assert.equal(result.markdown, '# Corrected v15');
            assert.equal(result.parserProfile, previousProfile);
            assert.equal(result.cacheKey, previousKey);
            assert.deepEqual(reads, [currentKey, previousKey]);
        });

        test(`${method} never accesses another model's correction from ${modelVersion}`, async () => {
            const otherKey = await keyFor(otherPreviousProfile);
            const reads = [];
            const extractor = createRevisionExtractor(modelVersion, async ({ cacheKey }) => {
                reads.push(cacheKey);
                return cacheKey === otherKey ? { markdown: '# Other model correction' } : null;
            });
            // A cache miss is enough to exercise every historical revision lookup.
            extractor.conversion = {
                convert: async () => ({ origin: 'fresh', result: { markdown: '# Current result' } }),
                readCached: async () => null,
            };

            const result = await extractor[method](42);

            assert.equal(result?.markdown ?? null, method === 'extract' ? '# Current result' : null);
            assert.deepEqual(reads, await Promise.all([
                currentProfile, ...mineruCloudPreviousParserProfilesFor(currentProfile),
            ].map(keyFor)));
            assert.equal(reads.includes(otherKey), false);
        });
    }

    test(`${modelVersion} inherits v15 translations without accessing the other model`, async () => {
        const currentKey = await keyFor(currentProfile);
        const previousKey = await keyFor(previousProfile);
        const otherKey = await keyFor(otherPreviousProfile);
        const previousKeys = await Promise.all(mineruCloudPreviousParserProfilesFor(currentProfile).map(keyFor));
        for (const availableKey of [previousKey, otherKey]) {
            const copies = [];
            const conversion = new MinerUConversion({
                client: createSuccessfulClient('# Converted'),
                pendingTasks: createKeyedMemoryPendingTasks(),
                cache: {
                    get: async () => null,
                    put: async () => {},
                    copyTranslations: async (from, to) => {
                        copies.push([from, to]);
                        return from === availableKey ? 1 : 0;
                    },
                },
                createTranslationSourceKeys: (bytes, { modelVersion: selected }) => Promise.all(
                    mineruCloudPreviousParserProfilesFor(mineruCloudProfilesFor(selected).cacheProfile)
                        .map(parserProfile => createMarkdownCacheKey(bytes, { parserProfile }))
                ),
                createDataID: () => 'mktero-task-profile-upgrade',
            });

            const result = await conversion.convert({
                key: currentKey,
                apiKey: 'secret-token',
                fileName: 'paper.pdf',
                fileData,
                cacheEnabled: true,
                modelVersion,
            });

            assert.deepEqual(result.warnings, []);
            assert.deepEqual(copies, (availableKey === previousKey ? [previousKey] : previousKeys)
                .map(key => [key, currentKey]));
            assert.equal(copies.some(([from]) => from === otherKey), false);
        }
    });
}

test('lists exactly the two cloud models and rejects anything else', () => {
    assert.deepEqual([...MINERU_CLOUD_MODEL_VERSIONS], ['vlm', 'pipeline']);
    assert.deepEqual(
        [...MINERU_CLOUD_CACHE_PROFILE_IDS],
        [mineruCloudProfilesFor('vlm').cacheProfile, mineruCloudProfilesFor('pipeline').cacheProfile]
    );
    assert.deepEqual(
        [...MINERU_CLOUD_REQUEST_PROFILE_IDS],
        [mineruCloudProfilesFor('vlm').requestProfile, mineruCloudProfilesFor('pipeline').requestProfile]
    );
    for (const invalid of ['', 'vlm ', 'MinerU-HTML', 'mineru-html', 1, {}, null]) {
        assert.throws(
            () => mineruCloudProfilesFor(invalid),
            error => error.code === 'MINERU_UNKNOWN_MODEL'
        );
        assert.throws(
            () => mineruBatchOptionsFor(invalid),
            error => error.code === 'MINERU_UNKNOWN_MODEL'
        );
    }
    assert.deepEqual(mineruBatchOptionsFor(), { ...MINERU_BATCH_OPTIONS });
});

test('each cloud model writes its own Markdown cache and raw result keys', async () => {
    const calls = [];
    const conversion = new MinerUConversion({
        client: createSuccessfulClient('# Converted'),
        pendingTasks: createKeyedMemoryPendingTasks(),
        cache: {
            get: async () => null,
            put: async (key, result) => { calls.push(['put', key, result.markdown]); },
        },
        resultStore: {
            get: async () => null,
            put: async key => { calls.push(['raw', key]); },
        },
        createResultKey: async (_fileData, options) => {
            calls.push(['resultKey', options.modelVersion, options.requestProfile]);
            return `raw-${options.modelVersion}`;
        },
        createDataID: () => 'mktero-task-model',
    });
    const fileData = new Uint8Array([1]);

    await conversion.convert({
        key: 'vlm-key',
        apiKey: 'secret-token',
        fileName: 'paper.pdf',
        fileData,
        cacheEnabled: true,
        modelVersion: 'vlm',
    });
    await conversion.convert({
        key: 'pipeline-key',
        apiKey: 'secret-token',
        fileName: 'paper.pdf',
        fileData,
        cacheEnabled: true,
        modelVersion: 'pipeline',
    });

    const vlm = mineruCloudProfilesFor('vlm');
    const pipeline = mineruCloudProfilesFor('pipeline');
    assert.deepEqual(calls, [
        ['resultKey', 'vlm', vlm.requestProfile],
        ['raw', 'raw-vlm'],
        ['put', 'vlm-key', '# Converted'],
        ['resultKey', 'pipeline', pipeline.requestProfile],
        ['raw', 'raw-pipeline'],
        ['put', 'pipeline-key', '# Converted'],
    ]);
});

test('a pipeline read never restores a previous vlm cache entry', async () => {
    const requestedProfiles = [];
    const reads = [];
    const conversion = new MinerUConversion({
        client: createUnexpectedClient(),
        pendingTasks: createKeyedMemoryPendingTasks(),
        cache: {
            get: async key => {
                reads.push(key);
                return key === 'vlm-key'
                    ? { markdown: '# Vlm result', assets: [], sourceMap: [] }
                    : null;
            },
            put: async () => {},
        },
        createPreviousCacheKeys: async (_fileData, { modelVersion }) => {
            requestedProfiles.push(modelVersion);
            return modelVersion === 'vlm' ? ['vlm-key'] : ['pipeline-old-key'];
        },
    });

    const result = await conversion.readCached({
        key: 'pipeline-key',
        fileData: new Uint8Array([1]),
        cacheEnabled: true,
        modelVersion: 'pipeline',
    });

    assert.equal(result, null);
    assert.deepEqual(requestedProfiles, ['pipeline']);
    assert.deepEqual(reads, ['pipeline-key', 'pipeline-old-key']);
});

test('translation carry-over keys are asked for the frozen model', async () => {
    const requestedProfiles = [];
    const conversion = new MinerUConversion({
        client: createSuccessfulClient('# Converted'),
        pendingTasks: createKeyedMemoryPendingTasks(),
        cache: {
            get: async () => null,
            put: async () => {},
            copyTranslations: async () => 1,
        },
        createTranslationSourceKeys: async (_fileData, { modelVersion }) => {
            requestedProfiles.push(modelVersion);
            return ['previous-key'];
        },
        createDataID: () => 'mktero-task-translations',
    });

    await conversion.convert({
        key: 'pipeline-key',
        apiKey: 'secret-token',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1]),
        cacheEnabled: true,
        modelVersion: 'pipeline',
    });

    assert.deepEqual(requestedProfiles, ['pipeline']);
});

test('resumes a stored pipeline task after the conversion is recreated', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cloud-model-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const storeOptions = {
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: createNodePathUtils(),
        now: () => 1_700_000_000_000,
    };
    let markCollectStarted;
    const collectStarted = new Promise(resolve => { markCollectStarted = resolve; });
    const controller = new AbortController();
    const first = new MinerUConversion({
        client: {
            async submit({ dataID, modelVersion }) {
                assert.equal(modelVersion, 'pipeline');
                return { batchID: 'batch-pipeline', dataID, modelVersion };
            },
            async collect({ signal }) {
                markCollectStarted();
                return new Promise((resolve, reject) => {
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                });
            },
        },
        pendingTasks: new MinerUPendingTaskStore(storeOptions),
        createDataID: () => 'mktero-task-pipeline',
        now: () => 1_700_000_000_000,
    }).convert({
        key: CONVERSION_KEY,
        apiKey: 'secret-token',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1]),
        modelVersion: 'pipeline',
        signal: controller.signal,
    });
    await collectStarted;
    controller.abort();
    await assert.rejects(first, error => error.name === 'AbortError');

    let submitted = false;
    const second = new MinerUConversion({
        client: {
            async submit() {
                submitted = true;
                throw new Error('the PDF must not be uploaded again');
            },
            async collect({ task }) {
                assert.equal(task.batchID, 'batch-pipeline');
                assert.equal(task.modelVersion, 'pipeline');
                return { markdown: '# Resumed pipeline result' };
            },
        },
        pendingTasks: new MinerUPendingTaskStore(storeOptions),
        createDataID: () => 'mktero-task-other',
        now: () => 1_700_000_000_001,
    });

    const result = await second.convert({
        key: CONVERSION_KEY,
        apiKey: 'secret-token',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1]),
        modelVersion: 'pipeline',
    });

    assert.equal(submitted, false);
    assert.equal(result.origin, 'resumed');
    assert.equal(result.result.markdown, '# Resumed pipeline result');
});

test('resumes a pending record written before model selection as vlm', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cloud-model-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const tasksPath = path.join(rootPath, 'tasks');
    await mkdir(tasksPath, { recursive: true });
    await writeFile(
        path.join(tasksPath, `${CONVERSION_KEY}.json`),
        JSON.stringify({
            schemaVersion: 1,
            conversionKey: CONVERSION_KEY,
            batchID: 'batch-legacy-vlm',
            dataID: 'mktero-task-legacy-vlm',
            uploadedAt: 1_700_000_000_000,
        })
    );
    const conversion = new MinerUConversion({
        client: {
            async submit() {
                throw new Error('the PDF must not be uploaded again');
            },
            async collect({ task }) {
                assert.equal(task.batchID, 'batch-legacy-vlm');
                return { markdown: '# Legacy vlm result' };
            },
        },
        pendingTasks: new MinerUPendingTaskStore({
            rootPath,
            ioUtils: createNodeIOUtils(),
            pathUtils: createNodePathUtils(),
            now: () => 1_700_000_000_000,
        }),
        now: () => 1_700_000_000_001,
    });

    const result = await conversion.convert({
        key: CONVERSION_KEY,
        apiKey: 'secret-token',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1]),
    });

    assert.equal(result.origin, 'resumed');
    assert.equal(result.result.markdown, '# Legacy vlm result');
});

test('refuses to resume a pending vlm task as pipeline and keeps it', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cloud-model-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const storeOptions = {
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: createNodePathUtils(),
        now: () => 1_700_000_000_000,
    };
    const pending = {
        batchID: 'batch-vlm',
        dataID: 'mktero-task-vlm',
        uploadedAt: 1_700_000_000_000,
        modelVersion: 'vlm',
    };
    await new MinerUPendingTaskStore(storeOptions).put(CONVERSION_KEY, pending);
    let submitted = false;
    const conversion = new MinerUConversion({
        client: {
            async submit() {
                submitted = true;
                throw new Error('a mismatched pending task must not resubmit');
            },
            async collect() {
                throw new Error('a mismatched pending task must not be collected');
            },
        },
        pendingTasks: new MinerUPendingTaskStore(storeOptions),
        now: () => 1_700_000_000_001,
    });

    await assert.rejects(
        () => conversion.convert({
            key: CONVERSION_KEY,
            apiKey: 'secret-token',
            fileName: 'paper.pdf',
            fileData: new Uint8Array([1]),
            modelVersion: 'pipeline',
        }),
        error => error.code === 'MINERU_PENDING_MODEL_MISMATCH'
            && error.pendingModelVersion === 'vlm'
            && error.modelVersion === 'pipeline'
    );

    assert.equal(submitted, false);
    assert.deepEqual(
        await new MinerUPendingTaskStore(storeOptions).get(CONVERSION_KEY),
        pending
    );
});

test('a forced refresh of one model never touches the other model on the same key', async () => {
    const pendingTasks = createKeyedMemoryPendingTasks({
        'vlm-key': {
            batchID: 'batch-vlm',
            dataID: 'mktero-task-vlm',
            uploadedAt: 1_600_000_000_000,
            modelVersion: 'vlm',
        },
    });
    const conversion = new MinerUConversion({
        client: createSuccessfulClient('# Pipeline result'),
        pendingTasks,
        createDataID: () => 'mktero-task-pipeline',
        now: () => 1_700_000_000_000,
    });

    const result = await conversion.convert({
        key: 'pipeline-key',
        apiKey: 'secret-token',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1]),
        modelVersion: 'pipeline',
        forceRefresh: true,
    });

    assert.equal(result.origin, 'fresh');
    // The pipeline task was committed and removed; the vlm task survived.
    assert.equal(await pendingTasks.get('pipeline-key'), null);
    assert.deepEqual(await pendingTasks.get('vlm-key'), {
        batchID: 'batch-vlm',
        dataID: 'mktero-task-vlm',
        uploadedAt: 1_600_000_000_000,
        modelVersion: 'vlm',
    });
});

test('a forced refresh refuses another model\'s task on the same key instead of overwriting it', async () => {
    const pending = {
        batchID: 'batch-vlm',
        dataID: 'mktero-task-vlm',
        uploadedAt: 1_600_000_000_000,
        modelVersion: 'vlm',
    };
    const calls = [];
    const pendingTasks = {
        async get() {
            calls.push(['get']);
            return pending;
        },
        async put(_key, task) {
            calls.push(['put', task.modelVersion]);
        },
        async delete(_key, batchID) {
            calls.push(['delete', batchID]);
            return true;
        },
    };
    const conversion = new MinerUConversion({
        client: {
            async submit() {
                calls.push(['submit']);
                return { batchID: 'batch-pipeline', dataID: 'mktero-task-pipeline', modelVersion: 'pipeline' };
            },
            async collect() {
                calls.push(['collect']);
                return { markdown: '# Pipeline result' };
            },
        },
        pendingTasks,
        createDataID: () => 'mktero-task-pipeline',
        now: () => 1_700_000_000_000,
    });

    await assert.rejects(
        () => conversion.convert({
            key: CONVERSION_KEY,
            apiKey: 'secret-token',
            fileName: 'paper.pdf',
            fileData: new Uint8Array([1]),
            modelVersion: 'pipeline',
            forceRefresh: true,
        }),
        error => error.code === 'MINERU_PENDING_MODEL_MISMATCH'
            && error.pendingModelVersion === 'vlm'
            && error.modelVersion === 'pipeline'
    );

    // No overwrite, no deletion, no upload: the vlm task is untouched.
    assert.deepEqual(calls, [['get']]);
    assert.deepEqual(await pendingTasks.get(), pending);
});

test('a client that reports another model is refused instead of mislabelling the task', async () => {
    const pendingTasks = createKeyedMemoryPendingTasks();
    const conversion = new MinerUConversion({
        client: {
            async submit({ dataID }) {
                return { batchID: 'batch-wrong', dataID, modelVersion: 'vlm' };
            },
            async collect() {
                throw new Error('a mismatched receipt must not be collected');
            },
        },
        pendingTasks,
        createDataID: () => 'mktero-task-wrong',
    });

    await assert.rejects(
        () => conversion.convert({
            key: CONVERSION_KEY,
            apiKey: 'secret-token',
            fileName: 'paper.pdf',
            fileData: new Uint8Array([1]),
            modelVersion: 'pipeline',
        }),
        error => error.code === 'MINERU_SUBMIT_MODEL_MISMATCH'
            && error.submittedModelVersion === 'vlm'
            && error.modelVersion === 'pipeline'
    );
    assert.equal(await pendingTasks.get(CONVERSION_KEY), null);
});

test('a forced refresh commits over a task of its own model', async () => {
    const pendingTasks = createKeyedMemoryPendingTasks({
        [CONVERSION_KEY]: {
            batchID: 'batch-stale',
            dataID: 'mktero-task-stale',
            uploadedAt: 1_600_000_000_000,
            modelVersion: 'pipeline',
        },
    });
    const conversion = new MinerUConversion({
        client: createSuccessfulClient('# Refreshed result'),
        pendingTasks,
        createDataID: () => 'mktero-task-refresh',
        now: () => 1_700_000_000_000,
    });

    const result = await conversion.convert({
        key: CONVERSION_KEY,
        apiKey: 'secret-token',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1]),
        modelVersion: 'pipeline',
        forceRefresh: true,
    });

    assert.equal(result.origin, 'fresh');
    assert.equal(result.result.markdown, '# Refreshed result');
    // The superseded task of the same model was replaced and then removed.
    assert.equal(await pendingTasks.get(CONVERSION_KEY), null);
});

test('switching model keeps the running task and switching back resumes it', async () => {
    const pendingTasks = createKeyedMemoryPendingTasks({
        'vlm-key': {
            batchID: 'batch-vlm',
            dataID: 'mktero-task-vlm',
            uploadedAt: 1_700_000_000_000,
            modelVersion: 'vlm',
        },
    });
    const submittedModels = [];
    const conversion = new MinerUConversion({
        client: {
            async submit({ dataID, modelVersion }) {
                submittedModels.push(modelVersion);
                return { batchID: 'batch-pipeline', dataID, modelVersion };
            },
            async collect({ task }) {
                return { markdown: `# ${task.batchID}` };
            },
        },
        pendingTasks,
        createDataID: () => 'mktero-task-pipeline',
        now: () => 1_700_000_000_000,
    });

    const pipeline = await conversion.convert({
        key: 'pipeline-key',
        apiKey: 'secret-token',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1]),
        modelVersion: 'pipeline',
    });
    assert.equal(pipeline.origin, 'fresh');
    assert.deepEqual(submittedModels, ['pipeline']);

    const vlm = await conversion.convert({
        key: 'vlm-key',
        apiKey: 'secret-token',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1]),
        modelVersion: 'vlm',
    });

    assert.equal(vlm.origin, 'resumed');
    assert.equal(vlm.result.markdown, '# batch-vlm');
    assert.deepEqual(submittedModels, ['pipeline']);
});

test('a preference change during one conversion cannot move its task to another model', async () => {
    let preferredModel = 'pipeline';
    const submittedModels = [];
    const cacheKeysAsked = [];
    const conversion = new MinerUConversion({
        client: {
            async submit({ dataID, modelVersion }) {
                submittedModels.push(modelVersion);
                return { batchID: 'batch-frozen', dataID, modelVersion };
            },
            async collect() {
                return { markdown: '# Frozen result' };
            },
        },
        pendingTasks: createKeyedMemoryPendingTasks(),
        cache: { get: async () => null, put: async () => {} },
        resultStore: { get: async () => null, put: async () => {} },
        createPreviousCacheKeys: async (_fileData, { modelVersion }) => {
            cacheKeysAsked.push(modelVersion);
            // A preference flipped while the operation was in flight.
            preferredModel = 'vlm';
            return [];
        },
        createResultKey: async (_fileData, { modelVersion }) => {
            submittedModels.push(`resultKey:${modelVersion}`);
            return `raw-${modelVersion}`;
        },
        createDataID: () => 'mktero-task-frozen',
    });

    await conversion.convert({
        key: 'pipeline-key',
        apiKey: 'secret-token',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1]),
        cacheEnabled: true,
        modelVersion: preferredModel,
    });

    assert.equal(preferredModel, 'vlm');
    assert.deepEqual(submittedModels, ['resultKey:pipeline', 'pipeline']);
    assert.deepEqual(cacheKeysAsked, ['pipeline']);
});

test('rejects an unknown model before touching the network or the cache', async () => {
    let touched = false;
    const conversion = new MinerUConversion({
        client: {
            async submit() { touched = true; throw new Error('must not submit'); },
            async collect() { touched = true; throw new Error('must not collect'); },
        },
        pendingTasks: createKeyedMemoryPendingTasks(),
        cache: {
            get: async () => { touched = true; return null; },
            put: async () => { touched = true; },
        },
    });

    await assert.rejects(
        () => conversion.convert({
            key: CONVERSION_KEY,
            apiKey: 'secret-token',
            fileName: 'paper.pdf',
            fileData: new Uint8Array([1]),
            cacheEnabled: true,
            modelVersion: 'mineru-html',
        }),
        error => error.code === 'MINERU_UNKNOWN_MODEL'
    );
    await assert.rejects(
        () => conversion.readCached({
            key: CONVERSION_KEY,
            fileData: new Uint8Array([1]),
            cacheEnabled: true,
            modelVersion: 'mineru-html',
        }),
        error => error.code === 'MINERU_UNKNOWN_MODEL'
    );
    assert.equal(touched, false);
});

function createRevisionExtractor(modelVersion, readRevision) {
    return new MinerUDocumentExtractor({
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
            convert: async () => assert.fail('a saved correction must not convert'),
            readCached: async () => assert.fail('a saved correction must not read the OCR cache'),
        },
        getApiKey: () => '',
        getParserProfile: () => mineruCloudProfilesFor(modelVersion).cacheProfile,
        getPreviousParserProfiles: mineruCloudPreviousParserProfilesFor,
        getConversionOptions: () => ({ endpoint: 'cloud', modelVersion }),
        readFile: async () => new Uint8Array([1]),
        createCacheKey: createMarkdownCacheKey,
        readRevision,
        prepareResult: result => result,
    });
}

function createSuccessfulClient(markdown) {
    return {
        async submit({ dataID, modelVersion }) {
            return { batchID: 'batch-success', dataID, modelVersion };
        },
        async collect() {
            // A result archive is what the raw-result store receives.
            return { markdown, contentList: [], resultArchive: { archive: new Uint8Array([1]) } };
        },
    };
}

function createUnexpectedClient() {
    return {
        async submit() { throw new Error('must not submit'); },
        async collect() { throw new Error('must not collect'); },
    };
}

function createKeyedMemoryPendingTasks(initial = {}) {
    const tasks = new Map(Object.entries(initial));
    return {
        async get(key) {
            return tasks.get(key) || null;
        },
        async put(key, task) {
            tasks.set(key, task);
        },
        async delete(key, batchID) {
            const current = tasks.get(key);
            if (current?.batchID !== batchID) return false;
            tasks.delete(key);
            return true;
        },
    };
}

function createNodePathUtils() {
    return {
        filename: path.basename,
        join: path.join,
        parent: path.dirname,
    };
}

function createNodeIOUtils() {
    return {
        async exists(filePath) {
            try {
                await stat(filePath);
                return true;
            }
            catch {
                return false;
            }
        },
        makeDirectory: (filePath, options = {}) => mkdir(filePath, {
            recursive: options.ignoreExisting !== false,
        }),
        readUTF8: filePath => readFile(filePath, 'utf8'),
        getChildren: async filePath => (await readdir(filePath))
            .map(name => path.join(filePath, name)),
        stat: async filePath => {
            const value = await stat(filePath);
            return {
                type: value.isDirectory() ? 'directory' : 'regular',
                size: value.size,
            };
        },
        remove: (filePath, options = {}) => rm(filePath, {
            recursive: Boolean(options.recursive),
            force: Boolean(options.ignoreAbsent),
        }),
        async writeUTF8(filePath, data, options = {}) {
            if (!options.tmpPath) {
                await writeFile(filePath, data);
                return;
            }
            await writeFile(options.tmpPath, data);
            await rename(options.tmpPath, filePath);
        },
    };
}
