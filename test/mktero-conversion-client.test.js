import test from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { sha256Hex } from '../src/core/sha256.js';
import { mkteroVersion } from '../src/config/runtime-config.js';
import { MkteroConversionClient } from '../src/mktero/mktero-conversion-client.js';

const API_BASE = 'http://127.0.0.1:8080';
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

function createTestPNG() {
    return new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
        0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
        0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
        0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
        0x42, 0x60, 0x82,
    ]);
}

function jsonResponse(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        async arrayBuffer() {
            return strToU8(JSON.stringify(body)).buffer;
        },
    };
}

function archiveResponse(bytes) {
    return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        async arrayBuffer() {
            return bytes.slice().buffer;
        },
    };
}

function uploadResponse(status) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
    };
}

function awaitingUpload(jobId, uploadURL, extra = {}) {
    return jsonResponse(201, {
        job_id: jobId,
        status: 'awaiting_upload',
        upload_url: uploadURL,
        upload_method: 'PUT',
        ...extra,
    });
}

function convertOptions(extra = {}) {
    return {
        apiBase: API_BASE,
        getAccessToken: () => 'access-token',
        fileName: 'paper.pdf',
        fileData: PDF_BYTES,
        ...extra,
    };
}

function flushTasks() {
    return new Promise(resolve => setImmediate(resolve));
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function resultArchive() {
    return zipSync({
        'result/full.md': strToU8('# Converted\n\nBody text.'),
        'result/images/figure.png': createTestPNG(),
    });
}

function successfulClient({ archive = resultArchive(), onRequest = () => {} } = {}) {
    const client = new MkteroConversionClient({
        fetch: async (url, options) => {
            onRequest(url, options);
            if (options.method === 'POST' && url.endsWith('/conversions')) {
                return jsonResponse(201, { job_id: 'job-success', status: 'succeeded' });
            }
            if (url.endsWith('/result-url')) {
                return jsonResponse(200, { result_url: 'https://r2.example/result.zip' });
            }
            if (url === 'https://r2.example/result.zip') return archiveResponse(archive);
            throw new Error(`unexpected ${options.method} ${url}`);
        },
        sleep: async () => {},
    });
    return client;
}

test('converts through the hosted service and decodes the MinerU archive', async () => {
    const requests = [];
    const jobs = [];
    const archive = resultArchive();
    const responses = [
        jsonResponse(201, {
            job_id: 'job-1',
            status: 'awaiting_upload',
            upload_url: 'https://r2.example/upload',
            upload_method: 'PUT',
        }),
        { ok: true, status: 200, headers: { get: () => null } },
        jsonResponse(202, { job_id: 'job-1', status: 'queued' }),
        jsonResponse(200, { job_id: 'job-1', status: 'processing', progress: 40 }),
        jsonResponse(200, { job_id: 'job-1', status: 'succeeded', progress: 100 }),
        jsonResponse(200, {
            result_url: 'https://r2.example/result.zip',
            method: 'GET',
        }),
        archiveResponse(archive),
    ];
    const client = new MkteroConversionClient({
        fetch: async (url, options) => {
            requests.push({ url, options });
            return responses.shift();
        },
        sleep: async () => {},
        onJob: job => jobs.push(job),
    });

    const converted = await client.convert({
        apiBase: API_BASE,
        getAccessToken: () => 'access-token',
        fileName: 'paper.pdf',
        fileData: PDF_BYTES,
    });

    assert.equal(converted.origin, 'network');
    assert.match(converted.result.markdown, /Converted/);

    assert.equal(requests[0].url, `${API_BASE}/api/v1/conversions`);
    assert.equal(requests[0].options.method, 'POST');
    assert.equal(requests[0].options.headers.Authorization, 'Bearer access-token');
    const created = JSON.parse(requests[0].options.body);
    assert.equal(created.filename, 'paper.pdf');
    assert.equal(created.size, PDF_BYTES.length);
    assert.equal(created.content_type, 'application/pdf');

    assert.equal(requests[1].url, 'https://r2.example/upload');
    assert.equal(requests[1].options.method, 'PUT');
    assert.equal(requests[1].options.headers.Authorization, undefined);
    // A presigned URL must not gain a header its signature does not cover.
    assert.equal(requests[1].options.headers['X-Mktero-Version'], undefined);
    assert.equal(requests[1].options.body, PDF_BYTES);

    assert.equal(
        requests[2].url,
        `${API_BASE}/api/v1/conversions/job-1/complete`
    );
    assert.equal(requests[3].url, `${API_BASE}/api/v1/conversions/job-1`);
    assert.equal(
        requests[5].url,
        `${API_BASE}/api/v1/conversions/job-1/result-url`
    );
    assert.equal(requests[6].url, 'https://r2.example/result.zip');
    assert.deepEqual(jobs.map(job => job.status), [
        'awaiting_upload',
        'succeeded',
    ]);
    assert.equal(jobs.every(job => job.id === 'job-1' && job.provider === 'mktero'), true);
});

test('downloads an existing result without uploading when the service already has it', async () => {
    const requests = [];
    const progress = [];
    const archive = resultArchive();
    const responses = [
        jsonResponse(201, {
            job_id: 'job-ready',
            status: 'succeeded',
            progress: 100,
        }),
        jsonResponse(200, {
            result_url: 'https://r2.example/result.zip',
            method: 'GET',
        }),
        archiveResponse(archive),
    ];
    const client = new MkteroConversionClient({
        fetch: async (url, options) => {
            requests.push({ url, options });
            return responses.shift();
        },
        sleep: async () => {},
    });

    const converted = await client.convert({
        apiBase: API_BASE,
        getAccessToken: () => 'access-token',
        fileName: 'paper.pdf',
        fileData: PDF_BYTES,
        onProgress: value => progress.push(value),
    });

    assert.equal(converted.origin, 'network');
    assert.match(converted.result.markdown, /Converted/);
    const created = JSON.parse(requests[0].options.body);
    assert.equal(created.sha256, await sha256Hex(PDF_BYTES));
    assert.equal(created.sha256.length, 64);
    assert.deepEqual(requests.map(request => request.url), [
        `${API_BASE}/api/v1/conversions`,
        `${API_BASE}/api/v1/conversions/job-ready/result-url`,
        'https://r2.example/result.zip',
    ]);
    assert.deepEqual(progress, [2, 95, 95]);
    assert.equal(JSON.stringify(progress).includes('cache'), false);
});

test('reports a failed job with its service error code', async () => {
    const responses = [
        jsonResponse(201, {
            job_id: 'job-2',
            status: 'awaiting_upload',
            upload_url: 'https://r2.example/upload',
        }),
        { ok: true, status: 200, headers: { get: () => null } },
        jsonResponse(202, { job_id: 'job-2', status: 'queued' }),
        jsonResponse(200, {
            job_id: 'job-2',
            status: 'failed',
            error_code: 'MINERU_PARSE_FAILED',
        }),
    ];
    const client = new MkteroConversionClient({
        fetch: async () => responses.shift(),
        sleep: async () => {},
    });

    await assert.rejects(
        client.convert({
            apiBase: API_BASE,
            getAccessToken: () => 'access-token',
            fileName: 'paper.pdf',
            fileData: PDF_BYTES,
        }),
        error => error.code === 'MKTERO_CONVERSION_FAILED'
            && error.errorCode === 'MINERU_PARSE_FAILED'
    );
});

test('asks the user to sign in when the token is rejected', async () => {
    const client = new MkteroConversionClient({
        fetch: async () => jsonResponse(401, {
            error: { code: 'invalid_token', message: 'token is invalid or expired' },
        }),
        sleep: async () => {},
    });

    await assert.rejects(
        client.convert({
            apiBase: API_BASE,
            getAccessToken: () => 'expired-token',
            fileName: 'paper.pdf',
            fileData: PDF_BYTES,
        }),
        error => error.code === 'MKTERO_SIGN_IN_REQUIRED'
    );
});

test('refreshes the access token once when creating a job is unauthorized', async () => {
    let creates = 0;
    const keys = [];
    let token = 'expired-token';
    const archive = resultArchive();
    const client = new MkteroConversionClient({
        fetch: async (url, options) => {
            if (url.endsWith('/conversions') && options.method === 'POST') {
                creates += 1;
                keys.push(options.headers['Idempotency-Key']);
                if (creates === 1) {
                    assert.equal(options.headers.Authorization, 'Bearer expired-token');
                    return jsonResponse(401, {
                        error: { code: 'invalid_token', message: 'token is invalid or expired' },
                    });
                }
                assert.equal(options.headers.Authorization, 'Bearer refreshed-token');
                return awaitingUpload('job-auth', 'https://r2.example/upload');
            }
            if (options.method === 'PUT') return uploadResponse(200);
            if (url.endsWith('/complete')) {
                return jsonResponse(202, { job_id: 'job-auth', status: 'queued' });
            }
            if (url.endsWith('/job-auth')) {
                return jsonResponse(200, {
                    job_id: 'job-auth',
                    status: 'succeeded',
                    progress: 100,
                });
            }
            if (url.endsWith('/result-url')) {
                return jsonResponse(200, {
                    result_url: 'https://r2.example/result.zip',
                    method: 'GET',
                });
            }
            if (url === 'https://r2.example/result.zip') return archiveResponse(archive);
            throw new Error(`unexpected ${options.method} ${url}`);
        },
        sleep: async () => {},
    });

    const converted = await client.convert(convertOptions({
        getAccessToken: (options = {}) => {
            if (options?.forceRefresh) token = 'refreshed-token';
            return token;
        },
        idempotencyKey: 'logical-create-replay-1',
    }));

    assert.match(converted.result.markdown, /Converted/);
    assert.equal(creates, 2);
    assert.deepEqual(keys, ['logical-create-replay-1', 'logical-create-replay-1']);
});

test('reports a disabled account instead of asking for sign-in', async () => {
    const client = new MkteroConversionClient({
        fetch: async () => jsonResponse(403, {
            error: { code: 'account_disabled', message: 'account is disabled' },
        }),
        sleep: async () => {},
    });

    await assert.rejects(
        client.convert({
            apiBase: API_BASE,
            getAccessToken: () => 'access-token',
            fileName: 'paper.pdf',
            fileData: PDF_BYTES,
        }),
        error => error.code === 'MKTERO_ACCOUNT_DISABLED'
    );
});

test('fails before the request when no access token is available', async () => {
    let called = false;
    const client = new MkteroConversionClient({
        fetch: async () => {
            called = true;
            return jsonResponse(201, {});
        },
        sleep: async () => {},
    });

    await assert.rejects(
        client.convert({
            apiBase: API_BASE,
            getAccessToken: () => '',
            fileName: 'paper.pdf',
            fileData: PDF_BYTES,
        }),
        error => error.code === 'MKTERO_SIGN_IN_REQUIRED'
    );
    assert.equal(called, false);
});

test('does not retry an upload rejected with a non-expiry client error', async () => {
    for (const status of [400, 404, 408, 409, 429]) {
        const requests = [];
        const responses = [
            awaitingUpload('job-4', 'https://r2.example/upload'),
            uploadResponse(status),
        ];
        const client = new MkteroConversionClient({
            fetch: async (url, options) => {
                requests.push({ url, options });
                const next = responses.shift();
                if (next) return next;
                if (options.method === 'DELETE') {
                    return jsonResponse(200, { job_id: 'job-4', status: 'failed' });
                }
                throw new Error(`unexpected ${options.method} ${url}`);
            },
            sleep: async () => {},
        });

        await assert.rejects(
            client.convert(convertOptions()),
            error => error.code === 'MKTERO_UPLOAD_FAILED'
                && error.status === status
                && error.stage === 'upload'
                && !String(error.message).includes('server')
        );
        await flushTasks();
        assert.equal(requests.filter(request => request.options.method === 'PUT').length, 1);
        assert.equal(requests.some(request => request.url.endsWith('/upload-url')), false);
        assert.equal(requests.filter(request => request.options.method === 'DELETE').length, 1);
    }
});

test('keeps the transport failure and stage when the upload cannot connect', async () => {
    const requests = [];
    const responses = [
        jsonResponse(201, {
            job_id: 'job-5',
            status: 'awaiting_upload',
            upload_url: 'https://r2.example/upload',
        }),
    ];
    const transport = new TypeError('NetworkError when attempting to fetch resource');
    const client = new MkteroConversionClient({
        fetch: async (url, options) => {
            requests.push({ url, options });
            const next = responses.shift();
            if (next) return next;
            throw transport;
        },
        sleep: async () => {},
    });

    await assert.rejects(
        client.convert(convertOptions()),
        error => error.code === 'MKTERO_NETWORK_ERROR'
            && error.stage === 'upload'
            && error.requestLabel === 'PDF upload'
            && error.cause === transport
    );
    await flushTasks();
    // The transport failure is retryable, so renewal is attempted. It fails
    // the same way and does not hide the original upload error. Giving up
    // still cancels the job.
    assert.equal(requests.filter(request => request.options.method === 'PUT').length, 1);
    assert.equal(requests.filter(request => request.url.endsWith('/upload-url')).length, 1);
    assert.equal(requests.filter(request => request.options.method === 'DELETE').length, 1);
});

test('maps a retryable or unavailable conversion response to an action', async () => {
    const cases = [
        ['upload_expired', 410, 'MKTERO_JOB_NOT_FOUND'],
        ['invalid_upload', 422, 'MKTERO_CONVERSION_FAILED'],
        ['internal_error', 500, 'MKTERO_UNAVAILABLE'],
    ];
    for (const [serviceCode, status, code] of cases) {
        const client = new MkteroConversionClient({
            fetch: async () => jsonResponse(status, {
                error: { code: serviceCode, message: 'hidden' },
            }),
            sleep: async () => {},
        });
        await assert.rejects(
            client.convert({
                apiBase: API_BASE,
                getAccessToken: () => 'access-token',
                fileName: 'paper.pdf',
                fileData: PDF_BYTES,
            }),
            error => error.code === code && error.errorCode === serviceCode
        );
    }
});

test('keeps the HTTP status and service error code off the job API', async () => {
    const client = new MkteroConversionClient({
        fetch: async () => jsonResponse(404, {
            error: { code: 'conversion_not_found', message: 'job is unknown' },
        }),
        sleep: async () => {},
    });

    await assert.rejects(
        client.convert({
            apiBase: API_BASE,
            getAccessToken: () => 'access-token',
            fileName: 'paper.pdf',
            fileData: PDF_BYTES,
        }),
        error => error.code === 'MKTERO_JOB_NOT_FOUND'
            && error.status === 404
            && error.stage === 'api'
            && error.errorCode === 'conversion_not_found'
    );
});

test('stops polling when the caller aborts', async () => {
    const controller = new AbortController();
    const requests = [];
    const responses = [
        jsonResponse(201, {
            job_id: 'job-3',
            status: 'awaiting_upload',
            upload_url: 'https://r2.example/upload',
        }),
        { ok: true, status: 200, headers: { get: () => null } },
        jsonResponse(202, { job_id: 'job-3', status: 'queued' }),
    ];
    const client = new MkteroConversionClient({
        fetch: async (url, options) => {
            requests.push({ url, options });
            const next = responses.shift();
            if (next) return next;
            if (options.method === 'DELETE') {
                return jsonResponse(409, {
                    error: { code: 'conversion_not_cancellable', message: 'hidden' },
                });
            }
            throw new Error(`unexpected ${options.method} ${url}`);
        },
        sleep: async () => {
            controller.abort();
        },
    });

    await assert.rejects(
        client.convert({
            apiBase: API_BASE,
            getAccessToken: () => 'access-token',
            fileName: 'paper.pdf',
            fileData: PDF_BYTES,
            signal: controller.signal,
        }),
        error => error.name === 'AbortError'
            && !String(error.message).includes('hidden')
    );
    await flushTasks();
    assert.equal(
        requests.filter(request => request.options.method === 'DELETE').length,
        1
    );
});

test('does not cancel when the caller aborts before a job exists', async () => {
    const controller = new AbortController();
    controller.abort();
    const requests = [];
    const client = new MkteroConversionClient({
        fetch: async (url, options) => {
            requests.push({ url, options });
            return jsonResponse(201, {});
        },
        sleep: async () => {},
    });

    await assert.rejects(
        client.convert(convertOptions({ signal: controller.signal })),
        error => error.name === 'AbortError'
    );
    await flushTasks();
    assert.equal(requests.length, 0);
});

test('renews an expired upload URL and retries the PUT', async () => {
    const requests = [];
    const progress = [];
    const archive = resultArchive();
    const responses = [
        awaitingUpload('job-renew', 'https://r2.example/upload-1'),
        uploadResponse(403),
        jsonResponse(200, {
            job_id: 'job-renew',
            status: 'awaiting_upload',
            upload_url: 'https://r2.example/upload-2',
            upload_method: 'PUT',
            upload_headers: { 'x-amz-meta-test': 'renewed' },
            upload_expires_at: '2026-09-03T12:15:00Z',
        }),
        uploadResponse(200),
        jsonResponse(202, { job_id: 'job-renew', status: 'queued' }),
        jsonResponse(200, { job_id: 'job-renew', status: 'succeeded', progress: 100 }),
        jsonResponse(200, {
            result_url: 'https://r2.example/result.zip',
            method: 'GET',
        }),
        archiveResponse(archive),
    ];
    const client = new MkteroConversionClient({
        fetch: async (url, options) => {
            requests.push({ url, options });
            return responses.shift();
        },
        sleep: async () => {},
    });

    const converted = await client.convert(convertOptions({
        onProgress: value => progress.push(value),
    }));

    assert.match(converted.result.markdown, /Converted/);
    const puts = requests.filter(request => request.options.method === 'PUT');
    assert.equal(puts.length, 2);
    assert.equal(puts[0].url, 'https://r2.example/upload-1');
    assert.equal(puts[0].options.headers.Authorization, undefined);
    assert.equal(puts[0].options.headers['X-Mktero-Version'], undefined);
    assert.equal(puts[1].url, 'https://r2.example/upload-2');
    assert.equal(puts[1].options.headers['x-amz-meta-test'], 'renewed');
    assert.equal(puts[1].options.headers['X-Mktero-Version'], undefined);
    assert.equal(puts[1].options.body, PDF_BYTES);

    const renewal = requests.find(request => request.url.endsWith('/upload-url'));
    assert.equal(renewal.options.method, 'POST');
    assert.equal(renewal.options.body, null);
    assert.equal(renewal.options.headers.Authorization, 'Bearer access-token');
    assert.equal(renewal.options.headers['X-Mktero-Version'], mkteroVersion());
    assert.equal(
        requests.some(request => request.url.endsWith('/conversions/job-renew/complete')),
        true
    );
    assert.equal(requests.some(request => request.options.method === 'DELETE'), false);
    assert.equal(progress.filter(value => value === 5).length, 2);
});

test('renews after a transport failure and retries the PUT', async () => {
    const requests = [];
    const transport = new TypeError('NetworkError when attempting to fetch resource');
    let puts = 0;
    const archive = resultArchive();
    const client = new MkteroConversionClient({
        fetch: async (url, options) => {
            requests.push({ url, options });
            if (options.method === 'PUT') {
                puts += 1;
                if (puts === 1) throw transport;
                return uploadResponse(200);
            }
            if (url.endsWith('/upload-url')) {
                return jsonResponse(200, {
                    job_id: 'job-net',
                    status: 'awaiting_upload',
                    upload_url: 'https://r2.example/upload-2',
                    upload_method: 'PUT',
                });
            }
            if (url.endsWith('/conversions') && options.method === 'POST') {
                return awaitingUpload('job-net', 'https://r2.example/upload-1');
            }
            if (url.endsWith('/complete')) {
                return jsonResponse(202, { job_id: 'job-net', status: 'queued' });
            }
            if (url.endsWith('/job-net')) {
                return jsonResponse(200, {
                    job_id: 'job-net',
                    status: 'succeeded',
                    progress: 100,
                });
            }
            if (url.endsWith('/result-url')) {
                return jsonResponse(200, {
                    result_url: 'https://r2.example/result.zip',
                    method: 'GET',
                });
            }
            if (url === 'https://r2.example/result.zip') return archiveResponse(archive);
            throw new Error(`unexpected ${options.method} ${url}`);
        },
        sleep: async () => {},
    });

    const converted = await client.convert(convertOptions());
    assert.match(converted.result.markdown, /Converted/);
    assert.equal(puts, 2);
    assert.equal(
        requests.filter(request => request.options.method === 'PUT')[1].url,
        'https://r2.example/upload-2'
    );
    assert.equal(requests.some(request => request.options.method === 'DELETE'), false);
});

test('renews after an upload timeout and retries the PUT', async () => {
    let puts = 0;
    const archive = resultArchive();
    const client = new MkteroConversionClient({
        uploadTimeoutMs: 20,
        fetch: async (url, options) => {
            if (options.method === 'PUT') {
                puts += 1;
                if (puts === 1) {
                    return new Promise((resolve, reject) => {
                        options.signal.addEventListener('abort', () => {
                            const error = new Error('The operation was aborted');
                            error.name = 'AbortError';
                            reject(error);
                        }, { once: true });
                    });
                }
                return uploadResponse(200);
            }
            if (url.endsWith('/upload-url')) {
                return jsonResponse(200, {
                    job_id: 'job-timeout',
                    status: 'awaiting_upload',
                    upload_url: 'https://r2.example/upload-2',
                    upload_method: 'PUT',
                });
            }
            if (url.endsWith('/conversions') && options.method === 'POST') {
                return awaitingUpload('job-timeout', 'https://r2.example/upload-1');
            }
            if (url.endsWith('/complete')) {
                return jsonResponse(202, { job_id: 'job-timeout', status: 'queued' });
            }
            if (url.endsWith('/job-timeout')) {
                return jsonResponse(200, {
                    job_id: 'job-timeout',
                    status: 'succeeded',
                    progress: 100,
                });
            }
            if (url.endsWith('/result-url')) {
                return jsonResponse(200, {
                    result_url: 'https://r2.example/result.zip',
                    method: 'GET',
                });
            }
            if (url === 'https://r2.example/result.zip') return archiveResponse(archive);
            throw new Error(`unexpected ${options.method} ${url}`);
        },
        sleep: async () => {},
    });

    const converted = await client.convert(convertOptions());
    assert.match(converted.result.markdown, /Converted/);
    assert.equal(puts, 2);
});

test('refreshes the access token once when renewal is unauthorized', async () => {
    const requests = [];
    const forceRefreshCalls = [];
    let token = 'expired-token';
    let renewals = 0;
    const archive = resultArchive();
    const client = new MkteroConversionClient({
        fetch: async (url, options) => {
            requests.push({ url, options });
            if (url.endsWith('/upload-url')) {
                renewals += 1;
                if (renewals === 1) {
                    assert.equal(options.headers.Authorization, 'Bearer expired-token');
                    return jsonResponse(401, {
                        error: { code: 'invalid_token', message: 'token is invalid or expired' },
                    });
                }
                assert.equal(options.headers.Authorization, 'Bearer refreshed-token');
                return jsonResponse(200, {
                    job_id: 'job-auth',
                    status: 'awaiting_upload',
                    upload_url: 'https://r2.example/upload-2',
                    upload_method: 'PUT',
                });
            }
            if (options.method === 'PUT') {
                return options.body && url.endsWith('upload-1')
                    ? uploadResponse(403)
                    : uploadResponse(200);
            }
            if (url.endsWith('/conversions') && options.method === 'POST') {
                return awaitingUpload('job-auth', 'https://r2.example/upload-1');
            }
            if (url.endsWith('/complete')) {
                return jsonResponse(202, { job_id: 'job-auth', status: 'queued' });
            }
            if (url.endsWith('/job-auth')) {
                return jsonResponse(200, {
                    job_id: 'job-auth',
                    status: 'succeeded',
                    progress: 100,
                });
            }
            if (url.endsWith('/result-url')) {
                return jsonResponse(200, {
                    result_url: 'https://r2.example/result.zip',
                    method: 'GET',
                });
            }
            if (url === 'https://r2.example/result.zip') return archiveResponse(archive);
            throw new Error(`unexpected ${options.method} ${url}`);
        },
        sleep: async () => {},
    });

    const converted = await client.convert(convertOptions({
        getAccessToken: (options = {}) => {
            forceRefreshCalls.push(options?.forceRefresh === true);
            if (options?.forceRefresh) token = 'refreshed-token';
            return token;
        },
    }));

    assert.match(converted.result.markdown, /Converted/);
    assert.equal(renewals, 2);
    assert.deepEqual(forceRefreshCalls.filter(Boolean), [true]);
    assert.equal(String(JSON.stringify(requests)).includes('token is invalid or expired'), false);
});

test('does not replay an unauthorized renewal more than once', async () => {
    let renewals = 0;
    const requests = [];
    const client = new MkteroConversionClient({
        fetch: async (url, options) => {
            requests.push({ url, options });
            if (url.endsWith('/upload-url')) {
                renewals += 1;
                return jsonResponse(401, {
                    error: { code: 'invalid_token', message: 'token is invalid or expired' },
                });
            }
            if (options.method === 'PUT') return uploadResponse(403);
            if (options.method === 'DELETE') {
                return jsonResponse(401, {
                    error: { code: 'invalid_token', message: 'token is invalid or expired' },
                });
            }
            if (options.method === 'POST') {
                return awaitingUpload('job-401', 'https://r2.example/upload');
            }
            throw new Error(`unexpected ${options.method} ${url}`);
        },
        sleep: async () => {},
    });

    await assert.rejects(
        client.convert(convertOptions()),
        error => error.code === 'MKTERO_SIGN_IN_REQUIRED'
            && error.message === 'The Mktero conversion request failed'
            && !error.message.includes('token is invalid or expired')
    );
    await flushTasks();
    assert.equal(renewals, 2);
    assert.equal(requests.filter(request => request.options.method === 'PUT').length, 1);
    assert.equal(requests.filter(request => request.options.method === 'DELETE').length, 1);
});

test('gives up after three upload failures and cancels the job', async () => {
    const requests = [];
    const putStatuses = [500, 502, 503];
    const client = new MkteroConversionClient({
        fetch: async (url, options) => {
            requests.push({ url, options });
            if (options.method === 'PUT') {
                return uploadResponse(putStatuses.shift());
            }
            if (url.endsWith('/upload-url')) {
                const attempt = requests.filter(request => request.url.endsWith('/upload-url')).length;
                return jsonResponse(200, {
                    job_id: 'job-5xx',
                    status: 'awaiting_upload',
                    upload_url: `https://r2.example/upload-${attempt + 1}`,
                    upload_method: 'PUT',
                });
            }
            if (options.method === 'DELETE') {
                return jsonResponse(409, {
                    error: {
                        code: 'conversion_not_cancellable',
                        message: 'hidden server text',
                    },
                });
            }
            if (options.method === 'POST' && url.endsWith('/conversions')) {
                return awaitingUpload('job-5xx', 'https://r2.example/upload-1');
            }
            throw new Error(`unexpected ${options.method} ${url}`);
        },
        sleep: async () => {},
    });

    await assert.rejects(
        client.convert(convertOptions()),
        error => error.code === 'MKTERO_UPLOAD_FAILED'
            && error.status === 503
            && error.stage === 'upload'
            && error.message === 'The PDF upload to Mktero failed'
            && !error.message.includes('hidden server text')
    );
    await flushTasks();
    assert.equal(requests.filter(request => request.options.method === 'PUT').length, 3);
    assert.equal(requests.filter(request => request.url.endsWith('/upload-url')).length, 2);
    const cancel = requests.filter(request => request.options.method === 'DELETE');
    assert.equal(cancel.length, 1);
    assert.equal(cancel[0].url, `${API_BASE}/api/v1/conversions/job-5xx`);
    assert.equal(cancel[0].options.headers.Authorization, 'Bearer access-token');
    assert.equal(cancel[0].options.headers['X-Mktero-Version'], mkteroVersion());
    assert.equal(putStatuses.length, 0);
});

test('cancels the hosted job when the caller aborts after the job is created', async () => {
    const controller = new AbortController();
    const requests = [];
    const client = new MkteroConversionClient({
        fetch: async (url, options) => {
            requests.push({ url, options });
            if (options.method === 'DELETE') {
                assert.notEqual(options.signal, controller.signal);
                assert.equal(options.signal?.aborted, false);
                return jsonResponse(409, {
                    error: {
                        code: 'conversion_not_cancellable',
                        message: 'hidden server text',
                    },
                });
            }
            if (options.method === 'PUT') {
                controller.abort();
                const aborted = new Error('The operation was aborted');
                aborted.name = 'AbortError';
                throw aborted;
            }
            if (options.method === 'POST' && url.endsWith('/conversions')) {
                return awaitingUpload('job-abort', 'https://r2.example/upload');
            }
            throw new Error(`unexpected ${options.method} ${url}`);
        },
        sleep: async () => {},
    });

    await assert.rejects(
        client.convert(convertOptions({ signal: controller.signal })),
        error => error.name === 'AbortError'
            && !String(error.message).includes('hidden server text')
    );
    await flushTasks();
    const cancel = requests.filter(request => request.options.method === 'DELETE');
    assert.equal(cancel.length, 1);
    assert.equal(cancel[0].url, `${API_BASE}/api/v1/conversions/job-abort`);
    assert.equal(cancel[0].options.method, 'DELETE');
    assert.equal(requests.filter(request => request.options.method === 'PUT').length, 1);
});

test('does not wait for cancellation before reporting an abort', async () => {
    const controller = new AbortController();
    let releaseDelete;
    const deleteHung = new Promise(resolve => {
        releaseDelete = resolve;
    });
    const client = new MkteroConversionClient({
        cancelTimeoutMs: 30_000,
        fetch: async (url, options) => {
            if (options.method === 'DELETE') return deleteHung;
            if (options.method === 'PUT') {
                controller.abort();
                const aborted = new Error('The operation was aborted');
                aborted.name = 'AbortError';
                throw aborted;
            }
            return awaitingUpload('job-slow-cancel', 'https://r2.example/upload');
        },
        sleep: async () => {},
    });

    const started = Date.now();
    await assert.rejects(
        client.convert(convertOptions({ signal: controller.signal })),
        error => error.name === 'AbortError'
    );
    assert.ok(Date.now() - started < 1000);
    releaseDelete(jsonResponse(200, { job_id: 'job-slow-cancel', status: 'failed' }));
    await deleteHung;
    await flushTasks();
});

test('does not retry forever when renewal returns no upload URL', async () => {
    const requests = [];
    const responses = [
        awaitingUpload('job-moved', 'https://r2.example/upload'),
        uploadResponse(403),
        jsonResponse(200, {
            job_id: 'job-moved',
            status: 'queued',
            progress: 0,
        }),
    ];
    const client = new MkteroConversionClient({
        fetch: async (url, options) => {
            requests.push({ url, options });
            const next = responses.shift();
            if (next) return next;
            if (options.method === 'DELETE') {
                return jsonResponse(409, {
                    error: {
                        code: 'conversion_not_cancellable',
                        message: 'hidden server text',
                    },
                });
            }
            throw new Error(`unexpected ${options.method} ${url}`);
        },
        sleep: async () => {},
    });

    await assert.rejects(
        client.convert(convertOptions()),
        error => error.code === 'MKTERO_UPLOAD_FAILED'
            && error.status === 403
            && error.stage === 'upload'
            && !String(error.message).includes('hidden server text')
    );
    await flushTasks();
    assert.equal(requests.filter(request => request.options.method === 'PUT').length, 1);
    assert.equal(requests.filter(request => request.url.endsWith('/upload-url')).length, 1);
    assert.equal(requests.filter(request => request.options.method === 'DELETE').length, 1);
});

async function settleWithin(promise, ms) {
    let timer;
    const guard = new Promise(resolve => {
        timer = setTimeout(() => resolve({ pending: true }), ms);
    });
    try {
        return await Promise.race([
            promise.then(value => ({ value }), error => ({ error })),
            guard,
        ]);
    }
    finally {
        clearTimeout(timer);
    }
}

test('stops waiting for an access token when the conversion is cancelled', async () => {
    const controller = new AbortController();
    const requests = [];
    let tokenRequested;
    const requested = new Promise(resolve => { tokenRequested = resolve; });
    const client = new MkteroConversionClient({
        fetch: async (url, options) => {
            requests.push({ url, options });
            throw new Error(`unexpected ${options.method} ${url}`);
        },
        sleep: async () => {},
    });

    // The account session can wait up to its lock TTL for a refresh that a
    // crashed Zotero left behind.
    const converting = client.convert(convertOptions({
        signal: controller.signal,
        getAccessToken: () => {
            tokenRequested();
            return new Promise(() => {});
        },
    }));
    await requested;
    controller.abort();

    const outcome = await settleWithin(converting, 1000);
    assert.equal(outcome.pending, undefined);
    assert.equal(outcome.error?.name, 'AbortError');
    assert.equal(requests.length, 0);
});

test('stops waiting for a forced token refresh when the conversion is cancelled', async () => {
    const controller = new AbortController();
    const requests = [];
    let refreshRequested;
    const requested = new Promise(resolve => { refreshRequested = resolve; });
    const client = new MkteroConversionClient({
        fetch: async (url, options) => {
            requests.push({ url, options });
            return jsonResponse(401, {
                error: { code: 'invalid_token', message: 'token is invalid or expired' },
            });
        },
        sleep: async () => {},
    });

    const converting = client.convert(convertOptions({
        signal: controller.signal,
        getAccessToken: (options = {}) => {
            if (!options?.forceRefresh) return 'expired-token';
            refreshRequested();
            return new Promise(() => {});
        },
    }));
    await requested;
    controller.abort();

    const outcome = await settleWithin(converting, 1000);
    assert.equal(outcome.pending, undefined);
    assert.equal(outcome.error?.name, 'AbortError');
    assert.equal(requests.length, 1);
});

test('times a request from when its access token is ready', async () => {
    const client = new MkteroConversionClient({
        requestTimeoutMs: 1,
        fetch: async (url, options) => {
            if (options.signal.aborted) {
                throw new DOMException('The operation was aborted', 'AbortError');
            }
            return jsonResponse(403, {
                error: { code: 'account_disabled', message: 'account is disabled' },
            });
        },
        sleep: async () => {},
    });

    // The refresh ends after the request timeout, but inside the refresh lock
    // TTL, so the request is still sent.
    await assert.rejects(
        client.convert(convertOptions({
            getAccessToken: () => new Promise(resolve => {
                setTimeout(() => resolve('access-token'), 30);
            }),
        })),
        error => error.code === 'MKTERO_ACCOUNT_DISABLED'
    );
});

test('uses the provided source hash and idempotency key and optionally returns the raw archive', async () => {
    const archive = resultArchive();
    const requests = [];
    const client = successfulClient({
        archive,
        onRequest: (url, options) => requests.push({ url, options }),
    });

    const converted = await client.convert(convertOptions({
        sourceHash: 'B'.repeat(64),
        idempotencyKey: 'logical-conversion-42',
        includeRawArchive: true,
    }));

    assert.equal(requests[0].options.headers['Idempotency-Key'], 'logical-conversion-42');
    assert.equal(JSON.parse(requests[0].options.body).sha256, 'b'.repeat(64));
    assert.deepEqual(converted.rawArchive, archive);
    assert.equal('resultArchive' in converted, false);
});

test('keeps the trimmed result archive independent from raw archive opt-in', async () => {
    const archive = resultArchive();
    const client = successfulClient({ archive });
    const converted = await client.convert(convertOptions({ includeArchive: true }));

    assert.equal('rawArchive' in converted, false);
    assert.ok(converted.resultArchive instanceof Uint8Array);
    assert.notDeepEqual(converted.resultArchive, archive);
});

test('rejects invalid explicit idempotency keys before contacting the service', async () => {
    let calls = 0;
    const client = new MkteroConversionClient({
        fetch: async () => { calls += 1; return jsonResponse(201, {}); },
        sleep: async () => {},
    });

    await assert.rejects(client.convert(convertOptions({ idempotencyKey: 'bad\nkey' })), TypeError);
    assert.equal(calls, 0);
});

test('reports cancel cleanup before rejecting and isolates cleanup callback errors', async () => {
    const controller = new AbortController();
    let releaseDelete;
    let cleanup;
    const deleteGate = new Promise(resolve => { releaseDelete = resolve; });
    const client = new MkteroConversionClient({
        fetch: async (url, options) => {
            if (options.method === 'POST') {
                return awaitingUpload('job-cleanup-observer', 'https://r2.example/upload');
            }
            if (options.method === 'PUT') {
                controller.abort();
                throw new DOMException('The operation was aborted', 'AbortError');
            }
            if (options.method === 'DELETE') return deleteGate;
            throw new Error(`unexpected ${options.method} ${url}`);
        },
        sleep: async () => {},
    });

    await assert.rejects(client.convert(convertOptions({
        signal: controller.signal,
        onCleanup: pending => {
            cleanup = pending;
            throw new Error('observer failure');
        },
    })), { name: 'AbortError' });
    assert.equal(typeof cleanup?.then, 'function');
    const settled = settleWithin(cleanup, 20);
    assert.equal((await settled).pending, true);
    releaseDelete(jsonResponse(200, { job_id: 'job-cleanup-observer', status: 'failed' }));
    await cleanup;
});

test('bounds cancel cleanup while waiting for an access token', async () => {
    const controller = new AbortController();
    let tokenCalls = 0;
    let cleanup;
    const requests = [];
    const client = new MkteroConversionClient({
        cancelTimeoutMs: 25,
        fetch: async (url, options) => {
            requests.push({ url, options });
            if (options.method === 'POST') {
                return awaitingUpload('job-token-timeout', 'https://r2.example/upload');
            }
            if (options.method === 'PUT') {
                controller.abort();
                throw new DOMException('The operation was aborted', 'AbortError');
            }
            throw new Error(`unexpected ${options.method} ${url}`);
        },
        sleep: async () => {},
    });

    const started = Date.now();
    await assert.rejects(client.convert(convertOptions({
        signal: controller.signal,
        getAccessToken: () => {
            tokenCalls += 1;
            return tokenCalls === 1 ? 'access-token' : new Promise(() => {});
        },
        onCleanup: pending => { cleanup = pending; },
    })), { name: 'AbortError' });
    const outcome = await settleWithin(cleanup, 1000);
    assert.equal(outcome.pending, undefined);
    assert.equal(outcome.error, undefined);
    assert.ok(Date.now() - started < 1000);
    assert.equal(requests.filter(request => request.options.method === 'DELETE').length, 0);
});

test('bounds DELETE body cleanup and aborts the transfer even when the body ignores cancellation', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const controller = new AbortController();
    const reading = deferred();
    const body = deferred();
    let cleanup;
    let cancelSignal;
    let cleaned = false;
    const client = new MkteroConversionClient({
        cancelTimeoutMs: 20,
        fetch: async (url, options) => {
            if (options.method === 'POST') {
                return awaitingUpload('job-cancel-body', 'https://r2.example/upload');
            }
            if (options.method === 'PUT') {
                controller.abort();
                throw new DOMException('The operation was aborted', 'AbortError');
            }
            if (options.method === 'DELETE') {
                cancelSignal = options.signal;
                return {
                    ...jsonResponse(200, {}),
                    arrayBuffer: () => { reading.resolve(); return body.promise; },
                };
            }
            throw new Error(`unexpected ${options.method} ${url}`);
        },
    });

    await assert.rejects(client.convert(convertOptions({
        signal: controller.signal,
        onCleanup: pending => { cleanup = pending; },
    })), { name: 'AbortError' });
    await reading.promise;
    void cleanup.then(() => { cleaned = true; });
    try {
        t.mock.timers.tick(19);
        await flushTasks();
        assert.equal(cleaned, false);
        assert.equal(cancelSignal.aborted, false);
        t.mock.timers.tick(1);
        await flushTasks();
        assert.equal(cancelSignal.aborted, true);
        assert.equal(cleaned, true);
    }
    finally {
        body.resolve(strToU8('{}').buffer);
        await cleanup;
    }
});

