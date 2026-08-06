import {
    createDehyphenatedPdfAnnotationTextIndex,
} from '../markdown/pdf-annotation-text.js';

const CACHE_SCHEMA_VERSION = 1;
const METADATA_FILE = 'entry.json';
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_INDEX_BYTES = 128 * 1024 * 1024;
const MAX_PAGES = 10_000;
const MAX_PAGE_TEXT_LENGTH = 1_000_000;
const MAX_TOTAL_TEXT_LENGTH = 10_000_000;
const MAX_TEXT_ITEMS = 250_000;
const MAX_STYLES = 100_000;

export function createZoteroPDFTextIndexCache({
    zotero,
    ioUtils,
    pathUtils,
}) {
    const profilePath = zotero?.Profile?.dir;
    if (!profilePath) {
        throw new Error('The Zotero profile directory is unavailable');
    }
    return new PDFTextIndexCache({
        rootPath: pathUtils.join(profilePath, 'mktero-pdf-index', 'v1'),
        ioUtils,
        pathUtils,
    });
}

export class PDFTextIndexCache {
    constructor({
        rootPath,
        ioUtils,
        pathUtils,
        now = Date.now,
        maxBytes = DEFAULT_MAX_BYTES,
        maxEntries = DEFAULT_MAX_ENTRIES,
        maxAgeMs = DEFAULT_MAX_AGE_MS,
        maxIndexBytes = DEFAULT_MAX_INDEX_BYTES,
    }) {
        if (!rootPath) throw new TypeError('A PDF index cache root is required');
        if (!ioUtils) throw new TypeError('An IOUtils adapter is required');
        if (!pathUtils) throw new TypeError('A PathUtils adapter is required');
        this.rootPath = rootPath;
        this.io = ioUtils;
        this.path = pathUtils;
        this.now = now;
        this.maxBytes = maxBytes;
        this.maxEntries = maxEntries;
        this.maxAgeMs = maxAgeMs;
        this.maxIndexBytes = maxIndexBytes;
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
            validateMetadata(metadata, cacheKey, this.maxIndexBytes);
            if (this.#isExpired(metadata)) {
                await this.io.remove(entryPath, {
                    recursive: true,
                    ignoreAbsent: true,
                });
                return null;
            }
            const indexPath = this.path.join(entryPath, metadata.indexFile);
            const fileInfo = await this.io.stat(indexPath);
            if (!Number.isSafeInteger(fileInfo?.size)
                || fileInfo.size !== metadata.indexBytes
                || fileInfo.size > this.maxIndexBytes) {
                throw new Error('Cached PDF text index file size is invalid');
            }
            const indexJSON = await this.io.readUTF8(indexPath);
            if (new TextEncoder().encode(indexJSON).length
                !== metadata.indexBytes) {
                throw new Error('Cached PDF text index size is invalid');
            }
            const index = JSON.parse(indexJSON);
            validatePDFTextIndex(index);
            if (index.profile !== metadata.profile) {
                throw new Error('Cached PDF text index profile is invalid');
            }
            metadata.lastAccessedAt = this.now();
            await this.#writeMetadata(metadataPath, metadata).catch(() => {});
            return index;
        }
        catch {
            await this.io.remove(entryPath, {
                recursive: true,
                ignoreAbsent: true,
            }).catch(() => {});
            return null;
        }
    }

    put(cacheKey, index) {
        validateCacheKey(cacheKey);
        validatePDFTextIndex(index);
        return this.#withOperation(() => this.#put(cacheKey, index));
    }

    async #put(cacheKey, index) {
        const indexJSON = JSON.stringify(index);
        const indexBytes = new TextEncoder().encode(indexJSON).length;
        if (indexBytes > this.maxIndexBytes) {
            throw new Error('PDF text index exceeds the cache size limit');
        }
        const entryPath = this.#entryPath(cacheKey);
        await this.#ensureRoot();
        await this.io.makeDirectory(entryPath, { ignoreExisting: true });
        const metadataPath = this.path.join(entryPath, METADATA_FILE);
        const previous = await this.#readMetadata(metadataPath, cacheKey);
        const generation = createGenerationID(this.now());
        const indexFile = `index-${generation}.json`;
        const indexPath = this.path.join(entryPath, indexFile);
        const temporaryPath = `${indexPath}.tmp`;
        try {
            await this.io.writeUTF8(indexPath, indexJSON, {
                tmpPath: temporaryPath,
            });
            const timestamp = this.now();
            await this.#writeMetadata(metadataPath, {
                schemaVersion: CACHE_SCHEMA_VERSION,
                cacheKey,
                profile: index.profile,
                createdAt: previous?.createdAt ?? timestamp,
                lastAccessedAt: timestamp,
                indexFile,
                indexBytes,
                sizeBytes: indexBytes,
            });
        }
        catch (error) {
            await Promise.all([indexPath, temporaryPath].map(filePath => (
                this.io.remove(filePath, { ignoreAbsent: true }).catch(() => {})
            )));
            throw error;
        }
        if (previous?.indexFile && previous.indexFile !== indexFile) {
            await this.io.remove(
                this.path.join(entryPath, previous.indexFile),
                { ignoreAbsent: true }
            ).catch(() => {});
        }
        await this.#scan({ removeInvalid: true, enforceLimits: true });
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
        const timestamp = this.now();
        for (const entryPath of await this.io.getChildren(entriesPath)) {
            try {
                if ((await this.io.stat(entryPath)).type !== 'directory') continue;
                const cacheKey = this.path.filename(entryPath);
                validateCacheKey(cacheKey);
                const metadata = JSON.parse(await this.io.readUTF8(
                    this.path.join(entryPath, METADATA_FILE)
                ));
                validateMetadata(metadata, cacheKey, this.maxIndexBytes);
                if (this.#isExpired(metadata, timestamp)) {
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
        let sizeBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
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
            validateMetadata(metadata, cacheKey, this.maxIndexBytes);
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

export function validatePDFTextIndex(index) {
    if (typeof index?.profile !== 'string'
        || !index.profile
        || index.profile.length > 256
        || !Array.isArray(index.pages)
        || !index.pages.length
        || index.pages.length > MAX_PAGES) {
        throw new Error('Invalid PDF text index');
    }
    let totalTextLength = 0;
    let totalItems = 0;
    for (const [pageIndex, page] of index.pages.entries()) {
        if (page?.pageIndex !== pageIndex
            || typeof page.pageLabel !== 'string'
            || page.pageLabel.length > 1_000
            || typeof page.rawText !== 'string'
            || typeof page.normalizedText !== 'string'
            || page.rawText.length > MAX_PAGE_TEXT_LENGTH
            || !validViewport(page.viewport)
            || !Array.isArray(page.items)
            || typeof page.styles !== 'object'
            || page.styles === null) {
            throw new Error('Invalid PDF text index page');
        }
        totalTextLength += page.rawText.length;
        totalItems += page.items.length;
        if (totalTextLength > MAX_TOTAL_TEXT_LENGTH
            || totalItems > MAX_TEXT_ITEMS
            || Object.keys(page.styles).length > MAX_STYLES
            || createDehyphenatedPdfAnnotationTextIndex(page.rawText).text
                !== page.normalizedText) {
            throw new Error('PDF text index exceeds the safety limit');
        }
        for (const item of page.items) validateTextItem(item, page.rawText);
        for (const style of Object.values(page.styles)) validateStyle(style);
    }
    return index;
}

function validateTextItem(item, rawText) {
    if (typeof item?.text !== 'string'
        || item.text.length > MAX_PAGE_TEXT_LENGTH
        || !['ltr', 'rtl'].includes(item.direction)
        || !Number.isFinite(item.width)
        || item.width < 0
        || !Number.isFinite(item.height)
        || item.height < 0
        || !Array.isArray(item.transform)
        || item.transform.length !== 6
        || !item.transform.every(Number.isFinite)
        || typeof item.fontName !== 'string'
        || item.fontName.length > 512
        || !Number.isSafeInteger(item.sourceFrom)
        || !Number.isSafeInteger(item.sourceTo)
        || item.sourceFrom < 0
        || item.sourceTo < item.sourceFrom
        || item.sourceTo > rawText.length
        || rawText.slice(item.sourceFrom, item.sourceTo) !== item.text) {
        throw new Error('Invalid PDF text index item');
    }
}

function validateStyle(style) {
    if (typeof style?.fontFamily !== 'string'
        || style.fontFamily.length > 512
        || ![null, undefined].includes(style.ascent)
            && !Number.isFinite(style.ascent)
        || ![null, undefined].includes(style.descent)
            && !Number.isFinite(style.descent)
        || typeof style.vertical !== 'boolean') {
        throw new Error('Invalid PDF text index style');
    }
}

function validViewport(viewport) {
    return Array.isArray(viewport?.transform)
        && viewport.transform.length === 6
        && viewport.transform.every(Number.isFinite)
        && Number.isFinite(viewport.width)
        && viewport.width > 0
        && Number.isFinite(viewport.height)
        && viewport.height > 0;
}

function validateCacheKey(value) {
    if (!/^[a-f0-9]{64}$/.test(String(value))) {
        throw new TypeError('A PDF index SHA-256 cache key is required');
    }
}

function validateMetadata(metadata, cacheKey, maxIndexBytes) {
    if (metadata?.schemaVersion !== CACHE_SCHEMA_VERSION
        || metadata.cacheKey !== cacheKey
        || typeof metadata.profile !== 'string'
        || !metadata.profile
        || metadata.profile.length > 256
        || !Number.isFinite(metadata.createdAt)
        || !Number.isFinite(metadata.lastAccessedAt)
        || !/^index-[a-z0-9-]+\.json$/.test(metadata.indexFile)
        || !Number.isSafeInteger(metadata.indexBytes)
        || metadata.indexBytes < 0
        || metadata.indexBytes > maxIndexBytes
        || metadata.sizeBytes !== metadata.indexBytes) {
        throw new Error('Invalid PDF text index cache metadata');
    }
}

function createGenerationID(timestamp) {
    const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '')
        || Math.random().toString(36).slice(2);
    return `${Number(timestamp).toString(36)}-${random}`;
}
