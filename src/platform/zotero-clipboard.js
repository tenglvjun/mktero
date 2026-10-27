const CLIPBOARD_HELPER_CONTRACT = '@mozilla.org/widget/clipboardhelper;1';
const CLIPBOARD_CONTRACT = '@mozilla.org/widget/clipboard;1';
const TRANSFERABLE_CONTRACT = '@mozilla.org/widget/transferable;1';
const SUPPORTS_STRING_CONTRACT = '@mozilla.org/supports-string;1';
const TEXT_FLAVOR = 'text/plain';
const HTML_FLAVOR = 'text/html';

export function createZoteroClipboard(components) {
    return {
        async writeText(value) {
            if (typeof value !== 'string' || !value.trim()) {
                throw new Error('System clipboard content is unavailable');
            }
            const helper = components?.classes?.[CLIPBOARD_HELPER_CONTRACT]
                ?.getService?.(components?.interfaces?.nsIClipboardHelper);
            if (typeof helper?.copyString !== 'function') {
                throw new Error('System clipboard is unavailable');
            }
            helper.copyString(value);
        },
        // text/html beside text/plain, so a Zotero note paste keeps a table or
        // a formula. The length is UTF-16 bytes. setData stays three arguments:
        // the optional window-context argument is not used on Zotero 7 through
        // 10. A missing or throwing rich clipboard falls back to plain text.
        async writeRich({ text, html } = {}) {
            if (typeof text !== 'string' || !text.trim()) {
                throw new Error('System clipboard content is unavailable');
            }
            if (typeof html !== 'string') {
                throw new Error('System clipboard content is unavailable');
            }
            // An empty HTML flavor is truthy to some paste targets and would
            // hide the plain text. It is not a rich copy.
            if (!html.trim()) return this.writeText(text);
            try {
                writeRichClipboard(components, text, html);
            }
            catch {
                return this.writeText(text);
            }
        },
        // Reads the system clipboard's plain text, or null when it holds none.
        // Throws when the clipboard cannot be reached at all.
        async readText() {
            const interfaces = components?.interfaces;
            const clipboard = components?.classes?.[CLIPBOARD_CONTRACT]
                ?.getService?.(interfaces?.nsIClipboard);
            const transferable = components?.classes?.[TRANSFERABLE_CONTRACT]
                ?.createInstance?.(interfaces?.nsITransferable);
            if (typeof clipboard?.getData !== 'function'
                || typeof transferable?.addDataFlavor !== 'function') {
                throw new Error('System clipboard is unavailable');
            }
            transferable.init?.(null);
            transferable.addDataFlavor(TEXT_FLAVOR);
            clipboard.getData(transferable, clipboard.kGlobalClipboard);
            const data = {};
            try {
                transferable.getTransferData(TEXT_FLAVOR, data);
            }
            catch {
                return null;
            }
            const value = data.value?.QueryInterface?.(interfaces.nsISupportsString)
                ?.data;
            return typeof value === 'string' ? value : null;
        },
    };
}

function writeRichClipboard(components, text, html) {
    const interfaces = components?.interfaces;
    const clipboard = components?.classes?.[CLIPBOARD_CONTRACT]
        ?.getService?.(interfaces?.nsIClipboard);
    const transferable = components?.classes?.[TRANSFERABLE_CONTRACT]
        ?.createInstance?.(interfaces?.nsITransferable);
    if (typeof clipboard?.setData !== 'function'
        || typeof clipboard.kGlobalClipboard !== 'number'
        || typeof transferable?.init !== 'function'
        || typeof transferable.addDataFlavor !== 'function'
        || typeof transferable.setTransferData !== 'function') {
        throw new Error('System clipboard is unavailable');
    }
    transferable.init(null);
    addClipboardFlavor(components, transferable, HTML_FLAVOR, html);
    addClipboardFlavor(components, transferable, TEXT_FLAVOR, text);
    clipboard.setData(transferable, null, clipboard.kGlobalClipboard);
}

function addClipboardFlavor(components, transferable, flavor, value) {
    const supports = components?.classes?.[SUPPORTS_STRING_CONTRACT]
        ?.createInstance?.(components?.interfaces?.nsISupportsString);
    if (!supports || typeof supports !== 'object') {
        throw new Error('System clipboard is unavailable');
    }
    supports.data = value;
    transferable.addDataFlavor(flavor);
    transferable.setTransferData(flavor, supports, value.length * 2);
}
