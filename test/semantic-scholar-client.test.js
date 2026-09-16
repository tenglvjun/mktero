import test from 'node:test';
import assert from 'node:assert/strict';

import { SemanticScholarClient } from '../src/citations/semantic-scholar-client.js';

function jsonResponse(value, status = 200, headers = {}) {
    return new Response(JSON.stringify(value), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...headers,
        },
    });
}

test('supports focused papers with either DOI or arXiv identifiers', () => {
    const client = new SemanticScholarClient({ fetch: async () => jsonResponse({}) });

    assert.equal(client.supports({ doi: '10.1000/a' }), true);
    assert.equal(client.supports({ arxivID: '2401.12345' }), true);
    assert.equal(client.supports({ title: 'Title only' }), false);
});

test('resolves an open-access PDF using only the normalized DOI', async () => {
    let request;
    const client = new SemanticScholarClient({
        fetch: async (url, options) => {
            request = { url: String(url), options };
            return jsonResponse({
                openAccessPdf: { url: 'https://repository.example/paper.pdf#page=1' },
                externalIds: { DOI: '10.1000/test' },
            });
        },
    });

    assert.equal(await client.resolveOpenAccessPDF({
        doi: ' DOI:10.1000/TEST ',
        apiKey: 'provider-secret',
    }), 'https://repository.example/paper.pdf');
    assert.match(request.url, /fields=.*openAccessPdf/);
    assert.match(request.url, /DOI%3A10\.1000%2Ftest/);
    assert.equal(request.options.headers['x-api-key'], 'provider-secret');
    assert.doesNotMatch(request.url, /reference text|LOCAL-KEY/i);
});

test('treats missing or malformed open-access PDF fields as a normal miss', async () => {
    const responses = [
        jsonResponse({}, 404),
        jsonResponse({ openAccessPdf: { url: 'javascript:alert(1)' } }),
    ];
    const client = new SemanticScholarClient({
        fetch: async () => responses.shift(),
    });

    assert.equal(await client.resolveOpenAccessPDF({ doi: '10.1000/missing' }), null);
    assert.equal(await client.resolveOpenAccessPDF({ doi: '10.1000/unsafe' }), '');
});

test('enforces request timeouts for open-access lookup', async () => {
    const timedOut = new SemanticScholarClient({
        maxRetryAttempts: 1,
        setTimer(callback) {
            callback();
            return 1;
        },
        clearTimer() {},
        fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
            const abort = () => reject(new DOMException('Aborted', 'AbortError'));
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
        }),
    });
    await assert.rejects(
        () => timedOut.resolveOpenAccessPDF({ doi: '10.1000/timeout' }),
        error => error.code === 'S2_REQUEST_TIMEOUT'
    );
});

test('resolves DOI and arXiv identifiers in batches of at most 500', async () => {
    const requests = [];
    const client = new SemanticScholarClient({
        fetch: async (url, options) => {
            const body = JSON.parse(options.body);
            requests.push({ url, options, body });
            return jsonResponse(body.ids.map((id, index) => ({
                paperId: `s2${requests.length}-${index}`,
                title: id,
                year: 2024,
                externalIds: id.startsWith('DOI:')
                    ? { DOI: id.slice(4) }
                    : { ArXiv: id.slice(6) },
            })));
        },
    });
    const papers = Array.from({ length: 501 }, (_, index) => ({
        id: `1:${index}`,
        doi: `10.1000/${index}`,
        arxivID: '',
    }));

    const resolved = await client.resolvePapers({
        papers,
        apiKey: ' secret-key ',
    });

    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.ids.length, 500);
    assert.equal(requests[1].body.ids.length, 1);
    assert.ok(requests.flatMap(request => request.body.ids)
        .every(id => id.startsWith('DOI:')));
    assert.equal(requests[0].options.headers['x-api-key'], 'secret-key');
    assert.equal(resolved.size, 501);
    assert.equal(resolved.get('1:500').paperID, 's22-0');
});

