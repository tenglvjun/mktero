import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MarkdownTranslationService,
    TRANSLATION_PROMPT_VERSION,
} from '../src/ai/markdown-translation-service.js';
import {
    collectMarkdownTranslationBlocks,
    TRANSLATION_PROTECTED_CONTENT_CHANGED,
} from '../src/markdown/markdown-translation-blocks.js';

const SETTINGS = Object.freeze({
    enabled: true,
    provider: 'custom',
    protocol: 'openai-chat-completions',
    apiBase: 'https://api.example.com/v1',
    apiKey: 'token',
    model: 'example-chat',
    targetLanguage: 'zh-CN',
    requestTimeoutMs: 30_000,
    maxOutputTokens: 2_048,
});

test('tests a valid connection before AI translation is enabled', async () => {
    let request;
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(value) {
                request = value;
                return { text: 'OK', model: 'example-chat' };
            },
        },
        getSettings: () => ({
            ...SETTINGS,
            enabled: false,
            reasoning: 'xhigh',
        }),
    });

    const result = await service.testConnection();

    assert.equal(result.text, 'OK');
    assert.equal(request.settings.enabled, true);
    assert.equal(request.settings.reasoning, 'xhigh');
    assert.equal(request.maxOutputTokens, 4);
    assert.equal(request.acceptNonTextResponse, true);
    assert.deepEqual(request.messages, [{
        role: 'user',
        content: 'hi',
    }]);
});

test('gives each connection test and selection its own session id', async () => {
    const requests = [];
    let nextSession = 0;
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                requests.push(request);
                return { text: 'OK', model: 'example-chat' };
            },
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createSessionId: () => `session-${nextSession++}`,
    });

    await service.testConnection();
    await service.translateSelection({ text: 'A sentence.' });
    await service.translateSelection({ text: 'Another sentence.' });

    assert.deepEqual(requests.map(request => request.sessionId), [
        'session-0',
        'session-1',
        'session-2',
    ]);
});

test('reuses one session id for every request in a document translation', async () => {
    const sessionIds = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                sessionIds.push(request.sessionId);
                return {
                    text: translateBatchRequest(
                        request.messages[1].content,
                        sourceMarkdown => sourceMarkdown
                            .replace('# One section', '# 一个章节')
                            .replace(/Paragraph (\d+)\./g, '译文段落 $1。')
                    ),
                };
            },
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => null,
        createSessionId: () => 'document-session',
    });
    const source = [
        '# One section',
        ...Array.from({ length: 17 }, (_, index) => [
            '',
            `Paragraph ${index}.`,
        ]).flat(),
    ].join('\n');

    await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: source,
    });

    assert.deepEqual(sessionIds, [
        'document-session',
        'document-session',
        'document-session',
    ]);
});

test('translates a complete Markdown document in one provider request', async () => {
    const requests = [];
    const progress = [];
    const cached = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                const requestMarkdown = request.messages[1].content;
                requests.push(requestMarkdown);
                return {
                    text: translateBatchRequest(requestMarkdown, source => (
                        source
                            .replace('# Paper', '# 论文')
                            .replace('Original paragraph.', '译文段落。')
                    )),
                    model: 'provider-model',
                    usage: { totalTokens: 10 },
                };
            },
        },
        cache: {
            getTranslation: async () => null,
            putTranslation: async (...args) => cached.push(args),
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper\n\nOriginal paragraph.\n\n```js\ncode();\n```',
        onProgress: value => progress.push(value),
    });

    assert.equal(requests.length, 1);
    assert.deepEqual(parseTranslationRequest(requests[0]).map(entry => (
        entry.sourceMarkdown
    )), ['# Paper', 'Original paragraph.']);
    assert.doesNotMatch(requests[0], /code\(\)/);
    assert.equal(
        result.translatedMarkdown,
        '# 论文\n\n译文段落。\n\n```js\ncode();\n```'
    );
    assert.match(result.comparisonMarkdown, /# Paper\n\n# 论文/);
    assert.equal(result.totalBlocks, 2);
    assert.equal(result.completedBlocks, 2);
    assert.deepEqual(result.blockRanges.map(range => range.id), [
        'translation-0-0-7-heading',
        'translation-1-9-28-paragraph',
        'translation-2-30-47-structural',
    ]);
    assert.equal(result.cacheHit, false);
    assert.deepEqual(progress[0], {
        stage: 'preparing',
        completed: 0,
        total: 2,
    });
    assert.deepEqual(progress.at(-1), {
        stage: 'complete',
        completed: 2,
        total: 2,
    });
    assert.equal(cached.length, 1);
    assert.equal(cached[0][0], 'a'.repeat(64));
    assert.equal(cached[0][1], 'c'.repeat(64));
    assert.equal(cached[0][2].translatedMarkdown, result.translatedMarkdown);
});

test('streams the complete document by default and uses the selected language', async () => {
    const requests = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async streamText(request) {
                requests.push(request);
                return {
                    text: translateSingleBlockRequest(
                        request.messages[1].content,
                        '# Article traduit'
                    ),
                    model: 'stream-model',
                };
            },
            generateText: assert.fail,
        },
        getSettings: () => ({
            ...SETTINGS,
            streaming: true,
            targetLanguage: 'fr-FR',
        }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
    });

    assert.equal(requests.length, 1);
    assert.match(requests[0].messages[0].content, /French/);
    assert.equal(result.translatedMarkdown, '# Article traduit');
});

test('translates an explicitly selected language without changing the default', async () => {
    const requests = [];
    const cacheInputs = [];
    const settings = {
        ...SETTINGS,
        streaming: false,
        targetLanguage: 'zh-CN',
    };
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                requests.push(request);
                return {
                    text: translateSingleBlockRequest(
                        request.messages[1].content,
                        '# 한국어 논문'
                    ),
                };
            },
        },
        getSettings: () => settings,
        createCacheKey: async value => {
            cacheInputs.push(JSON.parse(value));
            return 'c'.repeat(64);
        },
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
        targetLanguage: 'ko-KR',
    });

    assert.match(requests[0].messages[0].content, /Korean/);
    assert.equal(cacheInputs[0].targetLanguage, 'ko-KR');
    assert.equal(result.targetLanguage, 'ko-KR');
    assert.equal(settings.targetLanguage, 'zh-CN');
});

test('rejects English as a translation target before calling the provider', async () => {
    const service = new MarkdownTranslationService({
        aiGateway: { generateText: assert.fail },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
    });

    await assert.rejects(() => service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
        targetLanguage: 'en-US',
    }), error => error?.code === 'AI_INVALID_REQUEST');
});

test('reports provider stages before validating the complete translation', async () => {
    const progress = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async streamText(request) {
                request.onStreamEvent({ type: 'reasoning-start' });
                request.onStreamEvent({ type: 'reasoning-delta' });
                request.onStreamEvent({ type: 'text-start' });
                return {
                    text: translateSingleBlockRequest(
                        request.messages[1].content,
                        '# Article traduit'
                    ),
                    model: 'stream-model',
                };
            },
            generateText: assert.fail,
        },
        getSettings: () => ({ ...SETTINGS, streaming: true }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
        onProgress: value => progress.push(value),
    });

    assert.deepEqual(progress.map(value => value.stage), [
        'preparing',
        'requesting',
        'reasoning',
        'translating',
        'validating',
        'complete',
    ]);
});

test('isolates document translations by reasoning and source content', async () => {
    const cacheInputs = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            generateText: async request => ({
                text: translateSingleBlockRequest(
                    request.messages[1].content,
                    '# 论文'
                ),
            }),
        },
        getSettings: () => ({
            ...SETTINGS,
            streaming: false,
            reasoning: 'high',
        }),
        createCacheKey: async value => {
            cacheInputs.push(JSON.parse(value));
            return 'c'.repeat(64);
        },
    });

    await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
    });

    assert.equal(cacheInputs[0].source, '# Paper');
    assert.equal(cacheInputs[0].reasoning, 'high');
});

test('keeps a completed document translation when caching fails', async () => {
    const cacheErrors = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            generateText: async request => ({
                text: translateSingleBlockRequest(
                    request.messages[1].content,
                    '# 论文'
                ),
            }),
        },
        cache: {
            getTranslation: async () => null,
            putTranslation: async () => { throw new Error('disk full'); },
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
        onCacheError: error => cacheErrors.push(error.message),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
    });

    assert.equal(result.translatedMarkdown, '# 论文');
    assert.equal(result.cacheStatus, 'missing');
    assert.deepEqual(cacheErrors, ['disk full']);
});

test('continues translating without persistence when cache hashing fails', async () => {
    const cacheErrors = [];
    let providerCalls = 0;
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                providerCalls++;
                return {
                    text: translateSingleBlockRequest(
                        request.messages[1].content,
                        '# 论文'
                    ),
                };
            },
        },
        cache: {
            getTranslation: assert.fail,
            putTranslation: assert.fail,
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => { throw new Error('hash unavailable'); },
        onCacheError: error => cacheErrors.push(error.message),
    });

    const cached = await service.getCachedDocumentTranslation({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
    });
    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
    });

    assert.equal(cached, null);
    assert.equal(result.translatedMarkdown, '# 论文');
    assert.equal(result.translationKey, null);
    assert.equal(result.cacheStatus, 'missing');
    assert.equal(providerCalls, 1);
    assert.deepEqual(cacheErrors, ['hash unavailable', 'hash unavailable']);
});

test('lists complete and partial cached translations for every language', async () => {
    const blockID = 'translation-0-0-7-heading';
    const cachedByLanguage = new Map([
        ['zh-CN', {
            translatedMarkdown: '# \u8bba\u6587',
            comparisonMarkdown: '',
            blocks: [{ id: blockID, markdown: '# \u8bba\u6587' }],
            model: 'cached-model',
            targetLanguage: 'zh-CN',
            promptVersion: TRANSLATION_PROMPT_VERSION,
            partial: false,
            failedBlocks: [],
        }],
        ['ja-JP', {
            translatedMarkdown: '# \u8ad6\u6587',
            comparisonMarkdown: '',
            blocks: [{ id: blockID, markdown: '# \u8ad6\u6587' }],
            model: 'cached-model',
            targetLanguage: 'ja-JP',
            promptVersion: TRANSLATION_PROMPT_VERSION,
            partial: false,
            failedBlocks: [],
        }],
        ['fr-FR', {
            translatedMarkdown: '# Paper',
            comparisonMarkdown: '',
            blocks: [{ id: blockID, markdown: '# Paper' }],
            model: 'cached-model',
            targetLanguage: 'fr-FR',
            promptVersion: TRANSLATION_PROMPT_VERSION,
            partial: true,
            failedBlocks: [],
        }],
        ['en-US', {
            translatedMarkdown: '# Paper',
            comparisonMarkdown: '',
            blocks: [{ id: blockID, markdown: '# Paper' }],
            model: 'cached-model',
            targetLanguage: 'en-US',
            promptVersion: TRANSLATION_PROMPT_VERSION,
            partial: false,
            failedBlocks: [],
        }],
        ['es-ES', {
            translatedMarkdown: '# Articulo',
            comparisonMarkdown: '',
            blocks: [{ id: 'unknown-block', markdown: '# Articulo' }],
            model: 'cached-model',
            targetLanguage: 'es-ES',
            promptVersion: TRANSLATION_PROMPT_VERSION,
            partial: false,
            failedBlocks: [],
        }],
    ]);
    const providerCalls = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                providerCalls.push(request);
                throw new Error('The provider must not be called');
            },
        },
        cache: {
            getTranslation: async (_documentKey, language) => (
                cachedByLanguage.get(language) || null
            ),
        },
        getSettings: () => ({ ...SETTINGS, targetLanguage: 'zh-CN' }),
        createCacheKey: async value => JSON.parse(value).targetLanguage,
    });

    const japanese = await service.getCachedDocumentTranslation({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
        targetLanguage: 'ja-JP',
    });
    const variants = await service.listCachedDocumentTranslationVariants({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
    });

    assert.equal(japanese.targetLanguage, 'ja-JP');
    assert.equal(japanese.translatedMarkdown, '# \u8ad6\u6587');
    assert.deepEqual(variants.map(result => [
        result.targetLanguage,
        result.partial,
    ]), [
        ['zh-CN', false],
        ['ja-JP', false],
        ['fr-FR', true],
    ]);
    assert.equal(cachedByLanguage.has('en-US'), true);
    assert.equal(variants.some(result => (
        result.targetLanguage === 'en-US'
    )), false);
    assert.equal(providerCalls.length, 0);
});

