import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversionBatch } from '../src/core/conversion-batch.js';
import { parseConversionQuota, formatQuotaReset } from '../src/account/conversion-quota.js';
import { getMkteroConversionQuota } from '../src/account/account-client.js';
import { MkteroConversionClient } from '../src/mktero/mktero-conversion-client.js';

const quota = { mode: 'enforce', limit: 10, used: 8, reserved: 2, remaining: 0,
    reset_at: '2026-11-03T00:00:00Z', server_time: '2026-11-02T22:00:00Z' };
const pauseError = () => Object.assign(new Error('quota'), {
    code: 'MKTERO_DAILY_SLOTS_RESERVED', quota: parseConversionQuota(quota),
});
const flush = () => new Promise(resolve => setImmediate(resolve));

test('validates quota fields and drops extra response fields', () => {
    assert.equal(parseConversionQuota(quota).limit, 10);
    assert.equal(parseConversionQuota({ ...quota, secret: 'unused' }).secret, undefined);
    for (const invalid of [NaN, Infinity, -1, '10', Number.MAX_SAFE_INTEGER + 1]) {
        assert.equal(parseConversionQuota({ ...quota, limit: invalid }), null);
    }
    assert.equal(parseConversionQuota({ ...quota, reset_at: 'invalid' }), null);
    assert.equal(parseConversionQuota({ ...quota, remaining: 2 }), null);
    assert.equal(parseConversionQuota({ ...quota, mode: 'shadow', used: 30 }).used, 30);
    assert.equal(formatQuotaReset('invalid'), '');
});

test('account quota request returns only validated data', async () => {
    const result = await getMkteroConversionQuota({
        apiBase: 'https://api.example', accessToken: 'token',
        fetchImpl: async (url, options) => {
            assert.equal(url, 'https://api.example/api/v1/me/conversion-quota');
            assert.equal(options.headers.Authorization, 'Bearer token');
            return { ok: true, json: async () => quota };
        },
    });
    assert.equal(result.limit, 10);
});

for (const [code, expected, status] of [
    ['conversion_daily_limit_exceeded', 'MKTERO_DAILY_LIMIT_EXCEEDED', 429],
    ['conversion_daily_slots_reserved', 'MKTERO_DAILY_SLOTS_RESERVED', 429],
    ['conversion_quota_unavailable', 'MKTERO_QUOTA_UNAVAILABLE', 503],
]) {
    test(`maps ${code} without replay or signout`, async () => {
        let calls = 0;
        const client = new MkteroConversionClient({ fetch: async (_url, init) => {
            calls += 1;
            assert.ok(init.headers['Idempotency-Key']);
            return new Response(JSON.stringify({ error: { code, quota } }), { status });
        } });
        await assert.rejects(client.convert({ apiBase: 'https://api.example',
            getAccessToken: () => 'token', fileName: 'a.pdf', fileData: new Uint8Array([1]),
        }), error => error.code === expected && error.quota.limit === 10);
        assert.equal(calls, 1);
    });
}

test('keeps create idempotency key through one unauthorized replay', async () => {
    const keys = [];
    const client = new MkteroConversionClient({ fetch: async (_url, init) => {
        keys.push(init.headers['Idempotency-Key']);
        return new Response(JSON.stringify({ error: {
            code: keys.length === 1 ? 'invalid_token' : 'conversion_daily_slots_reserved', quota,
        } }), { status: keys.length === 1 ? 401 : 429 });
    } });
    await assert.rejects(client.convert({ apiBase: 'https://api.example',
        getAccessToken: () => 'token', fileName: 'a.pdf', fileData: new Uint8Array([1]),
    }), { code: 'MKTERO_DAILY_SLOTS_RESERVED' });
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
});

test('pauses same-account pending work, settles waiters, and keeps in-flight work', async () => {
    const gates = new Map();
    const calls = [];
    const events = [];
    let scope = 'mktero:a';
    let ready = false;
    const batch = createConversionBatch({
        concurrency: 3, getScope: () => scope, isReady: item => ready && item.itemID === 4,
        onEvent: event => events.push(event),
        convert: item => new Promise((resolve, reject) => {
            calls.push(item.itemID); gates.set(item.itemID, { resolve, reject });
        }),
    });
    batch.enqueue([1, 2, 3, 4, 5].map(itemID => ({ itemID })));
    const pending = assert.rejects(batch.wait(4), { code: 'MKTERO_QUOTA_PAUSED' });
    gates.get(1).reject(pauseError());
    gates.get(2).reject(pauseError());
    await pending;
    await flush();
    assert.equal(batch.position(4).status, 'paused');
    assert.equal(events.filter(event => event.type === 'quota-blocked').length, 1);
    batch.enqueue([{ itemID: 6 }]);
    assert.equal(batch.position(6).status, 'paused');
    gates.get(3).resolve('ready');
    await flush();
    assert.equal(await batch.wait(3), 'ready');
    assert.deepEqual(calls, [1, 2, 3]);
    scope = 'mktero:b';
    assert.equal(batch.resume('mktero:a'), 0);
    batch.enqueue([{ itemID: 7 }]);
    assert.equal(calls.at(-1), 7);
    scope = 'mktero:a';
    ready = true;
    assert.equal(batch.resume(), 4);
    assert.equal(batch.position(4), null);
    const again = batch.wait(1);
    gates.get(1).resolve('recovered');
    assert.equal(await again, 'recovered');
});

test('cancel remaining leaves active jobs untouched', async () => {
    let reject;
    let secondSignal;
    const batch = createConversionBatch({
        concurrency: 2, getScope: () => 'mktero:a',
        convert: (item, { signal }) => new Promise((_resolve, fail) => {
            if (item.itemID === 1) reject = fail;
            else secondSignal = signal;
        }),
    });
    batch.enqueue([1, 2, 3].map(itemID => ({ itemID })));
    reject(pauseError());
    await flush();
    assert.deepEqual(batch.cancelRemaining(), [1, 3]);
    assert.equal(secondSignal.aborted, false);
    await assert.rejects(batch.wait(3), { name: 'AbortError' });
});
