import {
    createLLMCacheRawKey,
    LLM_CACHE_ADAPTER_VERSION,
} from '../mineru/llm-cache-profile.js';
import { throwIfFigureAborted } from '../figures/figure-async.js';

const SCHEMA_VERSION = 1;
const MAX_ENTRIES = 1_000;
const MAX_BYTES = 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const ATTACHMENT_KEY = /^[A-Za-z0-9]{1,32}$/;
const SOURCE_FORMATS = new Set(['v2', 'legacy', 'missing', 'content-list', 'layout']);

export class MinerUImportIndexError extends Error {
    constructor(code, message, cause = null) {
        super(message);
        this.name = 'MinerUImportIndexError';
        this.code = code;
        if (cause) this.cause = cause;
    }
}

export function createZoteroMinerUImportIndex({ zotero, ioUtils, pathUtils }) {
    const profilePath = zotero?.Profile?.dir;
    if (!profilePath) throw new Error('The Zotero profile directory is unavailable');
    return new MinerUImportIndex({
        rootPath: pathUtils.join(profilePath, 'mktero-imports', 'v1'),
        ioUtils,
        pathUtils,
    });
}

export class MinerUImportIndex {
    constructor({
        adapter = null,
        rootPath = null,
        ioUtils = null,
        pathUtils = null,
        maxEntries = MAX_ENTRIES,
        maxBytes = MAX_BYTES,
    } = {}) {
        if (!adapter) {
            if (!rootPath || !ioUtils || !pathUtils) {
                throw new TypeError('An imported MinerU index adapter or Zotero file adapters are required');
            }
            adapter = createFileAdapter(rootPath, ioUtils, pathUtils, Math.min(maxBytes, MAX_BYTES));
        }
        if (typeof adapter.read !== 'function' || typeof adapter.write !== 'function') {
            throw new TypeError('An imported MinerU index read/write adapter is required');
        }
        if (!Number.isSafeInteger(maxEntries) || maxEntries < 1
            || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
            throw new TypeError('Imported MinerU index limits must be positive integers');
        }
        this.adapter = adapter;
        this.maxEntries = Math.min(maxEntries, MAX_ENTRIES);
        this.maxBytes = Math.min(maxBytes, MAX_BYTES);
        this.records = null;
        this.serialized = null;
        this.loadError = null;
        this.operationTail = Promise.resolve();
    }

