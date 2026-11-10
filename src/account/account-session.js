import {
    isAccountSessionInvalid,
    refreshMkteroAccount,
    reportMkteroClientVersion,
    reportMkteroReadingActivity,
} from './account-client.js';
import {
    accessTokenNeedsRefresh,
    ACCOUNT_REFRESH_ATTEMPT_ID_PREF,
    clearAccountSession,
    getAccountApiBase,
    getAccountSession,
    saveAccountSession,
} from '../config/account-preferences.js';

export const ACCOUNT_REFRESH_LOCK_PREF = 'extensions.mktero.accountRefreshLock';

export const REFRESH_LOCK_TTL_MS = 60 * 1000;
// Shorter than the lock, so a hung request ends before the lock can expire and
// let another caller present the same refresh token.
export const REFRESH_REQUEST_TIMEOUT_MS = 20 * 1000;
export const CLIENT_HEARTBEAT_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const CLIENT_HEARTBEAT_RETRY_DELAY_MS = 60 * 1000;
export const CLIENT_HEARTBEAT_REQUEST_TIMEOUT_MS = 20 * 1000;
// Reading batches flush more often than the version heartbeat because they
// carry increments: a crash loses whatever has not been sent, and a shorter
// interval bounds that loss. Ten minutes also keeps an idle session silent, since
// a flush with nothing pending sends no request at all.
export const READING_ACTIVITY_INTERVAL_MS = 10 * 60 * 1000;
export const READING_ACTIVITY_RETRY_DELAY_MS = 2 * 60 * 1000;
export const READING_ACTIVITY_REQUEST_TIMEOUT_MS = 20 * 1000;
// On shutdown Zotero waits for the promise shutdown() returns, so the final
// flush gets a short budget rather than the full request timeout.
export const READING_ACTIVITY_SHUTDOWN_TIMEOUT_MS = 2000;
const PEER_POLL_MS = 25;
const MAX_PEER_POLLS = 2400;

// One promise per Zotero runtime. bootstrap.js and preferences.js are separate
// bundles, so this map only collapses callers that share a bundle. The prefs
// lock below covers the other bundle.
const refreshInFlight = new WeakMap();
const heartbeatInFlight = new WeakMap();
const heartbeatSchedulers = new WeakMap();
// The reading reporter keeps its own scheduler map. Sharing the heartbeat's
// would let one six-hour cycle swallow every ten-minute reading flush.
const readingActivitySchedulers = new WeakMap();
let refreshLockSerial = 0;

export function reportAccountClientHeartbeat(zotero, {
    fetchImpl,
    now = Date.now,
    sleep = delay,
    secureRandom = globalThis.crypto,
} = {}) {
    return joinClientHeartbeat(zotero, async () => {
        const request = accessToken => reportMkteroClientVersion({
            apiBase: getAccountApiBase(zotero),
            accessToken,
            fetchImpl,
            timeoutMs: CLIENT_HEARTBEAT_REQUEST_TIMEOUT_MS,
        });
        const accessToken = await ensureAccountAccessToken(zotero, {
            fetchImpl,
            now,
            sleep,
            secureRandom,
        });
        try {
            await request(accessToken);
            return { reported: true };
        }
        catch (error) {
            // A deployed server may predate the heartbeat endpoint. Keep the
            // extension usable and try again on the next scheduled cycle.
            if (isClientHeartbeatUnsupported(error)) {
                return { reported: false, unsupported: true };
            }
            if (error?.status !== 401) throw error;
            const refreshed = await ensureAccountAccessToken(zotero, {
                fetchImpl,
                now,
                sleep,
                secureRandom,
                forceRefresh: true,
            });
            try {
                await request(refreshed);
                return { reported: true, refreshed: true };
            }
            catch (retryError) {
                if (isClientHeartbeatUnsupported(retryError)) {
                    return { reported: false, unsupported: true };
                }
                throw retryError;
            }
        }
    });
}

