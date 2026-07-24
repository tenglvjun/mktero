import { toUint8Array } from '../mineru/binary.js';
import { MINERU_PARSER_PROFILE_ID } from '../mineru/parser-profile.js';

const CACHE_SCHEMA_VERSION = 1;
const METADATA_FILE = 'entry.json';
const MARKDOWN_FILE = 'document.md';
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_MINERU_PARSER_PROFILE = MINERU_PARSER_PROFILE_ID;

export function createZoteroMarkdownCache({ zotero, ioUtils, pathUtils }) {
    const profilePath = zotero?.Profile?.dir;
    if (!profilePath) throw new Error('The Zotero profile directory is unavailable');
    return new MarkdownCache({
        rootPath: pathUtils.join(profilePath, 'mktero-cache', 'v1'),
        ioUtils,
        pathUtils,
    });
}

export async function createMinerUCacheKey(fileData, {
    crypto = globalThis.crypto,
    parserProfile = DEFAULT_MINERU_PARSER_PROFILE,
} = {}) {
    const sourceHash = await sha256Hex(fileData, { crypto });
    const descriptor = new TextEncoder().encode([
        `cache-schema:${CACHE_SCHEMA_VERSION}`,
        `parser-profile:${parserProfile}`,
        `source-sha256:${sourceHash}`,
    ].join('\n'));
    return sha256Hex(descriptor, { crypto });
}

export async function sha256Hex(value, { crypto = globalThis.crypto } = {}) {
    if (!crypto?.subtle?.digest) {
        throw new Error('SHA-256 is unavailable in this runtime');
    }
    const bytes = toUint8Array(value, 'SHA-256 input');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export class MarkdownCache {
    constructor({
        rootPath,
        ioUtils,
        pathUtils,
        now = Date.now,
        maxBytes = DEFAULT_MAX_BYTES,
        maxEntries = DEFAULT_MAX_ENTRIES,
        maxAgeMs = DEFAULT_MAX_AGE_MS,
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
        this.operationTail = Promise.resolve();
    }

    async get(cacheKey) {
        validateCacheKey(cacheKey);
        return this.#withOperation(() => this.#get(cacheKey));
    }

    async #get(cacheKey) {
        const entryPath = this.#entryPath(cacheKey);
        const metadataPath = this.path.join(entryPath, METADATA_FILE);
        if (!(await this.io.exists(metadataPath))) return null;

        try {
            const metadata = JSON.parse(await this.io.readUTF8(metadataPath));
            validateMetadata(metadata, cacheKey);
            if (this.#isExpired(metadata)) {
                await this.io.remove(entryPath, { recursive: true, ignoreAbsent: true });
                return null;
            }
            const markdownFile = metadata.markdownFile || MARKDOWN_FILE;
            const [markdown, assets] = await Promise.all([
                this.io.readUTF8(this.path.join(entryPath, markdownFile)),
                Promise.all(metadata.assets.map(async asset => {
                    const data = await this.io.read(
                        this.path.join(entryPath, 'assets', asset.file)
                    );
                    if (data.length !== asset.size) {
                        throw new Error('Cached image size does not match its metadata');
                    }
                    return {
                        path: asset.path,
                        mimeType: asset.mimeType,
                        data,
                    };
                })),
            ]);
            if (new TextEncoder().encode(markdown).length !== metadata.markdownBytes) {
                throw new Error('Cached Markdown size does not match its metadata');
            }
            metadata.lastAccessedAt = this.now();
            await this.#writeMetadata(metadataPath, metadata).catch(() => {});

            return {
                markdown,
                assets,
                assetBasePath: metadata.assetBasePath,
                extractedPages: metadata.extractedPages,
                totalPages: metadata.totalPages,
            };
        }
        catch {
            await this.io.remove(entryPath, { recursive: true, ignoreAbsent: true })
                .catch(() => {});
            return null;
        }
    }

    async put(cacheKey, result) {
        validateCacheKey(cacheKey);
        if (typeof result?.markdown !== 'string' || !result.markdown.trim()) {
            throw new TypeError('Cached Markdown must be a non-empty string');
        }

        return this.#withOperation(() => this.#put(cacheKey, result));
    }

    async #put(cacheKey, result) {
        const entryPath = this.#entryPath(cacheKey);
        const assetsPath = this.path.join(entryPath, 'assets');
        await this.#ensureRoot();
        await this.io.makeDirectory(entryPath, { ignoreExisting: true });
        await this.io.makeDirectory(assetsPath, { ignoreExisting: true });

        const metadataPath = this.path.join(entryPath, METADATA_FILE);
        const previousMetadata = await this.#readMetadata(metadataPath, cacheKey);
        const generation = createGenerationID(this.now());
        const markdownFile = `document-${generation}.md`;
        const writtenPaths = [];
        const temporaryPaths = [];
        const assets = [];
        try {
            for (const [index, asset] of (result.assets || []).entries()) {
                const file = `${generation}-${String(index).padStart(4, '0')}.bin`;
                const data = toUint8Array(asset.data, 'Cached image');
                const filePath = this.path.join(assetsPath, file);
                const temporaryPath = `${filePath}.tmp`;
                temporaryPaths.push(temporaryPath);
                await this.io.write(filePath, data, { tmpPath: temporaryPath });
                writtenPaths.push(filePath);
                assets.push({
                    file,
                    path: String(asset.path),
                    mimeType: String(asset.mimeType),
                    size: data.length,
                });
            }

            const markdownPath = this.path.join(entryPath, markdownFile);
            const temporaryMarkdownPath = `${markdownPath}.tmp`;
            temporaryPaths.push(temporaryMarkdownPath);
            await this.io.writeUTF8(markdownPath, result.markdown, {
                tmpPath: temporaryMarkdownPath,
            });
            writtenPaths.push(markdownPath);
            const timestamp = this.now();
            const markdownBytes = new TextEncoder().encode(result.markdown).length;
            const metadata = {
                schemaVersion: CACHE_SCHEMA_VERSION,
                cacheKey,
                createdAt: timestamp,
                lastAccessedAt: timestamp,
                markdownFile,
                assetBasePath: String(result.assetBasePath || ''),
                extractedPages: result.extractedPages ?? null,
                totalPages: result.totalPages ?? null,
                markdownBytes,
                sizeBytes: markdownBytes
                    + assets.reduce((total, asset) => total + asset.size, 0),
                assets,
            };
            temporaryPaths.push(`${metadataPath}.tmp`);
            await this.#writeMetadata(metadataPath, metadata);
            await this.#removeReferencedFiles(entryPath, previousMetadata);
        }
        catch (error) {
            await Promise.all([...writtenPaths, ...temporaryPaths].map(filePath => (
                this.io.remove(filePath, { ignoreAbsent: true }).catch(() => {})
            )));
            throw error;
        }
        await this.#scan({ removeInvalid: true, enforceLimits: true });
    }

    prune() {
        return this.#withOperation(() => this.#scan({
            removeInvalid: true,
            enforceLimits: true,
        }));
    }

    async #scan({ removeInvalid, enforceLimits }) {
        const entriesPath = this.path.join(this.rootPath, 'entries');
        if (!(await this.io.exists(entriesPath))) {
            return { entries: 0, sizeBytes: 0 };
        }

        const now = this.now();
        const entries = [];
        for (const entryPath of await this.io.getChildren(entriesPath)) {
            try {
                if ((await this.io.stat(entryPath)).type !== 'directory') continue;
                const metadata = JSON.parse(
                    await this.io.readUTF8(this.path.join(entryPath, METADATA_FILE))
                );
                const cacheKey = this.path.filename(entryPath);
                validateCacheKey(cacheKey);
                validateMetadata(metadata, cacheKey);
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
                    await this.io.remove(entryPath, { recursive: true, ignoreAbsent: true });
                }
            }
        }

        entries.sort((left, right) => left.lastAccessedAt - right.lastAccessedAt);
        let sizeBytes = entries.reduce((total, entry) => total + entry.sizeBytes, 0);
        while (enforceLimits
            && (entries.length > this.maxEntries || sizeBytes > this.maxBytes)) {
            const entry = entries.shift();
            await this.io.remove(entry.path, { recursive: true, ignoreAbsent: true });
            sizeBytes -= entry.sizeBytes;
        }
        return { entries: entries.length, sizeBytes };
    }

    getStats() {
        return this.#withOperation(() => this.#scan({
            removeInvalid: false,
            enforceLimits: false,
        }));
    }

    clear() {
        return this.#withOperation(() => this.#clear());
    }

    async #clear() {
        await this.io.remove(this.rootPath, { recursive: true, ignoreAbsent: true });
        await this.#ensureRoot();
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
            validateMetadata(metadata, cacheKey);
            return metadata;
        }
        catch {
            return null;
        }
    }

    async #removeReferencedFiles(entryPath, metadata) {
        if (!metadata) return;
        const files = [
            this.path.join(entryPath, metadata.markdownFile || MARKDOWN_FILE),
            ...(metadata.assets || []).map(asset => (
                this.path.join(entryPath, 'assets', asset.file)
            )),
        ];
        await Promise.all(files.map(filePath => this.io.remove(filePath, {
            ignoreAbsent: true,
        }).catch(() => {})));
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