test('falls back from a missing DOI record to arXiv without sending local IDs', async () => {
    const identifiers = [];
    const client = new SemanticScholarClient({
        fetch: async (url, options) => {
            const body = JSON.parse(options.body);
            identifiers.push(...body.ids);
            return jsonResponse(body.ids.map(id => id.startsWith('ARXIV:')
                ? {
                    paperId: 's2-arxiv',
                    title: 'Resolved by arXiv',
                    externalIds: { ArXiv: id.slice(6) },
                }
                : null));
        },
    });

    const resolved = await client.resolvePapers({
        papers: [{
            id: '7:LOCAL-KEY',
            doi: '10.1000/missing',
            arxivID: '2401.12345',
        }],
    });

    assert.deepEqual(identifiers, [
        'DOI:10.1000/missing',
        'ARXIV:2401.12345',
    ]);
    assert.equal(resolved.get('7:LOCAL-KEY').paperID, 's2-arxiv');
    assert.ok(!identifiers.some(value => value.includes('LOCAL-KEY')));
});

test('fetches references by DOI then falls back to arXiv after a 404', async () => {
    const requests = [];
    const client = new SemanticScholarClient({
        fetch: async url => {
            requests.push(url);
            if (requests.length === 1) return jsonResponse({}, 404);
            return jsonResponse({
                data: [{
                    citedPaper: {
                        paperId: 'cited-1',
                        title: 'Cited paper',
                        year: 2023,
                        externalIds: { DOI: '10.1000/CITED' },
                        authors: [{ name: 'Author' }],
                    },
                }],
                next: null,
            });
        },
    });

    const result = await client.fetchReferences({
        doi: '10.1000/source',
        arxivID: '2401.00001',
    });

    assert.match(requests[0], /paper\/DOI%3A10\.1000%2Fsource\/references/);
    assert.match(requests[1], /paper\/ARXIV%3A2401\.00001\/references/);
    assert.deepEqual(result.references, [{
        paperID: 'cited-1',
        title: 'Cited paper',
        year: 2023,
        doi: '10.1000/cited',
        arxivID: '',
        authors: ['Author'],
    }]);
    assert.equal(result.status, 'fetched');
    assert.equal(result.truncated, false);
});

test('treats a final 404 and a successful empty result as unindexed', async () => {
    const responses = [jsonResponse({}, 404), jsonResponse({ data: [], next: null })];
    const client = new SemanticScholarClient({
        fetch: async () => responses.shift(),
        now: () => 4_000,
    });

    assert.deepEqual(
        await client.fetchReferences({ doi: '10.1000/missing' }),
        {
            status: 'unindexed',
            references: [],
            truncated: false,
            fetchedAt: 4_000,
        }
    );
    assert.equal(
        (await client.fetchReferences({ doi: '10.1000/empty' })).status,
        'unindexed'
    );
});

test('caps references at 1000 and marks a remaining page as truncated', async () => {
    const client = new SemanticScholarClient({
        fetch: async () => jsonResponse({
            data: Array.from({ length: 1001 }, (_, index) => ({
                citedPaper: {
                    paperId: `paper${index}`,
                    title: `Paper ${index}`,
                },
            })),
            next: 1000,
        }),
    });

    const result = await client.fetchReferences({ doi: '10.1000/source' });

    assert.equal(result.references.length, 1000);
    assert.equal(result.truncated, true);
});

test('retries rate limits with bounded Retry-After and does not expose secrets', async () => {
    const delays = [];
    const retries = [];
    let attempts = 0;
    const client = new SemanticScholarClient({
        fetch: async () => {
            attempts++;
            if (attempts < 3) {
                return jsonResponse({}, 429, { 'Retry-After': '2' });
            }
            return jsonResponse({ data: [], next: null });
        },
        sleep: async milliseconds => delays.push(milliseconds),
    });

    const result = await client.fetchReferences({
        doi: '10.1000/private',
        apiKey: 'private-key',
        onRetry: retry => retries.push(retry),
    });

    assert.equal(result.status, 'unindexed');
    assert.deepEqual(delays, [2_000, 2_000]);
    assert.deepEqual(retries, [{
        code: 'rate-limited',
        attempt: 1,
        retryAfterMs: 2_000,
    }, {
        code: 'rate-limited',
        attempt: 2,
        retryAfterMs: 2_000,
    }]);
    assert.equal(attempts, 3);
});