test('cancels a job when its create response arrives after the caller aborts', async () => {
    const controller = new AbortController();
    let returnCreate;
    let signalCreateStarted;
    let cleanup;
    const createResponse = new Promise(resolve => { returnCreate = resolve; });
    const started = new Promise(resolve => { signalCreateStarted = resolve; });
    const requests = [];
    const client = new MkteroConversionClient({
        fetch: async (url, options) => {
            requests.push({ url, options });
            if (options.method === 'POST') {
                signalCreateStarted();
                return createResponse;
            }
            if (options.method === 'DELETE') {
                return jsonResponse(200, { job_id: 'job-late', status: 'failed' });
            }
            throw new Error(`unexpected ${options.method} ${url}`);
        },
        sleep: async () => {},
    });

    const converting = client.convert(convertOptions({
        signal: controller.signal,
        onCleanup: pending => { cleanup = pending; },
    }));
    await started;
    controller.abort();
    returnCreate(awaitingUpload('job-late', 'https://r2.example/upload'));
    await assert.rejects(converting, { name: 'AbortError' });
    await cleanup;

    assert.equal(requests.filter(request => request.options.method === 'PUT').length, 0);
    assert.equal(requests.filter(request => request.options.method === 'DELETE').length, 1);
    assert.equal(requests.find(request => request.options.method === 'DELETE').url,
        `${API_BASE}/api/v1/conversions/job-late`);
});

