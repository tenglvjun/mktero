import test from 'node:test';
import assert from 'node:assert/strict';
import {
    loginMkteroAccount,
    logoutMkteroAccount,
    refreshMkteroAccount,
    registerMkteroAccount,
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
                user: { email: 'user@example.com' },
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
        accessToken: 'access',
        refreshToken: 'refresh',
        accessExpiresAt: 1_000 + 3_600_000,
    });
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
