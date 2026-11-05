import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedMkteroConversion, createSharedConversionKey } from '../src/mktero/shared-conversion.js';
import { createConversionRunRegistry } from '../src/core/conversion-runs.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const hash = 'b'.repeat(64);
const value = () => ({ result: { markdown: '# Network' }, origin: 'network', warnings: [] });
function input(extra = {}) {
    return { scope: 's1', apiBase: 'https://api.example.test', sourceHash: hash,
        fileData: new Uint8Array([1, 2]), fileName: 'a.pdf', getAccessToken: () => 'token', ...extra };
}
function create(convert, extra = {}) {
    return new SharedMkteroConversion({ conversion: { convert }, getScope: () => 's1', ...extra });
}

// Waits are explicit stage gates; elapsed timing is not an assertion of ordering.
test('content keys normalize transport identity and exclude caller policy and tokens', () => {
    const base = { ...input(), byteLength: 2 };
    const key = createSharedConversionKey(base);
    assert.equal(key, createSharedConversionKey({ ...base, apiBase: 'https://API.example.test:443/',
        forceRefresh: true, cacheEnabled: true, itemID: 88, fileName: 'b.pdf', accessToken: 'rotated' }));
    for (const change of [{ scope: 's2' }, { apiBase: 'https://other.example.test' },
        { sourceHash: 'c'.repeat(64) }, { byteLength: 3 }, { requestProfile: 'changed' }]) {
        assert.notEqual(key, createSharedConversionKey({ ...base, ...change }));
    }
    assert.equal(createSharedConversionKey({ ...base, sourceHash: '' }), null);
});

test('missing hashes never merge unrelated calls', async () => {
    let calls = 0;
    const shared = create(async () => { calls++; return value(); });
    const a = shared.acquire(input({ sourceHash: '' }));
    const b = shared.acquire(input({ sourceHash: '' }));
    await Promise.all([a.result, b.result]);
    assert.equal(calls, 2);
    a.release(); b.release(); await shared.dispose();
});

test('claims before cache lookup and persists a network result only once', async () => {
    const lookup = deferred();
    const entered = deferred();
    let reads = 0;
    let creates = 0;
    let writes = 0;
    const shared = create(async () => { creates++; return { ...value(), resultArchive: new Uint8Array([8]) }; }, {
        resultStore: {
            async get() { reads++; entered.resolve(); return lookup.promise; },
            async put(_key, _record, { canCommit }) { assert.equal(canCommit(), true); writes++; },
        },
    });
    const a = shared.acquire(input({ cacheEnabled: true, resultKey: hash }));
    await entered.promise;
    const b = shared.acquire(input({ cacheEnabled: true, resultKey: hash }));
    assert.equal(reads, 1);
    lookup.resolve(null);
    await Promise.all([a.result, b.result]);
    assert.equal(creates, 1);
    assert.equal(writes, 1);
    a.release(); b.release(); await shared.dispose();
});

test('force arriving during cache lookup upgrades the uncommitted acquisition', async () => {
    const lookup = deferred();
    const entered = deferred();
    let creates = 0;
    const shared = create(async () => { creates++; return value(); }, {
        resultStore: { get: () => { entered.resolve(); return lookup.promise; }, put: async () => {} },
        extractStoredResult: () => ({ markdown: '# Cached' }),
    });
    const a = shared.acquire(input({ cacheEnabled: true, resultKey: hash }));
    await entered.promise;
    const b = shared.acquire(input({ forceRefresh: true }));
    lookup.resolve({ archive: new Uint8Array([1]) });
    const results = await Promise.all([a.result, b.result]);
    assert.ok(results.every(result => result.result.markdown === '# Network'));
    assert.equal(creates, 1);
    a.release(); b.release(); await shared.dispose();
});

test('a ready disk result cannot satisfy a later forced refresh', async () => {
    let creates = 0;
    const shared = create(async () => { creates++; return value(); }, {
        resultStore: { get: async () => ({ archive: new Uint8Array([1]) }), put: async () => {} },
        extractStoredResult: () => ({ markdown: '# Cached' }),
    });
    const a = shared.acquire(input({ cacheEnabled: true, resultKey: hash }));
    assert.equal((await a.result).origin, 'cache');
    const b = shared.acquire(input({ forceRefresh: true }));
    assert.equal((await b.result).origin, 'network');
    assert.equal(creates, 1);
    a.release(); b.release(); await shared.dispose();
});

