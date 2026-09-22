import { concatenateUint8Arrays, toUint8Array } from './binary.js';
import { sha256Hex } from '../core/sha256.js';
import { CONVERSION_PROGRESS } from '../core/conversion-progress.js';
import { createRuntimeAbortController } from '../platform/abort-controller.js';
import {
    isSameMinerUOrigin,
    MINERU_LOCAL_OCR_MODE,
    MINERU_LOCAL_TIER,
    normalizeMinerULocalApiBase,
    resolveMinerUURL,
} from './local-endpoint.js';
import { extractMinerULocalResultFromZip } from './local-result.js';
import { DEFAULT_MAX_ARCHIVE_BYTES } from './mineru-client.js';

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_MAX_POLL_ATTEMPTS = 600;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 2 * 60_000;
const MAX_REDIRECTS = 3;
const TERMINAL_JOB_STATUSES = new Set([
    'completed',
    'partial',
    'failed',
    'canceled',
]);

export class MinerULocalClient {
    constructor({
        fetch = globalThis.fetch?.bind(globalThis),
        sleep = delay,
        hash = sha256Hex,
        extractResultFromZip = extractMinerULocalResultFromZip,
        pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
        maxPollAttempts = DEFAULT_MAX_POLL_ATTEMPTS,
        requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
        uploadTimeoutMs = DEFAULT_UPLOAD_TIMEOUT_MS,
        downloadTimeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
        maxArchiveBytes = DEFAULT_MAX_ARCHIVE_BYTES,
        tier = MINERU_LOCAL_TIER,
        ocrMode = MINERU_LOCAL_OCR_MODE,
        createAbortController = createRuntimeAbortController,
    } = {}) {
        if (!fetch) throw new TypeError('A fetch implementation is required');
        if (typeof hash !== 'function') throw new TypeError('A SHA-256 function is required');
        if (typeof extractResultFromZip !== 'function') {
            throw new TypeError('A local MinerU result extractor is required');
        }
        if (typeof createAbortController !== 'function') {
            throw new TypeError('An AbortController factory is required');
        }
        this.fetch = fetch;
        this.sleep = sleep;
        this.hash = hash;
        this.extractResultFromZip = extractResultFromZip;
        this.pollIntervalMs = pollIntervalMs;
        this.maxPollAttempts = maxPollAttempts;
        this.requestTimeoutMs = requestTimeoutMs;
        this.uploadTimeoutMs = uploadTimeoutMs;
        this.downloadTimeoutMs = downloadTimeoutMs;
        this.maxArchiveBytes = maxArchiveBytes;
        this.tier = tier;
        this.ocrMode = ocrMode;
        this.createAbortController = createAbortController;
    }