// startAccountClientHeartbeat starts one non-blocking initial report and then
// keeps the signed-in account fresh. A failed request is retried shortly, while
// a successful report waits for the server's six-hour write throttle window.
export function startAccountClientHeartbeat(zotero, {
    fetchImpl,
    now = Date.now,
    sleep = delay,
    secureRandom = globalThis.crypto,
    setTimeoutImpl = globalThis.setTimeout?.bind(globalThis),
    clearTimeoutImpl = globalThis.clearTimeout?.bind(globalThis),
    intervalMs = CLIENT_HEARTBEAT_INTERVAL_MS,
    retryDelayMs = CLIENT_HEARTBEAT_RETRY_DELAY_MS,
    onError = () => {},
} = {}) {
    if (!zotero) throw new TypeError('A Zotero runtime is required');
    const existing = heartbeatSchedulers.get(zotero);
    if (existing) return existing;
    if (typeof setTimeoutImpl !== 'function' || typeof clearTimeoutImpl !== 'function') {
        throw new TypeError('Timer functions are required');
    }

    let disposed = false;
    let timer = null;
    const schedule = delayMs => {
        if (disposed) return;
        timer = setTimeoutImpl(() => {
            timer = null;
            void run();
        }, delayMs);
    };
    const run = async () => {
        if (disposed) return;
        try {
            await reportAccountClientHeartbeat(zotero, {
                fetchImpl,
                now,
                sleep,
                secureRandom,
            });
            schedule(intervalMs);
        }
        catch (error) {
            if (!isExpectedHeartbeatError(error)) {
                try {
                    onError(error);
                }
                catch {
                    // Reporting diagnostics must never stop the scheduler.
                }
            }
            schedule(isExpectedHeartbeatError(error) ? intervalMs : retryDelayMs);
        }
    };
    const handle = {
        dispose() {
            if (disposed) return;
            disposed = true;
            if (timer !== null) clearTimeoutImpl(timer);
            timer = null;
            if (heartbeatSchedulers.get(zotero) === handle) {
                heartbeatSchedulers.delete(zotero);
            }
        },
    };
    heartbeatSchedulers.set(zotero, handle);
    void run();
    return handle;
}

function joinClientHeartbeat(zotero, start) {
    const existing = heartbeatInFlight.get(zotero);
    if (existing) return existing;
    const promise = start().finally(() => {
        if (heartbeatInFlight.get(zotero) === promise) {
            heartbeatInFlight.delete(zotero);
        }
    });
    heartbeatInFlight.set(zotero, promise);
    return promise;
}

