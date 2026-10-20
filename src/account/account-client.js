import { mkteroVersion } from '../config/runtime-config.js';
import { createRuntimeAbortController } from '../platform/abort-controller.js';

const JSON_HEADERS = Object.freeze({
    Accept: 'application/json',
    'Content-Type': 'application/json',
    // Operations telemetry for mktero-server: which extension build is calling.
    // Every request in this module goes to the Mktero account API, so the
    // header is attached once here instead of per call. It must never be added
    // to a third-party provider request.
    'X-Mktero-Version': mkteroVersion(),
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

// timeoutMs bounds the request. A hung refresh would otherwise hold the shared
// refresh promise and the prefs lock until the lock expired, which lets a
// second caller present the same refresh token. A timeout is reported as a
// network error, so the stored session is kept.
export async function refreshMkteroAccount({
    apiBase,
    refreshToken,
    refreshAttemptID = '',
    fetchImpl = globalThis.fetch,
    now = Date.now,
    timeoutMs = 0,
} = {}) {
    const body = await requestJSON(fetchImpl, apiBase, '/api/v1/auth/refresh', {
        payload: {
            refresh_token: refreshToken,
            ...(refreshAttemptID ? { refresh_attempt_id: refreshAttemptID } : {}),
        },
        timeoutMs,
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
    timeoutMs = 0,
} = {}) {
    if (typeof fetchImpl !== 'function') {
        throw accountError('network');
    }
    const headers = { ...JSON_HEADERS };
    if (token) headers.Authorization = `Bearer ${token}`;
    // A GET carries no body; only the JSON-writing methods serialize a payload.
    const sendsBody = method !== 'GET' && method !== 'HEAD';
    const init = {
        method,
        headers,
        body: sendsBody ? JSON.stringify(payload ?? {}) : undefined,
    };
    const deadline = timeoutMs > 0 ? startDeadline(timeoutMs) : null;
    if (deadline?.signal) init.signal = deadline.signal;
    let response;
    let body;
    try {
        const exchange = (async () => {
            const received = await fetchImpl(joinURL(apiBase, path), init);
            return { received, parsed: await readBody(received) };
        })();
        // After a timeout wins the race, a late failure here has no consumer.
        exchange.catch(() => {});
        const settled = deadline
            ? await Promise.race([exchange, deadline.expired])
            : await exchange;
        response = settled.received;
        body = settled.parsed;
    }
    catch {
        throw accountError('network');
    }
    finally {
        deadline?.clear();
    }
    if (!response.ok) {
        throw accountError(body?.error?.code || 'request_failed', response.status);
    }
    return body;
}

// startDeadline rejects `expired` after timeoutMs and aborts the request when
// the runtime offers an AbortController. A runtime without one still times out.
function startDeadline(timeoutMs) {
    let controller = null;
    try {
        controller = createRuntimeAbortController();
    }
    catch {
        controller = null;
    }
    let timer = null;
    const expired = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            try {
                controller?.abort();
            }
            catch {
                // The rejection below is what ends the request.
            }
            reject(new Error('Mktero account request timed out'));
        }, timeoutMs);
    });
    // The race below may already have settled; keep a late rejection quiet.
    expired.catch(() => {});
    return {
        signal: controller?.signal,
        expired,
        clear() {
            clearTimeout(timer);
        },
    };
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

function accountError(code, status = 0) {
    const error = new Error('Mktero account request failed');
    error.code = code || 'request_failed';
    // The status is diagnostic only. Callers must judge a session by the
    // server's error code, because a proxy can answer 401 or 403 without an
    // Mktero error body.
    error.status = status;
    return error;
}

// SESSION_INVALID_CODES are the codes the server returns only when the stored
// credentials can never succeed again. Every other failure is transient: a
// network error, a timeout, a 5xx, or a body this client could not parse.
// Callers must keep the session for those so the next attempt retries instead
// of silently signing the user out. The set matches the codes
// mktero-conversion-client.js already treats as session-ending.
const SESSION_INVALID_CODES = Object.freeze(new Set([
    'invalid_token',
    'user_not_found',
    'account_disabled',
]));

// isAccountSessionInvalid reports whether an account request error proves the
// local session is permanently unusable.
export function isAccountSessionInvalid(error) {
    return SESSION_INVALID_CODES.has(String(error?.code || ''));
}