test('continues translating when reading the Markdown translation cache fails', async () => {
    const cacheErrors = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            generateText: async request => ({
                text: translateSingleBlockRequest(
                    request.messages[1].content,
                    '# 论文'
                ),
            }),
        },
        cache: {
            getTranslation: async () => { throw new Error('cache unreadable'); },
            putTranslation: async () => {},
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
        onCacheError: error => cacheErrors.push(error.message),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
    });

    assert.equal(result.translatedMarkdown, '# 论文');
    assert.deepEqual(cacheErrors, ['cache unreadable']);
});

test('always stores completed translations with the Markdown cache entry', async () => {
    const cached = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            generateText: async request => ({
                text: translateSingleBlockRequest(
                    request.messages[1].content,
                    '# 论文'
                ),
            }),
        },
        cache: {
            getTranslation: async () => null,
            putTranslation: async (...args) => cached.push(args),
        },
        getSettings: () => ({
            ...SETTINGS,
            cacheEnabled: false,
            streaming: false,
        }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
    });

    assert.equal(cached.length, 1);
});

for (const [name, output] of [
    ['raw HTML', '<script>alert(1)</script>'],
    ['a Markdown image', '![Injected](https://example.com/tracker.png)'],
]) {
    test(`keeps source text when the AI provider returns ${name}`, async () => {
        const service = createBoundaryService({ output });

        const result = await service.translateDocument({
            documentKey: 'a'.repeat(64),
            markdown: 'Translate this paragraph.',
        });

        assert.equal(result.translatedMarkdown, 'Translate this paragraph.');
        assert.equal(result.partial, true);
        assert.equal(result.completedBlocks, 0);
        assert.equal(result.failedBlocks.length, 1);
    });
}

test('accepts a Markdown paragraph over the removed 64 KB block limit', async () => {
    let providerCalls = 0;
    const source = `Paragraph ${'x'.repeat(64 * 1024)}.`;
    const service = createBoundaryService({
        output: '译文。',
        onProviderCall: () => { providerCalls++; },
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: source,
    });

    assert.equal(result.translatedMarkdown, '译文。');
    assert.equal(providerCalls, 1);
});

test('counts protected content toward the 4 MB document input limit', async () => {
    let providerCalls = 0;
    const service = createBoundaryService({
        output: '译文。',
        onProviderCall: () => { providerCalls++; },
    });

    await assert.rejects(() => service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: `Translate \`${'x'.repeat(4 * 1024 * 1024)}\`.`,
    }), error => error?.code === 'AI_INPUT_TOO_LARGE');
    assert.equal(providerCalls, 0);
});

test('rejects more than 2,000 translatable blocks before calling the provider', async () => {
    let providerCalls = 0;
    const service = createBoundaryService({
        output: '译文。',
        onProviderCall: () => { providerCalls++; },
    });

    await assert.rejects(() => service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: Array.from(
            { length: 2_001 },
            (_, index) => `Paragraph ${index}.`
        ).join('\n\n'),
    }), error => error?.code === 'AI_INPUT_TOO_LARGE');
    assert.equal(providerCalls, 0);
});

test('rejects cumulative translation input over 4 MB before calling the provider', async () => {
    let providerCalls = 0;
    const service = createBoundaryService({
        output: '译文。',
        onProviderCall: () => { providerCalls++; },
    });
    const paragraph = `Paragraph ${'x'.repeat(60 * 1024)}.`;

    await assert.rejects(() => service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: Array.from({ length: 69 }, () => paragraph).join('\n\n'),
    }), error => error?.code === 'AI_INPUT_TOO_LARGE');
    assert.equal(providerCalls, 0);
});

test('accepts a translated document over the removed 256 KB block limit', async () => {
    const output = `译文${'x'.repeat(256 * 1024)}`;
    const service = createBoundaryService({
        output,
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: 'Translate this paragraph.',
    });

    assert.equal(result.translatedMarkdown, output);
});

test('rejects a document translation over 4 MB without caching it', async () => {
    let providerCalls = 0;
    const service = createBoundaryService({
        output: `译${'x'.repeat(4 * 1024 * 1024)}`,
        onProviderCall: () => { providerCalls++; },
    });
    service.cache.putTranslation = assert.fail;

    await assert.rejects(() => service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: 'Translate this paragraph.',
    }), error => error?.code === 'AI_RESPONSE_TOO_LARGE');
    assert.equal(providerCalls, 1);
});

test('counts restored protected content toward the document output limit', async () => {
    const protectedContent = 'x'.repeat(4 * 1024 * 1024 - 1_024);
    const source = `Translate \`${protectedContent}\`.`;
    let requestMarkdown;
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                requestMarkdown = request.messages[1].content;
                const placeholder = parseTranslationRequest(requestMarkdown)[0]
                    .sourceMarkdown.match(
                    /MKTEROPROTECTED\d+PLACEHOLDER/
                )?.[0];
                return {
                    text: translateSingleBlockRequest(
                        requestMarkdown,
                        `${'译'.repeat(1_024)} ${placeholder}`
                    ),
                };
            },
        },
        cache: {
            getTranslation: async () => null,
            putTranslation: assert.fail,
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    await assert.rejects(() => service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: source,
    }), error => error?.code === 'AI_RESPONSE_TOO_LARGE');
    assert.match(requestMarkdown, /MKTEROPROTECTED\d+PLACEHOLDER/);
});

test('cancels active batches when completed translations exceed 4 MB', async () => {
    let calls = 0;
    let aborted = 0;
    const oversizedParagraph = `译文${'x'.repeat(1_100_000)}`;
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                calls++;
                const entries = parseTranslationRequest(
                    request.messages[1].content
                );
                const heading = entries.find(entry => (
                    entry.sourceMarkdown.startsWith('# ')
                ));
                if (heading?.sourceMarkdown === '# Section 4') {
                    await new Promise((resolve, reject) => {
                        request.signal.addEventListener('abort', () => {
                            aborted++;
                            reject(Object.assign(new Error('aborted'), {
                                name: 'AbortError',
                            }));
                        }, { once: true });
                    });
                }
                return {
                    text: JSON.stringify(entries.map(entry => ({
                        id: entry.id,
                        translatedMarkdown: entry === heading
                            ? entry.sourceMarkdown
                            : oversizedParagraph,
                    }))),
                };
            },
        },
        cache: {
            getTranslation: async () => null,
            putTranslation: assert.fail,
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
    });
    const source = Array.from({ length: 5 }, (_, index) => (
        `# Section ${index}\n\nParagraph ${index}.`
    )).join('\n\n');

    await assert.rejects(() => service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: source,
    }), error => error?.code === 'AI_RESPONSE_TOO_LARGE');

    assert.equal(calls, 5);
    assert.equal(aborted, 1);
});

test('loads a complete document translation without calling the provider', async () => {
    const cached = {
        translatedMarkdown: '# 论文',
        comparisonMarkdown: '# Paper\n\n> # 论文',
        blocks: [{ id: 'translation-0-0-7-heading', markdown: '# 论文' }],
        model: 'cached-model',
        targetLanguage: 'zh-CN',
        promptVersion: TRANSLATION_PROMPT_VERSION,
        partial: false,
        failedBlocks: [],
    };
    const service = new MarkdownTranslationService({
        aiGateway: { generateText: assert.fail },
        cache: {
            getTranslation: async () => cached,
            putTranslation: assert.fail,
        },
        getSettings: () => SETTINGS,
        createCacheKey: async () => 'c'.repeat(64),
    });

    const result = await service.getCachedDocumentTranslation({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
    });

    assert.deepEqual(result, {
        ...cached,
        comparisonMarkdown: '# Paper\n\n# 论文',
        comparisonSourceRanges: [{
            sourceFrom: 0,
            sourceTo: 7,
            comparisonFrom: 0,
        }],
        comparisonTranslationRanges: [{ from: 9, to: 13 }],
        blockRanges: [{
            id: 'translation-0-0-7-heading',
            type: 'heading',
            sourceFrom: 0,
            sourceTo: 7,
            translatedFrom: 0,
            translatedTo: 4,
            comparisonSourceFrom: 0,
            comparisonSourceTo: 7,
            comparisonTranslationFrom: 9,
            comparisonTranslationTo: 13,
        }],
        sourceBlocks: [{
            id: 'translation-0-0-7-heading',
            markdown: '# Paper',
        }],
        pendingBlockIDs: [],
        translationKey: 'c'.repeat(64),
        cacheHit: true,
        cacheStatus: 'complete',
        totalBlocks: 1,
        completedBlocks: 1,
        documentKey: 'a'.repeat(64),
        sourceMarkdown: '# Paper',
        settingsIdentity: documentSettingsIdentity(),
    });
});

test('restores unchanged block translations after deleting a source block', async () => {
    const newSource = 'Keep this paragraph.';
    const cached = {
        translatedMarkdown: '# 文章\n\n保留这一段。',
        comparisonMarkdown: '',
        blocks: [{
            id: 'translation-0-0-9-heading',
            markdown: '# 文章',
        }, {
            id: 'translation-1-11-31-paragraph',
            markdown: '保留这一段。',
        }],
        sourceBlocks: [{
            id: 'translation-0-0-9-heading',
            markdown: '# Article',
        }, {
            id: 'translation-1-11-31-paragraph',
            markdown: 'Keep this paragraph.',
        }],
        settingsIdentity: documentSettingsIdentity(),
        model: 'cached-model',
        targetLanguage: 'zh-CN',
        promptVersion: TRANSLATION_PROMPT_VERSION,
        partial: false,
        failedBlocks: [],
    };
    const service = new MarkdownTranslationService({
        aiGateway: { generateText: assert.fail },
        cache: {
            getTranslation: async () => null,
            getTranslationByLanguage: async (_documentKey, language) => (
                language === 'zh-CN' ? cached : null
            ),
            putTranslation: assert.fail,
        },
        getSettings: () => SETTINGS,
        createCacheKey: async () => 'd'.repeat(64),
    });

    const [restored] = await service.listCachedDocumentTranslationVariants({
        documentKey: 'a'.repeat(64),
        markdown: newSource,
    });

    assert.equal(restored.sourceMarkdown, newSource);
    assert.equal(restored.translatedMarkdown, '保留这一段。');
    assert.equal(restored.partial, false);
    assert.deepEqual(restored.failedBlocks, []);
    assert.deepEqual(restored.blocks, [{
        id: 'translation-0-0-20-paragraph',
        markdown: '保留这一段。',
    }]);
    assert.doesNotMatch(restored.comparisonMarkdown, /Article|文章/);
});

test('restores a cached translation after deleting a protected citation marker',
    async () => {
    const oldSource = 'Wrist-worn devices identify ovulation [1].';
    const currentSource = 'Wrist-worn devices identify ovulation.';
    const [oldBlock] = collectMarkdownTranslationBlocks(oldSource);
    const cached = {
        blocks: [{
            id: oldBlock.id,
            markdown: oldBlock.requestMarkdown.replace(
                'Wrist-worn devices identify ovulation',
                '腕戴设备可识别排卵'
            ).replace(/\.$/u, '。'),
        }],
        sourceBlocks: [{ id: oldBlock.id, markdown: oldSource }],
        settingsIdentity: documentSettingsIdentity(),
        model: 'cached-model',
        targetLanguage: 'zh-CN',
        promptVersion: TRANSLATION_PROMPT_VERSION,
        partial: false,
        failedBlocks: [],
    };
    const { service, cacheErrors } = createCompatibleCacheService(cached);

    const variants = await service.listCachedDocumentTranslationVariants({
        documentKey: 'a'.repeat(64),
        markdown: currentSource,
    });

    assert.deepEqual(cacheErrors, []);
    assert.equal(variants.length, 1);
    assert.equal(variants[0].translatedMarkdown, '腕戴设备可识别排卵。');
    assert.equal(variants[0].partial, false);
    assert.deepEqual(variants[0].pendingBlockIDs, []);
});

