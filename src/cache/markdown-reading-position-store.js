const STORE_SCHEMA_VERSION = 1;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_ENTRY_BYTES = 8 * 1024;
const MAX_HEADING_KEY_LENGTH = 512;

export function createZoteroMarkdownReadingPositionStore({
    zotero,
    ioUtils,
    pathUtils,
}) {
    const profilePath = zotero?.Profile?.dir;
    if (!profilePath) {
        throw new Error('The Zotero profile directory is unavailable');
    }
    return new MarkdownReadingPositionStore({
        rootPath: pathUtils.join(profilePath, 'mktero-reading-positions', 'v1'),
        ioUtils,
        pathUtils,
    });
}

export class MarkdownReadingPositionStore {
    constructor({
        rootPath,
        ioUtils,
        pathUtils,
        now = Date.now,
    }) {
        if (!rootPath) {
            throw new TypeError('A reading-position store path is required');
        }
        if (!ioUtils) throw new TypeError('An IOUtils adapter is required');
        if (typeof ioUtils.stat !== 'function'
            || typeof ioUtils.getChildren !== 'function') {
            throw new TypeError('Bounded reading-position adapters are required');
        }
        if (!pathUtils) throw new TypeError('A PathUtils adapter is required');
        this.rootPath = rootPath;
        this.io = ioUtils;
        this.path = pathUtils;
        this.now = now;
        this.operationTail = Promise.resolve();
    }

    load(sourceHash, cacheKey) {
        validateHash(sourceHash, 'source hash');
        validateHash(cacheKey, 'cache key');
        return this.#withOperation(() => this.#load(sourceHash, cacheKey));
    }

    save(sourceHash, { cacheKey, anchor } = {}) {
        validateHash(sourceHash, 'source hash');
        validateHash(cacheKey, 'cache key');
        const normalizedAnchor = normalizeAnchor(anchor);
        return this.#withOperation(() => this.#save(
            sourceHash,
            cacheKey,
            normalizedAnchor
        ));
    }

    clear() {
        return this.#withOperation(() => this.#clear());
    }

    getStats() {
        return this.#withOperation(() => this.#stats());
    }

    async #load(sourceHash, cacheKey) {
        const filePath = this.#filePath(sourceHash);
        if (!(await this.io.exists(filePath))) return null;
        const fileInfo = await this.io.stat(filePath);
        validateFileSize(fileInfo);
        const record = JSON.parse(await this.io.readUTF8(filePath));
        validateRecord(record, sourceHash);
        if (record.cacheKey !== cacheKey) {
            await this.io.remove(filePath, { ignoreAbsent: true });
            return null;
        }
        return {
            sourceHash,
            cacheKey: record.cacheKey,
            anchor: normalizeAnchor(record.anchor),
        };
    }

    async #save(sourceHash, cacheKey, anchor) {
        const record = {
            schemaVersion: STORE_SCHEMA_VERSION,
            sourceHash,
            cacheKey,
            anchor,
            updatedAt: this.now(),
        };
        const serialized = JSON.stringify(record);
        if (byteLength(serialized) > MAX_ENTRY_BYTES) {
            throw new Error('Markdown reading position exceeds the safety limit');
        }
        await this.#ensureRoot();
        const filePath = this.#filePath(sourceHash);
        await this.io.writeUTF8(filePath, serialized, {
            tmpPath: `${filePath}.tmp`,
        });
    }

    async #clear() {
        await this.io.remove(this.rootPath, {
            recursive: true,
            ignoreAbsent: true,
        });
        await this.#ensureRoot();
    }

    async #stats() {
        if (!(await this.io.exists(this.rootPath))) {
            return { entries: 0, sizeBytes: 0 };
        }
        const children = await this.io.getChildren(this.rootPath);
        let entries = 0;
        let sizeBytes = 0;
        for (const filePath of children) {
            const fileName = this.path.filename?.(filePath)
                || String(filePath).split(/[/\\]/).pop();
            if (!HASH_PATTERN.test(String(fileName || '').replace(/\.json$/, ''))) {
                continue;
            }
            const fileInfo = await this.io.stat(filePath);
            if (!Number.isSafeInteger(fileInfo?.size) || fileInfo.size < 0) {
                continue;
            }
            entries += 1;
            sizeBytes += fileInfo.size;
        }
        return { entries, sizeBytes };
    }

    #filePath(sourceHash) {
        return this.path.join(this.rootPath, `${sourceHash}.json`);
    }

    async #ensureRoot() {
        const parentPath = this.path.parent?.(this.rootPath);
        if (parentPath) {
            await this.io.makeDirectory(parentPath, { ignoreExisting: true });
        }
        await this.io.makeDirectory(this.rootPath, { ignoreExisting: true });
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

function validateHash(value, label) {
    if (!HASH_PATTERN.test(value || '')) {
        throw new TypeError(`A Markdown ${label} is required`);
    }
}

function validateFileSize(fileInfo) {
    if (!Number.isSafeInteger(fileInfo?.size) || fileInfo.size < 0) {
        throw new Error('Unable to verify Markdown reading-position size');
    }
    if (fileInfo.size > MAX_ENTRY_BYTES) {
        throw new Error('Markdown reading position exceeds the safety limit');
    }
}

function validateRecord(record, sourceHash) {
    if (record?.schemaVersion !== STORE_SCHEMA_VERSION
        || record.sourceHash !== sourceHash
        || !HASH_PATTERN.test(record.cacheKey || '')) {
        throw new Error('Invalid Markdown reading-position store');
    }
    normalizeAnchor(record.anchor);
}

function normalizeAnchor(anchor) {
    const offset = Number(anchor?.offset);
    if (!Number.isFinite(offset)) {
        throw new TypeError('A Markdown reading-position offset is required');
    }
    const normalized = {
        offset: Math.max(0, Math.trunc(offset)),
    };
    const headingKey = String(anchor?.headingKey || '');
    if (headingKey) {
        if (headingKey.length > MAX_HEADING_KEY_LENGTH) {
            throw new TypeError('Invalid Markdown reading-position heading');
        }
        normalized.headingKey = headingKey;
        const occurrence = Number(anchor.headingOccurrence);
        normalized.headingOccurrence = Number.isSafeInteger(occurrence)
            && occurrence >= 0
            ? occurrence
            : 0;
        const relativeOffset = Number(anchor.relativeOffset);
        normalized.relativeOffset = Number.isFinite(relativeOffset)
            ? Math.max(0, Math.trunc(relativeOffset))
            : 0;
    }
    return normalized;
}

function byteLength(value) {
    return new TextEncoder().encode(String(value || '')).length;
}
