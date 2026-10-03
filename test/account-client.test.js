import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getMkteroAccount,
    getMkteroConversionStats,
    loginMkteroAccount,
    logoutMkteroAccount,
    refreshMkteroAccount,
    registerMkteroAccount,
    sendSignupCode,
    updateMkteroNickname,
} from '../src/account/account-client.js';

function jsonResponse(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
            return body;
        },
    };
}

test('login stores the issued token pair without keeping the password', async () => {
    const calls = [];
    const session = await loginMkteroAccount({
        apiBase: 'http://127.0.0.1:8080/',
        email: 'user@example.com',
        password: 'password123',
        now: () => 1_000,
        fetchImpl: async (url, options) => {
            calls.push({ url, body: JSON.parse(options.body) });
            return jsonResponse(200, {
                user: { email: 'user@example.com', nickname: 'user_a3f9k2' },
                access_token: 'access',
                refresh_token: 'refresh',
                expires_in: 3600,
            });
        },
    });
    assert.equal(calls[0].url, 'http://127.0.0.1:8080/api/v1/auth/login');
    assert.equal(calls[0].body.password, 'password123');
    assert.deepEqual(session, {
        email: 'user@example.com',
        nickname: 'user_a3f9k2',
        accessToken: 'access',
        refreshToken: 'refresh',
        accessExpiresAt: 1_000 + 3_600_000,
    });
});

test('sends an optional nickname on registration only when provided', async () => {
    const bodies = [];
    const fetchImpl = async (url, options) => {
        bodies.push(JSON.parse(options.body));
        return jsonResponse(201, {
            user: { email: 'user@example.com', nickname: 'paper-reader' },
            access_token: 'access',
            refresh_token: 'refresh',
            expires_in: 3600,
        });
    };

    await registerMkteroAccount({
        apiBase: 'http://127.0.0.1:8080',
        email: 'user@example.com',
        password: 'password123',
        code: '123456',
        nickname: '  paper-reader  ',
        fetchImpl,
    });
    assert.equal(bodies[0].nickname, 'paper-reader');

    await registerMkteroAccount({
        apiBase: 'http://127.0.0.1:8080',
        email: 'user@example.com',
        password: 'password123',
        code: '123456',
        fetchImpl,
    });
    assert.equal('nickname' in bodies[1], false);
});

test('carries the server-assigned nickname into the session', async () => {
    const session = await loginMkteroAccount({
        apiBase: 'http://127.0.0.1:8080',
        email: 'user@example.com',
        password: 'password123',
        now: () => 0,
        fetchImpl: async () => jsonResponse(200, {
            user: { email: 'user@example.com', nickname: 'user_a3f9k2' },
            access_token: 'access',
            refresh_token: 'refresh',
            expires_in: 3600,
        }),
    });
    assert.equal(session.nickname, 'user_a3f9k2');
});

test('registration uses the same token response as login', async () => {
    const session = await registerMkteroAccount({
        apiBase: 'http://127.0.0.1:8080',
        email: 'user@example.com',
        password: 'password123',
        code: '123456',
        now: () => 0,
        fetchImpl: async (url, options) => {
            assert.equal(url, 'http://127.0.0.1:8080/api/v1/auth/register');
            assert.equal(JSON.parse(options.body).code, '123456');
            assert.equal(JSON.parse(options.body).email, 'user@example.com');
            return jsonResponse(201, {
                user: { email: 'user@example.com' },
                access_token: 'access',
                refresh_token: 'refresh',
                expires_in: 3600,
            });
        },
    });
    assert.equal(session.accessToken, 'access');
    const pending = await registerMkteroAccount({
        apiBase: 'http://127.0.0.1:8080',
        email: 'new@example.com',
        password: 'password123',
        fetchImpl: async () => jsonResponse(202, { status: 'verification_required' }),
    });
    assert.equal(pending.verificationRequired, true);
    await assert.rejects(
        registerMkteroAccount({
            apiBase: 'http://127.0.0.1:8080',
            email: 'user@example.com',
            password: 'password123',
            fetchImpl: async () => jsonResponse(409, {
                error: { code: 'email_exists', message: 'secret' },
            }),
        }),
        error => error.code === 'email_exists' && !error.message.includes('secret')
    );
});