test('renumbers a retained protected citation after deleting an earlier one',
    async () => {
    const oldSource = 'See [1] and [2].';
    const currentSource = 'See and [2].';
    const [oldBlock] = collectMarkdownTranslationBlocks(oldSource);
    const [firstCitation, secondCitation] = oldBlock.protectedFragments;
    const cached = {
        blocks: [{
            id: oldBlock.id,
            markdown: [
                '结果见',
                firstCitation.placeholder,
                '，并参见 ',
                secondCitation.placeholder,
                '。',
            ].join(''),
        }],
        sourceBlocks: [{ id: oldBlock.id, markdown: oldSource }],
        settingsIdentity: documentSettingsIdentity(),
        model: 'cached-model',
        targetLanguage: 'zh-CN',
        promptVersion: TRANSLATION_PROMPT_VERSION,
        partial: false,
        failedBlocks: [],
    };
    const { service, cacheErrors } = createCompatibleCacheService(cached);

    const variants = await service.listCachedDocumentTranslationVariants({
        documentKey: 'a'.repeat(64),
        markdown: currentSource,
    });

    assert.deepEqual(cacheErrors, []);
    assert.equal(variants.length, 1);
    assert.equal(variants[0].translatedMarkdown, '结果见，并参见 [2]。');
    assert.equal(variants[0].partial, false);
    assert.deepEqual(variants[0].pendingBlockIDs, []);
});

test('renumbers protected citations in later unchanged cached blocks',
    async () => {
    const oldSource = 'First [1].\n\nSecond [2].';
    const currentSource = 'First.\n\nSecond [2].';
    const oldBlocks = collectMarkdownTranslationBlocks(oldSource);
    const cached = {
        blocks: oldBlocks.map(block => ({
            id: block.id,
            markdown: block.requestMarkdown
                .replace('First', '第一处')
                .replace('Second', '第二处')
                .replace(/\.$/u, '。'),
        })),
        sourceBlocks: oldBlocks.map(block => ({
            id: block.id,
            markdown: block.markdown,
        })),
        settingsIdentity: documentSettingsIdentity(),
        model: 'cached-model',
        targetLanguage: 'zh-CN',
        promptVersion: TRANSLATION_PROMPT_VERSION,
        partial: false,
        failedBlocks: [],
    };
    const { service, cacheErrors } = createCompatibleCacheService(cached);

    const variants = await service.listCachedDocumentTranslationVariants({
        documentKey: 'a'.repeat(64),
        markdown: currentSource,
    });

    assert.deepEqual(cacheErrors, []);
    assert.equal(variants.length, 1);
    assert.equal(variants[0].translatedMarkdown, '第一处。\n\n第二处 [2]。');
    assert.equal(variants[0].partial, false);
    assert.deepEqual(variants[0].pendingBlockIDs, []);
});

test('preserves context-protected figure references in compatible cache',
    async () => {
    const oldSource = [
        'First [1].',
        '',
        '# Results',
        '',
        'The ablation appears in Fig. 2.',
        '',
        '![](images/panel-a.png)',
        '',
        '![](images/panel-b.png)  ',
        'Figure 2. Ablation results.',
    ].join('\n');
    const currentSource = oldSource.replace('First [1].', 'First.');
    const oldBlocks = collectMarkdownTranslationBlocks(oldSource).filter(
        block => block.translatable
    );
    const cached = {
        blocks: oldBlocks.map(block => ({
            id: block.id,
            markdown: block.requestMarkdown
                .replace('First', '第一处')
                .replace('# Results', '# 结果')
                .replace('The ablation appears in', '消融结果见')
                .replace('Ablation results', '消融结果')
                .replace(/\.$/u, '。'),
        })),
        sourceBlocks: oldBlocks.map(block => ({
            id: block.id,
            markdown: block.markdown,
        })),
        settingsIdentity: documentSettingsIdentity(),
        model: 'cached-model',
        targetLanguage: 'zh-CN',
        promptVersion: TRANSLATION_PROMPT_VERSION,
        partial: false,
        failedBlocks: [],
    };
    const { service, cacheErrors } = createCompatibleCacheService(cached);

    const variants = await service.listCachedDocumentTranslationVariants({
        documentKey: 'a'.repeat(64),
        markdown: currentSource,
    });

    assert.deepEqual(cacheErrors, []);
    assert.equal(variants.length, 1);
    assert.match(variants[0].translatedMarkdown, /消融结果\s*见 Fig\. 2。/u);
    assert.match(variants[0].translatedMarkdown, /Figure 2\. 消融结果。/u);
    assert.doesNotMatch(variants[0].translatedMarkdown, /MKTEROPROTECTED/u);
});

test('deletes a citation beside a context-protected figure reference',
    async () => {
    const oldSource = [
        '# Results',
        '',
        'The ablation [1] appears in Fig. 2.',
        '',
        '![](images/panel-a.png)',
        '',
        '![](images/panel-b.png)  ',
        'Figure 2. Ablation results.',
    ].join('\n');
    const currentSource = oldSource.replace(' [1]', '');
    const oldBlocks = collectMarkdownTranslationBlocks(oldSource).filter(
        block => block.translatable
    );
    const cached = {
        blocks: oldBlocks.map(block => ({
            id: block.id,
            markdown: block.requestMarkdown
                .replace('# Results', '# 结果')
                .replace('The ablation', '消融结果')
                .replace('appears in', '见')
                .replace('Ablation results', '消融结果')
                .replace(/\.$/u, '。'),
        })),
        sourceBlocks: oldBlocks.map(block => ({
            id: block.id,
            markdown: block.markdown,
        })),
        settingsIdentity: documentSettingsIdentity(),
        model: 'cached-model',
        targetLanguage: 'zh-CN',
        promptVersion: TRANSLATION_PROMPT_VERSION,
        partial: false,
        failedBlocks: [],
    };
    const { service, cacheErrors } = createCompatibleCacheService(cached);

    const variants = await service.listCachedDocumentTranslationVariants({
        documentKey: 'a'.repeat(64),
        markdown: currentSource,
    });

    assert.deepEqual(cacheErrors, []);
    assert.equal(variants.length, 1);
    assert.match(variants[0].translatedMarkdown, /消融结果\s*见 Fig\. 2。/u);
    assert.doesNotMatch(variants[0].translatedMarkdown, /MKTEROPROTECTED/u);
});

test('rejects an ambiguous protected citation deletion from translation cache',
    async () => {
    const oldSource = 'See [1] and [1].';
    const currentSource = 'See and [1].';
    const [oldBlock] = collectMarkdownTranslationBlocks(oldSource);
    const cached = {
        blocks: [{
            id: oldBlock.id,
            markdown: oldBlock.requestMarkdown.replace('See', '见'),
        }],
        sourceBlocks: [{ id: oldBlock.id, markdown: oldSource }],
        settingsIdentity: documentSettingsIdentity(),
        model: 'cached-model',
        targetLanguage: 'zh-CN',
        promptVersion: TRANSLATION_PROMPT_VERSION,
        partial: false,
        failedBlocks: [],
    };
    const { service, cacheErrors } = createCompatibleCacheService(cached);

    const variants = await service.listCachedDocumentTranslationVariants({
        documentKey: 'a'.repeat(64),
        markdown: currentSource,
    });

    assert.deepEqual(variants, []);
    assert.equal(cacheErrors.length, 1);
    assert.equal(
        cacheErrors[0].code,
        TRANSLATION_PROTECTED_CONTENT_CHANGED
    );
});

test('does not reuse an ambiguous translation after deleting a duplicate block', async () => {
    const oldSource = [
        'Intro.',
        '',
        'Repeated.',
        '',
        'Middle.',
        '',
        'Repeated.',
        '',
        'End.',
    ].join('\n');
    const newSource = 'Intro.\n\nMiddle.\n\nRepeated.\n\nEnd.';
    const oldTranslation = {
        documentKey: 'a'.repeat(64),
        sourceMarkdown: oldSource,
        translationKey: 'c'.repeat(64),
        settingsIdentity: documentSettingsIdentity(),
        translatedMarkdown: '简介。\n\n第一处重复。\n\n中间。\n\n第二处重复。\n\n结尾。',
        comparisonMarkdown: '',
        blocks: [{
            id: 'translation-0-0-6-paragraph',
            markdown: '简介。',
        }, {
            id: 'translation-1-8-17-paragraph',
            markdown: '第一处重复。',
        }, {
            id: 'translation-2-19-26-paragraph',
            markdown: '中间。',
        }, {
            id: 'translation-3-28-37-paragraph',
            markdown: '第二处重复。',
        }, {
            id: 'translation-4-39-43-paragraph',
            markdown: '结尾。',
        }],
        sourceBlocks: [{
            id: 'translation-0-0-6-paragraph',
            markdown: 'Intro.',
        }, {
            id: 'translation-1-8-17-paragraph',
            markdown: 'Repeated.',
        }, {
            id: 'translation-2-19-26-paragraph',
            markdown: 'Middle.',
        }, {
            id: 'translation-3-28-37-paragraph',
            markdown: 'Repeated.',
        }, {
            id: 'translation-4-39-43-paragraph',
            markdown: 'End.',
        }],
        targetLanguage: 'zh-CN',
        model: 'cached-model',
        promptVersion: TRANSLATION_PROMPT_VERSION,
        partial: false,
        failedBlocks: [],
    };
    const service = new MarkdownTranslationService({
        aiGateway: { generateText: assert.fail },
        cache: {
            getTranslation: async () => null,
            getTranslationByLanguage: async () => null,
        },
        getSettings: () => SETTINGS,
        createCacheKey: async () => 'd'.repeat(64),
    });

    const reconciled = await service.reconcileDocumentTranslation({
        documentKey: 'a'.repeat(64),
        markdown: newSource,
        existingTranslation: oldTranslation,
    });

    assert.equal(
        reconciled.translatedMarkdown,
        '简介。\n\n中间。\n\nRepeated.\n\n结尾。'
    );
    assert.equal(reconciled.partial, true);
    assert.deepEqual(reconciled.pendingBlockIDs, [
        'translation-2-17-26-paragraph',
    ]);
    assert.doesNotMatch(reconciled.translatedMarkdown, /第一处重复|第二处重复/);
});

test('preserves an exact complete cache when a correction is restored', async () => {
    const documentKey = 'a'.repeat(64);
    const baseSource = '# Paper';
    const correctedSource = '# Study';
    const baseKey = 'c'.repeat(64);
    const correctedKey = 'd'.repeat(64);
    const exact = {
        translatedMarkdown: '# 论文',
        comparisonMarkdown: '',
        blocks: [{
            id: 'translation-0-0-7-heading',
            markdown: '# 论文',
        }],
        sourceBlocks: [{
            id: 'translation-0-0-7-heading',
            markdown: baseSource,
        }],
        settingsIdentity: documentSettingsIdentity(),
        model: 'cached-model',
        targetLanguage: 'zh-CN',
        promptVersion: TRANSLATION_PROMPT_VERSION,
        partial: false,
        failedBlocks: [],
    };
    let stored = { key: baseKey, value: exact };
    const writes = [];
    let providerCalls = 0;
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                providerCalls++;
                return {
                    text: translateSingleBlockRequest(
                        request.messages[1].content,
                        '# 论文'
                    ),
                };
            },
        },
        cache: {
            getTranslation: async (_key, translationKey) => (
                stored.key === translationKey ? stored.value : null
            ),
            getTranslationByLanguage: async () => stored.value,
            putTranslation: async (_key, translationKey, value) => {
                writes.push(translationKey);
                stored = { key: translationKey, value };
            },
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async value => (
            JSON.parse(value).source === baseSource ? baseKey : correctedKey
        ),
    });
    const correctedTranslation = {
        documentKey,
        sourceMarkdown: correctedSource,
        translationKey: correctedKey,
        settingsIdentity: documentSettingsIdentity(),
        translatedMarkdown: correctedSource,
        comparisonMarkdown: '',
        blocks: [{
            id: 'translation-0-0-7-heading',
            markdown: correctedSource,
        }],
        sourceBlocks: [{
            id: 'translation-0-0-7-heading',
            markdown: correctedSource,
        }],
        model: 'cached-model',
        targetLanguage: 'zh-CN',
        promptVersion: TRANSLATION_PROMPT_VERSION,
        partial: true,
        failedBlocks: [{
            id: 'translation-0-0-7-heading',
            message: 'The source Markdown block changed',
        }],
    };

    const restored = await service.reconcileDocumentTranslation({
        documentKey,
        markdown: baseSource,
        existingTranslation: correctedTranslation,
    });
    const reopened = await service.translateDocument({
        documentKey,
        markdown: baseSource,
        existingTranslation: restored,
    });

    assert.equal(restored.translatedMarkdown, '# 论文');
    assert.equal(restored.partial, false);
    assert.equal(reopened.translatedMarkdown, '# 论文');
    assert.equal(providerCalls, 0);
    assert.deepEqual(writes, []);
    assert.equal(stored.key, baseKey);
});

