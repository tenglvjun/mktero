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
const ANNOTATION_HOVER_OPEN_DELAY_MS = 220;
const SELECTION_TRANSLATION_DELAY_MS = 250;
const ANNOTATION_ERROR_KEYS = new Map([
    ['MKTERO_PDF_TEXT_NOT_FOUND', 'annotation.pdfTextNotFound'],
    ['MKTERO_PDF_TEXT_AMBIGUOUS', 'annotation.pdfTextAmbiguous'],
    ['MKTERO_PDF_READER_UNAVAILABLE', 'annotation.pdfReaderUnavailable'],
    ['MKTERO_PDF_TEXT_SEARCH_TIMEOUT', 'annotation.pdfTextSearchTimeout'],
    ['MKTERO_ANNOTATION_TOO_MANY_SEGMENTS', 'annotation.tooManySegments'],
]);
const SELECTION_TRANSLATION_ERROR_KEYS = new Map([
    ['AI_CONFIGURATION_ERROR', 'ai.configurationRequired'],
    ['AI_AUTH_ERROR', 'ai.authenticationFailed'],
    ['AI_RATE_LIMITED', 'ai.rateLimited'],
    ['AI_REQUEST_TIMEOUT', 'ai.requestTimedOut'],
    ['AI_INPUT_TOO_LARGE', 'ai.selectionTranslationTooLong'],
    ['AI_RESPONSE_TOO_LARGE', 'ai.responseTooLarge'],
]);

