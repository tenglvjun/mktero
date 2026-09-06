import { createZoteroMarkdownCache } from '../cache/markdown-cache.js';
import {
    notifyLocalCacheCleared,
    withSuccessfulClearNotification,
} from '../cache/cache-events.js';
import {
    createZoteroPDFTextIndexCache,
} from '../cache/pdf-text-index-cache.js';
import { createZoteroTranslationCache } from '../cache/translation-cache.js';
import {
    createZoteroCitationGraphCache,
} from '../cache/citation-graph-cache.js';
import {
    AI_PROTOCOL_PREF,
    getAIProtocolsForProvider,
    getAISettings,
} from '../config/ai-preferences.js';
import { AISDKGateway } from '../ai/ai-sdk-gateway.js';
import {
    MarkdownTranslationService,
} from '../ai/markdown-translation-service.js';
import { createRuntimeAbortController } from '../platform/abort-controller.js';
import {
    getZoteroLocale,
    PREFERENCE_CONTROL_LIMITS,
} from '../config/mineru-preferences.js';
import {
    CONVERSION_PROVIDER_MINERU,
    CONVERSION_PROVIDER_MISTRAL,
    MISTRAL_API_KEY_PREF,
    MINERU_API_KEY_PREF,
    getConversionProvider,
    getMinerUApiKey,
    getMistralApiKey,
    normalizeConversionProvider,
} from '../config/conversion-preferences.js';
import {
    getMarkdownReaderFont,
    getMarkdownReaderFontSize,
    setMarkdownReaderFont,
    setMarkdownReaderFontSize,
} from '../config/reader-preferences.js';
import {
    createLocalization,
    translateEnglish,
} from '../i18n/localization.js';

export function registerPreferencesPaneLoader({ document, initialize }) {
    const initializations = new Map();
    const disposePane = pane => {
        const record = initializations.get(pane);
        if (!record) return;
        initializations.delete(pane);
        record.disposed = true;
        record.initialization.then(cleanup => cleanup?.(), () => {});
    };
    const handleLoad = event => {
        const pane = event.target;
        if (pane?.id !== 'mktero-preferences-pane') return;
        let record = initializations.get(pane);
        if (!record) {
            record = { disposed: false, initialization: null };
            record.initialization = Promise.resolve()
                .then(() => initialize(event))
                .then(cleanup => {
                    if (record.disposed) cleanup?.();
                    return record.disposed ? null : cleanup;
                });
            initializations.set(pane, record);
        }
        event.waitUntil?.(record.initialization);
    };
    const handleUnload = event => {
        const pane = event.target;
        if (pane?.id === 'mktero-preferences-pane') disposePane(pane);
    };
    const dispose = () => {
        document.removeEventListener('load', handleLoad, true);
        document.removeEventListener('unload', handleUnload, true);
        document.defaultView?.removeEventListener('unload', dispose);
        for (const pane of initializations.keys()) disposePane(pane);
    };
    document.addEventListener('load', handleLoad, true);
    document.addEventListener('unload', handleUnload, true);
    document.defaultView?.addEventListener('unload', dispose);
    return dispose;
}

