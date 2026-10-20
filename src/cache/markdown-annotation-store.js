import {
    invalidMarkdownAnnotationStoreError,
} from '../core/markdown-local-annotations.js';

const STORE_SCHEMA_VERSION = 1;
const MAX_STORE_BYTES = 4 * 1024 * 1024;
const MAX_STORED_ANNOTATIONS = 5_000;
const MAX_BACKUP_NAME_ATTEMPTS = 1_000;

export function createZoteroMarkdownAnnotationStore({
    zotero,
    ioUtils,
    pathUtils,
}) {
    const profilePath = zotero?.Profile?.dir;
    if (!profilePath) throw new Error('The Zotero profile directory is unavailable');
    return new MarkdownAnnotationStore({
        rootPath: pathUtils.join(profilePath, 'mktero-annotations', 'v1'),
        ioUtils,
        pathUtils,
    });
}

export class MarkdownAnnotationStore {
    constructor({ rootPath, ioUtils, pathUtils, now = Date.now }) {
        if (!rootPath) throw new TypeError('An annotation store path is required');
        if (!ioUtils) throw new TypeError('An IOUtils adapter is required');
        if (typeof ioUtils.stat !== 'function') {
            throw new TypeError('An IOUtils stat adapter is required');
        }
        if (!pathUtils) throw new TypeError('A PathUtils adapter is required');
        this.rootPath = rootPath;
        this.io = ioUtils;
        this.path = pathUtils;
        this.now = now;
        this.operationTail = Promise.resolve();
    }

    get(itemID) {
        validateItemID(itemID);
        return this.#withOperation(() => this.#get(itemID));
    }

    put(itemID, annotations) {
        validateItemID(itemID);
        if (!Array.isArray(annotations)
            || annotations.length > MAX_STORED_ANNOTATIONS) {
            throw new TypeError('Invalid Markdown annotation collection');
        }
        return this.#withOperation(() => this.#put(itemID, annotations));
    }

    // Keeps an unreadable file under a backup name so a later put cannot
    // overwrite it. Resolves false when there is no file to keep.
    setAside(itemID) {
        validateItemID(itemID);
        return this.#withOperation(() => this.#setAside(itemID));
    }

    async #get(itemID) {
        const filePath = this.#filePath(itemID);
        if (!(await this.io.exists(filePath))) return [];
        const fileInfo = await this.io.stat(filePath);
        if (!Number.isFinite(fileInfo?.size) || fileInfo.size < 0) {
            throw new Error('Unable to verify Markdown annotation store size');
        }
        // put() never writes past this limit, so a larger file is damaged.
        if (fileInfo.size > MAX_STORE_BYTES) {
            throw invalidMarkdownAnnotationStoreError(
                'Markdown annotation store exceeds the safety limit'
            );
        }
        const json = await this.io.readUTF8(filePath);
        let metadata;
        try {
            metadata = JSON.parse(json);
        }
        catch (error) {
            throw invalidMarkdownAnnotationStoreError(
                'Invalid Markdown annotation store',
                error
            );
        }
        validateMetadata(metadata, itemID);
        return metadata.annotations;
    }

    async #put(itemID, annotations) {
        const metadata = {
            schemaVersion: STORE_SCHEMA_VERSION,
            itemID,
            annotations,
        };
        const serialized = JSON.stringify(metadata);
        if (new TextEncoder().encode(serialized).length > MAX_STORE_BYTES) {
            throw new Error('Markdown annotation store exceeds the safety limit');
        }
        await this.#ensureRoot();
        const filePath = this.#filePath(itemID);
        await this.io.writeUTF8(filePath, serialized, {
            tmpPath: `${filePath}.tmp`,
        });
    }

    async #setAside(itemID) {
        const filePath = this.#filePath(itemID);
        if (!(await this.io.exists(filePath))) return false;
        if (typeof this.io.move !== 'function') {
            throw new Error('An IOUtils move adapter is required');
        }
        const stamp = Math.max(0, Math.trunc(this.now()));
        let backupPath;
        let attempt = 0;
        do {
            if (attempt >= MAX_BACKUP_NAME_ATTEMPTS) {
                throw new Error('No free Markdown annotation backup name');
            }
            const suffix = attempt ? `-${attempt}` : '';
            backupPath = this.path.join(
                this.rootPath,
                `item-${itemID}.corrupt-${stamp}${suffix}.json`
            );
            attempt++;
        } while (await this.io.exists(backupPath));
        await this.io.move(filePath, backupPath, { noOverwrite: true });
        return true;
    }

    async #ensureRoot() {
        const parentPath = this.path.parent?.(this.rootPath);
        if (parentPath) {
            await this.io.makeDirectory(parentPath, { ignoreExisting: true });
        }
        await this.io.makeDirectory(this.rootPath, { ignoreExisting: true });
    }

    #filePath(itemID) {
        return this.path.join(this.rootPath, `item-${itemID}.json`);
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

function validateItemID(itemID) {
    if (!Number.isInteger(itemID) || itemID <= 0) {
        throw new TypeError('A positive Zotero item ID is required');
    }
}

function validateMetadata(metadata, itemID) {
    if (metadata?.schemaVersion !== STORE_SCHEMA_VERSION
        || metadata.itemID !== itemID
        || !Array.isArray(metadata.annotations)
        || metadata.annotations.length > MAX_STORED_ANNOTATIONS) {
        throw invalidMarkdownAnnotationStoreError(
            'Invalid Markdown annotation store'
        );
    }
}
