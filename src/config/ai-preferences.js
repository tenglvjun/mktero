export const AI_PROVIDER_PREF = 'extensions.mktero.aiProvider';
export const AI_PROTOCOL_PREF = 'extensions.mktero.aiProtocol';
export const AI_API_BASE_PREF = 'extensions.mktero.aiApiBase';
export const AI_API_KEY_PREF = 'extensions.mktero.aiApiKey';
export const AI_MODEL_PREF = 'extensions.mktero.aiModel';
export const AI_REASONING_PREF = 'extensions.mktero.aiReasoning';
export const AI_TARGET_LANGUAGE_PREF = 'extensions.mktero.aiTargetLanguage';
export const AI_REQUEST_TIMEOUT_PREF = 'extensions.mktero.aiRequestTimeoutMs';
export const AI_STREAMING_PREF = 'extensions.mktero.aiStreaming';
export const AI_AUTO_TRANSLATE_SELECTION_PREF =
    'extensions.mktero.aiAutoTranslateSelection';
export const AI_PROVIDER_PROFILES_PREF = 'extensions.mktero.aiProviderProfiles';

export const AI_PROVIDER_OPENAI = 'openai';
export const AI_PROVIDER_ANTHROPIC = 'anthropic';
export const AI_PROVIDER_GOOGLE = 'google';
export const AI_PROVIDER_DEEPSEEK = 'deepseek';
export const AI_PROVIDER_ALIBABA = 'alibaba';
export const AI_PROVIDER_MOONSHOT = 'moonshotai';
export const AI_PROVIDER_MINIMAX = 'minimax';
export const AI_PROVIDER_CUSTOM = 'custom';
export const AI_PROVIDER_OPENAI_COMPATIBLE = 'openai-compatible';

export const AI_PROTOCOL_OPENAI_RESPONSES = 'openai-responses';
export const AI_PROTOCOL_OPENAI_CHAT = 'openai-chat-completions';
export const AI_PROTOCOL_OPEN_RESPONSES = 'open-responses';
export const AI_PROTOCOL_ANTHROPIC = 'anthropic-messages';
export const AI_PROTOCOL_GOOGLE = 'google-generative-ai';

export const AI_DEFAULT_API_BASE = 'https://api.openai.com/v1';
export const AI_PROVIDER_API_BASES = Object.freeze({
    [AI_PROVIDER_OPENAI]: 'https://api.openai.com/v1',
    [AI_PROVIDER_ANTHROPIC]: 'https://api.anthropic.com/v1',
    [AI_PROVIDER_GOOGLE]: 'https://generativelanguage.googleapis.com/v1beta',
    [AI_PROVIDER_DEEPSEEK]: 'https://api.deepseek.com',
    [AI_PROVIDER_ALIBABA]:
        'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    [AI_PROVIDER_MOONSHOT]: 'https://api.moonshot.ai/v1',
    [AI_PROVIDER_MINIMAX]: 'https://api.minimax.io/anthropic/v1',
});
export const AI_ALIBABA_API_BASE_INTERNATIONAL =
    AI_PROVIDER_API_BASES[AI_PROVIDER_ALIBABA];
export const AI_ALIBABA_API_BASE_CHINA =
    'https://dashscope.aliyuncs.com/compatible-mode/v1';
export const AI_MOONSHOT_API_BASE_INTERNATIONAL =
    AI_PROVIDER_API_BASES[AI_PROVIDER_MOONSHOT];
export const AI_MOONSHOT_API_BASE_CHINA = 'https://api.moonshot.cn/v1';
export const AI_MINIMAX_API_BASE_INTERNATIONAL =
    AI_PROVIDER_API_BASES[AI_PROVIDER_MINIMAX];
