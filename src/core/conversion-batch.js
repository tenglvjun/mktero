// Concurrent conversions, not OS threads. Figure rendering shares one worker.
export const CONVERSION_BATCH_CONCURRENCY = 3;

export function createConversionBatch({
    concurrency = CONVERSION_BATCH_CONCURRENCY,
    isReady = () => false,
    isActive = () => false,
    isBlockedError = () => false,
    isQuotaError = error => error?.code === 'MKTERO_DAILY_LIMIT_EXCEEDED'
        || error?.code === 'MKTERO_DAILY_SLOTS_RESERVED',
    getScope = () => '',
    convert,
    onEvent = () => {},
    createController = () => new AbortController(),
} = {}) {
    if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
        throw new TypeError('A positive batch concurrency is required');
    }
    if (typeof convert !== 'function') {
        throw new TypeError('A batch converter is required');
    }
    if (typeof createController !== 'function') {
        throw new TypeError('An AbortController factory is required');
    }

    const queue = [];
    const items = new Map();
    const waiters = new Map();
    const pausedScopes = new Map();
    let running = 0;
    let stopped = false;

    return {
        enqueue(candidates) {
            stopped = false;
            const summary = {
                accepted: [],
                skippedReady: [],
                skippedActive: [],
                skippedQueued: [],
            };
            const seen = new Set();
            for (const candidate of candidates || []) {
                const item = normalizeCandidate(candidate);
                if (!item || seen.has(item.itemID)) continue;
                seen.add(item.itemID);
                const scope = String(getScope() || '');
                const existing = items.get(item.itemID);
                if (existing && isOpenStatus(existing.status)) {
                    if (existing.scope === scope || existing.status === 'running') {
                        summary.skippedQueued.push(item);
                        continue;
                    }
                    const oldPosition = queue.indexOf(item.itemID);
                    if (oldPosition >= 0) queue.splice(oldPosition, 1);
                    finish(item.itemID, 'released');
                }
                if (safeCheck(isActive, item)) {
                    summary.skippedActive.push(item);
                    continue;
                }
                if (safeCheck(isReady, item)) {
                    summary.skippedReady.push(item);
                    continue;
                }
                const record = {
                    ...item,
                    scope,
                    status: 'queued',
                    result: null,
                    error: null,
                    controller: null,
                };
                items.set(item.itemID, record);
                if (record.scope && pausedScopes.has(record.scope)) {
                    pauseRecord(record, pausedScopes.get(record.scope), false);
                } else {
                    queue.push(item.itemID);
                }
                summary.accepted.push(item);
                if (record.status === 'queued') emit({
                    type: 'queued',
                    item,
                    ahead: queue.length - 1,
                });
            }
            emitPositions();
            pump();
            return summary;
        },

        cancel() {
            stopped = true;
            const pending = queue.splice(0);
            const running = [];
            for (const itemID of pending) finish(itemID, 'cancelled');
            const paused = [];
            for (const record of items.values()) {
                if (record.status === 'paused' || record.status === 'blocked') {
                    paused.push(record.itemID);
                    finish(record.itemID, 'cancelled');
                }
                if (record.status !== 'running') continue;
                running.push(record.itemID);
                record.controller?.abort();
            }
            // Cancelling work does not lift a server quota pause for new submissions.
            return [...pending, ...paused, ...running];
        },

        cancelItem(itemID) {
            const index = queue.indexOf(itemID);
            if (index >= 0) {
                queue.splice(index, 1);
                finish(itemID, 'cancelled');
                emitPositions();
                return;
            }
            const record = items.get(itemID);
            if (record?.status === 'paused' || record?.status === 'blocked') {
                finish(itemID, 'cancelled');
                return;
            }
            if (record?.status === 'running') record.controller?.abort();
        },

        isPreparing(itemID) {
            const record = items.get(itemID);
            return Boolean(record && record.scope === getScope()
                && isOpenStatus(record.status) && !safeCheck(isReady, record));
        },

        position(itemID) {
            const record = items.get(itemID);
            if (!record || !isOpenStatus(record.status)) return null;
            if (record.status === 'paused' || record.status === 'blocked') {
                return { status: record.status, ahead: 0 };
            }
            if (record.status === 'running') {
                return { status: 'running', ahead: 0 };
            }
            const ahead = queue.indexOf(itemID);
            return {
                status: 'queued',
                ahead: ahead < 0 ? 0 : ahead,
            };
        },

        wait(itemID) {
            const record = items.get(itemID);
            if (record?.status === 'paused' || record?.status === 'blocked') {
                return Promise.reject(pausedError(record.error));
            }
            if (record?.status === 'succeeded') {
                return Promise.resolve(record.result);
            }
            if (record?.status === 'failed') return Promise.reject(record.error);
            if (!record || !isOpenStatus(record.status)) {
                return Promise.reject(cancelledError());
            }
            return waiterFor(itemID).promise;
        },

        pausedScope(scope = getScope()) {
            return pausedScopes.get(scope) || null;
        },

        blockScope(error, scope = getScope(), candidate = null) {
            blockScope(error, scope, candidate);
        },

        // Resuming lifts the account pause so every pending item is tried once.
        // The server is the only authority on whether an item is chargeable: a
        // document this account already converted is admitted without quota,
        // and a new document is refused and re-pauses the scope.
        resume(scope = getScope()) {
            if (!scope || scope !== getScope() || !pausedScopes.has(scope)) return 0;
            stopped = false;
            pausedScopes.delete(scope);
            let count = 0;
            for (const record of items.values()) {
                if (record.scope !== scope
                    || (record.status !== 'paused' && record.status !== 'blocked')) continue;
                if (safeCheck(isReady, record) || safeCheck(isActive, record)) {
                    finish(record.itemID, 'released');
                    continue;
                }
                record.status = 'queued';
                record.error = null;
                queue.push(record.itemID);
                emit({ type: 'queued', item: publicItem(record), ahead: queue.length - 1 });
                count += 1;
            }
            emitPositions();
            pump();
            return count;
        },

        cancelRemaining(scope = getScope()) {
            const cancelled = [];
            for (const record of items.values()) {
                if (record.scope !== scope
                    || (record.status !== 'paused' && record.status !== 'blocked')) continue;
                cancelled.push(record.itemID);
                finish(record.itemID, 'cancelled');
            }
            return cancelled;
        },
    };

    function pauseRecord(record, error, blocked) {
        record.status = blocked ? 'blocked' : 'paused';
        record.error = error;
        emit({ type: record.status, item: publicItem(record), error });
        settleWaiter(record.itemID, waiter => waiter.reject(pausedError(error)));
    }

    function pump() {
        if (stopped) return;
        while (running < concurrency && queue.length) {
            const itemID = queue.shift();
            const record = items.get(itemID);
            if (!record || record.status !== 'queued') continue;
            if (record.scope !== getScope()) {
                if (!record.scope.startsWith('mktero:')) {
                    finish(record.itemID, 'released');
                    continue;
                }
                const error = Object.assign(new Error('Conversion account or provider changed'), {
                    code: 'MKTERO_QUOTA_ACCOUNT_CHANGED',
                });
                pausedScopes.set(record.scope, error);
                pauseRecord(record, error, false);
                continue;
            }
            record.status = 'running';
            record.controller = createController();
            running += 1;
            emit({ type: 'started', item: publicItem(record) });
            emitPositions();
            void runItem(record).finally(() => {
                running -= 1;
                pump();
            });
        }
    }

    async function runItem(record) {
        const signal = record.controller.signal;
        try {
            const result = await convert(publicItem(record), {
                signal,
                onProgress: (progress, state) => {
                    if (signal.aborted || record.status !== 'running') return;
                    emit({
                        type: 'progress',
                        item: publicItem(record),
                        progress,
                        state: state || {},
                    });
                },
            });
            if (signal.aborted || record.status !== 'running') {
                finish(record.itemID, 'cancelled');
                return;
            }
            record.status = 'succeeded';
            record.result = result;
            emit({
                type: 'succeeded',
                item: publicItem(record),
                result,
            });
            settleWaiter(record.itemID, waiter => waiter.resolve(result));
        }
        catch (error) {
            if (signal.aborted || isCancellation(error)) {
                finish(record.itemID, replacement(error)
                    ? 'released'
                    : 'cancelled');
                return;
            }
            if (isQuotaError(error) && record.scope) {
                pauseRecord(record, error, true);
                blockScope(error, record.scope);
                return;
            }
            record.status = 'failed';
            record.error = error;
            emit({
                type: 'failed',
                item: publicItem(record),
                error,
            });
            settleWaiter(record.itemID, waiter => waiter.reject(error));
            if (safeCheck(isBlockedError, error)) {
                stopped = true;
                const pending = queue.splice(0);
                for (const itemID of pending) finish(itemID, 'cancelled');
                emit({ type: 'blocked', error });
            }
        }
    }

    function blockScope(error, scope, candidate = null) {
        if (!scope || !isQuotaError(error)) return;
        const item = normalizeCandidate(candidate);
        if (item && !isOpenStatus(items.get(item.itemID)?.status)) {
            const record = { ...item, scope, result: null, error, controller: null };
            items.set(item.itemID, record);
            pauseRecord(record, error, true);
        }
        const first = !pausedScopes.has(scope);
        pausedScopes.set(scope, error);
        for (const itemID of queue.splice(0)) {
            const pending = items.get(itemID);
            if (pending?.scope === scope) pauseRecord(pending, error, false);
            else queue.push(itemID);
        }
        emitPositions();
        if (first) emit({ type: 'quota-blocked', error, scope });
    }

    function finish(itemID, status) {
        const record = items.get(itemID);
        if (!record || !isOpenStatus(record.status)) return;
        record.status = status;
        emit({ type: status, item: publicItem(record) });
        settleWaiter(itemID, waiter => waiter.reject(cancelledError()));
    }

    function settleWaiter(itemID, settle) {
        const waiter = waiters.get(itemID);
        if (!waiter) return;
        waiters.delete(itemID);
        settle(waiter);
    }

    function emitPositions() {
        queue.forEach((itemID, ahead) => {
            const record = items.get(itemID);
            if (!record) return;
            emit({
                type: 'position',
                item: publicItem(record),
                ahead,
            });
        });
    }

    function emit(event) {
        try {
            onEvent(event);
        }
        catch {
            // Batch progress reporting must not stop the queue.
        }
    }

    function waiterFor(itemID) {
        let waiter = waiters.get(itemID);
        if (!waiter) {
            let resolve;
            let reject;
            const promise = new Promise((next, fail) => {
                resolve = next;
                reject = fail;
            });
            waiter = { promise, resolve, reject };
            waiters.set(itemID, waiter);
        }
        return waiter;
    }
}

function normalizeCandidate(candidate) {
    const itemID = candidate?.itemID;
    if (!Number.isSafeInteger(itemID) || itemID <= 0) return null;
    const title = cleanTitle(candidate.title);
    return { itemID, title };
}

function cleanTitle(value) {
    const text = String(value || '')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!text) return 'PDF';
    return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

function publicItem(record) {
    return { itemID: record.itemID, title: record.title, scope: record.scope };
}

function isOpenStatus(status) {
    return status === 'queued' || status === 'running'
        || status === 'paused' || status === 'blocked';
}

function safeCheck(check, value) {
    try {
        return Boolean(check?.(value));
    }
    catch {
        return false;
    }
}

function isCancellation(error) {
    return error?.name === 'AbortError'
        || error?.code === 'ABORT_ERR'
        || error?.code === 'MKTERO_CONVERSION_REPLACED';
}

function replacement(error) {
    return error?.code === 'MKTERO_CONVERSION_REPLACED';
}

function pausedError(cause) {
    const error = new Error('Conversion paused until quota is available');
    error.code = 'MKTERO_QUOTA_PAUSED';
    error.quota = cause?.quota || null;
    return error;
}

function cancelledError() {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    return error;
}
