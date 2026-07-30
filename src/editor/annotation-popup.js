import { createAnchoredPopup } from './anchored-popup.js';
import {
    MAX_PDF_ANNOTATION_TEXT_LENGTH,
    ZOTERO_ANNOTATION_COLORS,
} from '../core/pdf-annotation.js';
import {
    createLucideIcon,
    LUCIDE_ICONS,
} from '../icons/lucide-icon.js';
import { createLocalization } from '../i18n/localization.js';
import {
    annotationPageLabel,
    safeAnnotationColor,
} from './pdf-annotations.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const ANNOTATION_ERROR_KEYS = new Map([
    ['MKTERO_PDF_TEXT_NOT_FOUND', 'annotation.pdfTextNotFound'],
    ['MKTERO_PDF_TEXT_AMBIGUOUS', 'annotation.pdfTextAmbiguous'],
    ['MKTERO_PDF_READER_UNAVAILABLE', 'annotation.pdfReaderUnavailable'],
    ['MKTERO_PDF_TEXT_SEARCH_TIMEOUT', 'annotation.pdfTextSearchTimeout'],
]);

export function createAnnotationPopup(parent, {
    localization = createLocalization(),
    createMarkdownAnnotation,
    changeAnnotationColor,
    updateAnnotationComment,
    deleteAnnotation,
} = {}) {
    const t = localization.t.bind(localization);
    const anchoredPopup = createAnchoredPopup(parent, {
        className: 'mktero-annotation-popup',
        idPrefix: 'mktero-annotation-popup',
    });

    const openNote = ({ anchor, annotation }) => {
        if (!annotation) return;
        anchoredPopup.close();
        anchoredPopup.open({
            anchor,
            label: t('annotation.noteEditor'),
            popupClassName: 'mktero-annotation-popup--note-editor',
            renderContent({ document, close, reposition }) {
                return createAnnotationNoteEditor(document, annotation, t, {
                    saveComment: typeof updateAnnotationComment === 'function'
                        ? comment => updateAnnotationComment(
                            annotation.id,
                            comment
                        )
                        : undefined,
                    close,
                    reposition,
                });
            },
            focusContent: focusNoteInput,
        });
    };
    const openDraftNote = ({ anchor, annotation }) => {
        if (!annotation) return;
        anchoredPopup.close();
        anchoredPopup.open({
            anchor,
            label: t('annotation.noteEditor'),
            popupClassName: 'mktero-annotation-popup--note-editor',
            renderContent({ document, close, reposition }) {
                return createAnnotationNoteEditor(document, annotation, t, {
                    saveComment: typeof createMarkdownAnnotation === 'function'
                        ? comment => createMarkdownAnnotation({
                            ...annotation,
                            comment,
                        })
                        : undefined,
                    close,
                    reposition,
                });
            },
            focusContent: focusNoteInput,
        });
    };
    const openSelection = ({ anchor, selection }) => {
        if (!selection) return;
        const annotation = {
            ...selection,
            source: 'markdown',
            type: 'highlight',
            comment: '',
            color: '#ffd400',
        };
        anchoredPopup.open({
            anchor,
            label: t('annotation.selectionActions'),
            popupClassName: 'mktero-annotation-popup--actions',
            renderContent({ document, close, reposition }) {
                return createMarkdownSelectionActions(document, annotation, t, {
                    createMarkdownAnnotation,
                    openNote: () => openDraftNote({ anchor, annotation }),
                    close,
                    reposition,
                });
            },
        });
    };
    const openActions = ({ anchor, annotation, focus = false }) => {
        if (!annotation) return;
        anchoredPopup.open({
            anchor,
            label: t('annotation.actions'),
            popupClassName: 'mktero-annotation-popup--actions',
            renderContent({ document, close, reposition }) {
                return createAnnotationActions(document, annotation, t, {
                    changeAnnotationColor,
                    deleteAnnotation,
                    close,
                    reposition,
                });
            },
            focusContent: focus
                ? popup => popup.querySelector('button:not([disabled])')?.focus()
                : undefined,
        });
    };

    return {
        open: openNote,
        openNote,
        openSelection,
        openActions,
        close: anchoredPopup.close,
        scheduleClose: anchoredPopup.scheduleClose,
        cancelClose: anchoredPopup.cancelClose,
        contains: anchoredPopup.contains,
        destroy: anchoredPopup.destroy,
    };
}

