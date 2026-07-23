export function registerReaderToolbar({ zotero, pluginID, onOpen, onError = defaultErrorHandler }) {
    if (!zotero?.Reader?.registerEventListener) {
        throw new Error('Zotero Reader event handlers are unavailable');
    }

    const handler = ({ reader, doc, append }) => {
        if (reader?.type !== 'pdf') return;

        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'toolbar-button mktero-markdown-button';
        button.textContent = 'MD';
        button.title = 'Open as Markdown';
        button.dataset.mkteroItemID = String(reader.itemID);
        button.setAttribute?.('aria-label', 'Open PDF as Markdown');
        button.addEventListener('click', () => {
            Promise.resolve(onOpen(reader)).catch(error => onError(error, reader));
        });
        append(button);
    };

    zotero.Reader.registerEventListener('renderToolbar', handler, pluginID);
    return () => {
        // Zotero removes listeners registered with pluginID during plugin shutdown.
        // Zotero 9.0's public unregister method incorrectly keeps only the target
        // listener, so calling it can remove listeners belonging to other plugins.
        if (isZotero90(zotero.version)) return;
        zotero.Reader.unregisterEventListener?.('renderToolbar', handler);
    };
}

function isZotero90(version) {
    return /^9\.0(?:[.-]|$)/.test(String(version || ''));
}

function defaultErrorHandler(error) {
    globalThis.Zotero?.logError?.(error);
}
