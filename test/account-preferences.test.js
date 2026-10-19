import test from 'node:test';
import assert from 'node:assert/strict';
import {
    accessTokenNeedsRefresh,
    ACCOUNT_REFRESH_MARGIN_MS,
    clearAccountSession,
    getAccountApiBase,
    getAccountSession,
    isAccountSignedIn,
    saveAccountProfile,
    saveAccountSession,
    setAccountApiBase,
} from '../src/config/account-preferences.js';

function memoryPrefs(initial = {}) {
    const values = { ...initial };
    return {
        get(key) {
            return values[key];
        },
        set(key, value) {
            values[key] = value;
        },
        dump() {
            return values;
        },
    };
}

test('stores both tokens and refreshes shortly before the access token expires', () => {
    const zotero = { Prefs: memoryPrefs() };
    const now = 1_000_000;
    saveAccountSession(zotero, {
        email: 'user@example.com',
        accessToken: 'access',
        refreshToken: 'refresh',
        accessExpiresAt: now + ACCOUNT_REFRESH_MARGIN_MS + 1,
    });
    const session = getAccountSession(zotero);
    assert.equal(isAccountSignedIn(session), true);
    assert.equal(accessTokenNeedsRefresh(session, now), false);
    assert.equal(
        accessTokenNeedsRefresh(session, now + 2),
        true
    );
    clearAccountSession(zotero);
    assert.equal(isAccountSignedIn(getAccountSession(zotero)), false);
    assert.equal(zotero.Prefs.dump()['extensions.mktero.accountAccessToken'], '');
});

test('debug server address changes clear the saved session', () => {
    const zotero = { Prefs: memoryPrefs() };
    saveAccountSession(zotero, {
        email: 'user@example.com',
        accessToken: 'access',
        refreshToken: 'refresh',
        accessExpiresAt: 10,
    });
    assert.equal(getAccountApiBase(zotero), 'http://127.0.0.1:8080');
    assert.equal(
        setAccountApiBase(zotero, 'http://127.0.0.1:8080'),
        'http://127.0.0.1:8080'
    );
    assert.equal(isAccountSignedIn(getAccountSession(zotero)), true);
    setAccountApiBase(zotero, 'http://127.0.0.1:9090');
    assert.equal(isAccountSignedIn(getAccountSession(zotero)), false);
    assert.throws(
        () => setAccountApiBase(zotero, 'http://example.com'),
        { code: 'MINERU_LOCAL_ENDPOINT_INVALID' }
    );

});

function signedInPrefs() {
    const zotero = { Prefs: memoryPrefs() };
    saveAccountSession(zotero, {
        email: 'user@example.com',
        nickname: 'old-name',
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        accessExpiresAt: 5_000,
    });
    return zotero;
}

test('saving a profile leaves the tokens another refresh just stored', () => {
    const zotero = signedInPrefs();
    // A refresh lands while the profile request is in flight.
    saveAccountSession(zotero, {
        email: 'user@example.com',
        nickname: 'old-name',
        accessToken: 'access-2',
        refreshToken: 'refresh-2',
        accessExpiresAt: 9_000,
    });

    const saved = saveAccountProfile(
        zotero,
        { email: 'user@example.com', nickname: 'new-name' },
        { expectedEmail: 'user@example.com' }
    );

    assert.equal(saved, true);
    const session = getAccountSession(zotero);
    assert.equal(session.nickname, 'new-name');
    assert.equal(session.accessToken, 'access-2');
    assert.equal(session.refreshToken, 'refresh-2');
    assert.equal(session.accessExpiresAt, 9_000);
});

test('saving a profile after sign-out does not restore the session', () => {
    const zotero = signedInPrefs();
    clearAccountSession(zotero);

    const saved = saveAccountProfile(
        zotero,
        { email: 'user@example.com', nickname: 'new-name' },
        { expectedEmail: 'user@example.com' }
    );

    assert.equal(saved, false);
    const session = getAccountSession(zotero);
    assert.equal(isAccountSignedIn(session), false);
    assert.equal(session.email, '');
    assert.equal(session.nickname, '');
});

test('saving a profile for another account is ignored', () => {
    const zotero = signedInPrefs();
    saveAccountSession(zotero, {
        email: 'other@example.com',
        nickname: 'other',
        accessToken: 'access-o',
        refreshToken: 'refresh-o',
        accessExpiresAt: 9_000,
    });

    const saved = saveAccountProfile(
        zotero,
        { email: 'user@example.com', nickname: 'new-name' },
        { expectedEmail: 'USER@example.com' }
    );

    assert.equal(saved, false);
    assert.equal(getAccountSession(zotero).nickname, 'other');
    assert.equal(getAccountSession(zotero).refreshToken, 'refresh-o');
});

test('saving a profile keeps stored fields the response omits', () => {
    const zotero = signedInPrefs();

    assert.equal(saveAccountProfile(zotero, { nickname: '' }), true);

    const session = getAccountSession(zotero);
    assert.equal(session.email, 'user@example.com');
    assert.equal(session.nickname, 'old-name');
});