test('reports cancellation immediately and preserves the started create body for cleanup', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const controller = new AbortController();
    const reading = deferred();
    const body = deferred();
    const requests = [];
    let cleanup;
    let failure;
    const reason = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const client = new MkteroConversionClient({
        fetch: async (url, options) => {
            requests.push({ url, options });
            if (options.method === 'POST') {
                return {
                    ...jsonResponse(201, {}),
                    arrayBuffer: async () => {
                        const abort = () => body.reject(options.signal.reason);
                        options.signal.addEventListener('abort', abort, { once: true });
                        reading.resolve();
                        try { return await body.promise; }
                        finally { options.signal.removeEventListener('abort', abort); }
                    },
                };
            }
            if (options.method === 'DELETE') return jsonResponse(200, {});
            throw new Error(`unexpected ${options.method} ${url}`);
        },
    });

    const converted = client.convert(convertOptions({
        signal: controller.signal,
        onCleanup: pending => { cleanup = pending; },
    }));
    void converted.catch(error => { failure = error; });
    await reading.promise;
    controller.abort(reason);
    try {
        await flushTasks();
        assert.equal(failure, reason);
        assert.equal(requests[0].options.signal.aborted, false);
    }
    finally {
        body.resolve(strToU8(JSON.stringify({
            job_id: 'job-readable-after-abort',
            status: 'awaiting_upload',
            upload_url: 'https://r2.example/upload',
        })).buffer);
        await converted.catch(() => {});
        await cleanup;
    }
    assert.deepEqual(requests.map(request => request.options.method), ['POST', 'DELETE']);
    t.mock.timers.tick(30_000);
    await flushTasks();
    // Neither the create recovery timer nor DELETE's total deadline survives
    // a completed cleanup; successful response consumption removed them both.
    assert.equal(requests.every(request => !request.options.signal.aborted), true);
});

