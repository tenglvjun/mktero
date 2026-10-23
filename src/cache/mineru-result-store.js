import { sha256Hex } from '../core/sha256.js';
import { toUint8Array } from '../mineru/binary.js';

const STORE_SCHEMA_VERSION = 1;
const KEY_SCHEMA_VERSION = 1;
const METADATA_FILE = 'entry.json';
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_PROVIDER_LENGTH = 32;
const MAX_PROFILE_LENGTH = 4096;

export const MINERU_RESULT_STORE_MAX_AGE_MS = DEFAULT_MAX_AGE_MS;

export function createZoteroMinerUResultStore({ zotero, ioUtils, pathUtils }) {
    const profilePath = zotero?.Profile?.dir;
    if (!profilePath) throw new Error('The Zotero profile directory is unavailable');
    return new MinerUResultStore({
        rootPath: pathUtils.join(profilePath, 'mktero-mineru-results', 'v1'),
        ioUtils,
        pathUtils,
    });
}

// The raw-result key covers what MinerU produced, not how Mktero reads it:
// the PDF bytes, the provider that ran MinerU, and that provider's request
// options. Changing the document pipeline therefore reuses stored results.
export async function createMinerUResultKey({
    fileData = null,
    sourceHash = null,
    provider,
    requestProfile,
    crypto = globalThis.crypto,
}) {
    if (typeof provider !== 'string' || !provider || provider.length > MAX_PROVIDER_LENGTH) {
        throw new TypeError('A MinerU result provider is required');
    }
    if (typeof requestProfile !== 'string' || !requestProfile || requestProfile.length > MAX_PROFILE_LENGTH) {
        throw new TypeError('A MinerU request profile is required');
    }
    const hash = typeof sourceHash === 'string' && /^[a-f0-9]{64}$/.test(sourceHash)
        ? sourceHash
        : await sha256Hex(fileData, { crypto });
    return sha256Hex(new TextEncoder().encode([
        `mineru-result:${KEY_SCHEMA_VERSION}`,
        `provider:${provider}`,
        `request:${requestProfile}`,
        `source-sha256:${hash}`,
    ].join('\n')), { crypto });
}

// Stores trimmed MinerU result archives so a document-pipeline change can be
// re-derived locally. Archive bytes are opaque here; the caller extracts and
// validates them with the same code that reads a downloaded result.
export class MinerUResultStore {
    constructor({
        rootPath,
        ioUtils,
        pathUtils,
        now = Date.now,
        maxBytes = DEFAULT_MAX_BYTES,
        maxEntries = DEFAULT_MAX_ENTRIES,
        maxAgeMs = DEFAULT_MAX_AGE_MS,
        maxArchiveBytes = DEFAULT_MAX_ARCHIVE_BYTES,
    }) {
        if (!rootPath) throw new TypeError('A MinerU result store root path is required');
        if (!ioUtils) throw new TypeError('An IOUtils adapter is required');
        if (!pathUtils) throw new TypeError('A PathUtils adapter is required');
        this.rootPath = rootPath;
        this.io = ioUtils;
        this.path = pathUtils;
        this.now = now;
        this.maxBytes = maxBytes;
        this.maxEntries = maxEntries;
        this.maxAgeMs = maxAgeMs;
        this.maxArchiveBytes = maxArchiveBytes;
        this.operationTail = Promise.resolve();
    }

    get(key, { signal } = {}) {
        validateKey(key);
        return this.#withOperation(() => this.#get(key, signal));
    }