export function createAnnotationPopup(parent, {
    localization = createLocalization(),
    createMarkdownAnnotation,
    changeAnnotationColor,
    updateAnnotationComment,
    deleteAnnotation,
    copySourcedMarkdown,
    translateSelection,
    cancelSelectionTranslation,
    shouldAutoTranslateSelection,
    copySelectionTranslation,
    openSourceLocation,
    openAnnotationInPDF,
    onNoteEditorClose,
    onSourceNavigationError,
    onDetachedActionError,
} = {}) {
    const t = localization.t.bind(localization);
    const ownerWindow = parent.ownerDocument.defaultView;
    const anchoredPopup = createAnchoredPopup(parent, {
        className: 'mktero-annotation-popup',
        idPrefix: 'mktero-annotation-popup',
    });
    let selectionLocked = false;
    let hoverOpenTimer = null;
    let hoverOpenAnchor = null;
    let activeSelectionTranslationCancel = null;
    let saveNoteBeforeDismiss = null;
    let selectionHintOpen = false;
    // A live region inserted together with its text may never be announced.
    // This one exists for the popup's whole life, so a hint only changes the
    // text of a region the screen reader already tracks.
    const status = createVisuallyHiddenStatus(parent.ownerDocument);
    parent.appendChild(status);

    const cancelScheduledOpen = anchor => {
        if (hoverOpenTimer === null
            || (anchor && hoverOpenAnchor !== anchor)) {
            return false;
        }
        ownerWindow.clearTimeout(hoverOpenTimer);
        hoverOpenTimer = null;
        hoverOpenAnchor = null;
        return true;
    };
    const isSelectionOpen = () => (
        selectionLocked && anchoredPopup.isOpen()
    );
    const isNoteOpen = () => (
        saveNoteBeforeDismiss !== null && anchoredPopup.isOpen()
    );
    const isSelectionHintOpen = () => (
        selectionHintOpen && anchoredPopup.isOpen()
    );

    const cancelActiveSelectionTranslation = () => {
        const cancel = activeSelectionTranslationCancel;
        activeSelectionTranslationCancel = null;
        cancel?.();
    };

    const close = ({ saveNote = false } = {}) => {
        const save = saveNote ? saveNoteBeforeDismiss : null;
        const noteWasOpen = saveNoteBeforeDismiss !== null;
        saveNoteBeforeDismiss = null;
        cancelScheduledOpen();
        cancelActiveSelectionTranslation();
        selectionLocked = false;
        anchoredPopup.close();
        if (noteWasOpen) onNoteEditorClose?.();
        save?.();
    };
    const openPopup = (options, { lockSelection = false } = {}) => {
        anchoredPopup.open(options);
        selectionLocked = lockSelection && anchoredPopup.isOpen();
    };
    // The anchored popup can also close a note editor by itself, on Escape or
    // when focus leaves it. Without this, the pending save survives the editor
    // and the next outside click writes a note the reader already dismissed.
    const dismissNoteEditor = reason => {
        const save = saveNoteBeforeDismiss;
        if (!save) return;
        saveNoteBeforeDismiss = null;
        onNoteEditorClose?.();
        if (reason !== 'escape') save();
    };

    const openNote = ({ anchor, annotation, comment, errorText }) => {
        if (!annotation) return;
        close();
        openPopup({
            anchor,
            label: t('annotation.noteEditor'),
            popupClassName: 'mktero-annotation-popup--note-editor',
            renderContent({ document, reposition }) {
                const editor = createAnnotationNoteEditor(
                    document,
                    annotation,
                    t,
                    {
                        comment,
                        errorText,
                        saveComment: typeof updateAnnotationComment === 'function'
                            ? comment => updateAnnotationComment(
                                annotation.id,
                                comment
                            )
                            : undefined,
                        close,
                        reopen: (failedComment, failedError) => openNote({
                            anchor,
                            annotation,
                            comment: failedComment,
                            errorText: failedError,
                        }),
                        reposition,
                    }
                );
                saveNoteBeforeDismiss = editor.saveIfChanged;
                return editor.form;
            },
            focusContent: focusNoteInput,
            onClose: dismissNoteEditor,
        });
    };
    const openDraftNote = ({
        anchor,
        annotation,
        selectionContext,
        comment,
        errorText,
    }) => {
        if (!annotation) return;
        close();
        openPopup({
            anchor,
            label: t('annotation.noteEditor'),
            popupClassName: 'mktero-annotation-popup--note-editor',
            renderContent({ document, reposition }) {
                const editor = createAnnotationNoteEditor(
                    document,
                    annotation,
                    t,
                    {
                        comment,
                        errorText,
                        saveComment: typeof createMarkdownAnnotation === 'function'
                            ? comment => createMarkdownAnnotation({
                                ...annotation,
                                comment,
                            }, selectionContext)
                            : undefined,
                        close,
                        reopen: (failedComment, failedError) => openDraftNote({
                            anchor,
                            annotation,
                            selectionContext,
                            comment: failedComment,
                            errorText: failedError,
                        }),
                        reposition,
                    }
                );
                saveNoteBeforeDismiss = editor.saveIfChanged;
                return editor.form;
            },
            focusContent: focusNoteInput,
            onClose: dismissNoteEditor,
        });
    };
    const openSelection = ({
        anchor,
        selection,
        copyTarget,
        sourceLocation,
        canCopySource = false,
        selectionContext,
        onOpenNote,
    }) => {
        if (!selection) return;
        cancelScheduledOpen();
        const annotation = {
            ...selection,
            source: 'markdown',
            type: 'highlight',
            comment: '',
            color: '#ffd400',
        };
        let cancelSelectionPopup = () => {};
        let registeredSelectionPopupCancel = false;
        openPopup({
            anchor,
            label: t('annotation.selectionActions'),
            popupClassName: 'mktero-annotation-popup--actions',
            dismissOnMouseLeave: false,
            onClose: () => {
                cancelSelectionPopup();
                if (activeSelectionTranslationCancel === cancelSelectionPopup) {
                    activeSelectionTranslationCancel = null;
                }
            },
            renderContent({ document, close, reposition }) {
                const actions = createMarkdownSelectionActions(
                    document,
                    annotation,
                    t,
                    {
                        selectionContext,
                        createMarkdownAnnotation:
                            typeof createMarkdownAnnotation === 'function'
                                ? draft => createMarkdownAnnotation(
                                    draft,
                                    selectionContext
                                )
                            : undefined,
                        translateSelection:
                            typeof translateSelection === 'function'
                                ? (
                                    text,
                                    selectionContext,
                                    options,
                                ) => translateSelection(
                                    text,
                                    selectionContext,
                                    options,
                                )
                            : undefined,
                        cancelSelectionTranslation:
                            typeof cancelSelectionTranslation === 'function'
                                ? cancelSelectionTranslation
                            : undefined,
                        shouldAutoTranslateSelection,
                        copySelectionTranslation:
                            typeof copySelectionTranslation === 'function'
                                ? copySelectionTranslation
                            : undefined,
                        copySourcedMarkdown: canCopySource
                            && typeof copySourcedMarkdown === 'function'
                            ? () => copySourcedMarkdown(copyTarget)
                            : undefined,
                        viewPDFSource: sourceLocation
                            && typeof openSourceLocation === 'function'
                            ? async () => {
                                try {
                                    await openSourceLocation(sourceLocation);
                                }
                                catch (error) {
                                    onSourceNavigationError?.(error);
                                    throw error;
                                }
                            }
                            : undefined,
                        viewPDFSourceReportsErrors:
                            typeof onSourceNavigationError === 'function',
                        openNote: () => {
                            onOpenNote?.();
                            openDraftNote({
                                anchor,
                                annotation,
                                selectionContext,
                            });
                        },
                        close,
                        reposition,
                        onDetachedActionError,
                        registerPopupCancel: cancel => {
                            registeredSelectionPopupCancel = true;
                            cancelSelectionPopup = cancel;
                        },
                    }
                );
                return actions;
            },
        }, { lockSelection: true });
        if (registeredSelectionPopupCancel) {
            activeSelectionTranslationCancel = cancelSelectionPopup;
        }
    };
    // A compare-mode selection that holds no original text gets no actions.
    // Say why instead of leaving the selection without any response.
    const openSelectionHint = ({ anchor }) => {
        if (!anchor) return;
        cancelScheduledOpen();
        const message = t('annotation.originalTextOnly');
        openPopup({
            anchor,
            label: t('annotation.originalTextOnlyLabel'),
            popupClassName: 'mktero-annotation-popup--hint',
            dismissOnMouseLeave: false,
            onClose: () => {
                selectionHintOpen = false;
                status.textContent = '';
            },
            renderContent({ document }) {
                const hint = document.createElementNS(XHTML_NAMESPACE, 'div');
                hint.className = 'mktero-annotation-selection-hint';
                hint.textContent = message;
                return hint;
            },
        });
        selectionHintOpen = anchoredPopup.isOpen();
        if (selectionHintOpen) status.textContent = message;
    };
    const openActions = ({ anchor, annotation, focus = false }) => {
        if (!annotation) return;
        cancelScheduledOpen();
        openPopup({
            anchor,
            label: t('annotation.actions'),
            popupClassName: 'mktero-annotation-popup--actions',
            renderContent({ document, close, reposition }) {
                return createAnnotationActions(document, annotation, t, {
                    changeAnnotationColor,
                    deleteAnnotation,
                    openNote: () => openNote({ anchor, annotation }),
                    viewInPDF: annotation.source !== 'markdown'
                        && typeof openAnnotationInPDF === 'function'
                        ? async () => {
                            try {
                                await openAnnotationInPDF(annotation.id);
                            }
                            catch (error) {
                                onSourceNavigationError?.(error);
                                throw error;
                            }
                        }
                        : undefined,
                    close,
                    reposition,
                });
            },
            focusContent: focus
                ? popup => popup.querySelector('button:not([disabled])')?.focus()
                : undefined,
        });
    };
    const scheduleOpenActions = ({ anchor, annotation, beforeOpen }) => {
        if (!anchor || !annotation || isSelectionOpen() || isNoteOpen()) return;
        if (hoverOpenTimer !== null && hoverOpenAnchor === anchor) return;
        cancelScheduledOpen();
        hoverOpenAnchor = anchor;
        hoverOpenTimer = ownerWindow.setTimeout(() => {
            hoverOpenTimer = null;
            hoverOpenAnchor = null;
            if (isSelectionOpen() || isNoteOpen() || !anchor.isConnected) return;
            beforeOpen?.();
            openActions({ anchor, annotation });
        }, ANNOTATION_HOVER_OPEN_DELAY_MS);
    };

    return {
        open: openNote,
        openNote,
        openSelection,
        openSelectionHint,
        openActions,
        scheduleOpenActions,
        cancelScheduledOpen,
        close,
        scheduleClose: anchoredPopup.scheduleClose,
        cancelClose: anchoredPopup.cancelClose,
        isSelectionOpen,
        isSelectionHintOpen,
        isNoteOpen,
        contains: anchoredPopup.contains,
        destroy() {
            close();
            status.remove();
        },
    };
}

