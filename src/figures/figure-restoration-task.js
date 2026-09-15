// Owns a background figure restoration run independently of any reader tab.
// Closing a tab only detaches its subscriber; the run keeps going and can be
// reused by the next open of the same document. Shutdown cancels every task.
export function createFigureRestorationTask({ id, run } = {}) {
    if (typeof run !== 'function') throw new TypeError('A figure restoration run is required');
    const listeners = new Set();
    const controller = new AbortController();
    const figures = [];
    let settled = false;
    let result = null;
    let error = null;

    const emit = event => {
        for (const listener of [...listeners]) {
            try { listener(event, task); }
            catch { /* A subscriber must not break the run. */ }
        }
    };

    const task = {
        id,
        signal: controller.signal,
        get figures() { return [...figures]; },
        get settled() { return settled; },
        get result() { return result; },
        get error() { return error; },
        subscribe(listener) {
            listeners.add(listener);
            for (const figure of figures) {
                try { listener(figure, task); }
                catch { /* ignore */ }
            }
            if (settled) {
                try { listener(error || result, task); }
                catch { /* ignore */ }
            }
            return () => listeners.delete(listener);
        },
        cancel(reason) {
            controller.abort(reason || abortion());
        },
    };

    task.started = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason || abortion();
        return run({
            signal: controller.signal,
            onFigure: event => {
                figures.push(event);
                emit(event);
            },
        });
    }).then(
        value => { settled = true; result = value; emit(value); return value; },
        reason => { settled = true; error = reason; emit(reason); throw reason; }
    );
    return task;
}

export function createFigureRestorationTaskRegistry() {
    const tasks = new Map();
    return {
        start(id, run) {
            if (typeof id !== 'string' || !id) throw new TypeError('A task id is required');
            const existing = tasks.get(id);
            if (existing) return existing;
            const task = createFigureRestorationTask({ id, run });
            tasks.set(id, task);
            task.started.catch(() => {});
            return task;
        },
        get(id) {
            return tasks.get(id) || null;
        },
        release(id) {
            tasks.delete(id);
        },
        cancelAll(reason) {
            for (const task of tasks.values()) task.cancel(reason);
            tasks.clear();
        },
    };
}

function abortion() {
    const error = new Error('Figure restoration was cancelled');
    error.name = 'AbortError';
    return error;
}
