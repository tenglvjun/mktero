import { createZoteroMarkdownCache } from '../cache/markdown-cache.js';
import { getZoteroLocale } from '../config/mineru-preferences.js';
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
}) {
    const status = document.getElementById('mktero-cache-status');
    const clearButton = document.getElementById('mktero-clear-cache');
    const t = (key, variables) => localization.t(key, variables);
    let initialized = false;

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

    return {
        async init() {
            if (initialized) return;
            initialized = true;
            clearButton.addEventListener('click', clear);
            localize();
            await refresh();
        },
        destroy() {
            if (!initialized) return;
            initialized = false;
            clearButton.removeEventListener('click', clear);
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
    async init(event) {
        const document = event.target?.ownerDocument
            || event.currentTarget?.ownerDocument
            || globalThis.document;
        const cache = createZoteroMarkdownCache({
            zotero: Zotero,
            ioUtils: IOUtils,
            pathUtils: PathUtils,
        });
        const controller = createPreferencesController({ document, zotero: Zotero, cache });
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
