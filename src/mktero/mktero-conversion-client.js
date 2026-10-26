import { toUint8Array } from '../mineru/binary.js';
import { extractMinerUResultFromZip } from '../mineru/zip-markdown.js';
import { tryCreateMinerUResultArchive } from '../mineru/result-archive.js';
import { createRuntimeAbortController } from '../platform/abort-controller.js';
import { CONVERSION_PROGRESS } from '../core/conversion-progress.js';
import { sha256Hex } from '../core/sha256.js';
import { mkteroVersion } from '../config/runtime-config.js';
import { notifyDiagnosticJob } from '../diagnostics/diagnostic-log.js';

const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_MAX_POLL_ATTEMPTS = 600;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
// One original PUT plus two renewed PUTs. A renewal that does not yield a URL
// stops the loop early; it does not reset this budget.
const MAX_UPLOAD_RENEWALS = 2;
const CANCEL_TIMEOUT_MS = 2_000;
const JSON_HEADERS = Object.freeze({
    Accept: 'application/json',
    'Content-Type': 'application/json',
});

// API_HEADERS is JSON_HEADERS plus this extension's self-reported build, for
// requests to the Mktero account API only.
//
// It must never reach the two object-storage calls in this module. The PDF
// upload and the result download go to presigned R2 URLs, where an extra header
// that the signature does not cover invalidates the request and provokes a CORS
// preflight the bucket is not configured to answer. Those calls pass
// job.upload_headers and result.headers straight through #send unchanged.
//
// The header is therefore attached at the API call site rather than inside
// #send, so the storage paths cannot pick it up by accident.
const API_HEADERS = Object.freeze({
    ...JSON_HEADERS,
    'X-Mktero-Version': mkteroVersion(),
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
 * finish, and downloads the unchanged MinerU ZIP result. A failed upload renews
 * the presigned URL and retries. Aborting or giving up after the job exists
 * asks the service to cancel it, without delaying the caller.
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
        cancelTimeoutMs = CANCEL_TIMEOUT_MS,
        createAbortController = createRuntimeAbortController,
        onJob = null,
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
        this.cancelTimeoutMs = cancelTimeoutMs;
        this.createAbortController = createAbortController;
        this.onJob = onJob;
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
        includeArchive = false,
        signal,
    }) {
        if (typeof getAccessToken !== 'function') {
            throw new TypeError('An access token provider is required');
        }
        const bytes = toUint8Array(fileData, 'PDF file data');
        throwIfAborted(signal);

        // Assigned only after the service returns a job id. Batch cancel and
        // shutdown abort this signal; they do not send their own DELETE, and a
        // queued item that never entered convert() has no job to cancel.
        let job = null;
        try {
            notifyProgress(onProgress, CONVERSION_PROGRESS.PREPARING);
            job = await this.#createJob({
                apiBase,
                getAccessToken,
                fileName,
                bytes,
                metadata,
                sha256: await pdfSHA256(bytes),
                signal,
            });
            notifyDiagnosticJob(this.onJob, {
                provider: 'mktero',
                id: job.job_id,
                status: job.status || 'created',
            });
            throwIfAborted(signal);

            let finished = job;
            if (job.status === STATUS_SUCCEEDED && !job.upload_url) {
                notifyProgress(onProgress, CONVERSION_PROGRESS.DOWNLOADING);
            } else if (!job.upload_url && job.status === STATUS_WAITING_FOR_SHARED_PARSE) {
                finished = await this.#waitForResult({
                    apiBase,
                    getAccessToken,
                    job,
                    onProgress,
                    signal,
                });
            } else {
                await this.#upload({
                    apiBase,
                    getAccessToken,
                    job,
                    bytes,
                    onProgress,
                    signal,
                });
                throwIfAborted(signal);

                await this.#complete({ apiBase, getAccessToken, job, signal });
                notifyProgress(onProgress, CONVERSION_PROGRESS.QUEUED);

                finished = await this.#waitForResult({
                    apiBase,
                    getAccessToken,
                    job,
                    onProgress,
                    signal,
                });
            }

            const archive = await this.#downloadResult({
                apiBase,
                getAccessToken,
                job: finished,
                onProgress,
                signal,
            });
            throwIfAborted(signal);

            const result = this.extractResultFromZip(archive);
            const resultArchive = includeArchive ? tryCreateMinerUResultArchive(archive) : null;
            notifyDiagnosticJob(this.onJob, {
                provider: 'mktero',
                id: finished?.job_id || job.job_id,
                status: finished?.status || 'succeeded',
            });
            return {
                result,
                origin: 'network',
                warnings: [],
                ...(resultArchive ? { resultArchive } : {}),
            };
        }
        catch (error) {
            if (job?.job_id) {
                notifyDiagnosticJob(this.onJob, {
                    provider: 'mktero',
                    id: job.job_id,
                    status: error?.name === 'AbortError' ? 'aborted' : 'failed',
                });
            }
            this.#abandonJob({ apiBase, getAccessToken, job });
            throw error;
        }
    }

    async #createJob({
        apiBase,
        getAccessToken,
        fileName,
        bytes,
        metadata,
        sha256,
        signal,
    }) {
        const body = {
            filename: fileName,
            size: bytes.length,
            content_type: 'application/pdf',
        };
        if (metadata && typeof metadata === 'object') body.metadata = metadata;
        if (typeof sha256 === 'string' && sha256) body.sha256 = sha256;
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
        if (!job?.job_id || (!job.upload_url && job.status !== STATUS_SUCCEEDED && job.status !== STATUS_WAITING_FOR_SHARED_PARSE)) {
            throw codedError(
                'The Mktero service did not return an upload URL',
                'MKTERO_INVALID_RESPONSE'
            );
        }
        return job;
    }

    async #upload({ apiBase, getAccessToken, job, bytes, onProgress, signal }) {
        let current = job;
        let lastError = null;
        for (let attempt = 0; attempt <= MAX_UPLOAD_RENEWALS; attempt += 1) {
            throwIfAborted(signal);
            // Retries stay on the same stage. There is no separate retry copy.
            notifyProgress(onProgress, CONVERSION_PROGRESS.UPLOADING);
            try {
                await this.#putPDF({ job: current, bytes, signal });
                return;
            }
            catch (error) {
                if (signal?.aborted || isAbortError(error)) throw error;
                lastError = error;
                if (!isRetryableUploadFailure(error) || attempt === MAX_UPLOAD_RENEWALS) {
                    throw error;
                }
            }

            let renewed;
            try {
                renewed = await this.#renewUploadURL({
                    apiBase,
                    getAccessToken,
                    job: current,
                    signal,
                });
            }
            catch (error) {
                if (signal?.aborted || isAbortError(error)) throw error;
                // A rejected session is actionable on its own. Any other renewal
                // failure leaves the upload error the caller already has.
                if (isTerminalAuthError(error) || isTokenProviderFailure(error)) {
                    throw error;
                }
                throw lastError;
            }
            // The service returns the current job without a URL once the upload
            // is no longer awaiting. Retrying would loop until the budget ends.
            if (!renewed?.upload_url) throw lastError;
            current = {
                ...current,
                ...renewed,
                job_id: renewed.job_id || current.job_id,
            };
        }
        throw lastError;
    }

    async #putPDF({ job, bytes, signal }) {
        const method = String(job.upload_method || 'PUT').toUpperCase();
        const headers = { ...(job.upload_headers || {}) };
        if (!hasHeader(headers, 'content-type')) {
            headers['Content-Type'] = 'application/pdf';
        }
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

    #renewUploadURL({ apiBase, getAccessToken, job, signal }) {
        const path = `/api/v1/conversions/${encodeURIComponent(job.job_id)}/upload-url`;
        return this.#requestRenewal({
            apiBase,
            getAccessToken,
            path,
            signal,
        });
    }

    #requestRenewal({ apiBase, getAccessToken, path, signal }) {
        return this.#requestJSON({
            apiBase,
            getAccessToken,
            path,
            method: 'POST',
            signal,
            timeoutMs: this.requestTimeoutMs,
            label: 'conversion upload URL',
        });
    }

    // Fire-and-forget. convert() must reject without waiting for this DELETE:
    // batch cancel and shutdown abort the caller signal and are already
    // unwinding. Closing a tab does not abort; the run continues in the
    // background. The DELETE has its own short timeout and must not see the
    // caller's signal, or the aborted signal would stop it from leaving.
    #abandonJob({ apiBase, getAccessToken, job }) {
        const jobId = String(job?.job_id || '').trim();
        if (!jobId || typeof getAccessToken !== 'function') return;
        const pending = this.#cancelJob({ apiBase, getAccessToken, jobId });
        void pending.catch(() => {});
    }

    async #cancelJob({ apiBase, getAccessToken, jobId }) {
        try {
            await this.#requestJSON({
                apiBase,
                getAccessToken,
                path: `/api/v1/conversions/${encodeURIComponent(jobId)}`,
                method: 'DELETE',
                timeoutMs: this.cancelTimeoutMs,
                label: 'conversion cancel',
                replayUnauthorized: false,
            });
        }
        catch {
            // Terminal jobs, 409 after queued, and transport failures are ignored.
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
        replayUnauthorized = true,
        forceTokenRefresh = false,
    }) {
        const response = await this.#send({
            url: joinURL(apiBase, path),
            method,
            headers: API_HEADERS,
            body: body == null ? null : JSON.stringify(body),
            signal,
            timeoutMs,
            label,
            stage: STAGE_API,
            authorize: true,
            getAccessToken,
            forceTokenRefresh,
        });
        const payload = await readBoundedJSON(response, signal);
        if (!response.ok) {
            const error = codedError(
                'The Mktero conversion request failed',
                errorCodeForStatus(response.status, payload),
                {
                    status: response.status,
                    stage: STAGE_API,
                    errorCode: payload?.error?.code || '',
                }
            );
            // A 401 is an expired access token, not a dead login. Refresh once
            // and replay. Cancel is not replayed: it is already being abandoned.
            if (replayUnauthorized && isUnauthorizedResponse(error)) {
                return this.#requestJSON({
                    apiBase,
                    getAccessToken,
                    path,
                    method,
                    body,
                    signal,
                    timeoutMs,
                    label,
                    replayUnauthorized: false,
                    forceTokenRefresh: true,
                });
            }
            throw error;
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
        forceTokenRefresh = false,
    }) {
        throwIfAborted(signal);
        const controller = this.createAbortController();
        if (!controller?.signal) {
            throw new TypeError('AbortController factory returned an invalid controller');
        }
        let timedOut = false;
        const relayAbort = () => controller.abort(signal?.reason);
        signal?.addEventListener('abort', relayAbort, { once: true });
        let timeoutID = null;

        try {
            const requestHeaders = { ...headers };
            if (authorize) {
                // Waiting for a token can take up to the account refresh lock
                // TTL when another refresh is in flight or a crashed one left
                // its lock. A cancelled conversion stops waiting at once. The
                // request timeout still covers only the transfer: a refresh
                // that ends within the lock TTL keeps the conversion going.
                const token = String(await settleUnlessAborted(
                    forceTokenRefresh
                        ? getAccessToken({ forceRefresh: true })
                        : getAccessToken(),
                    signal
                ) || '').trim();
                if (!token) {
                    throw codedError(
                        'Sign in to Mktero before converting',
                        'MKTERO_SIGN_IN_REQUIRED'
                    );
                }
                requestHeaders.Authorization = `Bearer ${token}`;
            }
            if (timeoutMs > 0) {
                timeoutID = setTimeout(() => {
                    timedOut = true;
                    controller.abort();
                }, timeoutMs);
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
            if (error?.code === 'account_disabled') {
                throw codedError('Mktero account is disabled', 'MKTERO_ACCOUNT_DISABLED');
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

async function pdfSHA256(bytes) {
    try {
        return await sha256Hex(bytes);
    }
    catch {
        return '';
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
    if (code === 'account_disabled') return 'MKTERO_ACCOUNT_DISABLED';
    if (code === 'invalid_token' || code === 'user_not_found') {
        return 'MKTERO_SIGN_IN_REQUIRED';
    }
    if (code === 'storage_unavailable') return 'MKTERO_UNAVAILABLE';
    if (
        code === 'conversion_not_found'
        || code === 'conversion_result_not_found'
        || code === 'upload_expired'
        || code === 'upload_incomplete'
        || code === 'invalid_state'
        || code === 'result_not_ready'
    ) {
        return 'MKTERO_JOB_NOT_FOUND';
    }
    if (code === 'conversion_failed' || code === 'invalid_upload') {
        return 'MKTERO_CONVERSION_FAILED';
    }
    if (status === 401 || status === 403) return 'MKTERO_SIGN_IN_REQUIRED';
    if (status === 404) return 'MKTERO_JOB_NOT_FOUND';
    if (status === 408 || status === 429 || status >= 500) return 'MKTERO_UNAVAILABLE';
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

function isRetryableUploadFailure(error) {
    if (isAbortError(error) || error?.code === 'ABORT_ERR') return false;
    if (error?.code === 'MKTERO_NETWORK_ERROR' || error?.code === 'MKTERO_REQUEST_TIMEOUT') {
        return true;
    }
    const status = Number(error?.status);
    if (!Number.isInteger(status)) return false;
    // Object storage answers an expired presigned URL with 403. That is not an
    // account denial: the account API is never the upload target. Other 4xx,
    // including 408, are not retried; a client-side timeout is MKTERO_REQUEST_TIMEOUT.
    if (status === 403) return true;
    return status >= 500 && status <= 599;
}

function isUnauthorizedResponse(error) {
    return error?.status === 401;
}

function isTerminalAuthError(error) {
    return error?.code === 'MKTERO_SIGN_IN_REQUIRED'
        || error?.code === 'MKTERO_ACCOUNT_DISABLED';
}

// ensureAccountAccessToken throws these without a request stage. A renewal
// HTTP failure always carries one, so the upload error stays the one to show.
function isTokenProviderFailure(error) {
    return error?.code === 'MKTERO_NETWORK_ERROR' && !error.stage;
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

// settleUnlessAborted rejects when `signal` aborts first. The operation keeps
// running: an account refresh is shared with other callers, and stopping it
// halfway could lose a rotated refresh token.
function settleUnlessAborted(value, signal) {
    const pending = Promise.resolve(value);
    if (!signal) return pending;
    if (signal.aborted) {
        pending.catch(() => {});
        return Promise.reject(abortReason(signal));
    }
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            pending.catch(() => {});
            reject(abortReason(signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        pending.then(result => {
            signal.removeEventListener('abort', onAbort);
            resolve(result);
        }, error => {
            signal.removeEventListener('abort', onAbort);
            reject(error);
        });
    });
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
