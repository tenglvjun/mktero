import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import {
    ACCOUNT_REFRESH_LOCK_PREF,
    ensureAccountAccessToken,
    MkteroSignInRequiredError,
    REFRESH_LOCK_TTL_MS,
    REFRESH_REQUEST_TIMEOUT_MS,
} from '../src/account/account-session.js';
import {
    clearAccountSession,
    getAccountSession,
    saveAccountSession,
    setAccountApiBase,
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

test('does not clear a newer account when an old refresh reports disabled', async () => {
    const zotero = signedInZotero();
    await assert.rejects(
        ensureAccountAccessToken(zotero, {
            now: () => NOW,
            fetchImpl: async () => {
                saveAccountSession(zotero, {
                    email: 'other@example.com',
                    nickname: 'other-reader',
                    accessToken: 'other-access',
                    refreshToken: 'other-refresh',
                    accessExpiresAt: NOW + 60 * 60 * 1000,
                });
                return jsonResponse(403, {
                    error: { code: 'account_disabled' },
                });
            },
        }),
        error => error.code === 'MKTERO_SIGN_IN_REQUIRED'
    );
    assert.equal(getAccountSession(zotero).refreshToken, 'other-refresh');
    assert.equal(getAccountSession(zotero).accessToken, 'other-access');
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

test('does not restore a session when a refresh response arrives after logout', async () => {
    const zotero = signedInZotero();
    let resolveResponse;
    let markStarted;
    const started = new Promise(resolve => {
        markStarted = resolve;
    });
    const pending = ensureAccountAccessToken(zotero, {
        now: () => NOW,
        fetchImpl: async () => {
            markStarted();
            return new Promise(resolve => {
                resolveResponse = resolve;
            });
        },
    });
    await started;

    clearAccountSession(zotero);
    resolveResponse(refreshedSessionResponse());

    await assert.rejects(
        pending,
        error => error.code === 'MKTERO_SIGN_IN_REQUIRED'
    );
    const session = getAccountSession(zotero);
    assert.equal(session.refreshToken, '');
    assert.equal(session.accessToken, '');
    assert.equal(session.email, '');
    assert.equal(zotero.Prefs.dump()[ACCOUNT_REFRESH_LOCK_PREF], '');
});

test('does not overwrite a different account when a refresh response arrives late', async () => {
    const zotero = signedInZotero();
    let resolveResponse;
    let markStarted;
    const started = new Promise(resolve => {
        markStarted = resolve;
    });
    const pending = ensureAccountAccessToken(zotero, {
        now: () => NOW,
        fetchImpl: async () => {
            markStarted();
            return new Promise(resolve => {
                resolveResponse = resolve;
            });
        },
    });
    await started;

    saveAccountSession(zotero, {
        email: 'other@example.com',
        nickname: 'other-reader',
        accessToken: 'other-access',
        refreshToken: 'other-refresh',
        accessExpiresAt: NOW + 60 * 60 * 1000,
    });
    resolveResponse(refreshedSessionResponse());

    await assert.rejects(
        pending,
        error => error.code === 'MKTERO_SIGN_IN_REQUIRED'
    );
    assert.deepEqual(getAccountSession(zotero), {
        email: 'other@example.com',
        nickname: 'other-reader',
        accessToken: 'other-access',
        refreshToken: 'other-refresh',
        accessExpiresAt: NOW + 60 * 60 * 1000,
    });
});

test('adopts a valid same-account session that another bundle saved during refresh', async () => {
    const zotero = signedInZotero();
    let resolveResponse;
    let markStarted;
    const started = new Promise(resolve => {
        markStarted = resolve;
    });
    const pending = ensureAccountAccessToken(zotero, {
        now: () => NOW,
        fetchImpl: async () => {
            markStarted();
            return new Promise(resolve => {
                resolveResponse = resolve;
            });
        },
    });
    await started;

    saveAccountSession(zotero, {
        email: 'USER@example.com',
        nickname: 'paper-reader',
        accessToken: 'peer-access',
        refreshToken: 'peer-refresh',
        accessExpiresAt: NOW + 60 * 60 * 1000,
    });
    resolveResponse(refreshedSessionResponse());

    assert.equal(await pending, 'peer-access');
    assert.equal(getAccountSession(zotero).refreshToken, 'peer-refresh');
    assert.equal(getAccountSession(zotero).accessToken, 'peer-access');
});

test('does not adopt an old-host refresh after switching API endpoints', async () => {
    const zotero = signedInZotero();
    let resolveResponse;
    let markStarted;
    const started = new Promise(resolve => {
        markStarted = resolve;
    });
    const pending = ensureAccountAccessToken(zotero, {
        now: () => NOW,
        fetchImpl: async () => {
            markStarted();
            return new Promise(resolve => {
                resolveResponse = resolve;
            });
        },
    });
    await started;

    setAccountApiBase(zotero, 'http://127.0.0.1:9090');
    saveAccountSession(zotero, {
        email: 'user@example.com',
        nickname: 'new-host-session',
        accessToken: 'new-host-access',
        refreshToken: 'new-host-refresh',
        accessExpiresAt: NOW + 60 * 60 * 1000,
    });
    resolveResponse(refreshedSessionResponse());

    await assert.rejects(
        pending,
        error => error.code === 'MKTERO_SIGN_IN_REQUIRED'
    );
    const session = getAccountSession(zotero);
    assert.equal(session.refreshToken, 'new-host-refresh');
    assert.equal(session.accessToken, 'new-host-access');
    assert.equal(session.nickname, 'new-host-session');
});

test('replays the same persisted refresh attempt after a rotated response times out', async t => {
    t.after(() => mock.timers.reset());
    mock.timers.enable({ apis: ['setTimeout'] });
    const zotero = signedInZotero();
    const requests = [];
    let rotation = null;
    const fetchImpl = async (_url, options) => {
        const body = JSON.parse(options.body);
        requests.push(body);
        if (!rotation) {
            rotation = {
                previousToken: body.refresh_token,
                attemptID: body.refresh_attempt_id,
            };
            // The service commits the rotation but the first HTTP response is lost.
            return new Promise(() => {});
        }
        if (body.refresh_token === rotation.previousToken
            && body.refresh_attempt_id === rotation.attemptID) {
            return refreshedSessionResponse();
        }
        return jsonResponse(401, { error: { code: 'invalid_token' } });
    };

    const pending = ensureAccountAccessToken(zotero, {
        now: () => NOW,
        secureRandom: { randomUUID: () => '01234567-89ab-cdef-0123-456789abcdef' },
        fetchImpl,
    });
    for (let attempt = 0; attempt < 10 && requests.length === 0; attempt += 1) {
        await Promise.resolve();
    }
    assert.equal(requests.length, 1);
    mock.timers.tick(REFRESH_REQUEST_TIMEOUT_MS);

    assert.equal(await pending, 'access-new');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].refresh_attempt_id, '0123456789abcdef0123456789abcdef');
    assert.equal(requests[1].refresh_attempt_id, requests[0].refresh_attempt_id);
    assert.equal(requests[0].refresh_token, 'refresh-old');
    assert.equal(requests[1].refresh_token, 'refresh-old');
    assert.equal(getAccountSession(zotero).refreshToken, 'refresh-new');
    assert.equal(getAccountSession(zotero).accessToken, 'access-new');
    assert.equal(zotero.Prefs.dump()['extensions.mktero.accountRefreshAttemptID'], '');
});

test('a hung refresh times out before the lock expires and keeps the session', async t => {
    t.after(() => mock.timers.reset());
    mock.timers.enable({ apis: ['setTimeout'] });
    const zotero = signedInZotero();
    let calls = 0;
    let markStarted;
    const started = new Promise(resolve => {
        markStarted = resolve;
    });
    const pending = ensureAccountAccessToken(zotero, {
        now: () => NOW,
        fetchImpl: () => {
            calls += 1;
            markStarted();
            return new Promise(() => {});
        },
    });
    const outcome = assert.rejects(
        pending,
        error => error.code === 'MKTERO_NETWORK_ERROR'
    );
    // The request has started only after the shared lock is held.
    await started;
    assert.equal(calls, 1);
    assert.notEqual(zotero.Prefs.dump()[ACCOUNT_REFRESH_LOCK_PREF], '');

    mock.timers.tick(REFRESH_REQUEST_TIMEOUT_MS);
    // Let the first timeout's rejection chain schedule its one retry before
    // advancing the fake clock again.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2);
    mock.timers.tick(REFRESH_REQUEST_TIMEOUT_MS);
    await outcome;

    // Both the original attempt and its recovery retry give up before the lock expires.
    assert.ok(REFRESH_REQUEST_TIMEOUT_MS * 2 < REFRESH_LOCK_TTL_MS);
    const session = getAccountSession(zotero);
    assert.equal(session.refreshToken, 'refresh-old');
    assert.equal(session.accessToken, 'access-old');
    assert.equal(zotero.Prefs.dump()[ACCOUNT_REFRESH_LOCK_PREF], '');
});