test('refresh and logout use the refresh token and do not echo secrets in errors', async () => {
    const refreshed = await refreshMkteroAccount({
        apiBase: 'http://127.0.0.1:8080',
        refreshToken: 'old-refresh',
        now: () => 0,
        fetchImpl: async () => jsonResponse(200, {
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 3600,
        }),
    });
    assert.equal(refreshed.refreshToken, 'new-refresh');
    await logoutMkteroAccount({
        apiBase: 'http://127.0.0.1:8080',
        refreshToken: 'new-refresh',
        fetchImpl: async () => jsonResponse(204, null),
    });
    await assert.rejects(
        loginMkteroAccount({
            apiBase: 'http://127.0.0.1:8080',
            email: 'user@example.com',
            password: 'password123',
            fetchImpl: async () => jsonResponse(401, {
                error: { code: 'invalid_credentials', message: 'secret' },
            }),
        }),
        error => error.code === 'invalid_credentials'
            && !error.message.includes('secret')
    );
});

test('forwards the interface language on the signup-code request', async () => {
    const bodies = [];
    const fetchImpl = async (url, options) => {
        bodies.push({ url, body: JSON.parse(options.body) });
        return jsonResponse(202, { status: 'code_sent' });
    };

    await sendSignupCode({
        apiBase: 'http://127.0.0.1:8080',
        email: 'user@example.com',
        locale: 'zh-TW',
        fetchImpl,
    });
    assert.equal(bodies[0].url, 'http://127.0.0.1:8080/api/v1/auth/verification-code');
    assert.equal(bodies[0].body.locale, 'zh-TW');

    // An empty language is omitted so the server can pick its own fallback.
    await sendSignupCode({
        apiBase: 'http://127.0.0.1:8080',
        email: 'user@example.com',
        locale: '   ',
        fetchImpl,
    });
    assert.equal('locale' in bodies[1].body, false);
});

test('forwards the interface language on registration', async () => {
    const bodies = [];
    const fetchImpl = async (url, options) => {
        bodies.push(JSON.parse(options.body));
        return jsonResponse(201, {
            user: { email: 'user@example.com', nickname: 'user_a3f9k2' },
            access_token: 'access',
            refresh_token: 'refresh',
            expires_in: 3600,
        });
    };

    await registerMkteroAccount({
        apiBase: 'http://127.0.0.1:8080',
        email: 'user@example.com',
        password: 'password123',
        code: '123456',
        locale: 'ja-JP',
        fetchImpl,
    });
    assert.equal(bodies[0].locale, 'ja-JP');

    await registerMkteroAccount({
        apiBase: 'http://127.0.0.1:8080',
        email: 'user@example.com',
        password: 'password123',
        code: '123456',
        fetchImpl,
    });
    assert.equal('locale' in bodies[1], false);
});

test('updates the display nickname with the access token', async () => {
    const calls = [];
    const result = await updateMkteroNickname({
        apiBase: 'http://127.0.0.1:8080',
        accessToken: 'access-token',
        nickname: '  paper-reader  ',
        fetchImpl: async (url, options) => {
            calls.push({ url, method: options.method, headers: options.headers, body: JSON.parse(options.body) });
            return jsonResponse(200, { id: 1, email: 'user@example.com', nickname: 'paper-reader' });
        },
    });

    assert.equal(calls[0].url, 'http://127.0.0.1:8080/api/v1/me');
    assert.equal(calls[0].method, 'PATCH');
    assert.equal(calls[0].headers.Authorization, 'Bearer access-token');
    assert.equal(calls[0].body.nickname, 'paper-reader');
    assert.deepEqual(result, { nickname: 'paper-reader' });
});

test('surfaces the server error code when a nickname update fails', async () => {
    await assert.rejects(
        updateMkteroNickname({
            apiBase: 'http://127.0.0.1:8080',
            accessToken: 'access-token',
            nickname: 'reader',
            fetchImpl: async () => jsonResponse(401, { error: { code: 'invalid_token' } }),
        }),
        error => error.code === 'invalid_token'
    );
});