    load({ signal } = {}) {
        return this.#withOperation(async () => {
            await this.#load(signal);
            return this.records.map(record => ({ ...record }));
        });
    }

    get(identity, { signal } = {}) {
        const key = selectionKey(identity);
        return this.#withOperation(async () => {
            await this.#ensureLoaded(signal);
            const record = this.records.find(candidate => selectionKey(candidate) === key);
            return record ? { ...record } : null;
        });
    }

    selectionsForAttachment({ libraryID, attachmentKey } = {}, { signal } = {}) {
        validateAttachment(libraryID, attachmentKey);
        return this.#withOperation(async () => {
            await this.#ensureLoaded(signal);
            return this.records.filter(record => (
                record.libraryID === libraryID && record.attachmentKey === attachmentKey
            )).map(record => ({ ...record }));
        });
    }

    peekForAttachment({ libraryID, attachmentKey } = {}) {
        validateAttachment(libraryID, attachmentKey);
        if (this.loadError) throw this.loadError;
        const latest = (this.records || []).filter(record => (
            record.libraryID === libraryID && record.attachmentKey === attachmentKey
        )).reduce((found, candidate) => (
            !found || candidate.importedAt >= found.importedAt ? candidate : found
        ), null);
        return latest ? { ...latest } : null;
    }

    publish(record, { signal } = {}) {
        return this.#withOperation(async () => {
            await this.#ensureLoaded(signal);
            const normalized = await normalizeRecord(record);
            throwIfFigureAborted(signal);
            const key = selectionKey(normalized);
            const previous = this.records.find(candidate => selectionKey(candidate) === key);
            if (previous && normalized.importedAt <= previous.importedAt) {
                // Two imports may finish in one clock tick; conditional deletion
                // still needs to distinguish their publication order.
                normalized.importedAt = previous.importedAt + 1;
                if (!Number.isSafeInteger(normalized.importedAt)) throw invalidIndex('The imported MinerU publication time is invalid');
            }
            const records = this.records.filter(candidate => selectionKey(candidate) !== key);
            records.push(normalized);
            await this.#save(records, signal);
            return { ...normalized };
        });
    }

    forget(identity, { signal, expectedRecord = null } = {}) {
        const key = selectionKey(identity);
        return this.#withOperation(async () => {
            await this.#ensureLoaded(signal);
            const current = this.records.find(record => selectionKey(record) === key);
            if (!current || expectedRecord && !samePublication(current, expectedRecord)) return false;
            await this.#save(this.records.filter(record => selectionKey(record) !== key), signal);
            return true;
        });
    }

    forgetAttachment({ libraryID, attachmentKey }, { signal } = {}) {
        validateAttachment(libraryID, attachmentKey);
        return this.#withOperation(async () => {
            await this.#ensureLoaded(signal);
            const records = this.records.filter(record => record.libraryID !== libraryID
                || record.attachmentKey !== attachmentKey);
            if (records.length === this.records.length) return false;
            await this.#save(records, signal);
            return true;
        });
    }

    async #ensureLoaded(signal) {
        throwIfFigureAborted(signal);
        if (this.loadError) throw this.loadError;
        if (this.records === null) await this.#load(signal);
        throwIfFigureAborted(signal);
    }

    async #load(signal) {
        throwIfFigureAborted(signal);
        try {
            const serialized = await this.adapter.read({ signal });
            throwIfFigureAborted(signal);
            if (serialized === null || serialized === undefined) {
                this.records = [];
                this.serialized = null;
                this.loadError = null;
                return;
            }
            if (typeof serialized !== 'string' || new TextEncoder().encode(serialized).length > this.maxBytes) {
                throw invalidIndex('The imported MinerU index exceeds its byte limit');
            }
            const parsed = JSON.parse(serialized);
            if (parsed?.schemaVersion !== SCHEMA_VERSION) {
                throw new MinerUImportIndexError('LLM_CACHE_IMPORT_INDEX_UNSUPPORTED', 'The imported MinerU index version is unsupported');
            }
            if (!Array.isArray(parsed.records) || parsed.records.length > this.maxEntries) {
                throw invalidIndex('The imported MinerU index exceeds its entry limit');
            }
            const records = [];
            const keys = new Set();
            for (const raw of parsed.records) {
                throwIfFigureAborted(signal);
                const record = await normalizeRecord(raw);
                const key = selectionKey(record);
                if (keys.has(key)) throw invalidIndex('The imported MinerU index contains duplicate selections');
                keys.add(key);
                records.push(record);
            }
            throwIfFigureAborted(signal);
            this.records = records;
            this.serialized = serialized;
            this.loadError = null;
        }
        catch (error) {
            if (signal?.aborted || error?.name === 'AbortError') throw error;
            this.loadError = error instanceof MinerUImportIndexError
                ? error : invalidIndex('The imported MinerU index could not be read', error);
            throw this.loadError;
        }
    }

    async #save(records, signal) {
        throwIfFigureAborted(signal);
        if (records.length > this.maxEntries) {
            throw new MinerUImportIndexError('LLM_CACHE_IMPORT_INDEX_FULL', 'The imported MinerU index has reached its entry limit');
        }
        const serialized = JSON.stringify({ schemaVersion: SCHEMA_VERSION, records });
        if (new TextEncoder().encode(serialized).length > this.maxBytes) {
            throw new MinerUImportIndexError('LLM_CACHE_IMPORT_INDEX_FULL', 'The imported MinerU index exceeds its byte limit');
        }
        throwIfFigureAborted(signal);
        try {
            await this.adapter.write(serialized, { signal });
            throwIfFigureAborted(signal);
        }
        catch (error) {
            await this.#restore();
            throwIfFigureAborted(signal);
            if (error?.name === 'AbortError') throw error;
            throw new MinerUImportIndexError('LLM_CACHE_IMPORT_INDEX_WRITE_FAILED', 'The imported MinerU selection could not be saved', error);
        }
        // This synchronous checkpoint commits both views. Cancellation observed
        // before it restores the previous disk contents while holding the queue.
        this.records = records;
        this.serialized = serialized;
    }

    async #restore() {
        try {
            if ((await this.adapter.read() ?? null) === this.serialized) return;
        }
        catch {
            // A partial write can also make the index unreadable; restore it.
        }
        try {
            // Recovery must finish even if the caller's signal is already aborted.
            const serialized = this.serialized ?? JSON.stringify({ schemaVersion: SCHEMA_VERSION, records: this.records });
            await this.adapter.write(serialized);
            this.serialized = serialized;
        }
        catch (error) {
            this.loadError = new MinerUImportIndexError('LLM_CACHE_IMPORT_INDEX_WRITE_FAILED', 'The imported MinerU selection could not be restored', error);
            throw this.loadError;
        }
    }

    #withOperation(operation) {
        const pending = this.operationTail.catch(() => {}).then(operation);
        this.operationTail = pending;
        return pending.finally(() => {
            if (this.operationTail === pending) this.operationTail = Promise.resolve();
        });
    }
}