test('reuses the original translation after a deleted block is retranslated',
    async () => {
    const documentKey = 'a'.repeat(64);
    const originalSource = [
        '# Paper',
        '',
        'Deleted article block [1].',
        '',
        'Persistent paragraph.',
    ].join('\n');
    const deletedSource = [
        '# Paper',
        '',
        '   ',
        '',
        'Persistent paragraph.',
    ].join('\n');
    const originalKey = 'c'.repeat(64);
    const deletedKey = 'd'.repeat(64);
    const stored = new Map();
    const cacheErrors = [];
    let providerCalls = 0;
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                providerCalls++;
                return {
                    text: translateBatchRequest(
                        request.messages[1].content,
                        source => source
                            .replace('# Paper', '# 论文')
                            .replace('Deleted article block', '已删除文章段。')
                            .replace('Persistent paragraph.', '持久段落。')
                    ),
                };
            },
        },
        cache: {
            getTranslation: async (_key, translationKey) => (
                stored.get(translationKey)?.value || null
            ),
            getTranslationByLanguage: async () => (
                [...stored.values()].at(-1)?.value || null
            ),
            putTranslation: async (_key, translationKey, value) => {
                stored.delete(translationKey);
                stored.set(translationKey, { value });
            },
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async value => {
            const source = JSON.parse(value).source;
            return source === originalSource ? originalKey : deletedKey;
        },
        onCacheError: error => cacheErrors.push(error),
    });

    const originalTranslation = await service.translateDocument({
        documentKey,
        markdown: originalSource,
    });
    const deletedTranslation = await service.translateDocument({
        documentKey,
        markdown: deletedSource,
        existingTranslation: originalTranslation,
        forceRetranslate: true,
    });
    const restored = await service.reconcileDocumentTranslation({
        documentKey,
        markdown: originalSource,
        existingTranslation: deletedTranslation,
    });

    assert.equal(providerCalls, 2);
    assert.deepEqual(cacheErrors, []);
    assert.equal(restored.partial, false);
    assert.equal(
        restored.translatedMarkdown,
        '# 论文\n\n已删除文章段。 [1].\n\n持久段落。'
    );
    assert.deepEqual(restored.pendingBlockIDs, []);
});

test('keeps a single edited translation block available for targeted retry', async () => {
    const service = new MarkdownTranslationService({
        aiGateway: { generateText: assert.fail },
        cache: {
            getTranslation: async () => null,
            getTranslationByLanguage: async () => null,
            putTranslation: async () => {},
        },
        getSettings: () => SETTINGS,
        createCacheKey: async () => 'd'.repeat(64),
    });

    const reconciled = await service.reconcileDocumentTranslation({
        documentKey: 'a'.repeat(64),
        markdown: '# Study',
        existingTranslation: {
            documentKey: 'a'.repeat(64),
            sourceMarkdown: '# Paper',
            translationKey: 'c'.repeat(64),
            settingsIdentity: documentSettingsIdentity(),
            translatedMarkdown: '# 论文',
            comparisonMarkdown: '# Paper\n\n# 论文',
            blocks: [{
                id: 'translation-0-0-7-heading',
                markdown: '# 论文',
            }],
            sourceBlocks: [{
                id: 'translation-0-0-7-heading',
                markdown: '# Paper',
            }],
            targetLanguage: 'zh-CN',
            partial: false,
            failedBlocks: [],
        },
    });

    assert.equal(reconciled.partial, true);
    assert.equal(reconciled.translatedMarkdown, '# Study');
    assert.deepEqual(reconciled.pendingBlockIDs, [
        'translation-0-0-7-heading',
    ]);
});

test('preserves a translated block after deleting a non-semantic marker', async () => {
    const originalSource = 'Wrist-worn devices identify ovulation (1).';
    const correctedSource = 'Wrist-worn devices identify ovulation.';
    const originalBlockID = `translation-0-0-${originalSource.length}-paragraph`;
    const correctedBlockID = `translation-0-0-${correctedSource.length}-paragraph`;
    const service = new MarkdownTranslationService({
        aiGateway: { generateText: assert.fail },
        cache: {
            getTranslation: async () => null,
            getTranslationByLanguage: async () => null,
            putTranslation: async () => {},
        },
        getSettings: () => SETTINGS,
        createCacheKey: async () => 'd'.repeat(64),
    });

    const reconciled = await service.reconcileDocumentTranslation({
        documentKey: 'a'.repeat(64),
        markdown: correctedSource,
        existingTranslation: {
            documentKey: 'a'.repeat(64),
            sourceMarkdown: originalSource,
            translationKey: 'c'.repeat(64),
            settingsIdentity: documentSettingsIdentity(),
            translatedMarkdown: '腕戴设备可识别排卵。',
            comparisonMarkdown: '',
            blocks: [{
                id: originalBlockID,
                markdown: '腕戴设备可识别排卵。',
            }],
            sourceBlocks: [{
                id: originalBlockID,
                markdown: originalSource,
            }],
            targetLanguage: 'zh-CN',
            partial: false,
            failedBlocks: [],
        },
    });

    assert.equal(reconciled.partial, false);
    assert.equal(reconciled.translatedMarkdown, '腕戴设备可识别排卵。');
    assert.deepEqual(reconciled.pendingBlockIDs, []);
    assert.deepEqual(reconciled.blocks, [{
        id: correctedBlockID,
        markdown: '腕戴设备可识别排卵。',
    }]);
    assert.deepEqual(reconciled.sourceBlocks, [{
        id: correctedBlockID,
        markdown: correctedSource,
    }]);
});

test('requires targeted retranslation after deleting semantic text', async () => {
    const originalSource = 'Wrist-worn devices identify ovulation.';
    const correctedSource = 'Wrist-worn devices identify.';
    const originalBlockID = `translation-0-0-${originalSource.length}-paragraph`;
    const correctedBlockID = `translation-0-0-${correctedSource.length}-paragraph`;
    const service = new MarkdownTranslationService({
        aiGateway: { generateText: assert.fail },
        cache: {
            getTranslation: async () => null,
            getTranslationByLanguage: async () => null,
            putTranslation: async () => {},
        },
        getSettings: () => SETTINGS,
        createCacheKey: async () => 'd'.repeat(64),
    });

    const reconciled = await service.reconcileDocumentTranslation({
        documentKey: 'a'.repeat(64),
        markdown: correctedSource,
        existingTranslation: {
            documentKey: 'a'.repeat(64),
            sourceMarkdown: originalSource,
            translationKey: 'c'.repeat(64),
            settingsIdentity: documentSettingsIdentity(),
            translatedMarkdown: '腕戴设备可识别排卵。',
            comparisonMarkdown: '',
            blocks: [{
                id: originalBlockID,
                markdown: '腕戴设备可识别排卵。',
            }],
            sourceBlocks: [{
                id: originalBlockID,
                markdown: originalSource,
            }],
            targetLanguage: 'zh-CN',
            partial: false,
            failedBlocks: [],
        },
    });

    assert.equal(reconciled.partial, true);
    assert.equal(reconciled.translatedMarkdown, correctedSource);
    assert.deepEqual(reconciled.pendingBlockIDs, [correctedBlockID]);
});

test('reserves an exact translation while matching a deleted marker', async () => {
    const originalSource = 'Marker (1).\n\nMarker (2).';
    const correctedSource = 'Marker.\n\nMarker (2).';
    const service = new MarkdownTranslationService({
        aiGateway: { generateText: assert.fail },
        cache: {
            getTranslation: async () => null,
            getTranslationByLanguage: async () => null,
            putTranslation: async () => {},
        },
        getSettings: () => SETTINGS,
        createCacheKey: async () => 'd'.repeat(64),
    });

    const reconciled = await service.reconcileDocumentTranslation({
        documentKey: 'a'.repeat(64),
        markdown: correctedSource,
        existingTranslation: {
            documentKey: 'a'.repeat(64),
            sourceMarkdown: originalSource,
            translationKey: 'c'.repeat(64),
            settingsIdentity: documentSettingsIdentity(),
            translatedMarkdown: '标记一。\n\n标记二。',
            comparisonMarkdown: '',
            blocks: [{
                id: 'translation-0-0-11-paragraph',
                markdown: '标记一。',
            }, {
                id: 'translation-1-13-24-paragraph',
                markdown: '标记二。',
            }],
            sourceBlocks: [{
                id: 'translation-0-0-11-paragraph',
                markdown: 'Marker (1).',
            }, {
                id: 'translation-1-13-24-paragraph',
                markdown: 'Marker (2).',
            }],
            targetLanguage: 'zh-CN',
            partial: false,
            failedBlocks: [],
        },
    });

    assert.equal(reconciled.partial, false);
    assert.equal(reconciled.translatedMarkdown, '标记一。\n\n标记二。');
    assert.deepEqual(reconciled.pendingBlockIDs, []);
});

test('rebuilds missing visible translation sources before reconciling a correction', async () => {
    const originalSource = '# Paper\n\nUnchanged paragraph.';
    const correctedSource = '# Study\n\nUnchanged paragraph.';
    const service = new MarkdownTranslationService({
        aiGateway: { generateText: assert.fail },
        cache: {
            getTranslation: async () => null,
            getTranslationByLanguage: async () => null,
        },
        getSettings: () => SETTINGS,
        createCacheKey: async () => 'd'.repeat(64),
    });

    const reconciled = await service.reconcileDocumentTranslation({
        documentKey: 'a'.repeat(64),
        markdown: correctedSource,
        existingTranslation: {
            documentKey: 'a'.repeat(64),
            sourceMarkdown: originalSource,
            translationKey: 'c'.repeat(64),
            settingsIdentity: documentSettingsIdentity(),
            translatedMarkdown: '# 论文\n\n未修改段落。',
            comparisonMarkdown: '',
            blocks: [{
                id: 'translation-0-0-7-heading',
                markdown: '# 论文',
            }, {
                id: 'translation-1-9-29-paragraph',
                markdown: '未修改段落。',
            }],
            targetLanguage: 'zh-CN',
            partial: false,
            failedBlocks: [],
        },
    });

    assert.ok(reconciled);
    assert.equal(reconciled.partial, true);
    assert.equal(reconciled.translatedMarkdown, '# Study\n\n未修改段落。');
    assert.deepEqual(reconciled.pendingBlockIDs, [
        'translation-0-0-7-heading',
    ]);
});

