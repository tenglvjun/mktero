const REPLACED = 'replaced';
const CANCELLED = 'cancelled';

export function createConversionRunRegistry({
    createController,
    execute,
} = {}) {
    if (typeof createController !== 'function') {
        throw new TypeError('An AbortController factory is required');
    }
    if (typeof execute !== 'function') {
        throw new TypeError('A conversion executor is required');
    }

    const runs = new Map();
    const pendingListeners = new Map();

    return {
        begin({ itemID, owner, forceRefresh = false } = {}) {
            validateItemID(itemID);
            if (!owner) throw new TypeError('A conversion owner is required');
            const existing = runs.get(itemID);
            if (existing
                && !existing.settled
                && !existing.controller.signal.aborted
                && !forceRefresh) {
                existing.owners.add(owner);
                return { run: expose(existing), adopted: true };
            }
            if (existing) abortEntry(existing, REPLACED);

            const controller = createController();
            validateController(controller);
            const entry = {
                itemID,
                controller,
                owners: new Set([owner]),
                listeners: new Set(pendingListeners.get(itemID) || []),
                lastProgress: null,
                provisionalDocument: null,
                figurePatches: [],
                settled: false,
                abortReason: null,
                promise: null,
            };
            let execution;
            try {
                execution = execute(itemID, {
                    controller,
                    signal: controller.signal,
                    forceRefresh,
                    onProgress(progress, state) {
                        if (entry.settled || entry.controller.signal.aborted) return;
                        const nextState = state || {};
                        entry.lastProgress = { progress, state: nextState };
                        emit(entry, {
                            type: 'progress',
                            progress,
                            state: nextState,
                        });
                    },
                    onProgressiveFigures(event) {
                        if (entry.settled || !event) return;
                        if (event.type === 'document' && !entry.provisionalDocument) {
                            entry.provisionalDocument = event;
                        }
                        else if (
                            event.type === 'figure'
                            && event.figure?.status === 'composed'
                            && event.figure.crop
                        ) {
                            entry.figurePatches.push(event);
                        }
                        emit(entry, { type: 'progressive', event });
                    },
                });
            }
            catch (error) {
                execution = Promise.reject(error);
            }
            entry.promise = Promise.resolve(execution)
                .then(result => {
                    entry.settled = true;
                    entry.result = result;
                    emit(entry, { type: 'ready', result });
                    return result;
                }, error => {
                    entry.settled = true;
                    entry.error = error;
                    emit(entry, {
                        type: 'error',
                        error,
                        reason: entry.abortReason,
                    });
                    throw error;
                })
                .finally(() => {
                    if (runs.get(itemID) === entry) runs.delete(itemID);
                });
            runs.set(itemID, entry);
            return { run: expose(entry), adopted: false };
        },

        get(itemID) {
            const entry = runs.get(itemID);
            return entry ? expose(entry) : null;
        },

        subscribe(itemID, listener) {
            validateItemID(itemID);
            if (typeof listener !== 'function') {
                throw new TypeError('A conversion listener is required');
            }
            let pending = pendingListeners.get(itemID);
            if (!pending) {
                pending = new Set();
                pendingListeners.set(itemID, pending);
            }
            pending.add(listener);
            const entry = runs.get(itemID);
            if (entry && !entry.settled) {
                // Replay before the listener can observe live events. Document
                // first, even when a composed figure was stored earlier.
                for (const progressiveEvent of storedProgressiveEvents(entry)) {
                    try {
                        listener({
                            type: 'progressive',
                            event: progressiveEvent,
                        });
                    }
                    catch {
                        // A progress listener must not affect the conversion.
                    }
                }
                entry.listeners.add(listener);
                if (entry.lastProgress) {
                    listener({
                        type: 'progress',
                        progress: entry.lastProgress.progress,
                        state: entry.lastProgress.state,
                    });
                }
            }
            return () => {
                pending.delete(listener);
                if (!pending.size) pendingListeners.delete(itemID);
                runs.get(itemID)?.listeners.delete(listener);
            };
        },

        attach(itemID, owner) {
            const entry = activeEntry(itemID);
            if (!entry || !owner) return false;
            entry.owners.add(owner);
            return true;
        },

        release(itemID, owner, { abortIfLast = true } = {}) {
            const entry = runs.get(itemID);
            if (!entry || !owner) return false;
            entry.owners.delete(owner);
            if (entry.settled || entry.owners.size > 0 || !abortIfLast) {
                return false;
            }
            abortEntry(entry, CANCELLED);
            return true;
        },

        abort(itemID, reason = CANCELLED) {
            const entry = runs.get(itemID);
            if (!entry) return false;
            abortEntry(entry, reason);
            return true;
        },

        abortAll(reason = 'shutdown') {
            for (const entry of [...runs.values()]) abortEntry(entry, reason);
            runs.clear();
        },

        isActive(itemID) {
            return Boolean(activeEntry(itemID));
        },

        hasOwner(itemID, owner) {
            return Boolean(runs.get(itemID)?.owners.has(owner));
        },
    };

    function activeEntry(itemID) {
        const entry = runs.get(itemID);
        if (!entry || entry.settled || entry.controller.signal.aborted) {
            return null;
        }
        return entry;
    }
}

function abortEntry(entry, reason) {
    if (entry.settled || entry.controller.signal.aborted) return;
    entry.abortReason = reason;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    error.code = reason === REPLACED
        ? 'MKTERO_CONVERSION_REPLACED'
        : 'ABORT_ERR';
    try {
        entry.controller.abort(error);
    }
    catch {
        entry.controller.abort();
    }
}

function storedProgressiveEvents(entry) {
    return [
        ...(entry.provisionalDocument ? [entry.provisionalDocument] : []),
        ...entry.figurePatches,
    ];
}

function emit(entry, event) {
    for (const listener of [...entry.listeners]) {
        try {
            listener(event);
        }
        catch {
            // A progress listener must not affect the conversion.
        }
    }
}

function expose(entry) {
    return {
        get promise() {
            return entry.promise;
        },
        get signal() {
            return entry.controller.signal;
        },
        get abortReason() {
            return entry.abortReason;
        },
    };
}

function validateItemID(itemID) {
    if (!Number.isSafeInteger(itemID) || itemID <= 0) {
        throw new TypeError('A PDF item ID is required');
    }
}

function validateController(controller) {
    if (!controller?.signal || typeof controller.abort !== 'function') {
        throw new TypeError('An AbortController is required');
    }
}
