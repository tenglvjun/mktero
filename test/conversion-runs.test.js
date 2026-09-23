import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversionRunRegistry } from '../src/core/conversion-runs.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((next, fail) => {
        resolve = next;
        reject = fail;
    });
    return { promise, resolve, reject };
}

function registry(execute) {
    return createConversionRunRegistry({
        createController: () => new AbortController(),
        execute,
    });
}

test('adopts an active conversion instead of starting another', async () => {
    const started = [];
    const gate = deferred();
    const runs = registry(itemID => {
        started.push(itemID);
        return gate.promise;
    });

    const first = runs.begin({ itemID: 7, owner: 'batch' });
    const second = runs.begin({ itemID: 7, owner: 'tab' });

    assert.equal(first.adopted, false);
    assert.equal(second.adopted, true);
    assert.equal(first.run.promise, second.run.promise);
    assert.deepEqual(started, [7]);
    assert.equal(runs.hasOwner(7, 'tab'), true);
    gate.resolve({ cacheHit: false });
    assert.deepEqual(await second.run.promise, { cacheHit: false });
});

test('replaces an active conversion when refresh is forced', async () => {
    const runs = registry((_itemID, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const first = runs.begin({ itemID: 7, owner: 'batch' });
    const replacement = runs.begin({
        itemID: 7,
        owner: 'tab',
        forceRefresh: true,
    });

    await assert.rejects(first.run.promise, error => (
        error.code === 'MKTERO_CONVERSION_REPLACED'
    ));
    assert.equal(replacement.adopted, false);
    assert.equal(runs.hasOwner(7, 'batch'), false);
    assert.equal(runs.hasOwner(7, 'tab'), true);
    runs.abort(7);
    await assert.rejects(replacement.run.promise);
});

test('aborts only after the last owner releases', async () => {
    let signal;
    const runs = registry((_itemID, context) => new Promise((_resolve, reject) => {
        signal = context.signal;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const begun = runs.begin({ itemID: 4, owner: 'batch' });
    runs.attach(4, 'tab');

    assert.equal(runs.release(4, 'tab'), false);
    assert.equal(signal.aborted, false);
    assert.equal(runs.release(4, 'batch'), true);
    await assert.rejects(begun.run.promise, error => error.name === 'AbortError');
    assert.equal(runs.isActive(4), false);
});

test('keeps a figure restoration running when the tab releases without aborting', async () => {
    let signal;
    const runs = registry((_itemID, context) => new Promise(resolve => {
        signal = context.signal;
        signal.addEventListener('abort', () => resolve('aborted'), { once: true });
    }));
    const begun = runs.begin({ itemID: 4, owner: 'tab' });
    assert.equal(runs.release(4, 'tab', { abortIfLast: false }), false);
    assert.equal(signal.aborted, false);
    assert.equal(runs.isActive(4), true);
    runs.abort(4);
    assert.equal(await begun.run.promise, 'aborted');
});

test('replays the latest progress to a subscriber that arrives mid-conversion', async () => {
    const gate = deferred();
    const runs = registry((_itemID, { onProgress }) => {
        onProgress(12, { resumingTask: true });
        return gate.promise;
    });
    const events = [];
    runs.begin({ itemID: 9, owner: 'batch' });
    await Promise.resolve();
    const unsubscribe = runs.subscribe(9, event => events.push(event));

    assert.deepEqual(events, [{
        type: 'progress',
        progress: 12,
        state: { resumingTask: true },
    }]);
    unsubscribe();
    gate.resolve({ ok: true });
    await runs.get(9).promise;
});

test('delivers progress to a listener registered before the run starts', async () => {
    const events = [];
    const runs = registry((_itemID, { onProgress }) => {
        onProgress(5, {});
        return { ok: true };
    });
    runs.subscribe(3, event => events.push(event.type));
    const begun = runs.begin({ itemID: 3, owner: 'tab' });
    await begun.run.promise;
    assert.deepEqual(events, ['progress', 'ready']);
});
