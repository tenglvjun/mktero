import { createRuntimeAbortController } from '../platform/abort-controller.js';
import { extractMinerUResultFromZip } from '../mineru/zip-markdown.js';
import { tryCreateMinerUResultArchive } from '../mineru/result-archive.js';
import { MINERU_REQUEST_PROFILE_ID } from '../mineru/parser-profile.js';

const NETWORK_STATES = new Set(['running', 'publishing']);

// This identity is deliberately independent of item IDs, presentation profiles,
// filenames, cache preferences and credentials. A missing hash never coalesces.
export function createSharedConversionKey({
    apiBase, scope, requestProfile = MINERU_REQUEST_PROFILE_ID, sourceHash, byteLength,
}) {
    if (!/^[a-f\d]{64}$/i.test(sourceHash || '')) return null;
    const base = new URL(apiBase);
    if (!['http:', 'https:'].includes(base.protocol)
        || base.username || base.password || base.search || base.hash) {
        throw new TypeError('A valid conversion API base is required');
    }
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
        throw new TypeError('A PDF byte length is required');
    }
    return JSON.stringify([
        'mktero-shared-v1', base.toString().replace(/\/+$/, ''), String(scope || ''),
        'mktero', requestProfile, sourceHash.toLowerCase(), byteLength,
    ]);
}

/** One instance per runtime. Leases last through attachment processing, not
 * just the network promise. Run signals identify generations, never roles. */
export class SharedMkteroConversion {
    constructor({
        conversion,
        getScope = () => '',
        resultStore = null,
        extractStoredResult = extractMinerUResultFromZip,
        keepArchive = tryCreateMinerUResultArchive,
        createController = createRuntimeAbortController,
        assertPageLimit = null,
        onCacheError = () => {},
        onConversionSettled = () => {},
        stopTimeoutMs = 2500,
    }) {
        if (typeof conversion?.convert !== 'function') throw new TypeError('A conversion client is required');
        this.conversion = conversion;
        this.getScope = getScope;
        this.resultStore = resultStore;
        this.extractStoredResult = extractStoredResult;
        this.keepArchive = keepArchive;
        this.createController = createController;
        this.assertPageLimit = assertPageLimit;
        this.onCacheError = onCacheError;
        this.onConversionSettled = onConversionSettled;
        this.stopTimeoutMs = stopTimeoutMs;
        this.entries = new Map();
        this.liveEntries = new Set();
        this.runHolds = new WeakMap();
        this.waiters = new Set();
        this.publications = new Map();
        this.pendingPersistence = new Set();
        this.serial = 0;
        this.disposed = false;
    }

    acquire(options) {
        if (this.disposed) throw cancelled();
        throwIfAborted(options.signal);
        const scope = options.scope ?? this.getScope();
        if (scope !== this.getScope()) throw scopeChanged();
        const key = createSharedConversionKey({
            ...options, scope, byteLength: options.fileData.byteLength,
        }) || Symbol('unshared-pdf');
        const pins = [...(this.runHolds.get(options.signal) || [])]
            .filter(hold => hold.kind === 'reservation');
        const reserved = pins.find(pin => pin.entry.key === key && pin.entry.scope === scope);
        for (const pin of pins) if (pin !== reserved) pin.release();
        let entry = reserved?.entry || this.entries.get(key);
        if (entry?.state === 'stopping'
            || (!reserved && entry?.state === 'failed' && !entry.finished)) {
            return this._waitForStop(entry, options);
        }
        if (entry && (entry.state === 'disposed'
            || (!reserved && entry.state === 'failed')
            || (!reserved && entry.state === 'ready'
                && (options.forceRefresh || (!options.cacheEnabled && entry.origin === 'cache'))))) {
            entry = null;
        }
        if (!entry) entry = this._createEntry(key, { ...options, scope });
        // A late participant can enable persistence, without changing identity.
        if (options.resultKey && !entry.resultKey) entry.resultKey = options.resultKey;
        const lease = this._join(entry, options);
        // Acquire the replacement before releasing the last temporary owner.
        for (const pin of pins) pin.release();
        return lease;
    }

