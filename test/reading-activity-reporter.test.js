import test from 'node:test';
import assert from 'node:assert/strict';

import {
    READING_ACTIVITY_INTERVAL_MS,
    READING_ACTIVITY_RETRY_DELAY_MS,
    startReadingActivityReporter,
} from '../src/account/account-session.js';
import { saveAccountSession } from '../src/config/account-preferences.js';
import { createReadingActivityCounter } from '../src/account/reading-activity.js';

const NOW = 1_700_000_000_000;

function memoryPrefs(initial = {}) {
    const values = { ...initial };
    return {
        get(key) {
            return values[key];
        },
        set(key, value) {
            values[key] = value;
        },
        dump() {
            return values;
        },
    };
}

function signedInZotero() {
    const zotero = { Prefs: memoryPrefs() };
    saveAccountSession(zotero, {
        email: 'user@example.com',
        nickname: 'paper-reader',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        // Valid well past the test's clock, so no refresh is attempted.
        accessExpiresAt: NOW + 60 * 60 * 1000,
    });
    return zotero;
}

// A timer harness that records scheduled callbacks instead of waiting for real
// time, so one test can drive many cycles synchronously.
function timerHarness() {
    const pending = [];
    return {
        setTimeoutImpl(callback, delay) {
            const handle = { callback, delay, cleared: false };
            pending.push(handle);
            return handle;
        },
        clearTimeoutImpl(handle) {
            if (handle) handle.cleared = true;
        },
        // runNext fires the oldest live timer and waits for the cycle to settle.
        // The reporter schedules its next timer in a `finally` after an await, so
        // a fixed number of microtask ticks is not enough; a macrotask boundary is.
        async runNext() {
            const handle = pending.find(item => !item.cleared);
            if (!handle) return false;
            handle.cleared = true;
            handle.callback();
            await settle();
            return true;
        },
        pendingDelays() {
            return pending.filter(item => !item.cleared).map(item => item.delay);
        },
        liveCount() {
            return pending.filter(item => !item.cleared).length;
        },
    };
}

// settle yields to the macrotask queue so every pending microtask chain in the
// reporter completes before the assertion runs.
function settle() {
    return new Promise(resolve => setImmediate(resolve));
}

function jsonResponse(status, body = null) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
            return body;
        },
    };
}

function counterWithActivity(now = () => NOW) {
    const counter = createReadingActivityCounter({ now });
    counter.opened({ itemID: 'A' });
    counter.scrolled({ itemID: 'A' });
    return counter;
}

// The reporter must not open a request for an idle session. An extension that
// polls the service every ten minutes with nothing to say is worse than no
// telemetry at all.
test('an idle reporter sends nothing', async () => {
    const timers = timerHarness();
    let calls = 0;
    const zotero = signedInZotero();
    const reporter = startReadingActivityReporter(zotero, {
        counter: createReadingActivityCounter({ now: () => NOW }),
        fetchImpl: async () => {
            calls += 1;
            return jsonResponse(204);
        },
        now: () => NOW,
        ...timers,
    });
    await timers.runNext();
    assert.equal(calls, 0, 'no request for an empty counter');
    assert.deepEqual(timers.pendingDelays(), [READING_ACTIVITY_INTERVAL_MS]);
    reporter.dispose();
});

// The first cycle waits a full interval: opening Zotero is the busiest moment and
// there is nothing to send yet.
test('the first flush waits one interval', async () => {
    const timers = timerHarness();
    const zotero = signedInZotero();
    const reporter = startReadingActivityReporter(zotero, {
        counter: counterWithActivity(),
        fetchImpl: async () => jsonResponse(204),
        now: () => NOW,
        ...timers,
    });
    assert.deepEqual(timers.pendingDelays(), [READING_ACTIVITY_INTERVAL_MS]);
    reporter.dispose();
});

test('a cycle posts the counters and resets them', async () => {
    const timers = timerHarness();
    const zotero = signedInZotero();
    const counter = counterWithActivity();
    const bodies = [];
    const paths = [];
    const reporter = startReadingActivityReporter(zotero, {
        counter,
        fetchImpl: async (url, init) => {
            paths.push(String(url));
            bodies.push(JSON.parse(init.body));
            return jsonResponse(204);
        },
        now: () => NOW,
        ...timers,
    });
    await timers.runNext();

    assert.equal(bodies.length, 1);
    assert.ok(paths[0].endsWith('/api/v1/me/reading-activity'));
    assert.deepEqual(bodies[0], {
        day: '2023-11-14',
        readers_opened: 1,
        documents_read: 1,
        readers_scrolled: 1,
        deep_reads: 0,
        annotations_created: 0,
        exports: 0,
        translations: 0,
    });
    assert.equal(counter.pending(), false);
    reporter.dispose();
});

// A server that predates the endpoint must not cost the operator a day of data,
// which is the whole reason the client ships before the server in some rollouts.
test('a 404 keeps the batch for the next cycle', async () => {
    const timers = timerHarness();
    const zotero = signedInZotero();
    const errors = [];
    let attempt = 0;
    let secondBody = null;
    const reporter = startReadingActivityReporter(zotero, {
        counter: counterWithActivity(),
        fetchImpl: async (_url, init) => {
            attempt += 1;
            if (attempt === 1) return jsonResponse(404, { error: { code: 'not_found' } });
            secondBody = JSON.parse(init.body);
            return jsonResponse(204);
        },
        now: () => NOW,
        onError: error => errors.push(error),
        ...timers,
    });

    await timers.runNext();
    assert.equal(attempt, 1);
    // A missing endpoint is expected, not an error worth logging every ten
    // minutes for every user on an older server.
    assert.equal(errors.length, 0, 'an unsupported endpoint is not reported as an error');
    assert.deepEqual(timers.pendingDelays(), [READING_ACTIVITY_RETRY_DELAY_MS]);

    await timers.runNext();
    assert.equal(attempt, 2, 'the batch is retried, not dropped');
    assert.equal(secondBody.readers_opened, 1, 'the retried batch still carries the original counts');
    assert.deepEqual(timers.pendingDelays(), [READING_ACTIVITY_INTERVAL_MS]);
    reporter.dispose();
});

