import { MISTRAL_PARSER_PROFILE_ID } from './parser-profile.js';
import { normalizeMistralResult } from './mistral-result.js';

const CACHE_READ_WARNING = 'The local Markdown cache could not be read.';
const CACHE_WRITE_WARNING = 'The Markdown result could not be saved to the local cache.';

/**
 * Runs the synchronous Mistral OCR request and applies the common cache
 * contract used by the other Markdown conversion providers.
 */
export class MistralConversion {
    constructor({
        client,
        cache = null,
        prepareResult = normalizeMistralResult,
        parserProfile = MISTRAL_PARSER_PROFILE_ID,
        onError = () => {},
    }) {
        if (!client?.ocr) {
            throw new TypeError('A Mistral OCR client is required');
        }
        if (typeof prepareResult !== 'function') {
            throw new TypeError('A Mistral result normalizer is required');
        }
        if (typeof parserProfile !== 'string' || !parserProfile) {
            throw new TypeError('A Mistral parser profile is required');
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
                    onProgress?.(100);
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
        const raw = await this.client.ocr({
            apiKey,
            fileName,
            fileData,
            onProgress: progress => onProgress?.(Math.min(96, progress)),
            signal,
        });
        throwIfAborted(signal);
        const normalized = withIdentity(
            await this.prepareResult(raw, { fileData, signal, onProgress }),
            this.parserProfile
        );
        throwIfAborted(signal);

        if (this.cache && cacheEnabled && key) {
            try {
                await this.cache.put(key, normalized, { signal });
            }
            catch (error) {
                throwIfAborted(signal);
                this.#reportError(error);
                warnings.push(CACHE_WRITE_WARNING);
            }
        }

        throwIfAborted(signal);
        onProgress?.(100);

        return {
            result: normalized,
            origin: 'fresh',
            warnings,
        };
    }

    #reportError(error) {
        try {
            this.onError(error);
        }
        catch {
            // Cache diagnostics must not make successful OCR fail.
        }
    }
}

function withIdentity(result, parserProfile) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        return result;
    }
    return {
        ...result,
        provider: 'mistral',
        parserProfile,
    };
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    if (signal.reason) throw signal.reason;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
}
