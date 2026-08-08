import { sha256Hex } from '../core/sha256.js';
import { translationProfileDescriptor } from '../translation/translation-profile.js';

const CACHE_SCHEMA_VERSION = 1;
const METADATA_FILE = 'entry.json';
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_SEGMENTS = 20_000;

export function createZoteroTranslationCache({ zotero, ioUtils, pathUtils }) {
    const profilePath = zotero?.Profile?.dir;
    if (!profilePath) throw new Error('The Zotero profile directory is unavailable');
    return new TranslationCache({
        rootPath: pathUtils.join(
            profilePath,
            'mktero-translation-cache',
            'v1'
        ),
        ioUtils,
        pathUtils,
    });
}

export async function createTranslationCacheKey(markdown, configuration, {
    crypto = globalThis.crypto,
} = {}) {
    const sourceHash = await sha256Hex(
        new TextEncoder().encode(String(markdown || '')),
        { crypto }
    );
    const descriptor = translationProfileDescriptor(configuration);
    return sha256Hex(new TextEncoder().encode(JSON.stringify({
        sourceHash,
        ...descriptor,
    })), { crypto });
}

export class TranslationCache {
    constructor({
        rootPath,
        ioUtils,
        pathUtils,
        now = Date.now,
        maxBytes = DEFAULT_MAX_BYTES,
        maxEntries = DEFAULT_MAX_ENTRIES,
        maxAgeMs = DEFAULT_MAX_AGE_MS,
        maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES,
        maxSegments = DEFAULT_MAX_SEGMENTS,
    }) {
        if (!rootPath) throw new TypeError('A cache root path is required');
        if (!ioUtils) throw new TypeError('An IOUtils adapter is required');
        if (!pathUtils) throw new TypeError('A PathUtils adapter is required');
        this.rootPath = rootPath;
        this.io = ioUtils;
        this.path = pathUtils;
        this.now = now;
        this.maxBytes = maxBytes;
        this.maxEntries = maxEntries;
        this.maxAgeMs = maxAgeMs;
        this.maxEntryBytes = maxEntryBytes;
        this.maxSegments = maxSegments;
        this.operationTail = Promise.resolve();
    }

    get(cacheKey) {
        validateCacheKey(cacheKey);
        return this.#withOperation(() => this.#get(cacheKey));
    }

