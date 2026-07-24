import test from 'node:test';
import assert from 'node:assert/strict';
import { MinerUClient } from '../src/mineru/mineru-client.js';

function jsonResponse(body, status = 200, headers = undefined) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers,
        json: async () => body,
    };
}

test('uploads a local PDF and returns MinerU Markdown', async () => {
    const requests = [];
    const responses = [
        jsonResponse({
            code: 0,
            data: {
                batch_id: 'batch-1',
                file_urls: ['https://upload.example/paper'],
            },
        }),
        { ok: true, status: 200 },
        jsonResponse({
            code: 0,
            data: {
                extract_result: [{
                    data_id: 'zotero-42',
                    file_name: 'paper.pdf',
                    state: 'running',
                    extract_progress: {
                        extracted_pages: 2,
                        total_pages: 4,
                    },
                }],
            },
        }),
        jsonResponse({
            code: 0,
            data: {
                extract_result: [{
                    data_id: 'zotero-42',
                    file_name: 'paper.pdf',
                    state: 'done',
                    full_zip_url: 'https://download.example/result.zip',
                }],
            },
        }),
        {
            ok: true,
            status: 200,
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        },
    ];
    const fetch = async (url, options = {}) => {
        requests.push({ url, options });
        return responses.shift();
    };
    const progress = [];
    const sleeps = [];
    const client = new MinerUClient({
        fetch,
        sleep: async milliseconds => sleeps.push(milliseconds),
        extractMarkdownFromZip: bytes => {
            assert.deepEqual([...bytes], [1, 2, 3]);
            return '# Parsed by MinerU';
        },
        pollIntervalMs: 25,
    });

    const result = await client.parse({
        apiKey: 'secret-token',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([37, 80, 68, 70]),
        dataID: 'zotero-42',
        onProgress: value => progress.push(value),
    });

    assert.equal(result.markdown, '# Parsed by MinerU');
    assert.equal(result.extractedPages, 4);
    assert.equal(result.totalPages, 4);
    assert.deepEqual(sleeps, [25]);
    assert.equal(requests[0].url, 'https://mineru.net/api/v4/file-urls/batch');
    assert.equal(requests[0].options.headers.Authorization, 'Bearer secret-token');
    assert.deepEqual(JSON.parse(requests[0].options.body), {
        files: [{
            name: 'paper.pdf',
            data_id: 'zotero-42',
            is_ocr: true,
        }],
        model_version: 'vlm',
        enable_formula: true,
        enable_table: true,
    });
    assert.equal(requests[1].url, 'https://upload.example/paper');
    assert.equal(requests[1].options.method, 'PUT');
    assert.equal(requests[1].options.headers, undefined);
    assert.equal(
        requests[2].url,
        'https://mineru.net/api/v4/extract-results/batch/batch-1'
    );
    assert.equal(requests[2].options.headers.Authorization, 'Bearer secret-token');
    assert.equal(requests[4].url, 'https://download.example/result.zip');
    assert.equal(requests[4].options.headers, undefined);
    assert.equal(progress.at(-1), 100);
    assert.ok(progress.some(value => value > 50 && value < 100));
});

test('reports MinerU task failures without polling forever', async () => {
    const responses = [
        jsonResponse({
            code: 0,
            data: { batch_id: 'batch-1', file_urls: ['https://upload.example/paper'] },
        }),
        { ok: true, status: 200 },
        jsonResponse({
            code: 0,
            data: {
                extract_result: [{
                    data_id: 'zotero-42',
                    state: 'failed',
                    err_msg: 'page limit exceeded',
                }],
            },
        }),
    ];
    const client = new MinerUClient({
        fetch: async () => responses.shift(),
        sleep: async () => {},
        extractMarkdownFromZip: () => '',
    });

    await assert.rejects(
        () => client.parse({
            apiKey: 'secret-token',
            fileName: 'paper.pdf',
            fileData: new Uint8Array([1]),
            dataID: 'zotero-42',
        }),
        /page limit exceeded/
    );
});

test('rejects an invalid MinerU API token with an actionable error', async () => {
    const client = new MinerUClient({
        fetch: async () => jsonResponse({ code: 'A0202', msg: 'Token error' }, 401),
        sleep: async () => {},
        extractMarkdownFromZip: () => '',
    });

    await assert.rejects(
        () => client.parse({
            apiKey: 'bad-token',
            fileName: 'paper.pdf',
            fileData: new Uint8Array([1]),
            dataID: 'zotero-42',
        }),
        /API Token is invalid/
    );
});

