const HASH = /^[a-f0-9]{64}$/;
const ITEM_KEY = /^[A-Za-z0-9]{1,32}$/;
const STORES = new Set(['markdown', 'raw', 'revisions', 'pdfIndex', 'readingPosition']);
const MAX_RECORDS = 10_000;
const MAX_ARTIFACTS = 256;

export function attachmentIdentity({ libraryID, attachmentKey }) {
    if (!Number.isSafeInteger(libraryID) || libraryID < 0 || !ITEM_KEY.test(attachmentKey || '')) {
        throw new TypeError('Invalid cache owner');
    }
    return `${libraryID}:${attachmentKey}`;
}

// A scope identifies resources, not a whole store. Unscoped maintenance such as
// clear/prune is exclusive; ordinary reads of another paper do not stop GC.
function scopeKeys(scope) {
    if (!scope) return new Set(['*']);
    const keys = new Set();
    if (Number.isSafeInteger(scope.itemID)) keys.add(`item:${scope.itemID}`);
    if (scope.attachmentKey) keys.add(`owner:${attachmentIdentity(scope)}`);
    if (scope.sourceHash) keys.add(`source:${scope.sourceHash}`);
    for (const artifact of scope.artifacts || []) keys.add(artifactIdentity(artifact));
    return keys.size ? keys : new Set(['*']);
}

function overlaps(a, b) {
    return a.has('*') || b.has('*') || [...a].some(key => b.has(key));
}

// Only registered resources are candidates. Missing/corrupt ownership data can
// leak disk space, but must never be interpreted as proof of zero references.
export class CacheLifecycle {
    constructor({ storage, snapshot, remove, removeOwner, isBusy = () => false,
        now = Date.now, onError = () => {}, onIdle = () => {}, yieldControl = async () => {} }) {
        Object.assign(this, { storage, snapshot, remove, removeOwner, isBusy, now, onError, onIdle, yieldControl });
        this.tail = Promise.resolve();
        this.sweeping = null;
        this.purging = null;
        this.leases = new Set();
        this.itemSources = new Map();
        this.touched = new Set();
        this.deferred = new Map();
        this.epoch = 0;
        this.stopped = false;
    }

    invalidate() {
        this.epoch++;
    }

