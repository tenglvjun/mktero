import test from 'node:test';
import assert from 'node:assert/strict';
import {
    clipboardTextMatches,
    createCopyDelivery,
    VERIFY_DELAYS_MS,
} from '../src/editor/copy-delivery.js';

// The delivery loop schedules its next timer only after a few microtask
// turns, so a flush has to settle the queue before it looks for a timer and
// again after firing one.
const settle = () => new Promise(resolve => {
    setImmediate(resolve);
});

function createTimers() {
    const pending = [];
    return {
        pending,
        setTimeout(callback, delay) {
            const timer = { callback, delay, cleared: false };
            pending.push(timer);
            return timer;
        },
        clearTimeout(timer) {
            timer.cleared = true;
        },
    };
}

async function flush(timers, count = 1) {
    for (let index = 0; index < count; index += 1) {
        await settle();
        const timer = timers.pending.find(candidate => !candidate.cleared);
        assert.ok(timer, 'expected a pending timer');
        timer.cleared = true;
        timer.callback();
        await settle();
    }
}

function createDelivery({
    reads = [],
    writes = [],
    isActive = () => true,
    verifyDelays,
} = {}) {
    const timers = createTimers();
    const written = [];
    const options = [];
    const delivery = createCopyDelivery({
        readText: async () => {
            const next = reads.shift();
            if (next instanceof Error) throw next;
            return next === undefined ? null : next;
        },
        writeText: async (text, ...rest) => {
            written.push(text);
            options.push(rest);
            const next = writes.shift();
            if (next instanceof Error) throw next;
        },
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        isActive,
        verifyDelays,
    });
    return { delivery, timers, written, options };
}

test('accepts a clipboard that already holds the copied text', async () => {
    const { delivery, timers, written } = createDelivery({
        reads: ['Copied text'],
    });

    const result = delivery.deliver({ text: 'Copied text' });
    await flush(timers);
    assert.equal(await result, 'delivered');
    assert.deepEqual(written, []);
    assert.equal(timers.pending.length, 1);
});

test('treats Firefox line wrapping as the same copy', async () => {
    const { delivery, timers } = createDelivery({
        reads: ['Copied\r\n text'],
    });

    const result = delivery.deliver({ text: 'Copied text' });
    await flush(timers);
    assert.equal(await result, 'delivered');
});

test('writes again when the clipboard still holds the previous copy', async () => {
    const { delivery, timers, written } = createDelivery({
        reads: ['old copy', 'Copied text'],
        verifyDelays: [40, 120],
    });

    const result = delivery.deliver({ text: 'Copied text' });
    // Nothing is written before the first read-back says the copy missed.
    assert.deepEqual(written, []);
    await flush(timers, 2);
    assert.equal(await result, 'repaired');
    assert.deepEqual(written, ['Copied text']);
});

test('writes the note HTML again beside the text it rewrites', async () => {
    const { delivery, timers, written, options } = createDelivery({
        reads: ['old copy', 'Copied $i$'],
        verifyDelays: [40, 120],
    });

    const result = delivery.deliver({
        text: 'Copied $i$',
        html: '<p>Copied <span class="math">$i$</span></p>',
        exact: true,
    });
    await flush(timers, 2);
    assert.equal(await result, 'repaired');
    assert.deepEqual(written, ['Copied $i$']);
    assert.deepEqual(options, [[{
        html: '<p>Copied <span class="math">$i$</span></p>',
    }]]);

    const plain = createDelivery({ reads: ['old copy', 'Plain'], verifyDelays: [40, 120] });
    const plainResult = plain.delivery.deliver({ text: 'Plain', html: '   ' });
    await flush(plain.timers, 2);
    assert.equal(await plainResult, 'repaired');
    assert.deepEqual(plain.options, [[]]);
});

test('writes before the first check when the copy event never happened', async () => {
    const { delivery, timers, written } = createDelivery({
        reads: ['Copied text'],
    });

    const result = delivery.deliver({
        text: 'Copied text',
        exact: true,
        writeFirst: true,
    });
    assert.deepEqual(written, ['Copied text']);
    await flush(timers);
    assert.equal(await result, 'repaired');
});

// Firefox reports a clipboard that another program holds as holding no
// text. That is the reader's real case on Windows: keep writing in the free
// moments until the copy is there.
test('keeps writing while a held clipboard reads as empty', async () => {
    const { delivery, timers, written } = createDelivery({
        reads: [null, null, null, 'Copied text'],
        verifyDelays: [40, 80, 120, 160],
    });

    const result = delivery.deliver({ text: 'Copied text' });
    await flush(timers, 4);
    assert.equal(await result, 'repaired');
    assert.deepEqual(written, ['Copied text', 'Copied text', 'Copied text']);
});

