import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CONVERSION_PROVIDER_IDS,
    ConversionProviderRouter,
} from '../src/core/conversion-provider.js';

test('dispatches extraction to the configured provider', async () => {
    const calls = [];
    const options = {
        signal: new AbortController().signal,
        forceRefresh: true,
    };
    const result = { kind: 'markdown', provider: 'mistral' };
    const router = new ConversionProviderRouter({
        getProvider: () => CONVERSION_PROVIDER_IDS.MISTRAL,
        providers: {
            mineru: {
                extract: async () => assert.fail('MinerU was selected'),
                readCached: async () => null,
            },
            mistral: {
                extract: async (...args) => {
                    calls.push(args);
                    return result;
                },
                readCached: async () => null,
            },
            mktero: {
                extract: async () => assert.fail('Mktero was selected'),
                readCached: async () => null,
            },
        },
    });

    assert.equal(await router.extract(42, options), result);
    assert.deepEqual(calls, [[42, options]]);
});

test('falls back to Mktero for an invalid provider value', async () => {
    let selected = null;
    const router = new ConversionProviderRouter({
        getProvider: () => 'unsupported',
        providers: {
            mineru: {
                extract: async () => assert.fail('MinerU was selected'),
                readCached: async () => null,
            },
            mistral: {
                extract: async () => assert.fail('Mistral was selected'),
                readCached: async () => null,
            },
            mktero: {
                extract: async itemID => {
                    selected = itemID;
                    return { provider: 'mktero' };
                },
                readCached: async () => null,
            },
        },
    });

    assert.deepEqual(await router.extract(7), { provider: 'mktero' });
    assert.equal(selected, 7);
});

test('reads the provider for each extraction and preserves the signal', async () => {
    let configured = 'mineru';
    const calls = [];
    const signal = new AbortController().signal;
    const router = new ConversionProviderRouter({
        getProvider: () => configured,
        providers: {
            mineru: {
                extract: async (...args) => {
                    calls.push(['mineru', ...args]);
                    return { provider: 'mineru' };
                },
                readCached: async () => null,
            },
            mistral: {
                extract: async (...args) => {
                    calls.push(['mistral', ...args]);
                    return { provider: 'mistral' };
                },
                readCached: async () => null,
            },
            mktero: {
                extract: async (...args) => {
                    calls.push(['mktero', ...args]);
                    return { provider: 'mktero' };
                },
                readCached: async () => null,
            },
        },
    });

    await router.extract(1, { signal });
    configured = 'mistral';
    await router.extract(2, { signal });
    configured = 'mktero';
    await router.extract(3, { signal });

    assert.equal(calls[0][0], 'mineru');
    assert.equal(calls[1][0], 'mistral');
    assert.equal(calls[2][0], 'mktero');
    assert.equal(calls[0][2].signal, signal);
    assert.equal(calls[1][2].signal, signal);
    assert.equal(calls[2][2].signal, signal);
});

test('requires every provider extractor', () => {
    assert.throws(
        () => new ConversionProviderRouter({
            getProvider: () => 'mineru',
            providers: { mineru: { extract() {} } },
        }),
        /mistral document extractor is required/
    );
    assert.throws(
        () => new ConversionProviderRouter({
            getProvider: () => 'mineru',
            providers: {
                mineru: { extract() {} },
                mistral: {},
            },
        }),
        /mistral document extractor is required/
    );
    assert.throws(
        () => new ConversionProviderRouter({
            getProvider: () => 'mineru',
            providers: {
                mineru: {},
                mistral: { extract() {} },
            },
        }),
        /mineru document extractor is required/
    );
    assert.throws(
        () => new ConversionProviderRouter({
            getProvider: () => 'mineru',
            providers: {
                mineru: { extract() {} },
                mistral: { extract() {} },
            },
        }),
        /mktero document extractor is required/
    );
    assert.throws(
        () => new ConversionProviderRouter({
            getProvider: () => 'mineru',
            providers: {
                mineru: { extract() {}, readCached() {} },
                mistral: { extract() {} },
                mktero: { extract() {}, readCached() {} },
            },
        }),
        /mistral document extractor is required/
    );
});

test('forwards readCached to the active provider without extracting', async () => {
    let configured = 'mistral';
    const calls = [];
    const options = { signal: new AbortController().signal };
    const router = new ConversionProviderRouter({
        getProvider: () => configured,
        providers: {
            mineru: {
                extract: async () => assert.fail('extract was called'),
                readCached: async () => assert.fail('MinerU was selected'),
            },
            mistral: {
                extract: async () => assert.fail('extract was called'),
                readCached: async (...args) => {
                    calls.push(args);
                    return null;
                },
            },
            mktero: {
                extract: async () => assert.fail('extract was called'),
                readCached: async (...args) => {
                    calls.push(['mktero', ...args]);
                    return null;
                },
            },
        },
    });

    assert.equal(await router.readCached(9, options), null);
    configured = 'unsupported';
    assert.equal(await router.readCached(3, options), null);
    assert.deepEqual(calls, [[9, options], ['mktero', 3, options]]);
});