test('does not reuse source blocks across translation setting identities', async () => {
    const service = new MarkdownTranslationService({
        aiGateway: { generateText: assert.fail },
        cache: {
            getTranslation: async () => null,
            getTranslationByLanguage: async (_documentKey, language) => (
                language === 'zh-CN' ? {
                    translatedMarkdown: '旧译文。',
                    comparisonMarkdown: '',
                    blocks: [{
                        id: 'translation-0-0-10-paragraph',
                        markdown: '旧译文。',
                    }],
                    sourceBlocks: [{
                        id: 'translation-0-0-10-paragraph',
                        markdown: 'Paragraph.',
                    }],
                    settingsIdentity: documentSettingsIdentity({
                        model: 'previous-model',
                    }),
                    model: 'previous-model',
                    targetLanguage: 'zh-CN',
                    promptVersion: TRANSLATION_PROMPT_VERSION,
                    partial: false,
                    failedBlocks: [],
                } : null
            ),
            putTranslation: assert.fail,
        },
        getSettings: () => SETTINGS,
        createCacheKey: async () => 'd'.repeat(64),
    });

    const restored = await service.listCachedDocumentTranslationVariants({
        documentKey: 'a'.repeat(64),
        markdown: 'Paragraph.',
    });

    assert.deepEqual(restored, []);
});

test('reuses unchanged translations and retranslates only an edited block', async () => {
    const oldSource = 'First paragraph.\n\nSecond paragraph.';
    const newSource = 'Edited first paragraph.\n\nSecond paragraph.';
    const oldTranslation = {
        documentKey: 'a'.repeat(64),
        sourceMarkdown: oldSource,
        translationKey: 'c'.repeat(64),
        settingsIdentity: documentSettingsIdentity(),
        translatedMarkdown: '第一段。\n\n第二段。',
        comparisonMarkdown: '',
        blocks: [{
            id: 'translation-0-0-16-paragraph',
            markdown: '第一段。',
        }, {
            id: 'translation-1-18-35-paragraph',
            markdown: '第二段。',
        }],
        sourceBlocks: [{
            id: 'translation-0-0-16-paragraph',
            markdown: 'First paragraph.',
        }, {
            id: 'translation-1-18-35-paragraph',
            markdown: 'Second paragraph.',
        }],
        targetLanguage: 'zh-CN',
        model: 'cached-model',
        promptVersion: TRANSLATION_PROMPT_VERSION,
        partial: false,
        failedBlocks: [],
    };
    const requests = [];
    const writes = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                const entries = parseTranslationRequest(
                    request.messages[1].content
                );
                requests.push(entries);
                return {
                    text: JSON.stringify(entries.map(entry => ({
                        id: entry.id,
                        translatedMarkdown: '修改后的第一段。',
                    }))),
                };
            },
        },
        cache: {
            getTranslation: async () => null,
            getTranslationByLanguage: async () => null,
            putTranslation: async (...args) => writes.push(args),
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'd'.repeat(64),
    });

    const reconciled = await service.reconcileDocumentTranslation({
        documentKey: 'a'.repeat(64),
        markdown: newSource,
        existingTranslation: oldTranslation,
    });
    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: newSource,
        existingTranslation: reconciled,
        retryBlockIDs: reconciled.pendingBlockIDs,
    });

    assert.equal(reconciled.partial, true);
    assert.deepEqual(reconciled.pendingBlockIDs, [
        'translation-0-0-23-paragraph',
    ]);
    assert.equal(
        reconciled.translatedMarkdown,
        'Edited first paragraph.\n\n第二段。'
    );
    assert.equal(writes[0][1], 'c'.repeat(64));
    assert.deepEqual(writes[0][2].sourceBlocks, oldTranslation.sourceBlocks);
    assert.deepEqual(requests, [[{
        id: 'translation-0-0-23-paragraph',
        sourceMarkdown: 'Edited first paragraph.',
    }]]);
    assert.equal(
        result.translatedMarkdown,
        '修改后的第一段。\n\n第二段。'
    );
    assert.equal(result.partial, false);
});

test('rejects caches from the previous reference protection protocol', async () => {
    const cacheErrors = [];
    const service = new MarkdownTranslationService({
        aiGateway: { generateText: assert.fail },
        cache: {
            getTranslation: async () => ({
                translatedMarkdown: '# 论文',
                comparisonMarkdown: '# Paper\n\n# 论文',
                blocks: [{
                    id: 'translation-0-0-7-heading',
                    markdown: '# 论文',
                }],
                model: 'cached-model',
                targetLanguage: 'zh-CN',
                promptVersion: 'mktero-translation-v6',
                partial: false,
                failedBlocks: [],
            }),
            putTranslation: assert.fail,
        },
        getSettings: () => SETTINGS,
        createCacheKey: async () => 'c'.repeat(64),
        onCacheError: error => cacheErrors.push(error.message),
    });

    const result = await service.getCachedDocumentTranslation({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
    });

    assert.equal(result, null);
    assert.deepEqual(cacheErrors, [
        'The cached document translation identity changed',
    ]);
});

test('reuses a complete cache when the visible translation uses another language', async () => {
    const cached = {
        translatedMarkdown: '# Article français',
        comparisonMarkdown: '# Paper\n\n# Article français',
        blocks: [{
            id: 'translation-0-0-7-heading',
            markdown: '# Article français',
        }],
        model: 'cached-model',
        targetLanguage: 'fr-FR',
        promptVersion: TRANSLATION_PROMPT_VERSION,
        partial: false,
        failedBlocks: [],
    };
    const service = new MarkdownTranslationService({
        aiGateway: { generateText: assert.fail },
        cache: {
            getTranslation: async () => cached,
            putTranslation: assert.fail,
        },
        getSettings: () => ({ ...SETTINGS, targetLanguage: 'fr-FR' }),
        createCacheKey: async () => 'd'.repeat(64),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
        existingTranslation: {
            translationKey: 'c'.repeat(64),
            blocks: [{
                id: 'translation-0-0-7-heading',
                markdown: '# \u8bba\u6587',
            }],
            failedBlocks: [],
            targetLanguage: 'zh-CN',
        },
    });

    assert.equal(result.cacheHit, true);
    assert.equal(result.targetLanguage, 'fr-FR');
    assert.equal(result.translatedMarkdown, '# Article français');
});

test('reports cached partial translations but retries them on explicit translation', async () => {
    const blockID = 'translation-0-0-7-heading';
    const cached = {
        translatedMarkdown: '# Paper',
        comparisonMarkdown: '# Paper\n\n> # Paper',
        blocks: [{ id: blockID, markdown: '# Paper' }],
        model: 'cached-model',
        targetLanguage: 'zh-CN',
        promptVersion: TRANSLATION_PROMPT_VERSION,
        partial: true,
        failedBlocks: [{ id: blockID, message: 'Invalid response' }],
    };
    let providerCalls = 0;
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                providerCalls++;
                return {
                    text: translateSingleBlockRequest(
                        request.messages[1].content,
                        '# 论文'
                    ),
                };
            },
        },
        cache: {
            getTranslation: async () => cached,
            putTranslation: async () => {},
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    const restored = await service.getCachedDocumentTranslation({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
    });
    const retried = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
    });

    assert.equal(restored.partial, true);
    assert.equal(restored.completedBlocks, 0);
    assert.equal(retried.partial, false);
    assert.equal(retried.translatedMarkdown, '# 论文');
    assert.equal(providerCalls, 1);
});

test('resumes a selected partial language while another language is visible', async () => {
    const markdown = '# Paper\n\nParagraph.';
    const headingID = 'translation-0-0-7-heading';
    const paragraphID = 'translation-1-9-19-paragraph';
    const cachedFrench = {
        translatedMarkdown: '# Article\n\nParagraph.',
        comparisonMarkdown: '',
        blocks: [{
            id: headingID,
            markdown: '# Article',
        }, {
            id: paragraphID,
            markdown: 'Paragraph.',
        }],
        model: 'cached-model',
        targetLanguage: 'fr-FR',
        promptVersion: TRANSLATION_PROMPT_VERSION,
        partial: true,
        failedBlocks: [{
            id: paragraphID,
            message: 'Invalid response',
        }],
    };
    const requests = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                requests.push(request);
                return {
                    text: translateSingleBlockRequest(
                        request.messages[1].content,
                        'Paragraphe.'
                    ),
                };
            },
        },
        cache: {
            getTranslation: async (_documentKey, translationKey) => (
                translationKey === 'f'.repeat(64) ? cachedFrench : null
            ),
            putTranslation: async () => {},
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async value => (
            JSON.parse(value).targetLanguage === 'fr-FR'
                ? 'f'.repeat(64)
                : 'j'.repeat(64)
        ),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown,
        targetLanguage: 'fr-FR',
        existingTranslation: {
            translationKey: 'j'.repeat(64),
            blocks: [{ id: headingID, markdown: '# \u8ad6\u6587' }],
            failedBlocks: [],
            targetLanguage: 'ja-JP',
        },
    });

    assert.equal(requests.length, 1);
    assert.match(requests[0].messages[0].content, /French/);
    assert.deepEqual(
        parseTranslationRequest(requests[0].messages[1].content),
        [{ id: paragraphID, sourceMarkdown: 'Paragraph.' }]
    );
    assert.equal(result.partial, false);
    assert.equal(result.targetLanguage, 'fr-FR');
    assert.equal(result.translatedMarkdown, '# Article\n\nParagraphe.');
});

test('treats a cached translation with a missing block as partial and repairs it', async () => {
    const markdown = '# Paper\n\nParagraph.';
    const headingID = 'translation-0-0-7-heading';
    const paragraphID = 'translation-1-9-19-paragraph';
    const cached = {
        translatedMarkdown: '# \u8bba\u6587\n\nParagraph.',
        comparisonMarkdown: '',
        blocks: [{ id: headingID, markdown: '# \u8bba\u6587' }],
        model: 'cached-model',
        targetLanguage: 'zh-CN',
        promptVersion: TRANSLATION_PROMPT_VERSION,
        partial: false,
        failedBlocks: [],
    };
    const requests = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                const entries = parseTranslationRequest(
                    request.messages[1].content
                );
                requests.push(entries);
                return {
                    text: JSON.stringify([{
                        id: paragraphID,
                        translatedMarkdown: '\u6bb5\u843d\u3002',
                    }]),
                };
            },
        },
        cache: {
            getTranslation: async () => cached,
            putTranslation: async () => {},
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    const restored = await service.getCachedDocumentTranslation({
        documentKey: 'a'.repeat(64),
        markdown,
    });
    const repaired = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown,
    });

    assert.equal(restored.partial, true);
    assert.deepEqual(restored.failedBlocks, [{
        id: paragraphID,
        message: 'Cached translation is incomplete',
    }]);
    assert.deepEqual(requests, [[{
        id: paragraphID,
        sourceMarkdown: 'Paragraph.',
    }]]);
    assert.equal(repaired.partial, false);
    assert.equal(repaired.translatedMarkdown, '# \u8bba\u6587\n\n\u6bb5\u843d\u3002');
});

test('retries only failed cached blocks and preserves successful translations', async () => {
    const headingID = 'translation-0-0-7-heading';
    const paragraphID = 'translation-1-9-19-paragraph';
    const cached = {
        translatedMarkdown: '# 论文\n\nParagraph.',
        comparisonMarkdown: [
            '# Paper',
            '',
            '> # 论文',
            '',
            'Paragraph.',
            '',
            '> Paragraph.',
        ].join('\n'),
        blocks: [{
            id: headingID,
            markdown: '# 论文',
        }, {
            id: paragraphID,
            markdown: 'Paragraph.',
        }],
        model: 'cached-model',
        targetLanguage: 'zh-CN',
        promptVersion: TRANSLATION_PROMPT_VERSION,
        partial: true,
        failedBlocks: [{ id: paragraphID, message: 'Invalid response' }],
    };
    const requests = [];
    const writes = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                const entries = parseTranslationRequest(
                    request.messages[1].content
                );
                requests.push(entries);
                return {
                    text: JSON.stringify([{
                        id: entries[0].id,
                        translatedMarkdown: '译文。',
                    }]),
                };
            },
        },
        cache: {
            getTranslation: async () => cached,
            putTranslation: async (...args) => writes.push(args),
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper\n\nParagraph.',
    });

    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0], [{
        id: paragraphID,
        sourceMarkdown: 'Paragraph.',
    }]);
    assert.equal(result.translatedMarkdown, '# 论文\n\n译文。');
    assert.deepEqual(result.blocks, [{
        id: headingID,
        markdown: '# 论文',
    }, {
        id: paragraphID,
        markdown: '译文。',
    }]);
    assert.equal(result.partial, false);
    assert.equal(result.completedBlocks, 2);
    assert.equal(writes[0][2].partial, false);
});

