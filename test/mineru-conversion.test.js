import test from 'node:test';
import assert from 'node:assert/strict';
import {
    access,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MarkdownCache } from '../src/cache/markdown-cache.js';
import { CONVERSION_PROGRESS } from '../src/core/conversion-progress.js';
import {
    createTaskDataID,
    MinerUConversion,
} from '../src/mineru/mineru-conversion.js';
import { MinerUPendingTaskStore } from '../src/mineru/pending-task-store.js';

const CONVERSION_KEY = 'a'.repeat(64);

test('creates MinerU task data IDs with a secure UUID', () => {
    const dataID = createTaskDataID({
        randomUUID: () => '12345678-1234-4321-8765-123456789abc',
    });

    assert.equal(dataID, 'mktero-12345678-1234-4321-8765-123456789abc');
});

test('creates MinerU task data IDs with secure random bytes as a fallback', () => {
    const dataID = createTaskDataID({
        getRandomValues(bytes) {
            bytes.set(Array.from({ length: 16 }, (_, index) => index));
            return bytes;
        },
    });

    assert.equal(dataID, 'mktero-000102030405060708090a0b0c0d0e0f');
});

test('rejects MinerU task creation without a secure random source', () => {
    assert.throws(
        () => createTaskDataID({}),
        /Secure random number generation is unavailable/
    );
});

test('marks progress while collecting a resumed MinerU task', async () => {
    const progress = [];
    const conversion = new MinerUConversion({
        client: {
            async submit() {
                throw new Error('the PDF must not be uploaded again');
            },
            async collect({ onProgress }) {
                onProgress(42);
                return { markdown: '# Resumed result' };
            },
        },
        pendingTasks: createMemoryPendingTasks({
            batchID: 'batch-resumed',
            dataID: 'mktero-task-resumed',
            uploadedAt: 1_700_000_000_000,
        }),
        now: () => 1_700_000_000_001,
    });

    const result = await conversion.convert({
        key: CONVERSION_KEY,
        apiKey: 'secret-token',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1]),
        onProgress: (value, state) => progress.push([value, state]),
    });

    assert.equal(result.origin, 'resumed');
    assert.deepEqual(progress, [
        [CONVERSION_PROGRESS.PARSING, { resumingTask: true }],
        [42, { resumingTask: true }],
    ]);
});

test('resumes an uploaded MinerU task across conversion instances', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-conversion-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const storeOptions = {
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join },
        now: () => 1_700_000_000_000,
    };
    let markCollectStarted;
    const collectStarted = new Promise(resolve => { markCollectStarted = resolve; });
    const firstController = new AbortController();
    const first = new MinerUConversion({
        client: {
            async submit(options) {
                assert.equal(options.dataID, 'mktero-task-1');
                return {
                    batchID: 'batch-1',
                    dataID: options.dataID,
                    fileName: options.fileName,
                };
            },
            async collect({ signal }) {
                markCollectStarted();
                return new Promise((resolve, reject) => {
                    signal.addEventListener('abort', () => reject(signal.reason), {
                        once: true,
                    });
                });
            },
        },
        pendingTasks: new MinerUPendingTaskStore(storeOptions),
        createDataID: () => 'mktero-task-1',
        now: () => 1_700_000_000_000,
    }).convert({
        key: CONVERSION_KEY,
        apiKey: 'secret-token',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1, 2, 3]),
        signal: firstController.signal,
    });
    await collectStarted;
    firstController.abort();
    await assert.rejects(first, error => error.name === 'AbortError');

    let submitted = false;
    const second = new MinerUConversion({
        client: {
            async submit() {
                submitted = true;
                throw new Error('the PDF must not be uploaded again');
            },
            async collect({ task }) {
                assert.equal(task.batchID, 'batch-1');
                assert.equal(task.dataID, 'mktero-task-1');
                return { markdown: '# Recovered result' };
            },
        },
        pendingTasks: new MinerUPendingTaskStore(storeOptions),
        createDataID: () => 'mktero-task-2',
        now: () => 1_700_000_000_001,
    });

    const result = await second.convert({
        key: CONVERSION_KEY,
        apiKey: 'secret-token',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1, 2, 3]),
    });

    assert.equal(submitted, false);
    assert.equal(result.origin, 'resumed');
    assert.equal(result.result.markdown, '# Recovered result');
    assert.equal(
        await new MinerUPendingTaskStore(storeOptions).get(CONVERSION_KEY),
        null
    );
});