// startReadingActivityReporter flushes the reading counters on a timer.
//
// It is separate from startAccountClientHeartbeat on purpose. The heartbeat
// proves an account is alive every six hours; this carries increments that are
// lost when Zotero quits, so it runs every ten minutes and only when there is
// something to send.
//
// Failure handling follows the payload's value:
//   - 404 and 405 mean the service predates this endpoint. The batch is kept and
//     retried, so a client that ships before the server loses nothing.
//   - 401 forces one token refresh, the same way the heartbeat does.
//   - A sign-in-required or disabled-account error discards the batch: those
//     counts can never be delivered, and retrying them forever would grow the
//     held day without bound.
//   - Any other failure keeps the batch for the next cycle.
export function startReadingActivityReporter(zotero, {
    counter,
    fetchImpl,
    now = Date.now,
    sleep = delay,
    secureRandom = globalThis.crypto,
    setTimeoutImpl = globalThis.setTimeout?.bind(globalThis),
    clearTimeoutImpl = globalThis.clearTimeout?.bind(globalThis),
    intervalMs = READING_ACTIVITY_INTERVAL_MS,
    retryDelayMs = READING_ACTIVITY_RETRY_DELAY_MS,
    shutdownTimeoutMs = READING_ACTIVITY_SHUTDOWN_TIMEOUT_MS,
    onError = () => {},
} = {}) {
    if (!zotero) throw new TypeError('A Zotero runtime is required');
    if (!counter) throw new TypeError('A reading-activity counter is required');
    const existing = readingActivitySchedulers.get(zotero);
    if (existing) return existing;
    if (typeof setTimeoutImpl !== 'function' || typeof clearTimeoutImpl !== 'function') {
        throw new TypeError('Timer functions are required');
    }

    let disposed = false;
    let timer = null;
    let inFlight = null;
    // A batch the service did not accept, kept here rather than pushed back into
    // the counter. The counter has no "add back" API on purpose: that would let a
    // caller inflate totals. Only one batch is held, and only for a failure that
    // might succeed later (an older server, a network error), never for a lost
    // session.
    let retryBatch = null;

    const schedule = delayMs => {
        if (disposed) return;
        timer = setTimeoutImpl(() => {
            timer = null;
            void run();
        }, delayMs);
    };

    // send performs one flush. It returns true when the counter advanced (so the
    // caller can wait the full interval) and false when the same batch should be
    // retried sooner.
    const send = async ({ timeoutMs = READING_ACTIVITY_REQUEST_TIMEOUT_MS } = {}) => {
        // A held batch goes first: it is older, and once the service has the
        // endpoint it is the one most likely to expire. A newer batch waits until
        // the held one is accepted or dropped, which is also what bounds the hold
        // to a single day.
        const payload = retryBatch || counter.take();
        if (!payload) return true;
        const deliver = async accessToken => reportMkteroReadingActivity({
            apiBase: getAccountApiBase(zotero),
            accessToken,
            counters: payload,
            fetchImpl,
            timeoutMs,
        });
        try {
            const accessToken = await ensureAccountAccessToken(zotero, {
                fetchImpl,
                now,
                sleep,
                secureRandom,
            });
            await deliver(accessToken);
            retryBatch = null;
            return true;
        }
        catch (error) {
            if (isAccountSessionInvalidLike(error)) {
                // The counts cannot be delivered under this session. Dropping them
                // is the only bounded choice; the alternative is a held batch that
                // grows until the reader signs in again.
                retryBatch = null;
                return true;
            }
            if (error?.status === 401) {
                try {
                    const refreshed = await ensureAccountAccessToken(zotero, {
                        fetchImpl,
                        now,
                        sleep,
                        secureRandom,
                        forceRefresh: true,
                    });
                    await deliver(refreshed);
                    retryBatch = null;
                    return true;
                }
                catch (retryError) {
                    if (isAccountSessionInvalidLike(retryError)) {
                        retryBatch = null;
                        return true;
                    }
                    hold(payload);
                    if (!isReadingActivityUnsupported(retryError)) reportError(retryError);
                    return false;
                }
            }
            hold(payload);
            if (!isReadingActivityUnsupported(error)) reportError(error);
            return false;
        }
    };

    // hold keeps one batch for a later attempt. An older held batch is replaced:
    // the service accepts only today and yesterday, so the newer one is the one
    // that can still be accepted.
    function hold(payload) {
        retryBatch = payload;
    }

    const run = async () => {
        if (disposed || inFlight) return;
        // The next timer is scheduled before the promise settles, so a caller that
        // drains the timer queue right after runNext() sees the delay it should
        // wait. Scheduling inside .then() left a window where nothing was queued
        // and a test — or a crash between the two microtasks — saw an idle
        // scheduler.
        const pending = send().catch(error => {
            reportError(error);
            return false;
        });
        inFlight = pending;
        let ok = false;
        try {
            ok = await pending;
        }
        finally {
            inFlight = null;
            if (!disposed) schedule(ok ? intervalMs : retryDelayMs);
        }
    };

    const handle = {
        // dispose stops the timer. It does not flush: shutdown calls flush()
        // separately and waits for the promise it returns.
        dispose() {
            if (disposed) return;
            disposed = true;
            if (timer !== null) clearTimeoutImpl(timer);
            timer = null;
            if (readingActivitySchedulers.get(zotero) === handle) {
                readingActivitySchedulers.delete(zotero);
            }
        },

        // flush makes one final attempt within the shutdown budget. It resolves
        // to whether the batch was delivered, and never rejects: a failure to
        // record telemetry must not delay or fail Zotero's shutdown.
        async flush() {
            if (!retryBatch && !counter.pending()) return true;
            try {
                return await withDeadline(
                    () => send({ timeoutMs: shutdownTimeoutMs }),
                    shutdownTimeoutMs,
                    setTimeoutImpl,
                    clearTimeoutImpl,
                    () => false,
                );
            }
            catch (error) {
                reportError(error);
                return false;
            }
        },
    };
    readingActivitySchedulers.set(zotero, handle);

    function reportError(error) {
        try {
            onError(error);
        }
        catch {
            // Reporting diagnostics must never stop the scheduler.
        }
    }

    // The first flush waits a full interval. Opening Zotero is the busiest moment
    // and there is nothing to send yet, so an immediate request would be wasted.
    schedule(intervalMs);
    return handle;
}

