import { translateEnglish } from '../i18n/localization.js';
import {
    createLucideIcon,
    LUCIDE_ICONS,
} from '../icons/lucide-icon.js';
import { pdfSelectionPagesFromAnnotation } from '../core/pdf-selection-source-resolver.js';

const MARKDOWN_BUTTON_SELECTOR = '.mktero-markdown-button';
const GRAPH_BUTTON_SELECTOR = '.mktero-citation-graph-button';
const SELECTION_BUTTON_SELECTOR = '.mktero-selection-markdown-button';
const BUTTON_SELECTOR = `${MARKDOWN_BUTTON_SELECTOR}, ${GRAPH_BUTTON_SELECTOR}`;
const CUSTOM_SECTIONS_SELECTOR = '.toolbar .end .custom-sections';

export function registerReaderToolbar({
    zotero,
    pluginID,
    onOpen,
    onOpenSelection = null,
    isMarkdownReady = null,
    onSelectionUnresolved = null,
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
        if (!doc.querySelector?.(MARKDOWN_BUTTON_SELECTOR)) {
            append(createToolbarButton({
                doc,
                reader,
                className: 'mktero-markdown-button',
                icon: LUCIDE_ICONS.mktero,
                title: translate('toolbar.openMarkdown'),
                ariaLabel: translate('toolbar.openMarkdownAria'),
                onClick: () => onOpen(reader),
                onError,
            }));
        }
    };

    const selectionHandler = ({ reader, doc, params, append }) => {
        if (!active || reader?.type !== 'pdf' || typeof onOpenSelection !== 'function') {
            return;
        }
        if (typeof isMarkdownReady === 'function' && !isMarkdownReady(reader)) return;
        const annotation = params?.annotation;
        if (!pdfSelectionPagesFromAnnotation(annotation)) return;
        if (doc.querySelector?.(SELECTION_BUTTON_SELECTOR)) return;
        append(createSelectionButton({
            doc,
            reader,
            annotation,
            title: translate('readerSelection.openMarkdown'),
            ariaLabel: translate('readerSelection.openMarkdownAria'),
            onOpenSelection,
            onSelectionUnresolved,
            onError,
        }));
    };

    if (typeof onOpenSelection === 'function') {
        zotero.Reader.registerEventListener(
            'renderTextSelectionPopup',
            selectionHandler,
            pluginID
        );
    }
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
        zotero.Reader.unregisterEventListener?.(
            'renderTextSelectionPopup',
            selectionHandler
        );
    };
}

function createToolbarButton({
    doc,
    reader,
    className,
    icon,
    title,
    ariaLabel,
    onClick,
    onError,
}) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = `toolbar-button ${className}`;
    button.appendChild(createLucideIcon(doc, icon, {
        className: 'mktero-reader-toolbar-icon',
        size: 16,
    }));
    button.title = title;
    button.dataset.mkteroItemID = String(reader.itemID);
    button.setAttribute?.('aria-label', ariaLabel);
    button.addEventListener('click', () => {
        Promise.resolve(onClick()).catch(error => onError(error, reader));
    });
    return button;
}

function createSelectionButton({
    doc,
    reader,
    annotation,
    title,
    ariaLabel,
    onOpenSelection,
    onSelectionUnresolved,
    onError,
}) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'toolbar-button wide-button mktero-selection-markdown-button';
    button.textContent = title;
    button.title = title;
    button.setAttribute?.('aria-label', ariaLabel);
    button.addEventListener('click', () => {
        if (button.disabled) return;
        button.disabled = true;
        Promise.resolve(onOpenSelection(
            reader,
            annotation,
            message => reportSelection(button, message, reader, onSelectionUnresolved)
        )).then(result => {
            if (result?.status === 'opened') button.disabled = false;
        }).catch(error => onError(error, reader));
    });
    return button;
}

function reportSelection(button, message, reader, onSelectionUnresolved) {
    if (button.isConnected !== false) {
        button.textContent = message;
        button.disabled = true;
        return;
    }
    onSelectionUnresolved?.(message, reader);
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
