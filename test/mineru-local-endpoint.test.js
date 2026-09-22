import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isSameMinerUOrigin,
    normalizeMinerULocalApiBase,
    resolveMinerUURL,
} from '../src/mineru/local-endpoint.js';

test('accepts loopback HTTP, private HTTP, and explicit HTTPS MinerU addresses', () => {
    assert.equal(
        normalizeMinerULocalApiBase('http://127.0.0.1:8000/'),
        'http://127.0.0.1:8000'
    );
    assert.equal(
        normalizeMinerULocalApiBase('http://192.168.1.20:8000'),
        'http://192.168.1.20:8000'
    );
    assert.equal(
        normalizeMinerULocalApiBase('http://[::1]:8000'),
        'http://[::1]:8000'
    );
    assert.equal(
        normalizeMinerULocalApiBase('https://mineru.example/'),
        'https://mineru.example'
    );
});

test('rejects public HTTP, credentials, queries, and non-root MinerU addresses', () => {
    for (const value of [
        'http://mineru.example',
        'http://8.8.8.8:8000',
        'http://169.254.169.254',
        'http://user:pass@127.0.0.1:8000',
        'http://127.0.0.1:8000/?token=secret',
        'http://127.0.0.1:8000/mineru',
        'file:///tmp/mineru',
        '',
    ]) {
        assert.throws(
            () => normalizeMinerULocalApiBase(value),
            error => error.code === 'MINERU_LOCAL_ENDPOINT_INVALID'
                && !error.message.includes('secret')
                && !error.message.includes('169.254')
        );
    }
});

test('resolves local API paths and keeps cross-origin upload URLs unlogged', () => {
    assert.equal(
        resolveMinerUURL('http://127.0.0.1:8000', '/v1/tiers'),
        'http://127.0.0.1:8000/v1/tiers'
    );
    assert.equal(
        resolveMinerUURL(
            'http://127.0.0.1:8000/v1/files/file-1/content',
            'https://files.example/result.zip?sig=secret'
        ),
        'https://files.example/result.zip?sig=secret'
    );
    assert.equal(
        isSameMinerUOrigin('http://127.0.0.1:8000/v1/uploads', 'http://127.0.0.1:8000/v1/uploads/1/content'),
        true
    );
    assert.equal(
        isSameMinerUOrigin('http://127.0.0.1:8000', 'https://oss.example/upload'),
        false
    );
    assert.throws(
        () => resolveMinerUURL('http://127.0.0.1:8000', 'file:///etc/passwd'),
        error => error.code === 'MINERU_LOCAL_URL_REJECTED'
            && !error.message.includes('passwd')
    );
});
