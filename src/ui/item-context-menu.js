import { translateEnglish } from '../i18n/localization.js';
import { isSavedMarkdownNote as isMarkedSavedMarkdownNote } from '../core/saved-markdown-note-format.js';
import { resolvePDFCandidates } from './pdf-item-targets.js';
import { registerLLMCacheImportMenu } from './llm-cache-import-controller.js';

const ITEM_MENU_ID = 'zotero-itemmenu';
const COLLECTION_MENU_ID = 'zotero-collectionmenu';
const MENU_ITEM_ID = 'mktero-read-as-markdown';
const EXPORT_MENU_ITEM_ID = 'mktero-export-obsidian';
const COLLECTION_MENU_ITEM_ID = 'mktero-prepare-collection-markdown';
const COLLECTION_EXPORT_MENU_ITEM_ID = 'mktero-export-collection-obsidian';
const LEGACY_GRAPH_MENU_ITEM_ID = 'mktero-open-citation-graph';

// The export entry is a submenu, so the item menu offers the same four output
// actions as the reader's Save and export menu, in the same order. A snapshot
// needs a parent library item, so it is the only action that can be missing.
const EXPORT_ACTIONS = Object.freeze([
    Object.freeze({
        action: 'snapshot',
        labelKey: 'menu.exportSnapshot',
        needsParent: true,
    }),
    Object.freeze({
        action: 'markdown',
        labelKey: 'menu.exportMarkdown',
        needsParent: false,
    }),
    Object.freeze({
        action: 'obsidian',
        labelKey: 'menu.exportObsidianAction',
        needsParent: false,
    }),
    Object.freeze({
        action: 'epub',
        labelKey: 'menu.exportEpub',
        needsParent: false,
    }),
]);

export function registerItemContextMenu({
    zotero,
    window,
    rootURI,
    onOpen,
    onPrepare = null,
    onExport = null,
    onOpenSavedNote = null,
    probeLLMCache = null,
    onImportLLMCache = null,
    isSavedMarkdownNote = defaultIsSavedMarkdownNote,
    isPreparing = () => false,
    hasMarkdown = () => false,
    onError,
    translate = translateEnglish,
}) {
    const document = window?.document;
    const menu = document?.getElementById?.(ITEM_MENU_ID);
    if (!menu) return null;

    document.getElementById(MENU_ITEM_ID)?.remove();
    document.getElementById(EXPORT_MENU_ITEM_ID)?.remove();
    // Remove the item injected by older builds that exposed the graph here.
    document.getElementById(LEGACY_GRAPH_MENU_ITEM_ID)?.remove();

    const menuItem = document.createXULElement?.('menuitem')
        || document.createElement('menuitem');
    menuItem.id = MENU_ITEM_ID;
    menuItem.hidden = true;
    menuItem.setAttribute('label', translate('menu.readAsMarkdown'));
    const exportSubmenu = createExportSubmenu({
        document,
        id: EXPORT_MENU_ITEM_ID,
        labelKey: 'menu.exportSelected',
        idPrefix: 'mktero-export',
        onExport: typeof onExport === 'function'
            ? (action, targets) => onExport(action, exportTargets(targets))
            : null,
        translate,
        targets: () => exportPDFTargets(zotero, window, onExport, hasMarkdown),
        onError,
    });

    const handlePopupShowing = event => {
        if (event.target !== menu) return;
        const selected = resolveMenuAction({
            zotero,
            window,
            isSavedMarkdownNote,
            isPreparing,
            onPrepare,
            onOpenSavedNote,
        });
        menuItem.hidden = !selected;
        menuItem.setAttribute('label', translate(selected?.labelKey
            || 'menu.readAsMarkdown'));
    };
    const handleCommand = () => {
        const selected = resolveMenuAction({
            zotero,
            window,
            isSavedMarkdownNote,
            isPreparing,
            onPrepare,
            onOpenSavedNote,
        });
        if (!selected) return;
        Promise.resolve()
            .then(() => {
                if (selected.kind === 'prepare') return onPrepare(selected.targets);
                if (selected.kind === 'saved-markdown-note') {
                    return onOpenSavedNote?.(selected.item.id);
                }
                return onOpen(selected.item.id);
            })
            .catch(onError);
    };
    const handleExportPopupShowing = event => {
        if (event.target !== menu) return;
        exportSubmenu.sync();
    };
    menu.addEventListener('popupshowing', handlePopupShowing);
    menu.addEventListener('popupshowing', handleExportPopupShowing);
    menuItem.addEventListener('command', handleCommand);
    menu.append(menuItem, exportSubmenu.element);
    const disposeImportMenu = registerLLMCacheImportMenu({
        zotero,
        window,
        probeCandidate: probeLLMCache,
        onImport: onImportLLMCache,
        isPreparing,
        onError,
        translate,
    });

    let active = true;
    return () => {
        if (!active) return;
        active = false;
        disposeImportMenu?.();
        menu.removeEventListener('popupshowing', handlePopupShowing);
        menu.removeEventListener('popupshowing', handleExportPopupShowing);
        menuItem.removeEventListener('command', handleCommand);
        exportSubmenu.dispose();
        menuItem.remove();
        exportSubmenu.element.remove();
    };
}

