import { MINERU_LOCAL_PARSER_PROFILE_ID } from './parser-profile.js';

const CACHE_READ_WARNING = 'The local Markdown cache could not be read.';
const CACHE_WRITE_WARNING = 'The Markdown result could not be saved to the local cache.';

/**
 * Converts through a self-hosted MinerU 4.0 V1 service.
 *
 * The local service keeps job state only in memory, so this path never writes
 * a pending task and never resumes a job after the service restarts.
 */
export class MinerULocalConversion {
    constructor({
        client,
        cache = null,
        prepareResult = prepareLocalMinerUResult,
        parserProfile = MINERU_LOCAL_PARSER_PROFILE_ID,
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
        if (!forceRefresh && cacheEnabled && key && this.cache) {
            try {
                const cached = await this.cache.get(key);
                throwIfAborted(signal);
                if (cached) {
                    onProgress(100);
                    return {
                        result: withIdentity(cached, this.parserProfile),
                        origin: 'cache',
                        warnings,
                    };
                }
            }
            catch (error) {
                throwIfAborted(signal);
                this.#reportError(error);
                warnings.push(CACHE_READ_WARNING);
            }
        }

        throwIfAborted(signal);
        const raw = await this.client.parse({
            apiKey,
            apiBase,
            fileName,
            fileData,
            onProgress: progress => onProgress(Math.min(96, progress)),
            signal,
        });
        throwIfAborted(signal);
        const prepared = withIdentity(
            await this.prepareResult(raw, { fileData, signal, onProgress }),
            this.parserProfile
        );
        if (this.cache && cacheEnabled && key) {
            try {
                await this.cache.put(key, prepared, { signal });
            }
            catch (error) {
                throwIfAborted(signal);
                this.#reportError(error);
                warnings.push(CACHE_WRITE_WARNING);
            }
        }
        throwIfAborted(signal);
        onProgress(100);
        return { result: prepared, origin: 'fresh', warnings };
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

export function prepareLocalMinerUResult(result) {
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
    delete output.detailedLayout;
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
