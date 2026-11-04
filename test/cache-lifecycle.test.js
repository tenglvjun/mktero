import test from 'node:test';
import assert from 'node:assert/strict';
import { CacheLifecycle, attachmentIdentity } from '../src/cache/cache-lifecycle.js';

const HASH = 'a'.repeat(64);
const KEY = 'b'.repeat(64);
const RAW = { store: 'raw', key: 'c'.repeat(64) };
const owner = (overrides = {}) => ({
    libraryID: 1, attachmentKey: 'PDF1', itemID: 1, sourceHash: HASH, sourceBytes: 3,
    artifacts: [{ store: 'markdown', key: KEY }], ...overrides,
});
const otherOwner = (overrides = {}) => owner({
    libraryID: 2, attachmentKey: 'PDF2', itemID: 2, sourceHash: 'd'.repeat(64), sourceBytes: 7,
    artifacts: [{ store: 'markdown', key: 'e'.repeat(64) }], ...overrides,
});
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

function fixture(options = {}) {
    let records = [];
    let timestamp = 100;
    let idleCalls = 0;
    const live = { complete: true, owners: new Set(), libraries: new Set([1, 2]), itemIDs: new Set(), sources: new Set() };
    const removed = [];
    const removedOwners = [];
    const errors = [];
    const snapshots = [];
    const storage = {
        async read() { return structuredClone(records); },
        async write(value) { records = structuredClone(value); },
    };
    const lifecycle = new CacheLifecycle({
        storage,
        snapshot: async value => { snapshots.push(value); return structuredClone(live); },
        now: () => timestamp,
        remove: async value => removed.push(value),
        removeOwner: async value => removedOwners.push(value),
        onError: error => errors.push(error),
        onIdle: () => { idleCalls++; },
        ...options,
    });
    return {
        lifecycle, storage, live, removed, removedOwners, errors, snapshots,
        records: () => records, setTime: value => { timestamp = value; }, idleCalls: () => idleCalls,
    };
}

function holdUse(t, lifecycle, scope) {
    const active = deferred();
    t.after(() => active.resolve());
    return { release: active.resolve, pending: lifecycle.use(() => active.promise, scope) };
}

test('retains trash and collection removals, then cleans immediately after permanent deletion', async () => {
    const f = fixture();
    await f.lifecycle.remember(owner());
    f.live.owners.add(attachmentIdentity(owner()));
    f.live.itemIDs.add(1);
    await f.lifecycle.sweep();
    await f.lifecycle.sweep();
    assert.equal(f.records()[0].orphanedAt, null);
    assert.deepEqual(f.removed, []);
    assert.deepEqual(f.removedOwners, []);
    f.live.owners.clear();
    f.live.itemIDs.clear();
    const result = await f.lifecycle.sweep();
    assert.equal(result.removed, 1);
    assert.equal(result.ownersRemoved, 1);
    assert.deepEqual(f.removed, owner().artifacts);
    assert.equal(f.removedOwners[0].itemID, 1);
    assert.deepEqual(f.records(), []);
});

test('legacy tombstone timestamps and clock rollback do not impose a retention period', async () => {
    const f = fixture();
    await f.storage.write([{ ...owner(), orphanedAt: 100 }]);
    f.setTime(1);
    assert.equal((await f.lifecycle.sweep()).removed, 1);
    assert.deepEqual(f.removed, owner().artifacts);
    assert.deepEqual(f.records(), []);
});

test('a restored owner clears its legacy tombstone and protects its resources', async () => {
    const f = fixture();
    await f.storage.write([{ ...owner(), orphanedAt: 50 }]);
    f.live.owners.add(attachmentIdentity(owner()));
    await f.lifecycle.sweep();
    assert.equal(f.records()[0].orphanedAt, null);
    assert.deepEqual(f.removedOwners, []);
    assert.deepEqual(f.removed, []);
    f.live.owners.clear();
    assert.equal((await f.lifecycle.sweep()).removed, 1);
});

test('cleans private records while an unopened duplicate in another library or trash protects shared files', async () => {
    const f = fixture();
    await f.lifecycle.remember(owner());
    f.live.owners.add('2:UNOPENED');
    f.live.sources.add(HASH);
    const result = await f.lifecycle.sweep();
    assert.equal(result.ownersRemoved, 1);
    assert.equal(result.referenced, 1);
    assert.equal(result.removed, 0);
    assert.deepEqual(f.removed, []);
    assert.equal(f.records()[0].ownerCleaned, true);
    await f.lifecycle.sweep();
    assert.equal(f.removedOwners.length, 1);
    f.live.sources.clear();
    f.live.owners.clear();
    assert.equal((await f.lifecycle.sweep()).removed, 1);
    assert.equal(f.removedOwners.length, 1);
    assert.deepEqual(f.records(), []);
});

