import test from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { MinerULocalClient } from '../src/mineru/local-client.js';

const BASE = 'http://127.0.0.1:8000';
const PDF = new Uint8Array([37, 80, 68, 70]);

function archive() {
    return zipSync({
        'markdown.md': strToU8('# Parsed locally\n'),
        'middle_json.json': strToU8('{"schema":"docvortex.middle"}'),
        'images/a.png': strToU8('png'),
    });
}

function headerValue(headers, name) {
    if (!headers) return undefined;
    const key = Object.keys(headers).find(item => item.toLowerCase() === name);
    return key ? headers[key] : undefined;
}

function createFetch({
    apiKey = '',
    uploadURL = '/v1/uploads/upload-1/content',
    jobStatus = 'completed',
    tiers = ['standard'],
    redirectDownload = false,
} = {}) {
    const requests = [];
    let polls = 0;
    const fetch = async (url, options = {}) => {
        requests.push({
            url: String(url),
            method: options.method || 'GET',
            headers: options.headers || {},
            body: options.body,
        });
        const authorization = headerValue(options.headers, 'authorization');
        const sameOrigin = String(url).startsWith(BASE);
        if (apiKey && sameOrigin && authorization !== `Bearer ${apiKey}`) {
            return { ok: false, status: 401, json: async () => ({}) };
        }
        if (String(url).endsWith('/v1/tiers')) {
            return json({ data: tiers.map(id => ({ id })) });
        }
        if (String(url).endsWith('/v1/uploads') && options.method === 'POST') {
            return json({
                id: 'upload-1',
                status: 'pending',
                upload_url: uploadURL,
                upload_method: 'PUT',
                upload_headers: { 'Content-Type': 'application/pdf' },
            });
        }
        if (options.method === 'PUT') return { ok: true, status: 200 };
        if (String(url).endsWith('/complete')) {
            return json({ status: 'completed', file: { id: 'file-1' } });
        }
        if (String(url).endsWith('/v1/parse/jobs') && options.method === 'POST') {
            return json({ job_id: 'job-1', status: 'queued' }, 202);
        }
        if (String(url).includes('/v1/parse/jobs/job-1') && options.method === 'DELETE') {
            return json({ status: 'canceled' });
        }
        if (String(url).includes('/v1/parse/jobs/job-1')) {
            polls += 1;
            const status = polls === 1 && jobStatus === 'completed' ? 'running' : jobStatus;
            return json({
                job_id: 'job-1',
                status,
                progress: { completed: status === 'completed' ? 1 : 0, total: 1 },
                files: [{
                    output_files: {
                        zip: { file_id: 'file-zip' },
                    },
                }],
            });
        }
        if (String(url).includes('/v1/files/file-zip/content')) {
            if (redirectDownload) {
                return {
                    ok: false,
                    status: 302,
                    headers: { get: name => (name.toLowerCase() === 'location'
                        ? 'https://files.example/result.zip?sig=secret'
                        : null) },
                };
            }
            return {
                ok: true,
                status: 200,
                arrayBuffer: async () => archive().buffer,
            };
        }
        if (String(url).startsWith('https://files.example/')) {
            return {
                ok: true,
                status: 200,
                arrayBuffer: async () => archive().buffer,
            };
        }
        return { ok: false, status: 404, json: async () => ({}) };
    };
    return { fetch, requests };
}

function json(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    };
}

function client(fetch, overrides = {}) {
    return new MinerULocalClient({
        fetch,
        sleep: async () => {},
        pollIntervalMs: 0,
        createAbortController: () => new AbortController(),
        ...overrides,
    });
}

