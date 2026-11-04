const HASH = /^[a-f0-9]{64}$/;
const ITEM_KEY = /^[A-Za-z0-9]{1,32}$/;
const STORES = new Set(['markdown', 'raw', 'revisions', 'pdfIndex', 'readingPosition']);
const MAX_RECORDS = 10_000;
const MAX_ARTIFACTS = 256;
export const ORPHAN_CACHE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

export function attachmentIdentity({ libraryID, attachmentKey }) {
    if (!Number.isSafeInteger(libraryID) || libraryID < 0 || !ITEM_KEY.test(attachmentKey || '')) {
        throw new TypeError('Invalid cache owner');
    }
    return `${libraryID}:${attachmentKey}`;
}

// Only registered resources are candidates. Missing/corrupt ownership data can
// leak disk space, but must never be interpreted as proof of zero references.
export class CacheLifecycle {
    constructor({ storage, snapshot, remove, removeOwner, isBusy = () => false,
        now = Date.now, graceMs = ORPHAN_CACHE_GRACE_MS, onError = () => {} }) {
        Object.assign(this, { storage, snapshot, remove, removeOwner, isBusy, now, graceMs, onError });
        this.tail = Promise.resolve();
        this.sweeping = null;
        this.purging = null;
        this.users = 0;
        this.epoch = 0;
        this.stopped = false;
    }

    invalidate() {
        this.epoch++;
    }

    async use(operation) {
        this.invalidate();
        const pending = this.purging;
        if (pending) await pending;
        this.users++;
        try { return await operation(); }
        finally { this.users--; }
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
            const artifacts = new Map([...previous?.artifacts || [], ...incoming.artifacts]
                .map(artifact => [artifactIdentity(artifact), artifact]));
            const next = normalizeRecord({ ...incoming, artifacts: [...artifacts.values()] });
            if (JSON.stringify(previous) === JSON.stringify(next)) return;
            await this.storage.write([...records.filter(value => recordIdentity(value) !== id), next]);
        });
    }

    sweep() {
        if (this.sweeping) return this.sweeping;
        const pending = this.#enqueue(() => this.#sweep());
        this.sweeping = pending;
        return pending.finally(() => { if (this.sweeping === pending) this.sweeping = null; });
    }

    async dispose() {
        this.stopped = true;
        this.invalidate();
        await this.tail.catch(() => {});
    }

    async #sweep() {
        if (this.#busy()) return { removed: 0 };
        let records = await this.#read();
        if (!records.length) return { removed: 0 };
        const epoch = this.epoch;
        const membership = await this.snapshot({ hashes: false });
        if (!membership.complete || !this.#valid(epoch)) return { removed: 0 };
        const timestamp = this.now();
        const reconciled = records.map(record => ({
            ...record,
            orphanedAt: membership.owners.has(attachmentIdentity(record))
                ? null
                : membership.libraries.has(record.libraryID)
                    ? record.orphanedAt ?? timestamp : null,
        }));
        if (JSON.stringify(reconciled) !== JSON.stringify(records)) {
            await this.storage.write(reconciled);
            records = reconciled;
        }
        const eligible = record => record.orphanedAt !== null
            && timestamp >= record.orphanedAt + this.graceMs
            && !membership.owners.has(attachmentIdentity(record))
            && !membership.itemIDs.has(record.itemID)
            && membership.libraries.has(record.libraryID);
        if (!records.some(eligible) || !this.#valid(epoch)) return { removed: 0 };

        // Include even PDFs never opened in Mktero, in every accessible library
        // and in the trash. Missing files make the scan incomplete, not orphaned.
        const sourceSizes = [...new Set(records.filter(eligible).map(record => record.sourceBytes))];
        const live = await this.snapshot({ hashes: true, sourceSizes });
        if (!live.complete || !this.#valid(epoch)) return { removed: 0 };
        const protectedSources = new Set(live.sources);
        const protectedArtifacts = new Set();
        for (const record of records) {
            if (!eligible(record) || live.owners.has(attachmentIdentity(record))
                || live.itemIDs.has(record.itemID) || !live.libraries.has(record.libraryID)) {
                protectedSources.add(record.sourceHash);
                for (const artifact of record.artifacts) protectedArtifacts.add(artifactIdentity(artifact));
            }
        }
        const candidates = records.filter(record => eligible(record)
            && !protectedSources.has(record.sourceHash)
            && !record.artifacts.some(artifact => protectedArtifacts.has(artifactIdentity(artifact))));
        if (!candidates.length || !this.#valid(epoch)) return { removed: 0 };

        let release;
        this.purging = new Promise(resolve => { release = resolve; });
        let removed = 0;
        try {
            for (const record of candidates) {
                if (!this.#valid(epoch)) break;
                try {
                    for (const artifact of record.artifacts) {
                        if (!this.#valid(epoch)) return { removed };
                        await this.remove(artifact);
                    }
                    if (!this.#valid(epoch)) break;
                    // Item-local annotations and import selections are not
                    // shared. Cleanup is idempotent, including after a crash.
                    await this.removeOwner(record);
                    if (!this.#valid(epoch)) break;
                    const remaining = records.filter(value => recordIdentity(value) !== recordIdentity(record));
                    await this.storage.write(remaining);
                    records = remaining;
                    removed++;
                }
                catch (error) {
                    this.#report(error);
                    // Keep the tombstone and exact resource keys for retry.
                }
            }
        }
        finally {
            this.purging = null;
            release();
        }
        return { removed };
    }

    #busy() {
        return this.stopped || this.users > 0 || this.isBusy();
    }

    #valid(epoch) {
        return epoch === this.epoch && !this.#busy();
    }

    async #read() {
        const records = await this.storage.read();
        if (!Array.isArray(records) || records.length > MAX_RECORDS) throw new Error('Invalid cache ownership index');
        const normalized = records.map(normalizeRecord);
        if (new Set(normalized.map(recordIdentity)).size !== normalized.length) {
            throw new Error('Duplicate cache ownership records');
        }
        return normalized;
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
        || (record.orphanedAt !== null && (!Number.isSafeInteger(record.orphanedAt) || record.orphanedAt < 0))) {
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
    };
}
