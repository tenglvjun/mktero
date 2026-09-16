import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AI_API_BASE_PREF,
    AI_API_KEY_PREF,
    AI_AUTO_TRANSLATE_SELECTION_PREF,
    AI_MODEL_PREF,
    AI_REASONING_PREF,
    AI_PROTOCOL_OPENAI_CHAT,
    AI_PROTOCOL_OPENAI_RESPONSES,
    AI_PROTOCOL_PREF,
    AI_ALIBABA_API_BASE_CHINA,
    AI_ALIBABA_API_BASE_INTERNATIONAL,
    AI_MINIMAX_API_BASE_CHINA,
    AI_MINIMAX_API_BASE_INTERNATIONAL,
    AI_MOONSHOT_API_BASE_CHINA,
    AI_MOONSHOT_API_BASE_INTERNATIONAL,
    AI_PROVIDER_PREF,
    AI_PROVIDER_PROFILES_PREF,
    AI_REQUEST_TIMEOUT_PREF,
    AI_STREAMING_PREF,
    AI_TARGET_LANGUAGES,
    AI_TARGET_LANGUAGE_PREF,
    emptyAIProviderProfile,
    getAISettings,
    readAIProviderProfiles,
    switchAIProvider,
    syncCurrentAIProviderProfile,
    isReplaceableAIApiBase,
    isSupportedAITargetLanguage,
    normalizeAIBaseURL,
    observeAITargetLanguage,
    validateAISettings,
    aiRequestTimeoutMsFromSeconds,
    aiRequestTimeoutSecondsFromMs,
    defaultAIApiBaseForProvider,
    alibabaApiBaseForRegion,
    alibabaApiBaseRegion,
    miniMaxApiBaseForRegion,
    miniMaxApiBaseRegion,
    moonshotApiBaseForRegion,
    moonshotApiBaseRegion,
} from '../src/config/ai-preferences.js';

test('reads and normalizes the configured AI settings', () => {
    const values = new Map([
        [AI_PROVIDER_PREF, 'openai'],
        [AI_PROTOCOL_PREF, AI_PROTOCOL_OPENAI_RESPONSES],
        [AI_API_BASE_PREF, ' https://example.com/v1/ '],
        [AI_API_KEY_PREF, ' secret-token '],
        [AI_AUTO_TRANSLATE_SELECTION_PREF, true],
        [AI_MODEL_PREF, ' example-chat '],
        [AI_REASONING_PREF, 'high'],
        [AI_TARGET_LANGUAGE_PREF, 'zh-CN'],
        [AI_REQUEST_TIMEOUT_PREF, 45_000],
        [AI_STREAMING_PREF, false],
    ]);
    const settings = getAISettings({
        Prefs: { get: key => values.get(key) },
    });

    assert.deepEqual(settings, {
        enabled: true,
        provider: 'openai',
        protocol: AI_PROTOCOL_OPENAI_RESPONSES,
        apiBase: 'https://example.com/v1',
        apiKey: 'secret-token',
        autoTranslateSelection: true,
        model: 'example-chat',
        reasoning: 'high',
        targetLanguage: 'zh-CN',
        requestTimeoutMs: 45_000,
        maxOutputTokens: 0,
        streaming: false,
    });
});

test('uses full-document request defaults and preserves a streaming opt-out', () => {
    const defaults = getAISettings({ Prefs: { get: () => undefined } });
    assert.equal(defaults.enabled, true);
    assert.equal(getAISettings({
        Prefs: {
            get: key => key === 'extensions.mktero.aiEnabled' ? false : undefined,
        },
    }).enabled, true);
    assert.equal(defaults.streaming, true);
    assert.equal(defaults.autoTranslateSelection, false);
    assert.equal(defaults.requestTimeoutMs, 600_000);
    assert.equal(defaults.maxOutputTokens, 0);
    assert.equal(getAISettings({
        Prefs: {
            get: key => key === AI_STREAMING_PREF ? false : undefined,
        },
    }).streaming, false);
    assert.equal(getAISettings({
        Prefs: {
            get: key => key === AI_AUTO_TRANSLATE_SELECTION_PREF
                ? true
                : undefined,
        },
    }).autoTranslateSelection, true);
    assert.equal(validateAISettings({
        enabled: true,
        provider: 'openai',
        protocol: AI_PROTOCOL_OPENAI_RESPONSES,
        apiBase: 'https://api.example.com/v1',
        apiKey: 'token',
        model: 'model',
    }).streaming, true);
});