export const AI_MINIMAX_API_BASE_CHINA = 'https://api.minimax.cn/anthropic/v1';
const AI_MINIMAX_API_BASE_CHINA_ALIASES = Object.freeze([
    AI_MINIMAX_API_BASE_CHINA,
    'https://api.minimax.cn/anthropic',
    'https://api.minimaxi.com/anthropic/v1',
    'https://api.minimaxi.com/anthropic',
]);
const AI_KNOWN_API_BASE_ALIASES = Object.freeze([
    'https://api.anthropic.com',
    AI_ALIBABA_API_BASE_CHINA,
    'https://api.moonshot.cn/v1',
    'https://api.minimax.io/anthropic',
    ...AI_MINIMAX_API_BASE_CHINA_ALIASES,
]);
export const AI_DEFAULT_TARGET_LANGUAGE = 'zh-CN';
export const AI_DEFAULT_REASONING = 'none';
export const AI_PROVIDER_DEFAULT_REASONING = 'provider-default';
export const AI_DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
export const AI_DEFAULT_MAX_OUTPUT_TOKENS = 0;
export const AI_MAX_REQUEST_TIMEOUT_MS = 3_600_000;
export const AI_MAX_OUTPUT_TOKENS = 262_144;

const MAX_AI_API_BASE_LENGTH = 2_048;
const MAX_AI_API_KEY_LENGTH = 16_384;
const MAX_AI_MODEL_LENGTH = 512;
const MAX_AI_PROVIDER_PROFILES_LENGTH = 262_144;
export const AI_REASONING_ON = 'on';
const AI_REASONING_LEVELS = new Set([
    AI_DEFAULT_REASONING,
    AI_PROVIDER_DEFAULT_REASONING,
    AI_REASONING_ON,
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
]);
export const AI_TARGET_LANGUAGES = Object.freeze([
    'zh-CN',
    'zh-TW',
    'ja-JP',
    'ko-KR',
    'es-ES',
    'fr-FR',
    'pt-BR',
]);
const AI_TARGET_LANGUAGE_SET = new Set(AI_TARGET_LANGUAGES);
const AI_PROTOCOLS_BY_PROVIDER = Object.freeze({
    [AI_PROVIDER_OPENAI]: Object.freeze([
        AI_PROTOCOL_OPENAI_RESPONSES,
        AI_PROTOCOL_OPENAI_CHAT,
    ]),
    [AI_PROVIDER_ANTHROPIC]: Object.freeze([AI_PROTOCOL_ANTHROPIC]),
    [AI_PROVIDER_GOOGLE]: Object.freeze([AI_PROTOCOL_GOOGLE]),
    [AI_PROVIDER_DEEPSEEK]: Object.freeze([AI_PROTOCOL_OPENAI_CHAT]),
    [AI_PROVIDER_ALIBABA]: Object.freeze([AI_PROTOCOL_OPENAI_CHAT]),
    [AI_PROVIDER_MOONSHOT]: Object.freeze([AI_PROTOCOL_OPENAI_CHAT]),
    [AI_PROVIDER_MINIMAX]: Object.freeze([AI_PROTOCOL_ANTHROPIC]),
    [AI_PROVIDER_CUSTOM]: Object.freeze([
        AI_PROTOCOL_OPENAI_CHAT,
        AI_PROTOCOL_OPENAI_RESPONSES,
        AI_PROTOCOL_OPEN_RESPONSES,
        AI_PROTOCOL_ANTHROPIC,
        AI_PROTOCOL_GOOGLE,
    ]),
});

export function getAISettings(zotero) {
    const get = key => zotero?.Prefs?.get?.(key, true);
    const apiBase = get(AI_API_BASE_PREF);
    const rawProvider = String(get(AI_PROVIDER_PREF) || '').trim();
    const provider = normalizeProvider(rawProvider);
    return {
        enabled: true,
        autoTranslateSelection: get(AI_AUTO_TRANSLATE_SELECTION_PREF) === true,
        provider,
        protocol: normalizeProtocol(get(AI_PROTOCOL_PREF), provider, {
            legacyOpenAICompatible: rawProvider === AI_PROVIDER_OPENAI_COMPATIBLE,
        }),
        apiBase: normalizeProviderApiBase(
            provider,
            trimTrailingSlash(String(apiBase ?? AI_DEFAULT_API_BASE).trim())
        ),
        apiKey: String(get(AI_API_KEY_PREF) || '').trim(),
        model: String(get(AI_MODEL_PREF) || '').trim(),
        reasoning: normalizeStoredReasoning(get(AI_REASONING_PREF)),
        targetLanguage: normalizeTargetLanguage(
            get(AI_TARGET_LANGUAGE_PREF)
        ),
        requestTimeoutMs: normalizeInteger(
            get(AI_REQUEST_TIMEOUT_PREF),
            AI_DEFAULT_REQUEST_TIMEOUT_MS,
            1_000,
            AI_MAX_REQUEST_TIMEOUT_MS
        ),
        maxOutputTokens: AI_DEFAULT_MAX_OUTPUT_TOKENS,
        streaming: get(AI_STREAMING_PREF) !== false,
    };
}