// Builds a `menu` holding one `menuitem` per export action. The submenu owns
// its own popup, so a caller only appends `element` and calls `sync()` when the
// parent menu opens. Unavailable actions are removed from the popup rather than
// left hidden, because a native XUL submenu sizes itself from its children.
function createExportSubmenu({
    document,
    id,
    labelKey,
    idPrefix,
    onExport,
    translate,
    targets,
    onError,
}) {
    const element = document.createXULElement?.('menu') || document.createElement('menu');
    element.id = id;
    element.hidden = true;
    element.setAttribute('label', translate(labelKey));
    const popup = document.createXULElement?.('menupopup')
        || document.createElement('menupopup');
    popup.id = `${id}-popup`;
    element.append(popup);

    const entries = EXPORT_ACTIONS.map(({ action, labelKey: actionLabelKey }) => {
        const item = document.createXULElement?.('menuitem')
            || document.createElement('menuitem');
        item.id = `${idPrefix}-${action}`;
        item.setAttribute('label', translate(actionLabelKey));
        const handleCommand = () => {
            if (typeof onExport !== 'function') return;
            const current = targets();
            if (!current?.length) return;
            // Callers receive the resolved targets, not the stripped menu
            // shape: the collection flow still needs the ready count, so it
            // passes its own adapter and gets the full records.
            Promise.resolve()
                .then(() => onExport(action, current))
                .catch(onError);
        };
        item.addEventListener('command', handleCommand);
        return { action, item, handleCommand, labelKey: actionLabelKey };
    });

    const sync = () => {
        const current = targets();
        element.hidden = !current?.length;
        element.setAttribute('label', translate(labelKey));
        const available = new Set(current?.length
            ? EXPORT_ACTIONS
                .filter(({ needsParent }) => !needsParent
                    || current.some(target => target.hasParent))
                .map(({ action }) => action)
            : []);
        popup.replaceChildren();
        for (const entry of entries) {
            entry.item.setAttribute('label', translate(entry.labelKey));
            entry.item.hidden = !available.has(entry.action);
            if (entry.item.hidden) continue;
            popup.append(entry.item);
        }
    };

    return {
        element,
        popup,
        sync,
        dispose() {
            for (const entry of entries) {
                entry.item.removeEventListener('command', entry.handleCommand);
            }
        },
    };
}

function exportPDFTargets(zotero, window, onExport, hasMarkdown) {
    if (typeof onExport !== 'function') return null;
    const selectedItems = window?.ZoteroPane?.getSelectedItems?.();
    if (!Array.isArray(selectedItems) || !selectedItems.length) return null;
    const targets = resolvePDFCandidates(zotero, selectedItems);
    if (!targets.length || !targets.some(target => (
        safeHasMarkdown(hasMarkdown, target.item)
    ))) {
        return null;
    }
    return targets.map(target => ({
        ...target,
        hasParent: Boolean(target.item?.parentItemID || target.item?.parentID),
    }));
}

