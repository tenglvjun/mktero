import { CONVERSION_PROGRESS } from '../core/conversion-progress.js';
import {
    DEFAULT_PENDING_TASK_MAX_AGE_MS,
    DEFAULT_PENDING_TASK_MAX_ENTRIES,
} from './pending-task-store.js';
import { prepareMinerUResult } from './mineru-result.js';
import { throwIfFigureAborted as throwIfAborted } from '../figures/figure-async.js';

export class MinerUConversion {
    constructor({
        client,
        pendingTasks,
        cache = null,
        prepareResult = prepareMinerUResult,
        createDataID = createTaskDataID,
        now = Date.now,
        maxTaskAgeMs = DEFAULT_PENDING_TASK_MAX_AGE_MS,
        maxInMemoryTasks = DEFAULT_PENDING_TASK_MAX_ENTRIES,
        onError = () => {},
    }) {
        if (!client?.submit || !client?.collect) {
            throw new TypeError('A resumable MinerU client is required');
        }
        if (!pendingTasks?.get || !pendingTasks?.put || !pendingTasks?.delete) {
            throw new TypeError('A pending MinerU task store is required');
        }
        this.client = client;
        this.pendingTasks = pendingTasks;
        this.cache = cache;
        if (typeof prepareResult !== 'function') throw new TypeError('A MinerU result preparer is required');
        this.prepareResult = prepareResult;
        this.createDataID = createDataID;
        this.now = now;
        this.maxTaskAgeMs = maxTaskAgeMs;
        this.maxInMemoryTasks = maxInMemoryTasks;
        this.onError = onError;
        this.operationTails = new Map();
        this.currentTasks = new Map();
    }