function createGenerationID(timestamp) {
    const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '')
        || Math.random().toString(36).slice(2);
    return `${Number(timestamp).toString(36)}-${random}`;
}

function validateCacheKey(cacheKey) {
    if (!/^[a-f0-9]{64}$/.test(String(cacheKey))) {
        throw new TypeError('A SHA-256 cache key is required');
    }
}

function validateMetadata(metadata, cacheKey) {
    if (metadata?.schemaVersion !== CACHE_SCHEMA_VERSION
        || metadata.cacheKey !== cacheKey
        || !Number.isFinite(metadata.markdownBytes)
        || metadata.markdownBytes < 0
        || !Number.isFinite(metadata.sizeBytes)
        || metadata.sizeBytes < metadata.markdownBytes
        || !Number.isFinite(metadata.lastAccessedAt)
        || (metadata.markdownFile !== undefined
            && !/^document-[a-z0-9-]+\.md$/.test(metadata.markdownFile))
        || typeof metadata.assetBasePath !== 'string'
        || !Array.isArray(metadata.assets)
        || metadata.assets.length > 1000) {
        throw new Error('Invalid cache metadata');
    }
    for (const asset of metadata.assets) {
        if (!/^(?:\d{4}|[a-z0-9-]+-\d{4})\.bin$/.test(asset?.file)
            || typeof asset.path !== 'string'
            || typeof asset.mimeType !== 'string'
            || !Number.isFinite(asset.size)
            || asset.size < 0) {
            throw new Error('Invalid cached image metadata');
        }
    }
}