    async use(operation, scope = null) {
        const keys = this.#expand(scopeKeys(scope));
        if (this.sweeping) for (const key of keys) this.touched.add(key);
        const pending = this.purging;
        if (pending && overlaps(keys, pending.keys)) {
            pending.interrupted = true;
            await pending.promise;
        }
        this.leases.add(keys);
        try { return await operation(); }
        finally {
            this.leases.delete(keys);
            if ([...this.deferred.values()].some(value => overlaps(keys, value))) {
                try { this.onIdle(); } catch (error) { this.#report(error); }
            }
        }
    }

    remember(record) {
        const incoming = normalizeRecord({ ...record, orphanedAt: null });
        this.invalidate();
        return this.#enqueue(async () => {
            const records = await this.#read();
            const id = recordIdentity(incoming);
            const previous = records.find(value => recordIdentity(value) === id);
            if (previous && previous.itemID !== incoming.itemID) {
                throw new Error('Cache owner ID changed; cleanup requires reconciliation');
            }
            const artifacts = new Map([...(previous?.artifacts || []), ...incoming.artifacts]
                .map(artifact => [artifactIdentity(artifact), artifact]));
            const next = normalizeRecord({ ...incoming, artifacts: [...artifacts.values()] });
            if (JSON.stringify(previous) === JSON.stringify(next)) return;
            await this.storage.write([...records.filter(value => recordIdentity(value) !== id), next]);
        });
    }

    sweep(options = {}) {
        if (this.sweeping) return this.sweeping;
        const pending = this.#enqueue(() => this.#sweep(options));
        this.sweeping = pending;
        return pending.finally(() => { if (this.sweeping === pending) this.sweeping = null; });
    }

    async dispose() {
        this.stopped = true;
        this.invalidate();
        await this.tail.catch(() => {});
    }

    async #sweep({ itemIDs = null } = {}) {
        const summary = { removed: 0, ownersRemoved: 0, referenced: 0, busy: 0, unknown: 0,
            errors: 0, interrupted: false, continuation: false, reasons: [], blockers: [] };
        const reason = (code, count = 1) => {
            const entry = summary.reasons.find(value => value.code === code);
            if (entry) entry.count += count;
            else summary.reasons.push({ code, count });
        };
        this.touched.clear();
        this.deferred.clear();
        if (this.stopped) return summary;
        let records = await this.#read();
        if (!records.length) return summary;
        const epoch = this.epoch;
        const membership = await this.snapshot({ hashes: false, generation: epoch });
        if (!membership.complete || !this.#valid(epoch)) {
            summary.unknown = records.length;
            reason('library-unavailable', records.length);
            summary.interrupted = !this.#valid(epoch);
            return summary;
        }
        const pendingRecords = new Set(records.filter(record => record.orphanedAt !== null).map(recordIdentity));
        const reconciled = records.map(record => ({
            ...record,
            // Kept for diagnostics and compatibility with the first ownership
            // index. This timestamp is never an age/retention requirement.
            orphanedAt: membership.owners.has(attachmentIdentity(record))
                ? null
                : membership.libraries.has(record.libraryID)
                    ? record.orphanedAt ?? this.now() : null,
        }));
        if (JSON.stringify(reconciled) !== JSON.stringify(records)) {
            await this.storage.write(reconciled);
            records = reconciled;
        }
        const absent = (record, state) => !state.owners.has(attachmentIdentity(record))
            && !state.itemIDs.has(record.itemID) && state.libraries.has(record.libraryID);
        const selected = record => !itemIDs || itemIDs.has(record.itemID) || pendingRecords.has(recordIdentity(record));
        const eligible = record => record.orphanedAt !== null && absent(record, membership);
        const candidates = records.filter(record => eligible(record) && selected(record));
        if (!candidates.length || !this.#valid(epoch)) {
            summary.interrupted = !this.#valid(epoch);
            return summary;
        }
        const defer = record => {
            const keys = scopeKeys(record);
            if (!this.deferred.has(recordIdentity(record))) summary.busy++;
            this.deferred.set(recordIdentity(record), keys);
            // The conflicting operation may already have finished before we
            // noticed it. In that case there will be no future release signal.
            if (!this.isBusy(record) && ![...this.leases].some(value => overlaps(keys, value))) {
                summary.interrupted = true;
            }
        };

        // Attachment-private records can go even while another owner protects
        // the content. Keep the resource ledger until shared files are released.
        for (const record of candidates) {
            if (!this.#valid(epoch)) { summary.interrupted = true; return summary; }
            if (this.#busy(record)) { defer(record); continue; }
            if (record.ownerCleaned) continue;
            try {
                let updated = null;
                const cleaned = await this.#purge(record, epoch, async valid => {
                    await this.removeOwner(record);
                    if (!valid()) return;
                    const next = { ...record, ownerCleaned: true };
                    updated = records.map(value => recordIdentity(value) === recordIdentity(record) ? next : value);
                    await this.storage.write(updated);
                }, async () => { if (updated) await this.storage.write(records); });
                if (!cleaned) { defer(record); continue; }
                records = updated;
                record.ownerCleaned = true;
                summary.ownersRemoved++;
            }
            catch (error) { summary.errors++; reason('cleanup-failed'); this.#report(error); }
            await this.yieldControl();
        }
        const available = candidates.filter(record => {
            if (!record.ownerCleaned) return false;
            if (this.#busy(record)) { defer(record); return false; }
            return true;
        });
        if (!available.length || !this.#valid(epoch)) {
            summary.interrupted ||= !this.#valid(epoch);
            return summary;
        }
        const sourceSizes = [...new Set(available.map(record => record.sourceBytes))];
        const live = await this.snapshot({ hashes: true, sourceSizes, candidates: available, generation: epoch });
        if (!live.complete || !this.#valid(epoch)) {
            summary.continuation = Boolean(live.continuation) && this.#valid(epoch);
            summary.unknown += summary.continuation ? 0 : available.length;
            if (!summary.continuation) reason('library-unavailable', available.length);
            summary.interrupted = !this.#valid(epoch);
            return summary;
        }
        const protectedSources = new Set(live.sources);
        const protectedArtifacts = new Set();
        for (const record of records) {
            if (!absent(record, live)) {
                protectedSources.add(record.sourceHash);
                for (const artifact of record.artifacts) protectedArtifacts.add(artifactIdentity(artifact));
            }
        }
        for (const record of available) {
            if (!this.#valid(epoch)) { summary.interrupted = true; break; }
            if (this.#busy(record)) { defer(record); continue; }
            if (!absent(record, live) || protectedSources.has(record.sourceHash)
                || record.artifacts.some(artifact => protectedArtifacts.has(artifactIdentity(artifact)))) {
                summary.referenced++;
                continue;
            }
            const blocked = [...(live.uncertainSources?.get(record.sourceHash) || []),
                ...(live.uncertainSources?.get('*') || [])];
            if (blocked.length) {
                summary.unknown++;
                for (const code of new Set(blocked.map(value => value.reason))) reason(code);
                for (const blocker of blocked) {
                    if (summary.blockers.length >= 10) break;
                    if (!summary.blockers.some(value => value.itemID === blocker.itemID && value.reason === blocker.reason)) {
                        summary.blockers.push(blocker);
                    }
                }
                continue;
            }
            try {
                let remaining = null;
                const cleaned = await this.#purge(record, epoch, async valid => {
                    for (const artifact of record.artifacts) {
                        if (!valid()) return;
                        await this.remove(artifact);
                    }
                    if (!valid()) return;
                    remaining = records.filter(value => recordIdentity(value) !== recordIdentity(record));
                    await this.storage.write(remaining);
                }, async () => { if (remaining) await this.storage.write(records); });
                if (!cleaned) { defer(record); continue; }
                records = remaining;
                summary.removed++;
            }
            catch (error) { summary.errors++; reason('cleanup-failed'); this.#report(error); }
            await this.yieldControl();
        }
        return summary;
    }

    async #purge(record, epoch, operation, rollback = async () => {}) {
        let release;
        const pending = { keys: scopeKeys(record), interrupted: false,
            promise: new Promise(resolve => { release = resolve; }) };
        this.purging = pending;
        const valid = () => this.#valid(epoch) && !pending.interrupted && !this.#busy(record);
        try {
            if (!valid()) return false;
            try { await operation(valid); }
            catch (error) { await rollback(); throw error; }
            if (!valid()) { await rollback(); return false; }
            // No await between this final decision and releasing the lease:
            // a write arriving during commit must see the restored ledger.
            return true;
        }
        finally { this.purging = null; release(); }
    }

    #busy(record) {
        const keys = scopeKeys(record);
        return this.isBusy(record) || overlaps(keys, this.touched)
            || [...this.leases].some(value => overlaps(keys, value));
    }

    #valid(epoch) {
        return epoch === this.epoch && !this.stopped;
    }

    async #read() {
        let records;
        try { records = normalizeCacheOwnership(await this.storage.read()); }
        catch (cause) {
            const error = new Error('Cache ownership index is corrupt or unavailable', { cause });
            error.cleanupReason = 'index-unavailable';
            throw error;
        }
        this.itemSources.clear();
        for (const record of records) {
            const sources = this.itemSources.get(record.itemID) || new Set();
            sources.add(record.sourceHash);
            this.itemSources.set(record.itemID, sources);
        }
        for (const keys of this.leases) this.#expand(keys);
        this.#expand(this.touched);
        return records;
    }

    #expand(keys) {
        for (const key of keys) {
            if (!key.startsWith('item:')) continue;
            for (const hash of this.itemSources.get(Number(key.slice(5))) || []) keys.add(`source:${hash}`);
        }
        return keys;
    }

    #enqueue(operation) {
        const pending = this.tail.catch(() => {}).then(operation);
        this.tail = pending;
        return pending;
    }

    #report(error) {
        try { this.onError(error); }
        catch { /* Diagnostics must not interrupt cleanup retries. */ }
    }
}