    captureCachePublication({ sourceHash, byteLength, signal }) {
        const key = publicationKey({ sourceHash, byteLength });
        const publication = this._publication(key);
        const generation = publication.latest;
        const permitted = publication.entries.size === 0;
        let active = true;
        const hold = {
            canPublish: () => active && permitted && !this.disposed && !signal?.aborted
                && publication.latest === generation && publication.entries.size === 0,
            release: () => {
                if (!active) return;
                active = false;
                signal?.removeEventListener('abort', hold.release);
                publication.readers.delete(hold);
                this._releasePublication(key, publication);
            },
        };
        publication.readers.add(hold);
        signal?.addEventListener('abort', hold.release, { once: true });
        if (signal?.aborted) hold.release();
        return hold;
    }

    reserveReplacement(previousSignal, nextSignal) {
        if (this.disposed || nextSignal?.aborted || !nextSignal) return false;
        const previous = [...(this.runHolds.get(previousSignal) || [])].find(hold => (
            hold.entry?.scope === this.getScope()
            && hold.entry.origin === 'network'
            && (NETWORK_STATES.has(hold.entry.state)
                || (hold.kind === 'reservation' && hold.entry.state === 'ready'))
        ));
        if (!previous) return false;
        const entry = previous.entry;
        const pin = { kind: 'reservation', entry, active: true, release: null };
        pin.release = () => {
            if (!pin.active) return;
            pin.active = false;
            this._untrack(nextSignal, pin);
            entry.pins.delete(pin);
            this._releaseEntry(entry);
        };
        entry.pins.add(pin);
        this._track(nextSignal, pin);
        return true;
    }

    releaseRun(signal) {
        for (const hold of [...(this.runHolds.get(signal) || [])]) hold.release();
    }

    invalidateScope() {
        const scope = this.getScope();
        for (const entry of [...this.liveEntries]) {
            if (entry.scope !== scope) this._stop(entry, scopeChanged());
        }
    }

    dispose() {
        this.disposed = true;
        const entries = [...this.liveEntries];
        for (const waiter of [...this.waiters]) waiter.release();
        for (const entry of entries) this._stop(entry, cancelled());
        for (const publication of [...this.publications.values()]) {
            for (const reader of [...publication.readers]) reader.release();
        }
        return Promise.all([
            ...entries.map(entry => entry.done),
            bounded(Promise.all([...this.pendingPersistence]), this.stopTimeoutMs),
        ]);
    }

    _publication(key) {
        let publication = this.publications.get(key);
        if (!publication) {
            publication = { latest: 0, entries: new Set(), readers: new Set() };
            this.publications.set(key, publication);
        }
        return publication;
    }

    _releasePublication(key, publication) {
        if (!publication.entries.size && !publication.readers.size) this.publications.delete(key);
    }

    _createEntry(key, options) {
        const sharedPublicationKey = publicationKey({
            ...options, byteLength: options.fileData.byteLength,
        });
        const publication = this._publication(sharedPublicationKey);
        const entry = {
            key, scope: options.scope, generation: ++this.serial, options,
            controller: this.createController(), state: 'checking', origin: null,
            members: new Set(), pins: new Set(), lastProgress: null,
            resultKey: options.resultKey, value: null, error: null,
            publicationKey: sharedPublicationKey, publication, cleanup: Promise.resolve(), finished: false,
            scopeCheck: options.assertScope, transportDone: Promise.resolve(), persistence: null,
        };
        // Claim publication with the generation, before asynchronous work. A
        // failed replacement does not grant an older run permission to write.
        publication.latest = entry.generation;
        publication.entries.add(entry);
        this.liveEntries.add(entry);
        // Claim before any cache I/O or token lookup can yield.
        this.entries.set(key, entry);
        entry.done = Promise.resolve().then(() => this._run(entry)).catch(error => {
            entry.error = error;
            if (entry.state !== 'stopping') entry.state = 'failed';
            for (const member of entry.members) member.reject(error);
        }).then(async () => {
            // A transport that ignores abort must not hold this key forever.
            // Its late job response can still use onCleanup for best-effort DELETE.
            await bounded(Promise.all([
                entry.transportDone.then(() => entry.cleanup), entry.persistence,
            ]), this.stopTimeoutMs);
            entry.finished = true;
            entry.scopeCheck = null;
            this._releaseEntry(entry);
        });
        return entry;
    }