test('allows a full-document timeout budget', () => {
    const settings = getAISettings({
        Prefs: {
            get: key => ({
                [AI_REQUEST_TIMEOUT_PREF]: 3_600_001,
            })[key],
        },
    });

    assert.equal(settings.requestTimeoutMs, 3_600_000);
    assert.equal(settings.maxOutputTokens, 0);
});

test('reads reasoning effort and maps the legacy automatic value to off', () => {
    assert.equal(getAISettings({
        Prefs: {
            get: key => key === AI_REASONING_PREF ? 'high' : undefined,
        },
    }).reasoning, 'high');
    assert.equal(getAISettings({
        Prefs: {
            get: key => key === AI_REASONING_PREF
                ? 'provider-default'
                : undefined,
        },
    }).reasoning, 'none');
    assert.equal(getAISettings({
        Prefs: { get: () => undefined },
    }).reasoning, 'none');
    assert.equal(getAISettings({
        Prefs: {
            get: key => key === AI_REASONING_PREF ? 'on' : undefined,
        },
    }).reasoning, 'on');
    assert.equal(getAISettings({
        Prefs: {
            get: key => key === AI_REASONING_PREF ? 'minimal' : undefined,
        },
    }).reasoning, 'minimal');
    assert.equal(getAISettings({
        Prefs: {
            get: key => key === AI_REASONING_PREF ? 'max' : undefined,
        },
    }).reasoning, 'max');
});

test('supports non-English targets and normalizes legacy English to Chinese', () => {
    assert.deepEqual(AI_TARGET_LANGUAGES, [
        'zh-CN',
        'zh-TW',
        'ja-JP',
        'ko-KR',
        'es-ES',
        'fr-FR',
        'pt-BR',
    ]);
    assert.equal(isSupportedAITargetLanguage('en-US'), false);
    assert.equal(
        getAISettings({
            Prefs: {
                get: key => key === AI_TARGET_LANGUAGE_PREF
                    ? 'en-US'
                    : undefined,
            },
        }).targetLanguage,
        'zh-CN'
    );
    for (const targetLanguage of ['es-ES', 'fr-FR', 'pt-BR']) {
        assert.equal(
            getAISettings({
                Prefs: {
                    get: key => key === AI_TARGET_LANGUAGE_PREF
                        ? targetLanguage
                        : undefined,
                },
            }).targetLanguage,
            targetLanguage
        );
        assert.equal(
            validateAISettings({
                enabled: true,
                provider: 'openai',
                protocol: AI_PROTOCOL_OPENAI_RESPONSES,
                apiBase: 'https://api.example.com/v1',
                apiKey: 'token',
                model: 'model',
                targetLanguage,
            }).targetLanguage,
            targetLanguage
        );
    }
});

test('observes normalized AI target-language changes and unregisters', () => {
    const changes = [];
    const unregistered = [];
    let observer;
    const dispose = observeAITargetLanguage({
        Prefs: {
            registerObserver(key, callback, global) {
                assert.equal(key, AI_TARGET_LANGUAGE_PREF);
                assert.equal(global, true);
                observer = callback;
                return 'target-language-observer';
            },
            unregisterObserver(value) {
                unregistered.push(value);
            },
        },
    }, language => changes.push(language));

    observer('ja-JP');
    observer('unsupported');
    dispose();

    assert.deepEqual(changes, ['ja-JP', 'zh-CN']);
    assert.deepEqual(unregistered, ['target-language-observer']);
});

