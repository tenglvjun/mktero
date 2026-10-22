import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createBlockHeightIdentity,
    createBlockHeightMemory,
} from '../src/editor/block-height-memory.js';

test('returns a remembered height only for the same block source', () => {
    const memory = createBlockHeightMemory();
    const figure = createBlockHeightIdentity('image', 120, '![Figure 1.](a.png)');
    assert.equal(memory.estimate(figure), -1);

    memory.remember(figure, 940);
    assert.equal(memory.estimate(figure), 940);
    assert.equal(
        memory.estimate(createBlockHeightIdentity('image', 120, '![Figure 1.](a.png)')),
        940
    );
    // A different source at the same offset is a different block.
    assert.equal(
        memory.estimate(createBlockHeightIdentity('image', 120, '![Figure 2.](b.png)')),
        -1
    );
    assert.equal(
        memory.estimate(createBlockHeightIdentity('table', 120, '![Figure 1.](a.png)')),
        -1
    );
});

test('ignores heights that are not a measured size', () => {
    const memory = createBlockHeightMemory();
    const block = createBlockHeightIdentity('table', 0, '| a |');
    for (const height of [0, -20, Number.NaN, Number.POSITIVE_INFINITY]) {
        memory.remember(block, height);
    }
    assert.equal(memory.estimate(block), -1);
    memory.remember(null, 200);
    assert.equal(memory.estimate(null), -1);
});

test('drops the oldest block once the memory is full', () => {
    const memory = createBlockHeightMemory({ limit: 2 });
    const first = createBlockHeightIdentity('image', 0, 'first');
    const second = createBlockHeightIdentity('image', 10, 'second');
    const third = createBlockHeightIdentity('image', 20, 'third');
    memory.remember(first, 100);
    memory.remember(second, 200);
    memory.remember(first, 110);
    memory.remember(third, 300);

    assert.equal(memory.estimate(first), 110);
    assert.equal(memory.estimate(second), -1);
    assert.equal(memory.estimate(third), 300);
});

test('rejects an identity without a block offset or source', () => {
    assert.equal(createBlockHeightIdentity('', 0, 'source'), null);
    assert.equal(createBlockHeightIdentity('image', 1.5, 'source'), null);
    assert.equal(createBlockHeightIdentity('image', 0, null), null);
});
