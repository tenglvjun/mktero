import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    createZoteroMinerUImportIndex,
    MinerUImportIndex,
    MinerUImportIndexError,
} from '../src/cache/mineru-import-index.js';
import { createLLMCacheRawKey, LLM_CACHE_ADAPTER_VERSION } from '../src/mineru/llm-cache-profile.js';

const SOURCE = 'a'.repeat(64);
const SNAPSHOT = 'b'.repeat(64);
const identity = (overrides = {}) => ({ libraryID: 1, attachmentKey: 'ATTACH01', sourceHash: SOURCE, ...overrides });

async function record(overrides = {}) {
    const result = {
        ...identity(), snapshotHash: SNAPSHOT, adapterVersion: LLM_CACHE_ADAPTER_VERSION,
        importedAt: 100, binding: 'user-confirmed', ...overrides,
    };
    return { ...result, rawKey: await createLLMCacheRawKey(result) };
}

function fixture(options = {}) {
    let content = null;
    let failed = false;
    const writes = [];
    const adapter = {
        async read() { return content; },
        async write(value) {
            if (failed) throw new Error('disk full');
            content = value;
            writes.push(JSON.parse(value));
        },
    };
    const index = new MinerUImportIndex({ adapter, ...options });
    return { index, writes, adapter, corrupt(value) { content = value; }, fail(value = true) { failed = value; } };
}

function pauseNext(target, method) {
    const original = target[method].bind(target);
    const entered = Promise.withResolvers();
    const released = Promise.withResolvers();
    let paused = false;
    target[method] = async (...args) => {
        const result = await original(...args);
        if (!paused) {
            paused = true;
            entered.resolve();
            await released.promise;
        }
        return result;
    };
    return { entered: entered.promise, release: released.resolve };
}

async function fileFixture(t) {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mktero-import-index-'));
    t.after(() => fs.rm(profile, { recursive: true, force: true }));
    const moves = [];
    const ioUtils = {
        async exists(file) {
            try { await fs.access(file); return true; }
            catch (error) { if (error.code === 'ENOENT') return false; throw error; }
        },
        async stat(file) {
            const info = await fs.stat(file);
            return { type: info.isFile() ? 'regular' : 'directory', size: info.size };
        },
        readUTF8: file => fs.readFile(file, 'utf8'),
        makeDirectory: directory => fs.mkdir(directory, { recursive: true }),
        async writeUTF8(file, value, { tmpPath } = {}) {
            await fs.writeFile(tmpPath || file, value, 'utf8');
            if (tmpPath) await fs.rename(tmpPath, file);
        },
        async move(from, to, options) {
            moves.push({ from, to, options });
            await fs.rename(from, to);
        },
        remove: (file, { ignoreAbsent } = {}) => fs.rm(file, { force: ignoreAbsent }),
    };
    const adapters = {
        zotero: { Profile: { dir: profile } },
        ioUtils,
        pathUtils: { join: path.join, parent: path.dirname },
    };
    return {
        index: createZoteroMinerUImportIndex(adapters),
        restart: () => createZoteroMinerUImportIndex(adapters),
        io: ioUtils,
        moves,
        rootPath: path.join(profile, 'mktero-imports', 'v1'),
    };
}

test('loads an empty index and atomically publishes an attachment selection', async () => {
    const f = fixture();
    await f.index.load();
    assert.equal(await f.index.get(identity()), null);
    assert.equal(f.index.peekForAttachment(identity()), null);
    const selected = await record();
    await f.index.publish(selected);
    assert.deepEqual(await f.index.get(identity()), selected);
    const read = await f.index.get(identity());
    read.snapshotHash = 'c'.repeat(64);
    assert.deepEqual(f.index.peekForAttachment(identity()), selected);
    assert.equal(f.writes[0].schemaVersion, 1);
    assert.equal(f.writes[0].records.length, 1);
    const restarted = new MinerUImportIndex({ adapter: f.adapter });
    await restarted.load();
    assert.deepEqual(await restarted.get(identity()), selected);
});

test('keeps selections independent for equal PDF bytes in different attachments or libraries', async () => {
    const f = fixture();
    const a = await record();
    const b = await record({ attachmentKey: 'ATTACH02', importedAt: 200 });
    const c = await record({ libraryID: 2, importedAt: 300 });
    await Promise.all([a, b, c].map(item => f.index.publish(item)));
    assert.equal(a.rawKey, b.rawKey);
    assert.equal(a.rawKey, c.rawKey);
    await f.index.forget(identity());
    assert.equal(await f.index.get(identity()), null);
    assert.deepEqual(await f.index.get(identity({ attachmentKey: 'ATTACH02' })), b);
    assert.deepEqual(await f.index.get(identity({ libraryID: 2 })), c);
});