test('shares one uploaded task without sharing caller cancellation', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-conversion-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    let submissions = 0;
    let collections = 0;
    let markFirstCollectStarted;
    let markSecondCollectStarted;
    const firstCollectStarted = new Promise(resolve => {
        markFirstCollectStarted = resolve;
    });
    const secondCollectStarted = new Promise(resolve => {
        markSecondCollectStarted = resolve;
    });
    const conversion = new MinerUConversion({
        client: {
            async submit({ dataID }) {
                submissions++;
                return { batchID: 'batch-shared', dataID };
            },
            async collect({ signal }) {
                collections++;
                if (collections === 1) {
                    markFirstCollectStarted();
                    return new Promise((resolve, reject) => {
                        signal.addEventListener('abort', () => reject(signal.reason), {
                            once: true,
                        });
                    });
                }
                markSecondCollectStarted();
                return { markdown: '# Shared result' };
            },
        },
        pendingTasks: new MinerUPendingTaskStore({
            rootPath,
            ioUtils: createNodeIOUtils(),
            pathUtils: { join: path.join },
            now: () => 1_700_000_000_000,
        }),
        createDataID: () => 'mktero-task-shared',
        now: () => 1_700_000_000_000,
    });
    const firstController = new AbortController();
    const first = conversion.convert({
        key: CONVERSION_KEY,
        apiKey: 'secret-token',
        fileName: 'first.pdf',
        fileData: new Uint8Array([1]),
        signal: firstController.signal,
    });
    await firstCollectStarted;
    const second = conversion.convert({
        key: CONVERSION_KEY,
        apiKey: 'secret-token',
        fileName: 'second.pdf',
        fileData: new Uint8Array([1]),
        signal: new AbortController().signal,
    });
    await secondCollectStarted;
    firstController.abort();

    await assert.rejects(first, error => error.name === 'AbortError');
    assert.equal((await second).result.markdown, '# Shared result');
    assert.equal(submissions, 1);
});

test('shares the in-memory task when persistence writing fails', async () => {
    let submissions = 0;
    let collections = 0;
    let markFirstCollectStarted;
    let releaseFirstCollect;
    const firstCollectStarted = new Promise(resolve => {
        markFirstCollectStarted = resolve;
    });
    const reported = [];
    const conversion = new MinerUConversion({
        client: {
            async submit({ dataID }) {
                submissions++;
                return { batchID: 'batch-memory', dataID };
            },
            async collect() {
                collections++;
                if (collections === 1) {
                    markFirstCollectStarted();
                    return new Promise(resolve => { releaseFirstCollect = resolve; });
                }
                return { markdown: '# Shared in-memory result' };
            },
        },
        pendingTasks: {
            get: async () => null,
            put: async () => { throw new Error('storage unavailable'); },
            delete: async () => false,
        },
        createDataID: () => 'mktero-task-memory',
        onError: error => reported.push(error),
    });
    const first = conversion.convert({
        key: CONVERSION_KEY,
        apiKey: 'secret-token',
        fileName: 'first.pdf',
        fileData: new Uint8Array([1]),
    });
    await firstCollectStarted;

    const second = await conversion.convert({
        key: CONVERSION_KEY,
        apiKey: 'secret-token',
        fileName: 'second.pdf',
        fileData: new Uint8Array([1]),
    });
    releaseFirstCollect({ markdown: '# First result' });
    await first;

    assert.equal(second.result.markdown, '# Shared in-memory result');
    assert.equal(submissions, 1);
    assert.ok(reported.some(error => error.message === 'storage unavailable'));
});

