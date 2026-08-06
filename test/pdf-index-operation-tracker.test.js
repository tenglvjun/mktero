import test from 'node:test';
import assert from 'node:assert/strict';
import {
    PDFIndexOperationTracker,
} from '../src/pdf/pdf-index-operation-tracker.js';

test('keeps a completed conversion cancellable while PDF indexing continues', async () => {
    const tracker = new PDFIndexOperationTracker();
    const controller = new AbortController();
    let resolveIndex;
    const indexTask = new Promise(resolve => {
        resolveIndex = resolve;
    });
    tracker.start(42, controller);
    tracker.track(42, controller.signal, indexTask);

    tracker.finish(42, controller);
    tracker.abort(42);

    assert.equal(controller.signal.aborted, true);
    resolveIndex();
    await indexTask;
});

test('releases a completed operation after its PDF index settles', async () => {
    const tracker = new PDFIndexOperationTracker();
    const controller = new AbortController();
    const indexTask = Promise.resolve();
    tracker.start(42, controller);
    tracker.track(42, controller.signal, indexTask);
    tracker.finish(42, controller);
    await indexTask;
    await Promise.resolve();

    tracker.abort(42);

    assert.equal(controller.signal.aborted, false);
});

test('does not let an old PDF index task release a replacement operation', async () => {
    const tracker = new PDFIndexOperationTracker();
    const previous = new AbortController();
    let resolvePrevious;
    const previousTask = new Promise(resolve => {
        resolvePrevious = resolve;
    });
    tracker.start(42, previous);
    tracker.track(42, previous.signal, previousTask);
    tracker.finish(42, previous);
    const replacement = new AbortController();
    tracker.start(42, replacement);
    resolvePrevious();
    await previousTask;
    await Promise.resolve();

    tracker.abort(42);

    assert.equal(previous.signal.aborted, true);
    assert.equal(replacement.signal.aborted, true);
});

test('aborts every active conversion and PDF index during shutdown', () => {
    const tracker = new PDFIndexOperationTracker();
    const first = new AbortController();
    const second = new AbortController();
    tracker.start(42, first);
    tracker.start(84, second);

    tracker.abortAll();

    assert.equal(first.signal.aborted, true);
    assert.equal(second.signal.aborted, true);
});