for (const shared of ['source', 'artifact']) {
    test(`a live registered owner protects a shared ${shared} after another owner's private cleanup`, async () => {
        const f = fixture();
        const second = otherOwner(shared === 'source'
            ? { sourceHash: HASH, sourceBytes: 3 } : { artifacts: owner().artifacts });
        await f.lifecycle.remember(owner());
        await f.lifecycle.remember(second);
        f.live.owners.add(attachmentIdentity(second));
        f.live.itemIDs.add(second.itemID);
        const result = await f.lifecycle.sweep();
        assert.equal(result.referenced, 1);
        assert.deepEqual(f.removedOwners.map(value => value.itemID), [1]);
        assert.deepEqual(f.removed, []);
        assert.equal(f.records().length, 2);
        f.live.owners.clear();
        f.live.itemIDs.clear();
        assert.equal((await f.lifecycle.sweep()).removed, 2);
        assert.deepEqual(f.removedOwners.map(value => value.itemID), [1, 2]);
        assert.deepEqual(f.records(), []);
    });
}

test('merges historical profile keys while preserving other attachments and source versions', async () => {
    const f = fixture();
    const second = { ...otherOwner(), orphanedAt: 50, ownerCleaned: true };
    await f.storage.write([second]);
    await f.lifecycle.remember(owner());
    await f.lifecycle.remember(owner({ artifacts: [RAW] }));
    await f.lifecycle.remember(owner());
    await f.lifecycle.remember(owner({ sourceHash: 'f'.repeat(64), artifacts: [RAW] }));
    assert.deepEqual(f.records().find(value => value.itemID === 2), second);
    assert.deepEqual(f.records().find(value => value.sourceHash === HASH).artifacts, [...owner().artifacts, RAW]);
    assert.equal(f.records().length, 3);
    assert.equal((await f.lifecycle.sweep()).removed, 3);
    assert.deepEqual(f.records(), []);
});

test('remembering a restored attachment resets private cleanup without losing historical keys', async () => {
    const f = fixture();
    await f.storage.write([{ ...owner(), orphanedAt: 50, ownerCleaned: true }]);
    await f.lifecycle.remember(owner({ artifacts: [RAW] }));
    assert.equal(f.records()[0].orphanedAt, null);
    assert.notEqual(f.records()[0].ownerCleaned, true);
    assert.deepEqual(f.records()[0].artifacts, [...owner().artifacts, RAW]);
    await f.lifecycle.sweep();
    assert.equal(f.removedOwners.length, 1);
    assert.deepEqual(f.removed, [...owner().artifacts, RAW]);
});

test('targeted sweeps preserve other unmarked owners and hash only selected source sizes', async () => {
    const f = fixture();
    await f.lifecycle.remember(owner());
    await f.lifecycle.remember(otherOwner());
    const result = await f.lifecycle.sweep({ itemIDs: new Set([2]) });
    assert.equal(result.removed, 1);
    assert.deepEqual(f.removedOwners.map(value => value.itemID), [2]);
    assert.deepEqual(f.removed, otherOwner().artifacts);
    assert.deepEqual(f.records().map(value => value.itemID), [1]);
    assert.deepEqual(f.snapshots.map(value => value.hashes), [false, true]);
    assert.deepEqual(f.snapshots[1].sourceSizes, [7]);
    assert.equal(f.snapshots[0].generation, f.snapshots[1].generation);
    assert.ok(Number.isSafeInteger(f.snapshots[1].generation));
    assert.equal((await f.lifecycle.sweep()).removed, 1);
});

test('targeted deletion of an unregistered duplicate retries an orphan but preserves other unmarked owners', async () => {
    const f = fixture();
    await f.lifecycle.remember(owner());
    f.live.owners.add('2:UNOPENED');
    f.live.itemIDs.add(9);
    f.live.sources.add(HASH);
    const initial = await f.lifecycle.sweep({ itemIDs: new Set([1]) });
    assert.equal(initial.referenced, 1);
    assert.equal(f.records()[0].ownerCleaned, true);
    assert.deepEqual(f.removed, []);
    await f.lifecycle.remember(otherOwner());
    assert.equal(f.records().find(value => value.itemID === 2).orphanedAt, null);
    f.live.owners.clear();
    f.live.itemIDs.clear();
    f.live.sources.clear();
    const retried = await f.lifecycle.sweep({ itemIDs: new Set([9]) });
    assert.equal(retried.removed, 1);
    assert.equal(retried.ownersRemoved, 0);
    assert.deepEqual(f.removed, owner().artifacts);
    assert.deepEqual(f.removedOwners.map(value => value.itemID), [1]);
    assert.deepEqual(f.records().map(value => value.itemID), [2]);
    assert.notEqual(f.records()[0].ownerCleaned, true);
});

test('targeted sweeps retry a prior tombstone even before private cleanup was committed', async () => {
    const f = fixture();
    await f.storage.write([
        { ...owner(), orphanedAt: 0 },
        { ...otherOwner(), orphanedAt: null },
    ]);
    const result = await f.lifecycle.sweep({ itemIDs: new Set([9]) });
    assert.equal(result.removed, 1);
    assert.equal(result.ownersRemoved, 1);
    assert.deepEqual(f.removedOwners.map(value => value.itemID), [1]);
    assert.deepEqual(f.removed, owner().artifacts);
    assert.deepEqual(f.records().map(value => value.itemID), [2]);
});

