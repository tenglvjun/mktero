import { translateEnglish } from '../i18n/localization.js';
import { isSavedMarkdownNote as isMarkedSavedMarkdownNote } from '../core/saved-markdown-note-format.js';

const ITEM_MENU_ID = 'zotero-itemmenu';
const COLLECTION_MENU_ID = 'zotero-collectionmenu';
const MENU_ITEM_ID = 'mktero-read-as-markdown';
const EXPORT_MENU_ITEM_ID = 'mktero-export-obsidian';
const COLLECTION_MENU_ITEM_ID = 'mktero-prepare-collection-markdown';
const COLLECTION_EXPORT_MENU_ITEM_ID = 'mktero-export-collection-obsidian';
const LEGACY_GRAPH_MENU_ITEM_ID = 'mktero-open-citation-graph';

export function registerItemContextMenu({
    zotero,
    window,
    rootURI,
    onOpen,
    onPrepare = null,
    onExportObsidian = null,
    onOpenSavedNote = null,
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
    const exportItem = document.createXULElement?.('menuitem')
        || document.createElement('menuitem');
    exportItem.id = EXPORT_MENU_ITEM_ID;
    exportItem.hidden = true;
    exportItem.setAttribute('label', translate('menu.exportObsidian'));

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
        const targets = exportPDFTargets(
            zotero,
            window,
            onExportObsidian,
            hasMarkdown
        );
        exportItem.hidden = !targets;
        exportItem.setAttribute('label', translate('menu.exportObsidian'));
    };
    const handleExportCommand = () => {
        const targets = exportPDFTargets(
            zotero,
            window,
            onExportObsidian,
            hasMarkdown
        );
        if (!targets) return;
        Promise.resolve()
            .then(() => onExportObsidian(exportTargets(targets)))
            .catch(onError);
    };
    menu.addEventListener('popupshowing', handlePopupShowing);
    menu.addEventListener('popupshowing', handleExportPopupShowing);
    menuItem.addEventListener('command', handleCommand);
    exportItem.addEventListener('command', handleExportCommand);
    menu.append(menuItem, exportItem);

    let active = true;
    return () => {
        if (!active) return;
        active = false;
        menu.removeEventListener('popupshowing', handlePopupShowing);
        menu.removeEventListener('popupshowing', handleExportPopupShowing);
        menuItem.removeEventListener('command', handleCommand);
        exportItem.removeEventListener('command', handleExportCommand);
        menuItem.remove();
        exportItem.remove();
    };
}

function exportPDFTargets(zotero, window, onExportObsidian, hasMarkdown) {
    if (typeof onExportObsidian !== 'function') return null;
    const selectedItems = window?.ZoteroPane?.getSelectedItems?.();
    if (!Array.isArray(selectedItems) || !selectedItems.length) return null;
    const targets = resolvePDFRecords(zotero, selectedItems);
    if (!targets.length || !targets.some(target => (
        safeHasMarkdown(hasMarkdown, target.item)
    ))) {
        return null;
    }
    return targets;
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
    return resolvePDFRecords(zotero, items).map(target => ({
        itemID: target.itemID,
        title: target.title,
    }));
}

function resolvePDFRecords(zotero, items) {
    const targets = [];
    const seen = new Set();
    for (const item of items) {
        const pdfs = item?.isPDFAttachment?.()
            ? [item]
            : item?.isRegularItem?.()
                ? pdfAttachments(zotero, item)
                : [];
        for (const pdf of pdfs) {
            if (!Number.isSafeInteger(pdf?.id) || pdf.id <= 0 || seen.has(pdf.id)) {
                continue;
            }
            seen.add(pdf.id);
            targets.push({
                itemID: pdf.id,
                title: targetTitle(pdf, zotero),
                item: pdf,
            });
        }
    }
    return targets;
}

function pdfAttachments(zotero, item) {
    const attachments = [];
    for (const attachmentID of item.getAttachments?.() || []) {
        const attachment = zotero?.Items?.get?.(attachmentID);
        if (attachment?.isPDFAttachment?.()) attachments.push(attachment);
    }
    return attachments;
}

function targetTitle(item, zotero) {
    const parentID = item.parentItemID || item.parentID;
    const parent = item.parentItem
        || (parentID ? zotero?.Items?.get?.(parentID) : null);
    return cleanTitle(parent?.getDisplayTitle?.() || item.getDisplayTitle?.());
}

function cleanTitle(value) {
    const text = String(value || '')
        .replace(/[\u0000-\u001F\u007F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!text) return 'PDF';
    return text.length > 300 ? `${text.slice(0, 299)}…` : text;
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
    if (item?.isPDFAttachment?.()) return { kind: 'pdf', item };
    if (!item?.isRegularItem?.()) return null;
    const attachment = pdfAttachments(zotero, item)[0];
    return attachment ? { kind: 'pdf', item: attachment } : null;
}

export function registerCollectionContextMenu({
    zotero,
    window,
    onPrepare = null,
    onExportObsidian = null,
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
    const exportItem = document.createXULElement?.('menuitem')
        || document.createElement('menuitem');
    exportItem.id = COLLECTION_EXPORT_MENU_ITEM_ID;
    exportItem.hidden = true;
    exportItem.setAttribute('label', translate('menu.exportCollectionObsidian'));

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
            .then(() => onPrepare(targets))
            .catch(onError);
    };
    const handleExportPopupShowing = event => {
        if (event.target !== menu) return;
        const targets = collectionExportTargets(
            zotero,
            window,
            onExportObsidian,
            hasMarkdown
        );
        exportItem.hidden = !targets.length;
        exportItem.setAttribute(
            'label',
            translate('menu.exportCollectionObsidian')
        );
    };
    const handleExportCommand = () => {
        const targets = collectionExportTargets(
            zotero,
            window,
            onExportObsidian,
            hasMarkdown
        );
        if (!targets.length) return;
        Promise.resolve()
            .then(() => onExportObsidian(exportTargets(targets)))
            .catch(onError);
    };
    menu.addEventListener('popupshowing', handlePopupShowing);
    menu.addEventListener('popupshowing', handleExportPopupShowing);
    menuItem.addEventListener('command', handleCommand);
    exportItem.addEventListener('command', handleExportCommand);
    menu.append(menuItem, exportItem);

    let active = true;
    return () => {
        if (!active) return;
        active = false;
        menu.removeEventListener('popupshowing', handlePopupShowing);
        menu.removeEventListener('popupshowing', handleExportPopupShowing);
        menuItem.removeEventListener('command', handleCommand);
        exportItem.removeEventListener('command', handleExportCommand);
        menuItem.remove();
        exportItem.remove();
    };
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
    onExportObsidian,
    hasMarkdown
) {
    if (typeof onExportObsidian !== 'function') return [];
    const targets = collectionPDFRecords(zotero, window);
    if (!targets.some(target => safeHasMarkdown(hasMarkdown, target.item))) {
        return [];
    }
    return targets;
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
    return resolvePDFTargets(zotero, collectionChildItems(window));
}

function collectionPDFRecords(zotero, window) {
    return resolvePDFRecords(zotero, collectionChildItems(window));
}

function collectionChildItems(window) {
    const collections = window?.ZoteroPane?.getSelectedCollections?.();
    if (!Array.isArray(collections) || !collections.length) return [];
    const items = [];
    for (const collection of collections) {
        items.push(...childItems(collection));
    }
    return items;
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
