import test from 'node:test';
import assert from 'node:assert/strict';
import { MinerULocalConversion } from '../src/mineru/local-conversion.js';
import { MINERU_LOCAL_PARSER_PROFILE_ID } from '../src/mineru/parser-profile.js';

test('uses the local cache without creating a pending MinerU task', async () => {
    const calls = [];
    const cache = {
        async get() {
            return { markdown: '# Cached local', assets: [] };
        },
        async put() {
            throw new Error('cache put should not run');
        },
    };
    const conversion = new MinerULocalConversion({
        client: { async parse() { throw new Error('network should not run'); } },
        cache,
    });

    const converted = await conversion.convert({
        key: 'a'.repeat(64),
        apiBase: 'http://127.0.0.1:8000',
        fileData: new Uint8Array([1]),
        cacheEnabled: true,
        onProgress: value => calls.push(value),
    });

    assert.equal(converted.origin, 'cache');
    assert.equal(converted.result.markdown, '# Cached local');
    assert.equal(converted.result.parserProfile, MINERU_LOCAL_PARSER_PROFILE_ID);
    assert.equal(converted.result.detailedLayout, undefined);
    assert.deepEqual(calls, [100]);
});

test('stores a fresh local result and does not keep figure layout', async () => {
    const stored = [];
    const conversion = new MinerULocalConversion({
        client: {
            async parse() {
                return {
                    markdown: '# Fresh local',
                    assets: [],
                    assetBasePath: '',
                    detailedLayout: { schema: 'docvortex.middle' },
                    figureMap: { figures: [] },
                };
            },
        },
        cache: {
            async get() { return null; },
            async put(key, result) { stored.push({ key, result }); },
        },
    });

    const converted = await conversion.convert({
        key: 'b'.repeat(64),
        apiBase: 'http://127.0.0.1:8000',
        fileData: new Uint8Array([1]),
        cacheEnabled: true,
    });

    assert.equal(converted.origin, 'fresh');
    assert.equal(converted.result.detailedLayout, undefined);
    assert.equal(converted.result.figureMap, undefined);
    assert.equal(stored[0].result.markdown, '# Fresh local');
    assert.equal(stored[0].result.figureMap, undefined);
});