    async convert({
        key,
        apiKey,
        fileName,
        fileData,
        cacheEnabled = false,
        forceRefresh = false,
        onProgress = () => {},
        signal,
    }) {
        throwIfAborted(signal);
        const warnings = [];
        if (!key) {
            return this.#convertWithoutRecovery({
                apiKey,
                fileName,
                fileData,
                onProgress,
                signal,
            });
        }

        const selected = await this.#withKeyOperation(key, () => (
            this.#selectTask({
                key,
                apiKey,
                fileName,
                fileData,
                cacheEnabled,
                forceRefresh,
                onProgress: (progress, state) => onProgress(Math.min(96, progress), state),
                signal,
                warnings,
            })
        ));
        throwIfAborted(signal);

        if (selected.origin === 'cache') {
            onProgress(CONVERSION_PROGRESS.COMPLETE);
            return { result: selected.result, origin: 'cache', warnings };
        }
        const reportProgress = selected.origin === 'resumed'
            ? progress => onProgress(progress, { resumingTask: true })
            : onProgress;
        if (selected.origin === 'resumed') {
            reportProgress(CONVERSION_PROGRESS.PARSING);
        }
        let result;
        try {
            const raw = await this.client.collect({
                apiKey,
                task: selected.task,
                onProgress: progress => reportProgress(Math.min(96, progress)),
                signal,
            });
            throwIfAborted(signal);
            result = await this.prepareResult(raw, { fileData, signal, onProgress: reportProgress });
            throwIfAborted(signal);
        }
        catch (error) {
            throwIfAborted(signal);
            if (isTerminalTaskError(error)) {
                await this.#clearCurrentTask(key, selected.task.batchID);
            }
            throw error;
        }
        await this.#commitResult({
            key,
            selected,
            result,
            cacheEnabled,
            warnings,
            signal,
        });
        throwIfAborted(signal);
        reportProgress(CONVERSION_PROGRESS.COMPLETE);
        return { result, origin: selected.origin, warnings };
    }

    async #convertWithoutRecovery({
        apiKey,
        fileName,
        fileData,
        onProgress,
        signal,
    }) {
        const task = await this.client.submit({
            apiKey,
            fileName,
            fileData,
            dataID: this.createDataID(),
            onProgress: progress => onProgress(Math.min(96, progress)),
            signal,
        });
        throwIfAborted(signal);
        const raw = await this.client.collect({
            apiKey,
            task,
            onProgress: progress => onProgress(Math.min(96, progress)),
            signal,
        });
        throwIfAborted(signal);
        const result = await this.prepareResult(raw, { fileData, signal, onProgress });
        throwIfAborted(signal);
        onProgress(CONVERSION_PROGRESS.COMPLETE);
        return { result, origin: 'fresh', warnings: [] };
    }

    async #selectTask({
        key,
        apiKey,
        fileName,
        fileData,
        cacheEnabled,
        forceRefresh,
        onProgress,
        signal,
        warnings,
    }) {
        let supersededTask = null;
        if (forceRefresh) {
            supersededTask = await this.#tryReadPendingTask(key);
        }
        else {
            const active = this.#currentTask(key);
            if (active) return { task: active, origin: 'resumed' };

            const pending = await this.#readPendingTask(key);
            if (pending) {
                this.#rememberTask(key, pending);
                return { task: pending, origin: 'resumed' };
            }
            const cached = await this.#readCache(key, cacheEnabled, warnings);
            if (cached) return { result: cached, origin: 'cache' };
        }

        const task = await this.#submitTask({
            key,
            apiKey,
            fileName,
            fileData,
            onProgress,
            signal,
        });
        return { task, origin: 'fresh', supersededTask };
    }

    async #readCache(key, cacheEnabled, warnings) {
        if (!this.cache) return null;
        try {
            const cached = await this.cache.get(key);
            return cached && (cacheEnabled || cached.userEdited) ? cached : null;
        }
        catch (error) {
            this.#reportError(error);
            warnings.push('The local Markdown cache could not be read.');
            return null;
        }
    }

    async #submitTask({
        key,
        apiKey,
        fileName,
        fileData,
        onProgress,
        signal,
    }) {
        const submitted = await this.client.submit({
            apiKey,
            fileName,
            fileData,
            dataID: this.createDataID(),
            onProgress,
            signal,
        });
        const task = {
            batchID: submitted.batchID,
            dataID: submitted.dataID,
            fileName: submitted.fileName,
            uploadedAt: this.now(),
        };
        this.#rememberTask(key, task);
        try {
            await this.pendingTasks.put(key, task);
        }
        catch (error) {
            this.#reportError(error);
        }
        return task;
    }

    async #commitResult({ key, selected, result, cacheEnabled, warnings, signal }) {
        await this.#withKeyOperation(key, async () => {
            throwIfAborted(signal);
            if (this.#currentTask(key)?.batchID !== selected.task.batchID) {
                return;
            }
            if (this.cache && cacheEnabled) {
                try {
                    await this.cache.put(key, result, { signal });
                }
                catch (error) {
                    throwIfAborted(signal);
                    this.#reportError(error);
                    warnings.push(
                        'The Markdown result could not be saved to the local cache.'
                    );
                }
            }
            throwIfAborted(signal);
            if (selected.supersededTask
                && selected.supersededTask.batchID !== selected.task.batchID) {
                await this.#deletePendingTask(
                    key,
                    selected.supersededTask.batchID
                );
            }
            await this.#deletePendingTask(key, selected.task.batchID);
            if (this.#currentTask(key)?.batchID === selected.task.batchID) {
                this.currentTasks.delete(key);
            }
        });
    }

    async #readPendingTask(key) {
        try {
            return await this.pendingTasks.get(key);
        }
        catch (error) {
            this.#reportError(error);
            throw error;
        }
    }

    async #tryReadPendingTask(key) {
        try {
            return await this.pendingTasks.get(key);
        }
        catch (error) {
            this.#reportError(error);
            return null;
        }
    }

    async #deletePendingTask(key, batchID) {
        try {
            return await this.pendingTasks.delete(key, batchID);
        }
        catch (error) {
            this.#reportError(error);
            return false;
        }
    }

    async #clearCurrentTask(key, batchID) {
        await this.#withKeyOperation(key, async () => {
            if (this.#currentTask(key)?.batchID !== batchID) return;
            await this.#deletePendingTask(key, batchID);
            if (this.#currentTask(key)?.batchID === batchID) {
                this.currentTasks.delete(key);
            }
        });
    }

    #currentTask(key) {
        this.#pruneCurrentTasks();
        return this.currentTasks.get(key) || null;
    }

    #rememberTask(key, task) {
        this.currentTasks.set(key, task);
        this.#pruneCurrentTasks();
    }

    #pruneCurrentTasks() {
        const now = this.now();
        for (const [key, task] of this.currentTasks) {
            if (now - task.uploadedAt > this.maxTaskAgeMs) {
                this.currentTasks.delete(key);
            }
        }
        if (this.currentTasks.size <= this.maxInMemoryTasks) return;
        const oldest = [...this.currentTasks.entries()].sort(
            (left, right) => left[1].uploadedAt - right[1].uploadedAt
        );
        while (oldest.length > this.maxInMemoryTasks) {
            this.currentTasks.delete(oldest.shift()[0]);
        }
    }

    async #withKeyOperation(key, operation) {
        const previous = this.operationTails.get(key) || Promise.resolve();
        const pending = previous.catch(() => {}).then(operation);
        this.operationTails.set(key, pending);
        try {
            return await pending;
        }
        finally {
            if (this.operationTails.get(key) === pending) {
                this.operationTails.delete(key);
            }
        }
    }

    #reportError(error) {
        try {
            this.onError(error);
        }
        catch {
            // Recovery diagnostics must not make PDF conversion fail.
        }
    }
}

export function createTaskDataID(secureRandom = globalThis.crypto) {
    if (typeof secureRandom?.randomUUID === 'function') {
        return `mktero-${secureRandom.randomUUID()}`;
    }
    if (typeof secureRandom?.getRandomValues === 'function') {
        const bytes = new Uint8Array(16);
        secureRandom.getRandomValues(bytes);
        const random = Array.from(
            bytes,
            byte => byte.toString(16).padStart(2, '0')
        ).join('');
        return `mktero-${random}`;
    }
    throw new Error('Secure random number generation is unavailable');
}

function isTerminalTaskError(error) {
    return [
        'MINERU_ARCHIVE_TOO_LARGE',
        'MINERU_EMPTY_RESULT',
        'MINERU_INVALID_RESULT',
        'MINERU_RESULT_MISSING',
        'MINERU_TASK_FAILED',
        'MINERU_TASK_NOT_FOUND',
    ].includes(error?.code);
}