test('does not let an older task overwrite a forced refresh result', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-conversion-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const ioUtils = createNodeIOUtils();
    const pathUtils = {
        join: path.join,
        filename: path.basename,
        parent: path.dirname,
    };
    let submissions = 0;
    let releaseOldResult;
    let markOldCollectStarted;
    const oldCollectStarted = new Promise(resolve => {
        markOldCollectStarted = resolve;
    });
    const conversion = new MinerUConversion({
        client: {
            async submit({ dataID }) {
                submissions++;
                return {
                    batchID: submissions === 1 ? 'batch-old' : 'batch-new',
                    dataID,
                };
            },
            async collect({ task }) {
                if (task.batchID === 'batch-old') {
                    markOldCollectStarted();
                    return new Promise(resolve => { releaseOldResult = resolve; });
                }
                return { markdown: '# New result' };
            },
        },
        pendingTasks: new MinerUPendingTaskStore({
            rootPath: path.join(rootPath, 'pending'),
            ioUtils,
            pathUtils,
            now: () => 1_700_000_000_000,
        }),
        cache: new MarkdownCache({
            rootPath: path.join(rootPath, 'cache'),
            ioUtils,
            pathUtils,
            now: () => 1_700_000_000_000,
        }),
        createDataID: () => `mktero-task-${submissions + 1}`,
        now: () => 1_700_000_000_000,
    });
    const oldConversion = conversion.convert({
        key: CONVERSION_KEY,
        apiKey: 'secret-token',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1]),
        cacheEnabled: true,
    });
    await oldCollectStarted;

    const refreshed = await conversion.convert({
        key: CONVERSION_KEY,
        apiKey: 'secret-token',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1]),
        cacheEnabled: true,
        forceRefresh: true,
    });
    releaseOldResult({ markdown: '# Old result' });
    await oldConversion;

    assert.equal(refreshed.origin, 'fresh');
    assert.equal(
        (await new MarkdownCache({
            rootPath: path.join(rootPath, 'cache'),
            ioUtils,
            pathUtils,
            now: () => 1_700_000_000_000,
        }).get(CONVERSION_KEY)).markdown,
        '# New result'
    );
});

test('cleans a superseded task when forced-refresh persistence fails', async () => {
    let persisted = {
        batchID: 'batch-old',
        dataID: 'mktero-task-old',
        uploadedAt: 1_600_000_000_000,
    };
    const pendingTasks = {
        get: async () => persisted,
        put: async () => { throw new Error('replacement failed'); },
        async delete(_key, batchID) {
            if (persisted?.batchID !== batchID) return false;
            persisted = null;
            return true;
        },
    };
    let cached = null;
    const conversion = new MinerUConversion({
        client: createSuccessfulClient('# Forced result'),
        pendingTasks,
        cache: {
            get: async () => null,
            put: async (_key, result) => { cached = result; },
        },
        createDataID: () => 'mktero-task-new',
        now: () => 1_700_000_000_000,
    });

    const result = await conversion.convert({
        key: CONVERSION_KEY,
        apiKey: 'secret-token',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1]),
        cacheEnabled: true,
        forceRefresh: true,
    });

    assert.equal(result.result.markdown, '# Forced result');
    assert.equal(cached.markdown, '# Forced result');
    assert.equal(persisted, null);
});

test('removes a pending task after MinerU reports a terminal failure', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-conversion-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const store = new MinerUPendingTaskStore({
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join },
        now: () => 1_700_000_000_000,
    });
    const conversion = new MinerUConversion({
        client: {
            async submit({ dataID }) {
                return { batchID: 'batch-failed', dataID };
            },
            async collect() {
                const error = new Error('MinerU parsing failed: page limit exceeded');
                error.code = 'MINERU_TASK_FAILED';
                throw error;
            },
        },
        pendingTasks: store,
        createDataID: () => 'mktero-task-failed',
        now: () => 1_700_000_000_000,
    });

    await assert.rejects(
        () => conversion.convert({
            key: CONVERSION_KEY,
            apiKey: 'secret-token',
            fileName: 'paper.pdf',
            fileData: new Uint8Array([1]),
        }),
        /page limit exceeded/
    );

    assert.equal(await store.get(CONVERSION_KEY), null);
});