test('force joins publishing and a write failure still leaves a shareable ready result', async () => {
    const writing = deferred();
    const failWrite = deferred();
    let creates = 0;
    const errors = [];
    const shared = create(async () => { creates++; return { ...value(), resultArchive: new Uint8Array([8]) }; }, {
        resultStore: { get: async () => null, put: async () => { writing.resolve(); await failWrite.promise; } },
        onCacheError: error => errors.push(error.message),
    });
    const a = shared.acquire(input({ cacheEnabled: true, resultKey: hash }));
    await writing.promise;
    const b = shared.acquire(input({ forceRefresh: true }));
    failWrite.reject(new Error('disk full'));
    await Promise.all([a.result, b.result]);
    const c = shared.acquire(input());
    await c.result;
    assert.equal(creates, 1);
    assert.deepEqual(errors, ['disk full']);
    a.release(); b.release(); c.release(); await shared.dispose();
});

test('late cache enablement does not change the publication identity', async () => {
    const download = deferred();
    const started = deferred();
    let calls = 0;
    let writes = 0;
    const shared = create(async () => {
        calls++;
        if (calls === 1) { started.resolve(); await download.promise; }
        return { ...value(), resultArchive: new Uint8Array([8]) };
    }, { resultStore: { get: async () => null, put: async () => { writes++; } } });
    const a = shared.acquire(input());
    await started.promise;
    const b = shared.acquire(input({ cacheEnabled: true, resultKey: hash }));
    download.resolve();
    await Promise.all([a.result, b.result]);
    const c = shared.acquire(input({ forceRefresh: true, cacheEnabled: true, resultKey: hash }));
    await c.result;
    assert.equal(a.canPublish(), false);
    assert.equal(b.canPublish(), false);
    assert.equal(c.canPublish(), true);
    assert.equal(writes, 2);
    a.release(); b.release(); c.release(); await shared.dispose();
});

test('a cache-enabled caller joining ready persists once without another conversion', async () => {
    let calls = 0;
    let writes = 0;
    const shared = create(async () => {
        calls++;
        return { ...value(), resultArchive: new Uint8Array([8]) };
    }, { resultStore: { get: async () => null, put: async () => { writes++; } } });
    const a = shared.acquire(input());
    await a.result;
    assert.equal(writes, 0);
    const b = shared.acquire(input({ cacheEnabled: true, resultKey: hash }));
    const c = shared.acquire(input({ cacheEnabled: true, resultKey: hash }));
    await Promise.all([b.result, c.result]);
    assert.equal(calls, 1);
    assert.equal(writes, 1);
    a.release(); b.release(); c.release(); await shared.dispose();
});

test('a caller enabling cache in the publishing handoff still saves the raw result once', async () => {
    let writes = 0;
    const shared = create(async () => ({ ...value(), resultArchive: new Uint8Array([8]) }), {
        resultStore: { get: async () => null, put: async () => { writes++; } },
    });
    const a = shared.acquire(input());
    // Step promise jobs until the documented publishing phase; no elapsed-time
    // assumption is used to place the second caller in this narrow handoff.
    for (let turn = 0; turn < 20 && [...shared.entries.values()][0].state !== 'publishing'; turn++) {
        await Promise.resolve();
    }
    assert.equal([...shared.entries.values()][0].state, 'publishing');
    const b = shared.acquire(input({ cacheEnabled: true, resultKey: hash }));
    await Promise.all([a.result, b.result]);
    assert.equal(writes, 1);
    a.release(); b.release(); await shared.dispose();
});

for (const late of [false, true]) {
    test(`dispose waits for an invoked ${late ? 'ready' : 'publishing'} raw save to settle`, async () => {
        const writing = deferred();
        const committed = deferred();
        let canCommit;
        const shared = create(async () => ({ ...value(), resultArchive: new Uint8Array([8]) }), {
            resultStore: { get: async () => null, put: async (_key, _record, options) => {
                canCommit = options.canCommit;
                writing.resolve();
                await committed.promise;
            } },
        });
        const a = shared.acquire(input({ cacheEnabled: !late, resultKey: hash }));
        if (late) await a.result;
        const b = late ? shared.acquire(input({ cacheEnabled: true, resultKey: hash })) : null;
        const outcomes = Promise.allSettled([a.result, ...(b ? [b.result] : [])]);
        await writing.promise;
        const stopped = deferred();
        let finished = false;
        const dispose = shared.dispose().then(() => { finished = true; stopped.resolve(); });
        assert.equal(canCommit(), false);
        for (let turn = 0; turn < 10; turn++) await Promise.resolve();
        assert.equal(finished, false);
        committed.resolve();
        await dispose;
        await stopped.promise;
        await outcomes;
        assert.equal(finished, true);
        assert.equal(shared.pendingPersistence.size, 0);
    });
}

