import {
    normalizeArxivID,
    normalizeDOI,
    normalizeSemanticScholarPaper,
} from './citation-identifiers.js';
import { createRuntimeAbortController } from '../platform/abort-controller.js';

const DEFAULT_API_BASE = 'https://api.semanticscholar.org/graph/v1';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const MAX_RETRY_AFTER_MS = 60_000;
const MAX_BATCH_SIZE = 500;
const MAX_REFERENCES = 1_000;
const REFERENCE_FIELDS = 'title,year,externalIds,authors';
const RESOLUTION_FIELDS = 'paperId,title,year,externalIds';
const OPEN_ACCESS_FIELDS = 'openAccessPdf,externalIds';

export class SemanticScholarClient {
    constructor({
        fetch = globalThis.fetch?.bind(globalThis),
        sleep = delay,
        now = Date.now,
        createAbortController = createRuntimeAbortController,
        setTimer = globalThis.setTimeout?.bind(globalThis),
        clearTimer = globalThis.clearTimeout?.bind(globalThis),
        apiBase = DEFAULT_API_BASE,
        requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
        maxRetryAttempts = DEFAULT_MAX_RETRY_ATTEMPTS,
        retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    } = {}) {
        if (typeof fetch !== 'function') {
            throw new TypeError('A fetch implementation is required');
        }
        if (typeof createAbortController !== 'function') {
            throw new TypeError('An AbortController factory is required');
        }
        if (typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
            throw new TypeError('Timer adapters are required');
        }
        this.fetch = fetch;
        this.sleep = sleep;
        this.now = now;
        this.createAbortController = createAbortController;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.apiBase = String(apiBase || DEFAULT_API_BASE).replace(/\/$/, '');
        this.requestTimeoutMs = boundedInteger(
            requestTimeoutMs,
            1_000,
            60_000,
            DEFAULT_REQUEST_TIMEOUT_MS
        );
        this.maxRetryAttempts = boundedInteger(
            maxRetryAttempts,
            1,
            5,
            DEFAULT_MAX_RETRY_ATTEMPTS
        );
        this.retryBaseDelayMs = boundedInteger(
            retryBaseDelayMs,
            0,
            60_000,
            DEFAULT_RETRY_BASE_DELAY_MS
        );
    }

    supports(paper) {
        return Boolean(normalizeDOI(paper?.doi) || normalizeArxivID(paper?.arxivID));
    }

