import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MINERU_ENDPOINT_CLOUD,
    MINERU_ENDPOINT_LOCAL,
} from '../src/config/conversion-preferences.js';
import { createMinerUConversionFacade } from '../src/mineru/conversion-facade.js';

function createBranchDouble(sideEffect) {
    const calls = [];
    const double = {
        calls,
        sideEffects: 0,
        async convert(options) {
            calls.push({ method: 'convert', options });
            return { origin: 'fresh', result: { markdown: 'converted' }, warnings: [] };
        },
        async readCached(options) {
            calls.push({ method: 'readCached', options });
            return null;
        },
    };
    double[sideEffect] = () => {
        double.sideEffects += 1;
    };
    return double;
}

function createFacade({ endpoint, cloud, local }) {
    return createMinerUConversionFacade({
        getEndpoint: () => endpoint,
        cloud,
        local,
        getLocalApiKey: () => 'local-secret',
        getLocalApiBase: () => 'http://127.0.0.1:8000',
    });
}

const cachedRead = {
    key: 'cache-key',
    fileData: new Uint8Array([9]),
    cacheEnabled: true,
};

test('a cloud cache miss does not call local parse', async () => {
    const cloud = createBranchDouble('submit');
    const local = createBranchDouble('parse');
    const facade = createFacade({
        endpoint: MINERU_ENDPOINT_CLOUD,
        cloud,
        local,
    });

    assert.equal(await facade.readCached(cachedRead), null);
    assert.deepEqual(cloud.calls, [{ method: 'readCached', options: cachedRead }]);
    assert.deepEqual(local.calls, []);
    assert.equal(local.sideEffects, 0);
    assert.equal(cloud.sideEffects, 0);
});

test('a local cache miss does not call cloud submit', async () => {
    const cloud = createBranchDouble('submit');
    const local = createBranchDouble('parse');
    const facade = createFacade({
        endpoint: MINERU_ENDPOINT_LOCAL,
        cloud,
        local,
    });

    assert.equal(await facade.readCached(cachedRead), null);
    assert.deepEqual(local.calls, [{ method: 'readCached', options: cachedRead }]);
    assert.deepEqual(cloud.calls, []);
    assert.equal(cloud.sideEffects, 0);
    assert.equal(local.sideEffects, 0);
});

test('convert uses the same cloud and local branch as readCached', async () => {
    const cloud = createBranchDouble('submit');
    const local = createBranchDouble('parse');
    const options = {
        key: 'cache-key',
        apiKey: 'cloud-token',
        fileData: new Uint8Array([1]),
    };
    const endpoints = [MINERU_ENDPOINT_CLOUD, MINERU_ENDPOINT_LOCAL];
    let index = 0;
    const facade = createMinerUConversionFacade({
        getEndpoint: () => endpoints[index],
        cloud,
        local,
        getLocalApiKey: () => 'local-secret',
        getLocalApiBase: () => 'http://127.0.0.1:8000',
    });

    await facade.convert(options);
    index = 1;
    await facade.convert(options);

    assert.deepEqual(cloud.calls, [{ method: 'convert', options }]);
    assert.deepEqual(local.calls, [{
        method: 'convert',
        options: {
            ...options,
            apiKey: 'local-secret',
            apiBase: 'http://127.0.0.1:8000',
        },
    }]);
    assert.equal(cloud.sideEffects, 0);
    assert.equal(local.sideEffects, 0);
});