test('offline cache guards never regain rights after an active shared generation ends', async () => {
    const gate = deferred();
    const started = deferred();
    const shared = create(async () => { started.resolve(); return gate.promise; });
    const before = shared.captureCachePublication({ sourceHash: hash, byteLength: 2 });
    assert.equal(before.canPublish(), true);
    const a = shared.acquire(input());
    await started.promise;
    const during = shared.captureCachePublication({ sourceHash: hash, byteLength: 2 });
    assert.equal(before.canPublish(), false);
    assert.equal(during.canPublish(), false);
    gate.resolve(value());
    await a.result;
    a.release();
    await shared.entries.get(createSharedConversionKey({ ...input(), byteLength: 2 }))?.done;
    assert.equal(before.canPublish(), false);
    assert.equal(during.canPublish(), false);
    before.release(); during.release();
    await shared.dispose();
    assert.equal(shared.publications.size, 0);
});

test('claiming a replacement revokes old publication before the new download completes', async () => {
    const downloading = deferred();
    const complete = deferred();
    let calls = 0;
    const shared = create(async () => {
        if (++calls === 2) { downloading.resolve(); await complete.promise; }
        return value();
    });
    const old = shared.acquire(input());
    await old.result;
    assert.equal(old.canPublish(), true);
    const next = shared.acquire(input({ forceRefresh: true }));
    assert.equal(old.canPublish(), false);
    await downloading.promise;
    complete.resolve();
    await next.result;
    assert.equal(next.canPublish(), true);
    old.release(); next.release(); await shared.dispose();
});

test('a failed replacement does not restore old publication rights', async () => {
    let calls = 0;
    const shared = create(async () => {
        if (++calls === 2) throw new Error('replacement failed');
        return value();
    });
    const old = shared.acquire(input());
    await old.result;
    const next = shared.acquire(input({ forceRefresh: true }));
    await assert.rejects(next.result, /replacement failed/);
    assert.equal(old.canPublish(), false);
    old.release(); next.release(); await shared.dispose();
});

test('last cancellation before execution makes no network request', async () => {
    let calls = 0;
    const shared = create(async () => { calls++; return value(); });
    const controller = new AbortController();
    const a = shared.acquire(input({ signal: controller.signal }));
    controller.abort();
    await assert.rejects(a.result, { name: 'AbortError' });
    await shared.dispose();
    assert.equal(calls, 0);
});

test('a new acquisition waits for cleanup and does not join an aborted signal', async () => {
    const started = deferred();
    const cleanup = deferred();
    let calls = 0;
    const shared = create(async options => {
        calls++;
        if (calls === 2) return value();
        started.resolve();
        try {
            await new Promise((_resolve, reject) => options.signal.addEventListener('abort',
                () => reject(options.signal.reason), { once: true }));
        }
        finally { options.onCleanup(cleanup.promise); }
    });
    const controller = new AbortController();
    const a = shared.acquire(input({ signal: controller.signal }));
    await started.promise;
    controller.abort();
    await assert.rejects(a.result, { name: 'AbortError' });
    const b = shared.acquire(input());
    assert.equal(calls, 1);
    cleanup.resolve();
    assert.equal((await b.result).result.markdown, '# Network');
    assert.equal(calls, 2);
    b.release(); await shared.dispose();
});

test('a stopped transport ignoring abort cannot indefinitely hold the content key', async () => {
    const started = deferred();
    let calls = 0;
    const shared = create(async () => {
        if (++calls === 2) return value();
        started.resolve();
        return new Promise(() => {});
    }, { stopTimeoutMs: 5 });
    const controller = new AbortController();
    const a = shared.acquire(input({ signal: controller.signal }));
    await started.promise;
    controller.abort();
    await assert.rejects(a.result, { name: 'AbortError' });
    const b = shared.acquire(input());
    await b.result;
    assert.equal(calls, 2);
    b.release(); await shared.dispose();
});

test('waiting acquisition can be cancelled independently while cleanup is pending', async () => {
    const started = deferred();
    const cleanup = deferred();
    const shared = create(async options => {
        started.resolve();
        options.onCleanup(cleanup.promise);
        return new Promise((_resolve, reject) => options.signal.addEventListener('abort',
            () => reject(options.signal.reason), { once: true }));
    });
    const a = new AbortController();
    const b = new AbortController();
    const first = shared.acquire(input({ signal: a.signal }));
    await started.promise;
    a.abort();
    await assert.rejects(first.result, { name: 'AbortError' });
    const waiting = shared.acquire(input({ signal: b.signal }));
    b.abort();
    await assert.rejects(waiting.result, { name: 'AbortError' });
    cleanup.resolve();
    await shared.dispose();
});

test('handoff cancellation releases immediately even when the replacement never acquires', async () => {
    const started = deferred();
    let sharedSignal;
    const shared = create(async options => {
        sharedSignal = options.signal;
        started.resolve();
        return new Promise((_resolve, reject) => options.signal.addEventListener('abort',
            () => reject(options.signal.reason), { once: true }));
    });
    const old = new AbortController();
    const next = new AbortController();
    const first = shared.acquire(input({ signal: old.signal }));
    await started.promise;
    shared.reserveReplacement(old.signal, next.signal);
    old.abort();
    await assert.rejects(first.result, { name: 'AbortError' });
    assert.equal(sharedSignal.aborted, false);
    next.abort();
    assert.equal(sharedSignal.aborted, true);
    shared.releaseRun(next.signal);
    await shared.dispose();
});

