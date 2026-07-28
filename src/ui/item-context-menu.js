import { translateEnglish } from '../i18n/localization.js';

const ITEM_MENU_ID = 'zotero-itemmenu';
const MENU_ITEM_ID = 'mktero-read-as-markdown';

export function registerItemContextMenu({
    zotero,
    window,
    rootURI,
    onOpen,
    onError,
    translate = translateEnglish,
}) {
    const document = window?.document;
    const menu = document?.getElementById?.(ITEM_MENU_ID);
    if (!menu) return null;

    document.getElementById(MENU_ITEM_ID)?.remove();

    const menuItem = document.createXULElement?.('menuitem')
        || document.createElement('menuitem');
    menuItem.id = MENU_ITEM_ID;
    menuItem.hidden = true;
    menuItem.setAttribute('label', translate('menu.readAsMarkdown'));
    menuItem.setAttribute('class', 'menuitem-iconic');
    menuItem.setAttribute('image', `${rootURI}ui/icons/mktero.svg`);

    const handlePopupShowing = event => {
        if (event.target !== menu) return;
        menuItem.hidden = !resolveSelectedPDF(zotero, window);
    };
    const handleCommand = () => {
        const item = resolveSelectedPDF(zotero, window);
        if (!item) return;
        Promise.resolve()
            .then(() => onOpen(item.id))
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

function resolveSelectedPDF(zotero, window) {
    const selectedItems = window?.ZoteroPane?.getSelectedItems?.();
    if (!Array.isArray(selectedItems) || selectedItems.length !== 1) return null;

    const item = selectedItems[0];
    if (item?.isPDFAttachment?.()) return item;
    if (!item?.isRegularItem?.()) return null;

    for (const attachmentID of item.getAttachments?.() || []) {
        const attachment = zotero?.Items?.get?.(attachmentID);
        if (attachment?.isPDFAttachment?.()) return attachment;
    }
    return null;
}