test('an empty item selection with no pending tombstones does not clean owners or scan hashes', async () => {
    const f = fixture();
    await f.lifecycle.remember(owner());
    assert.equal((await f.lifecycle.sweep({ itemIDs: new Set() })).removed, 0);
    assert.deepEqual(f.removedOwners, []);
    assert.deepEqual(f.removed, []);
    assert.deepEqual(f.snapshots.map(value => value.hashes), [false]);
    assert.equal(f.records().length, 1);
});

for (const condition of ['incomplete', 'unavailable-library', 'reused-item-id']) {
    test(`defers private and shared cleanup for ${condition}`, async () => {
        const f = fixture();
        await f.lifecycle.remember(owner());
        if (condition === 'incomplete') f.live.complete = false;
        if (condition === 'unavailable-library') f.live.libraries.clear();
        if (condition === 'reused-item-id') f.live.itemIDs.add(1);
        const result = await f.lifecycle.sweep();
        assert.equal(result.removed, 0);
        assert.deepEqual(f.removed, []);
        assert.deepEqual(f.removedOwners, []);
        assert.equal(f.records().length, 1);
    });
}

test('missing or corrupt ownership data never authorizes deletion', async () => {
    const f = fixture();
    await f.lifecycle.remember(owner());
    const read = f.storage.read;
    f.storage.read = async () => { throw new Error('corrupt index'); };
    await assert.rejects(f.lifecycle.sweep(), /corrupt/);
    for (const records of [null, {}, [{ ...owner(), orphanedAt: null, ownerCleaned: 'yes' }],
        [{ ...owner(), orphanedAt: null }, { ...owner(), orphanedAt: null }]]) {
        f.storage.read = async () => records;
        await assert.rejects(f.lifecycle.sweep());
    }
    f.storage.read = async () => [];
    await f.lifecycle.sweep();
    assert.deepEqual(f.removed, []);
    assert.deepEqual(f.removedOwners, []);
    f.storage.read = read;
    assert.equal((await f.lifecycle.sweep()).removed, 1);
});

test('rejects arbitrary paths and malformed records before writing ownership', async () => {
    const f = fixture();
    for (const record of [
        owner({ attachmentKey: '../PDF1' }),
        owner({ artifacts: [{ store: 'markdown', key: '../escape' }] }),
        owner({ artifacts: [{ store: 'arbitrary', key: KEY }] }),
        owner({ itemID: -1 }), owner({ sourceHash: '../escape' }),
        owner({ sourceBytes: 0 }), owner({ ownerCleaned: 'true' }),
    ]) {
        assert.throws(() => f.lifecycle.remember(record));
    }
    assert.deepEqual(f.records(), []);
});

test('a changed item ID cannot replace an existing attachment ownership record', async () => {
    const f = fixture();
    await f.lifecycle.remember(owner());
    const records = structuredClone(f.records());
    await assert.rejects(f.lifecycle.remember(owner({ itemID: 9 })), /ID changed/);
    assert.deepEqual(f.records(), records);
});

for (const continuation of [false, true]) {
    test(`an incomplete hash scan preserves shared files and reports continuation=${continuation}`, async () => {
        const f = fixture();
        await f.lifecycle.remember(owner());
        const snapshot = f.lifecycle.snapshot;
        f.lifecycle.snapshot = async options => ({
            ...await snapshot(options),
            ...(options.hashes ? { complete: false, continuation } : {}),
        });
        const result = await f.lifecycle.sweep();
        assert.equal(result.ownersRemoved, 1);
        assert.equal(result.removed, 0);
        assert.equal(result.continuation, continuation);
        assert.equal(result.unknown, continuation ? 0 : 1);
        assert.equal(result.errors, 0);
        assert.deepEqual(f.removed, []);
        assert.equal(f.records()[0].ownerCleaned, true);
        f.lifecycle.snapshot = snapshot;
        const retried = await f.lifecycle.sweep();
        assert.equal(retried.removed, 1);
        assert.equal(retried.ownersRemoved, 0);
        assert.equal(retried.continuation, false);
        assert.equal(f.removedOwners.length, 1);
    });
}

test('a restored owner discovered during hashing protects shared files', async () => {
    const f = fixture();
    await f.lifecycle.remember(owner());
    const snapshot = f.lifecycle.snapshot;
    f.lifecycle.snapshot = async options => {
        if (options.hashes) f.live.owners.add(attachmentIdentity(owner()));
        return snapshot(options);
    };
    const result = await f.lifecycle.sweep();
    assert.equal(result.ownersRemoved, 1);
    assert.equal(result.referenced, 1);
    assert.deepEqual(f.removed, []);
    assert.equal(f.records().length, 1);
});

