import { translateEnglish } from '../i18n/localization.js';
import {
    createLucideIcon,
    LUCIDE_ICONS,
} from '../icons/lucide-icon.js';

const BUTTON_SELECTOR = '.mktero-markdown-button';
const CUSTOM_SECTIONS_SELECTOR = '.toolbar .end .custom-sections';

export function registerReaderToolbar({
    zotero,
    pluginID,
    onOpen,
    onPDFReaderAvailable = null,
    onError = defaultErrorHandler,
    translate = translateEnglish,
}) {
    if (!zotero?.Reader?.registerEventListener) {
        throw new Error(translate('error.readerHandlersUnavailable'));
    }

    let active = true;
    const notifyPDFReaderAvailable = reader => {
        if (!active
            || reader?.type !== 'pdf'
            || typeof onPDFReaderAvailable !== 'function') {
            return;
        }
        Promise.resolve()
            .then(() => {
                if (!active) return;
                return onPDFReaderAvailable(reader);
            })
            .catch(error => onError(error, reader));
    };
    const handler = ({
        reader,
        doc,
        append,
        suppressAvailableNotification = false,
    }) => {
        if (!active || reader?.type !== 'pdf') return;
        if (!suppressAvailableNotification) notifyPDFReaderAvailable(reader);
        if (doc.querySelector?.(BUTTON_SELECTOR)) return;

        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'toolbar-button mktero-markdown-button';
        button.appendChild(createLucideIcon(doc, LUCIDE_ICONS.fileText, {
            className: 'mktero-reader-toolbar-icon',
            size: 16,
        }));
        button.title = translate('toolbar.openMarkdown');
        button.dataset.mkteroItemID = String(reader.itemID);
        button.setAttribute?.('aria-label', translate('toolbar.openMarkdownAria'));
        button.addEventListener('click', () => {
            Promise.resolve(onOpen(reader)).catch(error => onError(error, reader));
        });
        append(button);
    };

    zotero.Reader.registerEventListener('renderToolbar', handler, pluginID);
    injectOpenReaderToolbars(zotero, handler, notifyPDFReaderAvailable);
    return () => {
        if (!active) return;
        active = false;
        removeOpenReaderToolbarButtons(zotero);
        // Zotero 9.0's public unregister method incorrectly keeps only the target
        // listener. Its plugin-ID cleanup path has the intended implementation.
        if (isZotero90(zotero.version)) {
            zotero.Reader._unregisterEventListenerByPluginID?.(pluginID);
            return;
        }
        zotero.Reader.unregisterEventListener?.('renderToolbar', handler);
    };
}

function injectOpenReaderToolbars(zotero, handler, notifyPDFReaderAvailable) {
    for (const reader of getOpenReaders(zotero)) {
        notifyPDFReaderAvailable(reader);
        try {
            const doc = getReaderDocument(reader);
            removeToolbarButtonsFromDocument(doc);
            const container = doc?.querySelector?.(CUSTOM_SECTIONS_SELECTOR);
            if (!container) continue;
            handler({
                reader,
                doc,
                suppressAvailableNotification: true,
                append(element) {
                    const section = doc.createElement('div');
                    section.className = 'section';
                    section.append(element);
                    container.append(section);
                },
            });
        }
        catch (error) {
            zotero.logError?.(error);
        }
    }
}

function removeOpenReaderToolbarButtons(zotero) {
    for (const reader of getOpenReaders(zotero)) {
        try {
            const doc = getReaderDocument(reader);
            removeToolbarButtonsFromDocument(doc);
        }
        catch (error) {
            zotero.logError?.(error);
        }
    }
}

function removeToolbarButtonsFromDocument(doc) {
    for (const button of doc?.querySelectorAll?.(BUTTON_SELECTOR) || []) {
        const section = button.parentElement;
        button.remove();
        if (section?.classList?.contains('section') && !section.children.length) {
            section.remove();
        }
    }
}

function getOpenReaders(zotero) {
    return Array.isArray(zotero.Reader?._readers)
        ? zotero.Reader._readers
        : [];
}

function getReaderDocument(reader) {
    return reader?._iframeWindow?.document
        || reader?._iframe?.contentDocument
        || null;
}

function isZotero90(version) {
    return /^9\.0(?:[.-]|$)/.test(String(version || ''));
}

function defaultErrorHandler(error) {
    globalThis.Zotero?.logError?.(error);
}
