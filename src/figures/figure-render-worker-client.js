import { validateFigureCrop } from './figure-model.js';

// Main-thread client that mirrors createPDFFigureRegionRenderer but performs the
// PDF.js rasterization inside a dedicated Worker. Falls back to a provided
// main-thread renderer when the worker is unavailable.
export function createWorkerFigureRegionRenderer({
    createWorker = defaultCreateWorker,
    createObjectURL = url => URL.createObjectURL(url),
    revokeObjectURL = url => URL.revokeObjectURL?.(url),
    loadWorkerSource,
    workerSource = '',
    rendererOptions = {},
    loadPdfAssets = null,
    fallback = null,
    limits,
    createAbortController = () => new AbortController(),
    setTimeout: schedule = globalThis.setTimeout,
    clearTimeout: cancel = globalThis.clearTimeout,
    requestTimeoutMs = 120_000,
} = {}) {
    if (typeof createWorker !== 'function') {
        throw new TypeError('A figure worker factory is required');
    }
    const pending = new Map();
    let nextId = 0;
    let workerPromise = null;
    let workerFailed = false;
    let disposed = false;
    let assetsSent = false;

    function handleMessage(event) {
        const message = event.data || {};
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        entry.cleanup();
        if (message.ok) entry.resolve(message.value);
        else entry.reject(remoteError(message.error));
    }

    function handleFailure(event) {
        workerFailed = true;
        const reason = new Error(`Figure render worker failed: ${event?.message || 'unknown error'}`);
        for (const entry of pending.values()) {
            entry.cleanup();
            entry.reject(reason);
        }
        pending.clear();
    }

    async function ensureWorker() {
        if (disposed || workerFailed) return null;
        if (workerPromise) return workerPromise;
        workerPromise = (async () => {
            const source = workerSource || await loadWorkerSource?.();
            if (!source) throw new Error('The figure worker source is unavailable');
            assetsSent = false;
            const url = createObjectURL(new Blob([source], { type: 'application/javascript' }));
            const worker = createWorker(url);
            revokeObjectURL(url);
            worker.addEventListener('message', handleMessage);
            worker.addEventListener('error', handleFailure);
            worker.addEventListener('messageerror', handleFailure);
            return worker;
        })().catch(() => {
            workerFailed = true;
            return null;
        });
        return workerPromise;
    }

    function request(worker, op, sessionId, payload = {}, { signal, transfer = [] } = {}) {
        return new Promise((resolve, reject) => {
            const id = ++nextId;
            let settled = false;
            const cleanup = () => {
                cancel(timer);
                signal?.removeEventListener?.('abort', onAbort);
            };
            const finish = (callback, value) => {
                if (settled) return;
                settled = true;
                pending.delete(id);
                cleanup();
                callback(value);
            };
            const onAbort = () => {
                try { worker.postMessage({ id: ++nextId, op: 'cancel', sessionId, payload: { targetId: id } }); }
                catch { /* The worker may already be gone. */ }
                finish(reject, signal?.reason || abortError());
            };
            const timer = schedule(() => {
                finish(reject, timeoutError());
            }, requestTimeoutMs);
            if (signal?.aborted) { onAbort(); return; }
            signal?.addEventListener?.('abort', onAbort, { once: true });
            pending.set(id, { resolve: value => finish(resolve, value), reject: value => finish(reject, value), cleanup });
            try {
                worker.postMessage({ id, op, sessionId, payload }, transfer);
            }
            catch (error) {
                finish(reject, error);
            }
        });
    }

    function createSession(worker, sessionId) {
        return {
            async getPageGeometry(pageIndex, { signal } = {}) {
                return request(worker, 'getPageGeometry', sessionId, { pageIndex }, { signal });
            },
            async renderRegion(regionRequest, { signal } = {}) {
                const crop = await request(worker, 'renderRegion', sessionId, { request: regionRequest }, { signal });
                return validateFigureCrop(crop, limits);
            },
            async renderPageCrops(cropsRequest, { signal } = {}) {
                const result = await request(worker, 'renderPageCrops', sessionId, { request: cropsRequest }, { signal });
                if (!result || !Array.isArray(result.crops)) throw new Error('Figure page crops are invalid');
                for (const item of result.crops) validateFigureCrop(item.crop, limits);
                return result;
            },
            async recoverImageGroup(recoveryRequest, { signal } = {}) {
                return request(worker, 'recoverImageGroup', sessionId, { request: recoveryRequest }, { signal });
            },
            async verifyFigureOrder(orderRequest, { signal } = {}) {
                return request(worker, 'verifyFigureOrder', sessionId, { request: orderRequest }, { signal });
            },
            async close() {
                if (disposed || workerFailed) return;
                await request(worker, 'close', sessionId, {}).catch(() => {});
            },
        };
    }

    return {
        async open(fileData, options = {}) {
            const worker = await ensureWorker();
            if (!worker) {
                if (!fallback) throw new Error('The figure render worker is unavailable');
                return fallback.open(fileData, options);
            }
            const sessionId = `s${++nextId}`;
            const copy = Uint8Array.from(fileData);
            let assets = null;
            if (!assetsSent && typeof loadPdfAssets === 'function') {
                try {
                    const loaded = await loadPdfAssets();
                    const entries = loaded instanceof Map
                        ? [...loaded.entries()]
                        : Object.entries(loaded || {});
                    assets = {};
                    for (const [key, value] of entries) {
                        // Copy so transferring into the worker never detaches the
                        // caller's cached asset bytes.
                        assets[key] = ArrayBuffer.isView(value)
                            ? Uint8Array.from(value)
                            : value;
                    }
                    assetsSent = Object.keys(assets).length > 0;
                }
                catch { /* Fall back to URL-based asset loading. */ }
            }
            const payload = {
                fileData: copy.buffer,
                options: {
                    ...rendererOptions,
                    ...(assets ? { assets } : {}),
                },
            };
            const transfer = [copy.buffer];
            if (assets) {
                for (const value of Object.values(assets)) {
                    if (ArrayBuffer.isView(value)) transfer.push(value.buffer);
                }
            }
            await request(worker, 'open', sessionId, payload, { signal: options.signal, transfer });
            return createSession(worker, sessionId);
        },
        async disposeAll() {
            disposed = true;
            const worker = workerPromise ? await workerPromise : null;
            if (worker && !workerFailed) {
                try { worker.postMessage({ id: ++nextId, op: 'disposeAll', sessionId: 'dispose', payload: {} }); }
                catch { /* Shutdown is best effort. */ }
                worker.terminate?.();
            }
            for (const entry of pending.values()) {
                entry.cleanup();
                entry.reject(abortError());
            }
            pending.clear();
        },
    };
}

function defaultCreateWorker(url) {
    const WorkerType = globalThis.Worker;
    if (typeof WorkerType !== 'function') throw new Error('Web Workers are unavailable');
    return new WorkerType(url);
}

function remoteError(remote) {
    const error = new Error(remote?.message || 'Figure render failed');
    if (remote?.name) error.name = remote.name;
    if (remote?.code) error.code = remote.code;
    return error;
}

function abortError() {
    const error = new Error('Figure operation was aborted');
    error.name = 'AbortError';
    return error;
}

function timeoutError() {
    const error = new Error('Figure render worker timed out');
    error.name = 'TimeoutError';
    error.code = 'FIGURE_RENDER_TIMEOUT';
    return error;
}
