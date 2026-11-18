import test from 'node:test';
import assert from 'node:assert/strict';
import {
    TranslationRequestTracker,
} from '../src/ai/translation-request-tracker.js';

test('replaces an in-flight translation for the same document block', async () => {
    const tracker = new TranslationRequestTracker({
        createAbortController: () => new AbortController(),
    });
    let firstSignal;
    let finishFirst;
    const first = tracker.run(42, 'paragraph-1', signal => {
        firstSignal = signal;
        return new Promise(resolve => { finishFirst = resolve; });
    });
    const second = tracker.run(
        42,
        'paragraph-1',
        signal => Promise.resolve(signal.aborted)
    );

    assert.equal(firstSignal.aborted, true);
    assert.equal(await second, false);
    finishFirst('stale');
    assert.equal(await first, 'stale');
});

test('cancels one block without aborting another block in the document', async () => {
    const tracker = new TranslationRequestTracker({
        createAbortController: () => new AbortController(),
    });
    const signals = new Map();
    const resolvers = new Map();
    const run = blockID => tracker.run(42, blockID, signal => {
        signals.set(blockID, signal);
        return new Promise(resolve => resolvers.set(blockID, resolve));
    });
    const first = run('paragraph-1');
    const second = run('paragraph-2');

    assert.equal(tracker.cancelBlock(42, 'paragraph-1'), true);
    assert.equal(signals.get('paragraph-1').aborted, true);
    assert.equal(signals.get('paragraph-2').aborted, false);
    resolvers.get('paragraph-1')();
    resolvers.get('paragraph-2')();
    await Promise.all([first, second]);
});

test('replaces and cancels a selection request independently of document translation', async () => {
    const tracker = new TranslationRequestTracker({
        createAbortController: () => new AbortController(),
    });
    let firstSignal;
    let secondSignal;
    let finishFirst;
    const first = tracker.run(42, 'selection', signal => {
        firstSignal = signal;
        return new Promise(resolve => { finishFirst = resolve; });
    });
    const documentRequest = tracker.run(42, 'document', signal => {
        secondSignal = signal;
        return Promise.resolve();
    });
    const second = tracker.run(42, 'selection', signal => {
        secondSignal = signal;
        return Promise.resolve(signal.aborted);
    });

    assert.equal(firstSignal.aborted, true);
    assert.equal(await documentRequest, undefined);
    assert.equal(await second, false);
    assert.equal(tracker.cancelBlock(42, 'selection'), false);
    finishFirst();
    await first;
});

test('cancels every translation in a closed document and during shutdown', async () => {
    const tracker = new TranslationRequestTracker({
        createAbortController: () => new AbortController(),
    });
    const operations = [];
    const start = (documentID, blockID) => {
        let resolve;
        const operation = {};
        operation.promise = tracker.run(documentID, blockID, signal => {
            operation.signal = signal;
            return new Promise(done => { resolve = done; });
        });
        operation.finish = () => resolve();
        operations.push(operation);
    };
    start(42, 'paragraph-1');
    start(42, 'paragraph-2');
    start(84, 'paragraph-1');

    assert.equal(tracker.cancelDocument(42), true);
    assert.equal(operations[0].signal.aborted, true);
    assert.equal(operations[1].signal.aborted, true);
    assert.equal(operations[2].signal.aborted, false);

    tracker.abortAll();
    assert.equal(operations[2].signal.aborted, true);
    for (const operation of operations) operation.finish();
    await Promise.all(operations.map(operation => operation.promise));
});
