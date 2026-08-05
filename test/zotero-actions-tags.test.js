import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createZoteroActionsTagsBridge,
} from '../src/platform/zotero-actions-tags.js';

function createZoteroHarness({
    readers = [],
    dispatch = async () => {},
    includeActionsTags = true,
} = {}) {
    const calls = [];
    const errors = [];
    const items = new Map([
        [7, { id: 7, parentItemID: 0 }],
        [42, { id: 42, parentItemID: 7 }],
        [43, { id: 43, parentItemID: 7 }],
    ]);

    const zotero = {
        Items: {
            get(itemID) {
                return items.get(itemID) || null;
            },
            getTopLevel(item) {
                const sources = Array.isArray(item) ? item : [item];
                return sources.map(source => {
                    const parent = items.get(source.parentItemID);
                    return parent || source;
                });
            },
        },
        Reader: {
            _readers: readers,
        },
        logError(error) {
            errors.push(error);
        },
    };

    if (includeActionsTags) {
        zotero.ActionsTags = {
            api: {
                actionManager: {
                    async dispatchActionByEvent(event, args) {
                        calls.push({ event, args });
                        return dispatch(event, args);
                    },
                },
            },
        };
    }

    return {
        zotero,
        calls,
        errors,
        bridge: createZoteroActionsTagsBridge({
            zotero,
            onError: error => errors.push(error),
        }),
    };
}

test('dispatches openFile once for a direct Markdown session using its parent item', async () => {
    const harness = createZoteroHarness();

    await harness.bridge.openMarkdownSession({
        sessionID: 'mktero-42',
        sourceItemID: 42,
        entryPoint: 'item-menu',
    });
    await harness.bridge.openMarkdownSession({
        sessionID: 'mktero-42',
        sourceItemID: 42,
        entryPoint: 'item-menu',
    });

    assert.deepEqual(harness.calls, [{
        event: 2,
        args: { itemID: 7 },
    }]);
});

test('does not duplicate native reader actions for the reader toolbar entry point', async () => {
    const harness = createZoteroHarness({
        readers: [{ type: 'pdf', itemID: 42 }],
    });

    await harness.bridge.openMarkdownSession({
        sessionID: 'mktero-42',
        sourceItemID: 42,
        entryPoint: 'reader-toolbar',
    });
    await harness.bridge.closeMarkdownSession({
        sessionID: 'mktero-42',
        sourceItemID: 42,
        reason: 'user',
    });

    assert.deepEqual(harness.calls, []);
});

test('does not own a Markdown session when its PDF reader is already open', async () => {
    const harness = createZoteroHarness({
        readers: [{ type: 'pdf', itemID: 42 }],
    });

    await harness.bridge.openMarkdownSession({
        sessionID: 'mktero-42',
        sourceItemID: 42,
        entryPoint: 'item-menu',
    });
    await harness.bridge.closeMarkdownSession({
        sessionID: 'mktero-42',
        sourceItemID: 42,
        reason: 'user',
    });

    assert.deepEqual(harness.calls, []);
});

test('recognizes a native reader for a sibling PDF under the same item', async () => {
    const harness = createZoteroHarness({
        readers: [{ type: 'pdf', itemID: 43 }],
    });

    await harness.bridge.openMarkdownSession({
        sessionID: 'mktero-42',
        sourceItemID: 42,
        entryPoint: 'item-menu',
    });
    await harness.bridge.closeMarkdownSession({
        sessionID: 'mktero-42',
        sourceItemID: 42,
        reason: 'user',
    });

    assert.deepEqual(harness.calls, []);
});

