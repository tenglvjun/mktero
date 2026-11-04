import test from 'node:test';
import assert from 'node:assert/strict';
import { CacheLifecycle, ORPHAN_CACHE_GRACE_MS, attachmentIdentity } from '../src/cache/cache-lifecycle.js';

const HASH = 'a'.repeat(64);
const KEY = 'b'.repeat(64);
const owner = (overrides = {}) => ({ libraryID: 1, attachmentKey: 'PDF1', itemID: 1,
    sourceHash: HASH, sourceBytes: 3, artifacts: [{ store: 'markdown', key: KEY }], ...overrides });
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

function fixture() {
    let records = [];
    let timestamp = 100;
    const live = { complete: true, owners: new Set(), libraries: new Set([1, 2]), itemIDs: new Set(), sources: new Set() };
    const removed = [];
    const removedOwners = [];
    const errors = [];
    const storage = {
        async read() { return structuredClone(records); },
        async write(value) { records = structuredClone(value); },
    };
    const lifecycle = new CacheLifecycle({ storage, snapshot: async () => live,
        now: () => timestamp, remove: async value => removed.push(value),
        removeOwner: async value => removedOwners.push(value), onError: error => errors.push(error),
    });
    return { lifecycle, storage, live, removed, removedOwners, errors,
        records: () => records, advance: (ms = ORPHAN_CACHE_GRACE_MS) => { timestamp += ms; } };
}

async function due(f, value = owner()) {
    await f.lifecycle.remember(value);
    await f.lifecycle.sweep();
    f.advance();
}

test('retains trash and collection removals, then starts grace only after permanent deletion', async () => {
    const f = fixture();
    await f.lifecycle.remember(owner());
    f.live.owners.add(attachmentIdentity(owner()));
    f.live.itemIDs.add(1);
    await f.lifecycle.sweep();
    f.advance();
    await f.lifecycle.sweep();
    assert.equal(f.records()[0].orphanedAt, null);
    f.live.owners.clear();
    f.live.itemIDs.clear();
    await f.lifecycle.sweep();
    f.advance(ORPHAN_CACHE_GRACE_MS - 1);
    await f.lifecycle.sweep();
    assert.deepEqual(f.removed, []);
    f.advance(1);
    assert.equal((await f.lifecycle.sweep()).removed, 1);
    assert.deepEqual(f.removed, owner().artifacts);
    assert.equal(f.removedOwners.length, 1);
    assert.deepEqual(f.records(), []);
});

test('restoring an owner cancels the tombstone and requires a new full grace period', async () => {
    const f = fixture();
    await due(f);
    f.live.owners.add(attachmentIdentity(owner()));
    await f.lifecycle.sweep();
    assert.equal(f.records()[0].orphanedAt, null);
    f.live.owners.clear();
    await f.lifecycle.sweep();
    assert.deepEqual(f.removed, []);
    f.advance();
    await f.lifecycle.sweep();
    assert.equal(f.removed.length, 1);
});

test('protects identical PDFs never opened in Mktero, including another library or trash', async () => {
    const f = fixture();
    await due(f);
    f.live.owners.add('2:UNOPENED');
    f.live.sources.add(HASH);
    await f.lifecycle.sweep();
    assert.deepEqual(f.removed, []);
    f.live.sources.clear();
    f.live.owners.clear();
    await f.lifecycle.sweep();
    assert.equal(f.removed.length, 1);
});

test('retains shared resources until every registered owner passes its grace period', async () => {
    const f = fixture();
    await due(f);
    const second = owner({ itemID: 2, libraryID: 2, attachmentKey: 'PDF2' });
    await f.lifecycle.remember(second);
    await f.lifecycle.sweep();
    assert.deepEqual(f.removed, []);
    f.advance();
    await f.lifecycle.sweep();
    assert.equal(f.records().length, 0);
    assert.equal(f.removedOwners.length, 2);
});

test('merges profile variants without dropping historical keys or resetting other attachments', async () => {
    const f = fixture();
    await f.lifecycle.remember(owner());
    await f.lifecycle.remember(owner({ artifacts: [{ store: 'raw', key: 'c'.repeat(64) }] }));
    assert.equal(f.records()[0].artifacts.length, 2);
    await f.lifecycle.remember(owner());
    assert.equal(f.records()[0].artifacts.length, 2);
    await due(f, owner({ sourceHash: 'd'.repeat(64) }));
    await f.lifecycle.sweep();
    assert.equal(f.records().length, 0);
});

for (const condition of ['incomplete', 'unavailable-library', 'reused-item-id']) {
    test(`defers cleanup for ${condition}`, async () => {
        const f = fixture();
        await due(f);
        if (condition === 'incomplete') f.live.complete = false;
        if (condition === 'unavailable-library') f.live.libraries.clear();
        if (condition === 'reused-item-id') f.live.itemIDs.add(1);
        await f.lifecycle.sweep();
        assert.deepEqual(f.removed, []);
        assert.equal(f.records().length, 1);
    });
}

