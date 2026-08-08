import { createRuntimeAbortController } from '../platform/abort-controller.js';
import {
    createTranslationRequest,
    MAX_TRANSLATION_RESPONSE_CHARACTERS,
    parseChatCompletionResponse,
} from './translation-protocol.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_CONCURRENCY = 4;

export class OpenAITranslationClient {
    constructor({
        fetch = globalThis.fetch?.bind(globalThis),
        createAbortController = createRuntimeAbortController,
        sleep = abortableDelay,
        now = Date.now,
        setTimeout = globalThis.setTimeout?.bind(globalThis),
        clearTimeout = globalThis.clearTimeout?.bind(globalThis),
        timeoutMs = DEFAULT_TIMEOUT_MS,
        maxAttempts = DEFAULT_MAX_ATTEMPTS,
        retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
        maxConcurrency = DEFAULT_MAX_CONCURRENCY,
    } = {}) {
        if (typeof fetch !== 'function') {
            throw new TypeError('A fetch implementation is required');
        }
        if (typeof createAbortController !== 'function') {
            throw new TypeError('An AbortController factory is required');
        }
        this.fetch = fetch;
        this.createAbortController = createAbortController;
        this.sleep = sleep;
        this.now = now;
        this.setTimeout = setTimeout;
        this.clearTimeout = clearTimeout;
        this.timeoutMs = timeoutMs;
        this.maxAttempts = maxAttempts;
        this.retryBaseDelayMs = retryBaseDelayMs;
        this.rateGate = new RequestRateGate({ now, sleep });
        this.semaphore = new AsyncSemaphore(maxConcurrency);
    }

    async translateBatch({
        service,
        targetLanguage,
        systemPrompt,
        documentTitle,
        segments,
        signal,
    }) {
        if (!Array.isArray(segments) || !segments.length) {
            throw new TypeError('Translation segments are required');
        }
        const body = createTranslationRequest({
            service,
            targetLanguage,
            systemPrompt,
            documentTitle,
            segments,
        });
        const value = await this.#withRetry(
            () => this.#requestJSON(service, body, signal),
            signal
        );
        return parseChatCompletionResponse(value, segments);
    }

    async #requestJSON(service, body, signal) {
        throwIfAborted(signal);
        const release = await this.semaphore.acquire(signal);
        let controller = null;
        let abortFromParent = null;
        let timer;
        let timedOut = false;
        try {
            await this.rateGate.wait(service.maxRequestsPerSecond, signal);
            controller = this.createAbortController();
            abortFromParent = () => controller.abort(signal?.reason);
            signal?.addEventListener?.('abort', abortFromParent, { once: true });
            if (signal?.aborted) abortFromParent();
            timer = this.setTimeout?.(() => {
                timedOut = true;
                controller.abort();
            }, this.timeoutMs);

            const headers = { 'Content-Type': 'application/json' };
            if (service.apiKey) {
                headers.Authorization = 'Bearer ' + service.apiKey;
            }
            let response;
            try {
                response = await this.fetch(service.apiURL, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body),
                    signal: controller.signal,
                });
            }
            catch (error) {
                if (signal?.aborted) throw abortError(signal.reason);
                if (timedOut) {
                    throw translationError(
                        'The translation request timed out',
                        'TRANSLATION_TIMEOUT',
                        { retryable: true }
                    );
                }
                if (!error?.code) error.code = 'TRANSLATION_NETWORK_ERROR';
                error.retryable = true;
                throw error;
            }
            const contentLength = Number(response.headers?.get?.('content-length'));
            if (Number.isFinite(contentLength)
                && contentLength > MAX_TRANSLATION_RESPONSE_CHARACTERS) {
                throw translationError(
                    'The translation response is too large',
                    'TRANSLATION_RESPONSE_TOO_LARGE'
                );
            }
            if (!response.ok) {
                throw httpTranslationError(response);
            }
            const text = await response.text();
            if (new TextEncoder().encode(text).length
                > MAX_TRANSLATION_RESPONSE_CHARACTERS) {
                throw translationError(
                    'The translation response is too large',
                    'TRANSLATION_RESPONSE_TOO_LARGE'
                );
            }
            try {
                return JSON.parse(text);
            }
            catch {
                throw translationError(
                    'The translation service returned invalid JSON',
                    'TRANSLATION_HTTP_RESPONSE_INVALID'
                );
            }
        }
        finally {
            if (timer !== undefined) this.clearTimeout?.(timer);
            if (abortFromParent) {
                signal?.removeEventListener?.('abort', abortFromParent);
            }
            release();
        }
    }

    async #withRetry(operation, signal) {
        let lastError;
        for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
            throwIfAborted(signal);
            try {
                return await operation();
            }
            catch (error) {
                if (signal?.aborted) throw abortError(signal.reason);
                lastError = error;
                if (!isRetryable(error) || attempt + 1 >= this.maxAttempts) {
                    throw error;
                }
                const retryAfterMs = Number(error.retryAfterMs);
                const delayMs = Number.isFinite(retryAfterMs)
                    ? Math.min(60_000, Math.max(0, retryAfterMs))
                    : this.retryBaseDelayMs * (2 ** attempt);
                await this.sleep(delayMs, signal);
            }
        }
        throw lastError;
    }
}

