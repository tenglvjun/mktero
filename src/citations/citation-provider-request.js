import { createRuntimeAbortController } from '../platform/abort-controller.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 6_000;
const DEFAULT_MAX_RETRY_ATTEMPTS = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const MAX_RETRY_AFTER_MS = 60_000;

export class CitationProviderRequest {
    constructor({
        providerName,
        errorPrefix,
        fetch = globalThis.fetch?.bind(globalThis),
        sleep = delay,
        now = Date.now,
        createAbortController = createRuntimeAbortController,
        setTimer = globalThis.setTimeout?.bind(globalThis),
        clearTimer = globalThis.clearTimeout?.bind(globalThis),
        requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
        maxRetryAttempts = DEFAULT_MAX_RETRY_ATTEMPTS,
        retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    }) {
        if (!providerName || !/^[A-Za-z ]+$/.test(providerName)) {
            throw new TypeError('A citation provider name is required');
        }
        if (!errorPrefix || !/^[A-Z]+$/.test(errorPrefix)) {
            throw new TypeError('A citation provider error prefix is required');
        }
        if (typeof fetch !== 'function') {
            throw new TypeError('A fetch implementation is required');
        }
        if (typeof createAbortController !== 'function') {
            throw new TypeError('An AbortController factory is required');
        }
        if (typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
            throw new TypeError('Timer adapters are required');
        }
        this.providerName = providerName;
        this.errorPrefix = errorPrefix;
        this.fetch = fetch;
        this.sleep = sleep;
        this.now = now;
        this.createAbortController = createAbortController;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.requestTimeoutMs = boundedInteger(
            requestTimeoutMs,
            1_000,
            60_000,
            DEFAULT_REQUEST_TIMEOUT_MS
        );
        this.maxRetryAttempts = boundedInteger(
            maxRetryAttempts,
            1,
            3,
            DEFAULT_MAX_RETRY_ATTEMPTS
        );
        this.retryBaseDelayMs = boundedInteger(
            retryBaseDelayMs,
            0,
            60_000,
            DEFAULT_RETRY_BASE_DELAY_MS
        );
    }

    async getJSON(url, {
        headers = {},
        signal,
        onRetry = () => {},
    } = {}) {
        return this.#withRetry(() => this.#requestJSON(
            url,
            headers,
            signal
        ), signal, onRetry);
    }

    invalidResponseError() {
        return providerError(
            `${this.providerName} returned an invalid response`,
            `${this.errorPrefix}_INVALID_RESPONSE`
        );
    }

    async #requestJSON(url, headers, signal) {
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
                method: 'GET',
                headers,
                signal: controller.signal,
            });
            if (!response?.ok) throw this.#httpError(response);
            const bytes = await readResponse(response, controller.signal);
            try {
                return JSON.parse(new TextDecoder().decode(bytes));
            }
            catch {
                throw this.invalidResponseError();
            }
        }
        catch (error) {
            if (signal?.aborted) throw abortReason(signal);
            if (timedOut) {
                throw providerError(
                    `${this.providerName} request timed out`,
                    `${this.errorPrefix}_REQUEST_TIMEOUT`
                );
            }
            if (isAbortError(error) || this.#isKnownError(error)) throw error;
            throw providerError(
                `${this.providerName} request failed`,
                `${this.errorPrefix}_NETWORK_ERROR`
            );
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
                if (finalAttempt || signal?.aborted || !this.#isRetryable(error)) {
                    throw error;
                }
                const retryAfterMs = Number.isFinite(error.retryAfterMs)
                    ? Math.min(error.retryAfterMs, MAX_RETRY_AFTER_MS)
                    : this.retryBaseDelayMs * (2 ** attempt);
                notifyRetry(onRetry, {
                    code: error.code === `${this.errorPrefix}_HTTP_ERROR`
                        && error.status === 429
                        ? 'rate-limited'
                        : 'request-retry',
                    attempt: attempt + 1,
                    retryAfterMs,
                });
                await waitFor(this.sleep, retryAfterMs, signal);
            }
        }
        throw providerError(
            `${this.providerName} retries were exhausted`,
            `${this.errorPrefix}_NETWORK_ERROR`
        );
    }

    #httpError(response) {
        const status = Number(response?.status) || 0;
        const error = providerError(
            `${this.providerName} returned HTTP ${status}`,
            `${this.errorPrefix}_HTTP_ERROR`
        );
        error.status = status;
        error.retryAfterMs = parseRetryAfter(
            response?.headers?.get?.('Retry-After'),
            this.now()
        );
        return error;
    }

    #isRetryable(error) {
        return error?.code === `${this.errorPrefix}_NETWORK_ERROR`
            || error?.code === `${this.errorPrefix}_REQUEST_TIMEOUT`
            || (error?.code === `${this.errorPrefix}_HTTP_ERROR`
                && (error.status === 429 || error.status >= 500));
    }

    #isKnownError(error) {
        return typeof error?.code === 'string'
            && error.code.startsWith(`${this.errorPrefix}_`);
    }
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
    const aborted = new Promise((_, reject) => {
        relayAbort = () => reject(abortReason(signal));
        signal.addEventListener('abort', relayAbort, { once: true });
    });
    try {
        return await Promise.race([reader.read(), aborted]);
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
        // The request controller remains the authoritative cancellation path.
    }
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

function providerError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function notifyRetry(callback, retry) {
    try {
        callback?.(retry);
    }
    catch {
        // Progress callbacks cannot alter retry behavior.
    }
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
    const aborted = new Promise((_, reject) => {
        relayAbort = () => reject(abortReason(signal));
        signal.addEventListener('abort', relayAbort, { once: true });
    });
    try {
        await Promise.race([sleep(milliseconds), aborted]);
    }
    finally {
        signal.removeEventListener('abort', relayAbort);
    }
}

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function boundedInteger(value, minimum, maximum, fallback) {
    return Number.isSafeInteger(value)
        ? Math.max(minimum, Math.min(value, maximum))
        : fallback;
}