test('retries transient polling failures without creating a second task', async () => {
    const requests = [];
    const sleeps = [];
    const responses = [
        jsonResponse({
            code: 0,
            data: { batch_id: 'batch-1', file_urls: ['https://upload.example/paper'] },
        }),
        { ok: true, status: 200 },
        jsonResponse(
            { code: 500, msg: 'try later' },
            503,
            { get: name => name === 'Retry-After' ? '0' : null }
        ),
        jsonResponse({
            code: 0,
            data: {
                extract_result: [{
                    data_id: 'zotero-42',
                    state: 'done',
                    full_zip_url: 'https://download.example/result.zip',
                }],
            },
        }),
        {
            ok: true,
            status: 200,
            arrayBuffer: async () => new Uint8Array([1]).buffer,
        },
    ];
    const client = new MinerUClient({
        fetch: async (url, options = {}) => {
            requests.push({ url, options });
            return responses.shift();
        },
        sleep: async milliseconds => sleeps.push(milliseconds),
        extractMarkdownFromZip: () => '# Complete',
    });

    const result = await client.parse({
        apiKey: 'secret-token',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1]),
        dataID: 'zotero-42',
    });

    assert.equal(result.markdown, '# Complete');
    assert.deepEqual(sleeps, [0]);
    assert.equal(
        requests.filter(request => request.url.endsWith('/file-urls/batch')).length,
        1
    );
    assert.equal(
        requests.filter(request => request.url.includes('/extract-results/batch/')).length,
        2
    );
});

test('retries MinerU application-level temporary errors while polling', async () => {
    const responses = [
        jsonResponse({
            code: 0,
            data: { batch_id: 'batch-1', file_urls: ['https://upload.example/paper'] },
        }),
        { ok: true, status: 200 },
        jsonResponse({ code: -10001, msg: 'please try again later' }),
        jsonResponse({
            code: 0,
            data: {
                extract_result: [{
                    data_id: 'zotero-42',
                    state: 'done',
                    full_zip_url: 'https://download.example/result.zip',
                }],
            },
        }),
        {
            ok: true,
            status: 200,
            arrayBuffer: async () => new Uint8Array([1]).buffer,
        },
    ];
    const sleeps = [];
    const client = new MinerUClient({
        fetch: async () => responses.shift(),
        sleep: async milliseconds => sleeps.push(milliseconds),
        retryBaseDelayMs: 7,
        extractMarkdownFromZip: () => '# Complete',
    });

    await client.parse({
        apiKey: 'secret-token',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1]),
        dataID: 'zotero-42',
    });

    assert.deepEqual(sleeps, [7]);
});

test('cancels an active MinerU request through the operation signal', async () => {
    const controller = new AbortController();
    const client = new MinerUClient({
        fetch: async (_url, options) => new Promise((_, reject) => {
            options.signal.addEventListener('abort', () => {
                reject(options.signal.reason);
            }, { once: true });
        }),
        extractMarkdownFromZip: () => '',
    });
    const conversion = client.parse({
        apiKey: 'secret-token',
        fileName: 'paper.pdf',
        fileData: new Uint8Array([1]),
        dataID: 'zotero-42',
        signal: controller.signal,
    });

    controller.abort();

    await assert.rejects(conversion, error => error.name === 'AbortError');
});

test('times out a stalled MinerU request', async () => {
    const client = new MinerUClient({
        fetch: async (_url, options) => new Promise((_, reject) => {
            options.signal.addEventListener('abort', () => {
                reject(options.signal.reason);
            }, { once: true });
        }),
        requestTimeoutMs: 5,
        extractMarkdownFromZip: () => '',
    });

    await assert.rejects(
        () => client.parse({
            apiKey: 'secret-token',
            fileName: 'paper.pdf',
            fileData: new Uint8Array([1]),
            dataID: 'zotero-42',
        }),
        error => error.code === 'MINERU_REQUEST_TIMEOUT'
    );
});

test('rejects a result archive larger than the configured limit', async () => {
    const responses = [
        jsonResponse({
            code: 0,
            data: { batch_id: 'batch-1', file_urls: ['https://upload.example/paper'] },
        }),
        { ok: true, status: 200 },
        jsonResponse({
            code: 0,
            data: {
                extract_result: [{
                    data_id: 'zotero-42',
                    state: 'done',
                    full_zip_url: 'https://download.example/result.zip',
                }],
            },
        }),
        {
            ok: true,
            status: 200,
            headers: { get: name => name === 'Content-Length' ? '3' : null },
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        },
    ];
    const client = new MinerUClient({
        fetch: async () => responses.shift(),
        sleep: async () => {},
        maxArchiveBytes: 2,
        extractMarkdownFromZip: () => assert.fail('oversized archive must not be extracted'),
    });

    await assert.rejects(
        () => client.parse({
            apiKey: 'secret-token',
            fileName: 'paper.pdf',
            fileData: new Uint8Array([1]),
            dataID: 'zotero-42',
        }),
        error => error.code === 'MINERU_ARCHIVE_TOO_LARGE'
    );
});

test('uses an injected AbortController when the calling sandbox has none', async t => {
    const NativeAbortController = globalThis.AbortController;
    delete globalThis.AbortController;
    t.after(() => { globalThis.AbortController = NativeAbortController; });
    let controllerCalls = 0;
    const client = new MinerUClient({
        fetch: async () => jsonResponse({ code: 'A0202', msg: 'Token error' }, 401),
        createAbortController: () => {
            controllerCalls++;
            return new NativeAbortController();
        },
        extractMarkdownFromZip: () => '',
    });

    await assert.rejects(
        () => client.parse({
            apiKey: 'bad-token',
            fileName: 'paper.pdf',
            fileData: new Uint8Array([1]),
            dataID: 'zotero-42',
        }),
        /API Token is invalid/
    );
    assert.equal(controllerCalls, 1);
});