    async #get(cacheKey) {
        const entryPath = this.#entryPath(cacheKey);
        const metadataPath = this.path.join(entryPath, METADATA_FILE);
        if (!(await this.io.exists(metadataPath))) return null;
        try {
            const metadata = JSON.parse(await this.io.readUTF8(metadataPath));
            validateMetadata(metadata, cacheKey, {
                maxEntryBytes: this.maxEntryBytes,
                maxSegments: this.maxSegments,
            });
            if (this.#isExpired(metadata)) {
                await this.io.remove(entryPath, {
                    recursive: true,
                    ignoreAbsent: true,
                });
                return null;
            }
            const translation = await this.io.readUTF8(
                this.path.join(entryPath, metadata.translationFile)
            );
            if (new TextEncoder().encode(translation).length
                !== metadata.translationBytes) {
                throw new Error('Cached translation size does not match metadata');
            }
            if (translation.length !== metadata.translationCharacters) {
                throw new Error('Cached translation length does not match metadata');
            }
            const segments = metadata.segments.map(record => ({
                id: record.id,
                sourceHash: record.sourceHash,
                from: record.from,
                to: record.to,
                kind: record.kind,
                status: record.status,
                ...(record.status === 'complete' ? {
                    text: translation.slice(
                        record.translationFrom,
                        record.translationTo
                    ),
                } : {}),
                ...(record.errorCode ? { errorCode: record.errorCode } : {}),
            }));
            metadata.lastAccessedAt = this.now();
            await this.#writeMetadata(metadataPath, metadata).catch(() => {});
            return {
                status: metadata.status,
                targetLanguage: metadata.targetLanguage,
                serviceName: metadata.serviceName,
                segments,
            };
        }
        catch {
            await this.io.remove(entryPath, {
                recursive: true,
                ignoreAbsent: true,
            }).catch(() => {});
            return null;
        }
    }

    put(cacheKey, result) {
        validateCacheKey(cacheKey);
        validateResult(result, this.maxSegments);
        return this.#withOperation(() => this.#put(cacheKey, result));
    }

    async #put(cacheKey, result) {
        const entryPath = this.#entryPath(cacheKey);
        await this.#ensureRoot();
        await this.io.makeDirectory(entryPath, { ignoreExisting: true });
        const metadataPath = this.path.join(entryPath, METADATA_FILE);
        const previous = await this.#readMetadata(metadataPath, cacheKey);
        const generation = createGenerationID(this.now());
        const translationFile = `translation-${generation}.md`;
        const translationPath = this.path.join(entryPath, translationFile);
        const translationParts = [];
        const records = [];
        let offset = 0;
        for (const segment of result.segments) {
            const record = {
                id: segment.id,
                sourceHash: segment.sourceHash,
                from: segment.from,
                to: segment.to,
                kind: segment.kind,
                status: segment.status,
            };
            if (segment.status === 'complete') {
                const text = String(segment.text || '');
                record.translationFrom = offset;
                record.translationTo = offset + text.length;
                translationParts.push(text);
                offset += text.length;
            }
            else if (segment.errorCode) {
                record.errorCode = String(segment.errorCode).slice(0, 100);
            }
            records.push(record);
        }
        const translation = translationParts.join('');
        const translationBytes = new TextEncoder().encode(translation).length;
        if (translationBytes > this.maxEntryBytes) {
            throw new Error('The translation cache entry exceeds its size limit');
        }
        const timestamp = this.now();
        const metadata = {
            schemaVersion: CACHE_SCHEMA_VERSION,
            cacheKey,
            createdAt: timestamp,
            lastAccessedAt: timestamp,
            translationFile,
            translationBytes,
            translationCharacters: translation.length,
            sizeBytes: translationBytes,
            status: result.status,
            targetLanguage: String(result.targetLanguage || ''),
            serviceName: String(result.serviceName || '').slice(0, 100),
            segments: records,
        };
        validateMetadata(metadata, cacheKey, {
            maxEntryBytes: this.maxEntryBytes,
            maxSegments: this.maxSegments,
        });
        const writtenPaths = [];
        const temporaryPaths = [
            `${translationPath}.tmp`,
            `${metadataPath}.tmp`,
        ];
        try {
            await this.io.writeUTF8(translationPath, translation, {
                tmpPath: `${translationPath}.tmp`,
            });
            writtenPaths.push(translationPath);
            await this.#writeMetadata(metadataPath, metadata);
            if (previous?.translationFile
                && previous.translationFile !== translationFile) {
                await this.io.remove(
                    this.path.join(entryPath, previous.translationFile),
                    { ignoreAbsent: true }
                ).catch(() => {});
            }
        }
        catch (error) {
            await Promise.all([...writtenPaths, ...temporaryPaths].map(path => (
                this.io.remove(path, { ignoreAbsent: true }).catch(() => {})
            )));
            throw error;
        }
        await this.#scan({ removeInvalid: true, enforceLimits: true });
    }

    remove(cacheKey) {
        validateCacheKey(cacheKey);
        return this.#withOperation(() => this.io.remove(
            this.#entryPath(cacheKey),
            { recursive: true, ignoreAbsent: true }
        ));
    }

    prune() {
        return this.#withOperation(() => this.#scan({
            removeInvalid: true,
            enforceLimits: true,
        }));
    }

    getStats() {
        return this.#withOperation(() => this.#scan({
            removeInvalid: false,
            enforceLimits: false,
        }));
    }

    clear() {
        return this.#withOperation(async () => {
            await this.io.remove(this.rootPath, {
                recursive: true,
                ignoreAbsent: true,
            });
            await this.#ensureRoot();
        });
    }

    async #scan({ removeInvalid, enforceLimits }) {
        const entriesPath = this.path.join(this.rootPath, 'entries');
        if (!(await this.io.exists(entriesPath))) {
            return { entries: 0, sizeBytes: 0 };
        }
        const entries = [];
        const now = this.now();
        for (const entryPath of await this.io.getChildren(entriesPath)) {
            try {
                if ((await this.io.stat(entryPath)).type !== 'directory') continue;
                const cacheKey = this.path.filename(entryPath);
                const metadata = JSON.parse(await this.io.readUTF8(
                    this.path.join(entryPath, METADATA_FILE)
                ));
                validateCacheKey(cacheKey);
                validateMetadata(metadata, cacheKey, {
                    maxEntryBytes: this.maxEntryBytes,
                    maxSegments: this.maxSegments,
                });
                const translationPath = this.path.join(
                    entryPath,
                    metadata.translationFile
                );
                if (!(await this.io.exists(translationPath))) {
                    throw new Error('Cached translation content is missing');
                }
                const translationStat = await this.io.stat(translationPath);
                if (translationStat.type !== 'regular'
                    || translationStat.size !== metadata.translationBytes) {
                    throw new Error('Cached translation content is invalid');
                }
                if (this.#isExpired(metadata, now)) {
                    if (removeInvalid) {
                        await this.io.remove(entryPath, {
                            recursive: true,
                            ignoreAbsent: true,
                        });
                    }
                    continue;
                }
                entries.push({
                    path: entryPath,
                    lastAccessedAt: metadata.lastAccessedAt,
                    sizeBytes: metadata.sizeBytes,
                });
            }
            catch {
                if (removeInvalid) {
                    await this.io.remove(entryPath, {
                        recursive: true,
                        ignoreAbsent: true,
                    });
                }
            }
        }
        entries.sort((left, right) => left.lastAccessedAt - right.lastAccessedAt);
        let sizeBytes = entries.reduce((total, entry) => total + entry.sizeBytes, 0);
        while (enforceLimits
            && (entries.length > this.maxEntries || sizeBytes > this.maxBytes)) {
            const entry = entries.shift();
            await this.io.remove(entry.path, {
                recursive: true,
                ignoreAbsent: true,
            });
            sizeBytes -= entry.sizeBytes;
        }
        return { entries: entries.length, sizeBytes };
    }

    #entryPath(cacheKey) {
        return this.path.join(this.rootPath, 'entries', cacheKey);
    }

    async #ensureRoot() {
        const parentPath = this.path.parent?.(this.rootPath);
        if (parentPath) {
            await this.io.makeDirectory(parentPath, { ignoreExisting: true });
        }
        await this.io.makeDirectory(this.rootPath, { ignoreExisting: true });
        await this.io.makeDirectory(this.path.join(this.rootPath, 'entries'), {
            ignoreExisting: true,
        });
    }

    #writeMetadata(metadataPath, metadata) {
        return this.io.writeUTF8(metadataPath, JSON.stringify(metadata), {
            tmpPath: `${metadataPath}.tmp`,
        });
    }

    async #readMetadata(metadataPath, cacheKey) {
        if (!(await this.io.exists(metadataPath))) return null;
        try {
            const metadata = JSON.parse(await this.io.readUTF8(metadataPath));
            validateMetadata(metadata, cacheKey, {
                maxEntryBytes: this.maxEntryBytes,
                maxSegments: this.maxSegments,
            });
            return metadata;
        }
        catch {
            return null;
        }
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
            if (this.operationTail === pending) {
                this.operationTail = Promise.resolve();
            }
        }
    }
}