test('returns a completed cache entry without a token or MinerU request', async () => {
    const cached = { markdown: '# Cached result' };
    const conversion = new MinerUConversion({
        client: createUnexpectedClient(),
        pendingTasks: createMemoryPendingTasks(),
        cache: {
            async get(key) {
                assert.equal(key, CONVERSION_KEY);
                return cached;
            },
        },
    });

    const result = await conversion.convert({
        key: CONVERSION_KEY,
        apiKey: '',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1]),
        cacheEnabled: true,
    });

    assert.equal(result.origin, 'cache');
    assert.equal(result.result, cached);
});

test('resumes a pending refresh instead of returning an older cache entry', async () => {
    const pendingTasks = createMemoryPendingTasks({
        batchID: 'batch-refresh',
        dataID: 'mktero-task-refresh',
        uploadedAt: 1_700_000_000_000,
    });
    let cacheReads = 0;
    const conversion = new MinerUConversion({
        client: {
            submit: async () => { throw new Error('must resume'); },
            async collect({ task }) {
                assert.equal(task.batchID, 'batch-refresh');
                return { markdown: '# Refreshed result' };
            },
        },
        pendingTasks,
        cache: {
            async get() {
                cacheReads++;
                return { markdown: '# Older cached result' };
            },
            async put() {},
        },
    });

    const result = await conversion.convert({
        key: CONVERSION_KEY,
        apiKey: 'secret-token',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1]),
        cacheEnabled: true,
    });

    assert.equal(result.origin, 'resumed');
    assert.equal(result.result.markdown, '# Refreshed result');
    assert.equal(cacheReads, 0);
});

test('ignores a normal cache entry when completed-result reuse is disabled', async () => {
    let cacheWrites = 0;
    const conversion = new MinerUConversion({
        client: createSuccessfulClient('# Fresh result'),
        pendingTasks: createMemoryPendingTasks(),
        cache: {
            async get() {
                return { markdown: '# Cached result' };
            },
            async put() {
                cacheWrites++;
            },
        },
        createDataID: () => 'mktero-task-fresh',
        now: () => 1_700_000_000_000,
    });

    const result = await conversion.convert({
        key: CONVERSION_KEY,
        apiKey: 'secret-token',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1]),
        cacheEnabled: false,
    });

    assert.equal(result.origin, 'fresh');
    assert.equal(result.result.markdown, '# Fresh result');
    assert.equal(cacheWrites, 0);
});

test('reuses a user-edited cache entry even when reuse is disabled', async () => {
    const cached = { markdown: '# Edited result', userEdited: true };
    const conversion = new MinerUConversion({
        client: createUnexpectedClient(),
        pendingTasks: createMemoryPendingTasks(),
        cache: { get: async () => cached },
    });

    const result = await conversion.convert({
        key: CONVERSION_KEY,
        apiKey: '',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1]),
        cacheEnabled: false,
    });

    assert.equal(result.origin, 'cache');
    assert.equal(result.result, cached);
});

test('returns a successful result with a warning when cache writing fails', async () => {
    const cacheError = new Error('disk full');
    const reported = [];
    const conversion = new MinerUConversion({
        client: createSuccessfulClient('# Fresh result'),
        pendingTasks: createMemoryPendingTasks(),
        cache: {
            get: async () => null,
            put: async () => { throw cacheError; },
        },
        createDataID: () => 'mktero-task-fresh',
        now: () => 1_700_000_000_000,
        onError: error => reported.push(error),
    });

    const result = await conversion.convert({
        key: CONVERSION_KEY,
        apiKey: 'secret-token',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1]),
        cacheEnabled: true,
    });

    assert.equal(result.result.markdown, '# Fresh result');
    assert.deepEqual(result.warnings, [
        'The Markdown result could not be saved to the local cache.',
    ]);
    assert.deepEqual(reported, [cacheError]);
});