test('retries transient network and server failures with exponential backoff', async () => {
    const delays = [];
    let attempts = 0;
    const client = new SemanticScholarClient({
        fetch: async () => {
            attempts++;
            if (attempts === 1) throw new TypeError('transport details');
            if (attempts === 2) return jsonResponse({}, 503);
            return jsonResponse({ data: [], next: null });
        },
        sleep: async milliseconds => delays.push(milliseconds),
        retryBaseDelayMs: 25,
    });

    const result = await client.fetchReferences({ doi: '10.1000/source' });

    assert.equal(result.status, 'unindexed');
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [25, 50]);
});

test('aborts while waiting for a retry backoff', async () => {
    const controller = new AbortController();
    let notifySleepStarted;
    const sleepStarted = new Promise(resolve => { notifySleepStarted = resolve; });
    let attempts = 0;
    const client = new SemanticScholarClient({
        fetch: async () => {
            attempts++;
            return jsonResponse({}, 503);
        },
        sleep: async () => {
            notifySleepStarted();
            return new Promise(() => {});
        },
    });
    const pending = client.fetchReferences({
        doi: '10.1000/source',
        signal: controller.signal,
    });
    await sleepStarted;

    controller.abort();

    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.equal(attempts, 1);
});

test('rejects malformed JSON and keeps provider errors free of secrets', async () => {
    const malformed = new SemanticScholarClient({
        fetch: async () => new Response('{bad json', { status: 200 }),
        maxRetryAttempts: 1,
    });
    await assert.rejects(
        () => malformed.fetchReferences({ doi: '10.1000/source' }),
        error => error.code === 'S2_INVALID_RESPONSE'
    );

    const denied = new SemanticScholarClient({
        fetch: async () => jsonResponse({ secret: 'raw-response' }, 401),
        maxRetryAttempts: 1,
    });
    await assert.rejects(
        () => denied.fetchReferences({
            doi: '10.1000/private-identifier',
            apiKey: 'private-api-key',
        }),
        error => {
            const exposed = `${error.message}\n${error.stack || ''}`;
            assert.equal(error.code, 'S2_HTTP_ERROR');
            assert.equal(error.status, 401);
            assert.doesNotMatch(exposed, /private-identifier/);
            assert.doesNotMatch(exposed, /private-api-key/);
            assert.doesNotMatch(exposed, /raw-response/);
            return true;
        }
    );
});

test('aborts a pending request through the caller signal', async () => {
    const controller = new AbortController();
    const client = new SemanticScholarClient({
        fetch: async (_url, { signal }) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
                reject(new DOMException('Aborted', 'AbortError'));
            }, { once: true });
        }),
    });
    const pending = client.fetchReferences({
        doi: '10.1000/source',
        signal: controller.signal,
    });

    controller.abort();

    await assert.rejects(pending, error => error.name === 'AbortError');
});

test('aborts while a streaming response body is pending', async () => {
    const controller = new AbortController();
    let cancelled = 0;
    const client = new SemanticScholarClient({
        fetch: async () => ({
            ok: true,
            status: 200,
            headers: { get: () => null },
            body: {
                getReader: () => ({
                    read: () => new Promise(() => {}),
                    cancel: () => { cancelled++; },
                }),
            },
        }),
    });
    const pending = client.fetchReferences({
        doi: '10.1000/source',
        signal: controller.signal,
    });
    await Promise.resolve();

    controller.abort();

    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.equal(cancelled, 1);
});

test('keeps the timeout active while reading the response body', async () => {
    let timeoutCallback;
    let cancelled = 0;
    const client = new SemanticScholarClient({
        maxRetryAttempts: 1,
        setTimer(callback) {
            timeoutCallback = callback;
            return 1;
        },
        clearTimer() {},
        fetch: async () => ({
            ok: true,
            status: 200,
            headers: { get: () => null },
            body: {
                getReader: () => ({
                    read: () => new Promise(() => {}),
                    cancel: () => { cancelled++; },
                }),
            },
        }),
    });
    const pending = client.fetchReferences({ doi: '10.1000/source' });
    await Promise.resolve();
    await Promise.resolve();

    timeoutCallback();

    await assert.rejects(
        pending,
        error => error.code === 'S2_REQUEST_TIMEOUT'
    );
    assert.equal(cancelled, 1);
});