export function emptyAIProviderProfile(providerValue) {
    const provider = normalizeProvider(providerValue);
    return {
        protocol: getAIProtocolsForProvider(provider)[0] || AI_PROTOCOL_OPENAI_CHAT,
        apiBase: defaultAIApiBaseForProvider(provider),
        apiKey: '',
        model: '',
        reasoning: AI_DEFAULT_REASONING,
        requestTimeoutMs: AI_DEFAULT_REQUEST_TIMEOUT_MS,
        maxOutputTokens: AI_DEFAULT_MAX_OUTPUT_TOKENS,
        streaming: true,
    };
}

export function readAIProviderProfiles(zotero) {
    return parseAIProviderProfiles(
        zotero?.Prefs?.get?.(AI_PROVIDER_PROFILES_PREF, true)
    );
}

export function syncCurrentAIProviderProfile(zotero) {
    const settings = getAISettings(zotero);
    const profiles = readAIProviderProfiles(zotero);
    profiles[settings.provider] = profileFromSettings(settings);
    writeAIProviderProfiles(zotero, profiles);
    return settings;
}

export function switchAIProvider(zotero, currentSettings, nextProviderValue) {
    const fromProvider = normalizeProvider(currentSettings?.provider);
    const toProvider = normalizeProvider(nextProviderValue);
    const profiles = readAIProviderProfiles(zotero);
    profiles[fromProvider] = profileFromSettings({
        ...getAISettings(zotero),
        ...currentSettings,
        provider: fromProvider,
    });
    const nextProfile = profiles[toProvider] || emptyAIProviderProfile(toProvider);
    writeAIProviderProfiles(zotero, profiles);
    applyAIProviderProfile(zotero, toProvider, nextProfile);
    return getAISettings(zotero);
}

export function observeAITargetLanguage(zotero, onChange) {
    if (typeof zotero?.Prefs?.registerObserver !== 'function'
        || typeof onChange !== 'function') {
        return () => {};
    }
    const observer = zotero.Prefs.registerObserver(
        AI_TARGET_LANGUAGE_PREF,
        value => onChange(normalizeTargetLanguage(value)),
        true
    );
    return () => zotero.Prefs.unregisterObserver?.(observer);
}