test('looks up current PDF hash exactly and peeks the latest choice per attachment', async () => {
    const f = fixture();
    const old = await record();
    const next = await record({ sourceHash: 'd'.repeat(64), importedAt: 200 });
    await f.index.publish(old);
    await f.index.publish(next);
    assert.deepEqual(await f.index.get(identity()), old);
    assert.deepEqual(await f.index.get(identity({ sourceHash: next.sourceHash })), next);
    assert.equal(await f.index.get(identity({ sourceHash: 'e'.repeat(64) })), null);
    assert.deepEqual(f.index.peekForAttachment(identity()), next);
});

test('does not overwrite or forget a newer selection after a failed or stale operation', async () => {
    const f = fixture();
    const first = await record();
    await f.index.publish(first);
    f.fail();
    const newer = await record({ snapshotHash: 'c'.repeat(64), importedAt: 200 });
    await assert.rejects(f.index.publish(newer), error => error instanceof MinerUImportIndexError && error.code === 'LLM_CACHE_IMPORT_INDEX_WRITE_FAILED');
    assert.deepEqual(await f.index.get(identity()), first);
    f.fail(false);
    await f.index.publish(newer);
    assert.equal(await f.index.forget(identity(), { expectedRecord: first }), false);
    assert.deepEqual(await f.index.get(identity()), newer);
    assert.equal(await f.index.forget(identity(), { expectedRecord: newer }), true);
});

test('rejects invalid or unsupported persisted records instead of treating them as a cache miss', async () => {
    for (const invalid of ['{bad', '{"schemaVersion":2,"records":[]}', '{"schemaVersion":1,"records":[{}]}']) {
        const f = fixture();
        f.corrupt(invalid);
        await assert.rejects(f.index.load(), error => error instanceof MinerUImportIndexError);
        await assert.rejects(f.index.get(identity()), error => error instanceof MinerUImportIndexError);
    }
    const f = fixture();
    const selected = await record();
    f.corrupt(JSON.stringify({ schemaVersion: 1, records: [{ ...selected, rawKey: 'f'.repeat(64) }] }));
    await assert.rejects(f.index.get(identity()), /key/i);
});

test('rejects untrusted paths and unknown adapter identities without publishing them', async () => {
    const f = fixture();
    const selected = await record();
    await assert.rejects(f.index.publish({ ...selected, attachmentKey: '../private' }), /identity/i);
    await assert.rejects(f.index.publish({ ...selected, rawKey: '../../private' }), /record/i);
    await assert.rejects(f.index.publish({ ...selected, adapterVersion: 'future' }), /adapter/i);
    assert.equal(f.writes.length, 0);
});

test('enforces hard entry and byte limits without evicting existing user selections', async () => {
    const f = fixture({ maxEntries: 1 });
    const first = await record();
    await f.index.publish(first);
    await assert.rejects(f.index.publish(await record({ attachmentKey: 'ATTACH02' })), error => error.code === 'LLM_CACHE_IMPORT_INDEX_FULL');
    assert.deepEqual(await f.index.get(identity()), first);
    const tiny = fixture({ maxBytes: 10 });
    await assert.rejects(tiny.index.publish(first), /limit/i);
    assert.equal(tiny.writes.length, 0);
});

test('distinguishes a newer identical snapshot published within the same clock tick', async () => {
    const f = fixture();
    const first = await record();
    await f.index.publish(first);
    const newer = await f.index.publish(first);
    assert.ok(newer.importedAt > first.importedAt);
    assert.equal(await f.index.forget(identity(), { expectedRecord: first }), false);
    assert.deepEqual(await f.index.get(identity()), newer);
});

test('loads attachment candidates once and serves subsequent checks from memory', async () => {
    const selected = await record();
    let reads = 0;
    const index = new MinerUImportIndex({ adapter: {
        async read() { reads++; return JSON.stringify({ schemaVersion: 1, records: [selected] }); },
        async write() {},
    } });
    assert.deepEqual(await index.selectionsForAttachment(identity()), [selected]);
    assert.deepEqual(await index.selectionsForAttachment(identity()), [selected]);
    assert.deepEqual(await index.get(identity()), selected);
    assert.equal(reads, 1);
    assert.deepEqual(await index.selectionsForAttachment(identity({ attachmentKey: 'NONE0001' })), []);
});