    async parse({
        apiBase,
        apiKey,
        fileName,
        fileData,
        onProgress = () => {},
        signal,
    }) {
        const base = normalizeMinerULocalApiBase(apiBase);
        const token = String(apiKey || '').trim();
        const pdf = toUint8Array(fileData, 'PDF file data');
        if (!pdf.byteLength) throw new Error('A PDF file is required');
        throwIfAborted(signal);

        onProgress(CONVERSION_PROGRESS.PREPARING);
        await this.#assertTier(base, token, signal);
        const digest = await this.hash(pdf);
        const upload = await this.#requestJSON(base, '/v1/uploads', {
            method: 'POST',
            token,
            body: {
                filename: safeFileName(fileName),
                bytes: pdf.byteLength,
                mime_type: 'application/pdf',
                purpose: 'parse',
                sha256sum: digest,
            },
            signal,
        });
        const fileID = await this.#finishUpload(base, token, upload, pdf, signal);
        onProgress(CONVERSION_PROGRESS.PARSING);
        const created = await this.#requestJSON(base, '/v1/parse/jobs', {
            method: 'POST',
            token,
            body: {
                files: [{ source: { type: 'file_id', file_id: fileID } }],
                tier: this.tier,
                ocr_mode: this.ocrMode,
                output_formats: ['zip'],
            },
            signal,
            acceptStatuses: new Set([200, 202]),
        });
        const jobID = stringField(created.job_id);
        if (!jobID) throw invalidResponse();
        let completed;
        try {
            completed = await this.#pollJob(base, token, jobID, onProgress, signal);
        }
        catch (error) {
            if (signal?.aborted) await this.#cancelJob(base, token, jobID);
            throw error;
        }
        const zipID = stringField(completed.files?.[0]?.output_files?.zip?.file_id);
        if (!zipID) throw codedError(
            'MinerU completed without a result archive',
            'MINERU_LOCAL_RESULT_MISSING'
        );
        onProgress(CONVERSION_PROGRESS.DOWNLOADING);
        const archive = await this.#download(base, token, `/v1/files/${encodeURIComponent(zipID)}/content`, signal);
        let extracted;
        try {
            extracted = this.extractResultFromZip(archive);
        }
        catch (error) {
            if (!error?.code) error.code = 'MINERU_LOCAL_INVALID_RESULT';
            throw error;
        }
        if (!String(extracted?.markdown || '').trim()) {
            throw codedError(
                'MinerU returned an empty Markdown document',
                'MINERU_LOCAL_EMPTY_RESULT'
            );
        }
        throwIfAborted(signal);
        onProgress(CONVERSION_PROGRESS.COMPLETE);
        return extracted;
    }

    async #assertTier(base, token, signal) {
        const payload = await this.#requestJSON(base, '/v1/tiers', { token, signal });
        const tiers = Array.isArray(payload?.data) ? payload.data : null;
        if (!tiers) throw invalidResponse();
        const available = tiers.some(tier => tier?.id === this.tier);
        if (!available) {
            throw codedError(
                'The local MinerU service does not offer the required parsing tier',
                'MINERU_LOCAL_TIER_UNAVAILABLE'
            );
        }
    }

    async #finishUpload(base, token, upload, pdf, signal) {
        const status = stringField(upload?.status);
        if (status === 'completed') return fileIDFrom(upload);
        if (status !== 'pending') throw invalidResponse();
        const uploadID = stringField(upload.id);
        const method = stringField(upload.upload_method) || 'PUT';
        if (!uploadID || method !== 'PUT') throw uploadDestinationError();
        const uploadURL = resolveUploadURL(base, upload.upload_url);
        const headers = uploadHeaders(upload.upload_headers);
        if (token && isSameMinerUOrigin(base, uploadURL)) {
            headers.Authorization = `Bearer ${token}`;
        }
        const response = await this.#runRequest({
            signal,
            timeoutMs: this.uploadTimeoutMs,
            operation: requestSignal => this.#fetchIsolated(uploadURL, {
                method,
                headers,
                body: pdf,
                signal: requestSignal,
            }, base),
        });
        if (!response?.ok) throw httpError(response);
        const completed = await this.#requestJSON(
            base,
            `/v1/uploads/${encodeURIComponent(uploadID)}/complete`,
            { method: 'POST', token, signal }
        );
        if (completed?.status !== 'completed') throw invalidResponse();
        return fileIDFrom(completed);
    }

    async #pollJob(base, token, jobID, onProgress, signal) {
        const path = `/v1/parse/jobs/${encodeURIComponent(jobID)}`;
        for (let attempt = 0; attempt < this.maxPollAttempts; attempt += 1) {
            throwIfAborted(signal);
            const job = await this.#requestJSON(base, path, { token, signal });
            const status = stringField(job?.status);
            onProgress(progressFromJob(job));
            if (TERMINAL_JOB_STATUSES.has(status)) {
                if (status !== 'completed') {
                    throw codedError(
                        'MinerU local parsing failed',
                        'MINERU_LOCAL_PARSE_FAILED'
                    );
                }
                return job;
            }
            if (!status || status !== 'queued' && status !== 'running') {
                throw invalidResponse();
            }
            await waitFor(this.sleep, this.pollIntervalMs, signal);
        }
        throw codedError('MinerU local parsing timed out', 'MINERU_LOCAL_PARSE_TIMEOUT');
    }

    async #cancelJob(base, token, jobID) {
        try {
            await this.#requestJSON(
                base,
                `/v1/parse/jobs/${encodeURIComponent(jobID)}`,
                { method: 'DELETE', token, timeoutMs: this.requestTimeoutMs }
            );
        }
        catch {
            // Cancellation is best-effort. The caller already owns the abort.
        }
    }

    async #download(base, token, path, signal) {
        const response = await this.#runRequest({
            signal,
            timeoutMs: this.downloadTimeoutMs,
            operation: requestSignal => this.#fetchIsolated(resolveAPIURL(base, path), {
                method: 'GET',
                headers: token ? { Authorization: `Bearer ${token}` } : {},
                signal: requestSignal,
            }),
        });
        if (!response?.ok) throw httpError(response);
        return readBoundedResponse(response, this.maxArchiveBytes, signal);
    }

    async #requestJSON(base, path, {
        method = 'GET',
        token,
        body,
        signal,
        timeoutMs = this.requestTimeoutMs,
        acceptStatuses = new Set([200]),
    }) {
        const headers = { Accept: 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const response = await this.#runRequest({
            signal,
            timeoutMs,
            operation: requestSignal => this.#fetchIsolated(resolveAPIURL(base, path), {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: requestSignal,
            }),
        });
        if (response?.status === 401) {
            throw codedError(
                'The local MinerU API key is invalid',
                'MINERU_LOCAL_API_KEY_INVALID'
            );
        }
        if (response?.status === 413) {
            throw codedError(
                'The PDF exceeds the local MinerU size limit',
                'MINERU_LOCAL_FILE_TOO_LARGE'
            );
        }
        if (!acceptStatuses.has(response?.status)) throw httpError(response);
        try {
            return await response.json();
        }
        catch {
            throw invalidResponse();
        }
    }

    async #fetchIsolated(url, options) {
        let current = url;
        let headers = { ...(options.headers || {}) };
        let method = options.method || 'GET';
        let body = options.body;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
            const response = await this.fetch(current, {
                method,
                headers,
                body,
                signal: options.signal,
                redirect: 'manual',
            });
            if (!isRedirect(response)) return response;
            if (hop === MAX_REDIRECTS) throw invalidResponse();
            const next = resolveRedirect(current, response.headers?.get?.('location'));
            if (!isSameMinerUOrigin(current, next)) delete headers.Authorization;
            if (method !== 'GET' && method !== 'HEAD'
                && (response.status === 301 || response.status === 302 || response.status === 303)) {
                method = 'GET';
                body = undefined;
            }
            current = next;
        }
        throw invalidResponse();
    }

    async #runRequest({ signal, timeoutMs, operation }) {
        throwIfAborted(signal);
        const controller = this.createAbortController();
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
                throw codedError(
                    'The local MinerU request timed out',
                    'MINERU_LOCAL_REQUEST_TIMEOUT'
                );
            }
            if (signal?.aborted) throw abortReason(signal);
            if (isKnownLocalError(error) || isAbortError(error)) throw error;
            throw codedError(
                'The local MinerU service could not be reached',
                'MINERU_LOCAL_NETWORK_ERROR'
            );
        }
        finally {
            if (timeoutID !== null) clearTimeout(timeoutID);
            signal?.removeEventListener('abort', relayAbort);
        }
    }
}