export function validateAISettings(settings = {}) {
    const rawProvider = String(settings.provider || '').trim();
    if (rawProvider
        && rawProvider !== AI_PROVIDER_OPENAI_COMPATIBLE
        && !Object.hasOwn(AI_PROTOCOLS_BY_PROVIDER, rawProvider)) {
        const error = new Error('The configured AI provider is not supported');
        error.code = 'AI_PROVIDER_UNSUPPORTED';
        throw error;
    }
    const provider = normalizeProvider(rawProvider);
    const requestedProtocol = String(settings.protocol || '').trim();
    if (rawProvider !== AI_PROVIDER_OPENAI_COMPATIBLE
        && requestedProtocol
        && !getAIProtocolsForProvider(provider).includes(requestedProtocol)) {
        const error = new Error(
            'The configured AI provider does not support this protocol'
        );
        error.code = 'AI_PROVIDER_UNSUPPORTED';
        throw error;
    }
    const protocol = normalizeProtocol(settings.protocol, provider, {
        legacyOpenAICompatible: rawProvider === AI_PROVIDER_OPENAI_COMPATIBLE,
    });
    if (!getAIProtocolsForProvider(provider).includes(protocol)) {
        const error = new Error(
            'The configured AI provider does not support this protocol'
        );
        error.code = 'AI_PROVIDER_UNSUPPORTED';
        throw error;
    }
    const apiBase = normalizeProviderApiBase(
        provider,
        normalizeAIBaseURL(settings.apiBase)
    );
    const model = String(settings.model || '').trim();
    if (!model) throw aiConfigurationError('An AI model is required');
    if (model.length > MAX_AI_MODEL_LENGTH || hasControlCharacters(model)) {
        throw aiConfigurationError('The AI model is invalid');
    }
    const apiKey = String(settings.apiKey || '').trim();
    if (apiKey.length > MAX_AI_API_KEY_LENGTH || /[\r\n\0]/.test(apiKey)) {
        throw aiConfigurationError('The AI API key is invalid');
    }
    if (!apiKey && !isLoopbackURL(apiBase)) {
        throw aiConfigurationError('An AI API key is required');
    }
    return {
        ...settings,
        enabled: true,
        provider,
        protocol,
        apiBase,
        apiKey,
        model,
        reasoning: normalizeReasoning(settings.reasoning),
        targetLanguage: normalizeTargetLanguage(settings.targetLanguage),
        requestTimeoutMs: normalizeInteger(
            settings.requestTimeoutMs,
            AI_DEFAULT_REQUEST_TIMEOUT_MS,
            1_000,
            AI_MAX_REQUEST_TIMEOUT_MS
        ),
        maxOutputTokens: AI_DEFAULT_MAX_OUTPUT_TOKENS,
        streaming: settings.streaming !== false,
    };
}

export function getAIProtocolsForProvider(providerValue) {
    const provider = normalizeProvider(providerValue);
    return AI_PROTOCOLS_BY_PROVIDER[provider] || [];
}

export function normalizeAIBaseURL(value) {
    const source = String(value || '').trim();
    if (!source || source.length > MAX_AI_API_BASE_LENGTH) {
        throw aiConfigurationError('The AI API base URL is invalid');
    }
    let url;
    try {
        url = new URL(source);
    }
    catch {
        throw aiConfigurationError('The AI API base URL is invalid');
    }
    if (url.username || url.password || url.search || url.hash) {
        throw aiConfigurationError('The AI API base URL is invalid');
    }
    const localHTTP = url.protocol === 'http:' && isLoopbackHost(url.hostname);
    if (url.protocol !== 'https:' && !localHTTP) {
        throw aiConfigurationError(
            'The AI API base URL must use HTTPS or a local HTTP address'
        );
    }
    return trimTrailingSlash(url.toString());
}

export function normalizeTargetLanguage(value) {
    const language = String(value || '').trim();
    return isSupportedAITargetLanguage(language)
        ? language
        : AI_DEFAULT_TARGET_LANGUAGE;
}

export function isSupportedAITargetLanguage(value) {
    return AI_TARGET_LANGUAGE_SET.has(String(value || '').trim());
}

export function normalizeReasoning(value) {
    const reasoning = String(value || '').trim();
    return AI_REASONING_LEVELS.has(reasoning)
        ? reasoning
        : AI_DEFAULT_REASONING;
}

function normalizeStoredReasoning(value) {
    const reasoning = String(value || '').trim();
    if (reasoning === AI_PROVIDER_DEFAULT_REASONING) {
        return AI_DEFAULT_REASONING;
    }
    return normalizeReasoning(reasoning);
}

export function defaultAIApiBaseForProvider(provider) {
    return AI_PROVIDER_API_BASES[normalizeProvider(provider)] || '';
}

export function alibabaApiBaseRegion(value) {
    return normalizeAlibabaApiBase(value) === AI_ALIBABA_API_BASE_CHINA
        ? 'china'
        : 'international';
}

export function alibabaApiBaseForRegion(region) {
    return region === 'china'
        ? AI_ALIBABA_API_BASE_CHINA
        : AI_ALIBABA_API_BASE_INTERNATIONAL;
}

