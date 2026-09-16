import {
    AI_PROVIDER_ALIBABA,
    AI_PROVIDER_ANTHROPIC,
    AI_PROVIDER_DEEPSEEK,
    AI_PROVIDER_GOOGLE,
    AI_PROVIDER_MINIMAX,
    AI_PROVIDER_MOONSHOT,
    AI_PROVIDER_OPENAI,
} from './ai-preferences.js';

export const MODELS_DEV_REASONING_CATALOG_URL = 'https://models.dev/api.json';
export const MODELS_DEV_REASONING_CATALOG_TIMEOUT_MS = 30_000;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const PLAN_SUFFIXES = ['-coding-plan', '-token-plan', '-step-plan'];
const LAB_PROVIDERS = Object.freeze([
    AI_PROVIDER_OPENAI,
    AI_PROVIDER_ANTHROPIC,
    AI_PROVIDER_GOOGLE,
    AI_PROVIDER_DEEPSEEK,
    AI_PROVIDER_ALIBABA,
    AI_PROVIDER_MOONSHOT,
    AI_PROVIDER_MINIMAX,
]);
const CURATED_HOSTS = Object.freeze({
    'api.openai.com': AI_PROVIDER_OPENAI,
    'api.anthropic.com': AI_PROVIDER_ANTHROPIC,
    'generativelanguage.googleapis.com': AI_PROVIDER_GOOGLE,
    'api.deepseek.com': AI_PROVIDER_DEEPSEEK,
    'dashscope-intl.aliyuncs.com': AI_PROVIDER_ALIBABA,
    'dashscope.aliyuncs.com': AI_PROVIDER_ALIBABA,
    'api.moonshot.ai': AI_PROVIDER_MOONSHOT,
    'api.moonshot.cn': AI_PROVIDER_MOONSHOT,
    'api.minimax.io': AI_PROVIDER_MINIMAX,
    'api.minimax.cn': AI_PROVIDER_MINIMAX,
    'api.minimaxi.com': AI_PROVIDER_MINIMAX,
});

export function compactAIReasoningCatalog(data) {
    const providers = {};
    for (const [providerId, record] of Object.entries(data || {})) {
        const models = compactProviderModels(record?.models);
        if (Object.keys(models).length) providers[providerId] = models;
    }
    return {
        source: MODELS_DEV_REASONING_CATALOG_URL,
        labProviders: [...LAB_PROVIDERS],
        hosts: collectHosts(data, providers),
        providers,
    };
}

export function createAIReasoningCatalogStore({
    fetch,
    createAbortController,
    setTimer,
    clearTimer,
    url = MODELS_DEV_REASONING_CATALOG_URL,
    timeoutMs = MODELS_DEV_REASONING_CATALOG_TIMEOUT_MS,
} = {}) {
    let catalog = null;
    let settled = false;
    let loading = false;
    let controller = null;
    let timeoutID = null;
    const listeners = new Set();

    return {
        getCatalog() {
            return catalog;
        },
        subscribe(listener) {
            if (typeof listener !== 'function') return () => {};
            listeners.add(listener);
            if (settled) listener(catalog);
            return () => listeners.delete(listener);
        },
        async load() {
            if (settled || loading) return catalog;
            if (typeof fetch !== 'function'
                || typeof createAbortController !== 'function') {
                settled = true;
                notify();
                return catalog;
            }
            loading = true;
            controller = createAbortController();
            const signal = controller.signal;
            if (timeoutMs > 0 && typeof setTimer === 'function') {
                timeoutID = setTimer(() => controller?.abort(), timeoutMs);
            }
            try {
                const response = await Promise.race([
                    fetch(url, {
                        method: 'GET',
                        headers: { accept: 'application/json' },
                        signal,
                    }),
                    abortPromise(signal),
                ]);
                if (!response?.ok || signal.aborted) return catalog;
                const text = await response.text();
                if (signal.aborted) return catalog;
                catalog = compactAIReasoningCatalog(JSON.parse(text));
                return catalog;
            }
            catch {
                return catalog;
            }
            finally {
                loading = false;
                settled = true;
                controller = null;
                if (timeoutID != null && typeof clearTimer === 'function') {
                    clearTimer(timeoutID);
                }
                timeoutID = null;
                notify();
            }
        },
        dispose() {
            controller?.abort();
            catalog = null;
            settled = false;
            loading = false;
            controller = null;
            if (timeoutID != null && typeof clearTimer === 'function') {
                clearTimer(timeoutID);
            }
            timeoutID = null;
            listeners.clear();
        },
    };

    function notify() {
        for (const listener of listeners) listener(catalog);
    }
}

export function bindZoteroWindowFetch(zotero) {
    try {
        const runtimeWindow = zotero?.getMainWindow?.();
        return typeof runtimeWindow?.fetch === 'function'
            ? runtimeWindow.fetch.bind(runtimeWindow)
            : undefined;
    }
    catch {
        return undefined;
    }
}

export function attachAIReasoningCatalogHost(zotero, store) {
    if (!zotero || !store) return () => {};
    const host = zotero.Mktero && typeof zotero.Mktero === 'object'
        ? zotero.Mktero
        : (zotero.Mktero = {});
    host.getAIReasoningCatalog = () => store.getCatalog();
    host.subscribeAIReasoningCatalog = listener => store.subscribe(listener);
    return () => {
        if (zotero.Mktero !== host) return;
        delete host.getAIReasoningCatalog;
        delete host.subscribeAIReasoningCatalog;
        if (!Object.keys(host).length) delete zotero.Mktero;
    };
}

function compactProviderModels(models) {
    const compacted = {};
    for (const [modelId, model] of Object.entries(models || {})) {
        const reasoning = model?.reasoning === true;
        compacted[modelId] = reasoning
            ? {
                reasoning: true,
                options: Array.isArray(model.reasoning_options)
                    ? model.reasoning_options
                    : [],
            }
            : { reasoning: false };
    }
    return compacted;
}

function collectHosts(data, providers) {
    const hosts = {};
    for (const [providerId, record] of Object.entries(data || {})) {
        if (!providers[providerId]) continue;
        const host = hostnameFromApi(record?.api);
        if (!host || LOOPBACK_HOSTS.has(host)) continue;
        hosts[host] = preferProvider(hosts[host], providerId);
    }
    return { ...hosts, ...CURATED_HOSTS };
}

function preferProvider(current, candidate) {
    if (!current) return candidate;
    return providerScore(candidate) > providerScore(current)
        ? candidate
        : current;
}

function providerScore(providerId) {
    let score = 0;
    if (LAB_PROVIDERS.includes(providerId)) score += 100;
    if (PLAN_SUFFIXES.some(suffix => providerId.endsWith(suffix))) score -= 50;
    return score;
}

function hostnameFromApi(value) {
    try {
        return new URL(String(value || '').trim()).hostname.toLowerCase();
    }
    catch {
        return '';
    }
}

function abortPromise(signal) {
    return new Promise((_, reject) => {
        const abort = () => reject(signal?.reason || new Error('Aborted'));
        if (signal?.aborted) {
            abort();
            return;
        }
        signal?.addEventListener('abort', abort, { once: true });
    });
}