test('cancels the late job when aborted during the create response body', async () => {
    const controller = new AbortController();
    const reading = deferred();
    const body = deferred();
    const requests = [];
    let cleanup;
    const client = new MkteroConversionClient({
        fetch: async (url, options) => {
            requests.push({ url, options });
            if (options.method === 'POST') {
                return {
                    ...jsonResponse(201, {}),
                    arrayBuffer: () => { reading.resolve(); return body.promise; },
                };
            }
            if (options.method === 'DELETE') return jsonResponse(200, {});
            throw new Error(`unexpected ${options.method} ${url}`);
        },
    });

    const converted = client.convert(convertOptions({
        signal: controller.signal,
        onCleanup: pending => { cleanup = pending; },
    }));
    const rejected = assert.rejects(converted, { name: 'AbortError' });
    await reading.promise;
    controller.abort();
    body.resolve(strToU8(JSON.stringify({
        job_id: 'job-late-body',
        status: 'awaiting_upload',
        upload_url: 'https://r2.example/upload',
    })).buffer);
    await rejected;
    await cleanup;

    assert.deepEqual(requests.map(request => request.options.method), ['POST', 'DELETE']);
    const cancel = requests[1];
    assert.equal(cancel.url, `${API_BASE}/api/v1/conversions/job-late-body`);
    assert.equal(cancel.options.signal.aborted, false);
});