test('retries one failed block from the visible result without a cache read', async () => {
    const markdown = '# Paper\n\nFirst paragraph.\n\nSecond paragraph.';
    const headingID = 'translation-0-0-7-heading';
    const firstID = 'translation-1-9-25-paragraph';
    const secondID = 'translation-2-27-44-paragraph';
    const requests = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                const entries = parseTranslationRequest(
                    request.messages[1].content
                );
                requests.push(entries);
                return {
                    text: JSON.stringify([{
                        id: entries[0].id,
                        translatedMarkdown: '\u7b2c\u4e00\u6bb5\u3002',
                    }]),
                };
            },
        },
        cache: {
            getTranslation: async () => null,
            putTranslation: async () => {},
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown,
        retryBlockIDs: [firstID],
        existingTranslation: {
            translationKey: 'c'.repeat(64),
            blocks: [{ id: headingID, markdown: '# \u8bba\u6587' }, {
                id: firstID,
                markdown: 'First paragraph.',
            }, {
                id: secondID,
                markdown: 'Second paragraph.',
            }],
            failedBlocks: [{ id: firstID, message: 'Invalid response' }, {
                id: secondID,
                message: 'Timed out',
            }],
            targetLanguage: 'zh-CN',
        },
    });

    assert.deepEqual(requests, [[{
        id: firstID,
        sourceMarkdown: 'First paragraph.',
    }]]);
    assert.equal(
        result.translatedMarkdown,
        '# \u8bba\u6587\n\n\u7b2c\u4e00\u6bb5\u3002\n\nSecond paragraph.'
    );
    assert.deepEqual(result.failedBlocks, [{
        id: secondID,
        message: 'Timed out',
    }]);
    assert.equal(result.completedBlocks, 2);
    assert.equal(result.partial, true);
});

test('retranslates one successful block and preserves the other visible translations', async () => {
    const markdown = '# Paper\n\nFirst paragraph.\n\nSecond paragraph.';
    const headingID = 'translation-0-0-7-heading';
    const firstID = 'translation-1-9-25-paragraph';
    const secondID = 'translation-2-27-44-paragraph';
    const requests = [];
    const progress = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                const entries = parseTranslationRequest(
                    request.messages[1].content
                );
                requests.push(entries);
                return {
                    text: JSON.stringify([{
                        id: firstID,
                        translatedMarkdown: '\u91cd\u8bd1\u7b2c\u4e00\u6bb5\u3002',
                    }]),
                };
            },
        },
        cache: {
            getTranslation: async () => null,
            putTranslation: async () => {},
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown,
        retryBlockIDs: [firstID],
        existingTranslation: {
            translationKey: 'c'.repeat(64),
            blocks: [{ id: headingID, markdown: '# \u8bba\u6587' }, {
                id: firstID,
                markdown: '\u7b2c\u4e00\u6bb5\u3002',
            }, {
                id: secondID,
                markdown: '\u7b2c\u4e8c\u6bb5\u3002',
            }],
            failedBlocks: [],
            targetLanguage: 'zh-CN',
        },
        onProgress: value => progress.push(value),
    });

    assert.deepEqual(requests, [[{
        id: firstID,
        sourceMarkdown: 'First paragraph.',
    }]]);
    assert.equal(
        result.translatedMarkdown,
        '# \u8bba\u6587\n\n\u91cd\u8bd1\u7b2c\u4e00\u6bb5\u3002\n\n\u7b2c\u4e8c\u6bb5\u3002'
    );
    assert.equal(result.partial, false);
    assert.deepEqual(progress[0], {
        stage: 'preparing',
        completed: 2,
        total: 3,
    });
    assert.ok(progress.every(value => (
        value.completed === undefined || value.completed <= value.total
    )));
});

test('retranslates one successful block when cache hashing is unavailable', async () => {
    const markdown = '# Paper\n\nFirst paragraph.\n\nSecond paragraph.';
    const headingID = 'translation-0-0-7-heading';
    const firstID = 'translation-1-9-25-paragraph';
    const secondID = 'translation-2-27-44-paragraph';
    const requests = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                const entries = parseTranslationRequest(
                    request.messages[1].content
                );
                requests.push(entries);
                const secondRequest = requests.length === 2;
                const translated = new Map([
                    [headingID, '# \u8bba\u6587'],
                    [firstID, secondRequest
                        ? '\u91cd\u8bd1\u7b2c\u4e00\u6bb5\u3002'
                        : '\u7b2c\u4e00\u6bb5\u3002'],
                    [secondID, '\u7b2c\u4e8c\u6bb5\u3002'],
                ]);
                return {
                    text: JSON.stringify(entries.map(entry => ({
                        id: entry.id,
                        translatedMarkdown: translated.get(entry.id),
                    }))),
                };
            },
        },
        cache: {
            getTranslation: assert.fail,
            putTranslation: assert.fail,
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => null,
    });
    const first = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown,
    });
    const second = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown,
        retryBlockIDs: [firstID],
        existingTranslation: first,
    });

    assert.deepEqual(requests[1], [{
        id: firstID,
        sourceMarkdown: 'First paragraph.',
    }]);
    assert.equal(
        second.translatedMarkdown,
        '# \u8bba\u6587\n\n\u91cd\u8bd1\u7b2c\u4e00\u6bb5\u3002\n\n\u7b2c\u4e8c\u6bb5\u3002'
    );
    assert.equal(second.translationKey, null);
});

test('forces a fresh full translation instead of returning a complete cache hit', async () => {
    const markdown = '# Paper\n\nParagraph.';
    const requests = [];
    const progress = [];
    const cached = {
        translatedMarkdown: '# \u8bba\u6587\n\n\u6bb5\u843d\u3002',
        blocks: [{
            id: 'translation-0-0-7-heading',
            markdown: '# \u8bba\u6587',
        }, {
            id: 'translation-1-9-19-paragraph',
            markdown: '\u6bb5\u843d\u3002',
        }],
        model: 'cached-model',
        targetLanguage: 'zh-CN',
        promptVersion: TRANSLATION_PROMPT_VERSION,
        partial: false,
        failedBlocks: [],
    };
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                const entries = parseTranslationRequest(
                    request.messages[1].content
                );
                requests.push(entries);
                return {
                    text: JSON.stringify(entries.map(entry => ({
                        id: entry.id,
                        translatedMarkdown: entry.id.includes('heading')
                            ? '# \u65b0\u8bba\u6587'
                            : '\u65b0\u6bb5\u843d\u3002',
                    }))),
                };
            },
        },
        cache: {
            getTranslation: async () => cached,
            putTranslation: async () => {},
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown,
        forceRetranslate: true,
        existingTranslation: {
            ...cached,
            translationKey: 'c'.repeat(64),
        },
        onProgress: value => progress.push(value),
    });

    assert.deepEqual(requests.flat().map(entry => entry.id), [
        'translation-0-0-7-heading',
        'translation-1-9-19-paragraph',
    ]);
    assert.equal(result.translatedMarkdown, '# \u65b0\u8bba\u6587\n\n\u65b0\u6bb5\u843d\u3002');
    assert.equal(result.cacheHit, false);
    assert.deepEqual(progress[0], {
        stage: 'preparing',
        completed: 0,
        total: 2,
    });
});

test('does not replace a complete cache with a partial retranslation', async () => {
    const cached = {
        translatedMarkdown: '# \u8bba\u6587',
        blocks: [{
            id: 'translation-0-0-7-heading',
            markdown: '# \u8bba\u6587',
        }],
        model: 'cached-model',
        targetLanguage: 'zh-CN',
        promptVersion: TRANSLATION_PROMPT_VERSION,
        partial: false,
        failedBlocks: [],
    };
    const writes = [];
    let providerCalls = 0;
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                providerCalls++;
                return {
                    text: translateSingleBlockRequest(
                        request.messages[1].content,
                        '<script>invalid</script>'
                    ),
                };
            },
        },
        cache: {
            getTranslation: async () => cached,
            putTranslation: async (...args) => writes.push(args),
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper',
        forceRetranslate: true,
        existingTranslation: {
            ...cached,
            translationKey: 'c'.repeat(64),
        },
    });

    assert.equal(providerCalls, 3);
    assert.equal(result.partial, true);
    assert.equal(result.cacheStatus, 'complete');
    assert.deepEqual(writes, []);
});

test('retranslates every block when a visible retry uses changed settings', async () => {
    const markdown = '# Paper\n\nFirst paragraph.\n\nSecond paragraph.';
    const headingID = 'translation-0-0-7-heading';
    const firstID = 'translation-1-9-25-paragraph';
    const secondID = 'translation-2-27-44-paragraph';
    const requests = [];
    const writes = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                const entries = parseTranslationRequest(
                    request.messages[1].content
                );
                requests.push(entries);
                const translations = new Map([
                    [headingID, '# Article français'],
                    [firstID, 'Premier paragraphe.'],
                    [secondID, 'Deuxième paragraphe.'],
                ]);
                return {
                    text: JSON.stringify(entries.map(entry => ({
                        id: entry.id,
                        translatedMarkdown: translations.get(entry.id),
                    }))),
                };
            },
        },
        cache: {
            getTranslation: async () => null,
            putTranslation: async (...args) => writes.push(args),
        },
        getSettings: () => ({
            ...SETTINGS,
            streaming: false,
            targetLanguage: 'fr-FR',
        }),
        createCacheKey: async () => 'd'.repeat(64),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown,
        retryBlockIDs: [firstID],
        existingTranslation: {
            translationKey: 'c'.repeat(64),
            blocks: [{ id: headingID, markdown: '# \u8bba\u6587' }, {
                id: firstID,
                markdown: 'First paragraph.',
            }, {
                id: secondID,
                markdown: '\u7b2c\u4e8c\u6bb5\u3002',
            }],
            failedBlocks: [{ id: firstID, message: 'Invalid response' }],
            targetLanguage: 'zh-CN',
        },
    });

    assert.deepEqual(requests.flat().map(entry => entry.id), [
        headingID,
        firstID,
        secondID,
    ]);
    assert.equal(result.targetLanguage, 'fr-FR');
    assert.equal(result.translationKey, 'd'.repeat(64));
    assert.equal(result.partial, false);
    assert.doesNotMatch(result.translatedMarkdown, /\u8bba\u6587|\u7b2c\u4e8c\u6bb5/);
    assert.equal(writes[0][1], 'd'.repeat(64));
    assert.equal(writes[0][2].targetLanguage, 'fr-FR');
});

test('keeps source blocks and caches a structurally incomplete partial response', async () => {
    let calls = 0;
    const cached = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText() {
                calls++;
                return { text: '# 论文' };
            },
        },
        cache: {
            getTranslation: async () => null,
            putTranslation: async (...args) => cached.push(args),
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper\n\nParagraph.',
    });

    assert.equal(result.translatedMarkdown, '# Paper\n\nParagraph.');
    assert.equal(result.partial, true);
    assert.equal(result.completedBlocks, 0);
    assert.equal(result.failedBlocks.length, 2);
    assert.equal(calls, 5);
    assert.equal(cached.length, 1);
    assert.equal(cached[0][2].partial, true);
    assert.deepEqual(cached[0][2].failedBlocks, result.failedBlocks);
});

test('keeps source blocks when a document response reaches the output limit', async () => {
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText() {
                return {
                    text: '部分译文',
                    finishReason: 'length',
                };
            },
        },
        cache: {
            getTranslation: async () => null,
            putTranslation: async () => {},
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: 'One paragraph.',
    });

    assert.equal(result.translatedMarkdown, 'One paragraph.');
    assert.equal(result.partial, true);
    assert.equal(result.completedBlocks, 0);
});

