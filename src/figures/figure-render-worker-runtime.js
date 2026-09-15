// Worker-side dispatcher for figure PDF rendering. It owns PDF sessions and
// serializes every operation with an abort scope so the main thread can cancel.
export function createFigureRenderWorkerRuntime({ createRenderer } = {}) {
    if (typeof createRenderer !== 'function') {
        throw new TypeError('A figure renderer factory is required');
    }
    const sessions = new Map();
    const operations = new Map();
    // PDF.js asset bytes (cMap/standard-font/WASM) are sent once and reused by
    // every session renderer, not just the session that first received them.
    let sharedAssets = null;
    let active = true;

    function begin(sessionId, id) {
        const key = `${sessionId}:${id}`;
        const controller = new AbortController();
        operations.set(key, controller);
        return {
            signal: controller.signal,
            dispose() {
                operations.delete(key);
                if (!controller.signal.aborted) controller.abort();
            },
        };
    }

    async function handle(message) {
        if (!active) throw new Error('Figure render worker is closed');
        if (!message || typeof message !== 'object') {
            throw new TypeError('Figure render message is invalid');
        }
        const { id, op, sessionId, payload = {} } = message;
        if (op === 'cancel') {
            operations.get(`${sessionId}:${payload.targetId}`)?.abort(payload.reason || abortReason());
            return null;
        }
        if (op === 'open') {
            const operation = begin(sessionId, id);
            const sessionScope = new AbortController();
            const abortSession = () => sessionScope.abort(operation.signal.reason || abortReason());
            operation.signal.addEventListener('abort', abortSession, { once: true });
            try {
                const options = payload.options || {};
                if (options.assets) sharedAssets = options.assets;
                const renderer = createRenderer({
                    ...options,
                    ...(sharedAssets ? { assets: sharedAssets } : {}),
                });
                const fileData = toBytes(payload.fileData);
                const session = await renderer.open(fileData, { signal: sessionScope.signal });
                if (operation.signal.aborted) {
                    await session.close().catch(() => {});
                    throw operation.signal.reason || abortReason();
                }
                sessions.set(sessionId, { renderer, session, scope: sessionScope });
                return null;
            }
            catch (error) {
                sessionScope.abort(error);
                try { await sessions.get(sessionId)?.session.close(); }
                catch { /* The failed open already released its resources. */ }
                sessions.delete(sessionId);
                throw error;
            }
            finally {
                operation.signal.removeEventListener('abort', abortSession);
                operation.dispose();
            }
        }
        if (op === 'disposeAll') {
            for (const entry of sessions.values()) entry.scope.abort(abortReason());
            await Promise.allSettled([...sessions.values()].map(({ renderer }) => renderer.disposeAll()));
            for (const { session } of sessions.values()) {
                try { await session.close(); }
                catch { /* Already disposed. */ }
            }
            sessions.clear();
            operations.clear();
            active = false;
            return null;
        }
        const entry = sessions.get(sessionId);
        if (!entry) throw new Error('Figure render session is unknown');
        const operation = begin(sessionId, id);
        try {
            switch (op) {
                case 'getPageGeometry':
                    return await entry.session.getPageGeometry(payload.pageIndex, { signal: operation.signal });
                case 'renderRegion':
                    return await entry.session.renderRegion(payload.request, { signal: operation.signal });
                case 'renderPageCrops':
                    return await entry.session.renderPageCrops(payload.request, { signal: operation.signal });
                case 'recoverImageGroup':
                    return await entry.session.recoverImageGroup(payload.request, { signal: operation.signal });
                case 'verifyFigureOrder':
                    return await entry.session.verifyFigureOrder(payload.request, { signal: operation.signal });
                case 'close':
                    sessions.delete(sessionId);
                    entry.scope?.abort(abortReason());
                    await entry.session.close();
                    return null;
                default:
                    throw new Error(`Unsupported figure render operation: ${op}`);
            }
        }
        finally {
            operation.dispose();
        }
    }

    return {
        handle,
        async disposeAll() {
            await handle({ id: 'dispose', op: 'disposeAll', sessionId: 'dispose' });
        },
    };
}

function toBytes(value) {
    if (ArrayBuffer.isView(value)) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    throw new TypeError('Figure PDF bytes are invalid');
}

function abortReason() {
    const error = new Error('Figure operation was aborted');
    error.name = 'AbortError';
    return error;
}
