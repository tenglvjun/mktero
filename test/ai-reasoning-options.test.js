import test from 'node:test';
import assert from 'node:assert/strict';
import {
    STATIC_AI_REASONING_LEVELS,
    resolveAIReasoningLevels,
    selectAIReasoningValue,
} from '../src/config/ai-reasoning-options.js';

const CATALOG = {
    labProviders: ['openai', 'anthropic', 'google', 'deepseek', 'alibaba', 'moonshotai', 'minimax'],
    hosts: {
        'api.openai.com': 'openai',
        'openrouter.ai': 'openrouter',
        'dashscope-intl.aliyuncs.com': 'alibaba',
    },
    providers: {
        openai: {
            'gpt-4o': { reasoning: false },
            'gpt-5.4': {
                reasoning: true,
                options: [{
                    type: 'effort',
                    values: ['none', 'low', 'medium', 'high', 'xhigh'],
                }],
            },
            'gpt-5-pro': {
                reasoning: true,
                options: [{ type: 'effort', values: ['high'] }],
            },
            'gpt-5-nano': {
                reasoning: true,
                options: [{
                    type: 'effort',
                    values: ['minimal', 'low', 'medium', 'high'],
                }],
            },
        },
        anthropic: {
            'claude-sonnet-4-6': {
                reasoning: true,
                options: [
                    { type: 'effort', values: ['low', 'medium', 'high', 'max'] },
                    { type: 'budget_tokens', min: 1024 },
                ],
            },
            'claude-haiku-4-5': {
                reasoning: true,
                options: [{ type: 'budget_tokens', min: 1024 }],
            },
        },
        moonshotai: {
            'kimi-k2.6': {
                reasoning: true,
                options: [{ type: 'toggle' }],
            },
            'kimi-k3': {
                reasoning: true,
                options: [
                    { type: 'toggle' },
                    { type: 'effort', values: ['low', 'high', 'max'] },
                ],
            },
        },
        minimax: {
            'MiniMax-M2': {
                reasoning: true,
                options: [],
            },
        },
        google: {
            'gemini-2.5-pro': {
                reasoning: true,
                options: [{
                    type: 'effort',
                    values: ['low', 'medium', 'high', null],
                }],
            },
        },
        openrouter: {
            'openai/gpt-5.4': {
                reasoning: true,
                options: [{
                    type: 'effort',
                    values: ['none', 'low', 'medium', 'high'],
                }],
            },
            'relay-only': {
                reasoning: true,
                options: [{ type: 'effort', values: ['low', 'high'] }],
            },
        },
        deepseek: {
            'deepseek-v4-flash': {
                reasoning: true,
                options: [
                    { type: 'toggle' },
                    { type: 'effort', values: ['low', 'high', 'max'] },
                ],
            },
        },
        alibaba: {
            'qwen3-max': { reasoning: false },
        },
    },
};

function levels(settings) {
    return resolveAIReasoningLevels(settings, CATALOG);
}

test('falls back to the static levels without a catalog or model match', () => {
    assert.deepEqual(
        resolveAIReasoningLevels({ provider: 'openai', model: 'gpt-5.4' }),
        [...STATIC_AI_REASONING_LEVELS]
    );
    assert.deepEqual(
        levels({ provider: 'openai', model: 'missing-model' }),
        [...STATIC_AI_REASONING_LEVELS]
    );
    assert.deepEqual(
        levels({ provider: 'openai', model: '' }),
        [...STATIC_AI_REASONING_LEVELS]
    );
});

test('shows only off when a matched model does not support reasoning', () => {
    assert.deepEqual(
        levels({ provider: 'openai', model: 'gpt-4o' }),
        ['none']
    );
    assert.deepEqual(
        levels({ provider: 'openai', model: 'GPT-4O' }),
        ['none']
    );
});

test('uses catalog effort values and does not duplicate an existing off option', () => {
    assert.deepEqual(
        levels({ provider: 'openai', model: 'gpt-5.4' }),
        ['none', 'low', 'medium', 'high', 'xhigh']
    );
    assert.deepEqual(
        levels({ provider: 'openai', model: 'openai/gpt-5.4' }),
        ['none', 'low', 'medium', 'high', 'xhigh']
    );
});

test('omits off when a reasoning model cannot disable thinking', () => {
    assert.deepEqual(
        levels({ provider: 'openai', model: 'gpt-5-pro' }),
        ['high']
    );
});

test('adds off when effort values omit none but a toggle is present', () => {
    assert.deepEqual(
        levels({ provider: 'moonshotai', model: 'kimi-k3' }),
        ['none', 'low', 'high', 'max']
    );
    assert.deepEqual(
        levels({ provider: 'deepseek', model: 'deepseek-v4-flash' }),
        ['none', 'low', 'high', 'max']
    );
});

