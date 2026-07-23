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
    return () => zotero.Reader.unregisterEventListener?.('renderToolbar', handler);
}

function defaultErrorHandler(error) {
    globalThis.Zotero?.logError?.(error);
}
