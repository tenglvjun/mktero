import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ACCOUNT_REFRESH_LOCK_PREF,
    ensureAccountAccessToken,
    MkteroSignInRequiredError,
} from '../src/account/account-session.js';
import {
    getAccountSession,
    saveAccountSession,
} from '../src/config/account-preferences.js';

const NOW = 1_700_000_000_000;

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

function signedInZotero({
    accessExpiresAt = NOW - 1000,
    refreshToken = 'refresh-old',
    accessToken = 'access-old',
} = {}) {
    const zotero = { Prefs: memoryPrefs() };
    saveAccountSession(zotero, {
        email: 'user@example.com',
        nickname: 'paper-reader',
        accessToken,
        refreshToken,
        accessExpiresAt,
    });
    return zotero;
}

function jsonResponse(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
            return body;
        },
    };
}

function refreshedSessionResponse(extra = {}) {
    return jsonResponse(200, {
        access_token: 'access-new',
        refresh_token: 'refresh-new',
        expires_in: 3600,
        ...extra,
    });
}

test('returns the stored access token without refreshing when it is still valid', async () => {
    let calls = 0;
    const zotero = signedInZotero({ accessExpiresAt: NOW + 60 * 60 * 1000 });
    const token = await ensureAccountAccessToken(zotero, {
        now: () => NOW,
        fetchImpl: async () => {
            calls += 1;
            return refreshedSessionResponse();
        },
    });
    assert.equal(token, 'access-old');
    assert.equal(calls, 0);
    assert.equal(getAccountSession(zotero).refreshToken, 'refresh-old');
});

test('refreshes once when several conversions need a new access token', async () => {
    let calls = 0;
    let release;
    const gate = new Promise(resolve => {
        release = resolve;
    });
    const zotero = signedInZotero();
    const fetchImpl = async () => {
        calls += 1;
        await gate;
        return refreshedSessionResponse();
    };
    const first = ensureAccountAccessToken(zotero, { now: () => NOW, fetchImpl });
    const second = ensureAccountAccessToken(zotero, { now: () => NOW, fetchImpl });
    const third = ensureAccountAccessToken(zotero, {
        now: () => NOW,
        fetchImpl,
        forceRefresh: true,
    });
    release();
    const tokens = await Promise.all([first, second, third]);
    assert.deepEqual(tokens, ['access-new', 'access-new', 'access-new']);
    assert.equal(calls, 1);
    const session = getAccountSession(zotero);
    assert.equal(session.refreshToken, 'refresh-new');
    assert.equal(session.email, 'user@example.com');
    assert.equal(session.nickname, 'paper-reader');
    assert.equal(zotero.Prefs.dump()[ACCOUNT_REFRESH_LOCK_PREF], '');
});

test('keeps a session another refresh rotated before this one was rejected', async () => {
    const zotero = signedInZotero();
    const token = await ensureAccountAccessToken(zotero, {
        now: () => NOW,
        fetchImpl: async () => {
            saveAccountSession(zotero, {
                email: 'user@example.com',
                nickname: 'paper-reader',
                accessToken: 'access-peer',
                refreshToken: 'refresh-peer',
                accessExpiresAt: NOW + 60 * 60 * 1000,
            });
            return jsonResponse(401, { error: { code: 'invalid_token' } });
        },
    });
    assert.equal(token, 'access-peer');
    const session = getAccountSession(zotero);
    assert.equal(session.refreshToken, 'refresh-peer');
    assert.equal(session.accessToken, 'access-peer');
    assert.equal(session.email, 'user@example.com');
});

test('adopts a session published while another bundle holds the refresh lock', async () => {
    const zotero = signedInZotero();
    zotero.Prefs.set(
        ACCOUNT_REFRESH_LOCK_PREF,
        JSON.stringify({ id: 'peer', until: Date.now() + 10_000 }),
        true
    );
    let calls = 0;
    const token = await ensureAccountAccessToken(zotero, {
        now: () => NOW,
        fetchImpl: async () => {
            calls += 1;
            return refreshedSessionResponse();
        },
        sleep: async () => {
            saveAccountSession(zotero, {
                email: 'user@example.com',
                nickname: 'paper-reader',
                accessToken: 'access-peer',
                refreshToken: 'refresh-peer',
                accessExpiresAt: NOW + 60 * 60 * 1000,
            });
            zotero.Prefs.set(ACCOUNT_REFRESH_LOCK_PREF, '', true);
        },
    });
    assert.equal(token, 'access-peer');
    assert.equal(calls, 0);
    assert.equal(getAccountSession(zotero).refreshToken, 'refresh-peer');
});

test('keeps the stored session when a refresh fails transiently', async () => {
    const zotero = signedInZotero();
    await assert.rejects(
        ensureAccountAccessToken(zotero, {
            now: () => NOW,
            fetchImpl: async () => {
                throw new Error('offline');
            },
        }),
        error => error.code === 'MKTERO_NETWORK_ERROR'
    );
    const session = getAccountSession(zotero);
    assert.equal(session.refreshToken, 'refresh-old');
    assert.equal(session.accessToken, 'access-old');
    assert.equal(session.email, 'user@example.com');
    assert.equal(zotero.Prefs.dump()[ACCOUNT_REFRESH_LOCK_PREF], '');
});

test('clears the session only when the refresh token itself is rejected', async () => {
    const zotero = signedInZotero();
    await assert.rejects(
        ensureAccountAccessToken(zotero, {
            now: () => NOW,
            fetchImpl: async () => jsonResponse(401, {
                error: { code: 'invalid_token' },
            }),
        }),
        error => error instanceof MkteroSignInRequiredError
    );
    const session = getAccountSession(zotero);
    assert.equal(session.refreshToken, '');
    assert.equal(session.accessToken, '');
    assert.equal(session.email, '');
    assert.equal(zotero.Prefs.dump()[ACCOUNT_REFRESH_LOCK_PREF], '');
});

test('clears the session when the account is disabled', async () => {
    const zotero = signedInZotero();
    await assert.rejects(
        ensureAccountAccessToken(zotero, {
            now: () => NOW,
            fetchImpl: async () => jsonResponse(403, {
                error: { code: 'account_disabled' },
            }),
        }),
        error => error.code === 'MKTERO_ACCOUNT_DISABLED'
    );
    assert.equal(getAccountSession(zotero).refreshToken, '');
});

test('forces one refresh when the access token was rejected before it expired', async () => {
    let calls = 0;
    const zotero = signedInZotero({ accessExpiresAt: NOW + 60 * 60 * 1000 });
    const token = await ensureAccountAccessToken(zotero, {
        forceRefresh: true,
        now: () => NOW,
        fetchImpl: async () => {
            calls += 1;
            return refreshedSessionResponse();
        },
    });
    assert.equal(calls, 1);
    assert.equal(token, 'access-new');
});
