import { createZoteroMarkdownCache } from '../cache/markdown-cache.js';
import {
    createZoteroPDFTextIndexCache,
} from '../cache/pdf-text-index-cache.js';
import {
    createZoteroTranslationCache,
} from '../cache/translation-cache.js';
import { getZoteroLocale } from '../config/mineru-preferences.js';
import { createZoteroClipboard } from '../platform/zotero-clipboard.js';
import {
    getMarkdownReaderFont,
    getMarkdownReaderFontSize,
    setMarkdownReaderFont,
    setMarkdownReaderFontSize,
} from '../config/reader-preferences.js';
import {
    clearTranslationFailureLogs,
    formatTranslationFailureLogs,
    createTranslationServiceID,
    DEFAULT_TRANSLATION_SERVICE_LIMITS,
    DEFAULT_TRANSLATION_SYSTEM_PROMPT,
    getActiveTranslationServiceID,
    getTranslationDeveloperMode,
    getTranslationFailureLogs,
    getTranslationServices,
    getTranslationSystemPrompt,
    getTranslationTargetLanguage,
    normalizeTranslationService,
    setActiveTranslationServiceID,
    setTranslationServices,
    setTranslationSystemPrompt,
    setTranslationTargetLanguage,
    setTranslationDeveloperMode,
} from '../config/translation-preferences.js';
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
    clipboard = null,
    services = typeof Services === 'undefined' ? null : Services,
    localization = createLocalization({
        zoteroLocale: getZoteroLocale(zotero, services),
    }),
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
    const translation = Object.fromEntries(Object.entries({
        targetLanguage: 'mktero-translation-target-language',
        systemPrompt: 'mktero-translation-system-prompt',
        resetPrompt: 'mktero-translation-prompt-reset',
        activeService: 'mktero-translation-active-service',
        serviceList: 'mktero-translation-service-list',
        newService: 'mktero-translation-service-new',
        deleteService: 'mktero-translation-service-delete',
        saveService: 'mktero-translation-service-save',
        serviceStatus: 'mktero-translation-service-status',
        name: 'mktero-translation-service-name',
        apiURL: 'mktero-translation-api-url',
        apiKey: 'mktero-translation-api-key',
        model: 'mktero-translation-model',
        qps: 'mktero-translation-qps',
        maxParagraphs: 'mktero-translation-max-paragraphs',
        maxCharacters: 'mktero-translation-max-characters',
        temperature: 'mktero-translation-temperature',
        developerMode: 'mktero-translation-developer-mode',
        developerControls: 'mktero-translation-developer-controls',
        copyFailureLog: 'mktero-translation-copy-failure-log',
        clearFailureLog: 'mktero-translation-clear-failure-log',
        developerStatus: 'mktero-translation-developer-status',
    }).map(([key, id]) => [key, document.getElementById(id)]));
    const t = (key, variables) => localization.t(key, variables);
    let initialized = false;

    let translationServices = [];
    let editingTranslationServiceID = null;
    const translationListeners = [];
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

    function initializeTranslationSettings() {
        if (!translation.serviceList) return;
        translationServices = getTranslationServices(zotero);
        translation.targetLanguage.value = getTranslationTargetLanguage(zotero);
        translation.systemPrompt.value = getTranslationSystemPrompt(zotero);
        renderTranslationServices();
        if (translation.developerMode) {
            translation.developerMode.checked = getTranslationDeveloperMode(zotero);
            refreshTranslationDeveloperControls();
            listenTranslation(translation.developerMode, 'change', () => {
                setTranslationDeveloperMode(
                    zotero,
                    translation.developerMode.checked
                );
                refreshTranslationDeveloperControls();
            });
            listenTranslation(translation.copyFailureLog, 'click', () => {
                void copyTranslationFailureLog();
            });
            listenTranslation(translation.clearFailureLog, 'click', () => {
                clearTranslationFailureLogs(zotero);
                refreshTranslationDeveloperControls();
                setTranslationDeveloperStatus(
                    'preferences.translation.developerLogCleared'
                );
            });
        }
        listenTranslation(translation.targetLanguage, 'change', () => {
            try {
                translation.targetLanguage.value = setTranslationTargetLanguage(
                    zotero,
                    translation.targetLanguage.value
                );
                setTranslationStatus('preferences.translation.settingsSaved');
            }
            catch (error) {
                showTranslationError(error);
            }
        });
        listenTranslation(translation.systemPrompt, 'change', () => {
            try {
                translation.systemPrompt.value = setTranslationSystemPrompt(
                    zotero,
                    translation.systemPrompt.value
                );
                setTranslationStatus('preferences.translation.settingsSaved');
            }
            catch (error) {
                showTranslationError(error);
            }
        });
        listenTranslation(translation.resetPrompt, 'click', () => {
            translation.systemPrompt.value = setTranslationSystemPrompt(
                zotero,
                DEFAULT_TRANSLATION_SYSTEM_PROMPT
            );
            setTranslationStatus('preferences.translation.promptReset');
        });
        listenTranslation(translation.activeService, 'change', () => {
            try {
                setActiveTranslationServiceID(
                    zotero,
                    translation.activeService.value
                );
                setTranslationStatus('preferences.translation.settingsSaved');
            }
            catch (error) {
                showTranslationError(error);
            }
        });
        listenTranslation(translation.serviceList, 'change', () => {
            loadTranslationService(translation.serviceList.value);
        });
        listenTranslation(translation.newService, 'click', () => {
            editingTranslationServiceID = null;
            translation.serviceList.value = '';
            fillTranslationServiceForm(null);
            setTranslationStatus('');
        });
        listenTranslation(translation.deleteService, 'click', () => {
            deleteSelectedTranslationService();
        });
        listenTranslation(translation.saveService, 'click', () => {
            saveEditedTranslationService();
        });
    }

    function renderTranslationServices(preferredID = null) {
        const activeID = getActiveTranslationServiceID(zotero);
        translation.activeService.replaceChildren(createPreferenceOption(
            '',
            t('preferences.translation.noActiveService')
        ));
        translation.serviceList.replaceChildren();
        for (const service of translationServices) {
            translation.activeService.appendChild(createPreferenceOption(
                service.id,
                service.name
            ));
            translation.serviceList.appendChild(createPreferenceOption(
                service.id,
                service.name
            ));
        }
        translation.activeService.value = translationServices.some(service => (
            service.id === activeID
        )) ? activeID : '';
        const selectedID = [
            preferredID,
            editingTranslationServiceID,
            translationServices[0]?.id,
        ].find(id => translationServices.some(service => service.id === id));
        if (selectedID) {
            translation.serviceList.value = selectedID;
            loadTranslationService(selectedID);
        }
        else {
            editingTranslationServiceID = null;
            fillTranslationServiceForm(null);
        }
        translation.deleteService.disabled = !editingTranslationServiceID;
    }

    function loadTranslationService(serviceID) {
        const service = translationServices.find(candidate => (
            candidate.id === serviceID
        )) || null;
        editingTranslationServiceID = service?.id || null;
        fillTranslationServiceForm(service);
        translation.deleteService.disabled = !service;
        setTranslationStatus('');
    }

    function fillTranslationServiceForm(service) {
        const defaults = DEFAULT_TRANSLATION_SERVICE_LIMITS;
        translation.name.value = service?.name || '';
        translation.apiURL.value = service?.apiURL || '';
        translation.apiKey.value = service?.apiKey || '';
        translation.model.value = service?.model || '';
        translation.qps.value = String(
            service?.maxRequestsPerSecond ?? defaults.maxRequestsPerSecond
        );
        translation.maxParagraphs.value = String(
            service?.maxParagraphsPerRequest
                ?? defaults.maxParagraphsPerRequest
        );
        translation.maxCharacters.value = String(
            service?.maxCharactersPerRequest
                ?? defaults.maxCharactersPerRequest
        );
        translation.temperature.value = String(
            service?.temperature ?? defaults.temperature
        );
    }

    function saveEditedTranslationService() {
        try {
            const id = editingTranslationServiceID
                || createTranslationServiceID();
            const service = normalizeTranslationService({
                id,
                name: translation.name.value,
                apiURL: translation.apiURL.value,
                apiKey: translation.apiKey.value,
                model: translation.model.value,
                maxRequestsPerSecond: translation.qps.value,
                maxParagraphsPerRequest: translation.maxParagraphs.value,
                maxCharactersPerRequest: translation.maxCharacters.value,
                temperature: translation.temperature.value,
            }, { requireID: true });
            const index = translationServices.findIndex(candidate => (
                candidate.id === id
            ));
            if (index >= 0) translationServices[index] = service;
            else translationServices.push(service);
            translationServices = setTranslationServices(
                zotero,
                translationServices
            );
            if (!getActiveTranslationServiceID(zotero)) {
                setActiveTranslationServiceID(zotero, id);
            }
            editingTranslationServiceID = id;
            renderTranslationServices(id);
            setTranslationStatus('preferences.translation.serviceSaved');
        }
        catch (error) {
            showTranslationError(error);
        }
    }

    function deleteSelectedTranslationService() {
        if (!editingTranslationServiceID) return;
        try {
            const deletedID = editingTranslationServiceID;
            translationServices = setTranslationServices(
                zotero,
                translationServices.filter(service => service.id !== deletedID)
            );
            if (getActiveTranslationServiceID(zotero) === deletedID) {
                setActiveTranslationServiceID(
                    zotero,
                    translationServices[0]?.id || ''
                );
            }
            editingTranslationServiceID = null;
            renderTranslationServices();
            setTranslationStatus('preferences.translation.serviceDeleted');
        }
        catch (error) {
            showTranslationError(error);
        }
    }

    function createPreferenceOption(value, label) {
        const option = document.createElementNS(
            'http://www.w3.org/1999/xhtml',
            'option'
        );
        option.value = value;
        option.textContent = label;
        return option;
    }

    function listenTranslation(element, type, listener) {
        element?.addEventListener(type, listener);
        if (element) translationListeners.push({ element, type, listener });
    }

    function refreshTranslationDeveloperControls() {
        if (!translation.developerMode) return;
        const enabled = getTranslationDeveloperMode(zotero);
        const logCount = getTranslationFailureLogs(zotero).length;
        translation.developerMode.checked = enabled;
        if (translation.developerControls) {
            translation.developerControls.hidden = !enabled;
        }
        if (translation.copyFailureLog) {
            translation.copyFailureLog.disabled = !enabled
                || !logCount
                || typeof clipboard?.writeText !== 'function';
        }
        if (translation.clearFailureLog) {
            translation.clearFailureLog.disabled = !enabled || !logCount;
        }
        setTranslationDeveloperStatus(enabled
            ? logCount
                ? 'preferences.translation.developerLogAvailable'
                : 'preferences.translation.developerLogEmpty'
            : '');
    }

    async function copyTranslationFailureLog() {
        if (!getTranslationFailureLogs(zotero).length) {
            setTranslationDeveloperStatus(
                'preferences.translation.developerLogEmpty'
            );
            return;
        }
        try {
            await clipboard?.writeText(formatTranslationFailureLogs(zotero));
            setTranslationDeveloperStatus(
                'preferences.translation.developerLogCopied'
            );
        }
        catch (error) {
            zotero.logError?.(error);
            setTranslationDeveloperStatus(
                'preferences.translation.developerLogCopyFailed',
                'error'
            );
        }
    }

    function setTranslationDeveloperStatus(key, status = 'success') {
        if (!translation.developerStatus) return;
        translation.developerStatus.textContent = key ? t(key) : '';
        if (key) translation.developerStatus.setAttribute('data-status', status);
        else translation.developerStatus.removeAttribute('data-status');
    }

    function setTranslationStatus(key, status = 'success') {
        translation.serviceStatus.textContent = key ? t(key) : '';
        if (key) translation.serviceStatus.setAttribute('data-status', status);
        else translation.serviceStatus.removeAttribute('data-status');
    }

    function showTranslationError(error) {
        zotero.logError?.(error);
        const prefix = t('preferences.translation.invalidService');
        translation.serviceStatus.textContent = `${prefix} ${error.message || ''}`
            .trim();
        translation.serviceStatus.setAttribute('data-status', 'error');
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

    return {
        async init() {
            if (initialized) return;
            initialized = true;
            clearButton.addEventListener('click', clear);
            localize();
            initializeTranslationSettings();
            initializeReaderFont();
            initializeReaderFontSize();
            await refresh();
        },
        destroy() {
            if (!initialized) return;
            initialized = false;
            clearButton.removeEventListener('click', clear);
            readerFontSizeInput?.removeEventListener(
                'input',
                updateReaderFontSize
            );
            readerFontInput?.removeEventListener('change', updateReaderFont);
            for (const { element, type, listener } of translationListeners) {
                element.removeEventListener(type, listener);
            }
            translationListeners.length = 0;
        },
    };
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
        const cache = createCombinedLocalCache([
            createZoteroMarkdownCache({
                zotero: Zotero,
                ioUtils: IOUtils,
                pathUtils: PathUtils,
            }),
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
        ]);
        const controller = createPreferencesController({
            document,
            zotero: Zotero,
            cache,
            clipboard: createZoteroClipboard(Components),
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
