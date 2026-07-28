import { createZoteroMarkdownCache } from '../cache/markdown-cache.js';
import {
    getMkteroLanguagePreference,
    getZoteroLocale,
    setMkteroLanguagePreference,
} from '../config/mineru-preferences.js';
import {
    createLocalization,
    LANGUAGE_SYSTEM,
    translateEnglish,
} from '../i18n/localization.js';

export function registerPreferencesPaneLoader({ document, initialize }) {
    const initializations = new WeakMap();
    const handleLoad = event => {
        const pane = event.target;
        if (pane?.id !== 'mktero-preferences-pane') return;
        let initialization = initializations.get(pane);
        if (!initialization) {
            initialization = Promise.resolve().then(() => initialize(event));
            initializations.set(pane, initialization);
        }
        event.waitUntil?.(initialization);
    };
    document.addEventListener('load', handleLoad, true);
    return () => document.removeEventListener('load', handleLoad, true);
}

export function createPreferencesController({
    document,
    zotero,
    cache,
    services = typeof Services === 'undefined' ? null : Services,
    localization = createLocalization({
        preference: zotero.Prefs?.get
            ? getMkteroLanguagePreference(zotero)
            : LANGUAGE_SYSTEM,
        systemLocale: getZoteroLocale(zotero, services),
    }),
}) {
    const status = document.getElementById('mktero-cache-status');
    const clearButton = document.getElementById('mktero-clear-cache');
    const languageSelect = document.getElementById('mktero-language');
    const t = (key, variables) => localization.t(key, variables);

    function localize() {
        localizePreferencesDocument(document, localization);
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

    async function changeLanguage() {
        const preference = zotero.Prefs?.set
            ? setMkteroLanguagePreference(zotero, languageSelect.value)
            : languageSelect.value;
        localization.setPreference(preference);
        languageSelect.value = localization.preference;
        localize();
        await refresh();
    }

    return {
        async init() {
            clearButton.addEventListener('click', clear);
            if (languageSelect) {
                languageSelect.value = localization.preference;
                languageSelect.addEventListener('change', changeLanguage);
            }
            localize();
            await refresh();
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

globalThis.MkteroPreferences = {
    init(event) {
        const document = event.target?.ownerDocument
            || event.currentTarget?.ownerDocument
            || globalThis.document;
        const cache = createZoteroMarkdownCache({
            zotero: Zotero,
            ioUtils: IOUtils,
            pathUtils: PathUtils,
        });
        const controller = createPreferencesController({ document, zotero: Zotero, cache });
        return controller.init();
    },
};

if (globalThis.document?.addEventListener) {
    registerPreferencesPaneLoader({
        document: globalThis.document,
        initialize: event => globalThis.MkteroPreferences.init(event),
    });
}