    async resolveOpenAccessPDF({
        doi = '',
        arxivID = '',
        apiKey = '',
        signal,
        onRetry = () => {},
    } = {}) {
        const normalizedDOI = normalizeDOI(doi);
        const normalizedArxivID = normalizeArxivID(arxivID);
        const queryID = normalizedDOI
            ? `DOI:${normalizedDOI}`
            : normalizedArxivID ? `ARXIV:${normalizedArxivID}` : '';
        if (!queryID) return null;
        try {
            const payload = await this.#requestJSON(
                `${this.apiBase}/paper/${encodeURIComponent(queryID)}`
                    + `?fields=${encodeURIComponent(OPEN_ACCESS_FIELDS)}`,
                { headers: requestHeaders(apiKey) },
                signal,
                onRetry
            );
            return normalizePublicURL(payload?.openAccessPdf?.url);
        }
        catch (error) {
            if (error?.code === 'S2_HTTP_ERROR' && error.status === 404) {
                return null;
            }
            throw error;
        }
    }

    async resolvePapers({
        papers,
        apiKey = '',
        signal,
        onRetry = () => {},
    } = {}) {
        if (!Array.isArray(papers)) {
            throw new TypeError('Citation papers are required');
        }
        throwIfAborted(signal);
        const resolved = new Map();
        const primary = papers.flatMap(paper => {
            const localID = normalizedLocalID(paper);
            const doi = normalizeDOI(paper?.doi);
            const arxivID = normalizeArxivID(paper?.arxivID);
            const queryID = doi
                ? `DOI:${doi}`
                : arxivID ? `ARXIV:${arxivID}` : '';
            return localID && queryID
                ? [{ localID, queryID, doi, arxivID }]
                : [];
        });
        await this.#resolveEntries(primary, resolved, apiKey, signal, onRetry);
        const fallbacks = primary.filter(entry => (
            !resolved.has(entry.localID)
            && entry.doi
            && entry.arxivID
        )).map(entry => ({
            ...entry,
            queryID: `ARXIV:${entry.arxivID}`,
        }));
        await this.#resolveEntries(fallbacks, resolved, apiKey, signal, onRetry);
        return resolved;
    }

    async #resolveEntries(entries, resolved, apiKey, signal, onRetry) {
        for (let index = 0; index < entries.length; index += MAX_BATCH_SIZE) {
            const batch = entries.slice(index, index + MAX_BATCH_SIZE);
            const payload = await this.#requestJSON(
                `${this.apiBase}/paper/batch?fields=${encodeURIComponent(RESOLUTION_FIELDS)}`,
                {
                    method: 'POST',
                    headers: requestHeaders(apiKey, true),
                    body: JSON.stringify({ ids: batch.map(entry => entry.queryID) }),
                },
                signal,
                onRetry
            );
            if (!Array.isArray(payload)) {
                throw invalidResponseError();
            }
            for (const [offset, entry] of batch.entries()) {
                const paper = normalizeSemanticScholarPaper(payload[offset]);
                if (!paper) continue;
                resolved.set(entry.localID, paper);
            }
        }
    }

    async fetchReferences({
        doi = '',
        arxivID = '',
        apiKey = '',
        signal,
        onRetry = () => {},
    } = {}) {
        const normalizedDOI = normalizeDOI(doi);
        const normalizedArxivID = normalizeArxivID(arxivID);
        const queryIDs = [
            normalizedDOI ? `DOI:${normalizedDOI}` : '',
            normalizedArxivID ? `ARXIV:${normalizedArxivID}` : '',
        ].filter(Boolean);
        if (!queryIDs.length) {
            throw new TypeError('A DOI or arXiv ID is required');
        }
        throwIfAborted(signal);
        for (const [index, queryID] of queryIDs.entries()) {
            let payload;
            try {
                payload = await this.#requestJSON(
                    `${this.apiBase}/paper/${encodeURIComponent(queryID)}/references`
                        + `?fields=${encodeURIComponent(REFERENCE_FIELDS)}`
                        + `&limit=${MAX_REFERENCES}`,
                    { headers: requestHeaders(apiKey) },
                    signal,
                    onRetry
                );
            }
            catch (error) {
                if (error?.code === 'S2_HTTP_ERROR'
                    && error.status === 404
                    && index < queryIDs.length - 1) {
                    continue;
                }
                if (error?.code === 'S2_HTTP_ERROR' && error.status === 404) {
                    return negativeResult(this.now());
                }
                throw error;
            }
            if (!Array.isArray(payload?.data)) {
                throw invalidResponseError();
            }
            const references = payload.data.slice(0, MAX_REFERENCES)
                .map(entry => normalizeSemanticScholarPaper(entry?.citedPaper))
                .filter(Boolean);
            if (!references.length) return negativeResult(this.now());
            return {
                status: 'fetched',
                references,
                truncated: payload.next !== null
                    && payload.next !== undefined,
                fetchedAt: this.now(),
            };
        }
        return negativeResult(this.now());
    }

    async #requestJSON(url, options, signal, onRetry) {
        return this.#withRetry(() => this.#runRequest(
            url,
            options,
            signal,
            async (response, requestSignal) => {
                if (!response?.ok) throw httpError(response, this.now());
                const bytes = await readResponse(response, requestSignal);
                try {
                    return JSON.parse(new TextDecoder().decode(bytes));
                }
                catch {
                    throw invalidResponseError();
                }
            }
        ), signal, onRetry);
    }

    async #runRequest(url, options, signal, consumeResponse) {
        throwIfAborted(signal);
        const controller = this.createAbortController();
        let timedOut = false;
        const relayAbort = () => controller.abort(signal?.reason);
        signal?.addEventListener('abort', relayAbort, { once: true });
        const timeoutID = this.setTimer(() => {
            timedOut = true;
            controller.abort();
        }, this.requestTimeoutMs);
        try {
            const response = await this.fetch(url, {
                ...options,
                signal: controller.signal,
            });
            return await consumeResponse(response, controller.signal);
        }
        catch (error) {
            if (signal?.aborted) throw abortReason(signal);
            if (timedOut) {
                const timeoutError = new Error('Semantic Scholar request timed out');
                timeoutError.code = 'S2_REQUEST_TIMEOUT';
                throw timeoutError;
            }
            if (isAbortError(error) || isKnownError(error)) throw error;
            const networkError = new Error('Semantic Scholar request failed');
            networkError.code = 'S2_NETWORK_ERROR';
            throw networkError;
        }
        finally {
            this.clearTimer(timeoutID);
            signal?.removeEventListener('abort', relayAbort);
        }
    }

    async #withRetry(operation, signal, onRetry) {
        for (let attempt = 0; attempt < this.maxRetryAttempts; attempt++) {
            try {
                return await operation();
            }
            catch (error) {
                const finalAttempt = attempt === this.maxRetryAttempts - 1;
                if (finalAttempt || signal?.aborted || !isRetryable(error)) {
                    throw error;
                }
                const retryAfterMs = Number.isFinite(error.retryAfterMs)
                    ? Math.min(error.retryAfterMs, MAX_RETRY_AFTER_MS)
                    : this.retryBaseDelayMs * (2 ** attempt);
                notifyRetry(onRetry, {
                    code: error?.code === 'S2_HTTP_ERROR'
                        && error.status === 429
                        ? 'rate-limited'
                        : 'request-retry',
                    attempt: attempt + 1,
                    retryAfterMs,
                });
                await waitFor(this.sleep, retryAfterMs, signal);
            }
        }
        throw new Error('Semantic Scholar retries were exhausted');
    }
}