export function createPreferencesController({
    document,
    zotero,
    cache,
    services = typeof Services === 'undefined' ? null : Services,
    localization = createLocalization({
        zoteroLocale: getZoteroLocale(zotero, services),
    }),
    testAIConnection = null,
    createAbortController = createRuntimeAbortController,
}) {
    const status = document.getElementById('mktero-cache-status');
    const clearButton = document.getElementById('mktero-clear-cache');
    const readerFontSizeInput = document.getElementById(
        'mktero-reader-font-size'
    );
    const readerFontSizeValue = document.getElementById(
        'mktero-reader-font-size-value'
    );
    const readerFontInput = document.getElementById(
        'mktero-reader-font-family'
    );
    const conversionProviderInput = document.getElementById(
        'mktero-conversion-provider'
    );
    const conversionApiKeyInput = document.getElementById(
        'mktero-api-key'
    );
    const conversionApiKeyManage = document.getElementById(
        'mktero-api-key-manage'
    );
    const aiTestButton = document.getElementById('mktero-ai-test');
    const aiTestStatus = document.getElementById('mktero-ai-test-status');
    const aiProviderInput = document.getElementById('mktero-ai-provider');
    const aiProtocolInput = document.getElementById('mktero-ai-protocol');
    const aiRequestTimeoutInput = document.getElementById(
        'mktero-ai-request-timeout'
    );
    const aiMaxOutputTokensInput = document.getElementById(
        'mktero-ai-max-output-tokens'
    );
    const t = (key, variables) => localization.t(key, variables);
    let initialized = false;
    let aiTestController = null;

    function localize() {
        localizePreferencesDocument(document, localization);
    }

    function updateReaderFontSize() {
        if (!readerFontSizeInput || !readerFontSizeValue) return;
        const size = setMarkdownReaderFontSize(
            zotero,
            readerFontSizeInput.value
        );
        readerFontSizeInput.value = String(size);
        readerFontSizeValue.textContent = t('viewer.textSizeValue', { size });
    }

    function initializeReaderFontSize() {
        if (!readerFontSizeInput || !readerFontSizeValue) return;
        const size = getMarkdownReaderFontSize(zotero);
        readerFontSizeInput.value = String(size);
        readerFontSizeValue.textContent = t('viewer.textSizeValue', { size });
        readerFontSizeInput.addEventListener('input', updateReaderFontSize);
    }

    function updateReaderFont() {
        if (!readerFontInput) return;
        readerFontInput.value = setMarkdownReaderFont(
            zotero,
            readerFontInput.value
        );
    }

    function initializeReaderFont() {
        if (!readerFontInput) return;
        readerFontInput.value = getMarkdownReaderFont(zotero);
        readerFontInput.addEventListener('change', updateReaderFont);
    }

    function getSelectedConversionProvider() {
        return normalizeConversionProvider(
            conversionProviderInput?.value || getConversionProvider(zotero)
        );
    }

    function getConversionApiKeyConfig(provider) {
        if (provider === CONVERSION_PROVIDER_MISTRAL) {
            return {
                preference: MISTRAL_API_KEY_PREF,
                value: getMistralApiKey(zotero),
                manageURL: 'https://console.mistral.ai/api-keys/',
            };
        }
        return {
            preference: MINERU_API_KEY_PREF,
            value: getMinerUApiKey(zotero),
            manageURL: 'https://mineru.net/apiManage/token',
        };
    }

    function updateConversionApiKeyControl() {
        if (!conversionApiKeyInput) return;
        const config = getConversionApiKeyConfig(
            getSelectedConversionProvider()
        );
        conversionApiKeyInput.value = config.value;
        if (conversionApiKeyManage) {
            conversionApiKeyManage.setAttribute('href', config.manageURL);
        }
    }

    function saveConversionApiKey() {
        if (!conversionApiKeyInput) return;
        const config = getConversionApiKeyConfig(
            getSelectedConversionProvider()
        );
        zotero?.Prefs?.set?.(config.preference, conversionApiKeyInput.value, true);
    }

    function initializeConversionProvider() {
        if (!conversionProviderInput) {
            updateConversionApiKeyControl();
            return;
        }
        conversionProviderInput.value = getConversionProvider(zotero);
        updateConversionApiKeyControl();
        conversionProviderInput.addEventListener(
            'change',
            updateConversionApiKeyControl
        );
        conversionApiKeyInput?.addEventListener(
            'change',
            saveConversionApiKey
        );
    }

    function updateAIProtocolOptions({ persist = true } = {}) {
        if (!aiProviderInput || !aiProtocolInput) return;
        const protocols = getAIProtocolsForProvider(aiProviderInput.value);
        for (const option of aiProtocolInput.options) {
            const available = protocols.includes(option.value);
            option.hidden = !available;
            option.disabled = !available;
        }
        if (!protocols.includes(aiProtocolInput.value)) {
            aiProtocolInput.value = protocols[0] || '';
            if (persist && aiProtocolInput.value) {
                zotero?.Prefs?.set?.(
                    AI_PROTOCOL_PREF,
                    aiProtocolInput.value,
                    true
                );
            }
        }
        aiProtocolInput.disabled = protocols.length < 2;
    }

    function initializeAIProvider() {
        if (!aiProviderInput || !aiProtocolInput) return;
        const settings = getAISettings(zotero);
        aiProviderInput.value = settings.provider;
        aiProtocolInput.value = settings.protocol;
        updateAIProtocolOptions({ persist: false });
        aiProviderInput.addEventListener('change', updateAIProtocolOptions);
    }

    function initializePreferenceControlLimits() {
        if (aiRequestTimeoutInput) {
            aiRequestTimeoutInput.max = String(
                PREFERENCE_CONTROL_LIMITS.aiRequestTimeoutMs
            );
        }
        if (aiMaxOutputTokensInput) {
            aiMaxOutputTokensInput.max = String(
                PREFERENCE_CONTROL_LIMITS.aiMaxOutputTokens
            );
        }
    }

    async function refresh() {
        status.setAttribute('aria-busy', 'true');
        try {
            status.textContent = formatCacheStats(await cache.getStats(), t);
        }
        catch (error) {
            zotero.logError?.(error);
            status.textContent = t('preferences.cache.unavailable');
        }
        finally {
            status.setAttribute('aria-busy', 'false');
        }
    }

    async function clear() {
        clearButton.disabled = true;
        status.setAttribute('aria-busy', 'true');
        status.textContent = t('preferences.cache.clearing');
        try {
            await cache.clear();
            await refresh();
        }
        catch (error) {
            zotero.logError?.(error);
            status.textContent = t('preferences.cache.clearFailed');
        }
        finally {
            clearButton.disabled = false;
            status.setAttribute('aria-busy', 'false');
        }
    }

    async function testAI() {
        if (!aiTestButton || typeof testAIConnection !== 'function') return;
        aiTestController?.abort?.();
        aiTestController = createAbortController();
        const controller = aiTestController;
        aiTestButton.disabled = true;
        if (aiTestStatus) aiTestStatus.textContent = t('preferences.ai.testing');
        try {
            await testAIConnection(
                readAISettingsFromControls(document, zotero),
                controller.signal
            );
            if (aiTestController === controller && aiTestStatus) {
                aiTestStatus.textContent = t('preferences.ai.testSuccess');
            }
        }
        catch (error) {
            if (controller.signal?.aborted) return;
            zotero.logError?.(error);
            if (aiTestController === controller && aiTestStatus) {
                aiTestStatus.textContent = t(aiTestErrorKey(error));
            }
        }
        finally {
            if (aiTestController === controller) {
                aiTestController = null;
                aiTestButton.disabled = false;
            }
        }
    }

    return {
        async init() {
            if (initialized) return;
            initialized = true;
            clearButton.addEventListener('click', clear);
            aiTestButton?.addEventListener('click', testAI);
            localize();
            initializeConversionProvider();
            initializeAIProvider();
            initializePreferenceControlLimits();
            initializeReaderFont();
            initializeReaderFontSize();
            await refresh();
        },
        destroy() {
            if (!initialized) return;
            initialized = false;
            clearButton.removeEventListener('click', clear);
            aiTestButton?.removeEventListener('click', testAI);
            aiTestController?.abort?.();
            aiTestController = null;
            aiProviderInput?.removeEventListener(
                'change',
                updateAIProtocolOptions
            );
            conversionProviderInput?.removeEventListener(
                'change',
                updateConversionApiKeyControl
            );
            conversionApiKeyInput?.removeEventListener(
                'change',
                saveConversionApiKey
            );
            readerFontSizeInput?.removeEventListener(
                'input',
                updateReaderFontSize
            );
            readerFontInput?.removeEventListener('change', updateReaderFont);
        },
    };
}

