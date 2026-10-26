import { translateEnglish } from '../i18n/localization.js';

export const DIAGNOSTIC_MENU_ITEM_ID = 'mktero-report-problem';
const HELP_POPUP_ID = 'menu_HelpPopup';
const REPORT_ERRORS_ID = 'reportErrors';
const TOOLS_POPUP_ID = 'menu_ToolsPopup';
const LIBRARY_TAB_ID = 'zotero-pane';

// registerDiagnosticMenuItem places the entry next to Zotero's own Report
// Errors item, where users look for problem reports. The Tools menu is only a
// fallback for a window that has no Help menu.
export function registerDiagnosticMenuItem({
    window,
    onCommand,
    onError = () => {},
    translate = translateEnglish,
}) {
    const document = window?.document;
    if (!document?.getElementById || typeof onCommand !== 'function') return null;
    const helpPopup = document.getElementById(HELP_POPUP_ID);
    const popup = helpPopup || document.getElementById(TOOLS_POPUP_ID);
    if (!popup) return null;
    document.getElementById(DIAGNOSTIC_MENU_ITEM_ID)?.remove();
    const item = document.createXULElement?.('menuitem')
        || document.createElement('menuitem');
    item.id = DIAGNOSTIC_MENU_ITEM_ID;
    item.setAttribute('label', translate('diagnostics.menu'));
    const handleCommand = () => {
        Promise.resolve()
            .then(() => onCommand())
            .catch(onError);
    };
    item.addEventListener('command', handleCommand);
    const reportErrors = helpPopup
        ? document.getElementById(REPORT_ERRORS_ID)
        : null;
    if (reportErrors?.parentNode === popup) {
        popup.insertBefore(item, reportErrors.nextSibling);
    }
    else {
        popup.append(item);
    }
    return () => {
        item.removeEventListener('command', handleCommand);
        item.remove();
    };
}

// selectedDiagnosticItemID returns the PDF the user is looking at: the
// paper of an open Mktero or PDF reader tab, or a single PDF selected in the
// library. Anything ambiguous returns null rather than guessing.
export function selectedDiagnosticItemID({
    zotero,
    window,
    sourceItemForTab = () => null,
}) {
    try {
        const tabID = window?.Zotero_Tabs?.selectedID;
        if (tabID && tabID !== LIBRARY_TAB_ID) {
            const tabItemID = validItemID(sourceItemForTab(tabID))
                ?? validItemID(zotero?.Reader?.getByTabID?.(tabID)?.itemID);
            return tabItemID;
        }
        const pane = window?.ZoteroPane || zotero?.getActiveZoteroPane?.();
        const selected = pane?.getSelectedItems?.() || [];
        if (selected.length !== 1) return null;
        return pdfItemID(zotero, selected[0]);
    }
    catch {
        return null;
    }
}

function pdfItemID(zotero, item) {
    if (!item) return null;
    if (item.isPDFAttachment?.()) return validItemID(item.id);
    if (!item.isRegularItem?.()) return null;
    const pdfs = (item.getAttachments?.() || [])
        .map(id => zotero?.Items?.get?.(id))
        .filter(attachment => attachment?.isPDFAttachment?.());
    return pdfs.length === 1 ? validItemID(pdfs[0].id) : null;
}

function validItemID(value) {
    const itemID = Number(value);
    return Number.isSafeInteger(itemID) && itemID > 0 ? itemID : null;
}
