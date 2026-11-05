import test from 'node:test';
import assert from 'node:assert/strict';
import { MkteroConversionClient } from '../src/mktero/mktero-conversion-client.js';
import { SharedMkteroConversion } from '../src/mktero/shared-conversion.js';

const API_BASE = 'https://api.example.test';
const JOB = {
    job_id: 'job-response-cleanup',
    status: 'awaiting_upload',
    upload_url: 'https://storage.example.test/upload',
};
const CANCEL_TIMEOUT_MS = 20;

function deferred() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}

function jsonBytes(value) {
    return new TextEncoder().encode(JSON.stringify(value)).buffer;
}

function createResponse(body, reading, signal) {
    let removeAbort;
    const stream = new ReadableStream({
        start(controller) {
            const abort = () => {
                removeAbort();
                controller.error(signal.reason);
            };
            removeAbort = () => signal.removeEventListener('abort', abort);
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
        },
        async pull(controller) {
            reading.resolve();
            try {
                const buffer = await body.promise;
                if (!signal.aborted) {
                    controller.enqueue(new Uint8Array(buffer));
                    controller.close();
                }
            }
            finally { removeAbort(); }
        },
        cancel() { removeAbort(); },
    }, { highWaterMark: 0 });
    return new Response(stream, {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
    });
}

function deleteResponse(body, reading) {
    return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer() {
            reading.resolve();
            return body.promise;
        },
    };
}

function flushTasks() {
    return new Promise(resolve => setImmediate(resolve));
}

function harness(t) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const createBody = deferred();
    const createReading = deferred();
    const deleteBody = deferred();
    const deleteReading = deferred();
    const requests = [];
    const tokenScopes = [];
    let scope = 's1';
    const client = new MkteroConversionClient({
        requestTimeoutMs: 1000,
        cancelTimeoutMs: CANCEL_TIMEOUT_MS,
        fetch: async (url, request) => {
            requests.push({ url, ...request });
            if (request.method === 'POST' && url === `${API_BASE}/api/v1/conversions`) {
                return createResponse(createBody, createReading, request.signal);
            }
            if (request.method === 'DELETE' && url === `${API_BASE}/api/v1/conversions/${JOB.job_id}`) {
                return deleteResponse(deleteBody, deleteReading);
            }
            throw new Error(`Unexpected ${request.method} ${url}`);
        },
    });
    const shared = new SharedMkteroConversion({
        conversion: client,
        getScope: () => scope,
        stopTimeoutMs: 500,
    });
    t.after(async () => {
        createBody.resolve(jsonBytes(JOB));
        deleteBody.resolve(jsonBytes({}));
        const stopping = shared.dispose();
        try {
            await flushTasks();
            t.mock.timers.tick(1000);
            await stopping;
        }
        finally { t.mock.timers.reset(); }
    });
    return {
        shared, createBody, createReading, deleteBody, deleteReading, requests, tokenScopes,
        acquire: (signal, extra = {}) => shared.acquire({
            apiBase: API_BASE,
            scope,
            sourceHash: 'b'.repeat(64),
            fileName: 'paper.pdf',
            fileData: new TextEncoder().encode('%PDF-1.7 synthetic content'),
            getAccessToken: async () => {
                tokenScopes.push(scope);
                return scope === 's1' ? 'initial-token' : 'later-account-token';
            },
            signal,
            ...extra,
        }),
        changeScope() { scope = 's2'; shared.invalidateScope(); },
    };
}

function observeDispose(shared) {
    let finished = false;
    const promise = shared.dispose().then(() => { finished = true; });
    return { promise, get finished() { return finished; } };
}

