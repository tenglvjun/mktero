import {
    parseMarkdownReadinessRecords,
    serializeMarkdownReadinessRecords,
} from '../cache/markdown-readiness-index.js';

const STORE_SCHEMA_VERSION = 1;
const INDEX_FILE = 'index.json';
const MAX_INDEX_BYTES = 1024 * 1024;

export function createZoteroMarkdownReadinessStore({
    zotero,
    ioUtils,
    pathUtils,
}) {
    const profilePath = zotero?.Profile?.dir;
    if (!profilePath) {
        throw new Error('The Zotero profile directory is unavailable');
    }
    return new MarkdownReadinessStore({
        rootPath: pathUtils.join(profilePath, 'mktero-readiness', 'v1'),
        ioUtils,
        pathUtils,
    });
}

export class MarkdownReadinessStore {
    constructor({
        rootPath,
        ioUtils,
        pathUtils,
    }) {
        if (!rootPath) {
            throw new TypeError('A Markdown readiness store path is required');
        }
        if (!ioUtils) throw new TypeError('An IOUtils adapter is required');
        if (!pathUtils) throw new TypeError('A PathUtils adapter is required');
        this.rootPath = rootPath;
        this.io = ioUtils;
        this.path = pathUtils;
        this.operationTail = Promise.resolve();
    }

    load() {
        return this.#withOperation(() => this.#load());
    }

    save(records) {
        return this.#withOperation(() => this.#save(records));
    }

    clear() {
        return this.#withOperation(() => this.#clear());
    }

    async #load() {
        const filePath = this.#filePath();
        if (!(await this.io.exists(filePath))) return [];
        try {
            const serialized = await this.io.readUTF8(filePath);
            if (new TextEncoder().encode(serialized).length > MAX_INDEX_BYTES) {
                throw new Error('Markdown readiness index exceeds the size limit');
            }
            const parsed = JSON.parse(serialized);
            if (parsed?.schemaVersion !== STORE_SCHEMA_VERSION) {
                throw new Error('Unsupported Markdown readiness index');
            }
            return parseMarkdownReadinessRecords(parsed);
        }
        catch {
            await this.io.remove(filePath, { ignoreAbsent: true }).catch(() => {});
            return [];
        }
    }

    async #save(records) {
        const payload = serializeMarkdownReadinessRecords(records);
        const serialized = JSON.stringify(payload);
        if (new TextEncoder().encode(serialized).length > MAX_INDEX_BYTES) {
            throw new Error('Markdown readiness index exceeds the size limit');
        }
        await this.#ensureRoot();
        const filePath = this.#filePath();
        await this.io.writeUTF8(filePath, serialized, {
            tmpPath: `${filePath}.tmp`,
        });
    }

    async #clear() {
        await this.io.remove(this.rootPath, {
            recursive: true,
            ignoreAbsent: true,
        });
    }

    #filePath() {
        return this.path.join(this.rootPath, INDEX_FILE);
    }

    async #ensureRoot() {
        const parentPath = this.path.parent?.(this.rootPath);
        if (parentPath) {
            await this.io.makeDirectory(parentPath, { ignoreExisting: true });
        }
        await this.io.makeDirectory(this.rootPath, { ignoreExisting: true });
    }

    #withOperation(operation) {
        const previous = this.operationTail;
        const pending = previous.catch(() => {}).then(operation);
        this.operationTail = pending;
        return pending.finally(() => {
            if (this.operationTail === pending) {
                this.operationTail = Promise.resolve();
            }
        });
    }
}
