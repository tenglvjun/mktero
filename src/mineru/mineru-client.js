import { concatenateUint8Arrays, toUint8Array } from './binary.js';
import { extractMinerUResultFromZip } from './zip-markdown.js';

const DEFAULT_API_BASE = 'https://mineru.net/api/v4';
const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_MAX_POLL_ATTEMPTS = 600;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_MAX_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
export const DEFAULT_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

export class MinerUClient {
    constructor({
        fetch = globalThis.fetch?.bind(globalThis),
        sleep = delay,
        extractMarkdownFromZip: extractResult = extractMinerUResultFromZip,
        apiBase = DEFAULT_API_BASE,
        pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
        maxPollAttempts = DEFAULT_MAX_POLL_ATTEMPTS,
        requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
        uploadTimeoutMs = DEFAULT_UPLOAD_TIMEOUT_MS,
        downloadTimeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
        maxRetryAttempts = DEFAULT_MAX_RETRY_ATTEMPTS,
        retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
        maxArchiveBytes = DEFAULT_MAX_ARCHIVE_BYTES,
    } = {}) {
        if (!fetch) throw new TypeError('A fetch implementation is required');
        this.fetch = fetch;
        this.sleep = sleep;
        this.extractResultFromZip = extractResult;
        this.apiBase = apiBase.replace(/\/$/, '');
        this.pollIntervalMs = pollIntervalMs;
        this.maxPollAttempts = maxPollAttempts;
        this.requestTimeoutMs = requestTimeoutMs;
        this.uploadTimeoutMs = uploadTimeoutMs;
        this.downloadTimeoutMs = downloadTimeoutMs;
        this.maxRetryAttempts = maxRetryAttempts;
        this.retryBaseDelayMs = retryBaseDelayMs;
        this.maxArchiveBytes = maxArchiveBytes;
    }