export function moonshotApiBaseRegion(value) {
    return normalizeMoonshotApiBase(value) === AI_MOONSHOT_API_BASE_CHINA
        ? 'china'
        : 'international';
}

export function moonshotApiBaseForRegion(region) {
    return region === 'china'
        ? AI_MOONSHOT_API_BASE_CHINA
        : AI_MOONSHOT_API_BASE_INTERNATIONAL;
}

export function miniMaxApiBaseRegion(value) {
    return normalizeMiniMaxApiBase(value) === AI_MINIMAX_API_BASE_CHINA
        ? 'china'
        : 'international';
}

export function miniMaxApiBaseForRegion(region) {
    return region === 'china'
        ? AI_MINIMAX_API_BASE_CHINA
        : AI_MINIMAX_API_BASE_INTERNATIONAL;
}

function normalizeProviderApiBase(provider, apiBase) {
    if (provider === AI_PROVIDER_ALIBABA) {
        return normalizeAlibabaApiBase(apiBase);
    }
    if (provider === AI_PROVIDER_MOONSHOT) {
        return normalizeMoonshotApiBase(apiBase);
    }
    if (provider === AI_PROVIDER_MINIMAX) {
        return normalizeMiniMaxApiBase(apiBase);
    }
    return apiBase;
}

function normalizeAlibabaApiBase(value) {
    const current = trimTrailingSlash(String(value || '').trim());
    return current === AI_ALIBABA_API_BASE_CHINA
        ? AI_ALIBABA_API_BASE_CHINA
        : AI_ALIBABA_API_BASE_INTERNATIONAL;
}

function normalizeMoonshotApiBase(value) {
    const current = trimTrailingSlash(String(value || '').trim());
    return current === AI_MOONSHOT_API_BASE_CHINA
        ? AI_MOONSHOT_API_BASE_CHINA
        : AI_MOONSHOT_API_BASE_INTERNATIONAL;
}

function normalizeMiniMaxApiBase(value) {
    const current = trimTrailingSlash(String(value || '').trim());
    return AI_MINIMAX_API_BASE_CHINA_ALIASES.includes(current)
        ? AI_MINIMAX_API_BASE_CHINA
        : AI_MINIMAX_API_BASE_INTERNATIONAL;
}

export function isReplaceableAIApiBase(value) {
    const current = trimTrailingSlash(String(value || '').trim());
    if (!current) return true;
    return getKnownAIApiBases().has(current);
}

export function aiRequestTimeoutSecondsFromMs(value) {
    return Math.round(
        normalizeInteger(
            value,
            AI_DEFAULT_REQUEST_TIMEOUT_MS,
            1_000,
            AI_MAX_REQUEST_TIMEOUT_MS
        ) / 1_000
    );
}

export function aiRequestTimeoutMsFromSeconds(value) {
    return normalizeInteger(
        Number(value) * 1_000,
        AI_DEFAULT_REQUEST_TIMEOUT_MS,
        1_000,
        AI_MAX_REQUEST_TIMEOUT_MS
    );
}

function profileFromSettings(settings) {
    const provider = normalizeProvider(settings?.provider);
    return normalizeStoredProfile(provider, settings);
}

function applyAIProviderProfile(zotero, provider, profile) {
    const next = normalizeStoredProfile(provider, profile);
    const set = (key, value) => zotero?.Prefs?.set?.(key, value, true);
    set(AI_PROVIDER_PREF, provider);
    set(AI_PROTOCOL_PREF, next.protocol);
    set(AI_API_BASE_PREF, next.apiBase);
    set(AI_API_KEY_PREF, next.apiKey);
    set(AI_MODEL_PREF, next.model);
    set(AI_REASONING_PREF, next.reasoning);
    set(AI_REQUEST_TIMEOUT_PREF, next.requestTimeoutMs);
    set(AI_STREAMING_PREF, next.streaming);
}

function parseAIProviderProfiles(value) {
    const source = String(value || '').trim();
    if (!source || source.length > MAX_AI_PROVIDER_PROFILES_LENGTH) return {};
    let parsed;
    try {
        parsed = JSON.parse(source);
    }
    catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {};
    }
    const profiles = {};
    for (const [key, profile] of Object.entries(parsed)) {
        const provider = profileProviderKey(key);
        if (!provider || profiles[provider]) continue;
        profiles[provider] = normalizeStoredProfile(provider, profile);
    }
    return profiles;
}

