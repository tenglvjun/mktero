import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAITranslationClient } from '../src/translation/openai-translation-client.js';

const SERVICE = {
    apiURL: 'https://api.example.test/v1/chat/completions',
    apiKey: 'secret-token',
    model: 'test-model',
    maxRequestsPerSecond: 100,
    maxParagraphsPerRequest: 8,
    maxCharactersPerRequest: 6000,
    temperature: 0.2,
};

const SEGMENTS = [{
    id: 'segment-000001',
    source: 'Source paragraph.',
    kind: 'paragraph',
    headingPath: ['Methods'],
}];

function textResponse(body, status = 200, headers = {}) {
    const values = new Map(
        Object.entries(headers).map(([key, value]) => [
            key.toLowerCase(),
            String(value),
        ])
    );
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: {
            get: key => values.get(String(key).toLowerCase()) ?? null,
        },
        text: async () => typeof body === 'string'
            ? body
            : JSON.stringify(body),
    };
}

function completion(translations) {
    return {
        choices: [{
            message: {
                content: JSON.stringify({ translations }),
            },
        }],
    };
}

function createClient(options = {}) {
    return new OpenAITranslationClient({
        createAbortController: () => new AbortController(),
        setTimeout,
        clearTimeout,
        sleep: async () => {},
        ...options,
    });
}

test('sends an OpenAI Chat Completions compatible request', async () => {
    const requests = [];
    const client = createClient({
        fetch: async (url, options) => {
            requests.push({ url, options });
            return textResponse(completion([{
                id: 'segment-000001',
                text: '译文段落。',
            }]));
        },
    });

    const result = await client.translateBatch({
        service: SERVICE,
        targetLanguage: 'zh-CN',
        systemPrompt: 'Translate accurately.',
        documentTitle: 'Paper',
        segments: SEGMENTS,
    });

    assert.deepEqual([...result], [['segment-000001', '译文段落。']]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, SERVICE.apiURL);
    assert.equal(requests[0].options.method, 'POST');
    assert.equal(
        requests[0].options.headers.Authorization,
        'Bearer secret-token'
    );
    const body = JSON.parse(requests[0].options.body);
    assert.equal(body.model, SERVICE.model);
    assert.equal(body.temperature, SERVICE.temperature);
    assert.equal(body.messages[1].role, 'user');
});

test('omits Authorization for a local service without an API key', async () => {
    let request;
    const client = createClient({
        fetch: async (_url, options) => {
            request = options;
            return textResponse(completion([{
                id: 'segment-000001',
                text: 'Translation.',
            }]));
        },
    });

    await client.translateBatch({
        service: {
            ...SERVICE,
            apiURL: 'http://localhost:1234/v1/chat/completions',
            apiKey: '',
        },
        targetLanguage: 'zh-CN',
        systemPrompt: 'Translate.',
        segments: SEGMENTS,
    });

    assert.equal('Authorization' in request.headers, false);
});

test('retries HTTP 429 and server errors up to the configured attempts', async () => {
    const responses = [
        textResponse('', 429, { 'retry-after': '0' }),
        textResponse('', 503),
        textResponse(completion([{
            id: 'segment-000001',
            text: 'Recovered translation.',
        }])),
    ];
    const delays = [];
    const client = createClient({
        fetch: async () => responses.shift(),
        sleep: async milliseconds => {
            delays.push(milliseconds);
        },
        retryBaseDelayMs: 25,
        maxAttempts: 3,
        now: () => 0,
    });

    const result = await client.translateBatch({
        service: SERVICE,
        targetLanguage: 'zh-CN',
        systemPrompt: 'Translate.',
        segments: SEGMENTS,
    });

    assert.equal(result.get('segment-000001'), 'Recovered translation.');
    assert.ok(delays.includes(0));
    assert.ok(delays.includes(50));
});

test('does not retry authentication failures', async () => {
    let calls = 0;
    const client = createClient({
        fetch: async () => {
            calls++;
            return textResponse('', 401);
        },
        maxAttempts: 3,
    });

    await assert.rejects(() => client.translateBatch({
        service: SERVICE,
        targetLanguage: 'zh-CN',
        systemPrompt: 'Translate.',
        segments: SEGMENTS,
    }), error => error.code === 'TRANSLATION_AUTHENTICATION_FAILED');
    assert.equal(calls, 1);
});