test('does not write while the clipboard service itself cannot be read', async () => {
    const { delivery, timers, written } = createDelivery({
        // Unavailable once, then readable and still holding the old text.
        reads: [new Error('clipboard unavailable'), 'old copy', 'Copied text'],
        verifyDelays: [40, 120, 300, 600],
    });

    const result = delivery.deliver({ text: 'Copied text' });
    await flush(timers);
    // A read that throws is not evidence of a miss, so nothing is written.
    assert.deepEqual(written, []);
    await flush(timers);
    assert.deepEqual(written, ['Copied text']);
    await flush(timers);
    assert.equal(await result, 'repaired');
});

test('retries a write that throws while another program holds the clipboard', async () => {
    const { delivery, timers, written } = createDelivery({
        reads: ['old copy', 'old copy', 'Copied text'],
        writes: [new Error('clipboard held')],
        verifyDelays: [40, 120, 300],
    });

    const result = delivery.deliver({ text: 'Copied text' });
    await flush(timers, 3);
    assert.equal(await result, 'repaired');
    // The first write threw; the second one reached the clipboard.
    assert.deepEqual(written, ['Copied text', 'Copied text']);
});

test('reports a failure while the clipboard service stays unavailable', async () => {
    const held = new Error('clipboard unavailable');
    const { delivery, timers, written } = createDelivery({
        reads: [held, held],
        verifyDelays: [40, 120],
    });

    const result = delivery.deliver({ text: 'Copied text' });
    await flush(timers, 2);
    assert.equal(await result, 'failed');
    assert.deepEqual(written, []);
});

test('stops when the reader leaves the window', async () => {
    let active = true;
    const { delivery, timers, written } = createDelivery({
        reads: ['old copy'],
        isActive: () => active,
    });

    const result = delivery.deliver({ text: 'Copied text' });
    active = false;
    await flush(timers);
    assert.equal(await result, 'cancelled');
    assert.deepEqual(written, []);
});

test('reports a failure after the last retry still misses', async () => {
    const { delivery, timers, written } = createDelivery({
        reads: ['old copy', 'old copy'],
        verifyDelays: [40, 120],
    });

    const result = delivery.deliver({ text: 'Copied text' });
    await flush(timers, 2);
    assert.equal(await result, 'failed');
    assert.deepEqual(written, ['Copied text']);
});

test('stops a delivery that a newer copy supersedes', async () => {
    // The first delivery is cancelled before its first read, so the only
    // read belongs to the newer copy.
    const { delivery, timers, written } = createDelivery({
        reads: ['Newer copy'],
        verifyDelays: [40, 120],
    });

    const first = delivery.deliver({ text: 'Copied text' });
    const second = delivery.deliver({ text: 'Newer copy' });
    assert.equal(await first, 'cancelled');
    await flush(timers);
    assert.equal(await second, 'delivered');
    assert.deepEqual(written, []);
});

test('skips a copy with no visible text', async () => {
    const { delivery, written } = createDelivery();
    assert.equal(await delivery.deliver({ text: '   ' }), 'skipped');
    assert.deepEqual(written, []);
});

test('compares exact copies without collapsing internal whitespace', () => {
    assert.equal(
        clipboardTextMatches('a  b', 'a  b', { exact: true }),
        true
    );
    assert.equal(clipboardTextMatches('a  b', 'a b', { exact: true }), false);
    assert.equal(clipboardTextMatches('a  b', 'a b'), true);
});

test('cancelling still settles when an unloading window cannot clear timers', async () => {
    const pending = [];
    const delivery = createCopyDelivery({
        readText: async () => 'old copy',
        writeText: async () => {},
        setTimeout: (callback, delay) => {
            const timer = { callback, delay };
            pending.push(timer);
            return timer;
        },
        clearTimeout: () => {
            throw new Error('NS_ERROR_NOT_INITIALIZED');
        },
    });

    const result = delivery.deliver({ text: 'Copied text' });
    await settle();
    assert.doesNotThrow(() => delivery.cancel());
    assert.equal(await result, 'cancelled');
    // The timer that could not be cleared later finds the delivery stale.
    pending[0].callback();
    await settle();
});

test('the default checks run for about two seconds and rewrite at most seven times', async () => {
    const { delivery, timers, written } = createDelivery({
        reads: VERIFY_DELAYS_MS.map(() => 'old copy'),
    });

    const result = delivery.deliver({ text: 'Copied text' });
    await flush(timers, VERIFY_DELAYS_MS.length);
    assert.equal(await result, 'failed');
    assert.equal(written.length, VERIFY_DELAYS_MS.length - 1);
    const total = VERIFY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
    assert.ok(total >= 1500 && total <= 2500, `total ${total} ms`);
});