// isAccountSessionInvalidLike covers the two states where retrying is pointless:
// the reader signed out, or the account is disabled.
function isAccountSessionInvalidLike(error) {
    return error?.code === 'MKTERO_SIGN_IN_REQUIRED'
        || error?.code === 'MKTERO_ACCOUNT_DISABLED';
}

// isReadingActivityUnsupported detects a service that predates the endpoint, the
// same signal the heartbeat uses.
function isReadingActivityUnsupported(error) {
    return error?.status === 404 || error?.status === 405;
}

// withDeadline races a promise against a timer. A runtime without timers still
// runs the operation; only the waiting is bounded.
function withDeadline(operation, timeoutMs, setTimeoutImpl, clearTimeoutImpl, onTimeout) {
    if (!(timeoutMs > 0) || typeof setTimeoutImpl !== 'function') {
        return operation();
    }
    return new Promise(resolve => {
        let settled = false;
        const timer = setTimeoutImpl(() => {
            if (settled) return;
            settled = true;
            resolve(onTimeout());
        }, timeoutMs);
        Promise.resolve(operation()).then(
            value => {
                if (settled) return;
                settled = true;
                if (typeof clearTimeoutImpl === 'function') clearTimeoutImpl(timer);
                resolve(value);
            },
            () => {
                if (settled) return;
                settled = true;
                if (typeof clearTimeoutImpl === 'function') clearTimeoutImpl(timer);
                resolve(onTimeout());
            }
        );
    });
}

function isClientHeartbeatUnsupported(error) {
    return error?.status === 404 || error?.status === 405;
}