test('honors cancellation before publishing, including while queued behind another operation', async () => {
    const controller = new AbortController();
    const f = fixture();
    const selected = await record();
    controller.abort();
    await assert.rejects(f.index.publish(selected, { signal: controller.signal }), error => error.name === 'AbortError');
    assert.equal(f.writes.length, 0);
    await f.index.publish(selected);
    await assert.rejects(f.index.forget(identity(), { signal: controller.signal }), error => error.name === 'AbortError');
    assert.deepEqual(await f.index.get(identity()), selected);
});

test('restores disk and memory when a plain adapter finishes writing after cancellation', async t => {
    for (const hasPrevious of [false, true]) {
        await t.test(hasPrevious ? 'replacement selection' : 'first selection', async t => {
            const f = fixture();
            const previous = hasPrevious ? await record() : null;
            if (previous) {
                // Recovery must preserve the loaded serialization, including whitespace.
                f.corrupt(JSON.stringify({ schemaVersion: 1, records: [previous] }, null, 2));
                await f.index.load();
            }
            const before = await f.adapter.read();
            const next = await record({ snapshotHash: 'c'.repeat(64), importedAt: 200 });
            const gate = pauseNext(f.adapter, 'write');
            t.after(gate.release);
            const controller = new AbortController();
            const rejected = assert.rejects(f.index.publish(next, { signal: controller.signal }), { name: 'AbortError' });
            await gate.entered;
            assert.deepEqual(f.index.peekForAttachment(identity()), previous);
            controller.abort();
            gate.release();
            await rejected;
            assert.deepEqual(await f.index.get(identity()), previous);
            const disk = await f.adapter.read();
            if (previous) assert.equal(disk, before);
            else assert.deepEqual(JSON.parse(disk).records, []);
            const restarted = new MinerUImportIndex({ adapter: f.adapter });
            assert.deepEqual(await restarted.get(identity()), previous);
        });
    }
});