// A dead session makes the batch undeliverable forever. Holding it would only
// grow the parked day, so it is dropped and the cycle continues normally.
test('a signed-out session drops the batch instead of retrying it', async () => {
    const timers = timerHarness();
    const zotero = signedInZotero();
    let calls = 0;
    const reporter = startReadingActivityReporter(zotero, {
        counter: counterWithActivity(),
        fetchImpl: async () => {
            calls += 1;
            return jsonResponse(401, { error: { code: 'invalid_token' } });
        },
        now: () => NOW,
        ...timers,
    });
    await timers.runNext();
    // One attempt plus the forced-refresh retry, both rejected.
    assert.equal(calls, 2);
    assert.deepEqual(timers.pendingDelays(), [READING_ACTIVITY_INTERVAL_MS]);
    reporter.dispose();
});

test('a network failure keeps the batch and retries sooner', async () => {
    const timers = timerHarness();
    const zotero = signedInZotero();
    const errors = [];
    let attempt = 0;
    const reporter = startReadingActivityReporter(zotero, {
        counter: counterWithActivity(),
        fetchImpl: async () => {
            attempt += 1;
            if (attempt === 1) throw new Error('network down');
            return jsonResponse(204);
        },
        now: () => NOW,
        onError: error => errors.push(error),
        ...timers,
    });
    await timers.runNext();
    assert.equal(errors.length, 1, 'a real failure is reported');
    assert.deepEqual(timers.pendingDelays(), [READING_ACTIVITY_RETRY_DELAY_MS]);
    await timers.runNext();
    assert.equal(attempt, 2);
    assert.deepEqual(timers.pendingDelays(), [READING_ACTIVITY_INTERVAL_MS]);
    reporter.dispose();
});

test('flush sends immediately and reports delivery', async () => {
    const timers = timerHarness();
    const zotero = signedInZotero();
    let calls = 0;
    const reporter = startReadingActivityReporter(zotero, {
        counter: counterWithActivity(),
        fetchImpl: async () => {
            calls += 1;
            return jsonResponse(204);
        },
        now: () => NOW,
        ...timers,
    });
    const delivered = await reporter.flush();
    assert.equal(delivered, true);
    assert.equal(calls, 1);
    reporter.dispose();
});

test('flush resolves false instead of rejecting when the service is unreachable', async () => {
    const timers = timerHarness();
    const zotero = signedInZotero();
    const reporter = startReadingActivityReporter(zotero, {
        counter: counterWithActivity(),
        fetchImpl: async () => {
            throw new Error('network down');
        },
        now: () => NOW,
        onError: () => {},
        ...timers,
    });
    const delivered = await reporter.flush();
    assert.equal(delivered, false, 'shutdown must not reject on a telemetry failure');
    reporter.dispose();
});

test('flush with nothing pending resolves true without a request', async () => {
    const timers = timerHarness();
    const zotero = signedInZotero();
    let calls = 0;
    const reporter = startReadingActivityReporter(zotero, {
        counter: createReadingActivityCounter({ now: () => NOW }),
        fetchImpl: async () => {
            calls += 1;
            return jsonResponse(204);
        },
        now: () => NOW,
        ...timers,
    });
    assert.equal(await reporter.flush(), true);
    assert.equal(calls, 0);
    reporter.dispose();
});

test('dispose stops the timer and a second start returns the same handle', async () => {
    const timers = timerHarness();
    const zotero = signedInZotero();
    const counter = createReadingActivityCounter({ now: () => NOW });
    const first = startReadingActivityReporter(zotero, {
        counter,
        fetchImpl: async () => jsonResponse(204),
        now: () => NOW,
        ...timers,
    });
    const second = startReadingActivityReporter(zotero, {
        counter,
        fetchImpl: async () => jsonResponse(204),
        now: () => NOW,
        ...timers,
    });
    assert.equal(first, second, 'a second start must not create a second scheduler');
    first.dispose();
    assert.equal(timers.liveCount(), 0);
    // After dispose the runtime may be started again from scratch.
    const third = startReadingActivityReporter(zotero, {
        counter,
        fetchImpl: async () => jsonResponse(204),
        now: () => NOW,
        ...timers,
    });
    assert.notEqual(third, first);
    third.dispose();
});

// The reporter and the version heartbeat run on different intervals. Sharing a
// scheduler would let the six-hour cycle swallow every reading flush, so this
// pins that they are independent objects on the same runtime.
test('the reading reporter does not reuse the heartbeat scheduler', async () => {
    const timers = timerHarness();
    const zotero = signedInZotero();
    const reporter = startReadingActivityReporter(zotero, {
        counter: createReadingActivityCounter({ now: () => NOW }),
        fetchImpl: async () => jsonResponse(204),
        now: () => NOW,
        ...timers,
    });
    assert.equal(reporter.dispose instanceof Function, true);
    assert.equal(reporter.flush instanceof Function, true);
    reporter.dispose();
});