function createVisuallyHiddenStatus(document) {
    const status = document.createElementNS(XHTML_NAMESPACE, 'div');
    status.className = 'mktero-annotation-popup-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    for (const [property, value] of [
        ['position', 'absolute'],
        ['width', '1px'],
        ['height', '1px'],
        ['margin', '-1px'],
        ['padding', '0'],
        ['border', '0'],
        ['overflow', 'hidden'],
        ['clip', 'rect(0 0 0 0)'],
        ['clip-path', 'inset(50%)'],
        ['white-space', 'nowrap'],
    ]) {
        status.style.setProperty(property, value);
    }
    return status;
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
    {
        comment,
        errorText = '',
        saveComment,
        close,
        reopen,
        reposition,
    }
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
    input.textContent = String(
        comment === undefined ? annotation.comment || '' : comment
    );
    const canUpdate = typeof saveComment === 'function';
    input.readOnly = !canUpdate;
    input.addEventListener('copy', event => {
        copyQuoteFromEmptyNoteInput(event, input, annotation);
    });
    form.appendChild(input);

    const error = document.createElementNS(XHTML_NAMESPACE, 'div');
    error.className = 'mktero-annotation-note-error';
    error.setAttribute('role', 'status');
    error.setAttribute('aria-live', 'polite');
    error.textContent = errorText;
    error.hidden = !errorText;

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

    let saving = null;
    const save = event => {
        event?.preventDefault?.();
        if (!canUpdate || saving) return saving;
        input.focus();
        input.readOnly = true;
        cancelButton.disabled = true;
        saveButton.disabled = true;
        error.hidden = true;
        saving = Promise.resolve()
            .then(() => saveComment(input.value))
            .then(() => {
                // The shared popup may already show newer content.
                if (form.isConnected) close?.();
            })
            .catch(cause => {
                error.textContent = annotationErrorMessage(
                    cause,
                    translate,
                    'annotation.noteSaveFailed'
                );
                error.hidden = false;
                const restoreFailedSave = () => reopen?.(
                    input.value,
                    error.textContent
                );
                if (form.isConnected) {
                    restoreFailedSave();
                    input.focus();
                }
                else {
                    queueMicrotask(restoreFailedSave);
                }
                reposition?.();
            })
            .finally(() => {
                saving = null;
                input.readOnly = false;
                cancelButton.disabled = false;
                saveButton.disabled = false;
            });
        return saving;
    };

    form.addEventListener('submit', save);
    saveButton.addEventListener('click', save);
    // Dismissing the editor without Save keeps what the reader typed, but an
    // untouched editor writes nothing. A new draft is otherwise saved as a
    // highlight with no note, which nobody asked for by clicking away.
    const storedComment = String(annotation.comment || '').trim();
    const saveIfChanged = () => {
        const draft = input.value.trim();
        if (draft === storedComment) return null;
        return save();
    };
    return { form, save, saveIfChanged };
}