function createAnnotationMetadata(document, annotation, translate) {
    const metadata = document.createElementNS(XHTML_NAMESPACE, 'div');
    metadata.className = 'mktero-annotation-popup-metadata';
    const swatch = document.createElementNS(XHTML_NAMESPACE, 'span');
    swatch.className = 'mktero-annotation-popup-swatch';
    swatch.style.setProperty(
        '--mktero-annotation-color',
        safeAnnotationColor(annotation.color)
    );
    swatch.setAttribute('aria-hidden', 'true');
    metadata.appendChild(swatch);
    const pageLabel = annotationPageLabel(annotation);
    if (pageLabel) {
        const page = document.createElementNS(XHTML_NAMESPACE, 'span');
        page.className = 'mktero-annotation-popup-page';
        page.textContent = translate('annotation.page', {
            page: pageLabel,
        });
        metadata.appendChild(page);
    }
    return metadata;
}

function createAnnotationNoteEditor(
    document,
    annotation,
    translate,
    { saveComment, close, reposition }
) {
    const form = document.createElementNS(XHTML_NAMESPACE, 'form');
    form.className = 'mktero-annotation-note-editor';
    form.appendChild(createAnnotationMetadata(document, annotation, translate));

    const quote = document.createElementNS(XHTML_NAMESPACE, 'div');
    quote.className = 'mktero-annotation-note-quote';
    quote.textContent = String(annotation.text || '');
    form.appendChild(quote);

    const input = document.createElementNS(XHTML_NAMESPACE, 'textarea');
    input.className = 'mktero-annotation-note-input';
    input.maxLength = MAX_PDF_ANNOTATION_TEXT_LENGTH;
    input.setAttribute('aria-label', translate('annotation.noteInput'));
    input.setAttribute('placeholder', translate('annotation.notePlaceholder'));
    input.textContent = String(annotation.comment || '');
    const canUpdate = typeof saveComment === 'function';
    input.readOnly = !canUpdate;
    form.appendChild(input);

    const error = document.createElementNS(XHTML_NAMESPACE, 'div');
    error.className = 'mktero-annotation-note-error';
    error.setAttribute('role', 'status');
    error.setAttribute('aria-live', 'polite');
    error.hidden = true;

    const footer = document.createElementNS(XHTML_NAMESPACE, 'div');
    footer.className = 'mktero-annotation-note-footer';
    const cancelButton = document.createElementNS(XHTML_NAMESPACE, 'button');
    cancelButton.className = 'mktero-annotation-note-cancel';
    cancelButton.type = 'button';
    cancelButton.textContent = translate('annotation.cancelNote');
    cancelButton.addEventListener('click', close);
    const saveButton = document.createElementNS(XHTML_NAMESPACE, 'button');
    saveButton.className = 'mktero-annotation-note-save';
    saveButton.type = 'submit';
    saveButton.textContent = translate('annotation.saveNote');
    saveButton.disabled = !canUpdate;
    footer.append(cancelButton, saveButton);
    form.append(error, footer);

    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (!canUpdate) return;
        input.focus();
        input.readOnly = true;
        cancelButton.disabled = true;
        saveButton.disabled = true;
        error.hidden = true;
        try {
            await saveComment(input.value);
            close?.();
        }
        catch (cause) {
            error.textContent = annotationErrorMessage(
                cause,
                translate,
                'annotation.noteSaveFailed'
            );
            error.hidden = false;
            reposition?.();
        }
        finally {
            input.readOnly = false;
            cancelButton.disabled = false;
            saveButton.disabled = false;
            if (form.isConnected) input.focus();
        }
    });
    return form;
}