test('last shared lease aborts immediately during create body while dispose waits for one independent DELETE',
    { timeout: 5000 }, async t => {
        const h = harness(t);
        const first = new AbortController();
        const last = new AbortController();
        const a = h.acquire(first.signal);
        const rejectedA = assert.rejects(a.result, { name: 'AbortError' });
        await h.createReading.promise;
        const b = h.acquire(last.signal);
        const rejectedB = assert.rejects(b.result, { name: 'AbortError' });
        const createSignal = h.requests[0].signal;

        first.abort();
        await rejectedA;
        assert.equal(createSignal.aborted, false);
        assert.deepEqual(h.requests.map(request => request.method), ['POST']);

        last.abort();
        last.abort();
        await rejectedB;
        const disposal = observeDispose(h.shared);
        await flushTasks();
        assert.equal(disposal.finished, false);
        assert.equal(createSignal.aborted, false);
        assert.equal(b.canPublish(), false);
        assert.deepEqual(h.requests.map(request => request.method), ['POST']);

        h.createBody.resolve(jsonBytes(JOB));
        await h.deleteReading.promise;
        await flushTasks();
        const deletion = h.requests[1];
        assert.equal(disposal.finished, false);
        assert.equal(deletion.url, `${API_BASE}/api/v1/conversions/${JOB.job_id}`);
        assert.equal(deletion.headers.Authorization, 'Bearer initial-token');
        for (const signal of [first.signal, last.signal, createSignal]) {
            assert.notEqual(deletion.signal, signal);
        }
        assert.equal(deletion.signal.aborted, false);

        h.deleteBody.resolve(jsonBytes({ job_id: JOB.job_id, status: 'failed' }));
        await disposal.promise;
        assert.deepEqual(h.requests.map(request => request.method), ['POST', 'DELETE']);
        assert.equal(deletion.signal.aborted, false);
        assert.equal(h.shared.liveEntries.size, 0);
    });

test('changing scope while the cancelled create body is pending never obtains the later account token for DELETE',
    { timeout: 5000 }, async t => {
        const h = harness(t);
        const controller = new AbortController();
        const lease = h.acquire(controller.signal);
        const rejected = assert.rejects(lease.result, { name: 'AbortError' });
        await h.createReading.promise;
        controller.abort();
        await rejected;
        h.changeScope();
        const disposal = observeDispose(h.shared);
        await flushTasks();
        assert.equal(disposal.finished, false);
        assert.equal(h.requests[0].signal.aborted, false);

        h.createBody.resolve(jsonBytes(JOB));
        await disposal.promise;
        assert.deepEqual(h.tokenScopes, ['s1']);
        assert.equal(h.requests[0].headers.Authorization, 'Bearer initial-token');
        assert.deepEqual(h.requests.map(request => request.method), ['POST']);
        assert.equal(h.shared.liveEntries.size, 0);
    });

test('DELETE token waiting and an uncooperative body share one deadline that aborts transport and finishes dispose',
    { timeout: 5000 }, async t => {
        const h = harness(t);
        const authorizing = deferred();
        const token = deferred();
        t.after(() => token.resolve('initial-token'));
        const tokenWaitMs = 7;
        const controller = new AbortController();
        let lookups = 0;
        const lease = h.acquire(controller.signal, {
            getAccessToken: async () => {
                if (++lookups === 1) return 'initial-token';
                authorizing.resolve();
                return token.promise;
            },
        });
        const rejected = assert.rejects(lease.result, { name: 'AbortError' });
        await h.createReading.promise;
        controller.abort();
        await rejected;
        const disposal = observeDispose(h.shared);
        h.createBody.resolve(jsonBytes(JOB));
        await authorizing.promise;

        t.mock.timers.tick(tokenWaitMs);
        token.resolve('initial-token');
        await h.deleteReading.promise;
        const deletion = h.requests[1];
        t.mock.timers.tick(CANCEL_TIMEOUT_MS - tokenWaitMs - 1);
        await flushTasks();
        assert.equal(disposal.finished, false);
        assert.equal(deletion.signal.aborted, false);

        t.mock.timers.tick(1);
        await flushTasks();
        assert.equal(deletion.signal.aborted, true);
        // The body gate remains unresolved until teardown. The shared 500 ms
        // fallback has not elapsed, so completion comes from client cleanup.
        assert.equal(disposal.finished, true);
        await disposal.promise;
        assert.equal(lookups, 2);
        assert.deepEqual(h.requests.map(request => request.method), ['POST', 'DELETE']);
        assert.equal(h.shared.liveEntries.size, 0);
    });
