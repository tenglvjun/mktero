import { toUint8Array } from '../mineru/binary.js';
import { extractMinerUResultFromZip } from '../mineru/zip-markdown.js';
import { createRuntimeAbortController } from '../platform/abort-controller.js';
import { CONVERSION_PROGRESS } from '../core/conversion-progress.js';

const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_MAX_POLL_ATTEMPTS = 600;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const JSON_HEADERS = Object.freeze({
    Accept: 'application/json',
    'Content-Type': 'application/json',
});

// Job states reported by the hosted service.
const STATUS_AWAITING_UPLOAD = 'awaiting_upload';
const STATUS_QUEUED = 'queued';
const STATUS_WAITING_FOR_SHARED_PARSE = 'waiting_for_shared_parse';
const STATUS_SUBMITTING = 'submitting';
const STATUS_PROCESSING = 'processing';
const STATUS_DOWNLOADING = 'downloading';
const STATUS_SUCCEEDED = 'succeeded';
const STATUS_FAILED = 'failed';

const TERMINAL_STATUSES = new Set([STATUS_SUCCEEDED, STATUS_FAILED]);

// Which leg of a conversion a failed request belongs to. The upload and
// download legs talk to the object store through a presigned URL rather than to
// the API, so they fail for reasons the generic messages never describe.
export const MKTERO_REQUEST_STAGES = Object.freeze({
    API: 'api',
    UPLOAD: 'upload',
    DOWNLOAD: 'download',
});

const STAGE_API = MKTERO_REQUEST_STAGES.API;
const STAGE_UPLOAD = MKTERO_REQUEST_STAGES.UPLOAD;
const STAGE_DOWNLOAD = MKTERO_REQUEST_STAGES.DOWNLOAD;

/**
 * Talks to the hosted Mktero conversion service.
 *
 * The service keeps the PDF and the MinerU credentials on its side: this client
 * only creates a job, PUTs the PDF to a presigned URL, waits for the job to
 * finish, and downloads the unchanged MinerU ZIP result.
 */
export class MkteroConversionClient {
    constructor({
        fetch = globalThis.fetch?.bind(globalThis),
        sleep = delay,
        extractMarkdownFromZip: extractResult = extractMinerUResultFromZip,
        pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
        maxPollAttempts = DEFAULT_MAX_POLL_ATTEMPTS,
        requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
        uploadTimeoutMs = DEFAULT_UPLOAD_TIMEOUT_MS,
        downloadTimeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
        maxArchiveBytes = DEFAULT_MAX_ARCHIVE_BYTES,
        createAbortController = createRuntimeAbortController,
    } = {}) {
        if (!fetch) throw new TypeError('A fetch implementation is required');
        if (typeof createAbortController !== 'function') {
            throw new TypeError('An AbortController factory is required');
        }
        this.fetch = fetch;
        this.sleep = sleep;
        this.extractResultFromZip = extractResult;
        this.pollIntervalMs = pollIntervalMs;
        this.maxPollAttempts = maxPollAttempts;
        this.requestTimeoutMs = requestTimeoutMs;
        this.uploadTimeoutMs = uploadTimeoutMs;
        this.downloadTimeoutMs = downloadTimeoutMs;
        this.maxArchiveBytes = maxArchiveBytes;
        this.createAbortController = createAbortController;
    }

