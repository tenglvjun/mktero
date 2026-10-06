const JSON_HEADERS = Object.freeze({
    Accept: 'application/json',
    'Content-Type': 'application/json',
});

export async function sendSignupCode({
    apiBase,
    email,
    locale = '',
    fetchImpl = globalThis.fetch,
} = {}) {
    await postJSON(fetchImpl, apiBase, '/api/v1/auth/verification-code', withLocale({ email }, locale));
    return { codeSent: true };
}

// withLocale adds the interface language so the server can localize the email.
// An empty value is omitted and the server falls back to English.
function withLocale(payload, locale) {
    const tag = String(locale || '').trim();
    return tag ? { ...payload, locale: tag } : payload;
}

export async function registerMkteroAccount({
    apiBase,
    email,
    password,
    code,
    nickname,
    locale = '',
    fetchImpl = globalThis.fetch,
    now = Date.now,
} = {}) {
    const trimmedNickname = String(nickname || '').trim();
    const body = await postJSON(fetchImpl, apiBase, '/api/v1/auth/register', withLocale({
        email,
        password,
        code,
        // The server generates a nickname when this is absent.
        ...(trimmedNickname ? { nickname: trimmedNickname } : {}),
    }, locale));
    if (body?.status === 'verification_required') {
        return { verificationRequired: true, email: String(email || '').trim() };
    }
    return sessionFromBody(body, now);
}

export async function loginMkteroAccount({
    apiBase,
    email,
    password,
    fetchImpl = globalThis.fetch,
    now = Date.now,
} = {}) {
    const body = await postJSON(fetchImpl, apiBase, '/api/v1/auth/login', {
        email,
        password,
    });
    return sessionFromBody(body, now);
}

export async function refreshMkteroAccount({
    apiBase,
    refreshToken,
    fetchImpl = globalThis.fetch,
    now = Date.now,
} = {}) {
    const body = await postJSON(fetchImpl, apiBase, '/api/v1/auth/refresh', {
        refresh_token: refreshToken,
    });
    return sessionFromBody(body, now);
}

export async function requestPasswordReset({
    apiBase,
    email,
    fetchImpl = globalThis.fetch,
} = {}) {
    await postJSON(fetchImpl, apiBase, '/api/v1/auth/forgot-password', { email });
    return { resetRequested: true };
}

export async function logoutMkteroAccount({
    apiBase,
    refreshToken,
    fetchImpl = globalThis.fetch,
} = {}) {
    if (!refreshToken) return;
    await postJSON(fetchImpl, apiBase, '/api/v1/auth/logout', {
        refresh_token: refreshToken,
    });
}

// getMkteroAccount reads the signed-in profile, including the registration date.
export async function getMkteroAccount({
    apiBase,
    accessToken,
    fetchImpl = globalThis.fetch,
} = {}) {
    const body = await requestJSON(fetchImpl, apiBase, '/api/v1/me', {
        method: 'GET',
        token: accessToken,
    });
    return {
        email: String(body?.email || '').trim(),
        nickname: String(body?.nickname || '').trim(),
        createdAt: String(body?.created_at || '').trim(),
    };
}

// getMkteroConversionStats reads the three conversion counters. Only successful
// conversions are counted. Month and today are the current UTC month and day.
export async function getMkteroConversionStats({
    apiBase,
    accessToken,
    fetchImpl = globalThis.fetch,
} = {}) {
    const body = await requestJSON(
        fetchImpl,
        apiBase,
        '/api/v1/me/stats',
        { method: 'GET', token: accessToken }
    );
    return {
        total: toCount(body?.total),
        month: toCount(body?.month),
        today: toCount(body?.today),
    };
}

// updateMkteroNickname replaces the display nickname of the signed-in account.
export async function updateMkteroNickname({
    apiBase,
    accessToken,
    nickname,
    fetchImpl = globalThis.fetch,
} = {}) {
    const body = await requestJSON(fetchImpl, apiBase, '/api/v1/me', {
        method: 'PATCH',
        token: accessToken,
        payload: { nickname: String(nickname || '').trim() },
    });
    return { nickname: String(body?.nickname || '').trim() };
}

async function postJSON(fetchImpl, apiBase, path, payload) {
    return requestJSON(fetchImpl, apiBase, path, { payload });
}

async function requestJSON(fetchImpl, apiBase, path, {
    method = 'POST',
    payload,
    token = '',
} = {}) {
    if (typeof fetchImpl !== 'function') {
        throw accountError('network');
    }
    const headers = { ...JSON_HEADERS };
    if (token) headers.Authorization = `Bearer ${token}`;
    // A GET carries no body; only the JSON-writing methods serialize a payload.
    const sendsBody = method !== 'GET' && method !== 'HEAD';
    let response;
    try {
        response = await fetchImpl(joinURL(apiBase, path), {
            method,
            headers,
            body: sendsBody ? JSON.stringify(payload ?? {}) : undefined,
        });
    }
    catch {
        throw accountError('network');
    }
    const body = await readBody(response);
    if (!response.ok) {
        throw accountError(body?.error?.code || 'request_failed');
    }
    return body;
}

async function readBody(response) {
    try {
        return await response.json();
    }
    catch {
        return null;
    }
}

function sessionFromBody(body, now) {
    const accessToken = String(body?.access_token || '').trim();
    const refreshToken = String(body?.refresh_token || '').trim();
    const email = String(body?.user?.email || body?.email || '').trim();
    const nickname = String(body?.user?.nickname || '').trim();
    if (!accessToken || !refreshToken) {
        throw accountError('invalid_response');
    }
    const expiresIn = Number(body?.expires_in);
    const lifetimeMs = Number.isFinite(expiresIn) && expiresIn > 0
        ? expiresIn * 1000
        : 60 * 60 * 1000;
    return {
        email,
        nickname,
        accessToken,
        refreshToken,
        accessExpiresAt: now() + lifetimeMs,
    };
}

function toCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function joinURL(apiBase, path) {
    return `${String(apiBase || '').replace(/\/+$/, '')}${path}`;
}

function accountError(code) {
    const error = new Error('Mktero account request failed');
    error.code = code || 'request_failed';
    return error;
}
