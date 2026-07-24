import { createZoteroMarkdownCache } from '../cache/markdown-cache.js';

export function createPreferencesController({ document, zotero, cache }) {
    const status = document.getElementById('mktero-cache-status');
    const clearButton = document.getElementById('mktero-clear-cache');

    async function refresh() {
        try {
            status.textContent = formatCacheStats(await cache.getStats());
        }
        catch (error) {
            zotero.logError?.(error);
            status.textContent = 'Cache information unavailable';
        }
    }

    async function clear() {
        clearButton.disabled = true;
        status.textContent = 'Clearing cache...';
        try {
            await cache.clear();
            await refresh();
        }
        catch (error) {
            zotero.logError?.(error);
            status.textContent = 'Cache could not be cleared';
        }
        finally {
            clearButton.disabled = false;
        }
    }

    return {
        async init() {
            clearButton.addEventListener('click', clear);
            await refresh();
        },
    };
}

export function formatCacheStats({ entries, sizeBytes }) {
    if (!entries) return 'No cached documents';
    const documentLabel = entries === 1 ? 'document' : 'documents';
    return `${entries} cached ${documentLabel}, ${formatBytes(sizeBytes)}`;
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
        const document = event.currentTarget?.ownerDocument || globalThis.document;
        const cache = createZoteroMarkdownCache({
            zotero: Zotero,
            ioUtils: IOUtils,
            pathUtils: PathUtils,
        });
        const controller = createPreferencesController({ document, zotero: Zotero, cache });
        const initialization = controller.init();
        event.waitUntil?.(initialization);
        return initialization;
    },
};
