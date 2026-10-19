import {
    isAccountSessionInvalid,
    refreshMkteroAccount,
} from './account-client.js';
import {
    accessTokenNeedsRefresh,
    clearAccountSession,
    getAccountApiBase,
    getAccountSession,
    saveAccountSession,
} from '../config/account-preferences.js';

export const ACCOUNT_REFRESH_LOCK_PREF = 'extensions.mktero.accountRefreshLock';

const REFRESH_LOCK_TTL_MS = 30 * 1000;
const PEER_POLL_MS = 25;
const MAX_PEER_POLLS = 1200;

// One promise per Zotero runtime. bootstrap.js and preferences.js are separate
// bundles, so this map only collapses callers that share a bundle. The prefs
// lock below covers the other bundle.
const refreshInFlight = new WeakMap();
let refreshLockSerial = 0;

export class MkteroSignInRequiredError extends Error {
    constructor() {
        super('Sign in to Mktero before converting');
        this.name = 'MkteroSignInRequiredError';
        this.code = 'MKTERO_SIGN_IN_REQUIRED';
    }
}

// ensureAccountAccessToken returns a usable access token, refreshing it when
// it is missing, inside the expiry margin, or the caller saw a 401
// (`{ forceRefresh: true }`).
//
// The server rotates the refresh token on every refresh and rejects the old
// one with invalid_token. A second in-flight refresh used to treat that
// rejection as a dead session and delete the token the first refresh had just
// stored, which signed the user out in the middle of a batch. Callers in one
// bundle share a single refresh. A caller in the other bundle waits for the
// prefs lock, then adopts the rotated session instead of clearing it.
export async function ensureAccountAccessToken(zotero, {
    forceRefresh = false,
    fetchImpl,
    now = Date.now,
    sleep = delay,
} = {}) {
    if (!zotero) throw new TypeError('A Zotero runtime is required');
    const clock = typeof now === 'function' ? now : () => now;
    const session = getAccountSession(zotero);
    if (!session.refreshToken) throw new MkteroSignInRequiredError();
    if (forceRefresh !== true && !accessTokenNeedsRefresh(session, clock())) {
        return session.accessToken;
    }
    return joinRefresh(zotero, () => performRefresh(zotero, {
        fetchImpl,
        clock,
        forceRefresh: forceRefresh === true,
        sleep,
    }));
}

function joinRefresh(zotero, start) {
    const existing = refreshInFlight.get(zotero);
    if (existing) return existing;
    const promise = start().finally(() => {
        if (refreshInFlight.get(zotero) === promise) refreshInFlight.delete(zotero);
    });
    refreshInFlight.set(zotero, promise);
    return promise;
}

async function performRefresh(zotero, {
    fetchImpl,
    clock,
    forceRefresh,
    sleep,
}) {
    const initial = getAccountSession(zotero);
    if (!initial.refreshToken) throw new MkteroSignInRequiredError();

    if (readActiveLock(zotero)) {
        const adopted = await waitForPeer(
            zotero,
            initial.refreshToken,
            clock,
            sleep
        );
        if (adopted) return adopted;
    }

    const lockId = acquireLock(zotero);
    if (!lockId) {
        const adopted = await waitForPeer(
            zotero,
            initial.refreshToken,
            clock,
            sleep
        );
        if (adopted) return adopted;
        throw networkError();
    }

    try {
        return await refreshWhileHoldingLock(zotero, {
            fetchImpl,
            clock,
            forceRefresh,
            initial,
        });
    }
    finally {
        releaseLock(zotero, lockId);
    }
}

async function refreshWhileHoldingLock(zotero, {
    fetchImpl,
    clock,
    forceRefresh,
    initial,
}) {
    const session = getAccountSession(zotero);
    if (!session.refreshToken) throw new MkteroSignInRequiredError();
    // The other bundle published a new pair while we waited for its lock.
    // That access token is not the one a 401 rejected.
    if (session.refreshToken !== initial.refreshToken
        && session.accessToken
        && !accessTokenNeedsRefresh(session, clock())) {
        return session.accessToken;
    }
    if (!forceRefresh && !accessTokenNeedsRefresh(session, clock())) {
        return session.accessToken;
    }

    const usedToken = session.refreshToken;
    try {
        const refreshed = await refreshMkteroAccount({
            apiBase: getAccountApiBase(zotero),
            refreshToken: usedToken,
            fetchImpl,
            now: clock,
        });
        saveAccountSession(zotero, {
            ...refreshed,
            email: refreshed.email || session.email,
            nickname: refreshed.nickname || session.nickname,
        });
        return refreshed.accessToken;
    }
    catch (error) {
        if (!isAccountSessionInvalid(error)) throw networkError();
        if (error.code === 'account_disabled') {
            clearAccountSession(zotero);
            const disabled = new Error('Mktero account is disabled');
            disabled.code = 'MKTERO_ACCOUNT_DISABLED';
            throw disabled;
        }
        const current = getAccountSession(zotero);
        // invalid_token also means another refresh already rotated this token.
        // Clearing here would throw away the pair that rotation just stored.
        if (current.refreshToken && current.refreshToken !== usedToken) {
            if (current.accessToken) return current.accessToken;
            throw new MkteroSignInRequiredError();
        }
        clearAccountSession(zotero);
        throw new MkteroSignInRequiredError();
    }
}

async function waitForPeer(zotero, refreshAtStart, clock, sleep) {
    for (let attempt = 0; attempt < MAX_PEER_POLLS; attempt += 1) {
        const adopted = adoptedAccessToken(zotero, refreshAtStart, clock);
        if (adopted) return adopted;
        const lock = readActiveLock(zotero);
        if (!getAccountSession(zotero).refreshToken && !lock) {
            throw new MkteroSignInRequiredError();
        }
        if (!lock) return null;
        await sleep(PEER_POLL_MS);
    }
    return null;
}

function adoptedAccessToken(zotero, refreshAtStart, clock) {
    const session = getAccountSession(zotero);
    if (!session.refreshToken
        || session.refreshToken === refreshAtStart
        || !session.accessToken
        || accessTokenNeedsRefresh(session, clock())) {
        return '';
    }
    return session.accessToken;
}

function acquireLock(zotero) {
    const now = Date.now();
    if (readActiveLock(zotero, now)) return '';
    refreshLockSerial += 1;
    const id = `${now.toString(36)}-${refreshLockSerial}-${Math.random().toString(36).slice(2)}`;
    writeLock(zotero, { id, until: now + REFRESH_LOCK_TTL_MS });
    if (readLock(zotero)?.id !== id) return '';
    return id;
}

function releaseLock(zotero, id) {
    if (!id || readLock(zotero)?.id !== id) return;
    writeLock(zotero, null);
}

function readActiveLock(zotero, now = Date.now()) {
    const lock = readLock(zotero);
    if (!lock || lock.until <= now) return null;
    return lock;
}

function readLock(zotero) {
    const raw = String(zotero?.Prefs?.get?.(ACCOUNT_REFRESH_LOCK_PREF, true) || '');
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.id !== 'string' || !Number.isFinite(parsed.until)) {
            return null;
        }
        return parsed;
    }
    catch {
        return null;
    }
}

function writeLock(zotero, lock) {
    zotero?.Prefs?.set?.(
        ACCOUNT_REFRESH_LOCK_PREF,
        lock ? JSON.stringify({ id: lock.id, until: lock.until }) : '',
        true
    );
}

function networkError() {
    const error = new Error('The Mktero account service could not be reached');
    error.code = 'MKTERO_NETWORK_ERROR';
    return error;
}

function delay(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}