    /**
     * Converts one PDF and returns the decoded MinerU result.
     *
     * `getAccessToken` is awaited for every request so a caller can refresh an
     * expired token without rebuilding the client.
     */
    async convert({
        apiBase,
        getAccessToken,
        fileName,
        fileData,
        metadata = null,
        onProgress = () => {},
        signal,
    }) {
        if (typeof getAccessToken !== 'function') {
            throw new TypeError('An access token provider is required');
        }
        const bytes = toUint8Array(fileData, 'PDF file data');
        throwIfAborted(signal);

        notifyProgress(onProgress, CONVERSION_PROGRESS.PREPARING);
        const job = await this.#createJob({
            apiBase,
            getAccessToken,
            fileName,
            bytes,
            metadata,
            signal,
        });
        throwIfAborted(signal);

        await this.#upload({
            job,
            bytes,
            onProgress,
            signal,
        });
        throwIfAborted(signal);

        await this.#complete({ apiBase, getAccessToken, job, signal });
        notifyProgress(onProgress, CONVERSION_PROGRESS.QUEUED);

        const finished = await this.#waitForResult({
            apiBase,
            getAccessToken,
            job,
            onProgress,
            signal,
        });

        const archive = await this.#downloadResult({
            apiBase,
            getAccessToken,
            job: finished,
            onProgress,
            signal,
        });
        throwIfAborted(signal);

        const result = this.extractResultFromZip(archive);
        return {
            result,
            origin: 'network',
            warnings: [],
        };
    }

    async #createJob({
        apiBase,
        getAccessToken,
        fileName,
        bytes,
        metadata,
        signal,
    }) {
        const body = {
            filename: fileName,
            size: bytes.length,
            content_type: 'application/pdf',
        };
        if (metadata && typeof metadata === 'object') body.metadata = metadata;
        const job = await this.#requestJSON({
            apiBase,
            getAccessToken,
            path: '/api/v1/conversions',
            method: 'POST',
            body,
            signal,
            timeoutMs: this.requestTimeoutMs,
            label: 'conversion job',
        });
        if (!job?.job_id || !job?.upload_url) {
            throw codedError(
                'The Mktero service did not return an upload URL',
                'MKTERO_INVALID_RESPONSE'
            );
        }
        return job;
    }

    async #upload({ job, bytes, onProgress, signal }) {
        const method = String(job.upload_method || 'PUT').toUpperCase();
        const headers = { ...(job.upload_headers || {}) };
        if (!hasHeader(headers, 'content-type')) {
            headers['Content-Type'] = 'application/pdf';
        }
        notifyProgress(onProgress, CONVERSION_PROGRESS.UPLOADING);
        const response = await this.#send({
            url: job.upload_url,
            method,
            headers,
            body: bytes,
            signal,
            timeoutMs: this.uploadTimeoutMs,
            label: 'PDF upload',
            stage: STAGE_UPLOAD,
            authorize: false,
        });
        if (!response.ok) {
            throw codedError(
                'The PDF upload to Mktero failed',
                'MKTERO_UPLOAD_FAILED',
                { status: response.status, stage: STAGE_UPLOAD }
            );
        }
    }

    async #complete({ apiBase, getAccessToken, job, signal }) {
        await this.#requestJSON({
            apiBase,
            getAccessToken,
            path: `/api/v1/conversions/${encodeURIComponent(job.job_id)}/complete`,
            method: 'POST',
            signal,
            timeoutMs: this.requestTimeoutMs,
            label: 'conversion completion',
        });
    }

    async #waitForResult({ apiBase, getAccessToken, job, onProgress, signal }) {
        let current = job;
        for (let attempt = 0; attempt < this.maxPollAttempts; attempt++) {
            throwIfAborted(signal);
            if (current.status === STATUS_SUCCEEDED) return current;
            if (current.status === STATUS_FAILED) {
                throw codedError(
                    'The Mktero conversion failed',
                    'MKTERO_CONVERSION_FAILED',
                    { errorCode: current.error_code || '' }
                );
            }
            reportJobProgress(onProgress, current.status, current.progress);
            await waitFor(this.sleep, this.pollIntervalMs, signal);
            current = await this.#requestJSON({
                apiBase,
                getAccessToken,
                path: `/api/v1/conversions/${encodeURIComponent(job.job_id)}`,
                method: 'GET',
                signal,
                timeoutMs: this.requestTimeoutMs,
                label: 'conversion status',
            });
        }
        throw codedError(
            'The Mktero conversion timed out',
            'MKTERO_PARSE_TIMEOUT'
        );
    }

    async #downloadResult({ apiBase, getAccessToken, job, onProgress, signal }) {
        const result = await this.#requestJSON({
            apiBase,
            getAccessToken,
            path: `/api/v1/conversions/${encodeURIComponent(job.job_id)}/result-url`,
            method: 'GET',
            signal,
            timeoutMs: this.requestTimeoutMs,
            label: 'conversion result URL',
        });
        if (!result?.result_url) {
            throw codedError(
                'The Mktero service did not return a result URL',
                'MKTERO_INVALID_RESPONSE'
            );
        }
        notifyProgress(onProgress, CONVERSION_PROGRESS.DOWNLOADING);
        const response = await this.#send({
            url: result.result_url,
            method: String(result.method || 'GET').toUpperCase(),
            headers: { ...(result.headers || {}) },
            signal,
            timeoutMs: this.downloadTimeoutMs,
            label: 'result download',
            stage: STAGE_DOWNLOAD,
            authorize: false,
        });
        if (!response.ok) {
            throw codedError(
                'The Mktero result download failed',
                'MKTERO_DOWNLOAD_FAILED',
                { status: response.status, stage: STAGE_DOWNLOAD }
            );
        }
        return readBoundedBytes(
            response,
            this.maxArchiveBytes,
            signal,
            'MKTERO_ARCHIVE_TOO_LARGE'
        );
    }

    async #requestJSON({
        apiBase,
        getAccessToken,
        path,
        method,
        body = null,
        signal,
        timeoutMs,
        label,
    }) {
        const response = await this.#send({
            url: joinURL(apiBase, path),
            method,
            headers: JSON_HEADERS,
            body: body == null ? null : JSON.stringify(body),
            signal,
            timeoutMs,
            label,
            stage: STAGE_API,
            authorize: true,
            getAccessToken,
        });
        const payload = await readBoundedJSON(response, signal);
        if (!response.ok) {
            throw codedError(
                'The Mktero conversion request failed',
                errorCodeForStatus(response.status, payload),
                {
                    status: response.status,
                    stage: STAGE_API,
                    errorCode: payload?.error?.code || '',
                }
            );
        }
        return payload;
    }

    async #send({
        url,
        method,
        headers,
        body = null,
        signal,
        timeoutMs,
        label,
        stage = STAGE_API,
        authorize,
        getAccessToken = null,
    }) {
        throwIfAborted(signal);
        const controller = this.createAbortController();
        if (!controller?.signal) {
            throw new TypeError('AbortController factory returned an invalid controller');
        }
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
            const requestHeaders = { ...headers };
            if (authorize) {
                const token = String(await getAccessToken() || '').trim();
                if (!token) {
                    throw codedError(
                        'Sign in to Mktero before converting',
                        'MKTERO_SIGN_IN_REQUIRED'
                    );
                }
                requestHeaders.Authorization = `Bearer ${token}`;
            }
            return await this.fetch(url, {
                method,
                headers: requestHeaders,
                body,
                signal: controller.signal,
            });
        }
        catch (error) {
            if (signal?.aborted) throw abortReason(signal);
            if (timedOut) {
                throw codedError(
                    'The Mktero conversion request timed out',
                    'MKTERO_REQUEST_TIMEOUT'
                );
            }
            if (isKnownError(error)) throw error;
            // The original exception is kept as `cause` so the presenter can
            // report whether this was a transport failure or a rejected
            // request. Its message may embed the request URL, which is a
            // presigned URL for transfers, so it is never surfaced directly.
            throw codedError(
                'The Mktero conversion request failed',
                'MKTERO_NETWORK_ERROR',
                { cause: error, stage, requestLabel: label }
            );
        }
        finally {
            if (timeoutID !== null) clearTimeout(timeoutID);
            signal?.removeEventListener('abort', relayAbort);
        }
    }
}

