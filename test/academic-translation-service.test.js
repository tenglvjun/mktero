import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AcademicTranslationService,
    createEmptyTranslationState,
} from '../src/translation/academic-translation-service.js';

const CACHE_KEY = 'a'.repeat(64);
const CONFIGURATION = {
    service: {
        name: 'Academic service',
        apiURL: 'https://api.example.test/v1/chat/completions',
        apiKey: 'secret',
        model: 'model',
        maxRequestsPerSecond: 1,
        maxParagraphsPerRequest: 8,
        maxCharactersPerRequest: 6000,
        temperature: 0.2,
    },
    targetLanguage: 'zh-CN',
    systemPrompt: 'Translate.',
};

function segment(index, preparedText, placeholders = []) {
    const from = index * 100;
    return {
        id: 'segment-' + String(index + 1).padStart(6, '0'),
        sourceHash: String(index + 1).padStart(8, 'a'),
        from,
        to: from + preparedText.length,
        anchor: from + preparedText.length,
        kind: 'paragraph',
        headingPath: ['Methods'],
        source: preparedText,
        preparedText,
        placeholders,
    };
}

function createMemoryCache() {
    const entries = new Map();
    return {
        entries,
        get: async key => entries.get(key) || null,
        put: async (key, value) => {
            entries.set(key, structuredClone(value));
        },
        remove: async key => {
            entries.delete(key);
        },
    };
}

function createService({ client, cache, segments }) {
    return new AcademicTranslationService({
        client,
        cache,
        createCacheKey: async () => CACHE_KEY,
        extractSegments: () => segments,
    });
}

test('starts with a visible but idle empty translation state', () => {
    assert.deepEqual(createEmptyTranslationState(), {
        visible: true,
        status: 'idle',
        profileKey: null,
        targetLanguage: '',
        serviceName: '',
        completed: 0,
        failed: 0,
        total: 0,
        segments: [],
        error: '',
        errorCode: null,
        failureCodes: {},
    });
});

test('persists progressive batches and restores a complete cache hit', async () => {
    const segments = [
        segment(0, 'First source paragraph.'),
        segment(1, 'Second source paragraph.'),
    ];
    const cache = createMemoryCache();
    let calls = 0;
    const client = {
        async translateBatch({ segments: chunks }) {
            calls++;
            return new Map(chunks.map(chunk => [
                chunk.id,
                'Translated ' + chunk.source,
            ]));
        },
    };
    const service = createService({ client, cache, segments });
    const updates = [];
    const state = await service.translate({
        markdown: 'Source document',
        documentTitle: 'Paper',
        configuration: CONFIGURATION,
        onUpdate: update => updates.push(update),
    });

    assert.equal(state.status, 'complete');
    assert.equal(state.completed, 2);
    assert.equal(calls, 1);
    assert.equal(cache.entries.get(CACHE_KEY).status, 'complete');
    assert.ok(updates.some(update => update.status === 'translating'));

    const cacheOnly = createService({
        cache,
        segments,
        client: {
            translateBatch: async () => assert.fail('cache hit must not fetch'),
        },
    });
    const restored = await cacheOnly.translate({
        markdown: 'Source document',
        documentTitle: 'Paper',
        configuration: CONFIGURATION,
    });
    assert.equal(restored.status, 'complete');
    assert.deepEqual(
        restored.segments.map(value => value.text),
        [
            'Translated First source paragraph.',
            'Translated Second source paragraph.',
        ]
    );
});

test('falls back from an invalid batch response to individual segments', async () => {
    const segments = [
        segment(0, 'First source paragraph.'),
        segment(1, 'Second source paragraph.'),
    ];
    const calls = [];
    const client = {
        async translateBatch({ segments: chunks }) {
            calls.push(chunks.map(chunk => chunk.id));
            if (chunks.length > 1) {
                const error = new Error('invalid batch');
                error.code = 'TRANSLATION_PROTOCOL_INVALID';
                throw error;
            }
            return new Map([[chunks[0].id, '译文 ' + chunks[0].source]]);
        },
    };
    const service = createService({
        client,
        cache: createMemoryCache(),
        segments,
    });

    const state = await service.translate({
        markdown: 'Source',
        documentTitle: 'Paper',
        configuration: CONFIGURATION,
    });

    assert.equal(state.status, 'complete');
    assert.deepEqual(calls.map(call => call.length), [2, 1, 1]);
});

test('marks isolated request failures as partial without stopping the document', async () => {
    const segments = [
        segment(0, 'First source paragraph.'),
        segment(1, 'Second source paragraph.'),
    ];
    const service = createService({
        cache: createMemoryCache(),
        segments,
        client: {
            async translateBatch({ segments: chunks }) {
                if (chunks[0].segmentID === 'segment-000002') {
                    const error = new Error('service unavailable');
                    error.code = 'TRANSLATION_HTTP_ERROR';
                    throw error;
                }
                return new Map([[chunks[0].id, 'Translated first paragraph.']]);
            },
        },
    });

    const state = await service.translate({
        markdown: 'Source',
        documentTitle: 'Paper',
        configuration: {
            ...CONFIGURATION,
            service: {
                ...CONFIGURATION.service,
                maxParagraphsPerRequest: 1,
            },
        },
    });

    assert.equal(state.status, 'partial');
    assert.equal(state.completed, 1);
    assert.equal(state.failed, 1);
    assert.deepEqual(state.failureCodes, {
        TRANSLATION_HTTP_ERROR: 1,
    });
});

test('rejects placeholder corruption and retries the affected segments', async () => {
    const placeholder = { token: '⟦MKTERO_0⟧', value: '$E=mc^2$' };
    const segments = [
        segment(0, 'Energy ⟦MKTERO_0⟧.', [placeholder]),
        segment(1, 'Plain paragraph.'),
    ];
    let calls = 0;
    const service = createService({
        cache: createMemoryCache(),
        segments,
        client: {
            async translateBatch({ segments: chunks }) {
                calls++;
                if (chunks.length > 1) {
                    return new Map(chunks.map(chunk => [
                        chunk.id,
                        chunk.source.replace('⟦MKTERO_0⟧', ''),
                    ]));
                }
                return new Map([[chunks[0].id, '译文 ' + chunks[0].source]]);
            },
        },
    });

    const state = await service.translate({
        markdown: 'Source',
        documentTitle: 'Paper',
        configuration: CONFIGURATION,
    });

    assert.equal(state.status, 'complete');
    assert.equal(calls, 3);
    assert.ok(state.segments[0].text.includes('$E=mc^2$'));
});