function resolveMenuAction({
    zotero,
    window,
    isSavedMarkdownNote,
    isPreparing,
    onPrepare,
    onOpenSavedNote,
}) {
    const selectedItems = window?.ZoteroPane?.getSelectedItems?.();
    if (!Array.isArray(selectedItems) || !selectedItems.length) return null;
    if (selectedItems.length === 1) {
        const selected = resolveSelectedItem(
            zotero,
            selectedItems[0],
            isSavedMarkdownNote
        );
        if (!selected) return null;
        if (selected.kind === 'saved-markdown-note'
            && typeof onOpenSavedNote !== 'function') {
            return null;
        }
        return {
            ...selected,
            labelKey: selected.kind === 'saved-markdown-note'
                ? 'menu.openSavedMarkdown'
                : safePreparing(isPreparing, selected.item.id)
                    ? 'menu.openPreparingMarkdown'
                    : 'menu.readAsMarkdown',
        };
    }
    if (typeof onPrepare !== 'function') return null;
    const targets = resolvePDFTargets(zotero, selectedItems);
    if (!targets.length) return null;
    return {
        kind: 'prepare',
        labelKey: 'menu.prepareMarkdown',
        targets,
    };
}

function resolvePDFTargets(zotero, items) {
    return resolvePDFCandidates(zotero, items).map(target => ({
        itemID: target.itemID,
        title: target.title,
    }));
}

function safePreparing(isPreparing, itemID) {
    try {
        return Boolean(isPreparing?.(itemID));
    }
    catch {
        return false;
    }
}

function resolveSelectedItem(zotero, item, isSavedMarkdownNote) {
    if (isSavedMarkdownNote(item)) {
        return { kind: 'saved-markdown-note', item };
    }
    const attachment = resolvePDFCandidates(zotero, [item])[0]?.item;
    return attachment ? { kind: 'pdf', item: attachment } : null;
}

export function registerCollectionContextMenu({
    zotero,
    window,
    onPrepare = null,
    onExport = null,
    confirm = async () => false,
    hasMarkdown = () => false,
    onError,
    translate = translateEnglish,
} = {}) {
    const document = window?.document;
    const menu = document?.getElementById?.(COLLECTION_MENU_ID);
    if (!menu || typeof onPrepare !== 'function') return null;

    document.getElementById(COLLECTION_MENU_ITEM_ID)?.remove();
    document.getElementById(COLLECTION_EXPORT_MENU_ITEM_ID)?.remove();
    const menuItem = document.createXULElement?.('menuitem')
        || document.createElement('menuitem');
    menuItem.id = COLLECTION_MENU_ITEM_ID;
    menuItem.hidden = true;
    menuItem.setAttribute('label', translate('menu.prepareCollectionMarkdown'));
    const exportSubmenu = createExportSubmenu({
        document,
        id: COLLECTION_EXPORT_MENU_ITEM_ID,
        labelKey: 'menu.exportCollection',
        idPrefix: 'mktero-export-collection',
        onExport: typeof onExport === 'function'
            ? (action, targets) => runCollectionExport({
                action,
                targets,
                onExport,
                confirm,
                onError,
            })
            : null,
        translate,
        targets: () => collectionExportTargets(
            zotero,
            window,
            onExport,
            hasMarkdown
        ),
        onError,
    });

    const handlePopupShowing = event => {
        if (event.target !== menu) return;
        const targets = collectionPDFTargets(zotero, window);
        menuItem.hidden = !targets.length;
        menuItem.setAttribute(
            'label',
            translate('menu.prepareCollectionMarkdown')
        );
    };
    const handleCommand = () => {
        const targets = collectionPDFTargets(zotero, window);
        if (!targets.length) return;
        Promise.resolve()
            .then(() => confirm('prepare', { count: targets.length }))
            .then(confirmed => confirmed ? onPrepare(targets) : undefined)
            .catch(onError);
    };
    const handleExportPopupShowing = event => {
        if (event.target !== menu) return;
        exportSubmenu.sync();
    };
    menu.addEventListener('popupshowing', handlePopupShowing);
    menu.addEventListener('popupshowing', handleExportPopupShowing);
    menuItem.addEventListener('command', handleCommand);
    menu.append(menuItem, exportSubmenu.element);

    let active = true;
    return () => {
        if (!active) return;
        active = false;
        menu.removeEventListener('popupshowing', handlePopupShowing);
        menu.removeEventListener('popupshowing', handleExportPopupShowing);
        menuItem.removeEventListener('command', handleCommand);
        exportSubmenu.dispose();
        menuItem.remove();
        exportSubmenu.element.remove();
    };
}

