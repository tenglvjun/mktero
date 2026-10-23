const CLIPBOARD_HELPER_CONTRACT = '@mozilla.org/widget/clipboardhelper;1';
const CLIPBOARD_CONTRACT = '@mozilla.org/widget/clipboard;1';
const TRANSFERABLE_CONTRACT = '@mozilla.org/widget/transferable;1';
const TEXT_FLAVOR = 'text/plain';

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
