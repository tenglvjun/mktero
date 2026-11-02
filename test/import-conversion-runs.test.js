import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversionRunRegistry } from '../src/core/conversion-runs.js';

function fixture() {
    const executions = [];
    const registry = createConversionRunRegistry({
        createController: () => new AbortController(),
        execute: (id, options) => {
            executions.push(options);
            return new Promise((resolve, reject) => {
                options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
            });
        },
    });
    return { registry, executions };
}

test('an import and a conversion cannot replace or adopt each other', async () => {
    for (const [first, second] of [['import-llm-cache', 'convert'], ['convert', 'import-llm-cache']]) {
        const { registry, executions } = fixture();
        const run = registry.begin({ itemID: 1, owner: 'tab', operation: first });
        assert.throws(() => registry.begin({
            itemID: 1, owner: 'tab', operation: second, forceRefresh: true,
        }), { code: 'LLM_CACHE_BUSY' });
        assert.equal(executions.length, 1);
        assert.equal(run.run.signal.aborted, false);
        assert.equal(run.run.operation, first);
        registry.abortAll();
        await assert.rejects(run.run.promise);
    }
});

test('local-only context and import operation reach the task executor', async () => {
    const { registry, executions } = fixture();
    const run = registry.begin({ itemID: 1, owner: 'tab', operation: 'import-llm-cache', localOnly: true });
    assert.equal(executions[0].operation, 'import-llm-cache');
    assert.equal(executions[0].localOnly, true);
    registry.release(1, 'tab');
    await assert.rejects(run.run.promise);
});