test('a private cleanup failure retains its ledger while unrelated owners finish', async () => {
    const f = fixture();
    await f.lifecycle.remember(owner());
    await f.lifecycle.remember(otherOwner());
    const removeOwner = f.lifecycle.removeOwner;
    f.lifecycle.removeOwner = async value => {
        if (value.itemID === 1) throw new Error('private cleanup failed');
        await removeOwner(value);
    };
    const result = await f.lifecycle.sweep();
    assert.equal(result.errors, 1);
    assert.equal(result.removed, 1);
    assert.equal(result.ownersRemoved, 1);
    assert.match(f.errors[0].message, /private cleanup failed/);
    assert.deepEqual(f.removed, otherOwner().artifacts);
    assert.deepEqual(f.records().map(value => value.itemID), [1]);
    assert.notEqual(f.records()[0].ownerCleaned, true);
    f.lifecycle.removeOwner = removeOwner;
    assert.equal((await f.lifecycle.sweep()).removed, 1);
    assert.deepEqual(f.records(), []);
});

test('restart retries partial resource deletion without repeating committed private cleanup', async () => {
    const f = fixture();
    const resources = [...owner().artifacts, RAW];
    await f.lifecycle.remember(owner({ artifacts: resources }));
    const remove = f.lifecycle.remove;
    f.lifecycle.remove = async value => {
        if (value.store === 'raw') throw new Error('permission denied');
        assert.equal(f.removedOwners.length, 1);
        await remove(value);
    };
    const result = await f.lifecycle.sweep();
    assert.equal(result.errors, 1);
    assert.equal(result.removed, 0);
    assert.deepEqual(f.records()[0].artifacts, resources);
    assert.equal(f.records()[0].ownerCleaned, true);
    assert.equal(f.removedOwners.length, 1);
    const restarted = new CacheLifecycle({
        storage: f.storage, snapshot: f.lifecycle.snapshot, now: () => 100, remove,
        removeOwner: () => assert.fail('private cleanup was already committed'),
    });
    assert.equal((await restarted.sweep()).removed, 1);
    assert.deepEqual(f.removed, [owner().artifacts[0], ...resources]);
    assert.deepEqual(f.records(), []);
});

test('failure to persist the initial tombstone leaves all files untouched', async () => {
    const f = fixture();
    await f.lifecycle.remember(owner());
    const write = f.storage.write;
    f.storage.write = async () => { throw new Error('disk full'); };
    await assert.rejects(f.lifecycle.sweep(), /disk full/);
    assert.equal(f.records()[0].orphanedAt, null);
    assert.deepEqual(f.removedOwners, []);
    assert.deepEqual(f.removed, []);
    f.storage.write = write;
    assert.equal((await f.lifecycle.sweep()).removed, 1);
});

test('a failed private-cleanup commit prevents shared deletion and retries the private cleanup', async () => {
    const f = fixture();
    await f.storage.write([{ ...owner(), orphanedAt: 100 }]);
    const write = f.storage.write;
    f.storage.write = async () => { throw new Error('disk full'); };
    const result = await f.lifecycle.sweep();
    assert.equal(result.errors, 1);
    assert.equal(result.removed, 0);
    assert.notEqual(f.records()[0].ownerCleaned, true);
    assert.equal(f.removedOwners.length, 1);
    assert.deepEqual(f.removed, []);
    f.storage.write = write;
    assert.equal((await f.lifecycle.sweep()).removed, 1);
    assert.equal(f.removedOwners.length, 2);
});

test('a failed resource-ledger commit keeps exact keys for retry even if diagnostics throw', async () => {
    const f = fixture({ onError: () => { throw new Error('diagnostics unavailable'); } });
    await f.storage.write([{ ...owner(), orphanedAt: 100, ownerCleaned: true }]);
    const write = f.storage.write;
    f.storage.write = async () => { throw new Error('disk full'); };
    assert.equal((await f.lifecycle.sweep()).errors, 1);
    assert.equal(f.records().length, 1);
    assert.equal(f.removed.length, 1);
    assert.deepEqual(f.removedOwners, []);
    f.storage.write = write;
    assert.equal((await f.lifecycle.sweep()).removed, 1);
    assert.equal(f.removed.length, 2);
    assert.deepEqual(f.records(), []);
});

test('an item lease acquired before reading ownership protects all source versions and their other owners', async t => {
    const f = fixture();
    const current = otherOwner();
    const historical = otherOwner({ sourceHash: HASH, sourceBytes: 3, artifacts: [RAW] });
    const sharedCurrent = owner({ sourceHash: current.sourceHash, sourceBytes: current.sourceBytes });
    const sharedHistorical = owner({ itemID: 3, attachmentKey: 'PDF3',
        artifacts: [{ store: 'revisions', key: 'f'.repeat(64) }] });
    const unrelated = owner({ itemID: 4, attachmentKey: 'PDF4', sourceHash: '1'.repeat(64),
        artifacts: [{ store: 'markdown', key: '2'.repeat(64) }] });
    await f.storage.write([current, historical, sharedCurrent, sharedHistorical, unrelated]
        .map(value => ({ ...value, orphanedAt: null })));
    const active = holdUse(t, f.lifecycle, { itemID: 2 });
    const result = await f.lifecycle.sweep();
    assert.equal(result.busy, 4);
    assert.equal(result.removed, 1);
    assert.deepEqual(f.removed, unrelated.artifacts);
    assert.deepEqual(f.removedOwners.map(value => value.itemID), [4]);
    assert.deepEqual(f.records().map(value => value.itemID), [2, 2, 1, 3]);
    active.release();
    await active.pending;
    assert.equal(f.idleCalls(), 1);
    assert.equal((await f.lifecycle.sweep()).removed, 4);
    assert.deepEqual(f.records(), []);
});