export function readAISettingsFromControls(document, zotero) {
    const settings = getAISettings(zotero);
    const value = id => document.getElementById(id)?.value;
    return {
        ...settings,
        enabled: document.getElementById('mktero-ai-enabled')?.checked
            ?? settings.enabled,
        autoTranslateSelection: document.getElementById(
            'mktero-ai-auto-translate-selection'
        )?.checked ?? settings.autoTranslateSelection,
        provider: value('mktero-ai-provider') ?? settings.provider,
        protocol: value('mktero-ai-protocol') ?? settings.protocol,
        apiBase: value('mktero-ai-api-base') ?? settings.apiBase,
        apiKey: value('mktero-ai-api-key') ?? settings.apiKey,
        model: value('mktero-ai-model') ?? settings.model,
        targetLanguage: value('mktero-ai-target-language')
            ?? settings.targetLanguage,
        requestTimeoutMs: value('mktero-ai-request-timeout')
            ?? settings.requestTimeoutMs,
        maxOutputTokens: value('mktero-ai-max-output-tokens')
            ?? settings.maxOutputTokens,
        streaming: document.getElementById('mktero-ai-streaming')
            ?.checked ?? settings.streaming,
    };
}

function aiTestErrorKey(error) {
    if (error?.code === 'AI_AUTH_ERROR') {
        return 'preferences.ai.testAuthenticationFailed';
    }
    if (error?.code === 'AI_RATE_LIMITED') {
        return 'preferences.ai.testRateLimited';
    }
    if (error?.code === 'AI_CONFIGURATION_ERROR'
        || error?.code === 'AI_PROVIDER_UNSUPPORTED') {
        return 'preferences.ai.testConfigurationFailed';
    }
    return 'preferences.ai.testFailed';
}