    async parse({
        apiKey,
        fileName,
        fileData,
        dataID,
        onProgress = () => {},
        signal,
    }) {
        const token = String(apiKey || '').trim();
        if (!token) throw new Error('A MinerU API Token is required');
        if (!fileName) throw new Error('A PDF file name is required');
        throwIfAborted(signal);

        onProgress(2);
        const batch = await this.#requestJSON(`${this.apiBase}/file-urls/batch`, {
            method: 'POST',
            headers: authorizedJSONHeaders(token),
            body: JSON.stringify({
                files: [{
                    name: fileName,
                    data_id: dataID,
                    is_ocr: true,
                }],
                model_version: 'vlm',
                enable_formula: true,
                enable_table: true,
            }),
            signal,
        });
        const batchID = batch.data?.batch_id;
        const uploadURL = batch.data?.file_urls?.[0];
        if (!batchID || !uploadURL) {
            throw new Error('MinerU did not return a file upload URL');
        }

        onProgress(5);
        const uploadResponse = await this.#runRequest({
            signal,
            timeoutMs: this.uploadTimeoutMs,
            label: 'file upload',
            operation: requestSignal => this.fetch(uploadURL, {
                method: 'PUT',
                body: toUint8Array(fileData, 'PDF file data'),
                signal: requestSignal,
            }),
        });
        if (!uploadResponse?.ok) {
            throw httpError('MinerU file upload failed', uploadResponse);
        }
        onProgress(10);

        const completed = await this.#poll({
            token,
            batchID,
            dataID,
            fileName,
            onProgress,
            signal,
        });
        onProgress(95);

        const archive = await this.#withRetry(
            () => this.#downloadArchive(completed.full_zip_url, signal),
            signal
        );
        const extracted = this.extractResultFromZip(archive);
        const markdown = typeof extracted === 'string' ? extracted : extracted.markdown;
        if (!markdown.trim()) {
            throw new Error('MinerU returned an empty Markdown document');
        }

        throwIfAborted(signal);
        onProgress(100);
        const totalPages = completed.extract_progress?.total_pages ?? null;
        return {
            markdown,
            assets: typeof extracted === 'string' ? [] : extracted.assets || [],
            assetBasePath: typeof extracted === 'string' ? '' : extracted.assetBasePath || '',
            extractedPages: totalPages,
            totalPages,
        };
    }

    async #poll({ token, batchID, dataID, fileName, onProgress, signal }) {
        let lastExtractProgress = null;
        for (let attempt = 0; attempt < this.maxPollAttempts; attempt++) {
            const response = await this.#withRetry(
                () => this.#requestJSON(
                    `${this.apiBase}/extract-results/batch/${encodeURIComponent(batchID)}`,
                    { headers: authorizedHeaders(token), signal }
                ),
                signal
            );
            const results = response.data?.extract_result;
            const result = findResult(results, dataID, fileName);

            if (result?.state === 'failed') {
                throw new Error(`MinerU parsing failed: ${result.err_msg || 'unknown error'}`);
            }
            if (result?.state === 'done') {
                if (!result.full_zip_url) {
                    throw new Error('MinerU completed without a result archive');
                }
                return {
                    ...result,
                    extract_progress: result.extract_progress || lastExtractProgress,
                };
            }
            if (result?.state === 'running') {
                lastExtractProgress = result.extract_progress || lastExtractProgress;
                onProgress(progressFromPages(result.extract_progress));
            }
            else {
                onProgress(12);
            }

            if (attempt < this.maxPollAttempts - 1) {
                await waitFor(this.sleep, this.pollIntervalMs, signal);
            }
        }

        throw new Error('MinerU parsing timed out');
    }

    async #downloadArchive(url, signal) {
        return this.#runRequest({
            signal,
            timeoutMs: this.downloadTimeoutMs,
            label: 'result download',
            operation: async requestSignal => {
                const response = await this.fetch(url, { signal: requestSignal });
                if (!response?.ok) {
                    throw httpError('MinerU result download failed', response);
                }
                return readBoundedResponse(response, this.maxArchiveBytes, requestSignal);
            },
        });
    }

    async #requestJSON(url, options) {
        return this.#runRequest({
            signal: options.signal,
            timeoutMs: this.requestTimeoutMs,
            label: 'API request',
            operation: async requestSignal => {
                const response = await this.fetch(url, {
                    ...options,
                    signal: requestSignal,
                });
                let payload;
                try {
                    payload = await response.json();
                }
                catch {
                    const error = new Error(
                        `MinerU returned an invalid response (HTTP ${response?.status || 0})`
                    );
                    error.code = 'MINERU_INVALID_RESPONSE';
                    throw error;
                }
                if (payload.code === 'A0202' || payload.code === 'A0211') {
                    throw apiError(payload.code, payload.msg);
                }
                if (!response?.ok) {
                    throw httpError('MinerU request failed', response, payload.msg);
                }
                if (payload.code !== 0) {
                    throw apiError(payload.code, payload.msg);
                }
                return payload;
            },
        });
    }

    async #runRequest({ signal, timeoutMs, label, operation }) {
        throwIfAborted(signal);
        const controller = new AbortController();
        let timedOut = false;
        const relayAbort = () => controller.abort(signal?.reason);
        signal?.addEventListener('abort', relayAbort, { once: true });
        const timeoutID = timeoutMs > 0
            ? setTimeout(() => {
                timedOut = true;
                controller.abort();
            }, timeoutMs)
            : null;

        try {
            return await operation(controller.signal);
        }
        catch (error) {
            if (timedOut) {
                const timeoutError = new Error(`MinerU ${label} timed out`);
                timeoutError.code = 'MINERU_REQUEST_TIMEOUT';
                throw timeoutError;
            }
            if (signal?.aborted) throw abortReason(signal);
            if (isKnownRequestError(error) || isAbortError(error)) throw error;

            const networkError = new Error(
                `MinerU ${label} failed: ${error?.message || 'network error'}`
            );
            networkError.code = 'MINERU_NETWORK_ERROR';
            throw networkError;
        }
        finally {
            if (timeoutID !== null) clearTimeout(timeoutID);
            signal?.removeEventListener('abort', relayAbort);
        }
    }

    async #withRetry(operation, signal) {
        for (let attempt = 0; attempt < this.maxRetryAttempts; attempt++) {
            try {
                return await operation();
            }
            catch (error) {
                const finalAttempt = attempt === this.maxRetryAttempts - 1;
                if (finalAttempt || !isRetryable(error) || signal?.aborted) throw error;
                const backoff = error.retryAfterMs
                    ?? this.retryBaseDelayMs * (2 ** attempt);
                await waitFor(this.sleep, backoff, signal);
            }
        }
        throw new Error('MinerU retry attempts were exhausted');
    }
}