test('an item operation completed during the ownership read protects another attachment sharing its source', async t => {
    const f = fixture();
    await f.storage.write([owner(), otherOwner({ sourceHash: HASH, sourceBytes: 3 })]
        .map(value => ({ ...value, orphanedAt: null })));
    const started = deferred();
    const reading = deferred();
    t.after(() => reading.resolve());
    const read = f.storage.read;
    f.storage.read = async () => {
        started.resolve();
        await reading.promise;
        return read();
    };
    const sweep = f.lifecycle.sweep();
    await started.promise;
    await f.lifecycle.use(async () => {}, { itemID: 2 });
    reading.resolve();
    const result = await sweep;
    assert.equal(result.busy, 2);
    assert.equal(result.removed, 0);
    assert.equal(result.interrupted, true);
    assert.equal(f.idleCalls(), 0);
    assert.deepEqual(f.removedOwners, []);
    assert.deepEqual(f.removed, []);
    assert.equal(f.records().length, 2);
    assert.equal((await f.lifecycle.sweep()).removed, 2);
});

for (const [name, scope] of [
    ['item', { itemID: 1 }],
    ['attachment', { libraryID: 1, attachmentKey: 'PDF1' }],
    ['source', { sourceHash: HASH }],
    ['artifact', { artifacts: owner().artifacts }],
]) {
    test(`${name} leases defer only overlapping resources and schedule retry when released`, async t => {
        const f = fixture();
        await f.lifecycle.remember(owner());
        await f.lifecycle.remember(otherOwner());
        const active = holdUse(t, f.lifecycle, scope);
        const result = await f.lifecycle.sweep();
        assert.equal(result.busy, 1);
        assert.equal(result.removed, 1);
        assert.deepEqual(f.removed, otherOwner().artifacts);
        assert.deepEqual(f.removedOwners.map(value => value.itemID), [2]);
        assert.deepEqual(f.records().map(value => value.itemID), [1]);
        assert.equal(f.idleCalls(), 0);
        active.release();
        await active.pending;
        assert.equal(f.idleCalls(), 1);
        assert.equal((await f.lifecycle.sweep()).removed, 1);
        assert.deepEqual(f.records(), []);
    });
}

for (const [name, scope] of [['unscoped', undefined], ['empty-scope', {}]]) {
    test(`${name} maintenance defers every resource until release`, async t => {
        const f = fixture();
        await f.lifecycle.remember(owner());
        await f.lifecycle.remember(otherOwner());
        const active = holdUse(t, f.lifecycle, scope);
        const result = await f.lifecycle.sweep();
        assert.equal(result.busy, 2);
        assert.deepEqual(f.removedOwners, []);
        assert.deepEqual(f.removed, []);
        active.release();
        await active.pending;
        assert.equal(f.idleCalls(), 1);
        assert.equal((await f.lifecycle.sweep()).removed, 2);
    });
}

test('open-reader busy checks receive each owner and allow unrelated cleanup', async () => {
    const seen = [];
    const f = fixture({ isBusy: record => { seen.push(record.itemID); return record.itemID === 1; } });
    await f.lifecycle.remember(owner());
    await f.lifecycle.remember(otherOwner());
    assert.equal((await f.lifecycle.sweep()).removed, 1);
    assert.deepEqual(new Set(seen), new Set([1, 2]));
    assert.deepEqual(f.removed, otherOwner().artifacts);
    assert.deepEqual(f.removedOwners.map(value => value.itemID), [2]);
    f.lifecycle.isBusy = () => false;
    assert.equal((await f.lifecycle.sweep()).removed, 1);
});

test('releasing one of two overlapping leases does not make the resource available', async t => {
    const f = fixture();
    await f.lifecycle.remember(owner());
    const first = holdUse(t, f.lifecycle, { itemID: 1 });
    const second = holdUse(t, f.lifecycle, { itemID: 1 });
    await f.lifecycle.sweep();
    first.release();
    await first.pending;
    await f.lifecycle.sweep();
    assert.deepEqual(f.removedOwners, []);
    assert.deepEqual(f.removed, []);
    second.release();
    await second.pending;
    assert.equal((await f.lifecycle.sweep()).removed, 1);
});

test('failed operations release their lease and request deferred cleanup', async t => {
    const f = fixture();
    await f.lifecycle.remember(owner());
    const active = deferred();
    t.after(() => active.resolve());
    const failure = assert.rejects(f.lifecycle.use(async () => {
        await active.promise;
        throw new Error('read failed');
    }, { itemID: 1 }), /read failed/);
    await f.lifecycle.sweep();
    assert.deepEqual(f.removed, []);
    active.resolve();
    await failure;
    assert.equal(f.idleCalls(), 1);
    assert.equal((await f.lifecycle.sweep()).removed, 1);
});