    put(key, record, { signal } = {}) {
        validateKey(key);
        const archive = toUint8Array(record?.archive, 'The MinerU result archive');
        if (!archive.length || archive.length > this.maxArchiveBytes) {
            throw new Error('The MinerU result archive exceeds the store limit');
        }
        return this.#withOperation(() => this.#put(key, {
            archive,
            provider: String(record.provider || ''),
            extractedPages: pageCount(record.extractedPages),
            totalPages: pageCount(record.totalPages),
        }, signal));
    }

    delete(key) {
        validateKey(key);
        return this.#withOperation(() => this.#remove(this.#entryPath(key)));
    }

    prune() {
        return this.#withOperation(() => this.#scan({ removeInvalid: true, enforceLimits: true }));
    }

    getStats() {
        return this.#withOperation(() => this.#scan({ removeInvalid: false, enforceLimits: false }));
    }

    clear() {
        return this.#withOperation(async () => {
            await this.io.remove(this.rootPath, { recursive: true, ignoreAbsent: true });
            await this.#ensureRoot();
        });
    }

    async #get(key, signal) {
        throwIfAborted(signal);
        const entryPath = this.#entryPath(key);
        const metadataPath = this.path.join(entryPath, METADATA_FILE);
        if (!(await this.io.exists(metadataPath))) return null;
        try {
            const metadata = JSON.parse(await this.io.readUTF8(metadataPath));
            validateMetadata(metadata, key, this.maxArchiveBytes);
            if (this.#isExpired(metadata)) {
                await this.#remove(entryPath);
                return null;
            }
            const archivePath = this.path.join(entryPath, metadata.archiveFile);
            const info = await this.io.stat(archivePath);
            if (info?.size !== metadata.archiveBytes) throw new Error('Stored MinerU archive size is invalid');
            const archive = toUint8Array(await this.io.read(archivePath), 'Stored MinerU archive');
            if (archive.length !== metadata.archiveBytes) throw new Error('Stored MinerU archive size is invalid');
            throwIfAborted(signal);
            metadata.lastAccessedAt = this.now();
            await this.#writeMetadata(metadataPath, metadata).catch(() => {});
            return {
                archive,
                provider: metadata.provider,
                extractedPages: metadata.extractedPages,
                totalPages: metadata.totalPages,
            };
        }
        catch (error) {
            if (error?.name === 'AbortError') throw error;
            await this.#remove(entryPath).catch(() => {});
            return null;
        }
    }

    async #put(key, record, signal) {
        throwIfAborted(signal);
        const entryPath = this.#entryPath(key);
        await this.#ensureRoot();
        await this.io.makeDirectory(entryPath, { ignoreExisting: true });
        const metadataPath = this.path.join(entryPath, METADATA_FILE);
        const previous = await this.#readMetadata(metadataPath, key);
        const archiveFile = `result-${createGenerationID(this.now())}.zip`;
        const archivePath = this.path.join(entryPath, archiveFile);
        const temporaryPath = `${archivePath}.tmp`;
        try {
            await this.io.write(archivePath, record.archive, { tmpPath: temporaryPath });
            throwIfAborted(signal);
            const timestamp = this.now();
            await this.#writeMetadata(metadataPath, {
                schemaVersion: STORE_SCHEMA_VERSION,
                key,
                provider: record.provider.slice(0, MAX_PROVIDER_LENGTH),
                createdAt: previous?.createdAt ?? timestamp,
                lastAccessedAt: timestamp,
                archiveFile,
                archiveBytes: record.archive.length,
                extractedPages: record.extractedPages,
                totalPages: record.totalPages,
            });
        }
        catch (error) {
            await Promise.all([archivePath, temporaryPath].map(filePath => (
                this.io.remove(filePath, { ignoreAbsent: true }).catch(() => {})
            )));
            throw error;
        }
        if (previous?.archiveFile && previous.archiveFile !== archiveFile) {
            await this.io.remove(this.path.join(entryPath, previous.archiveFile), { ignoreAbsent: true })
                .catch(() => {});
        }
        await this.#scan({ removeInvalid: true, enforceLimits: true });
    }

    async #scan({ removeInvalid, enforceLimits }) {
        const entriesPath = this.path.join(this.rootPath, 'entries');
        if (!(await this.io.exists(entriesPath))) return { entries: 0, sizeBytes: 0 };
        const entries = [];
        const timestamp = this.now();
        for (const entryPath of await this.io.getChildren(entriesPath)) {
            try {
                if ((await this.io.stat(entryPath)).type !== 'directory') continue;
                const key = this.path.filename(entryPath);
                validateKey(key);
                const metadata = JSON.parse(await this.io.readUTF8(this.path.join(entryPath, METADATA_FILE)));
                validateMetadata(metadata, key, this.maxArchiveBytes);
                if (this.#isExpired(metadata, timestamp)) {
                    if (removeInvalid) await this.#remove(entryPath);
                    continue;
                }
                entries.push({ path: entryPath, lastAccessedAt: metadata.lastAccessedAt, sizeBytes: metadata.archiveBytes });
            }
            catch {
                if (removeInvalid) await this.#remove(entryPath).catch(() => {});
            }
        }
        entries.sort((left, right) => left.lastAccessedAt - right.lastAccessedAt);
        let sizeBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
        while (enforceLimits && entries.length
            && (entries.length > this.maxEntries || sizeBytes > this.maxBytes)) {
            const entry = entries.shift();
            await this.#remove(entry.path);
            sizeBytes -= entry.sizeBytes;
        }
        return { entries: entries.length, sizeBytes };
    }

    #entryPath(key) {
        return this.path.join(this.rootPath, 'entries', key);
    }

    async #ensureRoot() {
        const parentPath = this.path.parent?.(this.rootPath);
        if (parentPath) await this.io.makeDirectory(parentPath, { ignoreExisting: true });
        await this.io.makeDirectory(this.rootPath, { ignoreExisting: true });
        await this.io.makeDirectory(this.path.join(this.rootPath, 'entries'), { ignoreExisting: true });
    }

    #writeMetadata(metadataPath, metadata) {
        return this.io.writeUTF8(metadataPath, JSON.stringify(metadata), { tmpPath: `${metadataPath}.tmp` });
    }

    async #readMetadata(metadataPath, key) {
        if (!(await this.io.exists(metadataPath))) return null;
        try {
            const metadata = JSON.parse(await this.io.readUTF8(metadataPath));
            validateMetadata(metadata, key, this.maxArchiveBytes);
            return metadata;
        }
        catch {
            return null;
        }
    }

    #remove(entryPath) {
        return this.io.remove(entryPath, { recursive: true, ignoreAbsent: true });
    }

    #isExpired(metadata, timestamp = this.now()) {
        return timestamp - metadata.lastAccessedAt > this.maxAgeMs;
    }

    async #withOperation(operation) {
        const previous = this.operationTail;
        const pending = previous.catch(() => {}).then(operation);
        this.operationTail = pending;
        try {
            return await pending;
        }
        finally {
            if (this.operationTail === pending) this.operationTail = Promise.resolve();
        }
    }
}

