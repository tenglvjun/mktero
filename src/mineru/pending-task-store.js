const TASK_SCHEMA_VERSION = 1;
export const DEFAULT_PENDING_TASK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_PENDING_TASK_MAX_ENTRIES = 256;
const DEFAULT_MAX_RECORD_BYTES = 16 * 1024;

export function createZoteroMinerUPendingTaskStore({
    zotero,
    ioUtils,
    pathUtils,
}) {
    const profilePath = zotero?.Profile?.dir;
    if (!profilePath) throw new Error('The Zotero profile directory is unavailable');
    return new MinerUPendingTaskStore({
        rootPath: pathUtils.join(profilePath, 'mktero-conversions', 'v1'),
        ioUtils,
        pathUtils,
    });
}

export class MinerUPendingTaskStore {
    constructor({
        rootPath,
        ioUtils,
        pathUtils,
        now = Date.now,
        maxAgeMs = DEFAULT_PENDING_TASK_MAX_AGE_MS,
        maxEntries = DEFAULT_PENDING_TASK_MAX_ENTRIES,
        maxRecordBytes = DEFAULT_MAX_RECORD_BYTES,
    }) {
        if (!rootPath) throw new TypeError('A pending-task root path is required');
        if (!ioUtils) throw new TypeError('An IOUtils adapter is required');
        if (!pathUtils) throw new TypeError('A PathUtils adapter is required');
        this.rootPath = rootPath;
        this.io = ioUtils;
        this.path = pathUtils;
        this.now = now;
        this.maxAgeMs = maxAgeMs;
        this.maxEntries = maxEntries;
        this.maxRecordBytes = maxRecordBytes;
        this.operationTail = Promise.resolve();
    }

    async get(conversionKey) {
        validateConversionKey(conversionKey);
        return this.#withOperation(() => this.#get(conversionKey));
    }

    async #get(conversionKey) {
        const taskPath = this.#taskPath(conversionKey);
        if (!(await this.io.exists(taskPath))) return null;
        const stored = await this.#readStoredTask(taskPath, conversionKey);
        return stored ? publicTask(stored) : null;
    }

    async put(conversionKey, task) {
        validateConversionKey(conversionKey);
        const stored = {
            schemaVersion: TASK_SCHEMA_VERSION,
            conversionKey,
            batchID: task?.batchID,
            dataID: task?.dataID,
            uploadedAt: task?.uploadedAt,
        };
        validateStoredTask(stored, conversionKey);
        return this.#withOperation(async () => {
            await this.#ensureRoot();
            const taskPath = this.#taskPath(conversionKey);
            const serialized = JSON.stringify(stored);
            if (new TextEncoder().encode(serialized).length > this.maxRecordBytes) {
                throw new Error('Pending MinerU task exceeds its storage limit');
            }
            await this.io.writeUTF8(taskPath, serialized, {
                tmpPath: `${taskPath}.tmp`,
            });
            await this.#scan();
        });
    }

    async delete(conversionKey, batchID) {
        validateConversionKey(conversionKey);
        if (!validOpaqueID(batchID)) {
            throw new TypeError('A MinerU batch ID is required');
        }
        return this.#withOperation(async () => {
            const current = await this.#get(conversionKey);
            if (!current || current.batchID !== batchID) return false;
            await this.io.remove(this.#taskPath(conversionKey), {
                ignoreAbsent: true,
            });
            return true;
        });
    }

    prune() {
        return this.#withOperation(() => this.#scan());
    }

    async #scan() {
        const tasksPath = this.path.join(this.rootPath, 'tasks');
        if (!(await this.io.exists(tasksPath))) return { tasks: 0 };

        const tasks = [];
        for (const taskPath of await this.io.getChildren(tasksPath)) {
            const match = /^([a-f0-9]{64})\.json$/.exec(
                this.#filename(taskPath)
            );
            if (!match) {
                await this.#removeInvalidTask(taskPath);
                continue;
            }
            try {
                const stored = await this.#readStoredTask(taskPath, match[1]);
                if (stored) {
                    tasks.push({
                        path: taskPath,
                        uploadedAt: stored.uploadedAt,
                    });
                }
            }
            catch {
                continue;
            }
        }

        tasks.sort((left, right) => left.uploadedAt - right.uploadedAt);
        while (tasks.length > this.maxEntries) {
            const expired = tasks.shift();
            await this.io.remove(expired.path, { ignoreAbsent: true });
        }
        return { tasks: tasks.length };
    }

    async #readStoredTask(taskPath, conversionKey) {
        const fileInfo = await this.io.stat(taskPath);
        if (fileInfo.type !== 'regular' || fileInfo.size > this.maxRecordBytes) {
            await this.#removeInvalidTask(taskPath);
            return null;
        }
        const serialized = await this.io.readUTF8(taskPath);
        let stored;
        try {
            stored = JSON.parse(serialized);
            validateStoredTask(stored, conversionKey);
        }
        catch {
            await this.#removeInvalidTask(taskPath);
            return null;
        }
        if (this.now() - stored.uploadedAt > this.maxAgeMs) {
            await this.io.remove(taskPath, { ignoreAbsent: true });
            return null;
        }
        return stored;
    }

    #removeInvalidTask(taskPath) {
        return this.io.remove(taskPath, {
            recursive: true,
            ignoreAbsent: true,
        }).catch(() => {});
    }

    #taskPath(conversionKey) {
        return this.path.join(this.rootPath, 'tasks', `${conversionKey}.json`);
    }

    async #ensureRoot() {
        const parentPath = this.path.parent?.(this.rootPath);
        if (parentPath) {
            await this.io.makeDirectory(parentPath, { ignoreExisting: true });
        }
        await this.io.makeDirectory(this.rootPath, { ignoreExisting: true });
        await this.io.makeDirectory(this.path.join(this.rootPath, 'tasks'), {
            ignoreExisting: true,
        });
    }

    #filename(filePath) {
        if (this.path.filename) return this.path.filename(filePath);
        return String(filePath).split(/[\\/]/).pop();
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

function validateConversionKey(conversionKey) {
    if (!/^[a-f0-9]{64}$/.test(String(conversionKey))) {
        throw new TypeError('A SHA-256 conversion key is required');
    }
}

function validateStoredTask(task, conversionKey) {
    if (task?.schemaVersion !== TASK_SCHEMA_VERSION
        || task.conversionKey !== conversionKey
        || !validOpaqueID(task.batchID)
        || !validOpaqueID(task.dataID)
        || !Number.isFinite(task.uploadedAt)
        || task.uploadedAt < 0) {
        throw new Error('Invalid pending MinerU task');
    }
}

function validOpaqueID(value) {
    return typeof value === 'string'
        && /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

function publicTask(stored) {
    return {
        batchID: stored.batchID,
        dataID: stored.dataID,
        uploadedAt: stored.uploadedAt,
    };
}