test('does not interpret missing or corrupt ownership data as unreferenced files', async () => {
    const f = fixture();
    await due(f);
    f.storage.read = async () => { throw new Error('corrupt index'); };
    await assert.rejects(f.lifecycle.sweep(), /corrupt/);
    assert.deepEqual(f.removed, []);
    f.storage.read = async () => [];
    await f.lifecycle.sweep();
    assert.deepEqual(f.removed, []);
});

test('rejects arbitrary paths and malformed records before writing ownership', async () => {
    const f = fixture();
    for (const record of [owner({ attachmentKey: '../PDF1' }), owner({ artifacts: [{ store: 'markdown', key: '../escape' }] }),
        owner({ artifacts: [{ store: 'arbitrary', key: KEY }] }), owner({ itemID: -1 })]) {
        assert.throws(() => f.lifecycle.remember(record));
    }
    assert.deepEqual(f.records(), []);
});

test('persists tombstones across restart and retries a partial deletion', async () => {
    const f = fixture();
    await due(f);
    const resources = [{ store: 'markdown', key: KEY }, { store: 'raw', key: 'c'.repeat(64) }];
    f.records()[0].artifacts = resources;
    let fail = true;
    const lifecycle = new CacheLifecycle({ storage: f.storage, snapshot: async () => f.live,
        now: () => ORPHAN_CACHE_GRACE_MS + 100,
        remove: async value => { if (value.store === 'raw' && fail) throw new Error('permission denied'); f.removed.push(value); },
        removeOwner: async value => f.removedOwners.push(value), onError: () => {},
    });
    await lifecycle.sweep();
    assert.equal(f.records().length, 1);
    assert.equal(f.removedOwners.length, 0);
    fail = false;
    await lifecycle.sweep();
    assert.equal(f.records().length, 0);
    assert.equal(f.removedOwners.length, 1);
});

test('active operations and open readers defer cleanup', async () => {
    const f = fixture();
    await due(f);
    const active = deferred();
    const read = f.lifecycle.use(() => active.promise);
    await f.lifecycle.sweep();
    assert.deepEqual(f.removed, []);
    active.resolve();
    await read;
    f.lifecycle.isBusy = () => true;
    await f.lifecycle.sweep();
    assert.deepEqual(f.removed, []);
    f.lifecycle.isBusy = () => false;
    await f.lifecycle.sweep();
    assert.equal(f.removed.length, 1);
});

test('a Zotero notification or read during scanning cancels stale deletion decisions', async () => {
    const f = fixture();
    await due(f);
    const started = deferred();
    const scan = deferred();
    f.lifecycle.snapshot = async options => {
        if (options.hashes) { started.resolve(); await scan.promise; }
        return f.live;
    };
    const sweep = f.lifecycle.sweep();
    await started.promise;
    f.lifecycle.invalidate();
    scan.resolve();
    await sweep;
    assert.deepEqual(f.removed, []);
});

test('new writes wait for an in-progress removal and stop further removals', async () => {
    const f = fixture();
    await due(f);
    f.records()[0].artifacts.push({ store: 'raw', key: 'c'.repeat(64) });
    const started = deferred();
    const deletion = deferred();
    f.lifecycle.remove = async value => { f.removed.push(value); started.resolve(); await deletion.promise; };
    const sweep = f.lifecycle.sweep();
    await started.promise;
    let written = false;
    const writing = f.lifecycle.use(async () => { written = true; });
    await Promise.resolve();
    assert.equal(written, false);
    deletion.resolve();
    await Promise.all([sweep, writing]);
    assert.equal(written, true);
    assert.equal(f.removed.length, 1);
    assert.equal(f.records().length, 1);
});

test('a failed tombstone commit does not lose the retry record', async () => {
    const f = fixture();
    await due(f);
    const write = f.storage.write;
    f.storage.write = async () => { throw new Error('disk full'); };
    await f.lifecycle.sweep();
    assert.equal(f.records().length, 1);
    assert.equal(f.removed.length, 1);
    f.storage.write = write;
    await f.lifecycle.sweep();
    assert.equal(f.records().length, 0);
});

test('clock rollback cannot shorten the grace period', async () => {
    const f = fixture();
    await f.lifecycle.remember(owner());
    await f.lifecycle.sweep();
    f.advance(-99);
    await f.lifecycle.sweep();
    assert.deepEqual(f.removed, []);
});

test('shutdown prevents pending scans from deleting files', async () => {
    const f = fixture();
    await due(f);
    await f.lifecycle.dispose();
    await f.lifecycle.sweep();
    assert.deepEqual(f.removed, []);
});
