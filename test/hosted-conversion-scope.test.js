import test from 'node:test';
import assert from 'node:assert/strict';

import { createHostedConversionScope } from '../src/mktero/conversion-scope.js';

const PREF = {
    apiBase: 'extensions.mktero.accountApiBase',
    email: 'extensions.mktero.accountEmail',
    epoch: 'extensions.mktero.accountSessionEpoch',
    provider: 'extensions.mktero.conversionProvider',
    refreshToken: 'extensions.mktero.accountRefreshToken',
};

function createZotero(initial = {}, { observers = true } = {}) {
    const values = {
        [PREF.apiBase]: 'http://127.0.0.1:8080',
        [PREF.email]: '',
        [PREF.epoch]: 'epoch-1',
        [PREF.provider]: 'mktero',
        [PREF.refreshToken]: '',
        ...initial,
    };
    const registrations = new Map();
    let nextID = 0;
    const prefs = {
        get(key) {
            return values[key];
        },
        set(key, value) {
            values[key] = value;
        },
        registrations,
        emit(key) {
            for (const registration of registrations.values()) {
                if (registration.preference === key) registration.callback();
            }
        },
    };
    if (observers) {
        prefs.registerObserver = (preference, callback, global) => {
            assert.equal(global, true);
            const id = ++nextID;
            registrations.set(id, { preference, callback });
            return id;
        };
        prefs.unregisterObserver = id => registrations.delete(id);
    }
    return { zotero: { Prefs: prefs }, prefs, values };
}

function signedIn(initial = {}) {
    return createZotero({
        [PREF.email]: ' Reader@Example.com ',
        [PREF.refreshToken]: 'refresh-secret-1',
        ...initial,
    });
}

test('provider A to B to A returns distinct runtime scopes', () => {
    const { zotero, prefs } = createZotero({ [PREF.provider]: 'mineru' });
    const changes = [];
    const hosted = createHostedConversionScope({ zotero, onChange: scope => changes.push(scope) });
    const first = hosted.current();

    prefs.set(PREF.provider, 'mistral');
    prefs.emit(PREF.provider);
    const second = hosted.current();
    prefs.set(PREF.provider, 'mineru');
    prefs.emit(PREF.provider);
    const third = hosted.current();

    assert.notEqual(second, first);
    assert.notEqual(third, second);
    assert.notEqual(third, first);
    assert.deepEqual(changes, [second, third]);
    hosted.dispose();
});

test('session epoch changes scope while token rotation does not expose token values', () => {
    const { zotero, prefs } = signedIn();
    const changes = [];
    const hosted = createHostedConversionScope({ zotero, onChange: scope => changes.push(scope) });
    const initial = hosted.current();

    prefs.set('extensions.mktero.accountAccessToken', 'access-secret-2');
    prefs.set(PREF.refreshToken, 'refresh-secret-2');
    prefs.emit(PREF.refreshToken);
    assert.equal(hosted.current(), initial);
    assert.deepEqual(changes, []);
    assert.equal(initial.includes('refresh-secret'), false);
    assert.equal(initial.includes('access-secret'), false);

    prefs.set(PREF.epoch, 'epoch-2');
    prefs.emit(PREF.epoch);
    assert.notEqual(hosted.current(), initial);
    assert.equal(changes.length, 1);
    hosted.dispose();
});

test('same-email logout and login produce a new hosted scope', () => {
    const { zotero, prefs } = signedIn();
    const hosted = createHostedConversionScope({ zotero });
    const initial = hosted.current();

    prefs.set(PREF.epoch, 'logout-epoch');
    prefs.emit(PREF.epoch);
    prefs.set(PREF.refreshToken, '');
    prefs.emit(PREF.refreshToken);
    prefs.set(PREF.email, '');
    prefs.emit(PREF.email);
    const loggedOut = hosted.current();

    prefs.set(PREF.epoch, 'login-epoch');
    prefs.emit(PREF.epoch);
    prefs.set(PREF.email, 'reader@example.com');
    prefs.emit(PREF.email);
    prefs.set(PREF.refreshToken, 'fresh-refresh-secret');
    prefs.emit(PREF.refreshToken);

    assert.notEqual(loggedOut, initial);
    assert.notEqual(hosted.current(), loggedOut);
    assert.notEqual(hosted.current(), initial);
    hosted.dispose();
});

test('API base changes invalidate scope using the normalized effective address', () => {
    const { zotero, prefs } = signedIn();
    const hosted = createHostedConversionScope({ zotero });
    const initial = hosted.current();

    prefs.set(PREF.apiBase, 'http://127.0.0.1:9090/');
    prefs.emit(PREF.apiBase);

    assert.notEqual(hosted.current(), initial);
    hosted.dispose();
});

test('current detects identity changes when preference observers are unavailable', () => {
    const { zotero, prefs } = createZotero({}, { observers: false });
    const changes = [];
    const hosted = createHostedConversionScope({ zotero, onChange: scope => changes.push(scope) });
    const initial = hosted.current();

    prefs.set(PREF.provider, 'mistral');
    const changed = hosted.current();

    assert.notEqual(changed, initial);
    assert.deepEqual(changes, [changed]);
    hosted.dispose();
});

test('updates the scope before a reentrant callback and contains callback errors', () => {
    const { zotero, prefs } = createZotero();
    const calls = [];
    let hosted;
    hosted = createHostedConversionScope({
        zotero,
        onChange(scope) {
            calls.push(scope);
            assert.equal(hosted.current(), scope);
            throw new Error('callback failure');
        },
    });
    const initial = hosted.current();

    assert.doesNotThrow(() => {
        prefs.set(PREF.provider, 'mineru');
        prefs.emit(PREF.provider);
    });

    assert.notEqual(hosted.current(), initial);
    assert.equal(calls.length, 1);
    hosted.dispose();
});

test('dispose removes account and conversion observers and prevents notifications', () => {
    const { zotero, prefs } = createZotero();
    let calls = 0;
    const hosted = createHostedConversionScope({ zotero, onChange: () => calls++ });
    assert.equal(prefs.registrations.size, 6);

    hosted.dispose();
    hosted.dispose();
    assert.equal(prefs.registrations.size, 0);

    const disposedScope = hosted.current();
    prefs.set(PREF.provider, 'mistral');
    prefs.emit(PREF.provider);
    prefs.set(PREF.epoch, 'epoch-2');
    prefs.emit(PREF.epoch);
    assert.notEqual(hosted.current(), disposedScope);
    assert.equal(calls, 0);
});