function isExpectedHeartbeatError(error) {
    return error?.code === 'MKTERO_SIGN_IN_REQUIRED'
        || error?.code === 'MKTERO_ACCOUNT_DISABLED'
        || isClientHeartbeatUnsupported(error);
}

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
    secureRandom = globalThis.crypto,
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
        secureRandom,
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
    secureRandom,
}) {
    const initial = getAccountSession(zotero);
    if (!initial.refreshToken) throw new MkteroSignInRequiredError();

    if (readActiveLock(zotero, clock())) {
        const adopted = await waitForPeer(
            zotero,
            initial.refreshToken,
            clock,
            sleep
        );
        if (adopted) return adopted;
    }

    const lockId = acquireLock(zotero, clock());
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
            secureRandom,
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
    secureRandom,
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
    const apiBase = getAccountApiBase(zotero);
    const attemptID = getRefreshAttemptID(zotero, secureRandom);
    const refresh = () => refreshMkteroAccount({
        apiBase,
        refreshToken: usedToken,
        refreshAttemptID: attemptID,
        fetchImpl,
        now: clock,
        timeoutMs: REFRESH_REQUEST_TIMEOUT_MS,
    });
    try {
        let refreshed;
        try {
            refreshed = await refresh();
        }
        catch (error) {
            // A timeout or transport failure may happen after the server has
            // committed rotation. Replaying the same ID recovers the same pair.
            if (error?.code !== 'network') throw error;
            refreshed = await refresh();
        }
        const current = getAccountSession(zotero);
        // The refresh response may arrive after logout, API-base switching, or
        // a new account has replaced the session. Never let an old request
        // resurrect or overwrite that newer state. A different token for the
        // same account can be a peer bundle that completed the rotation first;
        // adopt it when it is already usable.
        // This refresh belongs to the API endpoint used when it started. Do
        // not adopt or write a session created after the user switched hosts.
        if (getAccountApiBase(zotero) !== apiBase) {
            throw new MkteroSignInRequiredError();
        }
        if (current.refreshToken !== usedToken) {
            if (sameAccount(current, session)
                && current.accessToken
                && !accessTokenNeedsRefresh(current, clock())) {
                return current.accessToken;
            }
            throw new MkteroSignInRequiredError();
        }
        saveAccountSession(zotero, {
            ...refreshed,
            email: refreshed.email || current.email,
            nickname: refreshed.nickname || current.nickname,
        }, { preserveEpoch: true });
        return refreshed.accessToken;
    }
    catch (error) {
        if (error?.code === 'MKTERO_SIGN_IN_REQUIRED') throw error;
        if (!isAccountSessionInvalid(error)) throw networkError();
        const current = getAccountSession(zotero);
        if (error.code === 'account_disabled') {
            // Do not clear a session that replaced the one this request used.
            if (current.refreshToken !== usedToken) {
                throw new MkteroSignInRequiredError();
            }
            clearAccountSession(zotero);
            const disabled = new Error('Mktero account is disabled');
            disabled.code = 'MKTERO_ACCOUNT_DISABLED';
            throw disabled;
        }
        if (current.refreshToken && current.refreshToken !== usedToken) {
            if (getAccountApiBase(zotero) === apiBase
                && sameAccount(current, session)
                && current.accessToken
                && !accessTokenNeedsRefresh(current, clock())) {
                return current.accessToken;
            }
            throw new MkteroSignInRequiredError();
        }
        clearAccountSession(zotero);
        throw new MkteroSignInRequiredError();
    }
}

function getRefreshAttemptID(zotero, secureRandom) {
    const stored = String(zotero?.Prefs?.get?.(ACCOUNT_REFRESH_ATTEMPT_ID_PREF, true) || '')
        .trim()
        .toLowerCase();
    if (/^[0-9a-f]{32}$/.test(stored)) return stored;
    const attemptID = createRefreshAttemptID(secureRandom);
    zotero?.Prefs?.set?.(ACCOUNT_REFRESH_ATTEMPT_ID_PREF, attemptID, true);
    return attemptID;
}

export function createRefreshAttemptID(secureRandom = globalThis.crypto) {
    if (typeof secureRandom?.randomUUID === 'function') {
        const attemptID = secureRandom.randomUUID().replaceAll('-', '').toLowerCase();
        if (/^[0-9a-f]{32}$/.test(attemptID)) return attemptID;
    }
    if (typeof secureRandom?.getRandomValues === 'function') {
        const bytes = new Uint8Array(16);
        secureRandom.getRandomValues(bytes);
        const attemptID = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
        if (/^[0-9a-f]{32}$/.test(attemptID)) return attemptID;
    }
    const error = new Error('Secure random number generation is unavailable');
    error.code = 'MKTERO_NETWORK_ERROR';
    throw error;
}

function sameAccount(left, right) {
    const leftEmail = String(left?.email || '').trim().toLowerCase();
    const rightEmail = String(right?.email || '').trim().toLowerCase();
    return Boolean(leftEmail && rightEmail && leftEmail === rightEmail);
}

async function waitForPeer(zotero, refreshAtStart, clock, sleep) {
    for (let attempt = 0; attempt < MAX_PEER_POLLS; attempt += 1) {
        const adopted = adoptedAccessToken(zotero, refreshAtStart, clock);
        if (adopted) return adopted;
        const lock = readActiveLock(zotero, clock());
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

function acquireLock(zotero, now = Date.now()) {
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