test('maps toggle-only models to off and on', () => {
    assert.deepEqual(
        levels({ provider: 'moonshotai', model: 'kimi-k2.6' }),
        ['none', 'on']
    );
});

test('treats null effort as off and keeps extra catalog values', () => {
    assert.deepEqual(
        levels({ provider: 'google', model: 'gemini-2.5-pro' }),
        ['none', 'low', 'medium', 'high']
    );
    assert.deepEqual(
        levels({ provider: 'openai', model: 'gpt-5-nano' }),
        ['minimal', 'low', 'medium', 'high']
    );
    assert.deepEqual(
        levels({ provider: 'anthropic', model: 'claude-sonnet-4-6' }),
        ['low', 'medium', 'high', 'max']
    );
});

test('falls back to static levels for empty or budget-only options', () => {
    assert.deepEqual(
        levels({ provider: 'minimax', model: 'MiniMax-M2' }),
        [...STATIC_AI_REASONING_LEVELS]
    );
    assert.deepEqual(
        levels({ provider: 'anthropic', model: 'claude-haiku-4-5' }),
        [...STATIC_AI_REASONING_LEVELS]
    );
});

test('matches a custom provider from the API base hostname', () => {
    assert.deepEqual(
        levels({
            provider: 'custom',
            model: 'openai/gpt-5.4',
            apiBase: 'https://openrouter.ai/api/v1',
        }),
        ['none', 'low', 'medium', 'high']
    );
    assert.deepEqual(
        levels({
            provider: 'custom',
            model: 'gpt-5.4',
            apiBase: 'https://api.openai.com/v1',
        }),
        ['none', 'low', 'medium', 'high', 'xhigh']
    );
});

test('uses a globally matched model when the custom host is unknown', () => {
    assert.deepEqual(
        levels({
            provider: 'custom',
            model: 'kimi-k3',
            apiBase: 'https://gateway.example.com/v1',
        }),
        ['none', 'low', 'high', 'max']
    );
    assert.deepEqual(
        levels({
            provider: 'custom',
            model: 'relay-only',
            apiBase: 'https://gateway.example.com/v1',
        }),
        ['low', 'high']
    );
    assert.deepEqual(
        levels({
            provider: 'custom',
            model: 'gpt-5.4',
            apiBase: 'https://gateway.example.com/v1',
        }),
        ['none', 'low', 'medium', 'high', 'xhigh']
    );
});

test('prefers the first listed lab when several providers match', () => {
    const catalog = {
        ...CATALOG,
        providers: {
            ...CATALOG.providers,
            anthropic: {
                ...CATALOG.providers.anthropic,
                'shared-model': {
                    reasoning: true,
                    options: [{ type: 'effort', values: ['low'] }],
                },
            },
            openai: {
                ...CATALOG.providers.openai,
                'shared-model': {
                    reasoning: true,
                    options: [{ type: 'effort', values: ['high'] }],
                },
            },
        },
    };
    assert.deepEqual(
        resolveAIReasoningLevels({
            provider: 'custom',
            model: 'shared-model',
            apiBase: 'https://unknown.example.com/v1',
        }, catalog),
        ['high']
    );
});

test('picks the first unlisted provider when no listed lab matches', () => {
    const catalog = {
        labProviders: ['openai'],
        hosts: {},
        providers: {
            'relay-b': {
                'gpt-5.4': {
                    reasoning: true,
                    options: [{ type: 'effort', values: ['max'] }],
                },
            },
            'relay-a': {
                'gpt-5.4': {
                    reasoning: true,
                    options: [{ type: 'effort', values: ['low'] }],
                },
            },
        },
    };
    assert.deepEqual(
        resolveAIReasoningLevels({
            provider: 'custom',
            model: 'gpt-5.4',
            apiBase: 'https://unknown.example.com/v1',
        }, catalog),
        ['max']
    );
});

test('does not use the first global relay when the selected provider misses', () => {
    assert.deepEqual(
        levels({ provider: 'openai', model: 'openai/gpt-5.4' }),
        ['none', 'low', 'medium', 'high', 'xhigh']
    );
    assert.deepEqual(
        levels({
            provider: 'openai',
            model: 'not-a-real-model',
            apiBase: 'https://openrouter.ai/api/v1',
        }),
        [...STATIC_AI_REASONING_LEVELS]
    );
});

test('selects a valid stored reasoning value or a catalog default', () => {
    assert.equal(selectAIReasoningValue(['none', 'low', 'high'], 'high'), 'high');
    assert.equal(selectAIReasoningValue(['high'], 'none'), 'high');
    assert.equal(
        selectAIReasoningValue(['low', 'medium', 'high', 'max'], 'none'),
        'medium'
    );
    assert.equal(selectAIReasoningValue(['none'], 'xhigh'), 'none');
    assert.equal(selectAIReasoningValue([], 'high'), 'none');
});