export function localizePreferencesDocument(document, localization) {
    for (const element of document.querySelectorAll?.('[data-i18n]') || []) {
        element.textContent = localization.t(element.getAttribute('data-i18n'));
    }
    document.getElementById('mktero-preferences-pane')
        ?.setAttribute('lang', localization.language);
}

export function createCombinedLocalCache(caches) {
    const stores = Array.from(caches || []);
    if (!stores.length || stores.some(cache => (
        typeof cache?.getStats !== 'function'
        || typeof cache?.clear !== 'function'
    ))) {
        throw new TypeError('Local cache stores are required');
    }
    return {
        async getStats() {
            const statistics = await Promise.all(
                stores.map(cache => cache.getStats())
            );
            return statistics.reduce((combined, current) => {
                validateCacheStats(current);
                return {
                    entries: combined.entries + current.entries,
                    sizeBytes: combined.sizeBytes + current.sizeBytes,
                };
            }, { entries: 0, sizeBytes: 0 });
        },
        async clear() {
            await Promise.all(stores.map(cache => cache.clear()));
        },
    };
}

export function formatCacheStats({ entries, sizeBytes }, translate = translateEnglish) {
    if (!entries) return translate('preferences.cache.stats.none');
    return translate(
        entries === 1
            ? 'preferences.cache.stats.one'
            : 'preferences.cache.stats.many',
        {
            count: entries,
            size: formatBytes(sizeBytes),
        }
    );
}

function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${trimDecimal(bytes / 1024)} KB`;
    if (bytes < 1024 * 1024 * 1024) {
        return `${trimDecimal(bytes / (1024 * 1024))} MB`;
    }
    return `${trimDecimal(bytes / (1024 * 1024 * 1024))} GB`;
}

function trimDecimal(value) {
    return value.toFixed(1).replace(/\.0$/, '');
}

function validateCacheStats(value) {
    if (!Number.isSafeInteger(value?.entries)
        || value.entries < 0
        || !Number.isSafeInteger(value?.sizeBytes)
        || value.sizeBytes < 0) {
        throw new Error('Invalid local cache statistics');
    }
}

globalThis.MkteroPreferences = {
    async init(event) {
        const document = event.target?.ownerDocument
            || event.currentTarget?.ownerDocument
            || globalThis.document;
        const markdownCache = createZoteroMarkdownCache({
            zotero: Zotero,
            ioUtils: IOUtils,
            pathUtils: PathUtils,
        });
        const cache = createCombinedLocalCache([
            withSuccessfulClearNotification(markdownCache, () => (
                notifyLocalCacheCleared(
                    typeof Services === 'undefined' ? null : Services
                )
            )),
            createZoteroPDFTextIndexCache({
                zotero: Zotero,
                ioUtils: IOUtils,
                pathUtils: PathUtils,
            }),
            createZoteroTranslationCache({
                zotero: Zotero,
                ioUtils: IOUtils,
                pathUtils: PathUtils,
            }),
            createZoteroCitationGraphCache({
                zotero: Zotero,
                ioUtils: IOUtils,
                pathUtils: PathUtils,
            }),
        ]);
        const aiGateway = new AISDKGateway({
            createAbortController: createRuntimeAbortController,
            runtimeWindow: document?.defaultView,
        });
        const translationService = new MarkdownTranslationService({
            aiGateway,
            getSettings: () => getAISettings(Zotero),
        });
        const controller = createPreferencesController({
            document,
            zotero: Zotero,
            cache,
            testAIConnection: (settings, signal) => (
                translationService.testConnection({ settings, signal })
            ),
            createAbortController: createRuntimeAbortController,
        });
        await controller.init();
        return () => controller.destroy();
    },
};

if (globalThis.document?.addEventListener) {
    registerPreferencesPaneLoader({
        document: globalThis.document,
        initialize: event => globalThis.MkteroPreferences.init(event),
    });
}
