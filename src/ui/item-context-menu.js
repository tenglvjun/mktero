import { translateEnglish } from '../i18n/localization.js';
import { isSavedMarkdownNote as isMarkedSavedMarkdownNote } from '../core/saved-markdown-note-format.js';

const ITEM_MENU_ID = 'zotero-itemmenu';
const COLLECTION_MENU_ID = 'zotero-collectionmenu';
const MENU_ITEM_ID = 'mktero-read-as-markdown';
const COLLECTION_MENU_ITEM_ID = 'mktero-prepare-collection-markdown';
const LEGACY_GRAPH_MENU_ITEM_ID = 'mktero-open-citation-graph';

export function registerItemContextMenu({
    zotero,
    window,
    rootURI,
    onOpen,
    onPrepare = null,
    onOpenSavedNote = null,
    isSavedMarkdownNote = defaultIsSavedMarkdownNote,
    isPreparing = () => false,
    onError,
    translate = translateEnglish,
}) {
    const document = window?.document;
    const menu = document?.getElementById?.(ITEM_MENU_ID);
    if (!menu) return null;

    document.getElementById(MENU_ITEM_ID)?.remove();
    // Remove the item injected by older builds that exposed the graph here.
    document.getElementById(LEGACY_GRAPH_MENU_ITEM_ID)?.remove();

    const menuItem = document.createXULElement?.('menuitem')
        || document.createElement('menuitem');
    menuItem.id = MENU_ITEM_ID;
    menuItem.hidden = true;
    menuItem.setAttribute('label', translate('menu.readAsMarkdown'));

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
    menu.addEventListener('popupshowing', handlePopupShowing);
    menuItem.addEventListener('command', handleCommand);
    menu.append(menuItem);

    let active = true;
    return () => {
        if (!active) return;
        active = false;
        menu.removeEventListener('popupshowing', handlePopupShowing);
        menuItem.removeEventListener('command', handleCommand);
        menuItem.remove();
    };
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
    onError,
    translate = translateEnglish,
} = {}) {
    const document = window?.document;
    const menu = document?.getElementById?.(COLLECTION_MENU_ID);
    if (!menu || typeof onPrepare !== 'function') return null;

    document.getElementById(COLLECTION_MENU_ITEM_ID)?.remove();
    const menuItem = document.createXULElement?.('menuitem')
        || document.createElement('menuitem');
    menuItem.id = COLLECTION_MENU_ITEM_ID;
    menuItem.hidden = true;
    menuItem.setAttribute('label', translate('menu.prepareCollectionMarkdown'));

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
    menu.addEventListener('popupshowing', handlePopupShowing);
    menuItem.addEventListener('command', handleCommand);
    menu.append(menuItem);

    let active = true;
    return () => {
        if (!active) return;
        active = false;
        menu.removeEventListener('popupshowing', handlePopupShowing);
        menuItem.removeEventListener('command', handleCommand);
        menuItem.remove();
    };
}

function collectionPDFTargets(zotero, window) {
    const collections = window?.ZoteroPane?.getSelectedCollections?.();
    if (!Array.isArray(collections) || !collections.length) return [];
    const items = [];
    for (const collection of collections) {
        items.push(...childItems(collection));
    }
    return resolvePDFTargets(zotero, items);
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
