import { CONVERSION_PROGRESS } from '../core/conversion-progress.js';
import {
    DEFAULT_PENDING_TASK_MAX_AGE_MS,
    DEFAULT_PENDING_TASK_MAX_ENTRIES,
} from './pending-task-store.js';
import { prepareMinerUResult } from './document/prepare.js';
import { extractMinerUResultFromZip } from './zip-markdown.js';
import { throwIfFigureAborted as throwIfAborted } from '../figures/figure-async.js';
import { notifyDiagnosticJob } from '../diagnostics/diagnostic-log.js';

export class MinerUConversion {
    constructor({
        client,
        pendingTasks,
        cache = null,
        prepareResult = prepareMinerUResult,
        progressiveResult = null,
        restoreCachedInput = null,
        recoverFigures = async result => result,
        createPreviousCacheKeys = null,
        createTranslationSourceKeys = null,
        resultStore = null,
        createResultKey = null,
        extractStoredResult = extractMinerUResultFromZip,
        createDataID = createTaskDataID,
        now = Date.now,
        maxTaskAgeMs = DEFAULT_PENDING_TASK_MAX_AGE_MS,
        maxInMemoryTasks = DEFAULT_PENDING_TASK_MAX_ENTRIES,
        onError = () => {},
        onJob = null,
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
        if (progressiveResult !== null && typeof progressiveResult !== 'function') {
            throw new TypeError('A progressive result preparer must be a function');
        }
        this.progressiveResult = progressiveResult;
        if (restoreCachedInput !== null && typeof restoreCachedInput !== 'function') {
            throw new TypeError('A cached figure restoration runner must be a function');
        }
        this.restoreCachedInput = restoreCachedInput;
        this.recoverFigures = recoverFigures;
        this.createPreviousCacheKeys = createPreviousCacheKeys;
        this.createTranslationSourceKeys = typeof createTranslationSourceKeys === 'function'
            ? createTranslationSourceKeys : null;
        this.resultStore = resultStore?.get && resultStore?.put ? resultStore : null;
        this.createResultKey = typeof createResultKey === 'function' ? createResultKey : null;
        this.extractStoredResult = extractStoredResult;
        this.createDataID = createDataID;
        this.now = now;
        this.maxTaskAgeMs = maxTaskAgeMs;
        this.maxInMemoryTasks = maxInMemoryTasks;
        this.onError = onError;
        this.onJob = onJob;
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
        onProgressiveFigures = null,
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
                onProgressiveFigures,
                signal,
            });
        }

        const emitProgressive = typeof onProgressiveFigures === 'function'
            ? event => onProgressiveFigures({ ...event, cacheKey: key })
            : null;
        const reportBounded = (progress, state) => onProgress(Math.min(96, progress), state);
        const resultKey = cacheEnabled ? await this.#resultKey(fileData, signal) : null;
        const selected = await this.#withKeyOperation(key, async () => {
            const resumed = await this.#selectResumableTask({ key, forceRefresh });
            if (resumed?.origin) return resumed;
            if (!forceRefresh) {
                const cached = await this.#readCached({
                    key,
                    fileData,
                    cacheEnabled,
                    signal,
                    onProgress: reportBounded,
                    onProgressiveFigures: emitProgressive,
                    warnings,
                    resultKey,
                });
                if (cached) return cached;
            }
            const task = await this.#submitTask({
                key,
                apiKey,
                fileName,
                fileData,
                onProgress: reportBounded,
                signal,
            });
            return {
                task,
                origin: 'fresh',
                supersededTask: resumed?.supersededTask || null,
            };
        });
        throwIfAborted(signal);
        if (selected.task?.batchID) {
            notifyDiagnosticJob(this.onJob, {
                provider: 'mineru',
                id: selected.task.batchID,
                status: selected.origin === 'resumed' ? 'resumed' : 'submitted',
            });
        }

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
            const collected = await this.client.collect({
                apiKey,
                task: selected.task,
                onProgress: progress => reportProgress(Math.min(96, progress)),
                ...(resultKey && this.resultStore ? { includeArchive: true } : {}),
                signal,
            });
            throwIfAborted(signal);
            const raw = await this.#keepResultArchive(resultKey, collected, signal);
            result = this.progressiveResult
                ? await this.progressiveResult(raw, { fileData, signal,
                    onProgress: reportProgress, onEvent: emitProgressive })
                : await this.prepareResult(raw, { fileData, signal, onProgress: reportProgress });
            result = await this.#recoverFigures(result, { fileData, signal, onProgress: reportProgress });
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
            fileData,
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
        onProgressiveFigures,
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
        const prepared = this.progressiveResult
            ? await this.progressiveResult(raw, { fileData, signal, onProgress, onEvent: onProgressiveFigures })
            : await this.prepareResult(raw, { fileData, signal, onProgress });
        const result = await this.#recoverFigures(prepared, { fileData, signal, onProgress });
        throwIfAborted(signal);
        onProgress(CONVERSION_PROGRESS.COMPLETE);
        return { result, origin: 'fresh', warnings: [] };
    }

    async readCached(options = {}) {
        if (!options?.key) return null;
        const resultKey = options.cacheEnabled
            ? await this.#resultKey(options.fileData, options.signal)
            : null;
        return this.#withKeyOperation(
            options.key,
            () => this.#readCached({ ...options, resultKey })
        );
    }

    async #resultKey(fileData, signal) {
        if (!this.resultStore || !this.createResultKey) return null;
        try {
            const resultKey = await this.createResultKey(fileData);
            throwIfAborted(signal);
            return typeof resultKey === 'string' && resultKey ? resultKey : null;
        }
        catch (error) {
            throwIfAborted(signal);
            this.#reportError(error);
            return null;
        }
    }

    // Stores the trimmed MinerU archive and strips it from the raw result so
    // the bytes never reach the document pipeline or the derived cache.
    async #keepResultArchive(resultKey, collected, signal) {
        if (!collected || typeof collected !== 'object' || !('resultArchive' in collected)) return collected;
        const { resultArchive, ...raw } = collected;
        if (!resultKey || !this.resultStore || !resultArchive) return raw;
        try {
            await this.resultStore.put(resultKey, {
                archive: resultArchive,
                provider: 'mineru',
                extractedPages: raw.extractedPages,
                totalPages: raw.totalPages,
            }, { signal });
        }
        catch (error) {
            throwIfAborted(signal);
            this.#reportError(error);
        }
        return raw;
    }

    async #readStoredResult(resultKey, signal) {
        if (!resultKey || !this.resultStore) return null;
        try {
            const stored = await this.resultStore.get(resultKey, { signal });
            throwIfAborted(signal);
            if (!stored) return null;
            const extracted = this.extractStoredResult(stored.archive);
            return {
                ...extracted,
                extractedPages: stored.extractedPages ?? null,
                totalPages: stored.totalPages ?? null,
            };
        }
        catch (error) {
            throwIfAborted(signal);
            if (error?.name === 'AbortError') throw error;
            this.#reportError(error);
            await this.resultStore.delete?.(resultKey).catch(() => {});
            return null;
        }
    }

    // A stored MinerU result is prepared exactly like a downloaded one, so a
    // document-pipeline change is re-derived without contacting MinerU.
    async #prepareStoredResult(raw, { fileData, signal, onProgress, onProgressiveFigures }) {
        const prepared = this.progressiveResult
            ? await this.progressiveResult(raw, { fileData, signal, onProgress, onEvent: onProgressiveFigures })
            : await this.prepareResult(raw, { fileData, signal, onProgress });
        const result = await this.#recoverFigures(prepared, { fileData, signal, onProgress });
        throwIfAborted(signal);
        return result;
    }

    async #readCached({
        key,
        fileData,
        cacheEnabled = false,
        signal,
        onProgress = () => {},
        onProgressiveFigures = null,
        warnings,
        resultKey = null,
    } = {}) {
        const reportedWarnings = Array.isArray(warnings) ? warnings : [];
        if (!key) return null;
        throwIfAborted(signal);
        let cached = await this.#readCache(key, cacheEnabled, reportedWarnings);
        throwIfAborted(signal);
        let migrated = false;
        if (!cached && cacheEnabled && resultKey) {
            const stored = await this.#readStoredResult(resultKey, signal);
            if (stored) {
                const result = await this.#prepareStoredResult(stored, {
                    fileData, signal, onProgress, onProgressiveFigures,
                });
                await this.#putCache(key, result, signal, reportedWarnings, fileData);
                return { result, origin: 'cache', warnings: reportedWarnings };
            }
        }
        if (!cached && cacheEnabled && this.createPreviousCacheKeys) {
            try {
                const previousKeys = await this.createPreviousCacheKeys(fileData);
                throwIfAborted(signal);
                for (const previousKey of new Set(previousKeys)) {
                    if (!previousKey || previousKey === key) continue;
                    cached = await this.#readCache(previousKey, cacheEnabled, reportedWarnings);
                    throwIfAborted(signal);
                    migrated = Boolean(cached);
                    if (cached) break;
                }
            }
            catch (error) {
                throwIfAborted(signal);
                if (error?.name === 'AbortError') throw error;
                this.#reportError(error);
            }
        }
        if (!cached) return null;
        const wasPending = cached.figureRestoration?.status === 'pending';
        // An unfinished figure restoration starts again from the raw MinerU
        // result; the cached document stays in use when that is gone.
        if (wasPending && cached.figureRestoration.source === 'mineru-result-store' && resultKey) {
            const stored = await this.#readStoredResult(resultKey, signal);
            if (stored) {
                const result = await this.#prepareStoredResult(stored, {
                    fileData, signal, onProgress, onProgressiveFigures,
                });
                if (cacheEnabled) await this.#putCache(key, result, signal, reportedWarnings, migrated ? fileData : null);
                return { result, origin: 'cache', warnings: reportedWarnings };
            }
        }
        let resolved = cached;
        if (wasPending && cached.restorationInput && this.restoreCachedInput) {
            try {
                resolved = await this.restoreCachedInput(cached.restorationInput, {
                    fileData,
                    signal,
                    onProgress,
                    onEvent: onProgressiveFigures,
                });
            }
            catch (error) {
                throwIfAborted(signal);
                if (error?.name === 'AbortError') throw error;
                this.#reportError(error);
                resolved = cached;
            }
        }
        const result = await this.#recoverFigures(resolved, { fileData, signal, onProgress });
        throwIfAborted(signal);
        if (cacheEnabled && (migrated || result !== cached || wasPending)) {
            await this.#putCache(key, result, signal, reportedWarnings, migrated ? fileData : null);
        }
        return { result, origin: 'cache', warnings: reportedWarnings };
    }

    // `fileData` is passed when the entry is new for this profile, so the
    // translations of the same PDF under an earlier profile carry over.
    async #putCache(key, result, signal, warnings, fileData = null) {
        if (!this.cache) return;
        try { await this.cache.put(key, result, { signal }); }
        catch (error) {
            throwIfAborted(signal);
            if (error?.name === 'AbortError') throw error;
            this.#reportError(error);
            warnings.push('The Markdown result could not be saved to the local cache.');
            return;
        }
        if (fileData) await this.#copyEarlierTranslations(key, fileData, signal);
    }

    // The newest earlier profile entry that has translations gives them to
    // the new entry. Reading a copied translation reuses only the blocks
    // whose source text is unchanged, so this never shows a stale block.
    // Failure is only reported: the conversion result is already saved.
    async #copyEarlierTranslations(key, fileData, signal) {
        if (!this.createTranslationSourceKeys || !this.cache?.copyTranslations || !fileData) return;
        try {
            const previousKeys = await this.createTranslationSourceKeys(fileData);
            for (const previousKey of new Set(previousKeys)) {
                throwIfAborted(signal);
                if (!previousKey || previousKey === key) continue;
                if (await this.cache.copyTranslations(previousKey, key)) return;
            }
        }
        catch (error) {
            throwIfAborted(signal);
            if (error?.name === 'AbortError') throw error;
            this.#reportError(error);
        }
    }

    async #selectResumableTask({ key, forceRefresh }) {
        if (forceRefresh) {
            return { supersededTask: await this.#tryReadPendingTask(key) };
        }
        const active = this.#currentTask(key);
        if (active) return { task: active, origin: 'resumed' };
        const pending = await this.#readPendingTask(key);
        if (pending) {
            this.#rememberTask(key, pending);
            return { task: pending, origin: 'resumed' };
        }
        return null;
    }

    async #readCache(key, cacheEnabled, warnings) {
        if (!this.cache) return null;
        try {
            const cached = await this.cache.get(key);
            return cached && (cacheEnabled || cached.userEdited) ? cached : null;
        }
        catch (error) {
            if (error?.name === 'AbortError') throw error;
            this.#reportError(error);
            warnings.push('The local Markdown cache could not be read.');
            return null;
        }
    }

    async #recoverFigures(result, context) {
        if (result.userEdited) return result;
        try { return await this.recoverFigures(result, context); }
        catch {
            throwIfAborted(context.signal);
            return result;
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

    async #commitResult({ key, selected, result, cacheEnabled, warnings, signal, fileData }) {
        await this.#withKeyOperation(key, async () => {
            throwIfAborted(signal);
            if (this.#currentTask(key)?.batchID !== selected.task.batchID) {
                return;
            }
            if (this.cache && cacheEnabled) {
                try {
                    await this.cache.put(key, result, { signal });
                    await this.#copyEarlierTranslations(key, fileData, signal);
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
