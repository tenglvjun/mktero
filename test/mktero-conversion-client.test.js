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

function resultArchive() {
    return zipSync({
        'result/full.md': strToU8('# Converted\n\nBody text.'),
        'result/images/figure.png': createTestPNG(),
    });
}

test('converts through the hosted service and decodes the MinerU archive', async () => {
    const requests = [];
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