for (const fails of [false, true]) {
    test(`a throwing idle callback preserves the operation's ${fails ? 'original rejection' : 'return value'}`, async t => {
        const idleError = new Error('idle callback failed');
        let idleCalls = 0;
        const f = fixture({ onIdle: () => { idleCalls++; throw idleError; } });
        await f.lifecycle.remember(owner());
        const active = deferred();
        t.after(() => active.resolve());
        const expected = fails ? new Error('read failed') : { content: 'read result' };
        const operation = f.lifecycle.use(async () => {
            await active.promise;
            if (fails) throw expected;
            return expected;
        }, { itemID: 1 });
        const completed = fails
            ? assert.rejects(operation, error => { assert.equal(error, expected); return true; })
            : operation.then(value => assert.equal(value, expected));
        const result = await f.lifecycle.sweep();
        assert.equal(result.busy, 1);
        assert.equal(result.removed, 0);
        assert.equal(idleCalls, 0);
        active.resolve();
        await completed;
        assert.equal(idleCalls, 1);
        assert.deepEqual(f.errors, [idleError]);
        assert.equal((await f.lifecycle.sweep()).removed, 1);
        assert.deepEqual(f.records(), []);
    });
}

test('unrelated completed operations do not request retry for another resource', async t => {
    const f = fixture();
    await f.lifecycle.remember(owner());
    await f.lifecycle.use(async () => {}, { itemID: 1 });
    assert.equal(f.idleCalls(), 0);
    const active = holdUse(t, f.lifecycle, { itemID: 1 });
    await f.lifecycle.sweep();
    await f.lifecycle.use(async () => {}, { itemID: 2 });
    assert.equal(f.idleCalls(), 0);
    active.release();
    await active.pending;
    assert.equal(f.idleCalls(), 1);
});

test('an overlapping read completed during hashing invalidates only that resource for the sweep', async t => {
    const f = fixture();
    await f.lifecycle.remember(owner());
    await f.lifecycle.remember(otherOwner());
    const started = deferred();
    const scan = deferred();
    t.after(() => scan.resolve());
    const snapshot = f.lifecycle.snapshot;
    f.lifecycle.snapshot = async options => {
        if (options.hashes) { started.resolve(); await scan.promise; }
        return snapshot(options);
    };
    const sweep = f.lifecycle.sweep();
    await started.promise;
    await f.lifecycle.use(async () => {}, { sourceHash: HASH });
    scan.resolve();
    const result = await sweep;
    assert.equal(result.removed, 1);
    assert.equal(result.busy, 1);
    assert.equal(result.interrupted, true);
    assert.equal(f.idleCalls(), 0);
    assert.deepEqual(f.removed, otherOwner().artifacts);
    assert.deepEqual(f.records().map(value => value.itemID), [1]);
    const retried = await f.lifecycle.sweep();
    assert.equal(retried.removed, 1);
    assert.equal(retried.interrupted, false);
});

for (const hashes of [false, true]) {
    test(`a notification during the ${hashes ? 'hash' : 'membership'} scan cancels stale deletion`, async t => {
        const f = fixture();
        await f.lifecycle.remember(owner());
        const started = deferred();
        const scan = deferred();
        t.after(() => scan.resolve());
        const snapshot = f.lifecycle.snapshot;
        f.lifecycle.snapshot = async options => {
            if (options.hashes === hashes) { started.resolve(); await scan.promise; }
            return snapshot(options);
        };
        const sweep = f.lifecycle.sweep();
        await started.promise;
        f.lifecycle.invalidate();
        scan.resolve();
        assert.equal((await sweep).interrupted, true);
        assert.deepEqual(f.removed, []);
        assert.equal(f.removedOwners.length, hashes ? 1 : 0);
        assert.equal(f.records().length, 1);
        assert.equal((await f.lifecycle.sweep()).removed, 1);
    });
}

test('remembering a new owner during hashing cancels deletion before the queued ownership write', async t => {
    const f = fixture();
    await f.lifecycle.remember(owner());
    const started = deferred();
    const scan = deferred();
    t.after(() => scan.resolve());
    const snapshot = f.lifecycle.snapshot;
    f.lifecycle.snapshot = async options => {
        if (options.hashes) { started.resolve(); await scan.promise; }
        return snapshot(options);
    };
    const sweep = f.lifecycle.sweep();
    await started.promise;
    const writing = f.lifecycle.remember(otherOwner({ sourceHash: HASH, sourceBytes: 3 }));
    scan.resolve();
    const [result] = await Promise.all([sweep, writing]);
    assert.equal(result.interrupted, true);
    assert.deepEqual(f.removed, []);
    assert.equal(f.records().length, 2);
});