function createMarkdownSelectionActions(
    document,
    annotation,
    translate,
    {
        createMarkdownAnnotation,
        selectionContext,
        translateSelection,
        cancelSelectionTranslation,
        shouldAutoTranslateSelection,
        copySelectionTranslation,
        registerPopupCancel,
        copySourcedMarkdown,
        viewPDFSource,
        viewPDFSourceReportsErrors = false,
        openNote,
        close,
        reposition,
        onDetachedActionError,
    }
) {
    const content = document.createElementNS(XHTML_NAMESPACE, 'div');
    content.className = [
        'mktero-annotation-actions',
        'mktero-markdown-selection-actions',
    ].join(' ');
    const toolbar = document.createElementNS(XHTML_NAMESPACE, 'div');
    toolbar.className = 'mktero-markdown-selection-toolbar';
    content.appendChild(toolbar);
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
    const canTranslate = typeof translateSelection === 'function';
    const translation = document.createElementNS(XHTML_NAMESPACE, 'div');
    translation.className = 'mktero-selection-translation';
    translation.dataset.translationStatus = 'idle';
    const translationStatus = document.createElementNS(
        XHTML_NAMESPACE,
        'div'
    );
    translationStatus.className = 'mktero-selection-translation-status';
    translationStatus.setAttribute('role', 'status');
    translationStatus.setAttribute('aria-live', 'polite');
    const translationResult = document.createElementNS(
        XHTML_NAMESPACE,
        'div'
    );
    translationResult.className = 'mktero-selection-translation-result';
    translationResult.hidden = true;
    const translationError = document.createElementNS(
        XHTML_NAMESPACE,
        'div'
    );
    translationError.className = 'mktero-selection-translation-error';
    translationError.setAttribute('role', 'alert');
    translationError.hidden = true;
    const translationButtons = document.createElementNS(
        XHTML_NAMESPACE,
        'div'
    );
    translationButtons.className = 'mktero-selection-translation-actions';
    let translationStatusValue = 'idle';
    let translationRequestID = 0;
    let autoTranslateTimer = null;
    let translatedText = '';

    const clearAutoTranslateTimer = () => {
        if (autoTranslateTimer === null) return;
        document.defaultView?.clearTimeout(autoTranslateTimer);
        autoTranslateTimer = null;
    };

    const createTranslationButton = (action, label, icon) => {
        const button = document.createElementNS(XHTML_NAMESPACE, 'button');
        button.className = 'mktero-selection-translation-button';
        button.type = 'button';
        button.dataset.action = action;
        button.setAttribute('aria-label', translate(label));
        button.setAttribute('title', translate(label));
        button.appendChild(createLucideIcon(
            document,
            icon,
            { className: 'mktero-selection-translation-icon', size: 16 }
        ));
        return button;
    };

    const translateButton = canTranslate
        ? createTranslationButton(
            'translate-selection',
            'ai.translateSelection',
            LUCIDE_ICONS.languages
        )
        : null;
    const cancelTranslationButton = canTranslate
        ? createTranslationButton(
            'cancel-selection-translation',
            'ai.cancelSelectionTranslation',
            LUCIDE_ICONS.x
        )
        : null;
    const retryTranslationButton = canTranslate
        ? createTranslationButton(
            'retry-selection-translation',
            'ai.retrySelectionTranslation',
            LUCIDE_ICONS.rotateCcw
        )
        : null;
    const retranslateButton = canTranslate
        ? createTranslationButton(
            'retranslate-selection',
            'ai.retranslateSelection',
            LUCIDE_ICONS.rotateCcw
        )
        : null;
    const copyTranslationButton = typeof copySelectionTranslation === 'function'
        ? createTranslationButton(
            'copy-selection-translation',
            'ai.copySelectionTranslation',
            LUCIDE_ICONS.copy
        )
        : null;

    const setTranslationStatus = status => {
        translationStatusValue = status;
        content.dataset.status = status;
        content.dataset.translationStatus = status;
        translation.dataset.status = status;
        translation.dataset.translationStatus = status;
        translationButtons.replaceChildren();
        translationStatus.textContent = '';
        translationError.hidden = true;
        translation.hidden = status === 'idle';
        translationResult.hidden = status !== 'success';
        if (translateButton) {
            translateButton.hidden = status !== 'idle';
            translateButton.disabled = status === 'loading';
        }
        if (status === 'loading') {
            translationStatus.textContent = translate(
                'ai.selectionTranslationLoading'
            );
            translationButtons.appendChild(cancelTranslationButton);
        }
        else if (status === 'error') {
            translationStatus.textContent = translate(
                'ai.selectionTranslationFailed'
            );
            translationButtons.appendChild(retryTranslationButton);
            translationError.hidden = !translationError.textContent
                || translationError.textContent === translationStatus.textContent;
        }
        else if (status === 'success') {
            translationStatus.textContent = translate(
                'ai.selectionTranslationLabel'
            );
            translationButtons.appendChild(retranslateButton);
            if (copyTranslationButton) {
                translationButtons.appendChild(copyTranslationButton);
            }
        }
        reposition?.();
    };

    // A pending action (a highlight create) and a running translation each
    // keep the controls disabled. A translation that finishes first must not
    // re-enable a color that would create the same highlight twice.
    let actionPending = false;
    let translationBusy = false;
    const syncControlsDisabled = () => {
        for (const control of controls) {
            control.button.disabled = actionPending
                || translationBusy
                || !control.enabled;
        }
    };
    const setExistingControlsBusy = busy => {
        translationBusy = busy;
        syncControlsDisabled();
    };

    const startTranslation = async () => {
        if (!canTranslate || translationStatusValue === 'loading') return;
        clearAutoTranslateTimer();
        const requestID = ++translationRequestID;
        translatedText = '';
        translationResult.textContent = '';
        setExistingControlsBusy(true);
        setTranslationStatus('loading');
        try {
            const result = await translateSelection(
                annotation.text,
                selectionContext,
                {
                    onTextDelta(_chunk, accumulated) {
                        if (requestID !== translationRequestID) return;
                        translatedText = String(accumulated ?? '');
                        translationResult.textContent = translatedText;
                        translationResult.hidden = !translatedText;
                        reposition?.();
                    },
                },
            );
            if (requestID !== translationRequestID) return;
            const text = String(
                (typeof result === 'string' ? result : result?.text) || ''
            ).trim() || String(translatedText || '').trim();
            if (!text) {
                const emptyError = new Error('Selection translation was empty');
                emptyError.code = 'MKTERO_AI_SELECTION_TRANSLATION_EMPTY';
                throw emptyError;
            }
            translatedText = text;
            translationResult.textContent = text;
            translationRequestID += 1;
            setExistingControlsBusy(false);
            setTranslationStatus('success');
        }
        catch (cause) {
            if (requestID !== translationRequestID) return;
            const streamed = String(translatedText || '').trim();
            if (streamed && !isFatalSelectionTranslationError(cause)) {
                translationRequestID += 1;
                translatedText = streamed;
                translationResult.textContent = streamed;
                setExistingControlsBusy(false);
                setTranslationStatus('success');
                return;
            }
            translationRequestID += 1;
            translatedText = '';
            translationResult.textContent = '';
            setExistingControlsBusy(false);
            translationError.textContent = annotationErrorMessage(
                cause,
                translate,
                'ai.selectionTranslationFailed'
            );
            setTranslationStatus('error');
        }
    };

    const cancelTranslation = () => {
        if (translationStatusValue !== 'loading') return;
        clearAutoTranslateTimer();
        translationRequestID += 1;
        cancelSelectionTranslation?.();
        translatedText = '';
        translationResult.textContent = '';
        setExistingControlsBusy(false);
        setTranslationStatus('idle');
    };

    registerPopupCancel?.(() => {
        clearAutoTranslateTimer();
        cancelTranslation();
    });

    translateButton?.addEventListener('click', startTranslation);
    cancelTranslationButton?.addEventListener('click', cancelTranslation);
    retryTranslationButton?.addEventListener('click', startTranslation);
    retranslateButton?.addEventListener('click', startTranslation);
    copyTranslationButton?.addEventListener('click', async () => {
        try {
            await copySelectionTranslation(translatedText);
        }
        catch (cause) {
            translationError.textContent = annotationErrorMessage(
                cause,
                translate,
                'ai.selectionTranslationCopyFailed'
            );
            translationError.hidden = false;
            reposition?.();
        }
    });

    translation.append(
        translationStatus,
        translationResult,
        translationError,
        translationButtons
    );

    const run = async (
        action,
        errorKey = 'annotation.actionFailed',
        { errorReported = false } = {}
    ) => {
        if (actionPending) return;
        actionPending = true;
        syncControlsDisabled();
        error.hidden = true;
        try {
            await action();
            // The shared popup may already show a newer selection.
            if (content.isConnected) close?.();
        }
        catch (cause) {
            if (!content.isConnected) {
                // A refresh or an outside click closed this popup while the
                // action ran. Its error element is detached, so the failure
                // has to be shown somewhere the reader can still see.
                // An action that already logged its failure passes no
                // error, so the reader sees the message without a second log.
                onDetachedActionError?.(
                    annotationErrorKey(cause, errorKey),
                    errorReported ? undefined : cause
                );
                return;
            }
            error.textContent = annotationErrorMessage(
                cause,
                translate,
                errorKey
            );
            error.hidden = false;
            reposition?.();
        }
        finally {
            actionPending = false;
            syncControlsDisabled();
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
        ), 'annotation.createFailed'));
        controls.push({ button, enabled: canCreate });
        palette.appendChild(button);
    }
    toolbar.appendChild(palette);

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
    controls.push({ button: noteButton, enabled: canCreate });
    toolbar.appendChild(noteButton);

    if (typeof viewPDFSource === 'function') {
        const sourceButton = document.createElementNS(XHTML_NAMESPACE, 'button');
        sourceButton.className = 'mktero-annotation-source-button';
        sourceButton.type = 'button';
        sourceButton.dataset.action = 'view-in-pdf';
        sourceButton.setAttribute('aria-label', translate('source.viewInPDF'));
        sourceButton.setAttribute('title', translate('source.viewInPDF'));
        sourceButton.appendChild(createLucideIcon(
            document,
            LUCIDE_ICONS.externalLink,
            { className: 'mktero-source-action-icon', size: 16 }
        ));
        sourceButton.addEventListener('click', () => run(
            viewPDFSource,
            'source.navigationFailed',
            { errorReported: viewPDFSourceReportsErrors }
        ));
        controls.push({ button: sourceButton, enabled: true });
        toolbar.appendChild(sourceButton);
    }

    if (typeof copySourcedMarkdown === 'function') {
        const copyButton = document.createElementNS(XHTML_NAMESPACE, 'button');
        copyButton.className = 'mktero-annotation-copy-button';
        copyButton.type = 'button';
        copyButton.dataset.action = 'copy-with-source';
        copyButton.setAttribute('aria-label', translate('evidence.copyWithSource'));
        copyButton.setAttribute('title', translate('evidence.copyWithSource'));
        copyButton.appendChild(createLucideIcon(
            document,
            LUCIDE_ICONS.copy,
            { className: 'mktero-evidence-copy-icon', size: 16 }
        ));
        copyButton.addEventListener('click', () => run(
            copySourcedMarkdown,
            'evidence.copyFailed'
        ));
        controls.push({ button: copyButton, enabled: true });
        toolbar.appendChild(copyButton);
    }
    if (canTranslate) {
        controls.push({ button: translateButton, enabled: true });
        toolbar.appendChild(translateButton);
        content.appendChild(translation);
        setTranslationStatus('idle');
        if (shouldAutoTranslateSelection?.() === true) {
            autoTranslateTimer = document.defaultView?.setTimeout(
                startTranslation,
                SELECTION_TRANSLATION_DELAY_MS
            ) ?? null;
        }
    }
    content.appendChild(error);
    return content;
}