test('shares one supported target-language set with translation rendering', () => {
    assert.equal(isSupportedAITargetLanguage('zh-TW'), true);
    assert.equal(isSupportedAITargetLanguage(' pt-BR '), true);
    assert.equal(isSupportedAITargetLanguage('de-DE'), false);
    assert.equal(
        isSupportedAITargetLanguage('en-US" onclick="alert(1)'),
        false
    );
});

test('allows HTTPS providers and local HTTP model servers', () => {
    assert.equal(
        normalizeAIBaseURL('https://api.example.com/v1/'),
        'https://api.example.com/v1'
    );
    assert.equal(
        normalizeAIBaseURL('http://127.0.0.1:11434/v1/'),
        'http://127.0.0.1:11434/v1'
    );
    assert.throws(
        () => normalizeAIBaseURL('http://example.com/v1'),
        error => error?.code === 'AI_CONFIGURATION_ERROR'
    );
    assert.throws(
        () => normalizeAIBaseURL('file:///tmp/model'),
        error => error?.code === 'AI_CONFIGURATION_ERROR'
    );
    assert.equal(getAISettings({
        Prefs: { get: key => key === AI_API_BASE_PREF ? '' : undefined },
    }).apiBase, '');
});

test('requires a supported provider, protocol, model, and remote API key', () => {
    assert.equal(
        validateAISettings({
            enabled: false,
            provider: 'custom',
            protocol: AI_PROTOCOL_OPENAI_CHAT,
            apiBase: 'http://localhost:11434/v1',
            apiKey: '',
            model: 'qwen3',
        }).enabled,
        true
    );
    assert.throws(
        () => validateAISettings({
            enabled: true,
            provider: 'unsupported',
            apiBase: 'https://api.example.com/v1',
            apiKey: 'token',
            model: 'model',
        }),
        error => error?.code === 'AI_PROVIDER_UNSUPPORTED'
    );
    assert.throws(
        () => validateAISettings({
            enabled: true,
            provider: 'openai',
            protocol: AI_PROTOCOL_OPENAI_RESPONSES,
            apiBase: 'https://api.example.com/v1',
            apiKey: '',
            model: 'model',
        }),
        error => error?.code === 'AI_CONFIGURATION_ERROR'
    );
    assert.doesNotThrow(() => validateAISettings({
        enabled: true,
        provider: 'custom',
        protocol: AI_PROTOCOL_OPENAI_CHAT,
        apiBase: 'http://localhost:11434/v1',
        apiKey: '',
        model: 'qwen3',
    }));
});

test('rejects oversized or control-bearing AI preference values', () => {
    const valid = {
        enabled: true,
        provider: 'openai',
        protocol: AI_PROTOCOL_OPENAI_RESPONSES,
        apiBase: 'https://api.example.com/v1',
        apiKey: 'token',
        model: 'model',
    };

    assert.throws(
        () => normalizeAIBaseURL(`https://example.com/${'x'.repeat(2_048)}`),
        error => error?.code === 'AI_CONFIGURATION_ERROR'
    );
    assert.throws(
        () => validateAISettings({ ...valid, apiKey: 'token\nInjected: value' }),
        error => error?.code === 'AI_CONFIGURATION_ERROR'
    );
    assert.throws(
        () => validateAISettings({ ...valid, model: 'x'.repeat(513) }),
        error => error?.code === 'AI_CONFIGURATION_ERROR'
    );
});

test('migrates the legacy OpenAI-compatible provider to Chat Completions', () => {
    const settings = getAISettings({
        Prefs: {
            get: key => ({
                [AI_PROVIDER_PREF]: 'openai-compatible',
                [AI_PROTOCOL_PREF]: AI_PROTOCOL_OPENAI_RESPONSES,
                [AI_API_BASE_PREF]: 'https://api.example.com/v1',
                [AI_API_KEY_PREF]: 'token',
                [AI_MODEL_PREF]: 'legacy-model',
            })[key],
        },
    });

    assert.equal(settings.provider, 'custom');
    assert.equal(settings.protocol, AI_PROTOCOL_OPENAI_CHAT);
});

