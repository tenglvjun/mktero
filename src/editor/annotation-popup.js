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

export function createAnnotationPopup(parent, {
    localization = createLocalization(),
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
                    updateAnnotationComment,
                    close,
                    reposition,
                });
            },
            focusContent: focusNoteInput,
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
    { updateAnnotationComment, close, reposition }
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
    const canUpdate = typeof updateAnnotationComment === 'function';
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
            await updateAnnotationComment(annotation.id, input.value);
            close?.();
        }
        catch {
            error.textContent = translate('annotation.noteSaveFailed');
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
        catch {
            error.textContent = translate('annotation.actionFailed');
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