function validateResult(result, maxSegments) {
    if (!['partial', 'complete'].includes(result?.status)
        || !Array.isArray(result.segments)
        || result.segments.length > maxSegments
        || typeof result.targetLanguage !== 'string') {
        throw new TypeError('Invalid translation cache result');
    }
    for (const segment of result.segments) {
        if (!/^segment-\d{6}$/u.test(segment?.id || '')
            || !/^[a-f0-9]{8}$/u.test(segment.sourceHash || '')
            || !Number.isSafeInteger(segment.from)
            || !Number.isSafeInteger(segment.to)
            || segment.from < 0
            || segment.to <= segment.from
            || typeof segment.kind !== 'string'
            || !['complete', 'failed'].includes(segment.status)) {
            throw new TypeError('Invalid translation cache segment');
        }
        if (segment.status === 'complete' && !String(segment.text || '').trim()) {
            throw new TypeError('A completed translation must contain text');
        }
        if (segment.errorCode !== undefined
            && (typeof segment.errorCode !== 'string'
                || segment.errorCode.length > 100)) {
            throw new TypeError('Invalid translation cache error');
        }
    }
}

function validateMetadata(metadata, cacheKey, { maxEntryBytes, maxSegments }) {
    if (metadata?.schemaVersion !== CACHE_SCHEMA_VERSION
        || metadata.cacheKey !== cacheKey
        || !/^translation-[a-z0-9-]+\.md$/u.test(metadata.translationFile || '')
        || !Number.isSafeInteger(metadata.translationBytes)
        || metadata.translationBytes < 0
        || metadata.translationBytes > maxEntryBytes
        || metadata.sizeBytes !== metadata.translationBytes
        || !Number.isSafeInteger(metadata.translationCharacters)
        || metadata.translationCharacters < 0
        || !Number.isFinite(metadata.lastAccessedAt)
        || !['partial', 'complete'].includes(metadata.status)
        || typeof metadata.targetLanguage !== 'string'
        || typeof metadata.serviceName !== 'string'
        || !Array.isArray(metadata.segments)
        || metadata.segments.length > maxSegments) {
        throw new Error('Invalid translation cache metadata');
    }
    for (const record of metadata.segments) {
        validateSegmentRecord(record, metadata.translationCharacters);
    }
}

function validateSegmentRecord(record, translationLength) {
    if (!/^segment-\d{6}$/u.test(record?.id || '')
        || !/^[a-f0-9]{8}$/u.test(record.sourceHash || '')
        || !Number.isSafeInteger(record.from)
        || !Number.isSafeInteger(record.to)
        || record.from < 0
        || record.to <= record.from
        || typeof record.kind !== 'string'
        || !['complete', 'failed'].includes(record.status)) {
        throw new Error('Invalid cached translation segment');
    }
    if (record.status === 'complete'
        && (!Number.isSafeInteger(record.translationFrom)
            || !Number.isSafeInteger(record.translationTo)
            || record.translationFrom < 0
            || record.translationTo <= record.translationFrom
            || record.translationTo > translationLength)) {
        throw new Error('Invalid cached translation offsets');
    }
    if (record.errorCode !== undefined
        && (typeof record.errorCode !== 'string'
            || record.errorCode.length > 100)) {
        throw new Error('Invalid cached translation error');
    }
}

function validateCacheKey(cacheKey) {
    if (!/^[a-f0-9]{64}$/u.test(String(cacheKey))) {
        throw new TypeError('A SHA-256 translation cache key is required');
    }
}

function createGenerationID(timestamp) {
    const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '')
        || Math.random().toString(36).slice(2);
    return `${Number(timestamp).toString(36)}-${random}`;
}
