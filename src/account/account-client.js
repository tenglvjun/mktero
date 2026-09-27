const JSON_HEADERS = Object.freeze({
    Accept: 'application/json',
    'Content-Type': 'application/json',
});

export async function sendSignupCode({
    apiBase,
    email,
    fetchImpl = globalThis.fetch,
} = {}) {
    await postJSON(fetchImpl, apiBase, '/api/v1/auth/verification-code', { email });
    return { codeSent: true };
}

export async function registerMkteroAccount({
    apiBase,
    email,
    password,
    code,
    fetchImpl = globalThis.fetch,
    now = Date.now,
} = {}) {
    const body = await postJSON(fetchImpl, apiBase, '/api/v1/auth/register', {
        email,
        password,
        code,
    });
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

async function postJSON(fetchImpl, apiBase, path, payload) {
    if (typeof fetchImpl !== 'function') {
        throw accountError('network');
    }
    let response;
    try {
        response = await fetchImpl(joinURL(apiBase, path), {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify(payload),
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
    if (!accessToken || !refreshToken) {
        throw accountError('invalid_response');
    }
    const expiresIn = Number(body?.expires_in);
    const lifetimeMs = Number.isFinite(expiresIn) && expiresIn > 0
        ? expiresIn * 1000
        : 60 * 60 * 1000;
    return {
        email,
        accessToken,
        refreshToken,
        accessExpiresAt: now() + lifetimeMs,
    };
}

function joinURL(apiBase, path) {
    return `${String(apiBase || '').replace(/\/+$/, '')}${path}`;
}

function accountError(code) {
    const error = new Error('Mktero account request failed');
    error.code = code || 'request_failed';
    return error;
}