function reportJobProgress(onProgress, status, progress) {
    const reported = Number(progress);
    if (Number.isFinite(reported) && reported > 0) {
        // The service reports 0-100. Keep the client progress inside the
        // parsing band so it never looks finished before the ZIP is decoded.
        const bounded = Math.max(
            CONVERSION_PROGRESS.PARSING_MIN,
            Math.min(CONVERSION_PROGRESS.PARSING_MAX, reported)
        );
        notifyProgress(onProgress, bounded);
        return;
    }
    if (status === STATUS_QUEUED || status === STATUS_WAITING_FOR_SHARED_PARSE) {
        notifyProgress(onProgress, CONVERSION_PROGRESS.QUEUED);
        return;
    }
    if (status === STATUS_DOWNLOADING) {
        notifyProgress(onProgress, CONVERSION_PROGRESS.DOWNLOADING);
        return;
    }
    notifyProgress(onProgress, CONVERSION_PROGRESS.PARSING);
}

function errorCodeForStatus(status, payload) {
    const code = String(payload?.error?.code || '').trim();
    if (code === 'invalid_token' || code === 'user_not_found') {
        return 'MKTERO_SIGN_IN_REQUIRED';
    }
    if (code === 'storage_unavailable') return 'MKTERO_UNAVAILABLE';
    if (code === 'conversion_not_found') return 'MKTERO_JOB_NOT_FOUND';
    if (code === 'conversion_failed') return 'MKTERO_CONVERSION_FAILED';
    if (status === 401 || status === 403) return 'MKTERO_SIGN_IN_REQUIRED';
    if (status === 404) return 'MKTERO_JOB_NOT_FOUND';
    if (status === 503) return 'MKTERO_UNAVAILABLE';
    return 'MKTERO_HTTP_ERROR';
}

