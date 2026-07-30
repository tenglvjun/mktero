const STORE_SCHEMA_VERSION = 1;
const MAX_STORE_BYTES = 4 * 1024 * 1024;
const MAX_STORED_ANNOTATIONS = 5_000;

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
    constructor({ rootPath, ioUtils, pathUtils }) {
        if (!rootPath) throw new TypeError('An annotation store path is required');
        if (!ioUtils) throw new TypeError('An IOUtils adapter is required');
        if (typeof ioUtils.stat !== 'function') {
            throw new TypeError('An IOUtils stat adapter is required');
        }
        if (!pathUtils) throw new TypeError('A PathUtils adapter is required');
        this.rootPath = rootPath;
        this.io = ioUtils;
        this.path = pathUtils;
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

    async #get(itemID) {
        const filePath = this.#filePath(itemID);
        if (!(await this.io.exists(filePath))) return [];
        const fileInfo = await this.io.stat(filePath);
        if (!Number.isFinite(fileInfo?.size) || fileInfo.size < 0) {
            throw new Error('Unable to verify Markdown annotation store size');
        }
        if (fileInfo.size > MAX_STORE_BYTES) {
            throw new Error('Markdown annotation store exceeds the safety limit');
        }
        const metadata = JSON.parse(await this.io.readUTF8(filePath));
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
        throw new Error('Invalid Markdown annotation store');
    }
}