class RequestRateGate {
    constructor({ now, sleep }) {
        this.now = now;
        this.sleep = sleep;
        this.nextStartAt = 0;
        this.tail = Promise.resolve();
    }

    wait(requestsPerSecond, signal) {
        const interval = 1000 / Math.max(0.1, Number(requestsPerSecond) || 1);
        const operation = this.tail.catch(() => {}).then(async () => {
            throwIfAborted(signal);
            const waitMs = Math.max(0, this.nextStartAt - this.now());
            if (waitMs) await this.sleep(waitMs, signal);
            throwIfAborted(signal);
            this.nextStartAt = Math.max(this.nextStartAt, this.now()) + interval;
        });
        this.tail = operation;
        return operation;
    }
}

class AsyncSemaphore {
    constructor(limit) {
        this.limit = Math.max(1, Math.trunc(Number(limit) || 1));
        this.active = 0;
        this.waiters = [];
    }

    acquire(signal) {
        throwIfAborted(signal);
        if (this.active < this.limit) {
            this.active++;
            return Promise.resolve(this.#releaseFunction());
        }
        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject, signal, abort: null };
            waiter.abort = () => {
                const index = this.waiters.indexOf(waiter);
                if (index >= 0) this.waiters.splice(index, 1);
                reject(abortError(signal?.reason));
            };
            signal?.addEventListener?.('abort', waiter.abort, { once: true });
            this.waiters.push(waiter);
            if (signal?.aborted) waiter.abort();
        });
    }

    #releaseFunction() {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const waiter = this.waiters.shift();
            if (waiter) {
                waiter.signal?.removeEventListener?.('abort', waiter.abort);
                waiter.resolve(this.#releaseFunction());
                return;
            }
            this.active--;
        };
    }
}

function httpTranslationError(response) {
    const status = Number(response?.status) || 0;
    const authentication = status === 401 || status === 403;
    const configuration = [400, 404, 405, 422].includes(status);
    const retryable = status === 408 || status === 429 || status >= 500;
    const error = translationError(
        authentication
            ? 'The translation service rejected the API credentials'
            : configuration
                ? 'The translation service configuration was rejected'
                : 'The translation service request failed ('
                    + (status || 'unknown status') + ')',
        authentication
            ? 'TRANSLATION_AUTHENTICATION_FAILED'
            : configuration
                ? 'TRANSLATION_CONFIGURATION_INVALID'
                : 'TRANSLATION_HTTP_ERROR',
        { status, retryable }
    );
    const retryAfter = response?.headers?.get?.('retry-after');
    const retryAfterMs = parseRetryAfter(retryAfter);
    if (retryAfterMs !== null) error.retryAfterMs = retryAfterMs;
    return error;
}
function parseRetryAfter(value, now = Date.now()) {
    const source = String(value || '').trim();
    if (!source) return null;
    const seconds = Number(source);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const timestamp = Date.parse(source);
    return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}

function isRetryable(error) {
    return error?.retryable === true
        || error?.code === 'TRANSLATION_NETWORK_ERROR'
        || error?.code === 'TRANSLATION_TIMEOUT';
}

function translationError(message, code, properties = {}) {
    const error = new Error(message);
    error.name = 'TranslationServiceError';
    error.code = code;
    Object.assign(error, properties);
    return error;
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError(signal.reason);
}

function abortError(reason) {
    if (reason instanceof Error) return reason;
    const error = new Error('The translation was cancelled');
    error.name = 'AbortError';
    error.code = 'TRANSLATION_ABORTED';
    return error;
}

function abortableDelay(milliseconds, signal) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = callback => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener?.('abort', abort);
            callback();
        };
        const timer = globalThis.setTimeout(
            () => finish(resolve),
            Math.max(0, milliseconds)
        );
        const abort = () => {
            globalThis.clearTimeout(timer);
            finish(() => reject(abortError(signal?.reason)));
        };
        signal?.addEventListener?.('abort', abort, { once: true });
        if (signal?.aborted) abort();
    });
}