test('aborts an in-flight request through the caller signal', async () => {
    const caller = new AbortController();
    const client = createClient({
        fetch: async (_url, options) => new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => {
                reject(new Error('fetch aborted'));
            }, { once: true });
        }),
    });
    const pending = client.translateBatch({
        service: SERVICE,
        targetLanguage: 'zh-CN',
        systemPrompt: 'Translate.',
        segments: SEGMENTS,
        signal: caller.signal,
    });
    caller.abort();

    await assert.rejects(
        () => pending,
        error => error.code === 'TRANSLATION_ABORTED'
            || error.name === 'AbortError'
    );
});

test('rejects malformed or oversized service responses', async () => {
    const client = createClient({
        fetch: async () => textResponse({
            choices: [{ message: { content: 'not-json' } }],
        }),
    });

    await assert.rejects(() => client.translateBatch({
        service: SERVICE,
        targetLanguage: 'zh-CN',
        systemPrompt: 'Translate.',
        segments: SEGMENTS,
    }), error => error.code === 'TRANSLATION_PROTOCOL_INVALID');
});

test('stops immediately when the service rejects its configuration', async () => {
    let calls = 0;
    const client = createClient({
        fetch: async () => {
            calls++;
            return textResponse('', 400);
        },
        maxAttempts: 4,
    });

    await assert.rejects(() => client.translateBatch({
        service: SERVICE,
        targetLanguage: 'zh-CN',
        systemPrompt: 'Translate.',
        segments: SEGMENTS,
    }), error => (
        error.code === 'TRANSLATION_CONFIGURATION_INVALID'
        && error.status === 400
    ));
    assert.equal(calls, 1);
});

test('rate-limits actual request starts across concurrent batches', async () => {
    let clock = 0;
    const starts = [];
    const client = createClient({
        now: () => clock,
        sleep: async milliseconds => {
            clock += milliseconds;
        },
        fetch: async (_url, options) => {
            starts.push(clock);
            const body = JSON.parse(options.body);
            const user = JSON.parse(body.messages[1].content);
            const id = user.segments[0].id;
            return textResponse(completion([{
                id,
                text: 'Translated.',
            }]));
        },
    });
    const service = {
        ...SERVICE,
        maxRequestsPerSecond: 2,
    };

    await Promise.all(Array.from({ length: 3 }, (_, index) => (
        client.translateBatch({
            service,
            targetLanguage: 'zh-CN',
            systemPrompt: 'Translate.',
            segments: [{
                ...SEGMENTS[0],
                id: 'segment-' + String(index + 1).padStart(6, '0'),
            }],
        })
    )));

    assert.deepEqual(starts, [0, 500, 1000]);
});

test('limits concurrent network requests to four', async () => {
    let active = 0;
    let maximumActive = 0;
    const pending = [];
    const client = createClient({
        maxConcurrency: 4,
        now: () => 0,
        sleep: async () => {},
        fetch: async (_url, options) => {
            active++;
            maximumActive = Math.max(maximumActive, active);
            const body = JSON.parse(options.body);
            const user = JSON.parse(body.messages[1].content);
            const id = user.segments[0].id;
            await new Promise(resolve => {
                pending.push(resolve);
            });
            active--;
            return textResponse(completion([{
                id,
                text: 'Translated.',
            }]));
        },
    });
    const service = {
        ...SERVICE,
        maxRequestsPerSecond: 1_000_000,
    };
    const requests = Array.from({ length: 6 }, (_, index) => (
        client.translateBatch({
            service,
            targetLanguage: 'zh-CN',
            systemPrompt: 'Translate.',
            segments: [{
                ...SEGMENTS[0],
                id: 'segment-' + String(index + 1).padStart(6, '0'),
            }],
        })
    ));
    for (let index = 0; index < 20 && pending.length < 4; index++) {
        await Promise.resolve();
    }

    assert.equal(active, 4);
    assert.equal(maximumActive, 4);
    pending.splice(0, 4).forEach(resolve => resolve());
    for (let index = 0; index < 20 && pending.length < 2; index++) {
        await Promise.resolve();
    }
    assert.equal(active, 2);
    pending.splice(0, 2).forEach(resolve => resolve());

    await Promise.all(requests);
    assert.equal(maximumActive, 4);
});