function authorizedHeaders(token) {
    return { Authorization: `Bearer ${token}` };
}

function authorizedJSONHeaders(token) {
    return {
        ...authorizedHeaders(token),
        'Content-Type': 'application/json',
    };
}

function findResult(results, dataID, fileName) {
    if (!Array.isArray(results)) return null;
    return results.find(result => result.data_id === dataID)
        || results.find(result => result.file_name === fileName)
        || (results.length === 1 ? results[0] : null);
}

function progressFromPages(progress) {
    const extracted = Number(progress?.extracted_pages);
    const total = Number(progress?.total_pages);
    if (!Number.isFinite(extracted) || !Number.isFinite(total) || total <= 0) return 20;
    return Math.min(90, Math.max(15, Math.round(15 + (75 * extracted / total))));
}

function apiError(code, message) {
    if (code === 'A0202' || code === 'A0211') {
        const error = new Error('The MinerU API Token is invalid or expired');
        error.code = 'MINERU_API_KEY_INVALID';
        return error;
    }
    const suffix = message ? `: ${message}` : '';
    const error = new Error(`MinerU API error ${String(code)}${suffix}`);
    error.code = code === -10001 || code === '-10001'
        ? 'MINERU_TRANSIENT_API_ERROR'
        : 'MINERU_API_ERROR';
    return error;
}

function httpError(prefix, response, message = '') {
    const status = response?.status || 0;
    const suffix = message ? `: ${message}` : '';
    const error = new Error(`${prefix} with HTTP ${status}${suffix}`);
    error.code = 'MINERU_HTTP_ERROR';
    error.status = status;
    error.retryAfterMs = parseRetryAfter(response?.headers?.get?.('Retry-After'));
    return error;
}

function parseRetryAfter(value) {
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(value);
    if (!Number.isFinite(date)) return undefined;
    return Math.max(0, date - Date.now());
}

function isKnownRequestError(error) {
    return typeof error?.code === 'string' && error.code.startsWith('MINERU_');
}

function isRetryable(error) {
    if (error?.code === 'MINERU_HTTP_ERROR') {
        return error.status === 429 || error.status >= 500;
    }
    return error?.code === 'MINERU_NETWORK_ERROR'
        || error?.code === 'MINERU_INVALID_RESPONSE'
        || error?.code === 'MINERU_REQUEST_TIMEOUT'
        || error?.code === 'MINERU_TRANSIENT_API_ERROR';
}

async function readBoundedResponse(response, maxBytes, signal) {
    const declaredLength = Number(response.headers?.get?.('Content-Length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw archiveSizeError(maxBytes);
    }

    const reader = response.body?.getReader?.();
    if (!reader) {
        const bytes = toUint8Array(await response.arrayBuffer(), 'MinerU result archive');
        if (bytes.length > maxBytes) throw archiveSizeError(maxBytes);
        return bytes;
    }

    const chunks = [];
    let length = 0;
    try {
        while (true) {
            throwIfAborted(signal);
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = toUint8Array(value, 'MinerU result chunk');
            length += chunk.length;
            if (length > maxBytes) {
                await reader.cancel?.();
                throw archiveSizeError(maxBytes);
            }
            chunks.push(chunk);
        }
    }
    catch (error) {
        await reader.cancel?.().catch?.(() => {});
        throw error;
    }
    return concatenateUint8Arrays(chunks, length);
}

function archiveSizeError(maxBytes) {
    const error = new Error(
        `MinerU result archive exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB size limit`
    );
    error.code = 'MINERU_ARCHIVE_TOO_LARGE';
    return error;
}

async function waitFor(sleep, milliseconds, signal) {
    throwIfAborted(signal);
    if (!signal) {
        await sleep(milliseconds);
        return;
    }

    let onAbort;
    const aborted = new Promise((_, reject) => {
        onAbort = () => reject(abortReason(signal));
        signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        await Promise.race([sleep(milliseconds), aborted]);
    }
    finally {
        signal.removeEventListener('abort', onAbort);
    }
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal) {
    if (signal?.reason) return signal.reason;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}

function isAbortError(error) {
    return error?.name === 'AbortError';
}

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}