test('uploads PDF bytes to a local MinerU service and reads markdown.md from the zip', async () => {
    const server = createFetch({ apiKey: 'local-secret' });
    const result = await client(server.fetch).parse({
        apiBase: `${BASE}/`,
        apiKey: 'local-secret',
        fileName: 'nested/paper.pdf',
        fileData: PDF,
    });

    assert.equal(result.markdown, '# Parsed locally\n');
    assert.equal(result.detailedLayout, undefined);
    const upload = server.requests.find(request => request.method === 'PUT');
    assert.equal(upload.url, `${BASE}/v1/uploads/upload-1/content`);
    assert.equal(headerValue(upload.headers, 'authorization'), 'Bearer local-secret');
    const created = server.requests.find(request => request.url.endsWith('/v1/uploads'));
    const body = JSON.parse(created.body);
    assert.equal(body.filename, 'paper.pdf');
    assert.equal(body.purpose, 'parse');
    assert.equal(body.bytes, PDF.byteLength);
    assert.match(body.sha256sum, /^[0-9a-f]{64}$/);
    const job = server.requests.find(request => (
        request.method === 'POST' && request.url.endsWith('/v1/parse/jobs')
    ));
    assert.deepEqual(JSON.parse(job.body).output_formats, ['zip']);
    assert.equal(JSON.parse(job.body).tier, 'standard');
    assert.equal(
        server.requests.some(request => request.url.includes('local-secret')),
        false
    );
});

test('does not attach the MinerU API key to a cross-origin upload URL', async () => {
    const server = createFetch({
        apiKey: 'local-secret',
        uploadURL: 'https://oss.example/upload?sig=secret',
    });
    await client(server.fetch).parse({
        apiBase: BASE,
        apiKey: 'local-secret',
        fileName: 'paper.pdf',
        fileData: PDF,
    });

    const upload = server.requests.find(request => request.method === 'PUT');
    assert.equal(upload.url, 'https://oss.example/upload?sig=secret');
    assert.equal(headerValue(upload.headers, 'authorization'), undefined);
    assert.equal(headerValue(upload.headers, 'content-type'), 'application/pdf');
});

test('follows a result redirect without sending the API key to the other origin', async () => {
    const server = createFetch({ apiKey: 'local-secret', redirectDownload: true });
    await client(server.fetch).parse({
        apiBase: BASE,
        apiKey: 'local-secret',
        fileName: 'paper.pdf',
        fileData: PDF,
    });

    const download = server.requests.find(request => request.url.startsWith('https://files.example/'));
    assert.equal(headerValue(download.headers, 'authorization'), undefined);
    assert.equal(download.url.includes('sig=secret'), true);
});

test('reports an invalid local address and a missing tier without leaking the address', async () => {
    const server = createFetch();
    await assert.rejects(
        () => client(server.fetch).parse({
            apiBase: 'http://8.8.8.8:8000/?token=secret',
            fileName: 'paper.pdf',
            fileData: PDF,
        }),
        error => error.code === 'MINERU_LOCAL_ENDPOINT_INVALID'
            && !String(error.message).includes('secret')
            && server.requests.length === 0
    );
    await assert.rejects(
        () => client(createFetch({ tiers: ['flash'] }).fetch).parse({
            apiBase: BASE,
            fileName: 'paper.pdf',
            fileData: PDF,
        }),
        error => error.code === 'MINERU_LOCAL_TIER_UNAVAILABLE'
    );
});

test('cancels the local job when parsing is aborted', async () => {
    const controller = new AbortController();
    const server = createFetch({ jobStatus: 'running' });
    const originalFetch = server.fetch;
    const fetch = async (url, options) => {
        if (String(url).includes('/v1/parse/jobs/job-1') && options?.method !== 'DELETE') {
            controller.abort();
        }
        return originalFetch(url, options);
    };
    await assert.rejects(
        client(fetch).parse({
            apiBase: BASE,
            fileName: 'paper.pdf',
            fileData: PDF,
            signal: controller.signal,
        }),
        error => error.name === 'AbortError'
    );
    assert.equal(
        server.requests.some(request => (
            request.method === 'DELETE' && request.url.endsWith('/v1/parse/jobs/job-1')
        )),
        true
    );
});