async function readBoundedJSON(response, signal) {
    const bytes = await readBoundedBytes(
        response,
        1024 * 1024,
        signal,
        'MKTERO_INVALID_RESPONSE'
    );
    try {
        return JSON.parse(new TextDecoder().decode(bytes));
    }
    catch {
        return null;
    }
}

async function readBoundedBytes(response, maxBytes, signal, code) {
    if (typeof response.arrayBuffer !== 'function') {
        throw codedError('The Mktero response body is missing', code);
    }
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
        throw codedError('The Mktero response is too large', code);
    }
    const buffer = await response.arrayBuffer();
    throwIfAborted(signal);
    const bytes = new Uint8Array(buffer);
    if (bytes.length > maxBytes) {
        throw codedError('The Mktero response is too large', code);
    }
    return bytes;
}

function hasHeader(headers, name) {
    const wanted = name.toLowerCase();
    return Object.keys(headers).some(key => key.toLowerCase() === wanted);
}

function joinURL(apiBase, path) {
    return `${String(apiBase || '').replace(/\/+$/, '')}${path}`;
}

function notifyProgress(onProgress, value) {
    try {
        onProgress?.(value);
    }
    catch {
        // Progress reporting must not break a conversion.
    }
}

function codedError(message, code, extra = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, extra);
    return error;
}

function isKnownError(error) {
    return typeof error?.code === 'string' && error.code.startsWith('MKTERO_');
}

function isAbortError(error) {
    return error?.name === 'AbortError';
}

function abortReason(signal) {
    if (signal?.reason) return signal.reason;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    throw abortReason(signal);
}

async function waitFor(sleep, delayMs, signal) {
    if (!(delayMs > 0)) {
        throwIfAborted(signal);
        return;
    }
    await sleep(delayMs);
    throwIfAborted(signal);
}

function delay(delayMs) {
    return new Promise(resolve => setTimeout(resolve, delayMs));
}

export const MKTERO_CONVERSION_STATUSES = Object.freeze({
    AWAITING_UPLOAD: STATUS_AWAITING_UPLOAD,
    QUEUED: STATUS_QUEUED,
    WAITING_FOR_SHARED_PARSE: STATUS_WAITING_FOR_SHARED_PARSE,
    SUBMITTING: STATUS_SUBMITTING,
    PROCESSING: STATUS_PROCESSING,
    DOWNLOADING: STATUS_DOWNLOADING,
    SUCCEEDED: STATUS_SUCCEEDED,
    FAILED: STATUS_FAILED,
    TERMINAL: TERMINAL_STATUSES,
});
