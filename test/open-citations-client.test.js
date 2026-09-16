import test from 'node:test';
import assert from 'node:assert/strict';

import { OpenCitationsClient } from '../src/citations/open-citations-client.js';

test('fetches DOI references without sending local paper metadata', async () => {
    const requests = [];
    const client = new OpenCitationsClient({
        now: () => 2_000,
        fetch: async (url, options) => {
            requests.push({ url, options });
            return jsonResponse([{
                cited: 'omid:br/1 doi:10.1000/TARGET pmid:1',
            }, {
                cited: 'coci => omid:br/1 doi:10.1000/target',
            }, {
                cited: 'omid:br/2',
            }]);
        },
    });

    assert.equal(client.supports({ doi: '10.1000/source' }), true);
    assert.equal(client.supports({ arxivID: '2401.12345' }), false);
    const result = await client.fetchReferences({
        doi: ' DOI:10.1000/SOURCE ',
        apiKey: ' access-token ',
        paper: { title: 'Local private title', key: 'PRIVATE' },
    });

    assert.deepEqual(result, {
        status: 'fetched',
        paperID: '',
        references: [{
            paperID: '',
            title: '',
            year: 0,
            doi: '10.1000/target',
            arxivID: '',
            authors: [],
        }],
        truncated: false,
        fetchedAt: 2_000,
    });
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /references\/doi%3A10\.1000%2Fsource$/);
    assert.equal(requests[0].options.headers.authorization, 'access-token');
    assert.doesNotMatch(requests[0].url, /private/i);
    assert.equal(requests[0].options.body, undefined);
});

test('returns a bounded negative result for missing DOI records', async () => {
    const empty = new OpenCitationsClient({
        now: () => 3_000,
        fetch: async () => jsonResponse([]),
    });
    assert.deepEqual(
        await empty.fetchReferences({ doi: '10.1000/missing' }),
        {
            status: 'unindexed',
            paperID: '',
            references: [],
            truncated: false,
            fetchedAt: 3_000,
        }
    );

    const missing = new OpenCitationsClient({
        now: () => 4_000,
        maxRetryAttempts: 1,
        fetch: async () => jsonResponse({}, 404),
    });
    assert.equal(
        (await missing.fetchReferences({ doi: '10.1000/missing' })).status,
        'unindexed'
    );
});

test('retries one transient failure and reports bounded retry metadata', async () => {
    const retries = [];
    const delays = [];
    let attempts = 0;
    const client = new OpenCitationsClient({
        fetch: async () => {
            attempts++;
            return attempts === 1
                ? jsonResponse({}, 503)
                : jsonResponse([]);
        },
        sleep: async delay => delays.push(delay),
        retryBaseDelayMs: 25,
    });

    await client.fetchReferences({
        doi: '10.1000/source',
        onRetry: retry => retries.push(retry),
    });

    assert.equal(attempts, 2);
    assert.deepEqual(delays, [25]);
    assert.deepEqual(retries, [{
        code: 'request-retry',
        attempt: 1,
        retryAfterMs: 25,
    }]);
});

test('rejects malformed and secret-bearing failures safely', async () => {
    const malformed = new OpenCitationsClient({
        fetch: async () => jsonResponse({ citations: [] }),
    });
    await assert.rejects(
        () => malformed.fetchReferences({ doi: '10.1000/source' }),
        error => error.code === 'OC_INVALID_RESPONSE'
    );

    const denied = new OpenCitationsClient({
        maxRetryAttempts: 1,
        fetch: async () => jsonResponse({ token: 'raw-secret' }, 401),
    });
    await assert.rejects(
        () => denied.fetchReferences({
            doi: '10.1000/private-doi',
            apiKey: 'private-token',
        }),
        error => {
            const exposed = `${error.message}\n${error.stack || ''}`;
            assert.equal(error.code, 'OC_HTTP_ERROR');
            assert.doesNotMatch(exposed, /private-doi|private-token|raw-secret/);
            return true;
        }
    );
});

test('aborts an active OpenCitations request through the caller signal', async () => {
    const controller = new AbortController();
    const client = new OpenCitationsClient({
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

function jsonResponse(value, status = 200, headers = {}) {
    return new Response(JSON.stringify(value), { status, headers });
}
