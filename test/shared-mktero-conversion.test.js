import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedMkteroConversion } from '../src/mktero/shared-conversion.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

const HASH = 'a'.repeat(64);
function options(overrides = {}) {
    return {
        scope: 'account-session-1',
        apiBase: 'https://api.example.test',
        requestProfile: 'request-v1',
        sourceHash: HASH,
        fileData: new Uint8Array([1, 2, 3]),
        fileName: 'paper.pdf',
        getAccessToken: async () => 'test-token',
        ...overrides,
    };
}

function fixture(overrides = {}) {
    const started = deferred();
    const gate = deferred();
    const calls = [];
    const shared = new SharedMkteroConversion({
        conversion: { convert: async args => {
            calls.push(args);
            started.resolve(args);
            return gate.promise;
        } },
        getScope: () => 'account-session-1',
        ...overrides,
    });
    return { shared, calls, started, gate };
}

const result = () => ({ result: { markdown: '# Paper', assets: [{ data: new Uint8Array([7]) }] },
    origin: 'network', warnings: [] });

test('shares acquisition but gives each attachment an independent result', async () => {
    const { shared, calls, started, gate } = fixture();
    const a = shared.acquire(options());
    const b = shared.acquire(options({ fileName: 'another.pdf' }));
    await started.promise;
    assert.equal(calls.length, 1);
    gate.resolve(result());
    const [left, right] = await Promise.all([a.result, b.result]);
    left.result.assets[0].data[0] = 99;
    assert.equal(right.result.assets[0].data[0], 7);
    a.release();
    b.release();
    await shared.dispose();
});

test('creator cancellation does not abort another participant', async () => {
    const { shared, started, gate } = fixture();
    const controller = new AbortController();
    const a = shared.acquire(options({ signal: controller.signal }));
    const b = shared.acquire(options());
    const rejected = assert.rejects(a.result, { name: 'AbortError' });
    const call = await started.promise;
    controller.abort();
    await rejected;
    assert.equal(call.signal.aborted, false);
    gate.resolve(result());
    await b.result;
    b.release();
    await shared.dispose();
});

test('keeps a ready network result until all attachment runs release', async () => {
    const { shared, started, gate, calls } = fixture();
    const a = shared.acquire(options());
    await started.promise;
    gate.resolve(result());
    await a.result;
    const b = shared.acquire(options());
    await b.result;
    assert.equal(calls.length, 1);
    a.release();
    b.release();
    await shared.dispose();
});

test('replacement reservation survives completion before the new hash is available', async () => {
    const { shared, started, gate, calls } = fixture();
    const oldController = new AbortController();
    const newController = new AbortController();
    const old = shared.acquire(options({ signal: oldController.signal }));
    const rejected = assert.rejects(old.result, { name: 'AbortError' });
    const call = await started.promise;
    assert.equal(shared.reserveReplacement(oldController.signal, newController.signal), true);
    oldController.abort();
    await rejected;
    assert.equal(call.signal.aborted, false);
    const observer = shared.acquire(options());
    gate.resolve(result());
    await observer.result;
    observer.release();
    const replacement = shared.acquire(options({ signal: newController.signal, forceRefresh: true }));
    await replacement.result;
    assert.equal(calls.length, 1);
    replacement.release();
    await shared.dispose();
});

test('an unreserved force refresh starts a new generation after ready', async () => {
    let count = 0;
    const shared = new SharedMkteroConversion({
        conversion: { convert: async () => { count += 1; return result(); } },
        getScope: () => 'account-session-1',
    });
    const a = shared.acquire(options());
    await a.result;
    const b = shared.acquire(options({ forceRefresh: true }));
    await b.result;
    assert.equal(count, 2);
    assert.equal(a.canPublish(), false);
    assert.equal(b.canPublish(), true);
    a.release();
    b.release();
    await shared.dispose();
});
