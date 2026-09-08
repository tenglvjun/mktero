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
    AI_API_BASE_PREF,
    AI_PROTOCOL_PREF,
    AI_PROVIDER_CUSTOM,
    AI_REQUEST_TIMEOUT_PREF,
    aiRequestTimeoutMsFromSeconds,
    aiRequestTimeoutSecondsFromMs,
    defaultAIApiBaseForProvider,
    getAIProtocolsForProvider,
    getAISettings,
    isReplaceableAIApiBase,
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
    createLucideIcon,
    LUCIDE_ICONS,
} from '../icons/lucide-icon.js';
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
    notifyAITestResult = null,
    confirmClearCache = null,
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
    const aiEnabledInput = document.getElementById('mktero-ai-enabled');
    const aiSettings = document.getElementById('mktero-ai-settings');
    const aiTestButton = document.getElementById('mktero-ai-test');
    const aiProviderInput = document.getElementById('mktero-ai-provider');
    const aiProtocolInput = document.getElementById('mktero-ai-protocol');
    const aiApiBaseInput = document.getElementById('mktero-ai-api-base');
    const aiApiBaseRow = document.getElementById('mktero-ai-api-base-row');
    const aiProtocolRow = document.getElementById('mktero-ai-protocol-row');
    const aiRequestTimeoutInput = document.getElementById(
        'mktero-ai-request-timeout'
    );
    const aiMaxOutputTokensInput = document.getElementById(
        'mktero-ai-max-output-tokens'
    );
    const tabList = document.getElementById('mktero-pref-tablist');
    const t = (key, variables) => localization.t(key, variables);
    let initialized = false;
    let aiTestController = null;

    function localize() {
        localizePreferencesDocument(document, localization);
    }

    function preferenceTabs() {
        return [...(tabList?.querySelectorAll('[role="tab"]') || [])];
    }

    function selectPreferenceTab(tab, { focus = false } = {}) {
        if (!tab || !tabList) return;
        for (const candidate of preferenceTabs()) {
            const selected = candidate === tab;
            candidate.setAttribute(
                'aria-selected',
                selected ? 'true' : 'false'
            );
            candidate.tabIndex = selected ? 0 : -1;
            const panel = document.getElementById(
                candidate.getAttribute('aria-controls')
            );
            if (panel) panel.hidden = !selected;
        }
        if (focus) tab.focus?.();
    }

    function handlePreferenceTabClick(event) {
        selectPreferenceTab(event.currentTarget);
    }

    function handlePreferenceTabKeydown(event) {
        const tabs = preferenceTabs();
        const index = tabs.indexOf(event.currentTarget);
        if (index < 0) return;
        let next = -1;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
            next = (index + 1) % tabs.length;
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
            next = (index - 1 + tabs.length) % tabs.length;
        } else if (event.key === 'Home') {
            next = 0;
        } else if (event.key === 'End') {
            next = tabs.length - 1;
        }
        if (next < 0) return;
        event.preventDefault();
        selectPreferenceTab(tabs[next], { focus: true });
    }

    function initializePreferenceTabs() {
        if (!tabList) return;
        tabList.setAttribute('aria-label', t('preferences.tabsLabel'));
        for (const host of document.querySelectorAll('[data-tab-icon]')) {
            const icon = LUCIDE_ICONS[host.getAttribute('data-tab-icon')];
            if (!icon || host.querySelector('svg')) continue;
            host.replaceChildren(createLucideIcon(document, icon, {
                className: 'mktero-pref-tab-svg',
                size: 14,
            }));
        }
        for (const tab of preferenceTabs()) {
            tab.addEventListener('click', handlePreferenceTabClick);
            tab.addEventListener('keydown', handlePreferenceTabKeydown);
        }
        selectPreferenceTab(
            tabList.querySelector('[role="tab"][aria-selected="true"]')
            || preferenceTabs()[0]
        );
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

    function updateAISettingsVisibility() {
        if (!aiSettings) return;
        aiSettings.hidden = aiEnabledInput?.checked !== true;
    }

    function updateAIApiBaseForProvider({ persist = true } = {}) {
        if (!aiProviderInput || !aiApiBaseInput) return;
        const provider = aiProviderInput.value;
        const next = defaultAIApiBaseForProvider(provider);
        if (next && isReplaceableAIApiBase(aiApiBaseInput.value)) {
            aiApiBaseInput.value = next;
            if (persist) {
                zotero?.Prefs?.set?.(AI_API_BASE_PREF, next, true);
            }
        }
        updateAICustomFieldVisibility();
    }

    function updateAICustomFieldVisibility() {
        const custom = aiProviderInput?.value === AI_PROVIDER_CUSTOM;
        if (aiApiBaseRow) aiApiBaseRow.hidden = !custom;
        if (aiProtocolRow) aiProtocolRow.hidden = !custom;
    }

    function initializeAITestButton() {
        if (!aiTestButton) return;
        const label = t('preferences.ai.test');
        aiTestButton.setAttribute('aria-label', label);
        aiTestButton.setAttribute('title', label);
        if (!aiTestButton.querySelector('svg')) {
            aiTestButton.appendChild(createLucideIcon(
                document,
                LUCIDE_ICONS.zap,
                { className: 'mktero-ai-test-svg', size: 16 }
            ));
        }
    }

    function initializeAIProvider() {
        const settings = getAISettings(zotero);
        if (aiEnabledInput) {
            aiEnabledInput.checked = settings.enabled;
            aiEnabledInput.addEventListener('change', updateAISettingsVisibility);
        }
        updateAISettingsVisibility();
        initializeAITestButton();
        if (!aiProviderInput || !aiProtocolInput) return;
        aiProviderInput.value = settings.provider;
        aiProtocolInput.value = settings.protocol;
        updateAIProtocolOptions({ persist: false });
        updateAICustomFieldVisibility();
        aiProviderInput.addEventListener('change', handleAIProviderChange);
    }

    function handleAIProviderChange() {
        updateAIProtocolOptions();
        updateAIApiBaseForProvider();
    }

    function saveAIRequestTimeout() {
        if (!aiRequestTimeoutInput) return;
        const timeoutMs = aiRequestTimeoutMsFromSeconds(
            aiRequestTimeoutInput.value
        );
        aiRequestTimeoutInput.value = String(
            aiRequestTimeoutSecondsFromMs(timeoutMs)
        );
        zotero?.Prefs?.set?.(AI_REQUEST_TIMEOUT_PREF, timeoutMs, true);
    }

    function initializeAIRequestTimeout() {
        if (!aiRequestTimeoutInput) return;
        const timeoutMs = getAISettings(zotero).requestTimeoutMs;
        aiRequestTimeoutInput.max = String(
            aiRequestTimeoutSecondsFromMs(
                PREFERENCE_CONTROL_LIMITS.aiRequestTimeoutMs
            )
        );
        aiRequestTimeoutInput.value = String(
            aiRequestTimeoutSecondsFromMs(timeoutMs)
        );
        aiRequestTimeoutInput.addEventListener('change', saveAIRequestTimeout);
    }

    function initializePreferenceControlLimits() {
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

    async function confirmCacheClear() {
        const title = t('preferences.cache.clearConfirmTitle');
        const message = t('preferences.cache.clearConfirmMessage');
        if (typeof confirmClearCache === 'function') {
            return confirmClearCache({ title, message });
        }
        const win = document.defaultView;
        if (services?.prompt?.confirm) {
            return services.prompt.confirm(win, title, message);
        }
        if (typeof win?.confirm === 'function') {
            return win.confirm(message);
        }
        return false;
    }

    async function clear() {
        if (!await confirmCacheClear()) return;
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

    function notifyAITest(message) {
        const title = t('preferences.ai.test');
        if (typeof notifyAITestResult === 'function') {
            notifyAITestResult({ title, message });
            return;
        }
        const win = document.defaultView;
        if (services?.prompt?.alert) {
            services.prompt.alert(win, title, message);
            return;
        }
        win?.alert?.(message);
    }

    async function testAI() {
        if (!aiTestButton || typeof testAIConnection !== 'function') return;
        if (aiTestController) return;
        aiTestController = createAbortController();
        const controller = aiTestController;
        aiTestButton.disabled = true;
        try {
            await testAIConnection(
                readAISettingsFromControls(document, zotero),
                controller.signal
            );
            if (aiTestController === controller) {
                notifyAITest(t('preferences.ai.testSuccess'));
            }
        }
        catch (error) {
            if (controller.signal?.aborted) return;
            zotero.logError?.(error);
            if (aiTestController === controller) {
                notifyAITest(t(aiTestErrorKey(error)));
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
            initializePreferenceTabs();
            initializeConversionProvider();
            initializeAIProvider();
            initializeAIRequestTimeout();
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
            aiEnabledInput?.removeEventListener(
                'change',
                updateAISettingsVisibility
            );
            aiProviderInput?.removeEventListener(
                'change',
                handleAIProviderChange
            );
            aiRequestTimeoutInput?.removeEventListener(
                'change',
                saveAIRequestTimeout
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
            for (const tab of preferenceTabs()) {
                tab.removeEventListener('click', handlePreferenceTabClick);
                tab.removeEventListener('keydown', handlePreferenceTabKeydown);
            }
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
        reasoning: value('mktero-ai-reasoning') ?? settings.reasoning,
        targetLanguage: value('mktero-ai-target-language')
            ?? settings.targetLanguage,
        requestTimeoutMs: value('mktero-ai-request-timeout') == null
            ? settings.requestTimeoutMs
            : aiRequestTimeoutMsFromSeconds(value('mktero-ai-request-timeout')),
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