for (const phase of ['fetch', 'body']) {
    test(`bounds late create ${phase} cleanup even with request timeouts disabled`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const controller = new AbortController();
        const entered = deferred();
        const late = deferred();
        const requests = [];
        let cleanup;
        let cleaned = false;
        const client = new MkteroConversionClient({
            requestTimeoutMs: 0,
            cancelTimeoutMs: 20,
            fetch: async (url, options) => {
                requests.push({ url, options });
                if (phase === 'fetch') {
                    entered.resolve();
                    return late.promise;
                }
                return {
                    ...jsonResponse(201, {}),
                    arrayBuffer: () => { entered.resolve(); return late.promise; },
                };
            },
        });
        const reason = Object.assign(new Error('cancelled while creating'), { name: 'AbortError' });
        const converted = client.convert(convertOptions({
            signal: controller.signal,
            onCleanup: pending => { cleanup = pending; },
        }));
        const rejected = assert.rejects(converted, error => error === reason);
        await entered.promise;
        controller.abort(reason);
        await rejected;
        void cleanup.then(() => { cleaned = true; });
        assert.equal(requests[0].options.signal.aborted, phase === 'fetch');
        t.mock.timers.tick(19);
        await flushTasks();
        assert.equal(cleaned, false);
        t.mock.timers.tick(1);
        await flushTasks();
        assert.equal(cleaned, true);
        assert.equal(requests[0].options.signal.aborted, true);

        // A transport settling after its recovery deadline cannot resume work
        // or send an extra DELETE, and a late rejection must remain observed.
        if (phase === 'fetch') late.resolve(awaitingUpload('job-too-late', 'https://r2.example/upload'));
        else late.reject(new TypeError('late body failure'));
        await flushTasks();
        assert.deepEqual(requests.map(request => request.options.method), ['POST']);
    });

    test(`the DELETE deadline includes token wait and ${phase} transfer`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const controller = new AbortController();
        const tokenRequested = deferred();
        const token = deferred();
        const entered = deferred();
        const late = deferred();
        let tokenCalls = 0;
        let cleanup;
        let cancelSignal;
        let cleaned = false;
        const client = new MkteroConversionClient({
            cancelTimeoutMs: 20,
            fetch: async (url, options) => {
                if (options.method === 'POST') return awaitingUpload('job-total-deadline', 'https://r2.example/upload');
                if (options.method === 'PUT') {
                    controller.abort();
                    throw new DOMException('The operation was aborted', 'AbortError');
                }
                if (options.method === 'DELETE') {
                    cancelSignal = options.signal;
                    if (phase === 'fetch') { entered.resolve(); return late.promise; }
                    return {
                        ...jsonResponse(200, {}),
                        arrayBuffer: () => { entered.resolve(); return late.promise; },
                    };
                }
                throw new Error(`unexpected ${options.method} ${url}`);
            },
        });
        await assert.rejects(client.convert(convertOptions({
            signal: controller.signal,
            getAccessToken: () => {
                if (++tokenCalls === 1) return 'access-token';
                tokenRequested.resolve();
                return token.promise;
            },
            onCleanup: pending => { cleanup = pending; },
        })), { name: 'AbortError' });
        await tokenRequested.promise;
        void cleanup.then(() => { cleaned = true; });
        t.mock.timers.tick(15);
        token.resolve('access-token');
        await entered.promise;
        t.mock.timers.tick(4);
        await flushTasks();
        assert.equal(cleaned, false);
        assert.equal(cancelSignal.aborted, false);
        t.mock.timers.tick(1);
        await flushTasks();
        assert.equal(cancelSignal.aborted, true);
        assert.equal(cleaned, true);
        late.reject(new TypeError('late transfer failure'));
        await flushTasks();
    });
}