test('restores a selected attachment when cancellation happens during forget', async () => {
    const f = fixture();
    const previous = await record();
    await f.index.publish(previous);
    const before = await f.adapter.read();
    const write = f.adapter.write;
    const controller = new AbortController();
    f.adapter.write = async (value, { signal } = {}) => {
        await write(value);
        if (signal) {
            controller.abort();
            throw signal.reason;
        }
    };
    await assert.rejects(f.index.forget(identity(), { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(await f.adapter.read(), before);
    assert.deepEqual(await f.index.get(identity()), previous);
    assert.deepEqual(await new MinerUImportIndex({ adapter: f.adapter }).get(identity()), previous);
});

test('finishes cancellation recovery before allowing a queued newer selection to publish', async t => {
    const f = fixture();
    const previous = await record();
    await f.index.publish(previous);
    const cancelled = await record({ snapshotHash: 'c'.repeat(64), importedAt: 200 });
    const newer = await record({ snapshotHash: 'd'.repeat(64), importedAt: 300 });
    const gate = pauseNext(f.adapter, 'write');
    t.after(gate.release);
    const controller = new AbortController();
    const rejected = assert.rejects(f.index.publish(cancelled, { signal: controller.signal }), { name: 'AbortError' });
    await gate.entered;
    const queued = f.index.publish(newer);
    controller.abort();
    gate.release();
    await rejected;
    await queued;
    assert.deepEqual(await f.index.get(identity()), newer);
    assert.deepEqual(await new MinerUImportIndex({ adapter: f.adapter }).get(identity()), newer);
    assert.deepEqual(f.writes.map(write => write.records[0].snapshotHash), [
        previous.snapshotHash, cancelled.snapshotHash, previous.snapshotHash, newer.snapshotHash,
    ]);
});

test('restores partial adapter writes on ordinary publish and forget failures', async t => {
    for (const operation of ['publish', 'forget']) {
        await t.test(operation, async () => {
            const f = fixture();
            const previous = await record();
            await f.index.publish(previous);
            const before = await f.adapter.read();
            const write = f.adapter.write;
            let fail = true;
            f.adapter.write = async value => {
                await write(value);
                if (fail) {
                    fail = false;
                    throw new Error('write failed after changing disk');
                }
            };
            const pending = operation === 'publish'
                ? f.index.publish(await record({ snapshotHash: 'c'.repeat(64), importedAt: 200 }))
                : f.index.forget(identity());
            await assert.rejects(pending, { code: 'LLM_CACHE_IMPORT_INDEX_WRITE_FAILED' });
            assert.equal(await f.adapter.read(), before);
            assert.deepEqual(await f.index.get(identity()), previous);
            assert.deepEqual(await new MinerUImportIndex({ adapter: f.adapter }).get(identity()), previous);
        });
    }
});

test('fails closed when a damaged write cannot be restored', async () => {
    const f = fixture();
    await f.index.publish(await record());
    f.adapter.write = async () => {
        f.corrupt('{partial');
        throw new Error('disk failed');
    };
    await assert.rejects(f.index.forget(identity()), { code: 'LLM_CACHE_IMPORT_INDEX_WRITE_FAILED' });
    await assert.rejects(f.index.get(identity()), error => error instanceof MinerUImportIndexError);
    await assert.rejects(f.index.selectionsForAttachment(identity()), error => error instanceof MinerUImportIndexError);
    assert.throws(() => f.index.peekForAttachment(identity()), error => error instanceof MinerUImportIndexError);
    await assert.rejects(new MinerUImportIndex({ adapter: f.adapter }).get(identity()), error => error instanceof MinerUImportIndexError);
});

test('does not replace the live file if cancellation happens while writing staging', async t => {
    for (const hasPrevious of [false, true]) {
        await t.test(hasPrevious ? 'replacement selection' : 'first selection', async t => {
            const f = await fileFixture(t);
            const previous = hasPrevious ? await record() : null;
            if (previous) await f.index.publish(previous);
            const before = await f.index.adapter.read();
            const movesBefore = f.moves.length;
            const gate = pauseNext(f.io, 'writeUTF8');
            t.after(gate.release);
            const controller = new AbortController();
            const next = await record({ snapshotHash: 'c'.repeat(64), importedAt: 200 });
            const rejected = assert.rejects(f.index.publish(next, { signal: controller.signal }), { name: 'AbortError' });
            await gate.entered;
            const during = await f.index.adapter.read();
            controller.abort();
            gate.release();
            await rejected;
            assert.equal(during, before);
            assert.equal(await f.index.adapter.read(), before);
            assert.equal(f.moves.length, movesBefore);
            assert.deepEqual(await f.index.get(identity()), previous);
            assert.deepEqual(await f.restart().get(identity()), previous);
            assert.deepEqual(await fs.readdir(f.rootPath), previous ? ['index.json'] : []);
        });
    }
});

test('rolls back an in-flight atomic move when cancellation wins before memory commit', async t => {
    for (const hasPrevious of [false, true]) {
        await t.test(hasPrevious ? 'replacement selection' : 'first selection', async t => {
            const f = await fileFixture(t);
            const previous = hasPrevious ? await record() : null;
            if (previous) await f.index.publish(previous);
            const before = await f.index.adapter.read();
            const gate = pauseNext(f.io, 'move');
            t.after(gate.release);
            const controller = new AbortController();
            const next = await record({ snapshotHash: 'c'.repeat(64), importedAt: 200 });
            const rejected = assert.rejects(f.index.publish(next, { signal: controller.signal }), { name: 'AbortError' });
            await gate.entered;
            assert.deepEqual(f.index.peekForAttachment(identity()), previous);
            controller.abort();
            gate.release();
            await rejected;
            if (previous) assert.equal(await f.index.adapter.read(), before);
            assert.deepEqual(await f.index.get(identity()), previous);
            assert.deepEqual(await f.restart().get(identity()), previous);
            assert.deepEqual(await fs.readdir(f.rootPath), ['index.json']);
        });
    }
});

test('keeps the old file when staging writes or atomic moves fail', async t => {
    for (const failure of ['staging write', 'move before replacement', 'move after replacement']) {
        await t.test(failure, async t => {
            const f = await fileFixture(t);
            const previous = await record();
            await f.index.publish(previous);
            const before = await f.index.adapter.read();
            const method = failure === 'staging write' ? 'writeUTF8' : 'move';
            const original = f.io[method].bind(f.io);
            let fail = true;
            f.io[method] = async (...args) => {
                if (!fail) return original(...args);
                fail = false;
                if (failure !== 'move before replacement') await original(...args);
                throw new Error('simulated file failure');
            };
            await assert.rejects(f.index.publish(await record({ snapshotHash: 'c'.repeat(64), importedAt: 200 })), {
                code: 'LLM_CACHE_IMPORT_INDEX_WRITE_FAILED',
            });
            assert.equal(await f.index.adapter.read(), before);
            assert.deepEqual(await f.index.get(identity()), previous);
            assert.deepEqual(await f.restart().get(identity()), previous);
            assert.deepEqual(await fs.readdir(f.rootPath), ['index.json']);
        });
    }
});