function selectionKey(identity) {
    validateAttachment(identity?.libraryID, identity?.attachmentKey);
    if (typeof identity?.sourceHash !== 'string' || !HASH.test(identity.sourceHash)) {
        throw invalidIndex('An imported MinerU selection identity needs a PDF source hash');
    }
    return JSON.stringify([identity.libraryID, identity.attachmentKey, identity.sourceHash]);
}

function validateAttachment(libraryID, attachmentKey) {
    if (!Number.isSafeInteger(libraryID) || libraryID < 0
        || typeof attachmentKey !== 'string' || !ATTACHMENT_KEY.test(attachmentKey)) {
        throw invalidIndex('The imported MinerU attachment identity is invalid');
    }
}

async function normalizeRecord(record) {
    selectionKey(record);
    if (record?.adapterVersion !== LLM_CACHE_ADAPTER_VERSION) {
        throw new MinerUImportIndexError('LLM_CACHE_IMPORT_INDEX_UNSUPPORTED', 'The imported MinerU adapter version is unsupported');
    }
    if (typeof record.snapshotHash !== 'string' || !HASH.test(record.snapshotHash)
        || typeof record.rawKey !== 'string' || !HASH.test(record.rawKey)
        || !Number.isSafeInteger(record.importedAt) || record.importedAt < 0
        || record.binding !== 'user-confirmed'
        || record.sourceFormat !== undefined && !SOURCE_FORMATS.has(record.sourceFormat)) {
        throw invalidIndex('The imported MinerU selection record is invalid');
    }
    if (await createLLMCacheRawKey(record) !== record.rawKey) {
        throw invalidIndex('The imported MinerU result key does not match its identity');
    }
    return {
        libraryID: record.libraryID,
        attachmentKey: record.attachmentKey,
        sourceHash: record.sourceHash,
        snapshotHash: record.snapshotHash,
        rawKey: record.rawKey,
        adapterVersion: record.adapterVersion,
        importedAt: record.importedAt,
        binding: 'user-confirmed',
        ...(record.sourceFormat !== undefined ? { sourceFormat: record.sourceFormat } : {}),
    };
}

function samePublication(left, right) {
    return left.libraryID === right.libraryID
        && left.attachmentKey === right.attachmentKey
        && left.sourceHash === right.sourceHash
        && left.snapshotHash === right.snapshotHash
        && left.rawKey === right.rawKey
        && left.importedAt === right.importedAt;
}

function invalidIndex(message, cause) {
    return new MinerUImportIndexError('LLM_CACHE_IMPORT_INDEX_INVALID', message, cause);
}

function createFileAdapter(rootPath, io, path, maxBytes) {
    const filePath = path.join(rootPath, 'index.json');
    return {
        async read({ signal } = {}) {
            throwIfFigureAborted(signal);
            if (!(await io.exists(filePath))) return null;
            const info = await io.stat(filePath);
            if (info.type !== 'regular' && info.type !== 'file'
                || !Number.isSafeInteger(info.size) || info.size > maxBytes || info.size < 0) {
                throw invalidIndex('The imported MinerU index exceeds its byte limit or is not a regular file');
            }
            return io.readUTF8(filePath);
        },
        async write(serialized, { signal } = {}) {
            const parentPath = path.parent?.(rootPath);
            if (parentPath) await io.makeDirectory(parentPath, { ignoreExisting: true });
            await io.makeDirectory(rootPath, { ignoreExisting: true });
            throwIfFigureAborted(signal);
            if (typeof io.move !== 'function') {
                // Injected adapters without move use #save's serialized recovery.
                await io.writeUTF8(filePath, serialized, { tmpPath: `${filePath}.tmp` });
                return;
            }
            const stagingPath = `${filePath}.staging`;
            try {
                await io.writeUTF8(stagingPath, serialized);
                throwIfFigureAborted(signal);
                await io.move(stagingPath, filePath, { noOverwrite: false });
            }
            finally {
                try { await io.remove(stagingPath, { ignoreAbsent: true }); }
                catch { /* A stale staging file is never read as the index. */ }
            }
        },
    };
}