function fileIDFrom(payload) {
    const fileID = stringField(payload?.file?.id);
    if (!fileID) throw invalidResponse();
    return fileID;
}

function uploadHeaders(value) {
    if (value == null) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw invalidResponse();
    }
    const headers = {};
    for (const [key, headerValue] of Object.entries(value)) {
        if (typeof headerValue !== 'string' || /[\r\n]/.test(key) || /[\r\n]/.test(headerValue)) {
            throw invalidResponse();
        }
        if (key.toLowerCase() === 'authorization') continue;
        headers[key] = headerValue;
    }
    return headers;
}

function progressFromJob(job) {
    const completed = Number(job?.progress?.completed);
    const total = Number(job?.progress?.total);
    if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) {
        return job?.status === 'queued'
            ? CONVERSION_PROGRESS.QUEUED
            : CONVERSION_PROGRESS.PARSING_FALLBACK;
    }
    const range = CONVERSION_PROGRESS.PARSING_MAX - CONVERSION_PROGRESS.PARSING_MIN;
    return Math.min(
        CONVERSION_PROGRESS.PARSING_MAX,
        Math.max(
            CONVERSION_PROGRESS.PARSING_MIN,
            Math.round(CONVERSION_PROGRESS.PARSING_MIN + (range * completed / total))
        )
    );
}

function safeFileName(value) {
    const base = String(value || '').split(/[/\\]/).pop() || '';
    const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180);
    return cleaned || 'document.pdf';
}

function stringField(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    return text || '';
}

function isRedirect(response) {
    return response?.status >= 300 && response?.status < 400;
}

function codedError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function invalidResponse() {
    return codedError(
        'The local MinerU service returned an invalid response',
        'MINERU_LOCAL_INVALID_RESPONSE'
    );
}

function uploadDestinationError() {
    return codedError(
        'MinerU did not return a file upload URL',
        'MINERU_LOCAL_UPLOAD_UNAVAILABLE'
    );
}

function httpError(response) {
    const error = codedError(
        'The local MinerU request failed',
        'MINERU_LOCAL_HTTP_ERROR'
    );
    error.status = response?.status || 0;
    return error;
}

function isKnownLocalError(error) {
    return typeof error?.code === 'string' && error.code.startsWith('MINERU_LOCAL_')
        || error?.code === 'MINERU_ARCHIVE_TOO_LARGE';
}

async function readBoundedResponse(response, maxBytes, signal) {
    const declaredLength = Number(response.headers?.get?.('Content-Length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw archiveSizeError();
    }
    const reader = response.body?.getReader?.();
    if (!reader) {
        const bytes = toUint8Array(await response.arrayBuffer(), 'MinerU result archive');
        if (bytes.length > maxBytes) throw archiveSizeError();
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
                throw archiveSizeError();
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

function archiveSizeError() {
    return codedError(
        'MinerU result archive exceeds the size limit',
        'MINERU_LOCAL_ARCHIVE_TOO_LARGE'
    );
}

function resolveAPIURL(base, path) {
    try {
        return resolveMinerUURL(base, path);
    }
    catch (error) {
        if (error?.code === 'MINERU_LOCAL_ENDPOINT_INVALID') throw error;
        throw invalidResponse();
    }
}

function resolveUploadURL(base, target) {
    try {
        return resolveMinerUURL(base, target);
    }
    catch {
        throw uploadDestinationError();
    }
}

function resolveRedirect(current, location) {
    try {
        return resolveMinerUURL(current, location || '');
    }
    catch {
        throw invalidResponse();
    }
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
