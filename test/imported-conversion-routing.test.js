import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversionProviderRouter } from '../src/core/conversion-provider.js';

function fixture(imported) {
    const calls = [];
    let failure;
    const provider = {
        extract: async () => {
            calls.push('remote');
            if (failure) throw failure;
            return { kind: 'markdown', markdown: 'Converted' };
        },
        readCached: async () => { calls.push('cached'); return null; },
    };
    return {
        calls,
        fail(error) { failure = error; },
        router: new ConversionProviderRouter({
            getProvider: () => 'mktero',
            providers: { mineru: provider, mistral: provider, mktero: provider },
            imported,
        }),
    };
}

test('selected imported content bypasses every remote provider', async () => {
    const result = { kind: 'markdown', markdown: 'Imported' };
    const f = fixture({ extract: async () => result, readCached: async () => result });
    assert.equal(await f.router.extract(1), result);
    assert.equal(await f.router.readCached(1), result);
    assert.deepEqual(f.calls, []);
});

test('failed or aborted imports never fall through to conversion', async () => {
    for (const name of ['Error', 'AbortError']) {
        const error = Object.assign(new Error('Local result unavailable'), { name });
        const fail = async () => { throw error; };
        const f = fixture({ extract: fail, readCached: fail });
        await assert.rejects(f.router.extract(1), value => value === error);
        await assert.rejects(f.router.readCached(1), value => value === error);
        assert.deepEqual(f.calls, []);
    }
});

test('a local-only open refuses an absent selection without conversion', async () => {
    const f = fixture({ extract: async () => null, readCached: async () => null });
    await assert.rejects(f.router.extract(1, { localOnly: true }), { code: 'LLM_CACHE_UNAVAILABLE' });
    assert.deepEqual(f.calls, []);
});

test('unselected attachments continue to use the configured provider', async () => {
    const f = fixture({ extract: async () => null, readCached: async () => null });
    await f.router.extract(1);
    await f.router.readCached(1);
    assert.deepEqual(f.calls, ['remote', 'cached']);
});

test('explicit reparse releases only the previous selection after success', async () => {
    const selected = { attachmentKey: 'KEY', sourceHash: 'hash' };
    const forgotten = [];
    const f = fixture({
        extract: async () => assert.fail('read imported result during reparse'),
        readCached: async () => null,
        lookup: async () => selected,
        forgetSelection: async record => forgotten.push(record),
    });
    f.fail(new Error('Provider failed'));
    await assert.rejects(f.router.extract(1, { forceRefresh: true }), /Provider failed/);
    assert.deepEqual(forgotten, []);
    f.fail(null);
    await f.router.extract(1, { forceRefresh: true });
    assert.deepEqual(forgotten, [selected]);
});
