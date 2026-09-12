export function throwIfFigureAborted(signal) {
    if (!signal?.aborted) return;
    throw signal.reason || figureAbortError();
}

export function figureAbortError() {
    const error = new Error('Figure operation was aborted');
    error.name = 'AbortError';
    return error;
}

export function createFigureAbortScope(signals = [], {
    createAbortController = () => new AbortController(),
    timeoutMs = 0,
    setTimeout: schedule = globalThis.setTimeout,
    clearTimeout: cancel = globalThis.clearTimeout,
} = {}) {
    const controller = createAbortController();
    const listeners = [];
    for (const signal of signals.filter(Boolean)) {
        const abort = () => controller.abort(signal.reason || figureAbortError());
        if (signal.aborted) abort();
        else {
            signal.addEventListener('abort', abort, { once: true });
            listeners.push([signal, abort]);
        }
    }
    const timer = timeoutMs > 0 ? schedule(() => {
        const error = new Error('Figure operation timed out');
        error.code = 'FIGURE_RENDER_TIMEOUT';
        controller.abort(error);
    }, timeoutMs) : null;
    return {
        signal: controller.signal,
        abort: reason => controller.abort(reason || figureAbortError()),
        dispose() {
            if (timer !== null) cancel(timer);
            for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
            listeners.length = 0;
        },
    };
}

export function waitForFigureOperation(operation, signal, onAbort = null) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', abort);
            callback(value);
        };
        const abort = () => {
            if (settled) return;
            try {
                Promise.resolve(onAbort?.()).catch(() => {});
            }
            catch {
                // Cleanup must not replace the original cancellation reason.
            }
            finish(reject, signal?.reason || figureAbortError());
        };
        Promise.resolve(operation).then(value => {
            if (signal?.aborted) abort();
            else finish(resolve, value);
        }, error => finish(reject, error));
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
    });
}