    _join(entry, options) {
        let resolve;
        let reject;
        const result = new Promise((yes, no) => { resolve = yes; reject = no; });
        // A run can be aborted before its caller gets as far as awaiting result.
        void result.catch(() => {});
        const member = {
            kind: 'lease', entry, active: true, pending: true,
            forceRefresh: Boolean(options.forceRefresh), cacheEnabled: Boolean(options.cacheEnabled),
            onProgress: options.onProgress,
            reject(error) {
                if (!member.pending) return;
                member.pending = false;
                reject(error);
            },
            release: reason => {
                if (!member.active) return;
                member.active = false;
                member.reject(reason || abortReason(options.signal));
                this._untrack(options.signal, member);
                entry.members.delete(member);
                this._releaseEntry(entry);
            },
            deliver: () => {
                if (!member.active || !member.pending) return;
                try {
                    const value = this._copyResult(entry.value);
                    member.pending = false;
                    resolve(value);
                }
                catch (error) { member.reject(error); }
            },
        };
        entry.members.add(member);
        this._track(options.signal, member);
        if (entry.state === 'ready') {
            void this._persist(entry).then(() => {
                if (entry.controller.signal.aborted) member.reject(abortReason(entry.controller.signal));
                else member.deliver();
            });
        }
        else if (entry.state === 'failed') member.reject(entry.error);
        else {
            if (entry.state === 'publishing') void this._persist(entry);
            if (member.active && entry.lastProgress) safeCall(member.onProgress, ...entry.lastProgress);
        }
        return {
            result,
            release: member.release,
            canPublish: () => member.active && this._canPublish(entry),
        };
    }

    _waitForStop(entry, options) {
        let delegate = null;
        let resolve;
        let reject;
        const result = new Promise((yes, no) => { resolve = yes; reject = no; });
        void result.catch(() => {});
        const waiting = { kind: 'waiting', active: true, release: reason => {
            if (!waiting.active) return;
            waiting.active = false;
            this._untrack(options.signal, waiting);
            this.waiters.delete(waiting);
            delegate?.release(reason);
            reject(reason || abortReason(options.signal));
        } };
        this.waiters.add(waiting);
        this._track(options.signal, waiting);
        void entry.done.then(() => {
            if (!waiting.active) return;
            try {
                delegate = this.acquire(options);
                delegate.result.then(resolve, error => waiting.release(error));
            }
            catch (error) { waiting.release(error); }
        });
        return { result, release: waiting.release,
            canPublish: () => waiting.active && Boolean(delegate?.canPublish()) };
    }