for (const overlap of [true, false]) {
    test(`${overlap ? 'overlapping' : 'unrelated'} writes during removal ${overlap ? 'wait and stop further deletion' : 'proceed without interrupting deletion'}`, async t => {
        const f = fixture();
        await f.lifecycle.remember(owner({ artifacts: [...owner().artifacts, RAW] }));
        const started = deferred();
        const deletion = deferred();
        t.after(() => deletion.resolve());
        f.lifecycle.remove = async value => {
            f.removed.push(value);
            if (value.store === 'markdown') { started.resolve(); await deletion.promise; }
        };
        const sweep = f.lifecycle.sweep();
        await started.promise;
        let written = false;
        const writing = f.lifecycle.use(async () => { written = true; }, { itemID: overlap ? 1 : 2 });
        await Promise.resolve();
        assert.equal(written, !overlap);
        deletion.resolve();
        const [result] = await Promise.all([sweep, writing]);
        assert.equal(written, true);
        assert.equal(result.removed, overlap ? 0 : 1);
        assert.deepEqual(f.removed, overlap ? owner().artifacts : [...owner().artifacts, RAW]);
        assert.equal(f.records().length, overlap ? 1 : 0);
        if (overlap) {
            assert.equal(f.records()[0].ownerCleaned, true);
            assert.equal((await f.lifecycle.sweep()).removed, 1);
            assert.equal(f.removedOwners.length, 1);
        }
    });
}

for (const stage of ['private', 'shared']) {
    test(`a related item write arriving during the ${stage} ledger commit waits for rollback and defers cleanup`, async t => {
        const f = fixture();
        await f.storage.write([
            { ...owner(), orphanedAt: 100, ...(stage === 'shared' ? { ownerCleaned: true } : {}) },
            { ...otherOwner({ sourceHash: HASH, sourceBytes: 3 }), orphanedAt: null },
        ]);
        const started = deferred();
        const commit = deferred();
        t.after(() => commit.resolve());
        const write = f.storage.write;
        let originalLedger;
        let paused = false;
        f.storage.write = async value => {
            const target = value.find(record => record.itemID === 1);
            const committing = stage === 'private' ? target?.ownerCleaned === true : !target;
            if (committing && !paused) {
                paused = true;
                originalLedger = structuredClone(f.records());
                await write(value);
                started.resolve();
                await commit.promise;
                return;
            }
            await write(value);
        };
        const sweep = f.lifecycle.sweep({ itemIDs: new Set([1]) });
        await started.promise;
        let observedLedger;
        const writing = f.lifecycle.use(async () => {
            observedLedger = await f.storage.read();
        }, { itemID: 2 });
        await Promise.resolve();
        assert.equal(observedLedger, undefined);
        commit.resolve();
        const [result] = await Promise.all([sweep, writing]);
        assert.equal(result.removed, 0);
        assert.equal(result.busy, 1);
        assert.deepEqual(observedLedger, originalLedger);
        assert.deepEqual(f.records(), originalLedger);
        assert.deepEqual(f.removed, stage === 'shared' ? owner().artifacts : []);
        assert.equal((await f.lifecycle.sweep()).removed, 2);
        assert.deepEqual(f.records(), []);
    });
}

for (const stage of ['private', 'shared']) {
    test(`a related write in the ${stage} commit's final microtasks waits for ledger restoration and remains cleanable`, async () => {
        const f = fixture();
        await f.storage.write([
            { ...owner(), orphanedAt: 100, ...(stage === 'shared' ? { ownerCleaned: true } : {}) },
        ]);
        const originalLedger = structuredClone(f.records());
        let cachedData = 'old data';
        const removal = stage === 'private' ? 'removeOwner' : 'remove';
        const remove = f.lifecycle[removal];
        f.lifecycle[removal] = async value => {
            cachedData = null;
            await remove(value);
        };
        const events = [];
        const write = f.storage.write;
        let scheduled = false;
        let writing;
        let requestedLedger;
        let observedLedger;
        f.storage.write = async value => {
            const target = value.find(record => record.itemID === 1);
            const committing = stage === 'private' ? target?.ownerCleaned === true : !target;
            if (committing && !scheduled) {
                scheduled = true;
                await write(value);
                // The second microtask runs after the operation resumes from
                // this commit, but before #purge resumes for its final check.
                queueMicrotask(() => {
                    queueMicrotask(() => {
                        events.push('use requested');
                        requestedLedger = structuredClone(f.records());
                        writing = f.lifecycle.use(async () => {
                            events.push('write started');
                            observedLedger = await f.storage.read();
                            cachedData = 'new data';
                        }, { itemID: 1 });
                    });
                });
                return;
            }
            if (scheduled) {
                events.push('rollback started');
                await Promise.resolve();
                await write(value);
                events.push('rollback finished');
                return;
            }
            await write(value);
        };
        const result = await f.lifecycle.sweep();
        assert.ok(writing, 'the commit must schedule the related write');
        await writing;
        assert.deepEqual(requestedLedger, stage === 'private'
            ? [{ ...originalLedger[0], ownerCleaned: true }] : []);
        assert.deepEqual(events, ['use requested', 'rollback started', 'rollback finished', 'write started']);
        assert.deepEqual(observedLedger, originalLedger);
        assert.deepEqual(f.records(), originalLedger);
        assert.ok(result.busy > 0);
        assert.equal(result.removed, 0);
        assert.equal(result.ownersRemoved, 0);
        assert.equal(result.errors, 0);
        assert.deepEqual(f.errors, []);
        assert.equal(cachedData, 'new data');
        assert.deepEqual(f.removed, stage === 'shared' ? owner().artifacts : []);
        f.storage.write = write;
        const retried = await f.lifecycle.sweep();
        assert.equal(retried.removed, 1);
        assert.equal(retried.busy, 0);
        assert.equal(retried.errors, 0);
        assert.equal(cachedData, null);
        assert.deepEqual(f.records(), []);
        assert.equal(f.removedOwners.length, stage === 'private' ? 2 : 0);
        assert.deepEqual(f.removed, stage === 'private' ? owner().artifacts
            : [...owner().artifacts, ...owner().artifacts]);
    });
}