// A collection tree can hold hundreds of PDFs, so the batch asks once, with the
// total and the ready count, before it starts writing files.
async function runCollectionExport({
    action,
    targets,
    onExport,
    confirm,
    onError,
}) {
    try {
        const confirmed = await confirm('export', {
            count: targets.length,
            readyCount: targets.filter(target => target.hasMarkdown).length,
            action,
        });
        if (!confirmed) return;
        await onExport(action, exportTargets(targets));
    }
    catch (error) {
        onError?.(error);
    }
}

function exportTargets(targets) {
    return targets.map(target => ({
        itemID: target.itemID,
        title: target.title,
    }));
}

function collectionExportTargets(
    zotero,
    window,
    onExport,
    hasMarkdown
) {
    if (typeof onExport !== 'function') return null;
    const targets = collectionPDFRecords(zotero, window);
    if (!targets.some(target => safeHasMarkdown(hasMarkdown, target.item))) {
        return null;
    }
    return targets.map(target => ({
        ...target,
        hasParent: Boolean(target.item?.parentItemID || target.item?.parentID),
        hasMarkdown: safeHasMarkdown(hasMarkdown, target.item),
    }));
}

function safeHasMarkdown(hasMarkdown, item) {
    try {
        return hasMarkdown?.(item) === true;
    }
    catch {
        return false;
    }
}

function collectionPDFTargets(zotero, window) {
    return resolvePDFTargets(zotero, collectionChildItems(zotero, window));
}

function collectionPDFRecords(zotero, window) {
    return resolvePDFCandidates(zotero, collectionChildItems(zotero, window));
}

function collectionChildItems(zotero, window) {
    const selected = window?.ZoteroPane?.getSelectedCollections?.();
    if (!Array.isArray(selected) || !selected.length) return [];
    const pending = [...selected];
    const visited = new Set();
    const items = [];
    for (let index = 0; index < pending.length; index++) {
        const collection = resolveCollection(zotero, pending[index]);
        if (!collection) continue;
        const identity = collection.id != null
            ? `id:${collection.id}`
            : collection.libraryID != null && collection.key
                ? `key:${collection.libraryID}:${collection.key}`
                : collection;
        if (visited.has(identity)) continue;
        visited.add(identity);
        items.push(...childItems(collection));
        pending.push(...childCollections(collection));
    }
    return items;
}

function resolveCollection(zotero, value) {
    if (value && typeof value === 'object') return value;
    try {
        return zotero?.Collections?.get?.(value) || null;
    }
    catch {
        return null;
    }
}

function childCollections(collection) {
    if (typeof collection?.getChildCollections !== 'function') return [];
    try {
        const children = collection.getChildCollections();
        return Array.isArray(children) ? children : [];
    }
    catch {
        return [];
    }
}

function childItems(collection) {
    if (typeof collection?.getChildItems !== 'function') return [];
    try {
        const items = collection.getChildItems();
        return Array.isArray(items) ? items.filter(item => !item?.deleted) : [];
    }
    catch {
        return [];
    }
}

function defaultIsSavedMarkdownNote(item) {
    return Boolean(item?.isNote?.()
        && isMarkedSavedMarkdownNote(item.getNote?.() || ''));
}
