import { MINERU_LOCAL_PARSER_PROFILE_ID } from './parser-profile.js';
import { prepareMinerUDocument } from './document/prepare.js';
import { validateMinerULayout } from './document/result-bundle.js';
import { extractMinerULocalResultFromZip } from './local-result.js';

const CACHE_READ_WARNING = 'The local Markdown cache could not be read.';
const CACHE_WRITE_WARNING = 'The Markdown result could not be saved to the local cache.';

/**
 * Converts through a self-hosted MinerU 4.0 V1 service.
 *
 * The local service keeps job state only in memory, so this path never writes
 * a pending task and never resumes a job after the service restarts. Its
 * trimmed result archive is kept in the raw-result store, so a new document
 * pipeline reads it again without the service.
 */
export class MinerULocalConversion {
    constructor({
        client,
        cache = null,
        prepareResult = prepareLocalMinerUResult,
        parserProfile = MINERU_LOCAL_PARSER_PROFILE_ID,
        resultStore = null,
        createResultKey = null,
        extractStoredResult = extractMinerULocalResultFromZip,
        createTranslationSourceKeys = null,
        onError = () => {},
    }) {
        if (!client?.parse) {
            throw new TypeError('A local MinerU client is required');
        }
        if (typeof prepareResult !== 'function') {
            throw new TypeError('A local MinerU result preparer is required');
        }
        if (typeof parserProfile !== 'string' || !parserProfile) {
            throw new TypeError('A local MinerU parser profile is required');
        }
        this.client = client;
        this.cache = cache;
        this.prepareResult = prepareResult;
        this.parserProfile = parserProfile;
        this.resultStore = resultStore?.get && resultStore?.put ? resultStore : null;
        this.createResultKey = typeof createResultKey === 'function' ? createResultKey : null;
        this.extractStoredResult = extractStoredResult;
        this.createTranslationSourceKeys = typeof createTranslationSourceKeys === 'function'
            ? createTranslationSourceKeys : null;
        this.onError = onError;
    }

    async convert({
        key,
        apiKey,
        apiBase,
        fileName,
        fileData,
        cacheEnabled = false,
        forceRefresh = false,
        onProgress = () => {},
        signal,
    }) {
        throwIfAborted(signal);
        const warnings = [];
        if (!forceRefresh) {
            const cached = await this.readCached({
                key,
                fileData,
                cacheEnabled,
                signal,
                onProgress,
                warnings,
            });
            if (cached) {
                onProgress(100);
                return cached;
            }
        }

        throwIfAborted(signal);
        const resultKey = cacheEnabled ? await this.#resultKey(fileData, signal) : null;
        // A result the service produced before is read again from the store.
        const stored = forceRefresh ? null : await this.#readStoredResult(resultKey, signal);
        let raw = stored;
        if (!raw) {
            const parsed = await this.client.parse({
                apiKey,
                apiBase,
                fileName,
                fileData,
                ...(resultKey ? { includeArchive: true } : {}),
                onProgress: progress => onProgress(Math.min(96, progress)),
                signal,
            });
            throwIfAborted(signal);
            raw = await this.#keepResultArchive(resultKey, parsed, signal);
        }
        throwIfAborted(signal);
        const prepared = withIdentity(
            await this.prepareResult(raw, { fileData, signal, onProgress }),
            this.parserProfile
        );
        if (this.cache && cacheEnabled && key) {
            try {
                await this.cache.put(key, prepared, { signal });
                await this.#copyEarlierTranslations(key, fileData, signal);
            }
            catch (error) {
                throwIfAborted(signal);
                this.#reportError(error);
                warnings.push(CACHE_WRITE_WARNING);
            }
        }
        throwIfAborted(signal);
        onProgress(100);
        return { result: prepared, origin: stored ? 'cache' : 'fresh', warnings };
    }

    async #resultKey(fileData, signal) {
        if (!this.resultStore || !this.createResultKey || !fileData) return null;
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

    async #readStoredResult(resultKey, signal) {
        if (!resultKey) return null;
        try {
            const stored = await this.resultStore.get(resultKey, { signal });
            throwIfAborted(signal);
            return stored?.archive ? this.extractStoredResult(stored.archive) : null;
        }
        catch (error) {
            throwIfAborted(signal);
            if (error?.name === 'AbortError') throw error;
            this.#reportError(error);
            await this.resultStore.delete?.(resultKey)?.catch?.(() => {});
            return null;
        }
    }

    // The archive goes to the store and never into the prepared document.
    async #keepResultArchive(resultKey, parsed, signal) {
        if (!parsed || typeof parsed !== 'object' || !('resultArchive' in parsed)) return parsed;
        const { resultArchive, ...raw } = parsed;
        if (!resultKey || !resultArchive) return raw;
        try {
            await this.resultStore.put(resultKey, { archive: resultArchive, provider: 'mineru-local' }, { signal });
        }
        catch (error) {
            throwIfAborted(signal);
            this.#reportError(error);
        }
        return raw;
    }

    async #copyEarlierTranslations(key, fileData, signal) {
        if (!this.createTranslationSourceKeys || !this.cache?.copyTranslations || !fileData) return;
        try {
            for (const previousKey of new Set(await this.createTranslationSourceKeys(fileData))) {
                throwIfAborted(signal);
                if (previousKey && previousKey !== key && await this.cache.copyTranslations(previousKey, key)) return;
            }
        }
        catch (error) {
            throwIfAborted(signal);
            if (error?.name === 'AbortError') throw error;
            this.#reportError(error);
        }
    }

    async readCached({
        key,
        cacheEnabled = false,
        signal,
        warnings,
    } = {}) {
        const reportedWarnings = Array.isArray(warnings) ? warnings : [];
        if (!cacheEnabled || !key || !this.cache) return null;
        throwIfAborted(signal);
        try {
            const cached = await this.cache.get(key);
            throwIfAborted(signal);
            if (!cached) return null;
            return {
                result: withIdentity(cached, this.parserProfile),
                origin: 'cache',
                warnings: reportedWarnings,
            };
        }
        catch (error) {
            if (error?.name === 'AbortError') throw error;
            throwIfAborted(signal);
            this.#reportError(error);
            reportedWarnings.push(CACHE_READ_WARNING);
            return null;
        }
    }

    #reportError(error) {
        try {
            this.onError(error);
        }
        catch {
            // Cache diagnostics must not make a successful conversion fail.
        }
    }
}

// A result with MinerU 4.0's document structure goes through the same
// document pipeline as cloud results (with the PDF's text layer when the
// caller has it); one without keeps MinerU's own Markdown.
export function prepareLocalMinerUResult(result, { pdfText = null } = {}) {
    if (validateMinerULayout(result?.layout) && result.layout.pages.some(page => page.blocks.length)) {
        try {
            const prepared = prepareMinerUDocument({ ...result, contentList: [] }, { pdfText });
            // A structure that reads as nothing never hides MinerU's Markdown.
            if (prepared.markdown.trim()) return prepared;
        }
        catch (error) {
            if (error?.name === 'AbortError') throw error;
            // An unreadable structure falls back to the service's Markdown.
        }
    }
    return {
        markdown: result?.markdown,
        assets: result?.assets || [],
        assetBasePath: result?.assetBasePath || '',
        contentList: [],
        extractedPages: result?.extractedPages ?? null,
        totalPages: result?.totalPages ?? null,
    };
}

function withIdentity(result, parserProfile) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
    const output = {
        ...result,
        provider: 'mineru',
        parserProfile,
    };
    delete output.layout;
    delete output.figureMap;
    return output;
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    if (signal.reason) throw signal.reason;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
}