test('changed replacement content releases the old reservation', async () => {
    const started = deferred();
    let oldSignal;
    const shared = create(async options => {
        if (options.sourceHash !== hash) return value();
        oldSignal = options.signal;
        started.resolve();
        return new Promise((_resolve, reject) => options.signal.addEventListener('abort',
            () => reject(options.signal.reason), { once: true }));
    });
    const old = new AbortController();
    const next = new AbortController();
    const first = shared.acquire(input({ signal: old.signal }));
    await started.promise;
    shared.reserveReplacement(old.signal, next.signal);
    old.abort();
    await assert.rejects(first.result, { name: 'AbortError' });
    const replacement = shared.acquire(input({ signal: next.signal, sourceHash: 'c'.repeat(64), forceRefresh: true }));
    await replacement.result;
    assert.equal(oldSignal.aborted, true);
    replacement.release(); await shared.dispose();
});

test('repeated replacement transfers the reservation without restarting the network', async () => {
    const started = deferred();
    const gate = deferred();
    let calls = 0;
    const shared = create(async () => { calls++; started.resolve(); return gate.promise; });
    const a = new AbortController();
    const b = new AbortController();
    const c = new AbortController();
    const first = shared.acquire(input({ signal: a.signal }));
    await started.promise;
    assert.equal(shared.reserveReplacement(a.signal, b.signal), true);
    a.abort();
    await assert.rejects(first.result, { name: 'AbortError' });
    assert.equal(shared.reserveReplacement(b.signal, c.signal), true);
    b.abort();
    const replacement = shared.acquire(input({ signal: c.signal, forceRefresh: true }));
    gate.resolve(value());
    await replacement.result;
    assert.equal(calls, 1);
    shared.releaseRun(c.signal);
    await shared.dispose();
});

test('scope invalidation cancels leases and prevents publication under a new account', async () => {
    let scope = 's1';
    const started = deferred();
    const shared = create(async options => {
        started.resolve();
        return new Promise((_resolve, reject) => options.signal.addEventListener('abort',
            () => reject(options.signal.reason), { once: true }));
    }, { getScope: () => scope });
    const a = shared.acquire(input());
    await started.promise;
    scope = 's2';
    shared.invalidateScope();
    await assert.rejects(a.result, { code: 'MKTERO_QUOTA_ACCOUNT_CHANGED' });
    assert.equal(a.canPublish(), false);
    assert.throws(() => shared.acquire(input()), { code: 'MKTERO_QUOTA_ACCOUNT_CHANGED' });
    await shared.dispose();
});

test('late progress is replayed and observer exceptions cannot fail another participant', async () => {
    const started = deferred();
    const gate = deferred();
    let report;
    const shared = create(async options => {
        report = options.onProgress;
        options.onProgress(35, { stage: 'processing' });
        started.resolve();
        return gate.promise;
    });
    const a = shared.acquire(input({ onProgress: () => { throw new Error('observer'); } }));
    await started.promise;
    const seen = [];
    const b = shared.acquire(input({ onProgress: (...progress) => seen.push(progress) }));
    assert.deepEqual(seen, [[35, { stage: 'processing' }]]);
    gate.resolve(value());
    await Promise.all([a.result, b.result]);
    report(10);
    assert.equal(seen.length, 1);
    a.release(); b.release(); await shared.dispose();
});

test('registry reserves before abort and ignores a stale role release after replacement', async () => {
    const started = deferred();
    const network = deferred();
    const readNext = deferred();
    let calls = 0;
    let executions = 0;
    const shared = create(async () => { calls++; started.resolve(); return network.promise; });
    const runs = createConversionRunRegistry({
        createController: () => new AbortController(),
        beforeReplace: (old, next) => shared.reserveReplacement(old, next),
        onSettled: signal => shared.releaseRun(signal),
        execute: async (_itemID, { signal, forceRefresh }) => {
            if (++executions > 1) await readNext.promise;
            return shared.acquire(input({ signal, forceRefresh })).result;
        },
    });
    const first = runs.begin({ itemID: 1, owner: 'tab' });
    await started.promise;
    const next = runs.begin({ itemID: 1, owner: 'tab', forceRefresh: true });
    await assert.rejects(first.run.promise, { name: 'AbortError' });
    runs.release(1, 'tab', { expectedSignal: first.run.signal });
    assert.equal(next.run.signal.aborted, false);
    readNext.resolve(); network.resolve(value());
    await next.run.promise;
    assert.equal(calls, 1);
    await shared.dispose();
});
