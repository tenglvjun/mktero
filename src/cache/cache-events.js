export const LOCAL_CACHE_CLEARED_TOPIC = 'mktero-cache-cleared';
export const CACHE_CLEANUP_STATUS_TOPIC = 'mktero-cache-cleanup-status';
export const CACHE_CLEANUP_STATUS_REQUEST_TOPIC = 'mktero-cache-cleanup-status-request';
export const CACHE_CLEANUP_RETRY_TOPIC = 'mktero-cache-cleanup-retry';

const CLEANUP_STATES = new Set(['waiting', 'running', 'complete', 'blocked', 'error']);
const CLEANUP_REASONS = new Set([
    'missing-file', 'unreadable-file', 'changed-file', 'oversized-file',
    'identity-unverified', 'library-unavailable', 'index-unavailable', 'cleanup-failed',
]);

function cleanupCount(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function cleanupInstant(value) {
    return Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000
        ? value : null;
}

// Only this allowlist crosses the bootstrap/preferences bundle boundary.
function normalizeCleanupStatus(value) {
    if (!value || !CLEANUP_STATES.has(value.state)) return null;
    const reasons = new Map();
    for (const reason of Array.isArray(value.reasons) ? value.reasons : []) {
        if (!CLEANUP_REASONS.has(reason?.code)) continue;
        const count = cleanupCount(reason.count);
        if (count) reasons.set(reason.code, Math.min(
            Number.MAX_SAFE_INTEGER, (reasons.get(reason.code) || 0) + count
        ));
    }
    const blockers = [];
    for (const blocker of Array.isArray(value.blockers) ? value.blockers : []) {
        if (!CLEANUP_REASONS.has(blocker?.reason)
            || !Number.isSafeInteger(blocker.itemID) || blocker.itemID <= 0
            || !Number.isSafeInteger(blocker.libraryID) || blocker.libraryID < 0
            || typeof blocker.attachmentKey !== 'string'
            || !/^[A-Z0-9]{8}$/.test(blocker.attachmentKey)) continue;
        blockers.push({
            itemID: blocker.itemID,
            libraryID: blocker.libraryID,
            attachmentKey: blocker.attachmentKey,
            reason: blocker.reason,
        });
        if (blockers.length === 10) break;
    }
    return {
        state: value.state,
        checkedAt: cleanupInstant(value.checkedAt),
        nextRunAt: cleanupInstant(value.nextRunAt),
        removed: cleanupCount(value.removed),
        ownersRemoved: cleanupCount(value.ownersRemoved),
        referenced: cleanupCount(value.referenced),
        busy: cleanupCount(value.busy),
        unknown: cleanupCount(value.unknown),
        errors: cleanupCount(value.errors),
        reasons: [...reasons].map(([code, count]) => ({ code, count })),
        blockers,
    };
}

function notifyCleanup(services, topic, data = null) {
    try {
        if (typeof services?.obs?.notifyObservers !== 'function') return false;
        services.obs.notifyObservers(null, topic, data);
        return true;
    }
    catch {
        return false;
    }
}

export function publishCacheCleanupStatus(services, status) {
    const safeStatus = normalizeCleanupStatus(status);
    return safeStatus ? notifyCleanup(
        services, CACHE_CLEANUP_STATUS_TOPIC, JSON.stringify(safeStatus)
    ) : false;
}

export function observeCacheCleanupStatus(services, listener) {
    if (typeof listener !== 'function') {
        throw new TypeError('A cache cleanup status listener is required');
    }
    if (!services?.obs?.addObserver || !services?.obs?.removeObserver) return () => {};
    let active = true;
    const observer = { observe(_subject, topic, data) {
        if (!active || topic !== CACHE_CLEANUP_STATUS_TOPIC
            || typeof data !== 'string' || data.length > 16384) return;
        try {
            const status = normalizeCleanupStatus(JSON.parse(data));
            if (status) listener(status);
        }
        catch {
            // A malformed message or closed pane must not break background cleanup.
        }
    } };
    services.obs.addObserver(observer, CACHE_CLEANUP_STATUS_TOPIC);
    return () => {
        if (!active) return;
        active = false;
        services.obs.removeObserver(observer, CACHE_CLEANUP_STATUS_TOPIC);
    };
}

export function requestCacheCleanupStatus(services) {
    return notifyCleanup(services, CACHE_CLEANUP_STATUS_REQUEST_TOPIC);
}

export function requestCacheCleanupRetry(services) {
    return notifyCleanup(services, CACHE_CLEANUP_RETRY_TOPIC);
}

export function registerCacheCleanupStatusProvider(services, { getStatus, retry }) {
    if (typeof getStatus !== 'function' || typeof retry !== 'function') {
        throw new TypeError('Cache cleanup status and retry callbacks are required');
    }
    if (!services?.obs?.addObserver || !services?.obs?.removeObserver) return () => {};
    let active = true;
    let sequence = 0;
    let retrying = false;
    let lastStatus = null;
    const publish = status => {
        if (!active) return;
        const safeStatus = normalizeCleanupStatus(status);
        if (!safeStatus) return;
        lastStatus = safeStatus;
        publishCacheCleanupStatus(services, safeStatus);
    };
    const failed = () => publish({
        ...lastStatus, state: 'error', nextRunAt: null,
        errors: Math.max(1, lastStatus?.errors || 0),
        reasons: [{ code: 'cleanup-failed', count: 1 }],
    });
    const respond = () => {
        const request = ++sequence;
        try {
            const status = getStatus();
            if (typeof status?.then === 'function') {
                Promise.resolve(status).then(value => {
                    if (active && request === sequence) publish(value);
                }, () => {
                    if (active && request === sequence) failed();
                });
            }
            else publish(status);
        }
        catch { failed(); }
    };
    const observer = { observe(_subject, topic) {
        if (!active) return;
        if (topic === CACHE_CLEANUP_STATUS_REQUEST_TOPIC) {
            if (retrying) publish(lastStatus);
            else respond();
        }
        else if (topic === CACHE_CLEANUP_RETRY_TOPIC && !retrying) {
            retrying = true;
            sequence += 1;
            publish({ ...lastStatus, state: 'running', nextRunAt: null });
            // Deferring invocation also converts synchronous failures to a safe status.
            Promise.resolve().then(() => active ? retry() : undefined).then(() => {
                retrying = false;
                if (active) respond();
            }, () => {
                retrying = false;
                if (active) failed();
            });
        }
    } };
    services.obs.addObserver(observer, CACHE_CLEANUP_STATUS_REQUEST_TOPIC);
    services.obs.addObserver(observer, CACHE_CLEANUP_RETRY_TOPIC);
    return () => {
        if (!active) return;
        active = false;
        sequence += 1;
        services.obs.removeObserver(observer, CACHE_CLEANUP_STATUS_REQUEST_TOPIC);
        services.obs.removeObserver(observer, CACHE_CLEANUP_RETRY_TOPIC);
    };
}

export function notifyLocalCacheCleared(services) {
    services?.obs?.notifyObservers?.(null, LOCAL_CACHE_CLEARED_TOPIC);
}

export function withSuccessfulClearNotification(cache, listener) {
    if (typeof cache?.getStats !== 'function'
        || typeof cache?.clear !== 'function'
        || typeof listener !== 'function') {
        throw new TypeError('A cache and clear listener are required');
    }
    return {
        getStats: (...args) => cache.getStats(...args),
        async clear(...args) {
            await cache.clear(...args);
            listener();
        },
    };
}

export function observeLocalCacheCleared(services, listener) {
    if (typeof listener !== 'function') {
        throw new TypeError('A local cache listener is required');
    }
    if (!services?.obs?.addObserver || !services?.obs?.removeObserver) {
        return () => {};
    }
    const observer = {
        observe(_subject, topic) {
            if (topic === LOCAL_CACHE_CLEARED_TOPIC) listener();
        },
    };
    services.obs.addObserver(observer, LOCAL_CACHE_CLEARED_TOPIC);
    return () => services.obs.removeObserver(
        observer,
        LOCAL_CACHE_CLEARED_TOPIC
    );
}