function requestHeaders(apiKey, includeJSON = false) {
    const headers = includeJSON ? { 'Content-Type': 'application/json' } : {};
    const key = String(apiKey || '').trim();
    if (key) headers['x-api-key'] = key;
    return headers;
}

async function readResponse(response, signal) {
    const reader = response?.body?.getReader?.();
    if (!reader) {
        return new Uint8Array(await response.arrayBuffer());
    }
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            throwIfAborted(signal);
            const { done, value } = await readChunk(reader, signal);
            if (done) break;
            const chunk = value instanceof Uint8Array
                ? value
                : new Uint8Array(value);
            total += chunk.length;
            chunks.push(chunk);
        }
    }
    catch (error) {
        cancelReader(reader);
        throw error;
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
    }
    return combined;
}

async function readChunk(reader, signal) {
    throwIfAborted(signal);
    if (!signal) return reader.read();
    let relayAbort;
    const abortPromise = new Promise((_, reject) => {
        relayAbort = () => reject(abortReason(signal));
        signal.addEventListener('abort', relayAbort, { once: true });
    });
    try {
        return await Promise.race([reader.read(), abortPromise]);
    }
    finally {
        signal.removeEventListener('abort', relayAbort);
    }
}

function cancelReader(reader) {
    try {
        Promise.resolve(reader?.cancel?.()).catch(() => {});
    }
    catch {
        // The request AbortController remains the authoritative cancellation.
    }
}

function httpError(response, now) {
    const status = Number(response?.status) || 0;
    const error = new Error(`Semantic Scholar returned HTTP ${status}`);
    error.code = 'S2_HTTP_ERROR';
    error.status = status;
    error.retryAfterMs = parseRetryAfter(
        response?.headers?.get?.('Retry-After'),
        now
    );
    return error;
}

function parseRetryAfter(value, now) {
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
    }
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return undefined;
    return Math.min(Math.max(0, timestamp - now), MAX_RETRY_AFTER_MS);
}

function invalidResponseError() {
    const error = new Error('Semantic Scholar returned an invalid response');
    error.code = 'S2_INVALID_RESPONSE';
    return error;
}

function negativeResult(fetchedAt) {
    return {
        status: 'unindexed',
        references: [],
        truncated: false,
        fetchedAt,
    };
}

function isRetryable(error) {
    return error?.code === 'S2_NETWORK_ERROR'
        || error?.code === 'S2_REQUEST_TIMEOUT'
        || (error?.code === 'S2_HTTP_ERROR'
            && (error.status === 429 || error.status >= 500));
}

function notifyRetry(callback, retry) {
    try {
        callback?.(retry);
    }
    catch {
        // Progress callbacks cannot alter request retry behavior.
    }
}

function isKnownError(error) {
    return typeof error?.code === 'string' && error.code.startsWith('S2_');
}

function isAbortError(error) {
    return error?.name === 'AbortError';
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal) {
    if (signal?.reason instanceof Error) return signal.reason;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}

async function waitFor(sleep, milliseconds, signal) {
    throwIfAborted(signal);
    if (!signal) {
        await sleep(milliseconds);
        return;
    }
    let relayAbort;
    const abortPromise = new Promise((_, reject) => {
        relayAbort = () => reject(abortReason(signal));
        signal.addEventListener('abort', relayAbort, { once: true });
    });
    try {
        await Promise.race([sleep(milliseconds), abortPromise]);
    }
    finally {
        signal.removeEventListener('abort', relayAbort);
    }
}

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function normalizedLocalID(paper) {
    return String(paper?.id || '').trim();
}

function boundedInteger(value, minimum, maximum, fallback) {
    return Number.isSafeInteger(value)
        ? Math.max(minimum, Math.min(value, maximum))
        : fallback;
}

function normalizePublicURL(value) {
    if (typeof value !== 'string' || value.length > 2_048) return '';
    try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
        if (url.username || url.password) return '';
        url.hash = '';
        return url.toString();
    }
    catch {
        return '';
    }
}