function writeAIProviderProfiles(zotero, profiles) {
    const payload = {};
    for (const [provider, profile] of Object.entries(profiles || {})) {
        const id = profileProviderKey(provider);
        if (!id) continue;
        payload[id] = normalizeStoredProfile(id, profile);
    }
    const serialized = JSON.stringify(payload);
    if (serialized.length > MAX_AI_PROVIDER_PROFILES_LENGTH) return;
    zotero?.Prefs?.set?.(AI_PROVIDER_PROFILES_PREF, serialized, true);
}

function normalizeStoredProfile(provider, profile) {
    const source = profile && typeof profile === 'object' ? profile : {};
    const fallback = emptyAIProviderProfile(provider);
    const apiBase = source.apiBase == null
        ? fallback.apiBase
        : trimTrailingSlash(String(source.apiBase).trim()).slice(
            0,
            MAX_AI_API_BASE_LENGTH
        );
    return {
        protocol: normalizeProtocol(source.protocol, provider),
        apiBase: normalizeProviderApiBase(provider, apiBase),
        apiKey: String(source.apiKey || '').trim().slice(0, MAX_AI_API_KEY_LENGTH),
        model: String(source.model || '').trim().slice(0, MAX_AI_MODEL_LENGTH),
        reasoning: normalizeStoredReasoning(source.reasoning),
        requestTimeoutMs: normalizeInteger(
            source.requestTimeoutMs,
            AI_DEFAULT_REQUEST_TIMEOUT_MS,
            1_000,
            AI_MAX_REQUEST_TIMEOUT_MS
        ),
        maxOutputTokens: AI_DEFAULT_MAX_OUTPUT_TOKENS,
        streaming: source.streaming !== false,
    };
}

function getKnownAIApiBases() {
    return new Set([
        ...Object.values(AI_PROVIDER_API_BASES).map(trimTrailingSlash),
        ...AI_KNOWN_API_BASE_ALIASES.map(trimTrailingSlash),
    ]);
}

function profileProviderKey(value) {
    const provider = String(value || '').trim();
    if (provider === AI_PROVIDER_OPENAI_COMPATIBLE) return AI_PROVIDER_CUSTOM;
    return Object.hasOwn(AI_PROTOCOLS_BY_PROVIDER, provider) ? provider : '';
}

function normalizeProvider(value) {
    const provider = String(value || '').trim();
    if (provider === AI_PROVIDER_OPENAI_COMPATIBLE) {
        return AI_PROVIDER_CUSTOM;
    }
    return Object.hasOwn(AI_PROTOCOLS_BY_PROVIDER, provider)
        ? provider
        : AI_PROVIDER_CUSTOM;
}

function normalizeProtocol(value, provider, { legacyOpenAICompatible = false } = {}) {
    if (legacyOpenAICompatible) return AI_PROTOCOL_OPENAI_CHAT;
    const protocol = String(value || '').trim();
    if (getAIProtocolsForProvider(provider).includes(protocol)) return protocol;
    return getAIProtocolsForProvider(provider)[0] || AI_PROTOCOL_OPENAI_CHAT;
}

function normalizeInteger(value, fallback, minimum, maximum) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(minimum, Math.min(maximum, Math.round(number)));
}

function trimTrailingSlash(value) {
    return String(value || '').replace(/\/+$/, '');
}

function isLoopbackURL(value) {
    try {
        return isLoopbackHost(new URL(value).hostname);
    }
    catch {
        return false;
    }
}

function isLoopbackHost(hostname) {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(
        String(hostname || '').toLowerCase()
    );
}

function aiConfigurationError(message) {
    const error = new Error(message);
    error.code = 'AI_CONFIGURATION_ERROR';
    return error;
}

function hasControlCharacters(value) {
    return /[\u0000-\u001f\u007f]/.test(value);
}