function recordIdentity(record) {
    return `${attachmentIdentity(record)}:${record.sourceHash}`;
}

function artifactIdentity({ store, key }) {
    return `${store}:${key}`;
}

export function normalizeCacheOwnership(records) {
    if (!Array.isArray(records) || records.length > MAX_RECORDS) throw new Error('Cache ownership limit exceeded');
    const normalized = records.map(normalizeRecord);
    if (new Set(normalized.map(recordIdentity)).size !== normalized.length) throw new Error('Duplicate cache owners');
    return normalized;
}

function normalizeRecord(record) {
    attachmentIdentity(record);
    if (!Number.isSafeInteger(record.itemID) || record.itemID <= 0
        || !HASH.test(record.sourceHash || '')
        || !Number.isSafeInteger(record.sourceBytes) || record.sourceBytes < 1
        || record.sourceBytes > 256 * 1024 * 1024
        || !Array.isArray(record.artifacts) || record.artifacts.length > MAX_ARTIFACTS
        || (record.orphanedAt !== null && (!Number.isSafeInteger(record.orphanedAt) || record.orphanedAt < 0))
        || (record.ownerCleaned !== undefined && typeof record.ownerCleaned !== 'boolean')) {
        throw new TypeError('Invalid cache ownership record');
    }
    const artifacts = record.artifacts.map(({ store, key }) => {
        if (!STORES.has(store) || !HASH.test(key || '')) throw new TypeError('Invalid owned cache resource');
        return { store, key };
    });
    return {
        libraryID: record.libraryID, attachmentKey: record.attachmentKey,
        itemID: record.itemID, sourceHash: record.sourceHash, sourceBytes: record.sourceBytes,
        artifacts: [...new Map(artifacts.map(value => [artifactIdentity(value), value])).values()],
        orphanedAt: record.orphanedAt,
        ...(record.ownerCleaned ? { ownerCleaned: true } : {}),
    };
}