    async _run(entry) {
        const { options, controller } = entry;
        const signal = controller.signal;
        this._assertEntry(entry);
        let value = null;
        if (this._canReadCache(entry) && entry.resultKey && this.resultStore) {
            try {
                const stored = await abortable(this.resultStore.get(entry.resultKey, { signal }), signal);
                this._assertEntry(entry);
                if (stored && this._canReadCache(entry)) {
                    const result = this.extractStoredResult(stored.archive);
                    value = {
                        result: { ...result,
                            ...(stored.extractedPages != null ? { extractedPages: stored.extractedPages } : {}),
                            ...(stored.totalPages != null ? { totalPages: stored.totalPages } : {}) },
                        rawArchive: stored.archive, origin: 'cache', warnings: [],
                    };
                }
            }
            catch (error) {
                this._assertEntry(entry);
                safeCall(this.onCacheError, error);
                if (entry.generation >= entry.publication.latest) {
                    await abortable(Promise.resolve(this.resultStore.delete?.(entry.resultKey)).catch(() => {}), signal);
                }
            }
        }
        if (!value) {
            entry.state = 'running';
            entry.origin = 'network';
            try {
                if (this.assertPageLimit) {
                    await abortable(this.assertPageLimit(options.fileData, { signal }), signal);
                }
                this._assertEntry(entry);
                const transport = this.conversion.convert({
                    apiBase: options.apiBase,
                    getAccessToken: options.getAccessToken,
                    fileName: options.fileName,
                    fileData: options.fileData,
                    sourceHash: options.sourceHash,
                    idempotencyKey: operationID(),
                    includeRawArchive: true,
                    // Cleanup uses its own signal: cancellation of the task must
                    // not prohibit DELETE, but changing accounts still must.
                    assertScope: () => this._assertScope(entry),
                    beforeCreate: options.beforeCreate,
                    signal,
                    onProgress: (...progress) => this._progress(entry, progress),
                    onCleanup: cleanup => { entry.cleanup = Promise.resolve(cleanup).catch(() => {}); },
                });
                entry.transportDone = Promise.resolve(transport).then(() => {}, () => {});
                value = await abortable(transport, signal);
            }
            finally { safeCall(this.onConversionSettled); }
            this._assertEntry(entry);
            entry.state = 'publishing';
            entry.value = value;
            const persistence = this._persist(entry);
            await abortable(persistence, signal);
            // A caller may enable caching while the first no-op promise yields.
            if (entry.persistence && entry.persistence !== persistence) {
                await abortable(entry.persistence, signal);
            }
        }
        this._assertEntry(entry);
        entry.origin = value.origin;
        entry.value = value;
        entry.state = 'ready';
        entry.lastProgress = null;
        // The PDF remains owned by each attachment, not by the shared download.
        entry.options = null;
        for (const member of entry.members) member.deliver();
    }

    _persist(entry) {
        if (entry.persistence) return entry.persistence;
        if (entry.origin !== 'network' || !entry.value || !this.resultStore || !entry.resultKey
            || ![...entry.members].some(member => member.cacheEnabled) || !this._canPublish(entry)) {
            return Promise.resolve();
        }
        // A ready generation can gain its first cache-enabled participant. It
        // still owns at most one archive write, guarded at the store's commit.
        entry.persistence = Promise.resolve().then(async () => {
            try {
                const value = entry.value;
                const archive = value?.resultArchive || (value?.rawArchive && this.keepArchive(value.rawArchive));
                if (archive && this._canPublish(entry)) {
                    await this.resultStore.put(entry.resultKey, {
                        archive, provider: 'mktero',
                        extractedPages: value.result?.extractedPages,
                        totalPages: value.result?.totalPages,
                    }, { signal: entry.controller.signal, canCommit: () => this._canPublish(entry) });
                }
            }
            catch (error) {
                if (!entry.controller.signal.aborted) safeCall(this.onCacheError, error);
            }
        });
        this.pendingPersistence.add(entry.persistence);
        void entry.persistence.then(() => this.pendingPersistence.delete(entry.persistence));
        return entry.persistence;
    }

    _copyResult(value) {
        const { rawArchive, resultArchive, result, ...rest } = value;
        const archive = rawArchive;
        return {
            ...cloneValue(rest),
            result: archive ? {
                ...this.extractStoredResult(archive),
                ...(result?.extractedPages != null ? { extractedPages: result.extractedPages } : {}),
                ...(result?.totalPages != null ? { totalPages: result.totalPages } : {}),
            } : cloneValue(result),
        };
    }

    _canReadCache(entry) {
        return entry.members.size > 0 && [...entry.members].every(member => (
            member.cacheEnabled && !member.forceRefresh
        ));
    }

    _assertEntry(entry) {
        throwIfAborted(entry.controller.signal);
        this._assertScope(entry);
    }

