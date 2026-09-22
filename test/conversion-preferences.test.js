import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CONVERSION_PROVIDER_MINERU,
    CONVERSION_PROVIDER_MISTRAL,
    CONVERSION_PROVIDER_PREF,
    getConversionProvider,
    getMinerUApiKey,
    getMinerUCacheEnabled,
    getMinerUEndpoint,
    getMinerULocalApiBase,
    getMinerULocalApiKey,
    getMistralApiKey,
    MINERU_API_KEY_PREF,
    MINERU_CACHE_ENABLED_PREF,
    MINERU_ENDPOINT_PREF,
    MINERU_LOCAL_API_BASE_PREF,
    MINERU_LOCAL_API_KEY_PREF,
    MISTRAL_API_KEY_PREF,
    normalizeConversionProvider,
    normalizeMinerUEndpoint,
} from '../src/config/conversion-preferences.js';

test('normalizes conversion providers to the supported values', () => {
    assert.equal(
        normalizeConversionProvider(CONVERSION_PROVIDER_MINERU),
        CONVERSION_PROVIDER_MINERU
    );
    assert.equal(
        normalizeConversionProvider(` ${CONVERSION_PROVIDER_MISTRAL} `),
        CONVERSION_PROVIDER_MISTRAL
    );
    assert.equal(normalizeConversionProvider('unsupported'), 'mineru');
    assert.equal(normalizeConversionProvider(undefined), 'mineru');
});

test('reads the selected conversion provider from global Zotero preferences', () => {
    const calls = [];
    const zotero = {
        Prefs: {
            get(key, global) {
                calls.push({ key, global });
                return key === CONVERSION_PROVIDER_PREF ? 'mistral' : '';
            },
        },
    };

    assert.equal(getConversionProvider(zotero), 'mistral');
    assert.deepEqual(calls, [{ key: CONVERSION_PROVIDER_PREF, global: true }]);
    assert.equal(
        getConversionProvider({ Prefs: { get: () => 'unsupported' } }),
        'mineru'
    );
    assert.equal(
        getConversionProvider({ Prefs: { get: () => undefined } }),
        'mineru'
    );
});

test('reads and trims independent MinerU and Mistral API keys', () => {
    const calls = [];
    const zotero = {
        Prefs: {
            get(key, global) {
                calls.push({ key, global });
                return key === MINERU_API_KEY_PREF
                    ? '  mineru-secret  '
                    : '  mistral-secret  ';
            },
        },
    };

    assert.equal(getMinerUApiKey(zotero), 'mineru-secret');
    assert.equal(getMistralApiKey(zotero), 'mistral-secret');
    assert.deepEqual(calls, [
        { key: MINERU_API_KEY_PREF, global: true },
        { key: MISTRAL_API_KEY_PREF, global: true },
    ]);
});

test('defaults cache reuse to enabled unless explicitly disabled', () => {
    const calls = [];
    const zotero = {
        Prefs: {
            get(key, global) {
                calls.push({ key, global });
                return false;
            },
        },
    };

    assert.equal(getMinerUCacheEnabled(zotero), false);
    assert.deepEqual(calls, [{ key: MINERU_CACHE_ENABLED_PREF, global: true }]);
    assert.equal(
        getMinerUCacheEnabled({ Prefs: { get: () => undefined } }),
        true
    );
});

test('keeps the MinerU local endpoint separate from the cloud token', () => {
    assert.equal(normalizeMinerUEndpoint('local'), 'local');
    assert.equal(normalizeMinerUEndpoint('unsupported'), 'cloud');
    const values = new Map([
        [MINERU_ENDPOINT_PREF, 'local'],
        [MINERU_LOCAL_API_BASE_PREF, ' http://10.0.0.8:8000 '],
        [MINERU_LOCAL_API_KEY_PREF, ' local-secret '],
    ]);
    const zotero = {
        Prefs: { get: key => values.get(key) },
    };

    assert.equal(getMinerUEndpoint(zotero), 'local');
    assert.equal(getMinerULocalApiBase(zotero), 'http://10.0.0.8:8000');
    assert.equal(getMinerULocalApiKey(zotero), 'local-secret');
    assert.equal(
        getMinerULocalApiBase({ Prefs: { get: () => '' } }),
        'http://127.0.0.1:8000'
    );
});