function createMarkdownSelectionActions(
    document,
    annotation,
    translate,
    { createMarkdownAnnotation, openNote, close, reposition }
) {
    const content = document.createElementNS(XHTML_NAMESPACE, 'div');
    content.className = [
        'mktero-annotation-actions',
        'mktero-markdown-selection-actions',
    ].join(' ');
    const palette = document.createElementNS(XHTML_NAMESPACE, 'div');
    palette.className = 'mktero-annotation-color-palette';
    palette.setAttribute('role', 'group');
    palette.setAttribute('aria-label', translate('annotation.addHighlight'));
    const controls = [];
    const error = document.createElementNS(XHTML_NAMESPACE, 'div');
    error.className = 'mktero-annotation-action-error';
    error.setAttribute('role', 'status');
    error.setAttribute('aria-live', 'polite');
    error.hidden = true;
    const canCreate = typeof createMarkdownAnnotation === 'function';

    const run = async action => {
        for (const control of controls) control.disabled = true;
        error.hidden = true;
        try {
            await action();
            close?.();
        }
        catch (cause) {
            error.textContent = annotationErrorMessage(
                cause,
                translate,
                'annotation.actionFailed'
            );
            error.hidden = false;
            reposition?.();
        }
        finally {
            for (const control of controls) control.disabled = !canCreate;
        }
    };

    for (const option of ZOTERO_ANNOTATION_COLORS) {
        const button = document.createElementNS(XHTML_NAMESPACE, 'button');
        button.className = 'mktero-annotation-color-button';
        button.type = 'button';
        button.dataset.color = option.value;
        button.style.setProperty('--mktero-annotation-color', option.value);
        button.setAttribute('aria-label', translate('annotation.highlightColor', {
            color: translate(`annotation.color.${option.name}`),
        }));
        button.setAttribute('title', translate('annotation.highlightColor', {
            color: translate(`annotation.color.${option.name}`),
        }));
        button.disabled = !canCreate;
        button.addEventListener('click', () => run(() => (
            createMarkdownAnnotation({ ...annotation, color: option.value })
        )));
        controls.push(button);
        palette.appendChild(button);
    }
    content.appendChild(palette);

    const noteButton = document.createElementNS(XHTML_NAMESPACE, 'button');
    noteButton.className = 'mktero-annotation-note-button';
    noteButton.type = 'button';
    noteButton.dataset.action = 'add-note';
    noteButton.setAttribute('aria-label', translate('annotation.addNote'));
    noteButton.setAttribute('title', translate('annotation.addNote'));
    noteButton.disabled = !canCreate;
    noteButton.appendChild(createLucideIcon(
        document,
        LUCIDE_ICONS.messageSquarePlus,
        { className: 'mktero-annotation-note-action-icon', size: 16 }
    ));
    noteButton.addEventListener('click', openNote);
    controls.push(noteButton);
    content.append(noteButton, error);
    return content;
}

function focusNoteInput(popup) {
    const input = popup.querySelector('.mktero-annotation-note-input');
    if (!input) return;
    input.focus();
    input.setSelectionRange?.(input.value.length, input.value.length);
}

function createAnnotationActions(
    document,
    annotation,
    translate,
    { changeAnnotationColor, deleteAnnotation, close, reposition }
) {
    const content = document.createElementNS(XHTML_NAMESPACE, 'div');
    content.className = 'mktero-annotation-actions';
    const palette = document.createElementNS(XHTML_NAMESPACE, 'div');
    palette.className = 'mktero-annotation-color-palette';
    palette.setAttribute('role', 'group');
    palette.setAttribute('aria-label', translate('annotation.changeColor'));
    const controls = [];
    const currentColor = safeAnnotationColor(annotation.color);
    const error = document.createElementNS(XHTML_NAMESPACE, 'div');
    error.className = 'mktero-annotation-action-error';
    error.setAttribute('role', 'status');
    error.setAttribute('aria-live', 'polite');
    error.hidden = true;

    const run = async action => {
        for (const control of controls) control.disabled = true;
        error.hidden = true;
        try {
            await action();
            close?.();
        }
        catch (cause) {
            error.textContent = annotationErrorMessage(
                cause,
                translate,
                'annotation.actionFailed'
            );
            error.hidden = false;
            reposition?.();
        }
        finally {
            for (const control of controls) control.disabled = false;
        }
    };

    for (const option of ZOTERO_ANNOTATION_COLORS) {
        const button = document.createElementNS(XHTML_NAMESPACE, 'button');
        button.className = 'mktero-annotation-color-button';
        button.type = 'button';
        button.dataset.color = option.value;
        button.style.setProperty('--mktero-annotation-color', option.value);
        button.setAttribute(
            'aria-label',
            translate(`annotation.color.${option.name}`)
        );
        button.setAttribute('title', translate(`annotation.color.${option.name}`));
        button.setAttribute('aria-pressed', String(option.value === currentColor));
        button.disabled = typeof changeAnnotationColor !== 'function';
        button.addEventListener('click', () => run(() => (
            changeAnnotationColor(annotation.id, option.value)
        )));
        controls.push(button);
        palette.appendChild(button);
    }
    content.appendChild(palette);

    const deleteButton = document.createElementNS(XHTML_NAMESPACE, 'button');
    deleteButton.className = 'mktero-annotation-delete-button';
    deleteButton.type = 'button';
    deleteButton.setAttribute('aria-label', translate('annotation.delete'));
    deleteButton.setAttribute('title', translate('annotation.delete'));
    deleteButton.disabled = typeof deleteAnnotation !== 'function';
    deleteButton.appendChild(createLucideIcon(
        document,
        LUCIDE_ICONS.trash2,
        { className: 'mktero-annotation-delete-icon', size: 16 }
    ));
    deleteButton.addEventListener('click', () => run(() => (
        deleteAnnotation(annotation.id)
    )));
    controls.push(deleteButton);
    content.appendChild(deleteButton);
    content.appendChild(error);
    return content;
}

function annotationErrorMessage(error, translate, fallbackKey) {
    return translate(ANNOTATION_ERROR_KEYS.get(error?.code) || fallbackKey);
}