test('keeps source blocks when a streamed response reaches the output limit', async () => {
    const service = new MarkdownTranslationService({
        aiGateway: {
            generateText: assert.fail,
            async streamText() {
                return {
                    text: '部分译文',
                    finishReason: 'length',
                };
            },
        },
        cache: {
            getTranslation: async () => null,
            putTranslation: async () => {},
        },
        getSettings: () => ({ ...SETTINGS, streaming: true }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: 'One paragraph.',
    });

    assert.equal(result.translatedMarkdown, 'One paragraph.');
    assert.equal(result.partial, true);
    assert.equal(result.completedBlocks, 0);
});

test('stops a complete document translation when canceled', async () => {
    const controller = new AbortController();
    let calls = 0;
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText() {
                calls++;
                controller.abort();
                return { text: '# 论文' };
            },
        },
        cache: {
            getTranslation: async () => null,
            putTranslation: assert.fail,
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    await assert.rejects(() => service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper\n\nParagraph.',
        signal: controller.signal,
    }), error => error?.name === 'AbortError');
    assert.equal(calls, 1);
});

test('translates H1 sections with at most five concurrent requests and restores source order', async () => {
    let active = 0;
    let maximumActive = 0;
    const requests = [];
    const gates = new Map();
    const requestWaiters = [];
    const notifyRequest = () => {
        for (let index = requestWaiters.length - 1; index >= 0; index--) {
            if (requests.length < requestWaiters[index].count) continue;
            requestWaiters[index].resolve();
            requestWaiters.splice(index, 1);
        }
    };
    const waitForRequestCount = count => requests.length >= count
        ? Promise.resolve()
        : new Promise(resolve => requestWaiters.push({ count, resolve }));
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                active++;
                maximumActive = Math.max(maximumActive, active);
                const requestMarkdown = request.messages[1].content;
                const title = parseTranslationRequest(requestMarkdown)
                    .find(entry => entry.sourceMarkdown.startsWith('# '))
                    ?.sourceMarkdown || '';
                const index = Number(title.match(/Section (\d+)/)?.[1] || 0);
                requests.push({ index, requestMarkdown });
                notifyRequest();
                const gate = deferred();
                gates.set(index, gate);
                await gate.promise;
                active--;
                return {
                    text: translateMarkedSection(requestMarkdown, `# 翻译 ${index}`),
                    model: 'provider-model',
                    usage: { totalTokens: 10 },
                };
            },
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => null,
    });
    const source = Array.from({ length: 7 }, (_, index) => [
        `# Section ${index}`,
        '',
        `Paragraph ${index}.`,
    ].join('\n')).join('\n\n');

    const result = service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: source,
    });

    await waitForRequestCount(5);
    gates.get(4).resolve();
    await waitForRequestCount(6);
    gates.get(5).resolve();
    await waitForRequestCount(7);
    gates.get(6).resolve();
    for (const index of [3, 2, 1, 0]) gates.get(index).resolve();

    const completed = await result;

    assert.equal(requests.length, 7);
    assert.equal(maximumActive, 5);
    assert.deepEqual(
        [...completed.translatedMarkdown.matchAll(/^# 翻译 (\d+)$/gm)]
            .map(match => Number(match[1])),
        [0, 1, 2, 3, 4, 5, 6]
    );
    assert.equal(completed.usage.totalTokens, 70);
});

test('splits a long H1 section into bounded batches and restores paragraph order', async () => {
    const requests = [];
    let active = 0;
    let maximumActive = 0;
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                active++;
                maximumActive = Math.max(maximumActive, active);
                requests.push(request.messages[1].content);
                await Promise.resolve();
                active--;
                return {
                    text: translateBatchRequest(
                        request.messages[1].content,
                        sourceMarkdown => sourceMarkdown
                            .replace('# One section', '# 一个章节')
                            .replace(/Paragraph (\d+)\./g, '译文段落 $1。')
                    ),
                    model: 'provider-model',
                    usage: { totalTokens: 10 },
                };
            },
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => null,
    });
    const source = [
        '# One section',
        ...Array.from({ length: 17 }, (_, index) => [
            '',
            `Paragraph ${index}.`,
        ]).flat(),
    ].join('\n');

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: source,
    });

    assert.equal(requests.length, 3);
    assert.ok(maximumActive <= 5);
    assert.deepEqual(
        requests.map(request => parseTranslationRequest(request).length),
        [8, 8, 2]
    );
    assert.deepEqual(
        [...result.translatedMarkdown.matchAll(/^译文段落 (\d+)。$/gm)]
            .map(match => Number(match[1])),
        Array.from({ length: 17 }, (_, index) => index)
    );
    assert.equal(result.usage.totalTokens, 30);
});

test('retries only a missing block from an otherwise valid batch', async () => {
    const requests = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                const entries = parseTranslationRequest(
                    request.messages[1].content
                );
                requests.push(entries);
                if (requests.length === 1) {
                    return {
                        text: JSON.stringify([{
                            id: entries[0].id,
                            translatedMarkdown: '# 论文',
                        }]),
                    };
                }
                return {
                    text: JSON.stringify([{
                        id: entries[0].id,
                        translatedMarkdown: '译文。',
                    }]),
                };
            },
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => null,
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper\n\nParagraph.',
    });

    assert.deepEqual(requests.map(entries => entries.length), [2, 1]);
    assert.equal(requests[1][0].sourceMarkdown, 'Paragraph.');
    assert.equal(result.translatedMarkdown, '# 论文\n\n译文。');
});

test('falls back to translating only text segments after protected content retries fail', async () => {
    const paragraph = [
        'As analyzed in Sec. S5, the proposed NARI and NARF are induced jointly',
        'by the structures of model and human neural representations. We visualize',
        'such structures (the Gram matrices $X_{c}^{\\top}X_{c}$ and',
        '$Y_{c}Y_{c}^{\\top}$ of centered data as described in Sec. S5) for',
        'different models and human subjects in Fig. S3, considering 34 transitive',
        'reasoning problems. Results show that the structures vary among different',
        'models, layers of the same models, and different human subjects. Therefore,',
        'the joint effect of them in NARI/NARF would be sample-specific, motivating',
        'our multi-subject integration approach to capture robust improvement signals.',
    ].join(' ');
    const figure = '![Figure S3. Neural structures.](images/s3.png)';
    const markdown = `${paragraph}\n\n${figure}`;
    const requests = [];
    const writes = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                const entries = parseTranslationRequest(
                    request.messages[1].content
                );
                requests.push(entries);
                if ('sourceText' in entries[0]) {
                    return {
                        text: JSON.stringify(entries.map(entry => ({
                            id: entry.id,
                            translatedText: `译${entry.id}`,
                        }))),
                    };
                }
                return {
                    text: JSON.stringify(entries.map(entry => ({
                        id: entry.id,
                        translatedMarkdown: entry.sourceMarkdown.includes(
                            'Gram matrices'
                        )
                            ? entry.sourceMarkdown.replace(
                                /MKTEROPROTECTED\d+PLACEHOLDER/,
                                ''
                            )
                            : entry.sourceMarkdown,
                    }))),
                };
            },
        },
        cache: {
            getTranslation: async () => null,
            putTranslation: async (...args) => writes.push(args),
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown,
    });

    assert.equal(requests.length, 4);
    assert.equal(requests[0].length, 2);
    assert.deepEqual(requests.slice(1, 3).map(entries => entries.length), [1, 1]);
    assert.ok(requests[3].every(entry => 'sourceText' in entry));
    assert.doesNotMatch(
        JSON.stringify(requests[3]),
        /MKTEROPROTECTED|X_\{c\}|Y_\{c\}|Fig\. S3/
    );
    assert.equal(result.partial, false);
    assert.deepEqual(result.failedBlocks, []);
    assert.equal(result.translatedMarkdown.match(/\$X_\{c\}/g)?.length, 1);
    assert.equal(result.translatedMarkdown.match(/\$Y_\{c\}/g)?.length, 1);
    assert.equal(result.translatedMarkdown.match(/Fig\. S3/g)?.length, 1);
    assert.equal(writes.length, 1);
    assert.equal(writes[0][2].partial, false);
    assert.deepEqual(writes[0][2].failedBlocks, []);
});

for (const { name, fallbackResponse, messagePattern } of [{
    name: 'missing',
    fallbackResponse: entries => [{
        id: entries[0].id,
        translatedText: '比较',
    }],
    messagePattern: /omitted.*segment/i,
}, {
    name: 'duplicate',
    fallbackResponse: entries => [{
        id: entries[0].id,
        translatedText: '比较',
    }, {
        id: entries[0].id,
        translatedText: '对比',
    }, {
        id: entries[1].id,
        translatedText: '和',
    }],
    messagePattern: /duplicate.*segment/i,
}, {
    name: 'unknown',
    fallbackResponse: entries => [...entries.map(entry => ({
        id: entry.id,
        translatedText: '译文',
    })), {
        id: 'unknown-segment',
        translatedText: '注入内容',
    }],
    messagePattern: /unknown.*segment/i,
}]) {
    test(`keeps the source after a ${name} protected text segment response`, async () => {
        let calls = 0;
        const source = 'Compare $x$ and $y$.';
        const service = new MarkdownTranslationService({
            aiGateway: {
                async generateText(request) {
                    calls++;
                    const entries = parseTranslationRequest(
                        request.messages[1].content
                    );
                    if ('sourceText' in entries[0]) {
                        return { text: JSON.stringify(fallbackResponse(entries)) };
                    }
                    return {
                        text: JSON.stringify(entries.map(entry => ({
                            id: entry.id,
                            translatedMarkdown: entry.sourceMarkdown.replace(
                                /MKTEROPROTECTED\d+PLACEHOLDER/,
                                ''
                            ),
                        }))),
                    };
                },
            },
            getSettings: () => ({ ...SETTINGS, streaming: false }),
            createCacheKey: async () => null,
        });

        const result = await service.translateDocument({
            documentKey: 'a'.repeat(64),
            markdown: source,
        });

        assert.equal(calls, 4);
        assert.equal(result.translatedMarkdown, source);
        assert.equal(result.partial, true);
        assert.match(result.failedBlocks[0].message, messagePattern);
    });
}

test('keeps the source when the protected text fallback reaches its output limit', async () => {
    let calls = 0;
    const source = 'Compare $x$ and $y$.';
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                calls++;
                const entries = parseTranslationRequest(
                    request.messages[1].content
                );
                if ('sourceText' in entries[0]) {
                    return {
                        text: JSON.stringify(entries.map(entry => ({
                            id: entry.id,
                            translatedText: '译文',
                        }))),
                        finishReason: 'length',
                    };
                }
                return {
                    text: JSON.stringify(entries.map(entry => ({
                        id: entry.id,
                        translatedMarkdown: entry.sourceMarkdown.replace(
                            /MKTEROPROTECTED\d+PLACEHOLDER/,
                            ''
                        ),
                    }))),
                };
            },
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => null,
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: source,
    });

    assert.equal(calls, 4);
    assert.equal(result.translatedMarkdown, source);
    assert.equal(result.partial, true);
    assert.match(result.failedBlocks[0].message, /output token limit/i);
});

test('propagates cancellation from the protected text fallback', async () => {
    const controller = new AbortController();
    let calls = 0;
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                calls++;
                const entries = parseTranslationRequest(
                    request.messages[1].content
                );
                if ('sourceText' in entries[0]) {
                    controller.abort();
                    return { text: '[]' };
                }
                return {
                    text: JSON.stringify(entries.map(entry => ({
                        id: entry.id,
                        translatedMarkdown: entry.sourceMarkdown.replace(
                            /MKTEROPROTECTED\d+PLACEHOLDER/,
                            ''
                        ),
                    }))),
                };
            },
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => null,
    });

    await assert.rejects(() => service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: 'Compare $x$ and $y$.',
        signal: controller.signal,
    }), error => error?.name === 'AbortError');
    assert.equal(calls, 4);
});