for (const stage of ['JSON', 'download']) {
    for (const stop of ['cancel', 'timeout']) {
        test(`${stop} stops the ${stage} response body and cancels its transfer`, async t => {
            t.mock.timers.enable({ apis: ['setTimeout'] });
            const controller = new AbortController();
            const reading = deferred();
            const body = deferred();
            let transferSignal;
            let cleanup;
            let failure;
            const requests = [];
            const client = new MkteroConversionClient({
                requestTimeoutMs: 20,
                downloadTimeoutMs: 20,
                fetch: async (url, options) => {
                    requests.push({ url, options });
                    if (options.method === 'POST') return jsonResponse(201, { job_id: 'job-read-body', status: 'succeeded' });
                    if (options.method === 'DELETE') return jsonResponse(409, { error: { code: 'conversion_not_cancellable' } });
                    if (stage === 'download' && url.endsWith('/result-url')) {
                        return jsonResponse(200, { result_url: 'https://r2.example/result.zip' });
                    }
                    transferSignal = options.signal;
                    return {
                        ...jsonResponse(200, {}),
                        arrayBuffer: () => { reading.resolve(); return body.promise; },
                    };
                },
            });
            const converted = client.convert(convertOptions({
                signal: controller.signal,
                onCleanup: pending => { cleanup = pending; },
            }));
            void converted.catch(error => { failure = error; });
            await reading.promise;
            const reason = Object.assign(new Error('cancelled while reading'), { name: 'AbortError' });
            if (stop === 'cancel') controller.abort(reason);
            else t.mock.timers.tick(20);
            await flushTasks();
            assert.equal(transferSignal.aborted, true);
            if (stop === 'cancel') assert.equal(failure, reason);
            else assert.equal(failure?.code, 'MKTERO_REQUEST_TIMEOUT');
            await cleanup;
            assert.equal(requests.filter(request => request.options.method === 'DELETE').length, 1);
            body.reject(new TypeError('late response body failure'));
            await flushTasks();
        });
    }
}

for (const cancelled of [false, true]) {
    test(`cleans up a ${cancelled ? 'late cancelled' : 'failed'} create that has a job id but no upload URL`, async () => {
        const controller = new AbortController();
        const reading = deferred();
        const body = deferred();
        const requests = [];
        let cleanup;
        const client = new MkteroConversionClient({
            fetch: async (url, options) => {
                requests.push({ url, options });
                if (options.method === 'DELETE') return jsonResponse(200, {});
                return {
                    ...jsonResponse(201, {}),
                    arrayBuffer: () => { reading.resolve(); return body.promise; },
                };
            },
        });
        const converted = client.convert(convertOptions({
            signal: controller.signal,
            onCleanup: pending => { cleanup = pending; },
        }));
        const rejected = assert.rejects(converted, cancelled
            ? { name: 'AbortError' } : { code: 'MKTERO_INVALID_RESPONSE' });
        await reading.promise;
        if (cancelled) controller.abort();
        body.resolve(strToU8(JSON.stringify({ job_id: 'job-invalid-upload', status: 'awaiting_upload' })).buffer);
        await rejected;
        await cleanup;
        assert.deepEqual(requests.map(request => request.options.method), ['POST', 'DELETE']);
        assert.equal(requests[1].url, `${API_BASE}/api/v1/conversions/job-invalid-upload`);
    });
}

for (const stage of ['JSON limit', 'archive limit', 'download status']) {
    test(`aborts the unread transfer after rejecting its ${stage}`, async () => {
        let transferSignal;
        let cleanup;
        const client = new MkteroConversionClient({
            fetch: async (url, options) => {
                if (options.method === 'DELETE') return jsonResponse(200, {});
                if (stage !== 'JSON limit') {
                    if (options.method === 'POST') return jsonResponse(201, { job_id: 'job-unread', status: 'succeeded' });
                    if (url.endsWith('/result-url')) return jsonResponse(200, { result_url: 'https://r2.example/result.zip' });
                }
                transferSignal = options.signal;
                return {
                    ok: stage !== 'download status',
                    status: stage === 'download status' ? 500 : 200,
                    headers: { get: () => String(300 * 1024 * 1024) },
                    arrayBuffer: () => { throw new Error('The oversized or rejected body must not be read'); },
                };
            },
        });
        await assert.rejects(client.convert(convertOptions({ onCleanup: pending => { cleanup = pending; } })), {
            code: stage === 'JSON limit' ? 'MKTERO_INVALID_RESPONSE'
                : stage === 'archive limit' ? 'MKTERO_ARCHIVE_TOO_LARGE' : 'MKTERO_DOWNLOAD_FAILED',
        });
        await cleanup;
        assert.equal(transferSignal.aborted, true);
    });
}

test('a cancelled create receiving a late 401 does not refresh or replay', async () => {
    const controller = new AbortController();
    const reading = deferred();
    const body = deferred();
    const requests = [];
    let cleanup;
    let tokenCalls = 0;
    const client = new MkteroConversionClient({
        fetch: async (url, options) => {
            requests.push({ url, options });
            return {
                ...jsonResponse(401, {}),
                arrayBuffer: () => { reading.resolve(); return body.promise; },
            };
        },
    });
    const converted = client.convert(convertOptions({
        signal: controller.signal,
        getAccessToken: () => { tokenCalls += 1; return 'expired-token'; },
        onCleanup: pending => { cleanup = pending; },
    }));
    const rejected = assert.rejects(converted, { name: 'AbortError' });
    await reading.promise;
    controller.abort();
    await rejected;
    body.resolve(strToU8(JSON.stringify({ error: { code: 'invalid_token' } })).buffer);
    await cleanup;
    assert.equal(tokenCalls, 1);
    assert.deepEqual(requests.map(request => request.options.method), ['POST']);
});

