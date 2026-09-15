import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createFigureRestorationTask,
    createFigureRestorationTaskRegistry,
} from '../src/figures/figure-restoration-task.js';

test('streams every figure and the final result to a late subscriber', async () => {
    const task = createFigureRestorationTask({ id: 'k', run: async ({ onFigure }) => {
        onFigure({ id: 'a', status: 'composed' });
        onFigure({ id: 'b', status: 'preserved', reason: 'render-failed' });
        return { draft: true };
    } });
    await task.started;
    const seen = [];
    task.subscribe((event, source) => {
        if (event?.draft || event?.id) seen.push(event);
        assert.equal(source, task);
    });
    assert.deepEqual(seen.map(event => event.id || 'result'), ['a', 'b', 'result']);
    assert.equal(task.settled, true);
});

test('a detached subscriber does not cancel the run', async () => {
    let finished = false;
    const task = createFigureRestorationTask({ id: 'k', run: async ({ onFigure }) => {
        onFigure({ id: 'a', status: 'composed' });
        finished = true;
        return { draft: true };
    } });
    const unsubscribe = task.subscribe(() => {});
    unsubscribe();
    await task.started;
    assert.equal(finished, true);
    assert.equal(task.settled, true);
    assert.equal(task.signal.aborted, false);
});

test('registry deduplicates by id and cancels everything on shutdown', async () => {
    const registry = createFigureRestorationTaskRegistry();
    let aborted = false;
    const run = ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    });
    const first = registry.start('cache-key', run);
    const second = registry.start('cache-key', run);
    assert.equal(first, second);
    await Promise.resolve();
    registry.cancelAll();
    await first.started.catch(() => {});
    assert.equal(aborted, true);
    assert.equal(registry.get('cache-key'), null);
});

test('cancelling a task aborts its signal', async () => {
    const task = createFigureRestorationTask({ id: 'k', run: ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) });
    task.cancel();
    await assert.rejects(task.started, { name: 'AbortError' });
    assert.equal(task.error.name, 'AbortError');
});
