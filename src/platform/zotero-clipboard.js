const CLIPBOARD_HELPER_CONTRACT = '@mozilla.org/widget/clipboardhelper;1';

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
    };
}
