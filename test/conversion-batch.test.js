import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CONVERSION_BATCH_CONCURRENCY,
    createConversionBatch,
} from '../src/core/conversion-batch.js';

function createHarness({
    isReady = () => false,
    isActive = () => false,
    isBlockedError = () => false,
    limit = 2,
    concurrency = 1,
} = {}) {
    const events = [];
    const calls = [];
    const gates = new Map();
    const batch = createConversionBatch({
        limit,
        concurrency,
        isReady,
        isActive,
        isBlockedError,
        onEvent: event => events.push(event.type === 'progress'
            ? { type: 'progress', itemID: event.item.itemID, progress: event.progress }
            : {
                type: event.type,
                itemID: event.item?.itemID,
                ahead: event.ahead,
            }),
        convert(item, { signal, onProgress }) {
            calls.push(item.itemID);
            onProgress(10, {});
            return new Promise((resolve, reject) => {
                const fail = error => reject(error);
                signal.addEventListener('abort', () => {
                    const error = new Error('The operation was aborted');
                    error.name = 'AbortError';
                    fail(error);
                }, { once: true });
                gates.set(item.itemID, { resolve, reject: fail });
            });
        },
    });
    return { batch, events, calls, gates };
}

function item(itemID, title = `Paper ${itemID}`) {
    return { itemID, title };
}

test('skips ready, active, and duplicate items without capping the queue', () => {
    const { batch, events } = createHarness({
        isReady: candidate => candidate.itemID === 2,
        isActive: candidate => candidate.itemID === 3,
    });
    const summary = batch.enqueue([
        item(1),
        item(1),
        item(2),
        item(3),
        item(4),
        { itemID: 0 },
    ]);

    assert.deepEqual(summary.accepted.map(entry => entry.itemID), [1, 4]);
    assert.deepEqual(summary.skippedReady.map(entry => entry.itemID), [2]);
    assert.deepEqual(summary.skippedActive.map(entry => entry.itemID), [3]);
    assert.equal(events.filter(event => event.type === 'queued').length, 2);
    const again = batch.enqueue([item(1)]);
    assert.deepEqual(again.skippedQueued.map(entry => entry.itemID), [1]);
});

test('runs one item at a time and continues after a failure', async () => {
    const harness = createHarness({ limit: 5 });
    harness.batch.enqueue([item(1), item(2), item(3)]);
    assert.deepEqual(harness.calls, [1]);
    assert.equal(harness.batch.position(2).ahead, 0);

    harness.gates.get(1).reject(new Error('ocr failed'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(harness.calls, [1, 2]);
    assert.equal(harness.batch.position(3).ahead, 0);

    const waiting = harness.batch.wait(2);
    harness.gates.get(2).resolve({ cacheKey: 'ready' });
    assert.deepEqual(await waiting, { cacheKey: 'ready' });
});

test('stops queued items when conversion settings are missing', async () => {
    const blocked = new Error('token');
    blocked.code = 'MINERU_API_KEY_INVALID';
    const harness = createHarness({
        limit: 5,
        isBlockedError: error => error.code === 'MINERU_API_KEY_INVALID',
    });
    harness.batch.enqueue([item(1), item(2)]);
    const waiting = assert.rejects(
        harness.batch.wait(2),
        error => error.name === 'AbortError'
    );
    harness.gates.get(1).reject(blocked);
    await waiting;
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(harness.calls, [1]);
    assert.equal(harness.batch.isPreparing(2), false);
    assert.equal(
        harness.events.some(event => event.type === 'blocked'),
        true
    );
});

test('cancel stops the running item and the rest of the queue', async () => {
    const harness = createHarness({ limit: 5 });
    harness.batch.enqueue([item(1), item(2)]);
    const waiting = harness.batch.wait(1);
    harness.batch.cancel();
    await assert.rejects(waiting, error => error.name === 'AbortError');
    assert.equal(harness.batch.isPreparing(1), false);
    assert.equal(harness.batch.isPreparing(2), false);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(harness.calls, [1]);
});

test('reports a shorter queue after an earlier item starts', () => {
    const harness = createHarness({ limit: 5 });
    harness.batch.enqueue([item(8), item(9)]);
    const positions = harness.events.filter(event => (
        event.type === 'position' && event.itemID === 9
    ));
    assert.equal(positions.at(-1).ahead, 0);
    assert.equal(harness.batch.position(8).status, 'running');
});

test('starts the default number of conversions together', () => {
    const calls = [];
    const batch = createConversionBatch({
        convert(item) {
            calls.push(item.itemID);
            return new Promise(() => {});
        },
    });
    batch.enqueue([1, 2, 3, 4].map(itemID => ({ itemID, title: `Paper ${itemID}` })));
    assert.equal(CONVERSION_BATCH_CONCURRENCY, 3);
    assert.deepEqual(calls, [1, 2, 3]);
    assert.equal(batch.position(4).status, 'queued');
});

test('strips control characters from untrusted titles', () => {
    const events = [];
    const batch = createConversionBatch({
        convert: () => new Promise(() => {}),
        onEvent: event => events.push(event),
    });
    batch.enqueue([{ itemID: 6, title: 'A\u0000 title' }]);
    assert.equal(events[0].item.title, 'A title');
});
