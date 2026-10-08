import test from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { sha256Hex } from '../src/core/sha256.js';
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

test('reports a rejected PDF upload with an actionable cause', async () => {
    const responses = [
        jsonResponse(201, {
            job_id: 'job-4',
            status: 'awaiting_upload',
            upload_url: 'https://r2.example/upload',
        }),
        {
            ok: false,
            status: 403,
            headers: { get: () => null },
            async arrayBuffer() {
                return new ArrayBuffer(0);
            },
        },
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
        error => error.code === 'MKTERO_UPLOAD_FAILED'
            && error.status === 403
            && error.stage === 'upload'
    );
});

test('keeps the transport failure and stage when the upload cannot connect', async () => {
    const responses = [
        jsonResponse(201, {
            job_id: 'job-5',
            status: 'awaiting_upload',
            upload_url: 'https://r2.example/upload',
        }),
    ];
    const transport = new TypeError('NetworkError when attempting to fetch resource');
    const client = new MkteroConversionClient({
        fetch: async () => {
            const next = responses.shift();
            if (next) return next;
            throw transport;
        },
        sleep: async () => {},
    });

    await assert.rejects(
        client.convert({
            apiBase: API_BASE,
            getAccessToken: () => 'access-token',
            fileName: 'paper.pdf',
            fileData: PDF_BYTES,
        }),
        error => error.code === 'MKTERO_NETWORK_ERROR'
            && error.stage === 'upload'
            && error.requestLabel === 'PDF upload'
            && error.cause === transport
    );
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
        fetch: async () => responses.shift(),
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
    );
});