test('an unrelated item write during a ledger commit proceeds without rolling back deletion', async t => {
    const f = fixture();
    await f.lifecycle.remember(owner());
    await f.lifecycle.remember(otherOwner());
    const started = deferred();
    const commit = deferred();
    t.after(() => commit.resolve());
    const write = f.storage.write;
    f.storage.write = async value => {
        await write(value);
        if (!value.some(record => record.itemID === 1)) {
            started.resolve();
            await commit.promise;
        }
    };
    const sweep = f.lifecycle.sweep({ itemIDs: new Set([1]) });
    await started.promise;
    let written = false;
    const writing = f.lifecycle.use(async () => { written = true; }, { itemID: 2 });
    await Promise.resolve();
    assert.equal(written, true);
    commit.resolve();
    const [result] = await Promise.all([sweep, writing]);
    assert.equal(result.removed, 1);
    assert.deepEqual(f.removed, owner().artifacts);
    assert.deepEqual(f.records().map(value => value.itemID), [2]);
});

test('cooperative yielding allows invalidation before the next owner is cleaned', async () => {
    const f = fixture();
    await f.lifecycle.remember(owner());
    await f.lifecycle.remember(otherOwner());
    f.lifecycle.yieldControl = async () => f.lifecycle.invalidate();
    const result = await f.lifecycle.sweep();
    assert.equal(result.interrupted, true);
    assert.deepEqual(f.removedOwners.map(value => value.itemID), [1]);
    assert.deepEqual(f.removed, []);
    assert.equal(f.records().length, 2);
    f.lifecycle.yieldControl = async () => {};
    assert.equal((await f.lifecycle.sweep()).removed, 2);
});

test('concurrent sweeps share one scan and cleanup pass', async t => {
    const f = fixture();
    await f.lifecycle.remember(owner());
    const started = deferred();
    const scan = deferred();
    t.after(() => scan.resolve());
    const snapshot = f.lifecycle.snapshot;
    f.lifecycle.snapshot = async options => {
        if (options.hashes) { started.resolve(); await scan.promise; }
        return snapshot(options);
    };
    const first = f.lifecycle.sweep();
    await started.promise;
    const second = f.lifecycle.sweep();
    scan.resolve();
    const results = await Promise.all([first, second]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[0].removed, 1);
    assert.deepEqual(f.snapshots.map(value => value.hashes), [false, true]);
    assert.equal(f.removedOwners.length, 1);
    assert.deepEqual(f.removed, owner().artifacts);
});

test('a failed hash scan retains the ledger for a later successful sweep', async () => {
    const f = fixture();
    await f.lifecycle.remember(owner());
    const snapshot = f.lifecycle.snapshot;
    f.lifecycle.snapshot = async options => {
        if (options.hashes) throw new Error('library unavailable');
        return snapshot(options);
    };
    await assert.rejects(f.lifecycle.sweep(), /library unavailable/);
    assert.deepEqual(f.removed, []);
    assert.equal(f.records()[0].ownerCleaned, true);
    f.lifecycle.snapshot = snapshot;
    assert.equal((await f.lifecycle.sweep()).removed, 1);
    assert.equal(f.removedOwners.length, 1);
});

test('shutdown cancels an in-flight scan and prevents subsequent cleanup', async t => {
    const f = fixture();
    await f.lifecycle.remember(owner());
    const started = deferred();
    const scan = deferred();
    t.after(() => scan.resolve());
    const snapshot = f.lifecycle.snapshot;
    f.lifecycle.snapshot = async options => {
        if (options.hashes) { started.resolve(); await scan.promise; }
        return snapshot(options);
    };
    const sweep = f.lifecycle.sweep();
    await started.promise;
    const stopping = f.lifecycle.dispose();
    scan.resolve();
    const [result] = await Promise.all([sweep, stopping]);
    assert.equal(result.interrupted, true);
    assert.deepEqual(f.removed, []);
    assert.equal(f.records().length, 1);
    const scanCount = f.snapshots.length;
    assert.equal((await f.lifecycle.sweep()).removed, 0);
    assert.equal(f.snapshots.length, scanCount);
    assert.deepEqual(f.removed, []);
});