test('rejects provider and protocol combinations that cannot be routed', () => {
    assert.throws(
        () => validateAISettings({
            enabled: true,
            provider: 'anthropic',
            protocol: AI_PROTOCOL_OPENAI_RESPONSES,
            apiBase: 'https://api.anthropic.com/v1',
            apiKey: 'token',
            model: 'claude-model',
        }),
        error => error?.code === 'AI_PROVIDER_UNSUPPORTED'
    );
});

test('fills known provider API bases and treats them as replaceable defaults', () => {
    assert.equal(
        defaultAIApiBaseForProvider('deepseek'),
        'https://api.deepseek.com'
    );
    assert.equal(defaultAIApiBaseForProvider('custom'), '');
    assert.equal(isReplaceableAIApiBase(''), true);
    assert.equal(
        isReplaceableAIApiBase('https://api.openai.com/v1/'),
        true
    );
    assert.equal(
        isReplaceableAIApiBase('https://api.example.com/v1'),
        false
    );
    assert.equal(
        isReplaceableAIApiBase('https://api.moonshot.cn/v1'),
        true
    );
    assert.equal(
        isReplaceableAIApiBase('https://api.minimax.cn/anthropic/v1'),
        true
    );
    assert.equal(
        isReplaceableAIApiBase('https://dashscope.aliyuncs.com/compatible-mode/v1'),
        true
    );
});

test('keeps Moonshot on the international or China API base', () => {
    assert.equal(
        moonshotApiBaseRegion('https://api.moonshot.cn/v1/'),
        'china'
    );
    assert.equal(
        moonshotApiBaseForRegion('china'),
        AI_MOONSHOT_API_BASE_CHINA
    );
    assert.equal(
        moonshotApiBaseForRegion('international'),
        AI_MOONSHOT_API_BASE_INTERNATIONAL
    );
    assert.equal(
        getAISettings({
            Prefs: {
                get: key => ({
                    [AI_PROVIDER_PREF]: 'moonshotai',
                    [AI_API_BASE_PREF]: 'https://api.moonshot.cn/v1',
                    [AI_API_KEY_PREF]: 'token',
                    [AI_MODEL_PREF]: 'kimi-k3',
                })[key],
            },
        }).apiBase,
        AI_MOONSHOT_API_BASE_CHINA
    );
    assert.equal(
        validateAISettings({
            provider: 'moonshotai',
            apiBase: 'https://api.openai.com/v1',
            apiKey: 'token',
            model: 'kimi-k3',
        }).apiBase,
        AI_MOONSHOT_API_BASE_INTERNATIONAL
    );
});

test('keeps MiniMax on the international or China API base', () => {
    assert.equal(
        miniMaxApiBaseRegion('https://api.minimax.cn/anthropic'),
        'china'
    );
    assert.equal(
        miniMaxApiBaseForRegion('china'),
        AI_MINIMAX_API_BASE_CHINA
    );
    assert.equal(
        miniMaxApiBaseForRegion('international'),
        AI_MINIMAX_API_BASE_INTERNATIONAL
    );
    assert.equal(
        getAISettings({
            Prefs: {
                get: key => ({
                    [AI_PROVIDER_PREF]: 'minimax',
                    [AI_API_BASE_PREF]: 'https://api.minimax.cn/anthropic',
                    [AI_API_KEY_PREF]: 'token',
                    [AI_MODEL_PREF]: 'MiniMax-M3',
                })[key],
            },
        }).apiBase,
        AI_MINIMAX_API_BASE_CHINA
    );
    assert.equal(
        validateAISettings({
            provider: 'minimax',
            protocol: 'anthropic-messages',
            apiBase: 'https://api.minimax.io/anthropic/v1',
            apiKey: 'token',
            model: 'MiniMax-M3',
        }).apiBase,
        AI_MINIMAX_API_BASE_INTERNATIONAL
    );
});