test('stores normalized MinerU Markdown with its PDF source map', async () => {
    const rawResult = {
        markdown: 'The framework improves the ability to change perspective on\n\n'
            + 'an event), and context engagement.',
        contentList: [{
            type: 'text',
            text: 'The framework improves the ability to change perspective on',
            pageIndex: 0,
            bbox: [100, 100, 900, 200],
        }, {
            type: 'text',
            text: 'an event), and context engagement.',
            pageIndex: 1,
            bbox: [100, 80, 900, 160],
        }],
    };
    let cachedResult = null;
    const conversion = new MinerUConversion({
        client: createSuccessfulClient(rawResult),
        pendingTasks: createMemoryPendingTasks(),
        cache: {
            get: async () => null,
            put: async (_key, result) => { cachedResult = result; },
        },
        createDataID: () => 'mktero-task-raw',
        now: () => 1_700_000_000_000,
    });

    const result = await conversion.convert({
        key: CONVERSION_KEY,
        apiKey: 'secret-token',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1]),
        cacheEnabled: true,
    });

    const normalized = 'The framework improves the ability to change perspective on '
        + 'an event), and context engagement.';
    assert.equal(cachedResult.markdown, normalized);
    assert.equal(result.result.markdown, normalized);
    assert.deepEqual(cachedResult.sourceMap, [{
        type: 'text',
        markdownFrom: 0,
        markdownTo: normalized.length,
        locations: [
            { pageIndex: 0, bbox: [100, 100, 900, 200] },
            { pageIndex: 1, bbox: [100, 80, 900, 160] },
        ],
    }]);
});

test('keeps an uploaded task after transient and caller-abort failures', async t => {
    for (const failure of [
        Object.assign(new Error('temporary network failure'), {
            code: 'MINERU_NETWORK_ERROR',
        }),
        Object.assign(new Error('caller closed the tab'), { name: 'AbortError' }),
    ]) {
        await t.test(failure.name, async () => {
            const task = {
                batchID: `batch-${failure.name}`,
                dataID: `task-${failure.name}`,
                uploadedAt: 1_700_000_000_000,
            };
            const pendingTasks = createMemoryPendingTasks(task);
            const conversion = new MinerUConversion({
                client: {
                    submit: async () => { throw new Error('must resume'); },
                    collect: async () => { throw failure; },
                },
                pendingTasks,
            });

            await assert.rejects(() => conversion.convert({
                key: CONVERSION_KEY,
                apiKey: 'secret-token',
                fileName: 'paper.pdf',
                fileData: new Uint8Array([1]),
            }), error => error === failure);

            assert.equal((await pendingTasks.get(CONVERSION_KEY)).batchID, task.batchID);
        });
    }
});

test('does not reuse an in-memory task after its recovery lifetime', async () => {
    let now = 1_000;
    let submissions = 0;
    let collections = 0;
    const conversion = new MinerUConversion({
        client: {
            async submit({ dataID }) {
                submissions++;
                return { batchID: `batch-${submissions}`, dataID };
            },
            async collect() {
                collections++;
                if (collections === 1) {
                    const error = new Error('temporary network failure');
                    error.code = 'MINERU_NETWORK_ERROR';
                    throw error;
                }
                return { markdown: '# New task result' };
            },
        },
        pendingTasks: {
            get: async () => null,
            put: async () => {},
            delete: async () => false,
        },
        createDataID: () => `mktero-task-${submissions + 1}`,
        now: () => now,
        maxTaskAgeMs: 1_000,
    });
    const options = {
        key: CONVERSION_KEY,
        apiKey: 'secret-token',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1]),
    };
    await assert.rejects(() => conversion.convert(options), /network failure/);

    now = 2_001;
    const result = await conversion.convert(options);

    assert.equal(result.result.markdown, '# New task result');
    assert.equal(submissions, 2);
});

