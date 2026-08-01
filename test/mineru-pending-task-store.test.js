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
import {
    MinerUPendingTaskStore,
} from '../src/mineru/pending-task-store.js';

const CONVERSION_KEY = 'a'.repeat(64);
const SECOND_CONVERSION_KEY = 'b'.repeat(64);
const THIRD_CONVERSION_KEY = 'c'.repeat(64);
const EXPIRED_CONVERSION_KEY = 'e'.repeat(64);

test('restores an uploaded MinerU task across store instances', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-pending-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const options = {
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: createNodePathUtils(),
        now: () => 1_700_000_000_000,
    };
    const task = {
        batchID: 'batch-1',
        dataID: 'mktero-task-1',
        uploadedAt: 1_700_000_000_000,
    };

    await new MinerUPendingTaskStore(options).put(CONVERSION_KEY, task);

    assert.deepEqual(
        await new MinerUPendingTaskStore(options).get(CONVERSION_KEY),
        task
    );
});

test('does not delete a newer task when an older task finishes', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-pending-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const store = new MinerUPendingTaskStore({
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: createNodePathUtils(),
        now: () => 1_700_000_000_000,
    });
    await store.put(CONVERSION_KEY, {
        batchID: 'batch-new',
        dataID: 'mktero-task-new',
        uploadedAt: 1_700_000_000_000,
    });

    assert.equal(await store.delete(CONVERSION_KEY, 'batch-old'), false);
    assert.equal(await store.delete(CONVERSION_KEY, 'batch-new'), true);
    assert.equal(await store.get(CONVERSION_KEY), null);
});

test('removes an expired task when it is read', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-pending-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    let now = 1_999;
    const store = new MinerUPendingTaskStore({
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: createNodePathUtils(),
        now: () => now,
        maxAgeMs: 999,
    });
    await store.put(CONVERSION_KEY, {
        batchID: 'batch-expired',
        dataID: 'mktero-task-expired',
        uploadedAt: 1_000,
    });

    assert.equal((await store.get(CONVERSION_KEY)).batchID, 'batch-expired');
    now = 2_000;
    assert.equal(await store.get(CONVERSION_KEY), null);
    assert.equal(
        await pathExists(path.join(rootPath, 'tasks', `${CONVERSION_KEY}.json`)),
        false
    );
});

test('prunes malformed, expired, and excess task records', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-pending-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const tasksPath = path.join(rootPath, 'tasks');
    const store = new MinerUPendingTaskStore({
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: createNodePathUtils(),
        now: () => 10_000,
        maxAgeMs: 5_000,
        maxEntries: 2,
    });
    await store.put(CONVERSION_KEY, createTask('one', 8_000));
    await store.put(SECOND_CONVERSION_KEY, createTask('two', 9_000));
    await store.put(THIRD_CONVERSION_KEY, createTask('three', 10_000));
    await writeFile(path.join(tasksPath, 'malformed.json'), '{not-json');
    await writeFile(
        path.join(tasksPath, `${'d'.repeat(64)}.json`),
        JSON.stringify({ schemaVersion: 1, conversionKey: 'd'.repeat(64) })
    );
    await writeFile(
        path.join(tasksPath, `${EXPIRED_CONVERSION_KEY}.json`),
        JSON.stringify({
            schemaVersion: 1,
            conversionKey: EXPIRED_CONVERSION_KEY,
            batchID: 'batch-expired',
            dataID: 'mktero-task-expired',
            uploadedAt: 1_000,
        })
    );

    const result = await store.prune();

    assert.deepEqual(result, { tasks: 2 });
    assert.equal(await store.get(CONVERSION_KEY), null);
    assert.equal((await store.get(SECOND_CONVERSION_KEY)).batchID, 'batch-two');
    assert.equal((await store.get(THIRD_CONVERSION_KEY)).batchID, 'batch-three');
    assert.deepEqual((await readdir(tasksPath)).sort(), [
        `${SECOND_CONVERSION_KEY}.json`,
        `${THIRD_CONVERSION_KEY}.json`,
    ]);
});

test('rejects oversized task records before reading their contents', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-pending-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const ioUtils = createNodeIOUtils();
    const taskPath = path.join(rootPath, 'tasks', `${CONVERSION_KEY}.json`);
    await mkdir(path.dirname(taskPath), { recursive: true });
    await writeFile(taskPath, 'x'.repeat(129));
    let contentRead = false;
    const originalReadUTF8 = ioUtils.readUTF8;
    ioUtils.readUTF8 = async filePath => {
        contentRead = true;
        return originalReadUTF8(filePath);
    };
    const store = new MinerUPendingTaskStore({
        rootPath,
        ioUtils,
        pathUtils: createNodePathUtils(),
        maxRecordBytes: 128,
    });

    assert.equal(await store.get(CONVERSION_KEY), null);
    assert.equal(contentRead, false);
    assert.equal(await pathExists(taskPath), false);
});

test('keeps a valid task record when reading temporarily fails', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-pending-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const options = {
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: createNodePathUtils(),
        now: () => 1_700_000_000_000,
    };
    await new MinerUPendingTaskStore(options).put(
        CONVERSION_KEY,
        createTask('recoverable', 1_700_000_000_000)
    );
    const failingIO = createNodeIOUtils();
    failingIO.readUTF8 = async () => {
        throw new Error('temporary read failure');
    };

    await assert.rejects(
        () => new MinerUPendingTaskStore({
            ...options,
            ioUtils: failingIO,
        }).get(CONVERSION_KEY),
        /temporary read failure/
    );
    assert.equal(
        await pathExists(path.join(rootPath, 'tasks', `${CONVERSION_KEY}.json`)),
        true
    );
});

function createTask(suffix, uploadedAt) {
    return {
        batchID: `batch-${suffix}`,
        dataID: `mktero-task-${suffix}`,
        uploadedAt,
    };
}

function createNodePathUtils() {
    return {
        filename: path.basename,
        join: path.join,
        parent: path.dirname,
    };
}

async function pathExists(filePath) {
    try {
        await access(filePath);
        return true;
    }
    catch {
        return false;
    }
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