test('resolves a conversion target without sending PDF bytes', async () => {
    const requests = [];
    const client = new MkteroConversionClient({
        fetch: async (url, options) => {
            requests.push({ url, options });
            return jsonResponse(200, {
                route_id: 'route-1',
                model_version: 'pipeline',
                parser_profile_id: 'mineru/v4-batch-pipeline-1',
            });
        },
        sleep: async () => {},
    });

    const target = await client.resolveTarget({
        apiBase: API_BASE,
        getAccessToken: () => 'access-token',
        sourceHash: 'A'.repeat(64),
        expectedSize: 4096,
    });

    assert.deepEqual(target, {
        routeId: 'route-1',
        modelVersion: 'pipeline',
        parserProfileId: 'mineru/v4-batch-pipeline-1',
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, `${API_BASE}/api/v1/conversions/resolve`);
    assert.equal(requests[0].options.method, 'POST');
    const body = JSON.parse(requests[0].options.body);
    // A resolve is a lookup, not an upload: only identity is sent.
    assert.deepEqual(body, {
        sha256: 'a'.repeat(64),
        expected_size: 4096,
        content_type: 'application/pdf',
    });
});

test('a service without the resolve route is reported instead of guessing a model', async () => {
    const client = new MkteroConversionClient({
        fetch: async () => jsonResponse(404, { error: { code: 'not_found', message: 'no route' } }),
        sleep: async () => {},
    });

    await assert.rejects(
        () => client.resolveTarget({
            apiBase: API_BASE,
            getAccessToken: () => 'access-token',
            sourceHash: 'b'.repeat(64),
            expectedSize: 2048,
        }),
        error => error.code === 'MKTERO_RESOLVE_UNSUPPORTED'
    );
});

test('a resolve answer that names no usable model is rejected', async () => {
    for (const payload of [
        // A model the client does not know, a missing profile, a missing
        // route, and a model that disagrees with the profile it names.
        { route_id: 'route-1', model_version: 'MinerU-HTML', parser_profile_id: 'mineru/v4-batch-vlm-1' },
        { route_id: 'route-1', model_version: 'pipeline' },
        { model_version: 'vlm', parser_profile_id: 'mineru/v4-batch-vlm-1' },
        { route_id: 'route-1', model_version: 'vlm', parser_profile_id: 'mineru/v4-batch-pipeline-1' },
        { route_id: 'route-1', model_version: 'pipeline', parser_profile_id: 'mineru/v4-batch-vlm-1' },
    ]) {
        const client = new MkteroConversionClient({
            fetch: async () => jsonResponse(200, payload),
            sleep: async () => {},
        });
        await assert.rejects(
            () => client.resolveTarget({
                apiBase: API_BASE,
                getAccessToken: () => 'access-token',
                sourceHash: 'c'.repeat(64),
                expectedSize: 1024,
            }),
            error => error.code === 'MKTERO_INVALID_TARGET'
        );
    }
});

test('sends the resolved target with the job and returns it with the result', async () => {
    const requests = [];
    const archive = resultArchive();
    const target = { routeId: 'route-9', modelVersion: 'pipeline', parserProfileId: 'mineru/v4-batch-pipeline-1' };
    const responses = [
        jsonResponse(201, {
            job_id: 'job-target',
            status: 'awaiting_upload',
            upload_url: 'https://r2.example/upload',
            upload_method: 'PUT',
            model_version: 'pipeline',
            parser_profile_id: 'mineru/v4-batch-pipeline-1',
        }),
        uploadResponse(200),
        jsonResponse(202, { job_id: 'job-target', status: 'queued' }),
        jsonResponse(200, {
            job_id: 'job-target',
            status: 'succeeded',
            progress: 100,
            model_version: 'pipeline',
            parser_profile_id: 'mineru/v4-batch-pipeline-1',
        }),
        jsonResponse(200, { result_url: 'https://r2.example/result.zip' }),
        archiveResponse(archive),
    ];
    const client = new MkteroConversionClient({
        fetch: async (url, options) => {
            requests.push({ url, options });
            return responses.shift();
        },
        sleep: async () => {},
    });

    const converted = await client.convert(convertOptions({ target }));

    const created = JSON.parse(requests[0].options.body);
    assert.equal(created.route_id, 'route-9');
    assert.equal(created.model_version, 'pipeline');
    assert.equal(created.parser_profile_id, 'mineru/v4-batch-pipeline-1');
    // A job carries only the parse snapshot; the route handle stays with the
    // caller. The returned target therefore keeps the route it already had.
    assert.deepEqual(converted.target, target);
});

test('re-resolves once when the stored route moved before create', async () => {
    const created = [];
    const archive = resultArchive();
    const responses = [
        jsonResponse(409, { error: { code: 'conversion_target_changed', message: 'moved' } }),
        jsonResponse(200, {
            route_id: 'route-2',
            model_version: 'pipeline',
            parser_profile_id: 'mineru/v4-batch-pipeline-1',
        }),
        jsonResponse(201, {
            job_id: 'job-moved',
            status: 'awaiting_upload',
            upload_url: 'https://r2.example/upload',
            model_version: 'pipeline',
            parser_profile_id: 'mineru/v4-batch-pipeline-1',
        }),
        uploadResponse(200),
        jsonResponse(202, { job_id: 'job-moved', status: 'queued' }),
        jsonResponse(200, {
            job_id: 'job-moved',
            status: 'succeeded',
            model_version: 'pipeline',
            parser_profile_id: 'mineru/v4-batch-pipeline-1',
        }),
        jsonResponse(200, { result_url: 'https://r2.example/result.zip' }),
        archiveResponse(archive),
    ];
    const client = new MkteroConversionClient({
        fetch: async (url, options) => {
            if (options.method === 'POST' && url.endsWith('/conversions')) {
                created.push(JSON.parse(options.body));
            }
            return responses.shift();
        },
        sleep: async () => {},
    });

    const converted = await client.convert(convertOptions({
        sourceHash: 'd'.repeat(64),
        target: { routeId: 'route-1', modelVersion: 'pipeline', parserProfileId: 'mineru/v4-batch-pipeline-1' },
    }));

    assert.equal(created.length, 2);
    assert.equal(created[1].route_id, 'route-2');
    // The re-resolved target is the one the job reports. The job itself has no
    // route, so the route reference comes from the fresh resolve.
    assert.deepEqual(converted.target, {
        routeId: 'route-2',
        modelVersion: 'pipeline',
        parserProfileId: 'mineru/v4-batch-pipeline-1',
    });
});

test('a moved route changes the model the returned target names', async () => {
    const created = [];
    const responses = [
        jsonResponse(409, { error: { code: 'conversion_target_changed', message: 'moved' } }),
        jsonResponse(200, {
            route_id: 'route-2',
            model_version: 'pipeline',
            parser_profile_id: 'mineru/v4-batch-pipeline-1',
        }),
        jsonResponse(201, {
            job_id: 'job-moved',
            status: 'awaiting_upload',
            upload_url: 'https://r2.example/upload',
            model_version: 'pipeline',
            parser_profile_id: 'mineru/v4-batch-pipeline-1',
        }),
        uploadResponse(200),
        jsonResponse(202, { job_id: 'job-moved', status: 'queued' }),
        jsonResponse(200, {
            job_id: 'job-moved',
            status: 'succeeded',
            model_version: 'pipeline',
            parser_profile_id: 'mineru/v4-batch-pipeline-1',
        }),
        jsonResponse(200, { result_url: 'https://r2.example/result.zip' }),
        archiveResponse(resultArchive()),
    ];
    const client = new MkteroConversionClient({
        fetch: async (url, options) => {
            if (options.method === 'POST' && url.endsWith('/conversions')) {
                created.push(JSON.parse(options.body));
            }
            return responses.shift();
        },
        sleep: async () => {},
    });

    const converted = await client.convert(convertOptions({
        sourceHash: 'e'.repeat(64),
        target: { routeId: 'route-1', modelVersion: 'vlm', parserProfileId: 'mineru/v4-batch-vlm-1' },
    }));

    assert.equal(created[0].model_version, 'vlm');
    assert.equal(created[1].model_version, 'pipeline');
    assert.equal(converted.target.modelVersion, 'pipeline');
    assert.equal(converted.target.parserProfileId, 'mineru/v4-batch-pipeline-1');
});

test('a job snapshot without a route is accepted for the target it names', async () => {
    const client = new MkteroConversionClient({
        fetch: async (url, options) => {
            if (options.method === 'PUT') return uploadResponse(200);
            if (url.endsWith('/result-url')) {
                return jsonResponse(200, { result_url: 'https://r2.example/result.zip' });
            }
            if (url.endsWith('/result.zip')) return archiveResponse(resultArchive());
            if (url.endsWith('/complete')) return jsonResponse(202, { status: 'processing' });
            const status = options.method === 'POST' ? 201 : 200;
            return jsonResponse(status, {
                job_id: 'job-real',
                status: options.method === 'GET' ? 'succeeded' : 'awaiting_upload',
                ...(options.method === 'POST' ? { upload_url: 'https://r2.example/upload' } : {}),
                model_version: 'pipeline',
                parser_profile_id: 'mineru/v4-batch-pipeline-1',
            });
        },
        sleep: async () => {},
    });

    const converted = await client.convert(convertOptions({
        target: { routeId: 'route-1', modelVersion: 'pipeline', parserProfileId: 'mineru/v4-batch-pipeline-1' },
    }));

    assert.equal(converted.target.modelVersion, 'pipeline');
});

test('refuses a job the service parsed with a different model than requested', async () => {
    const responses = [
        jsonResponse(201, {
            job_id: 'job-wrong',
            status: 'awaiting_upload',
            upload_url: 'https://r2.example/upload',
            model_version: 'vlm',
            parser_profile_id: 'mineru/v4-batch-vlm-1',
        }),
    ];
    const client = new MkteroConversionClient({
        fetch: async () => responses.shift(),
        sleep: async () => {},
    });

    await assert.rejects(
        () => client.convert(convertOptions({
            target: { routeId: 'route-1', modelVersion: 'pipeline', parserProfileId: 'mineru/v4-batch-pipeline-1' },
        })),
        error => error.code === 'MKTERO_TARGET_MISMATCH'
    );
});

test('a job that names a model and a profile for the other model is refused', async () => {
    const client = new MkteroConversionClient({
        fetch: async () => jsonResponse(201, {
            job_id: 'job-mixed',
            status: 'awaiting_upload',
            upload_url: 'https://r2.example/upload',
            model_version: 'pipeline',
            parser_profile_id: 'mineru/v4-batch-vlm-1',
        }),
        sleep: async () => {},
    });

    await assert.rejects(
        () => client.convert(convertOptions({
            target: { routeId: 'route-1', modelVersion: 'pipeline', parserProfileId: 'mineru/v4-batch-pipeline-1' },
        })),
        error => error.code === 'MKTERO_TARGET_MISMATCH'
    );
});

test('an older service cannot confirm a pipeline target', async () => {
    const client = new MkteroConversionClient({
        fetch: async () => jsonResponse(201, {
            job_id: 'job-old',
            status: 'awaiting_upload',
            upload_url: 'https://r2.example/upload',
        }),
        sleep: async () => {},
    });

    await assert.rejects(
        () => client.convert(convertOptions({
            target: { routeId: 'route-1', modelVersion: 'pipeline', parserProfileId: 'mineru/v4-batch-pipeline-1' },
        })),
        error => error.code === 'MKTERO_TARGET_MISMATCH'
    );
});

function snapshotJob(status, extra = {}) {
    return {
        job_id: 'job-snapshot',
        status,
        model_version: 'pipeline',
        parser_profile_id: 'mineru/v4-batch-pipeline-1',
        ...extra,
    };
}

const PIPELINE_TARGET = Object.freeze({
    routeId: 'route-snapshot',
    modelVersion: 'pipeline',
    parserProfileId: 'mineru/v4-batch-pipeline-1',
});

test('every poll must repeat the snapshot the job was created under', async () => {
    const requests = [];
    const responses = [
        jsonResponse(201, snapshotJob('awaiting_upload', { upload_url: 'https://r2.example/upload' })),
        uploadResponse(200),
        jsonResponse(202, snapshotJob('queued')),
        // The same job answers with the other model on the next poll.
        jsonResponse(200, {
            job_id: 'job-snapshot',
            status: 'processing',
            model_version: 'vlm',
            parser_profile_id: 'mineru/v4-batch-vlm-1',
        }),
    ];
    const client = new MkteroConversionClient({
        fetch: async (url, options) => {
            requests.push({ url, options });
            return responses.shift();
        },
        sleep: async () => {},
    });

    await assert.rejects(
        () => client.convert(convertOptions({ target: PIPELINE_TARGET })),
        error => error.code === 'MKTERO_TARGET_MISMATCH'
    );
    assert.equal(requests.filter(request => request.url
        .endsWith('/api/v1/conversions/job-snapshot')
        && request.options.method === 'GET').length, 1);
});

test('a terminal poll that drops the snapshot is refused instead of guessed', async () => {
    const responses = [
        jsonResponse(201, snapshotJob('awaiting_upload', { upload_url: 'https://r2.example/upload' })),
        uploadResponse(200),
        jsonResponse(202, snapshotJob('queued')),
        jsonResponse(200, { job_id: 'job-snapshot', status: 'succeeded' }),
    ];
    const client = new MkteroConversionClient({
        fetch: async () => responses.shift(),
        sleep: async () => {},
    });

    await assert.rejects(
        () => client.convert(convertOptions({ target: PIPELINE_TARGET })),
        error => error.code === 'MKTERO_TARGET_MISMATCH'
    );
});

test('a terminal poll that names a mismatched profile is refused', async () => {
    const responses = [
        jsonResponse(201, snapshotJob('awaiting_upload', { upload_url: 'https://r2.example/upload' })),
        uploadResponse(200),
        jsonResponse(202, snapshotJob('queued')),
        jsonResponse(200, snapshotJob('succeeded', {
            parser_profile_id: 'mineru/v4-batch-vlm-1',
        })),
    ];
    const client = new MkteroConversionClient({
        fetch: async () => responses.shift(),
        sleep: async () => {},
    });

    await assert.rejects(
        () => client.convert(convertOptions({ target: PIPELINE_TARGET })),
        error => error.code === 'MKTERO_TARGET_MISMATCH'
    );
});

test('malformed snapshot fields on a poll are refused, not read as an older service', async () => {
    for (const extra of [
        { model_version: '', parser_profile_id: 'mineru/v4-batch-pipeline-1' },
        { model_version: 'pipeline', parser_profile_id: 'mineru/unknown-1' },
        { model_version: 'pipeline', parser_profile_id: '' },
    ]) {
        const responses = [
            jsonResponse(201, snapshotJob('awaiting_upload', { upload_url: 'https://r2.example/upload' })),
            uploadResponse(200),
            jsonResponse(202, snapshotJob('queued')),
            jsonResponse(200, snapshotJob('succeeded', extra)),
        ];
        const client = new MkteroConversionClient({
            fetch: async () => responses.shift(),
            sleep: async () => {},
        });
        await assert.rejects(
            () => client.convert(convertOptions({ target: PIPELINE_TARGET })),
            error => error.code === 'MKTERO_TARGET_MISMATCH'
        );
    }
});

test('present but empty or non-string snapshot fields cannot use the legacy VLM exemption', async () => {
    for (const fields of [
        { model_version: null, parser_profile_id: null },
        { model_version: '', parser_profile_id: '' },
        { model_version: 1, parser_profile_id: 2 },
    ]) {
        const requests = [];
        const client = new MkteroConversionClient({
            fetch: async (url, options) => {
                requests.push({ url, options });
                return jsonResponse(200, {
                    job_id: 'job-malformed-snapshot', status: 'succeeded', ...fields,
                });
            },
            sleep: async () => {},
        });
        await assert.rejects(client.convert(convertOptions({
            target: { routeId: 'route-vlm', modelVersion: 'vlm', parserProfileId: 'mineru/v4-batch-vlm-1' },
        })), error => error.code === 'MKTERO_TARGET_MISMATCH');
        assert.equal(requests.some(request => request.url.endsWith('/result-url')), false);
    }
});

test('a create answer that names a different model is refused', async () => {
    // Create is asked for one target. A service that answers with another model
    // has ignored that request; the result would then be filed under the wrong
    // identity, so it is refused rather than silently relabelled. A route that
    // really moved is reported as 409 and re-resolved instead.
    const client = new MkteroConversionClient({
        fetch: async () => jsonResponse(201, {
            job_id: 'job-other',
            status: 'succeeded',
            model_version: 'vlm',
            parser_profile_id: 'mineru/v4-batch-vlm-1',
        }),
        sleep: async () => {},
    });

    await assert.rejects(
        () => client.convert(convertOptions({
            sourceHash: 'f'.repeat(64),
            target: PIPELINE_TARGET,
        })),
        error => error.code === 'MKTERO_TARGET_MISMATCH'
    );
});

test('an idempotent replay of an accepted job keeps that job snapshot and cancels nothing', async () => {
    // The service fingerprints the whole create request, target included, so a
    // replayed job was accepted for exactly the target being asked for again.
    // The client must accept that report, label the download with it, and not
    // send a DELETE for work the service still considers usable.
    const requests = [];
    const replayedJob = {
        job_id: 'job-replay',
        status: 'succeeded',
        model_version: 'pipeline',
        parser_profile_id: 'mineru/v4-batch-pipeline-1',
    };
    const responses = [
        jsonResponse(201, replayedJob),
        jsonResponse(200, { result_url: 'https://r2.example/result.zip' }),
        archiveResponse(resultArchive()),
    ];
    const client = new MkteroConversionClient({
        fetch: async (url, options) => {
            requests.push({ url, options });
            return responses.shift();
        },
        sleep: async () => {},
    });

    const converted = await client.convert(convertOptions({
        sourceHash: 'a'.repeat(64),
        target: PIPELINE_TARGET,
        idempotencyKey: 'replay-key-1',
    }));

    assert.equal(converted.target.modelVersion, 'pipeline');
    assert.equal(converted.target.parserProfileId, 'mineru/v4-batch-pipeline-1');
    assert.equal(requests[0].options.headers['Idempotency-Key'], 'replay-key-1');
    assert.equal(requests.filter(request => request.options.method === 'DELETE').length, 0);
    assert.equal(requests.filter(request => request.options.method === 'PUT').length, 0,
        'an accepted job already holds the PDF');
});

test('a job whose snapshot contradicts the requested target is cancelled, not relabelled', async () => {
    // The only way a create answer can disagree is a service that ignored the
    // requested target. Caching its ZIP under the requested model would file a
    // pipeline result under the vlm identity, so the job is refused and its
    // own record released.
    const requests = [];
    const responses = [
        jsonResponse(201, {
            job_id: 'job-contradict',
            status: 'awaiting_upload',
            upload_url: 'https://r2.example/upload',
            model_version: 'vlm',
            parser_profile_id: 'mineru/v4-batch-vlm-1',
        }),
        jsonResponse(200, { job_id: 'job-contradict', status: 'failed' }),
    ];
    const client = new MkteroConversionClient({
        fetch: async (url, options) => {
            requests.push({ url, options });
            return responses.shift();
        },
        sleep: async () => {},
    });

    await assert.rejects(
        () => client.convert(convertOptions({
            sourceHash: 'b'.repeat(64),
            target: PIPELINE_TARGET,
        })),
        error => error.code === 'MKTERO_TARGET_MISMATCH'
    );
    assert.equal(requests.filter(request => request.options.method === 'PUT').length, 0);
    // Cancelling is best effort and runs after the caller already failed.
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (requests.some(request => request.options.method === 'DELETE')) break;
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(requests.filter(request => request.options.method === 'DELETE').length, 1);
});