test('reads the profile with a GET that carries no body', async () => {
    const calls = [];
    const profile = await getMkteroAccount({
        apiBase: 'http://127.0.0.1:8080',
        accessToken: 'access-token',
        fetchImpl: async (url, options) => {
            calls.push({ url, method: options.method, headers: options.headers, body: options.body });
            return jsonResponse(200, {
                id: 1,
                email: 'user@example.com',
                nickname: 'paper-reader',
                created_at: '2026-09-01T00:00:00Z',
            });
        },
    });

    assert.equal(calls[0].url, 'http://127.0.0.1:8080/api/v1/me');
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].headers.Authorization, 'Bearer access-token');
    // A GET must not serialize a payload.
    assert.equal(calls[0].body, undefined);
    assert.deepEqual(profile, {
        email: 'user@example.com',
        nickname: 'paper-reader',
        createdAt: '2026-09-01T00:00:00Z',
    });
});

test('tolerates a profile response with missing fields', async () => {
    const profile = await getMkteroAccount({
        apiBase: 'http://127.0.0.1:8080',
        accessToken: 'access-token',
        fetchImpl: async () => jsonResponse(200, {}),
    });
    assert.deepEqual(profile, { email: '', nickname: '', createdAt: '' });
});

test('requests the conversion stats window and normalizes the days', async () => {
    const calls = [];
    const stats = await getMkteroConversionStats({
        apiBase: 'http://127.0.0.1:8080/',
        accessToken: 'access-token',
        days: 371,
        fetchImpl: async (url, options) => {
            calls.push({ url, method: options.method, body: options.body });
            return jsonResponse(200, {
                total: 4,
                current_streak: 2,
                longest_streak: 5,
                days: [
                    { date: '2026-09-27', count: 0 },
                    { date: '2026-09-28', count: 1 },
                    { date: '2026-09-29', count: -2 },
                    { date: '2026-09-30', count: 3 },
                    { count: 9 },
                    null,
                ],
            });
        },
    });

    assert.equal(calls[0].url, 'http://127.0.0.1:8080/api/v1/me/stats?days=371');
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].body, undefined);
    assert.equal(stats.total, 4);
    assert.equal(stats.currentStreak, 2);
    assert.equal(stats.longestStreak, 5);
    // Entries without a date are dropped and negative counts clamp to zero.
    assert.deepEqual(stats.days, [
        { date: '2026-09-27', count: 0 },
        { date: '2026-09-28', count: 1 },
        { date: '2026-09-29', count: 0 },
        { date: '2026-09-30', count: 3 },
    ]);
});

test('omits the stats window when no day count is given', async () => {
    const urls = [];
    const fetchImpl = async url => {
        urls.push(String(url));
        return jsonResponse(200, { total: 0, days: [] });
    };
    await getMkteroConversionStats({
        apiBase: 'http://127.0.0.1:8080',
        accessToken: 'access-token',
        fetchImpl,
    });
    await getMkteroConversionStats({
        apiBase: 'http://127.0.0.1:8080',
        accessToken: 'access-token',
        days: 0,
        fetchImpl,
    });
    await getMkteroConversionStats({
        apiBase: 'http://127.0.0.1:8080',
        accessToken: 'access-token',
        days: -5,
        fetchImpl,
    });
    assert.deepEqual(urls, [
        'http://127.0.0.1:8080/api/v1/me/stats',
        'http://127.0.0.1:8080/api/v1/me/stats',
        'http://127.0.0.1:8080/api/v1/me/stats',
    ]);
});

test('defaults an empty stats response to zeros', async () => {
    const stats = await getMkteroConversionStats({
        apiBase: 'http://127.0.0.1:8080',
        accessToken: 'access-token',
        fetchImpl: async () => jsonResponse(200, {}),
    });
    assert.deepEqual(stats, {
        total: 0,
        currentStreak: 0,
        longestStreak: 0,
        days: [],
    });
});

test('surfaces the server error code when the stats request fails', async () => {
    await assert.rejects(
        getMkteroConversionStats({
            apiBase: 'http://127.0.0.1:8080',
            accessToken: 'access-token',
            fetchImpl: async () => jsonResponse(401, { error: { code: 'invalid_token' } }),
        }),
        error => error.code === 'invalid_token'
    );
});

test('reports a network failure as a network error', async () => {
    await assert.rejects(
        getMkteroConversionStats({
            apiBase: 'http://127.0.0.1:8080',
            accessToken: 'access-token',
            fetchImpl: async () => {
                throw new Error('offline');
            },
        }),
        error => error.code === 'network'
    );
});