function validateKey(value) {
    if (!/^[a-f0-9]{64}$/.test(String(value))) {
        throw new TypeError('A MinerU result SHA-256 key is required');
    }
}

function validateMetadata(metadata, key, maxArchiveBytes) {
    if (metadata?.schemaVersion !== STORE_SCHEMA_VERSION
        || metadata.key !== key
        || typeof metadata.provider !== 'string'
        || metadata.provider.length > MAX_PROVIDER_LENGTH
        || !Number.isFinite(metadata.createdAt)
        || !Number.isFinite(metadata.lastAccessedAt)
        || !/^result-[a-z0-9-]+\.zip$/.test(metadata.archiveFile)
        || !Number.isSafeInteger(metadata.archiveBytes)
        || metadata.archiveBytes <= 0
        || metadata.archiveBytes > maxArchiveBytes
        || ![null, undefined].includes(metadata.extractedPages) && pageCount(metadata.extractedPages) === null
        || ![null, undefined].includes(metadata.totalPages) && pageCount(metadata.totalPages) === null) {
        throw new Error('Invalid MinerU result store metadata');
    }
}

function pageCount(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function createGenerationID(timestamp) {
    const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '')
        || Math.random().toString(36).slice(2);
    return `${Number(timestamp).toString(36)}-${random}`;
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    if (signal.reason) throw signal.reason;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
}