test('dispatches closeTab once for a user-closing owned Markdown session', async () => {
    const harness = createZoteroHarness();

    await harness.bridge.openMarkdownSession({
        sessionID: 'mktero-42',
        sourceItemID: 42,
        entryPoint: 'item-menu',
    });
    await harness.bridge.closeMarkdownSession({
        sessionID: 'mktero-42',
        sourceItemID: 42,
        reason: 'user',
    });
    await harness.bridge.closeMarkdownSession({
        sessionID: 'mktero-42',
        sourceItemID: 42,
        reason: 'user',
    });

    assert.deepEqual(harness.calls, [
        { event: 2, args: { itemID: 7 } },
        { event: 3, args: { itemID: 7 } },
    ]);
});

test('does not dispatch closeTab for replacement or shutdown cleanup', async () => {
    const replacement = createZoteroHarness();
    await replacement.bridge.openMarkdownSession({
        sessionID: 'mktero-42',
        sourceItemID: 42,
        entryPoint: 'item-menu',
    });
    await replacement.bridge.closeMarkdownSession({
        sessionID: 'mktero-42',
        sourceItemID: 42,
        reason: 'replacement',
    });

    const shutdown = createZoteroHarness();
    await shutdown.bridge.openMarkdownSession({
        sessionID: 'mktero-42',
        sourceItemID: 42,
        entryPoint: 'item-menu',
    });
    await shutdown.bridge.closeMarkdownSession({
        sessionID: 'mktero-42',
        sourceItemID: 42,
        reason: 'shutdown',
    });

    assert.deepEqual(replacement.calls, [{
        event: 2,
        args: { itemID: 7 },
    }]);
    assert.deepEqual(shutdown.calls, [{
        event: 2,
        args: { itemID: 7 },
    }]);
});

test('keeps the bridge optional when Actions & Tags is unavailable', async () => {
    const harness = createZoteroHarness({ includeActionsTags: false });

    await harness.bridge.openMarkdownSession({
        sessionID: 'mktero-42',
        sourceItemID: 42,
        entryPoint: 'item-menu',
    });
    await harness.bridge.closeMarkdownSession({
        sessionID: 'mktero-42',
        sourceItemID: 42,
        reason: 'user',
    });

    assert.deepEqual(harness.calls, []);
    assert.deepEqual(harness.errors, []);
});

test('does not block Markdown when an Actions & Tags action fails', async () => {
    const failure = new Error('Actions & Tags unavailable');
    const harness = createZoteroHarness({
        dispatch: async () => {
            throw failure;
        },
    });

    await assert.doesNotReject(() => harness.bridge.openMarkdownSession({
        sessionID: 'mktero-42',
        sourceItemID: 42,
        entryPoint: 'item-menu',
    }));

    assert.deepEqual(harness.errors, [failure]);
});

test('serializes closeTab after an in-flight openFile action', async () => {
    let releaseOpen;
    const openFinished = new Promise(resolve => {
        releaseOpen = resolve;
    });
    const harness = createZoteroHarness({
        dispatch: async event => {
            if (event === 2) await openFinished;
        },
    });

    const open = harness.bridge.openMarkdownSession({
        sessionID: 'mktero-42',
        sourceItemID: 42,
        entryPoint: 'item-menu',
    });
    const close = harness.bridge.closeMarkdownSession({
        sessionID: 'mktero-42',
        sourceItemID: 42,
        reason: 'user',
    });

    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(harness.calls, [{
        event: 2,
        args: { itemID: 7 },
    }]);

    releaseOpen();
    await Promise.all([open, close]);

    assert.deepEqual(harness.calls, [
        { event: 2, args: { itemID: 7 } },
        { event: 3, args: { itemID: 7 } },
    ]);
});

test('does not dispatch a close action after bridge disposal', async () => {
    const harness = createZoteroHarness();

    await harness.bridge.openMarkdownSession({
        sessionID: 'mktero-42',
        sourceItemID: 42,
        entryPoint: 'item-menu',
    });
    harness.bridge.dispose();
    await harness.bridge.closeMarkdownSession({
        sessionID: 'mktero-42',
        sourceItemID: 42,
        reason: 'user',
    });

    assert.deepEqual(harness.calls, [{
        event: 2,
        args: { itemID: 7 },
    }]);
});
