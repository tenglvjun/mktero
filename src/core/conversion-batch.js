// Concurrent conversions, not OS threads. Figure rendering shares one worker.
export const CONVERSION_BATCH_CONCURRENCY = 3;

export function createConversionBatch({
    concurrency = CONVERSION_BATCH_CONCURRENCY,
    isReady = () => false,
    isActive = () => false,
    isBlockedError = () => false,
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
                const existing = items.get(item.itemID);
                if (existing && isOpenStatus(existing.status)) {
                    summary.skippedQueued.push(item);
                    continue;
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
                    status: 'queued',
                    result: null,
                    error: null,
                    controller: null,
                };
                items.set(item.itemID, record);
                queue.push(item.itemID);
                summary.accepted.push(item);
                emit({
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
            for (const record of items.values()) {
                if (record.status !== 'running') continue;
                running.push(record.itemID);
                record.controller?.abort();
            }
            return [...pending, ...running];
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
            if (record?.status === 'running') record.controller?.abort();
        },

        isPreparing(itemID) {
            return isOpenStatus(items.get(itemID)?.status);
        },

        position(itemID) {
            const record = items.get(itemID);
            if (!record || !isOpenStatus(record.status)) return null;
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
            if (record?.status === 'succeeded') {
                return Promise.resolve(record.result);
            }
            if (record?.status === 'failed') return Promise.reject(record.error);
            if (record && !isOpenStatus(record.status)) {
                return Promise.reject(cancelledError());
            }
            return waiterFor(itemID).promise;
        },
    };

    function pump() {
        if (stopped) return;
        while (running < concurrency && queue.length) {
            const itemID = queue.shift();
            const record = items.get(itemID);
            if (!record || record.status !== 'queued') continue;
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
    return { itemID: record.itemID, title: record.title };
}

function isOpenStatus(status) {
    return status === 'queued' || status === 'running';
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

function cancelledError() {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    return error;
}