// Opening a note moves focus into its input while the quoted Markdown stays
// highlighted. Copy then targets the empty input, so hand the clipboard the
// quote the reader still sees selected.
function copyQuoteFromEmptyNoteInput(event, input, annotation) {
    if (input.selectionStart !== input.selectionEnd) return;
    const quote = String(annotation?.text || '');
    if (!quote.trim() || !event.clipboardData) return;
    event.clipboardData.setData('text/plain', quote);
    event.preventDefault();
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
    {
        changeAnnotationColor,
        deleteAnnotation,
        openNote,
        viewInPDF,
        close,
        reposition,
    }
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

    const run = async (action, errorKey = 'annotation.actionFailed') => {
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
                errorKey
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

    const noteButton = document.createElementNS(XHTML_NAMESPACE, 'button');
    noteButton.className = 'mktero-annotation-note-button';
    noteButton.type = 'button';
    noteButton.dataset.action = 'add-note';
    noteButton.setAttribute('aria-label', translate('annotation.addNote'));
    noteButton.setAttribute('title', translate('annotation.addNote'));
    noteButton.appendChild(createLucideIcon(
        document,
        LUCIDE_ICONS.messageSquarePlus,
        { className: 'mktero-annotation-note-action-icon', size: 16 }
    ));
    noteButton.addEventListener('click', openNote);
    content.appendChild(noteButton);

    if (typeof viewInPDF === 'function') {
        const sourceButton = document.createElementNS(XHTML_NAMESPACE, 'button');
        sourceButton.className = 'mktero-annotation-source-button';
        sourceButton.type = 'button';
        sourceButton.dataset.action = 'view-in-pdf';
        sourceButton.setAttribute(
            'aria-label',
            translate('annotation.openInPDF')
        );
        sourceButton.setAttribute('title', translate('annotation.openInPDF'));
        sourceButton.appendChild(createLucideIcon(
            document,
            LUCIDE_ICONS.externalLink,
            { className: 'mktero-source-action-icon', size: 16 }
        ));
        sourceButton.addEventListener('click', () => run(
            viewInPDF,
            'source.navigationFailed'
        ));
        controls.push(sourceButton);
        content.appendChild(sourceButton);
    }

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

function isFatalSelectionTranslationError(error) {
    if (error?.name === 'AbortError') return true;
    return SELECTION_TRANSLATION_ERROR_KEYS.has(error?.code);
}

function annotationErrorKey(error, fallbackKey) {
    return SELECTION_TRANSLATION_ERROR_KEYS.get(error?.code)
        || ANNOTATION_ERROR_KEYS.get(error?.code)
        || fallbackKey;
}

function annotationErrorMessage(error, translate, fallbackKey) {
    return translate(annotationErrorKey(error, fallbackKey));
}
