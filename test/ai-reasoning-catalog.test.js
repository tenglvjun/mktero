import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MODELS_DEV_REASONING_CATALOG_URL,
    attachAIReasoningCatalogHost,
    compactAIReasoningCatalog,
    createAIReasoningCatalogStore,
} from '../src/config/ai-reasoning-catalog.js';
import { resolveAIReasoningLevels } from '../src/config/ai-reasoning-options.js';

const API = {
    openai: {
        models: {
            'gpt-4o': { reasoning: false },
            'gpt-5.4': {
                reasoning: true,
                reasoning_options: [{
                    type: 'effort',
                    values: ['none', 'low', 'medium', 'high', 'xhigh'],
                }],
            },
        },
    },
    openrouter: {
        api: 'https://openrouter.ai/api/v1',
        models: {
            'openai/gpt-5.4': {
                reasoning: true,
                reasoning_options: [{
                    type: 'effort',
                    values: ['none', 'low', 'high'],
                }],
            },
        },
    },
    'minimax-coding-plan': {
        api: 'https://api.minimax.io/anthropic/v1',
        models: {
            'MiniMax-M2': { reasoning: true, reasoning_options: [] },
        },
    },
    lmstudio: {
        api: 'http://127.0.0.1:1234/v1',
        models: {
            local: { reasoning: false },
        },
    },
};

test('compacts models.dev payloads into reasoning options and hosts', () => {
    const catalog = compactAIReasoningCatalog(API);
    assert.equal(catalog.source, MODELS_DEV_REASONING_CATALOG_URL);
    assert.equal(catalog.hosts['api.openai.com'], 'openai');
    assert.equal(catalog.hosts['openrouter.ai'], 'openrouter');
    assert.equal(catalog.hosts['api.minimax.io'], 'minimax');
    assert.equal(catalog.hosts['127.0.0.1'], undefined);
    assert.deepEqual(catalog.providers.openai['gpt-4o'], { reasoning: false });
    assert.deepEqual(
        resolveAIReasoningLevels({ provider: 'openai', model: 'gpt-4o' }, catalog),
        ['none']
    );
    assert.deepEqual(
        resolveAIReasoningLevels(
            { provider: 'openai', model: 'gpt-5.4' },
            catalog
        ),
        ['none', 'low', 'medium', 'high', 'xhigh']
    );
});

test('loads a catalog into memory and forgets it on dispose', async () => {
    const store = createAIReasoningCatalogStore({
        createAbortController: () => new AbortController(),
        fetch: async () => jsonResponse(API),
    });
    const loaded = await store.load();
    assert.equal(loaded.hosts['api.openai.com'], 'openai');
    assert.equal(store.getCatalog().providers.openai['gpt-4o'].reasoning, false);
    store.dispose();
    assert.equal(store.getCatalog(), null);
});

test('keeps the menu static when the catalog request fails', async () => {
    const store = createAIReasoningCatalogStore({
        createAbortController: () => new AbortController(),
        fetch: async () => {
            throw new Error('offline');
        },
    });
    await store.load();
    assert.equal(store.getCatalog(), null);
});

test('rejects an oversized catalog response before parsing it', async () => {
    const store = createAIReasoningCatalogStore({
        createAbortController: () => new AbortController(),
        maxBytes: 8,
        fetch: async () => jsonResponse(API),
    });
    await store.load();
    assert.equal(store.getCatalog(), null);
});

test('aborts an in-flight catalog fetch on dispose', async () => {
    let signal;
    const store = createAIReasoningCatalogStore({
        createAbortController: () => new AbortController(),
        fetch: (_url, init) => {
            signal = init.signal;
            return new Promise(() => {});
        },
    });
    const loading = store.load();
    store.dispose();
    assert.equal(signal.aborted, true);
    await loading;
    assert.equal(store.getCatalog(), null);
});

test('notifies subscribers after the in-memory catalog arrives', async () => {
    const catalogs = [];
    const store = createAIReasoningCatalogStore({
        createAbortController: () => new AbortController(),
        fetch: async () => jsonResponse(API),
    });
    store.subscribe(value => catalogs.push(value));
    await store.load();
    assert.equal(catalogs.at(-1).hosts['openrouter.ai'], 'openrouter');
});

test('exposes the in-memory catalog on the Zotero host and clears it', async () => {
    const zotero = {};
    const store = createAIReasoningCatalogStore({
        createAbortController: () => new AbortController(),
        fetch: async () => jsonResponse(API),
    });
    const detach = attachAIReasoningCatalogHost(zotero, store);
    const seen = [];
    zotero.Mktero.subscribeAIReasoningCatalog(value => seen.push(value));
    await store.load();
    assert.equal(
        zotero.Mktero.getAIReasoningCatalog().hosts['api.openai.com'],
        'openai'
    );
    assert.equal(seen.at(-1).hosts['api.openai.com'], 'openai');
    detach();
    assert.equal(zotero.Mktero, undefined);
});

function jsonResponse(value) {
    const text = JSON.stringify(value);
    return {
        ok: true,
        headers: { get: () => String(text.length) },
        text: async () => text,
    };
}