test('keeps Alibaba on the international or China API base', () => {
    assert.equal(
        alibabaApiBaseRegion('https://dashscope.aliyuncs.com/compatible-mode/v1/'),
        'china'
    );
    assert.equal(
        alibabaApiBaseForRegion('china'),
        AI_ALIBABA_API_BASE_CHINA
    );
    assert.equal(
        alibabaApiBaseForRegion('international'),
        AI_ALIBABA_API_BASE_INTERNATIONAL
    );
    assert.equal(
        getAISettings({
            Prefs: {
                get: key => ({
                    [AI_PROVIDER_PREF]: 'alibaba',
                    [AI_API_BASE_PREF]:
                        'https://dashscope.aliyuncs.com/compatible-mode/v1',
                    [AI_API_KEY_PREF]: 'token',
                    [AI_MODEL_PREF]: 'qwen-plus',
                })[key],
            },
        }).apiBase,
        AI_ALIBABA_API_BASE_CHINA
    );
    assert.equal(
        validateAISettings({
            provider: 'alibaba',
            apiBase: 'https://api.openai.com/v1',
            apiKey: 'token',
            model: 'qwen-plus',
        }).apiBase,
        AI_ALIBABA_API_BASE_INTERNATIONAL
    );
});

test('converts the AI request timeout between seconds and milliseconds', () => {
    assert.equal(aiRequestTimeoutSecondsFromMs(600_000), 600);
    assert.equal(aiRequestTimeoutMsFromSeconds(600), 600_000);
    assert.equal(aiRequestTimeoutMsFromSeconds(3_600), 3_600_000);
    assert.equal(aiRequestTimeoutMsFromSeconds(0), 1_000);
});

test('uses empty per-provider defaults for a never-configured provider', () => {
    assert.deepEqual(emptyAIProviderProfile('deepseek'), {
        protocol: AI_PROTOCOL_OPENAI_CHAT,
        apiBase: 'https://api.deepseek.com',
        apiKey: '',
        model: '',
        reasoning: 'none',
        requestTimeoutMs: 600_000,
        maxOutputTokens: 0,
        streaming: true,
    });
    assert.deepEqual(emptyAIProviderProfile('custom'), {
        protocol: AI_PROTOCOL_OPENAI_CHAT,
        apiBase: '',
        apiKey: '',
        model: '',
        reasoning: 'none',
        requestTimeoutMs: 600_000,
        maxOutputTokens: 0,
        streaming: true,
    });
});

test('copies live settings into the current provider slot on first sync', () => {
    const zotero = createAIPrefsZotero({
        [AI_PROVIDER_PREF]: 'openai',
        [AI_PROTOCOL_PREF]: AI_PROTOCOL_OPENAI_RESPONSES,
        [AI_API_BASE_PREF]: 'https://api.openai.com/v1',
        [AI_API_KEY_PREF]: 'openai-secret',
        [AI_MODEL_PREF]: 'gpt-5-pro',
        [AI_REASONING_PREF]: 'high',
        [AI_REQUEST_TIMEOUT_PREF]: 45_000,
        [AI_STREAMING_PREF]: false,
        [AI_TARGET_LANGUAGE_PREF]: 'ja-JP',
    });

    syncCurrentAIProviderProfile(zotero);

    assert.deepEqual(readAIProviderProfiles(zotero).openai, {
        protocol: AI_PROTOCOL_OPENAI_RESPONSES,
        apiBase: 'https://api.openai.com/v1',
        apiKey: 'openai-secret',
        model: 'gpt-5-pro',
        reasoning: 'high',
        requestTimeoutMs: 45_000,
        maxOutputTokens: 0,
        streaming: false,
    });
    assert.equal(readAIProviderProfiles(zotero).deepseek, undefined);
    assert.equal(getAISettings(zotero).targetLanguage, 'ja-JP');
});

