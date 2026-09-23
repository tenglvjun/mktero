import { createLucideIcon, LUCIDE_ICONS } from '../icons/lucide-icon.js';

const DATA_KEY = 'markdownReady';
const COLUMN_WIDTH = '32';

export function registerMarkdownReadinessColumn({
    zotero,
    pluginID,
    rootURI = '',
    isReady,
    translate,
    onError = null,
} = {}) {
    const manager = zotero?.ItemTreeManager;
    if (!pluginID || typeof isReady !== 'function' || !manager) {
        return {
            registeredKey: null,
            refresh() {},
            dispose() {},
        };
    }

    const options = columnOptions({
        pluginID,
        rootURI,
        isReady,
        translate,
        onError,
    });
    let registeredKey = null;
    try {
        if (typeof manager.registerColumn === 'function') {
            registeredKey = registeredColumnKey(manager.registerColumn(options));
        }
        else if (typeof manager.registerColumns === 'function') {
            registeredKey = registeredColumnKey(manager.registerColumns(options));
        }
    }
    catch (error) {
        report(onError, error);
        registeredKey = null;
    }

    return {
        registeredKey,
        refresh() {
            refreshMarkdownReadinessColumn(zotero);
        },
        dispose() {
            if (!registeredKey) return;
            try {
                if (typeof manager.unregisterColumn === 'function') {
                    manager.unregisterColumn(registeredKey);
                }
                else {
                    manager.unregisterColumns?.(registeredKey);
                }
            }
            catch (error) {
                report(onError, error);
            }
            registeredKey = null;
        },
    };
}

export function refreshMarkdownReadinessColumn(zotero) {
    try {
        zotero?.ItemTreeManager?.refresh?.();
    }
    catch {
        // Repainting the item list must not affect reading.
    }
    for (const win of mainWindows(zotero)) {
        try {
            const view = win?.ZoteroPane?.itemsView;
            if (!view) continue;
            if (view._rowCache && typeof view._rowCache === 'object') {
                view._rowCache = {};
            }
            view.tree?.invalidate?.();
        }
        catch {
            // A single window's item tree can be mid-teardown.
        }
    }
}

export function markdownReadinessColumnOptions({
    pluginID,
    rootURI = '',
    isReady,
    translate = key => key,
} = {}) {
    return columnOptions({
        pluginID,
        rootURI,
        isReady,
        translate,
        onError: null,
    });
}

function columnOptions({
    pluginID,
    rootURI,
    isReady,
    translate,
    onError,
}) {
    const label = safeTranslate(translate, 'column.markdownReady');
    const tooltip = safeTranslate(translate, 'column.markdownReadyTooltip');
    const iconPath = columnIconPath(rootURI);
    return {
        dataKey: DATA_KEY,
        label,
        pluginID,
        enabledTreeIDs: ['main'],
        // Zotero still uses defaultIn to decide the initial hidden state.
        // Without it, a custom column stays hidden whenever any built-in
        // column declares defaultIn. A persisted hidden preference still wins.
        defaultIn: ['default'],
        flex: 0,
        width: COLUMN_WIDTH,
        fixedWidth: true,
        staticWidth: true,
        minWidth: 24,
        noPadding: true,
        showInColumnPicker: true,
        columnPickerSubMenu: false,
        ...(iconPath ? { iconPath } : {}),
        zoteroPersist: ['hidden', 'width', 'sortDirection'],
        dataProvider(item) {
            try {
                return isReady(item) ? '1' : '';
            }
            catch (error) {
                report(onError, error);
                return '';
            }
        },
        renderCell(_index, data, column, _isFirstColumn, doc) {
            if (data !== '1' || !doc) return null;
            try {
                return renderReadyCell(doc, column, tooltip);
            }
            catch (error) {
                report(onError, error);
                return null;
            }
        },
    };
}

function renderReadyCell(doc, column, tooltip) {
    const cell = doc.createElement('span');
    cell.className = `cell ${column?.className || ''} mktero-markdown-ready`.trim();
    cell.title = tooltip;
    cell.setAttribute?.('role', 'img');
    cell.setAttribute?.('aria-label', tooltip);
    if (typeof doc.createElementNS === 'function') {
        cell.appendChild(createLucideIcon(doc, LUCIDE_ICONS.fileText, {
            className: 'mktero-markdown-ready-icon',
            size: 14,
        }));
    }
    else {
        cell.textContent = 'M';
    }
    return cell;
}

function columnIconPath(rootURI) {
    if (typeof rootURI !== 'string' || !rootURI) return null;
    return `${rootURI}${rootURI.endsWith('/') ? '' : '/'}ui/icons/mktero.svg`;
}

function registeredColumnKey(result) {
    if (typeof result === 'string' && result) return result;
    if (Array.isArray(result)) {
        return result.find(value => typeof value === 'string' && value) || null;
    }
    return null;
}

function safeTranslate(translate, key) {
    try {
        const value = translate?.(key);
        return typeof value === 'string' && value ? value : key;
    }
    catch {
        return key;
    }
}

function mainWindows(zotero) {
    if (typeof zotero?.getMainWindows === 'function') {
        const windows = zotero.getMainWindows();
        if (Array.isArray(windows) && windows.length) return windows;
    }
    const win = zotero?.getMainWindow?.();
    return win ? [win] : [];
}

function report(onError, error) {
    try {
        onError?.(error);
    }
    catch {
        // Column registration must not affect conversion or reading.
    }
}
