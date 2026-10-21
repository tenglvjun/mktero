import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

// firefoxPrefs models Zotero.Prefs over Firefox's preference service. A pref
// keeps the type of its prefs.js default, or of the first value written, and
// an integer pref holds a signed 32-bit value: XPConnect converts the number
// with ToInt32 before setIntPref, so larger numbers wrap.
async function firefoxPrefs(userValues = {}) {
    const source = await readFile(new URL('../prefs.js', import.meta.url), 'utf8');
    const defaults = new Map();
    for (const [, key, raw] of source.matchAll(/^pref\("([^"]+)",\s*(.+)\);$/gmu)) {
        defaults.set(key, JSON.parse(raw));
    }
    const user = new Map(Object.entries(userValues));
    const read = key => (user.has(key) ? user.get(key) : defaults.get(key));
    const typeOf = value => (typeof value === 'number' ? 'int' : typeof value);
    return {
        get(key) {
            return read(key);
        },
        set(key, value) {
            const current = read(key);
            const type = typeOf(current === undefined ? value : current);
            if (type === 'int') user.set(key, Number(value) | 0);
            else if (type === 'boolean') user.set(key, Boolean(value));
            else user.set(key, String(value));
        },
        clear(key) {
            user.delete(key);
        },
        hasUserValue(key) {
            return user.has(key);
        },
    };
}

const LEGACY_EXPIRES_AT_PREF = 'extensions.mktero.accountAccessExpiresAt';

test('keeps a real access-token expiry exactly through Zotero preferences', async () => {
    const zotero = { Prefs: await firefoxPrefs() };
    // A login at 01:29 UTC stores an expiry one hour later. Millisecond
    // timestamps are far larger than a signed 32-bit integer.
    const now = Date.UTC(2026, 9, 21, 1, 29, 17, 224);
    const expiresAt = now + 60 * 60 * 1000;
    saveAccountSession(zotero, {
        email: 'user@example.com',
        accessToken: 'access',
        refreshToken: 'refresh',
        accessExpiresAt: expiresAt,
    });

    const session = getAccountSession(zotero);
    assert.equal(session.accessExpiresAt, expiresAt);
    assert.equal(accessTokenNeedsRefresh(session, now), false);
    assert.equal(
        accessTokenNeedsRefresh(session, expiresAt - ACCOUNT_REFRESH_MARGIN_MS),
        true
    );
});

test('ignores and clears the wrapped expiry an earlier version stored', async () => {
    const prefs = await firefoxPrefs({
        // 2026-10-21T02:29:17.224Z after the 32-bit wrap.
        [LEGACY_EXPIRES_AT_PREF]: 1_548_394_792,
        'extensions.mktero.accountEmail': 'user@example.com',
        'extensions.mktero.accountAccessToken': 'access-1',
        'extensions.mktero.accountRefreshToken': 'refresh-1',
    });
    const zotero = { Prefs: prefs };
    const now = Date.UTC(2026, 9, 21, 1, 40);

    // No usable expiry yet, so the first request refreshes once.
    assert.equal(getAccountSession(zotero).accessExpiresAt, 0);
    assert.equal(accessTokenNeedsRefresh(getAccountSession(zotero), now), true);

    saveAccountSession(zotero, {
        email: 'user@example.com',
        accessToken: 'access-2',
        refreshToken: 'refresh-2',
        accessExpiresAt: now + 60 * 60 * 1000,
    });
    assert.equal(prefs.hasUserValue(LEGACY_EXPIRES_AT_PREF), false);
    assert.equal(accessTokenNeedsRefresh(getAccountSession(zotero), now), false);

    prefs.set(LEGACY_EXPIRES_AT_PREF, 1_548_394_792);
    clearAccountSession(zotero);
    assert.equal(prefs.hasUserValue(LEGACY_EXPIRES_AT_PREF), false);
    assert.equal(getAccountSession(zotero).accessExpiresAt, 0);
    assert.equal(isAccountSignedIn(getAccountSession(zotero)), false);
});

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
