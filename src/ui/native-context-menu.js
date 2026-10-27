const MENU_CLASS = 'mktero-context-menu';

// A native Zotero context menu (XUL menupopup), so a menu in the Markdown
// reader looks and behaves like the menus Zotero itself shows: platform
// styling, keyboard navigation, and dismissal.
//
// The popup is attached to the chrome document's popupset, not to the
// reader's shadow tree: a menupopup only opens from a node the chrome
// document lays out. Without XUL (the browser preview, a DOM test) there is
// no menu, and `createNativeContextMenu` returns null.
//
// `open({ items, screenX, screenY, anchor })`: each item is
// `{ label, command, disabled }` or `{ separator: true }`. A pointer opens
// the menu at the pointer; a keyboard request (no screen position) opens it
// below `anchor`.
export function createNativeContextMenu(document) {
    if (typeof document?.createXULElement !== 'function') return null;
    let popup = null;

    const ensurePopup = () => {
        if (popup?.isConnected) return popup;
        popup = document.createXULElement('menupopup');
        popup.classList.add(MENU_CLASS);
        const parent = document.querySelector?.('popupset')
            || document.documentElement;
        parent.appendChild(popup);
        return popup;
    };

    return {
        open({ items = [], screenX = 0, screenY = 0, anchor = null } = {}) {
            const menu = ensurePopup();
            menu.hidePopup?.();
            menu.replaceChildren();
            for (const item of items) {
                if (item?.separator) {
                    menu.appendChild(document.createXULElement('menuseparator'));
                    continue;
                }
                const menuItem = document.createXULElement('menuitem');
                menuItem.setAttribute('label', String(item?.label || ''));
                if (item?.disabled) menuItem.setAttribute('disabled', 'true');
                menuItem.addEventListener('command', () => {
                    if (item?.disabled) return;
                    item?.command?.();
                });
                menu.appendChild(menuItem);
            }
            const hasPointer = Number.isFinite(screenX)
                && Number.isFinite(screenY)
                && (screenX !== 0 || screenY !== 0);
            if (hasPointer && typeof menu.openPopupAtScreen === 'function') {
                menu.openPopupAtScreen(screenX, screenY, true);
            }
            else if (anchor && typeof menu.openPopup === 'function') {
                menu.openPopup(anchor, 'after_start', 0, 0, true, false);
            }
            return menu;
        },

        destroy() {
            popup?.hidePopup?.();
            popup?.remove();
            popup = null;
        },
    };
}