test('bounds in-memory recovery handles independently of persistence', async () => {
    let submissions = 0;
    const conversion = new MinerUConversion({
        client: {
            async submit({ dataID }) {
                submissions++;
                return { batchID: `batch-${submissions}`, dataID };
            },
            async collect() {
                const error = new Error('temporary network failure');
                error.code = 'MINERU_NETWORK_ERROR';
                throw error;
            },
        },
        pendingTasks: {
            get: async () => null,
            put: async () => {},
            delete: async () => false,
        },
        createDataID: () => `mktero-task-${submissions + 1}`,
        now: () => 1_000,
        maxInMemoryTasks: 2,
    });
    const convert = key => conversion.convert({
        key,
        apiKey: 'secret-token',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1]),
    });

    await assert.rejects(() => convert('a'.repeat(64)), /network failure/);
    await assert.rejects(() => convert('b'.repeat(64)), /network failure/);
    await assert.rejects(() => convert('c'.repeat(64)), /network failure/);
    await assert.rejects(() => convert('a'.repeat(64)), /network failure/);

    assert.equal(submissions, 4);
});

test('converts without persistence when a content key is unavailable', async () => {
    let persistenceCalls = 0;
    const conversion = new MinerUConversion({
        client: createSuccessfulClient('# Untracked result'),
        pendingTasks: {
            async get() { persistenceCalls++; },
            async put() { persistenceCalls++; },
            async delete() { persistenceCalls++; },
        },
        createDataID: () => 'mktero-task-untracked',
    });

    const result = await conversion.convert({
        key: null,
        apiKey: 'secret-token',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1]),
    });

    assert.equal(result.origin, 'fresh');
    assert.equal(result.result.markdown, '# Untracked result');
    assert.equal(persistenceCalls, 0);
});

test('does not upload when pending-task lookup is uncertain', async () => {
    const readError = new Error('pending-task read failed');
    const reported = [];
    const conversion = new MinerUConversion({
        client: createUnexpectedClient(),
        pendingTasks: {
            get: async () => { throw readError; },
            put: async () => {},
            delete: async () => false,
        },
        onError: error => reported.push(error),
    });

    await assert.rejects(() => conversion.convert({
        key: CONVERSION_KEY,
        apiKey: 'secret-token',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1]),
    }), error => error === readError);
    assert.deepEqual(reported, [readError]);
});

function createSuccessfulClient(result) {
    return {
        async submit({ dataID, fileName }) {
            return { batchID: 'batch-success', dataID, fileName };
        },
        async collect() {
            return typeof result === 'string' ? { markdown: result } : result;
        },
    };
}

function createUnexpectedClient() {
    return {
        async submit() {
            throw new Error('MinerU submission was not expected');
        },
        async collect() {
            throw new Error('MinerU collection was not expected');
        },
    };
}

function createMemoryPendingTasks(initialTask = null) {
    let current = initialTask;
    return {
        async get() {
            return current;
        },
        async put(_key, task) {
            current = task;
        },
        async delete(_key, batchID) {
            if (current?.batchID !== batchID) return false;
            current = null;
            return true;
        },
    };
}

function createNodeIOUtils() {
    return {
        async exists(filePath) {
            try {
                await access(filePath);
                return true;
            }
            catch {
                return false;
            }
        },
        read: async filePath => new Uint8Array(await readFile(filePath)),
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
        async write(filePath, data, options = {}) {
            await atomicWrite(filePath, data, options.tmpPath);
        },
        async writeUTF8(filePath, data, options = {}) {
            await atomicWrite(filePath, data, options.tmpPath);
        },
    };
}

async function atomicWrite(filePath, data, temporaryPath) {
    if (!temporaryPath) {
        await writeFile(filePath, data);
        return;
    }
    await writeFile(temporaryPath, data);
    await rename(temporaryPath, filePath);
}