    _assertScope(entry) {
        if (entry.scope !== this.getScope()) throw scopeChanged();
        entry.scopeCheck?.();
    }

    _canPublish(entry) {
        return !this.disposed && entry.state !== 'disposed'
            && (entry.members.size > 0 || entry.pins.size > 0)
            && !entry.controller.signal.aborted && entry.scope === this.getScope()
            && entry.publication.latest === entry.generation;
    }

    _progress(entry, progress) {
        if (entry.controller.signal.aborted || !NETWORK_STATES.has(entry.state)
            || entry.scope !== this.getScope()) return;
        entry.lastProgress = progress;
        for (const member of entry.members) safeCall(member.onProgress, ...progress);
    }

    _track(signal, hold) {
        if (!signal) return;
        let holds = this.runHolds.get(signal);
        if (!holds) this.runHolds.set(signal, holds = new Set());
        holds.add(hold);
        hold.onAbort = () => hold.release(abortReason(signal));
        signal.addEventListener('abort', hold.onAbort, { once: true });
        if (signal.aborted) hold.onAbort();
    }

    _untrack(signal, hold) {
        if (!signal) return;
        signal.removeEventListener('abort', hold.onAbort);
        const holds = this.runHolds.get(signal);
        holds?.delete(hold);
        if (!holds?.size) this.runHolds.delete(signal);
    }

    _stop(entry, reason) {
        if (entry.state === 'disposed') return;
        entry.state = 'stopping';
        if (!entry.controller.signal.aborted) entry.controller.abort(reason);
        for (const member of [...entry.members]) member.release(reason);
        for (const pin of [...entry.pins]) pin.release();
        this._releaseEntry(entry);
    }

    _releaseEntry(entry) {
        if (entry.members.size || entry.pins.size || entry.state === 'disposed') return;
        if (!entry.finished) {
            if (entry.state !== 'ready' && entry.state !== 'failed' && entry.state !== 'stopping') {
                entry.state = 'stopping';
                entry.controller.abort(cancelled());
            }
            return;
        }
        entry.state = 'disposed';
        if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
        this.liveEntries.delete(entry);
        entry.publication.entries.delete(entry);
        this._releasePublication(entry.publicationKey, entry.publication);
        entry.value = null;
        entry.options = null;
        entry.lastProgress = null;
    }
}

function publicationKey({ sourceHash, byteLength, requestProfile = MINERU_REQUEST_PROFILE_ID }) {
    if (!/^[a-f\d]{64}$/i.test(sourceHash || '')) return Symbol('unshared-publication');
    return JSON.stringify(['mktero', requestProfile, sourceHash.toLowerCase(), byteLength]);
}

function operationID() {
    return globalThis.crypto?.randomUUID?.()
        || `mktero-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function cloneValue(value) {
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Uint8Array) return value.slice();
    if (value instanceof ArrayBuffer) return value.slice(0);
    if (Array.isArray(value)) return value.map(cloneValue);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
}

function safeCall(callback, ...args) {
    try { callback?.(...args); }
    catch { /* Observers never own the shared operation. */ }
}

function cancelled() {
    return Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function scopeChanged() {
    return Object.assign(new Error('The conversion account or provider changed'), {
        code: 'MKTERO_QUOTA_ACCOUNT_CHANGED',
    });
}

function abortReason(signal) {
    return signal?.reason instanceof Error ? signal.reason : cancelled();
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw abortReason(signal);
}

function abortable(promise, signal) {
    return new Promise((resolve, reject) => {
        const finish = (callback, value) => {
            signal.removeEventListener('abort', abort);
            callback(value);
        };
        const abort = () => finish(reject, abortReason(signal));
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(promise).then(
            value => finish(resolve, value), error => finish(reject, error)
        );
        if (signal.aborted) abort();
    });
}

function bounded(promise, milliseconds) {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, milliseconds);
        Promise.resolve(promise).catch(() => {}).then(() => {
            clearTimeout(timer);
            resolve();
        });
    });
}