test('does not use the protected text fallback for ordinary structure errors', async () => {
    const requests = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                const entries = parseTranslationRequest(
                    request.messages[1].content
                );
                requests.push(entries);
                return {
                    text: JSON.stringify(entries.map(entry => ({
                        id: entry.id,
                        translatedMarkdown: '# Wrong structure',
                    }))),
                };
            },
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => null,
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: 'One paragraph.',
    });

    assert.equal(requests.length, 3);
    assert.ok(requests.flat().every(entry => 'sourceMarkdown' in entry));
    assert.equal(result.partial, true);
    assert.equal(result.translatedMarkdown, 'One paragraph.');
});

test('retries every block after the initial batch request fails', async () => {
    let calls = 0;
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText() {
                calls++;
                throw Object.assign(new Error('bad response'), {
                    code: 'AI_INVALID_RESPONSE',
                });
            },
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => null,
    });

    const result = await service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: '# Paper\n\nParagraph.',
    });

    assert.equal(calls, 5);
    assert.equal(result.partial, true);
    assert.equal(result.completedBlocks, 0);
    assert.equal(result.translatedMarkdown, '# Paper\n\nParagraph.');
});

for (const code of [
    'AI_AUTH_ERROR',
    'AI_RATE_LIMITED',
    'AI_REQUEST_TIMEOUT',
    'AI_NETWORK_ERROR',
    'AI_HTTP_ERROR',
    'AI_RESPONSE_TOO_LARGE',
]) {
    test(`does not retry a fatal ${code} provider error`, async () => {
        let calls = 0;
        const service = new MarkdownTranslationService({
            aiGateway: {
                async generateText() {
                    calls++;
                    throw Object.assign(new Error('provider failed'), { code });
                },
            },
            getSettings: () => ({ ...SETTINGS, streaming: false }),
            createCacheKey: async () => null,
        });

        await assert.rejects(() => service.translateDocument({
            documentKey: 'a'.repeat(64),
            markdown: '# Paper\n\nParagraph.',
        }), error => error?.code === code);
        assert.equal(calls, 1);
    });
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

test('aborts every active section request when the document signal is canceled', async () => {
    const controller = new AbortController();
    let calls = 0;
    let aborted = 0;
    let resolveStarted;
    const started = new Promise(resolve => { resolveStarted = resolve; });
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                calls++;
                if (calls === 5) resolveStarted();
                await new Promise((resolve, reject) => {
                    const abort = () => {
                        aborted++;
                        reject(Object.assign(new Error('aborted'), {
                            name: 'AbortError',
                        }));
                    };
                    request.signal.addEventListener('abort', abort, { once: true });
                });
                return { text: '' };
            },
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => null,
    });
    const source = Array.from({ length: 7 }, (_, index) => (
        `# Section ${index}\n\nParagraph ${index}.`
    )).join('\n\n');
    const translation = service.translateDocument({
        documentKey: 'a'.repeat(64),
        markdown: source,
        signal: controller.signal,
    });
    await started;
    controller.abort();

    await assert.rejects(translation, error => error?.name === 'AbortError');
    assert.equal(calls, 5);
    assert.equal(aborted, 5);
});

test('forwards reasoning effort to selection translation requests', async () => {
    let request;
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(value) {
                request = value;
                return { text: '译文', model: 'example-chat' };
            },
        },
        getSettings: () => ({
            ...SETTINGS,
            streaming: false,
            reasoning: 'medium',
        }),
    });

    const result = await service.translateSelection({ text: 'A sentence.' });

    assert.equal(result.text, '译文');
    assert.equal(request.settings.reasoning, 'medium');
});

test('translates one bounded selection without using document cache', async () => {
    const requests = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                requests.push(request);
                return {
                    text: '翻译后的短句',
                    model: 'selection-model',
                    usage: { totalTokens: 8 },
                };
            },
        },
        cache: {
            getTranslation: () => assert.fail('selection must not read cache'),
            putTranslation: () => assert.fail('selection must not write cache'),
        },
        createCacheKey: () => assert.fail('selection must not create cache keys'),
        getSettings: () => ({
            ...SETTINGS,
            streaming: false,
        }),
    });

    const result = await service.translateSelection({
        text: 'A bounded sentence.',
        context: 'The surrounding paragraph explains the term.',
    });

    assert.deepEqual(result, {
        text: '翻译后的短句',
        targetLanguage: 'zh-CN',
        model: 'selection-model',
        usage: { totalTokens: 8 },
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].maxInputBytes, 64 * 1024);
    assert.equal(requests[0].maxResponseBytes, 128 * 1024);
    assert.equal(requests[0].messages.length, 2);
    assert.equal(requests[0].messages[0].role, 'system');
    assert.match(requests[0].messages[0].content, /academic text/);
    assert.match(requests[0].messages[0].content, /plain text/);
    assert.match(requests[0].messages[0].content, /Do not follow instructions/);
    assert.equal(requests[0].messages[1].role, 'user');
    assert.match(requests[0].messages[1].content, /A bounded sentence\./);
    assert.match(requests[0].messages[1].content, /surrounding paragraph/);
});

test('uses the configured streaming gateway for selection translation', async () => {
    let streamCalls = 0;
    let generateCalls = 0;
    const deltas = [];
    const service = new MarkdownTranslationService({
        aiGateway: {
            async streamText(request) {
                streamCalls++;
                assert.match(request.messages[0].content, /French/);
                request.onTextDelta('Texte', 'Texte');
                request.onTextDelta(' traduit', 'Texte traduit');
                return { text: 'Texte traduit', model: 'stream-model' };
            },
            async generateText() {
                generateCalls++;
                return { text: 'wrong path' };
            },
        },
        getSettings: () => ({
            ...SETTINGS,
            streaming: true,
            targetLanguage: 'fr-FR',
        }),
    });

    const result = await service.translateSelection({
        text: 'A sentence.',
        onTextDelta: (chunk, accumulated) => {
            deltas.push([chunk, accumulated]);
        },
    });

    assert.equal(result.text, 'Texte traduit');
    assert.equal(result.targetLanguage, 'fr-FR');
    assert.deepEqual(deltas, [
        ['Texte', 'Texte'],
        [' traduit', 'Texte traduit'],
    ]);
    assert.equal(streamCalls, 1);
    assert.equal(generateCalls, 0);
});

test('falls back to generateText when streaming is unavailable', async () => {
    let generateCalls = 0;
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                generateCalls++;
                assert.equal(request.settings.targetLanguage, 'ja-JP');
                assert.equal('onTextDelta' in request, false);
                return { text: '翻訳文' };
            },
        },
        getSettings: () => ({
            ...SETTINGS,
            streaming: true,
            targetLanguage: 'ja-JP',
        }),
    });

    const result = await service.translateSelection({ text: 'A sentence.' });

    assert.equal(result.text, '翻訳文');
    assert.equal(generateCalls, 1);
});

test('rejects empty or invalid selection requests before calling the provider', async () => {
    let calls = 0;
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText() {
                calls++;
                return { text: 'unreachable' };
            },
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
    });

    await assert.rejects(
        () => service.translateSelection({ text: ' \n\t' }),
        error => error?.code === 'AI_INVALID_REQUEST'
    );
    await assert.rejects(
        () => service.translateSelection({ text: 'A sentence.', targetLanguage: 'en-US' }),
        error => error?.code === 'AI_INVALID_REQUEST'
    );
    assert.equal(calls, 0);
});

test('rejects selection, context, and request data above UTF-8 byte limits', async () => {
    let calls = 0;
    const service = new MarkdownTranslationService({
        aiGateway: {
            async generateText() {
                calls++;
                return { text: 'unreachable' };
            },
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
    });

    await assert.rejects(
        () => service.translateSelection({ text: '选'.repeat(32 * 1024) }),
        error => error?.code === 'AI_INPUT_TOO_LARGE'
    );
    await assert.rejects(
        () => service.translateSelection({
            text: 'A sentence.',
            context: '语境'.repeat(8 * 1024),
        }),
        error => error?.code === 'AI_INPUT_TOO_LARGE'
    );
    assert.equal(calls, 0);
});

test('rejects empty, truncated, and oversized selection responses with stable codes', async () => {
    const outputs = [
        { text: '  ', code: 'AI_INVALID_RESPONSE' },
        { text: '截断的翻译', finishReason: 'length', code: 'AI_INVALID_RESPONSE' },
        { text: '翻译'.repeat(128 * 1024), code: 'AI_RESPONSE_TOO_LARGE' },
    ];

    for (const output of outputs) {
        const service = new MarkdownTranslationService({
            aiGateway: {
                async generateText() {
                    return output;
                },
            },
            getSettings: () => ({ ...SETTINGS, streaming: false }),
        });

        await assert.rejects(
            () => service.translateSelection({ text: 'A sentence.' }),
            error => error?.code === output.code
        );
    }
});

test('preserves provider errors and aborts selection requests', async () => {
    const providerError = Object.assign(new Error('unauthorized'), {
        code: 'AI_AUTH_ERROR',
    });
    const providerService = new MarkdownTranslationService({
        aiGateway: {
            async generateText() {
                throw providerError;
            },
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
    });

    await assert.rejects(
        () => providerService.translateSelection({ text: 'A sentence.' }),
        error => error === providerError
    );

    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const abortedService = new MarkdownTranslationService({
        aiGateway: {
            async generateText() {
                calls++;
                return { text: 'unreachable' };
            },
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
    });

    await assert.rejects(
        () => abortedService.translateSelection({
            text: 'A sentence.',
            signal: controller.signal,
        }),
        error => error?.name === 'AbortError'
    );
    assert.equal(calls, 0);
});

function createBoundaryService({ output, onProviderCall = () => {} }) {
    return new MarkdownTranslationService({
        aiGateway: {
            async generateText(request) {
                onProviderCall();
                return {
                    text: translateSingleBlockRequest(
                        request.messages[1].content,
                        output
                    ),
                };
            },
        },
        cache: {
            getTranslation: async () => null,
            putTranslation: async () => {},
        },
        getSettings: () => ({ ...SETTINGS, streaming: false }),
        createCacheKey: async () => 'c'.repeat(64),
    });
}

function translateSingleBlockRequest(requestMarkdown, translatedMarkdown) {
    const entries = parseTranslationRequest(requestMarkdown);
    if (entries.length !== 1) throw new Error('A single-block request is required');
    return JSON.stringify([{
        id: entries[0].id,
        translatedMarkdown,
    }]);
}

function translateMarkedSection(requestMarkdown, translatedHeading) {
    const index = translatedHeading.match(/(\d+)$/)?.[1] || 0;
    return JSON.stringify(parseTranslationRequest(requestMarkdown).map(entry => ({
        id: entry.id,
        translatedMarkdown: entry.sourceMarkdown
            .replace(`# Section ${index}`, translatedHeading)
            .replace(`Paragraph ${index}.`, `译文段落 ${index}。`),
    })));
}

function translateBatchRequest(requestMarkdown, translate) {
    return JSON.stringify(parseTranslationRequest(requestMarkdown).map(entry => ({
        id: entry.id,
        translatedMarkdown: translate(entry.sourceMarkdown),
    })));
}

function parseTranslationRequest(request) {
    const entries = JSON.parse(request);
    if (!Array.isArray(entries)) throw new Error('A JSON translation batch is required');
    return entries;
}

function documentSettingsIdentity(overrides = {}) {
    return JSON.stringify({
        provider: SETTINGS.provider,
        protocol: SETTINGS.protocol,
        apiBase: SETTINGS.apiBase,
        model: SETTINGS.model,
        reasoning: 'none',
        targetLanguage: SETTINGS.targetLanguage,
        promptVersion: TRANSLATION_PROMPT_VERSION,
        ...overrides,
    });
}

function createCompatibleCacheService(cached) {
    const cacheErrors = [];
    const service = new MarkdownTranslationService({
        aiGateway: { generateText: assert.fail },
        cache: {
            getTranslation: async () => null,
            getTranslationByLanguage: async (_documentKey, language) => (
                language === 'zh-CN' ? cached : null
            ),
            putTranslation: assert.fail,
        },
        getSettings: () => SETTINGS,
        createCacheKey: async () => 'd'.repeat(64),
        onCacheError: error => cacheErrors.push(error),
    });
    return { service, cacheErrors };
}