test('switches to an empty profile and restores the previous provider', () => {
    const zotero = createAIPrefsZotero({
        [AI_PROVIDER_PREF]: 'openai',
        [AI_PROTOCOL_PREF]: AI_PROTOCOL_OPENAI_RESPONSES,
        [AI_API_BASE_PREF]: 'https://api.openai.com/v1',
        [AI_API_KEY_PREF]: 'openai-secret',
        [AI_MODEL_PREF]: 'gpt-5-pro',
        [AI_REASONING_PREF]: 'high',
        [AI_REQUEST_TIMEOUT_PREF]: 45_000,
        [AI_STREAMING_PREF]: false,
        [AI_TARGET_LANGUAGE_PREF]: 'ja-JP',
    });
    const current = getAISettings(zotero);

    const deepseek = switchAIProvider(zotero, current, 'deepseek');
    assert.equal(deepseek.provider, 'deepseek');
    assert.equal(deepseek.model, '');
    assert.equal(deepseek.apiKey, '');
    assert.equal(deepseek.streaming, true);
    assert.equal(deepseek.reasoning, 'none');
    assert.equal(deepseek.requestTimeoutMs, 600_000);
    assert.equal(deepseek.apiBase, 'https://api.deepseek.com');
    assert.equal(deepseek.targetLanguage, 'ja-JP');

    const restored = switchAIProvider(zotero, deepseek, 'openai');
    assert.equal(restored.provider, 'openai');
    assert.equal(restored.model, 'gpt-5-pro');
    assert.equal(restored.apiKey, 'openai-secret');
    assert.equal(restored.streaming, false);
    assert.equal(restored.reasoning, 'high');
    assert.equal(restored.requestTimeoutMs, 45_000);
    assert.equal(restored.maxOutputTokens, 0);
    assert.equal(restored.targetLanguage, 'ja-JP');
});

test('keeps a single custom provider slot', () => {
    const zotero = createAIPrefsZotero({
        [AI_PROVIDER_PREF]: 'custom',
        [AI_PROTOCOL_PREF]: AI_PROTOCOL_OPENAI_CHAT,
        [AI_API_BASE_PREF]: 'http://localhost:11434/v1',
        [AI_API_KEY_PREF]: '',
        [AI_MODEL_PREF]: 'qwen3',
        [AI_STREAMING_PREF]: true,
    });

    switchAIProvider(zotero, getAISettings(zotero), 'openai');
    const restored = switchAIProvider(
        zotero,
        getAISettings(zotero),
        'openai-compatible'
    );

    assert.equal(restored.provider, 'custom');
    assert.equal(restored.model, 'qwen3');
    assert.equal(restored.apiBase, 'http://localhost:11434/v1');
    assert.equal(
        Object.keys(readAIProviderProfiles(zotero)).includes('openai-compatible'),
        false
    );
});

test('ignores malformed provider profile JSON and unknown provider keys', () => {
    const zotero = createAIPrefsZotero({
        [AI_PROVIDER_PROFILES_PREF]: '{not-json',
    });
    assert.deepEqual(readAIProviderProfiles(zotero), {});

    zotero.Prefs.set(
        AI_PROVIDER_PROFILES_PREF,
        JSON.stringify({
            unknown: { model: 'x' },
            openai: { model: 'gpt-4o', apiKey: 'token' },
        }),
        true
    );
    assert.deepEqual(readAIProviderProfiles(zotero).openai.model, 'gpt-4o');
    assert.equal(readAIProviderProfiles(zotero).unknown, undefined);
    assert.equal(readAIProviderProfiles(zotero).custom, undefined);
});

function createAIPrefsZotero(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        Prefs: {
            get: key => values.get(key),
            set: (key, value) => values.set(key, value),
        },
    };
}
