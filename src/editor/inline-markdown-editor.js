import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { GFM } from '@lezer/markdown';
import {
    createEmptyAnnotationOverlay,
} from '../core/markdown-annotation-overlay.js';
import {
    resolveSourceMapSelectionLocation,
} from '../core/markdown-source-map.js';
import {
    findMarkdownPageMarkers,
    resolvePageMarkerSourceLocation,
} from '../core/markdown-page-markers.js';
import { createLocalization } from '../i18n/localization.js';
import { normalizeChromeRanges } from '../markdown/chrome-ranges.js';
import { createEvidenceSnippet } from '../markdown/markdown-evidence.js';
import { computeDocumentFigures } from '../markdown/markdown-analysis-cache.js';
import {
    createInlineRenderingExtension,
    pointerTouchesRect,
    refreshInlineRendering,
    selectedMarkdownAnnotation,
    selectionAnchor,
    setAnnotationOverlay,
    setChromeRanges,
    setDocumentTitle,
    setCorrectionRenderingState,
    setFigureHighlight,
    setFigureViews,
    setInlineEditingRange,
    setPendingFigures,
    setRestoredFigures,
    setReferenceHighlight,
    setTableHighlight,
    setTranslationRanges,
    setTranslationFailures,
    setTranslationPairs,
    setTranslationPairHighlight,
} from './inline-rendering.js';
import { createImagePreview } from './image-preview.js';
import { createCitationPopup } from './citation-popup.js';
import { rootSelectionFor } from './root-selection.js';
import { createAnnotationPopup } from './annotation-popup.js';
import {
    COPY_FAILED,
    createCopyDelivery,
} from './copy-delivery.js';
import {
    isCorrectionInteractionTarget,
    isEditableTextCorrectionBlock,
} from './correction-interactions.js';
import { createFigurePreviewPopup } from './figure-preview-popup.js';
import { createTablePreviewPopup } from './table-preview-popup.js';
import {
    createDocumentSearchHighlightExtension,
    setDocumentSearchHighlight,
} from './document-search-highlight.js';
import {
    createSelectionFlashExtension,
    setRetainedSelection,
    setSelectionFlash,
} from './selection-flash.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const editorNavigationMeasureKey = {};
// One stable identity for "no ranges", so the rendering field can skip a
// rebuild when a model update carries nothing new.
const NO_EDITOR_RANGES = Object.freeze([]);
const DOM_GLOBAL_NAMES = [
    'document',
    'window',
    'Window',
    'getComputedStyle',
    'IntersectionObserver',
    'MutationObserver',
    'ResizeObserver',
];
const DOM_ACTIVATION_EVENTS = [
    'beforeinput',
    'click',
    'compositionend',
    'compositionstart',
    'compositionupdate',
    'copy',
    'cut',
    'dragstart',
    'drop',
    'focusin',
    'input',
    'keydown',
    'keyup',
    'mousedown',
    'paste',
    'pointerdown',
    'scroll',
    'wheel',
];
let activeDOMWindow = null;
const domWindowReferences = new Map();
let previousDOMGlobals = null;

const NAVIGATION_HISTORY_LIMIT = 50;
// A jump that lands within this distance of the previous entry is the same
// place to the reader, so it must not add a second back step.
const NAVIGATION_SAME_POSITION_PX = 24;
// Ctrl/Cmd+C reaches the copy event in the same task on Windows and macOS.
// The wait only has to outlast that, not a slow machine's paint.
const COPY_SHORTCUT_GRACE_MS = 200;
// The fallback copy below asks CodeMirror for the text it would have copied.
// That dispatch is not a reader copy, so the verification ignores it.
let syntheticCopyDispatch = false;

function requestEditorScroll(view, position, requestedDocument, correctAfterRender = true) {
    view.requestMeasure({
        key: editorNavigationMeasureKey,
        read(editorView) {
            if (editorView.state.doc !== requestedDocument) return null;
            return {
                top: editorView.lineBlockAt(position).top,
                targetIsRendered: position >= editorView.viewport.from
                    && position <= editorView.viewport.to,
            };
        },
        write(measurement, editorView) {
            if (!measurement || editorView.state.doc !== requestedDocument) return;
            editorView.scrollDOM.scrollTop = Math.max(0, measurement.top);
            if (correctAfterRender && !measurement.targetIsRendered) {
                // Offscreen block-widget heights are estimates until this scroll renders them.
                requestEditorScroll(editorView, position, requestedDocument, false);
            }
        },
    });
}

export function createInlineMarkdownEditor({
    parent,
    initialMarkdown,
    resolveImageURL,
    resolveRestoredFigureURL,
    openLink,
    createMarkdownAnnotation,
    changeAnnotationColor,
    updateAnnotationComment,
    deleteAnnotation,
    copySourcedMarkdown,
    copyCode,
    deliverCopy,
    isCopyDeliveryActive,
    onCopyDeliveryFailed,
    onCopyDeliveryError,
    openSourceLocation,
    openAnnotationInPDF,
    onSourceNavigationError,
    onViewportChange,
    onNavigationBackChange,
    onNavigationForwardChange,
    onScrollProgress,
    onListReferenceLibraries,
    onGetReferenceStatus,
    onSearchReferenceMetadata,
    onImportReference,
    onOpenReferenceMatch,
    onSubscribeReferenceUpdates,
    sourceItemID,
    translateSelection,
    cancelSelectionTranslation,
    shouldAutoTranslateSelection,
    copySelectionTranslation,
    onCommitCorrection,
    onRestoreCorrection,
    onCorrectionError,
    onActiveCorrectionChange,
    localization = createLocalization(),
    analysisCache = null,
}) {
    const t = localization.t.bind(localization);
    if (!parent) throw new Error(t('error.editorParentRequired'));
    const ownerWindow = parent.ownerDocument?.defaultView;
    if (!ownerWindow) throw new Error(t('error.editorWindowRequired'));
    acquireDOMGlobals(ownerWindow);
    let view;
    const clearRetainedSelectionHighlight = () => {
        view?.dispatch({ effects: setRetainedSelection.of(null) });
    };
    const imagePreview = createImagePreview(parent, { localization });
    const citationPopup = createCitationPopup(parent, { localization });
    const annotationPopup = createAnnotationPopup(parent, {
        localization,
        createMarkdownAnnotation: typeof createMarkdownAnnotation === 'function'
            ? async (annotation, selectionContext) => {
                const saved = await createMarkdownAnnotation(
                    annotation,
                    withoutSelectionTranslationContext(selectionContext)
                );
                ownerWindow.getSelection?.()?.removeAllRanges?.();
                return saved;
            }
            : undefined,
        changeAnnotationColor,
        updateAnnotationComment,
        deleteAnnotation,
        copySourcedMarkdown,
        translateSelection: typeof translateSelection === 'function'
            ? (text, selectionContext, options) => translateSelection(
                text,
                selectionContext,
                options,
            )
            : undefined,
        cancelSelectionTranslation,
        shouldAutoTranslateSelection,
        copySelectionTranslation,
        openSourceLocation,
        openAnnotationInPDF,
        onNoteEditorClose: clearRetainedSelectionHighlight,
        onSourceNavigationError,
    });
    const tablePreviewPopup = createTablePreviewPopup(parent, {
        resolveImageURL,
        localization,
    });
    const figurePreviewPopup = createFigurePreviewPopup(parent, {
        resolveImageURL,
        localization,
        openSourceLocation,
        onSourceNavigationError,
    });
    let destroyed = false;
    const citationHighlight = createTimedTargetHighlight({
        ownerWindow,
        effect: setReferenceHighlight,
        isDestroyed: () => destroyed,
    });
    const tableHighlight = createTimedTargetHighlight({
        ownerWindow,
        effect: setTableHighlight,
        isDestroyed: () => destroyed,
    });
    const figureHighlight = createTimedTargetHighlight({
        ownerWindow,
        effect: setFigureHighlight,
        isDestroyed: () => destroyed,
    });
    const referenceFeatures = {
        citation: {
            popup: citationPopup,
            highlight: citationHighlight,
            effect: setReferenceHighlight,
        },
        table: {
            popup: tablePreviewPopup,
            highlight: tableHighlight,
            effect: setTableHighlight,
        },
        figure: {
            popup: figurePreviewPopup,
            highlight: figureHighlight,
            effect: setFigureHighlight,
        },
    };
    const referenceFeatureList = Object.values(referenceFeatures);
    const interactionPopups = [
        annotationPopup,
        imagePreview,
        ...referenceFeatureList.map(feature => feature.popup),
    ];
    const editingMode = new Compartment();
    let correctionManagementEnabled = false;
    let correctionBlocks = [];
    let correctedBlockIDs = [];
    let correctionAnnotationRanges = [];
    let activeCorrection = null;
    let pendingCorrectionViewportCenterOffset = null;
    let correctionBusy = false;
    let tableCorrectionEditing = false;
    let activeTableCorrection = null;
    let correctionToolbar;
    let stalledViewportRepairFrame = null;
    let correctionViewportFallbackEnabled = false;
    let translationHighlightTimer = null;
    let selectionFlashTimer = null;
    let navigationBackStack = [];
    let navigationForwardStack = [];
    let navigationBackAvailable = false;
    let navigationForwardAvailable = false;
    const syncNavigationAvailability = () => {
        const back = navigationBackStack.length > 0;
        const forward = navigationForwardStack.length > 0;
        if (back !== navigationBackAvailable) {
            navigationBackAvailable = back;
            onNavigationBackChange?.(back);
        }
        if (forward !== navigationForwardAvailable) {
            navigationForwardAvailable = forward;
            onNavigationForwardChange?.(forward);
        }
    };
    const clearNavigationHistory = () => {
        navigationBackStack = [];
        navigationForwardStack = [];
        syncNavigationAvailability();
    };
    const currentNavigationPoint = editorView => {
        const scrollTop = Number(editorView.scrollDOM?.scrollTop);
        return Number.isFinite(scrollTop)
            ? { document: editorView.state.doc, scrollTop: Math.max(0, scrollTop) }
            : null;
    };
    const pushNavigationPoint = (stack, point) => {
        const last = stack.at(-1);
        if (last
            && last.document === point.document
            && Math.abs(last.scrollTop - point.scrollTop)
                < NAVIGATION_SAME_POSITION_PX) {
            return;
        }
        stack.push(point);
        if (stack.length > NAVIGATION_HISTORY_LIMIT) stack.shift();
    };
    // Call this before any jump that moves the reader away from where it is
    // reading, so the way back is the position the jump started from.
    const recordNavigationPoint = () => {
        if (!view) return false;
        const point = currentNavigationPoint(view);
        if (!point) return false;
        pushNavigationPoint(navigationBackStack, point);
        navigationForwardStack = [];
        syncNavigationAvailability();
        return true;
    };
    const stepNavigation = (source, target) => {
        const point = source.pop();
        if (!point) {
            syncNavigationAvailability();
            return false;
        }
        if (!view || point.document !== view.state.doc) {
            clearNavigationHistory();
            return false;
        }
        const here = currentNavigationPoint(view);
        if (here) pushNavigationPoint(target, here);
        syncNavigationAvailability();
        activateDOMGlobals(ownerWindow);
        view.focus();
        view.scrollDOM.scrollTop = point.scrollTop;
        view.requestMeasure();
        return true;
    };
    const goNavigationBack = () => stepNavigation(
        navigationBackStack,
        navigationForwardStack
    );
    const goNavigationForward = () => stepNavigation(
        navigationForwardStack,
        navigationBackStack
    );
    const activateCitation = (editorView, target) => {
        recordNavigationPoint();
        referenceFeatures.citation.highlight.activate(editorView, target);
    };
    const activateTableReference = (editorView, target) => {
        recordNavigationPoint();
        referenceFeatures.table.highlight.activate(editorView, target);
    };
    const activateFigureReference = (editorView, target) => {
        recordNavigationPoint();
        referenceFeatures.figure.highlight.activate(editorView, target);
    };
    let scrollProgressFrame = null;
    let lastScrollProgress;
    const reportScrollProgress = () => {
        scrollProgressFrame = null;
        if (destroyed || !view || typeof onScrollProgress !== 'function') return;
        const scroller = view.scrollDOM;
        const range = Number(scroller?.scrollHeight)
            - Number(scroller?.clientHeight);
        const progress = range > 1
            ? Math.min(1, Math.max(0, Number(scroller.scrollTop) / range))
            : null;
        if (progress === lastScrollProgress) return;
        lastScrollProgress = progress;
        onScrollProgress(progress);
    };
    const scheduleScrollProgress = () => {
        if (typeof onScrollProgress !== 'function'
            || scrollProgressFrame !== null) {
            return;
        }
        if (typeof ownerWindow.requestAnimationFrame !== 'function') {
            reportScrollProgress();
            return;
        }
        scrollProgressFrame = ownerWindow.requestAnimationFrame(
            reportScrollProgress
        );
    };
    const cancelStalledViewportRepair = () => {
        if (stalledViewportRepairFrame === null) return;
        ownerWindow.cancelAnimationFrame?.(stalledViewportRepairFrame);
        stalledViewportRepairFrame = null;
    };
    const deferStalledViewportRepair = (scrollTop, centerOffset) => {
        cancelStalledViewportRepair();
        if (typeof ownerWindow.requestAnimationFrame !== 'function') return;
        stalledViewportRepairFrame = ownerWindow.requestAnimationFrame(() => {
            stalledViewportRepairFrame = null;
            if (destroyed) return;
            activateDOMGlobals(ownerWindow);
            try {
                view.dispatch({
                    effects: EditorView.scrollIntoView(
                        Math.max(
                            0,
                            Math.min(centerOffset, view.state.doc.length)
                        ),
                        { y: 'center' }
                    ),
                });
                view.measure();
            }
            catch {
                // Keep the rendered viewport when host geometry is unavailable.
            }
            finally {
                if (!destroyed) view.scrollDOM.scrollTop = scrollTop;
            }
        });
    };
    const repairViewport = centerOffset => repairStalledViewport(
        view,
        deferStalledViewportRepair,
        centerOffset,
        correctionViewportFallbackEnabled
    );
    const removeDOMActivation = installDOMActivation(
        parent,
        ownerWindow,
        event => {
            if (!view) return;
            if (interactionPopups.some(popup => popup.contains(event.target))) {
                return;
            }
            if (event.type === 'scroll' || event.type === 'wheel') {
                // An open note editor holds typed text and stays fixed in the
                // window, so scrolling the reader underneath it, or
                // CodeMirror restoring its scroll anchor after a refresh,
                // must not dismiss it.
                const keepNote = annotationPopup.isNoteOpen();
                for (const popup of interactionPopups) {
                    if (!(keepNote && popup === annotationPopup)) popup.close();
                }
            }
            const isEditorScroll = event.type === 'scroll'
                && event.target === view.scrollDOM;
            // An open correction already owns the caret. scrollIntoView plus
            // a synchronous measure here fights that caret on every scroll.
            const viewportRepaired = isEditorScroll
                && !activeCorrection
                && repairViewport();
            if (!activeCorrection) view.requestMeasure();
            if (isEditorScroll) {
                onViewportChange?.(editorViewportOffset(view));
            }
            if (isEditorScroll
                && !activeCorrection
                && !viewportRepaired
                && typeof ownerWindow.IntersectionObserver !== 'function') {
                view.measure();
            }
        }
    );

    try {
        const state = EditorState.create({
            doc: initialMarkdown || '',
            extensions: [
                markdown({ extensions: [GFM] }),
                createInlineRenderingExtension({
                    resolveImageURL,
                    resolveRestoredFigureURL,
                    openLink,
                    openImagePreview: imagePreview.open,
                    copyCode,
                    citationPopup,
                    sourceItemID,
                    onListReferenceLibraries,
                    onGetReferenceStatus,
                    onSearchReferenceMetadata,
                    onImportReference,
                    onOpenReferenceMatch,
                    onSubscribeReferenceUpdates,
                    tablePreviewPopup,
                    figurePreviewPopup,
                    annotationPopup,
                    openPageMarker: offset => (
                        openPageMarkerSourceLocation(offset)
                    ),
                    activateCitation,
                    activateTableReference,
                    activateFigureReference,
                    commitCorrection: correction => (
                        onCommitCorrection?.(correction)
                    ),
                    restoreCorrection: blockID => (
                        onRestoreCorrection?.(blockID)
                    ),
                    onCorrectionError,
                    onCorrectionEditingChange(editing) {
                        const state = typeof editing === 'object'
                            ? editing
                            : { editing: Boolean(editing) };
                        if (!state.editing) {
                            if (activeTableCorrection?.cancel
                                && state.cancel
                                && activeTableCorrection.cancel
                                    !== state.cancel) {
                                return;
                            }
                            activeTableCorrection = null;
                            tableCorrectionEditing = false;
                            if (!activeCorrection) correctionToolbar?.hide();
                            return;
                        }
                        if (activeCorrection) {
                            state.cancel?.();
                            return;
                        }
                        if (activeTableCorrection
                            && activeTableCorrection.cancel !== state.cancel
                            && activeTableCorrection.cancel?.() === false) {
                            state.cancel?.();
                            return;
                        }
                        activeTableCorrection = state;
                        tableCorrectionEditing = true;
                        annotationPopup.close();
                        if (typeof state.save !== 'function'
                            && typeof state.cancel !== 'function') {
                            return;
                        }
                        correctionToolbar?.show('table', {
                            onSave: state.save,
                            onCancel: state.cancel,
                            onDelete: null,
                        });
                        correctionToolbar?.setDirty(Boolean(state.dirty));
                        correctionToolbar?.setBusy(Boolean(state.busy));
                        correctionToolbar?.setError(
                            correctionErrorMessage(state.error, t)
                        );
                    },
                    translate: t,
                    analysisCache,
                }),
                editingMode.of([
                    EditorView.editable.of(false),
                    EditorState.readOnly.of(true),
                ]),
                // A read-only surface is not contenteditable. Without a tab
                // stop, Firefox neither focuses it on click nor honors
                // view.focus(), so the reader's own keys never arrive.
                EditorView.contentAttributes.of({ tabindex: '0' }),
                EditorState.transactionFilter.of(transaction => {
                    if (!transaction.docChanged || !activeCorrection) {
                        return transaction;
                    }
                    let allowed = true;
                    let annotationProtected = false;
                    transaction.changes.iterChangedRanges((from, to) => {
                        const protectedRange = activeCorrection.protectedRanges
                            .find(range => changeTouchesProtectedRange(
                                from,
                                to,
                                range
                            ));
                        if (from < activeCorrection.from
                            || to > activeCorrection.to
                            || protectedRange) {
                            allowed = false;
                            if (protectedRange?.kind === 'annotation') {
                                annotationProtected = true;
                            }
                        }
                    });
                    if (!allowed && annotationProtected) {
                        correctionToolbar?.setError(
                            t('revision.annotationProtected')
                        );
                    }
                    return allowed ? transaction : [];
                }),
                history(),
                Prec.highest(EditorView.domEventHandlers({
                    keydown(event) {
                        if (!activeCorrection
                            && !tableCorrectionEditing
                            && !event.isComposing) {
                            const moved = navigationBackAvailable
                                && isNavigationBackShortcut(event)
                                ? goNavigationBack()
                                : navigationForwardAvailable
                                    && isNavigationForwardShortcut(event)
                                    && goNavigationForward();
                            if (moved) {
                                event.preventDefault();
                                event.stopPropagation();
                                return true;
                            }
                        }
                        if (!activeCorrection
                            && !tableCorrectionEditing
                            && !event.isComposing
                            && !isCorrectionInteractionTarget(event.target)
                            && ['Enter', 'F2'].includes(event.key)) {
                            const position = view.state.selection.main.head;
                            const block = correctionBlocks.find(candidate => (
                                isEditableTextCorrectionBlock(candidate)
                                && position >= candidate.from
                                && position <= candidate.to
                            ));
                            if (!block || !beginActiveCorrection(block, position)) {
                                return false;
                            }
                            event.preventDefault();
                            event.stopPropagation();
                            return true;
                        }
                        if (!activeCorrection) return false;
                        if (event.isComposing || view.composing) {
                            if (event.key === 'Enter'
                                && (event.metaKey || event.ctrlKey)) {
                                event.stopPropagation();
                            }
                            return false;
                        }
                        if (event.key === 'Escape') {
                            event.preventDefault();
                            event.stopPropagation();
                            cancelActiveCorrection();
                            return true;
                        }
                        if (event.key === 'Enter'
                            && (event.metaKey || event.ctrlKey)) {
                            event.preventDefault();
                            event.stopPropagation();
                            void commitActiveCorrection();
                            return true;
                        }
                        return false;
                    },
                })),
                keymap.of([
                    ...defaultKeymap,
                    ...historyKeymap,
                ]),
                createDocumentSearchHighlightExtension(),
                createSelectionFlashExtension(),
                EditorView.lineWrapping,
                EditorView.updateListener.of(update => {
                    if (update.docChanged
                        || update.geometryChanged
                        || update.viewportChanged) {
                        scheduleScrollProgress();
                    }
                    const correctingDocument = update.docChanged
                        && activeCorrection;
                    if (!correctingDocument
                        && (update.viewportChanged
                            || update.geometryChanged
                            || update.docChanged)) {
                        onViewportChange?.(editorViewportOffset(update.view));
                    }
                    if (update.docChanged && activeCorrection) {
                        activeCorrection = {
                            ...activeCorrection,
                            viewportCenterOffset: update.changes.mapPos(
                                activeCorrection.viewportCenterOffset,
                                -1
                            ),
                            from: update.changes.mapPos(
                                activeCorrection.from,
                                -1
                            ),
                            to: update.changes.mapPos(activeCorrection.to, 1),
                            protectedRanges:
                                activeCorrection.protectedRanges.map(range => ({
                                    ...range,
                                    from: update.changes.mapPos(range.from, 1),
                                    to: update.changes.mapPos(range.to, -1),
                                })),
                            annotationRanges:
                                activeCorrection.annotationRanges.map(range => ({
                                    ...range,
                                    from: update.changes.mapPos(range.from, 1),
                                    to: update.changes.mapPos(range.to, -1),
                                })),
                        };
                        const dirty = update.view.state.sliceDoc(
                            activeCorrection.from,
                            activeCorrection.to
                        ) !== activeCorrection.originalMarkdown;
                        activeCorrection = { ...activeCorrection, dirty };
                        correctionToolbar?.setDirty(dirty);
                        correctionToolbar?.setError('');
                    }
                }),
            ],
        });
        const root = parent.getRootNode?.();
        view = new EditorView({
            state,
            parent,
            root: root?.nodeType === 9 || root?.nodeType === 11 ? root : undefined,
        });
        view.scrollDOM.addEventListener('scroll', scheduleScrollProgress, {
            passive: true,
        });
        scheduleScrollProgress();
    }
    catch (error) {
        for (const feature of referenceFeatureList) feature.popup.destroy();
        annotationPopup.destroy();
        imagePreview.destroy();
        removeDOMActivation();
        releaseDOMGlobals(ownerWindow);
        throw error;
    }
    const setEditingEnabled = enabled => {
        view.dispatch({
            effects: editingMode.reconfigure([
                EditorView.editable.of(enabled),
                EditorState.readOnly.of(!enabled),
            ]),
        });
    };
    const beginActiveCorrection = (block, position) => {
        if (correctionBusy
            || tableCorrectionEditing
            || !isEditableTextCorrectionBlock(block)
            || typeof onCommitCorrection !== 'function') {
            return false;
        }
        if (activeCorrection?.blockID === block.id) return true;
        if (activeCorrection) return false;
        const protectedRanges = normalizeProtectedCorrectionRanges(
            block.protectedRanges,
            block
        );
        activeCorrection = {
            blockID: block.id,
            viewportCenterOffset: block.from,
            from: block.from,
            to: block.to,
            originalMarkdown: view.state.sliceDoc(block.from, block.to),
            protectedRanges,
            annotationRanges: correctionAnnotationRanges.map(range => ({
                ...range,
            })),
            dirty: false,
        };
        annotationPopup.close();
        correctionToolbar?.show(block.type, protectedRanges.length
            ? { onDelete: null }
            : {});
        view.dispatch({
            selection: {
                anchor: Math.max(
                    block.from,
                    Math.min(position, block.to)
                ),
            },
            effects: [
                editingMode.reconfigure([
                    EditorView.editable.of(true),
                    EditorState.readOnly.of(false),
                ]),
                setInlineEditingRange.of({
                    from: block.from,
                    to: block.to,
                }),
            ],
        });
        onActiveCorrectionChange?.(true);
        view.focus();
        return true;
    };
    const endActiveCorrection = ({ revert = false } = {}) => {
        if (!activeCorrection) {
            setEditingEnabled(false);
            correctionToolbar?.hide();
            return;
        }
        const active = activeCorrection;
        activeCorrection = null;
        const changes = revert ? {
            from: active.from,
            to: active.to,
            insert: active.originalMarkdown,
        } : undefined;
        view.dispatch({
            ...(changes ? { changes } : {}),
            effects: [
                editingMode.reconfigure([
                    EditorView.editable.of(false),
                    EditorState.readOnly.of(true),
                ]),
                setInlineEditingRange.of(null),
            ],
        });
        correctionToolbar?.hide();
        onActiveCorrectionChange?.(false);
    };
    const cancelActiveCorrection = ({ force = false } = {}) => {
        if (correctionBusy && !force) return false;
        endActiveCorrection({ revert: true });
        return true;
    };
    const activeCorrectionPayload = active => ({
        blockID: active.blockID,
        replacementMarkdown: view.state.sliceDoc(active.from, active.to),
        ...(active.annotationRanges.length ? {
            annotationRanges: active.annotationRanges,
        } : {}),
    });
    const commitActiveCorrection = async () => {
        if (!activeCorrection || correctionBusy || !activeCorrection.dirty) {
            return false;
        }
        const active = activeCorrection;
        correctionBusy = true;
        correctionToolbar?.setBusy(true);
        try {
            await onCommitCorrection(activeCorrectionPayload(active));
            if (activeCorrection?.blockID === active.blockID) {
                endActiveCorrection();
            }
            return true;
        }
        catch (error) {
            if (activeCorrection?.blockID === active.blockID) {
                correctionToolbar?.setError(correctionErrorMessage(error, t));
            }
            onCorrectionError?.(error);
            return false;
        }
        finally {
            correctionBusy = false;
            correctionToolbar?.setBusy(false);
        }
    };
    const deleteActiveCorrection = () => {
        if (!activeCorrection || correctionBusy) return false;
        view.dispatch({
            changes: {
                from: activeCorrection.from,
                to: activeCorrection.to,
                insert: '',
            },
        });
        return commitActiveCorrection();
    };
    correctionToolbar = createBlockCorrectionToolbar({
        parent,
        translate: t,
        onSave: () => { void commitActiveCorrection(); },
        onCancel: cancelActiveCorrection,
        onDelete: () => { void deleteActiveCorrection(); },
    });
    const startCorrectionFromDoubleClick = event => {
        if (event.button !== 0
            || tableCorrectionEditing
            || event.target?.closest?.('.cm-mktero-table')
            || correctionToolbar?.contains?.(event.target)
            || interactionPopups.some(popup => popup.contains(event.target))
            || isCorrectionInteractionTarget(event.target)) {
            return;
        }
        activateDOMGlobals(ownerWindow);
        const clickedLine = event.target?.closest?.('.cm-line');
        let linePosition = null;
        if (clickedLine) {
            try {
                linePosition = view.posAtDOM(clickedLine, 0);
            }
            catch {
                linePosition = null;
            }
        }
        let coordinatePosition = view.posAtCoords?.({
            x: event.clientX,
            y: event.clientY,
        });
        if (!Number.isSafeInteger(coordinatePosition)) {
            try {
                coordinatePosition = view.posAtDOM(event.target, 0);
            }
            catch {
                coordinatePosition = null;
            }
        }
        const blockAtPosition = position => correctionBlocks.find(candidate => (
            isEditableTextCorrectionBlock(candidate)
            && Number.isSafeInteger(position)
            && position >= candidate.from
            && position <= candidate.to
        ));
        const lineBlock = blockAtPosition(linePosition);
        const coordinateBlock = blockAtPosition(coordinatePosition);
        const block = lineBlock || coordinateBlock;
        if (lineBlock && coordinateBlock !== lineBlock) {
            coordinatePosition = linePosition;
        }
        const position = Number.isSafeInteger(coordinatePosition)
            ? coordinatePosition
            : linePosition;
        if (!block || !beginActiveCorrection(block, position)) return;
        event.preventDefault();
        event.stopPropagation();
    };
    parent.addEventListener(
        'dblclick',
        startCorrectionFromDoubleClick,
        true
    );
    const openSelectedMarkdownActions = event => {
        if (event.button !== 0) return;
        if (activeCorrection || tableCorrectionEditing) return;
        if (interactionPopups.some(popup => popup.contains(event.target))) {
            return;
        }
        activateDOMGlobals(ownerWindow);
        const domSelection = rootSelectionFor(parent);
        clampSelectionFocusToPointerLine(view, domSelection, event);
        const selection = selectedMarkdownAnnotation(view, currentChromeRanges);
        if (!selection) return;
        if (markdownSelectionSide(
            domSelection,
            currentSourceActionRanges
        ) !== 'source' || !selectionSupportsSourceActions(
            selection,
            currentSourceActionRanges
        )) {
            openSelectionKey = null;
            annotationPopup.close();
            return;
        }
        const selectionKey = markdownSelectionKey(selection);
        if (annotationPopup.isSelectionOpen()
            && openSelectionKey === selectionKey) {
            return;
        }
        openSelectionKey = selectionKey;
        const copyTarget = { kind: 'selection', ...selection };
        const evidence = createSourcedEvidence(
            view.state.doc.toString(),
            currentSourceMap,
            copyTarget,
            currentFigureViews
        );
        for (const popup of interactionPopups) {
            if (popup !== annotationPopup) popup.close();
        }
        annotationPopup.openSelection({
            anchor: selectionAnchor(
                domSelection,
                event.target,
                event
            ),
            onOpenNote: () => retainSelectionHighlight(selection),
            selection,
            selectionContext: {
                side: 'source',
            },
            copyTarget,
            sourceLocation: selectionSourceLocation(
                currentSourceMap,
                copyTarget,
                view.state.doc.length
            ),
            canCopySource: Boolean(evidence),
        });
    };
    const retainSelectionHighlight = selection => {
        const range = selection?.ranges?.[0];
        if (!range) return;
        view.dispatch({
            effects: setRetainedSelection.of({
                from: range.from,
                to: range.to,
            }),
        });
    };
    const closeSelectionActions = event => {
        const targetsPopup = annotationPopup.contains(event.target)
            || event.composedPath?.().some(target => (
                target?.nodeType && annotationPopup.contains(target)
            ));
        if (event.button === 0 && !targetsPopup) {
            annotationPopup.close({ saveNote: true });
        }
    };
    const interactionRoot = parent.getRootNode?.() || ownerWindow.document;
    const closeSelectionActionsOutsideRoot = event => {
        if (event.button !== 0) return;
        const eventPath = event.composedPath?.() || [];
        if (eventPath.includes(interactionRoot)
            || event.target === interactionRoot.host) {
            return;
        }
        annotationPopup.close({ saveNote: true });
    };
    interactionRoot.addEventListener(
        'mousedown',
        closeSelectionActions,
        true
    );
    if (interactionRoot !== ownerWindow.document) {
        ownerWindow.document.addEventListener(
            'mousedown',
            closeSelectionActionsOutsideRoot,
            true
        );
    }
    const closeSelectionActionsOnEscape = event => {
        if (event.key !== 'Escape' || !annotationPopup.isSelectionOpen()) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        annotationPopup.close();
    };
    ownerWindow.document.addEventListener(
        'keydown',
        closeSelectionActionsOnEscape,
        true
    );
    parent.addEventListener('mouseup', openSelectedMarkdownActions, true);
    const copyDelivery = typeof deliverCopy === 'function'
        && typeof ownerWindow.setTimeout === 'function'
        ? createCopyDelivery({
            readText: () => deliverCopy({ action: 'read' }),
            writeText: text => deliverCopy({ action: 'write', text }),
            setTimeout: ownerWindow.setTimeout?.bind(ownerWindow),
            clearTimeout: ownerWindow.clearTimeout?.bind(ownerWindow),
            // A view without the hook (the browser preview) never stops a
            // delivery for focus; only an explicit false does.
            isActive: () => !destroyed
                && isCopyDeliveryActive?.() !== false,
        })
        : null;
    let copyShortcutWatch = null;
    const clearCopyShortcutWatch = () => {
        if (!copyShortcutWatch) return;
        const { timer } = copyShortcutWatch;
        copyShortcutWatch = null;
        try {
            ownerWindow.clearTimeout?.(timer);
        }
        catch {
            // An unloading window's timers can throw; the watch is already
            // dropped, so a late timer does nothing.
        }
    };
    const deliverReaderCopy = request => {
        if (!copyDelivery || !request) return;
        copyDelivery.deliver(request)
            .then(result => {
                if (result === COPY_FAILED && !destroyed) {
                    onCopyDeliveryFailed?.();
                }
            })
            .catch(error => onCopyDeliveryError?.(error));
    };
    // Bubble phase, so CodeMirror and the note editor have already put their
    // text on the event. Firefox writes the system clipboard once the event
    // returns; the delivery reads it back afterwards. Nothing here changes
    // what a copy puts on the clipboard.
    const verifyReaderCopy = event => {
        if (destroyed || syntheticCopyDispatch) return;
        if (copyShortcutWatch) copyShortcutWatch.observed = true;
        if (!copyDelivery) return;
        deliverReaderCopy(readerCopyRequest(event, view, parent));
    };
    parent.addEventListener('copy', verifyReaderCopy);
    // Ctrl/Cmd+C normally ends in a copy event above. When it does not, for
    // example because keyboard focus is in another frame while the reader's
    // selection is still visible, the reader's own selection is copied the
    // same way CodeMirror would copy it.
    const watchCopyShortcut = () => {
        if (destroyed || !copyDelivery) return;
        if (activeCorrection || tableCorrectionEditing) return;
        if (!readerSelectionText(rootSelectionFor(parent), view)) return;
        clearCopyShortcutWatch();
        const watch = { observed: false, timer: null };
        watch.timer = ownerWindow.setTimeout?.(() => {
            if (copyShortcutWatch !== watch) return;
            copyShortcutWatch = null;
            if (watch.observed || destroyed) return;
            const request = fallbackReaderCopyRequest(view, parent);
            if (request) deliverReaderCopy({ ...request, writeFirst: true });
        }, COPY_SHORTCUT_GRACE_MS);
        copyShortcutWatch = watch;
    };
    const openPageMarkerSourceLocation = offset => {
        if (typeof openSourceLocation !== 'function') return;
        const markdown = view?.state?.doc?.toString?.() || '';
        const location = pageMarkerLocationAt(
            currentSourceMap,
            markdown,
            offset,
            markdown.length
        );
        if (!location) return;
        Promise.resolve(openSourceLocation(location)).catch(error => {
            onSourceNavigationError?.(error);
        });
    };
    let currentSourceMap = [];
    let currentFigureViews = [];
    let currentPendingFigures = null;
    let currentRestoredFigures = new Map();
    let currentChromeRanges = [];
    let currentChromeRangesSource = null;
    let currentChromeRangesLength = -1;
    let currentSourceActionRanges = null;
    // Reused so that "no overlay" keeps one identity and the rendering field
    // can skip the rebuild it would otherwise trigger on every model update.
    let sharedEmptyAnnotationOverlay = null;
    const emptyAnnotationOverlay = () => {
        if (!sharedEmptyAnnotationOverlay) {
            sharedEmptyAnnotationOverlay = createEmptyAnnotationOverlay();
        }
        return sharedEmptyAnnotationOverlay;
    };
    let openSelectionKey = null;
    const setDocument = ({
        markdown,
        annotationOverlay,
        sourceMap,
        figureMap = null,
        figureViews = null,
        pendingFigures = null,
        chromeRanges,
        documentTitle = '',
        sourceActionRanges,
        translationRanges,
        translationFailures,
        translationPairs,
    }) => {
        activateDOMGlobals(ownerWindow);
        if (translationHighlightTimer !== null) {
            ownerWindow.clearTimeout?.(translationHighlightTimer);
            translationHighlightTimer = null;
        }
        const value = String(markdown || '');
        const documentChanged = value !== view.state.doc.toString();
        const viewportCenterOffset = Number.isSafeInteger(
            activeCorrection?.viewportCenterOffset
        )
            ? activeCorrection.viewportCenterOffset
            : editorViewportCenterOffset(view);
        pendingCorrectionViewportCenterOffset = viewportCenterOffset;
        if (activeCorrection) correctionViewportFallbackEnabled = true;
        if (documentChanged) {
            clearNavigationHistory();
        }
        activeTableCorrection?.cancel?.({
            focus: false,
            force: true,
        });
        activeCorrection = null;
        correctionBusy = false;
        correctionToolbar?.setBusy(false);
        correctionToolbar?.hide();
        tableCorrectionEditing = false;
        activeTableCorrection = null;
        for (const feature of referenceFeatureList) {
            feature.popup.close();
            feature.highlight.cancel();
        }
        // Annotation syncs republish the same Markdown while the reader may be
        // typing a note. Keep that editor and its draft; save it before a
        // different document replaces the text it quotes.
        if (documentChanged) annotationPopup.close({ saveNote: true });
        else if (!annotationPopup.isNoteOpen()) annotationPopup.close();
        currentSourceMap = Array.isArray(sourceMap) ? sourceMap : [];
        currentFigureViews = figureViews
            || computeDocumentFigures(analysisCache, value, { figureMap });
        const chromeRangesSource = Array.isArray(chromeRanges)
            ? chromeRanges
            : null;
        if (chromeRangesSource !== currentChromeRangesSource
            || value.length !== currentChromeRangesLength) {
            currentChromeRangesSource = chromeRangesSource;
            currentChromeRangesLength = value.length;
            currentChromeRanges = normalizeChromeRanges(
                chromeRangesSource,
                value.length
            );
        }
        currentSourceActionRanges = Array.isArray(sourceActionRanges)
            ? normalizeSourceActionRanges(sourceActionRanges, value.length)
            : null;
        const nextPendingFigures = pendingFigures instanceof Map
            ? pendingFigures
            : null;
        // Figure ids are positional and the next conversion reuses them.
        // An annotation refresh passes the same pending Map and does not
        // replay finished crops, so drop those crops only when that Map is
        // replaced or cleared.
        const pendingFiguresReplaced = nextPendingFigures !== currentPendingFigures;
        if (pendingFiguresReplaced) {
            currentPendingFigures = nextPendingFigures;
            currentRestoredFigures = new Map();
        }
        const effects = [
            ...referenceFeatureList.map(feature => feature.effect.of(null)),
            setAnnotationOverlay.of(
                annotationOverlay || emptyAnnotationOverlay()
            ),
            setChromeRanges.of(currentChromeRanges),
            setDocumentTitle.of(documentTitle),
            setFigureViews.of(currentFigureViews),
            setPendingFigures.of(nextPendingFigures),
            ...(pendingFiguresReplaced
                ? [setRestoredFigures.of(currentRestoredFigures)]
                : []),
            setTranslationRanges.of(translationRanges || NO_EDITOR_RANGES),
            setTranslationFailures.of(translationFailures || NO_EDITOR_RANGES),
            setTranslationPairs.of(translationPairs || NO_EDITOR_RANGES),
            setTranslationPairHighlight.of(null),
            setDocumentSearchHighlight.of({
                matches: [],
                activeIndex: -1,
            }),
            setInlineEditingRange.of(null),
            editingMode.reconfigure([
                EditorView.editable.of(false),
                EditorState.readOnly.of(true),
            ]),
        ];
        if (value === view.state.doc.toString()) {
            view.dispatch({ effects });
            return;
        }
        // Mapping a selection through a whole-document replacement would
        // select the entire new text, as when switching to a translation
        // mid-selection. A selection inside text both versions start with
        // (a streamed translation growing at the end) keeps its offsets;
        // any other collapses to the start.
        const current = view.state.doc.toString();
        const shared = sharedPrefixLength(current, value);
        const keep = view.state.selection.ranges.every(range => range.to <= shared);
        view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: value },
            selection: keep ? view.state.selection : { anchor: 0 },
            effects,
        });
    };
    return {
        getMarkdown() {
            return view.state.doc.toString();
        },
        // Called by the view when Ctrl/Cmd+C is pressed outside a text field.
        watchCopyShortcut,
        // Another copy replaced the clipboard; an older delivery must not
        // write over it. A pending Ctrl/Cmd+C watch stays: if the chord's
        // copy landed outside the reader, the reader's selection is still
        // what the reader asked to copy.
        cancelCopyDelivery() {
            copyDelivery?.cancel();
        },
        hasActiveCorrection() {
            return Boolean(activeCorrection);
        },
        // A closing tab cannot be vetoed, so its owner saves this draft
        // before destroy() cancels the open block or table cell.
        getPendingCorrection() {
            if (destroyed) return null;
            if (activeCorrection) {
                return activeCorrection.dirty
                    ? activeCorrectionPayload(activeCorrection)
                    : null;
            }
            return activeTableCorrection?.pendingCorrection?.() || null;
        },
        setDocument,
        showRestoredFigure(figure) {
            if (destroyed || !figure || figure.id == null) return;
            activateDOMGlobals(ownerWindow);
            const next = new Map(currentRestoredFigures);
            next.set(figure.id, figure);
            currentRestoredFigures = next;
            view.dispatch({
                effects: setRestoredFigures.of(next),
            });
        },
        setMarkdown(markdown) {
            setDocument({
                markdown,
                annotationOverlay: createEmptyAnnotationOverlay(),
            });
        },
        setCorrectionState({
            enabled = false,
            blocks = [],
            correctedBlockIDs: corrected = [],
            annotationRanges = [],
        } = {}) {
            activateDOMGlobals(ownerWindow);
            const viewportCenterOffset = Number.isSafeInteger(
                pendingCorrectionViewportCenterOffset
            )
                ? pendingCorrectionViewportCenterOffset
                : editorViewportCenterOffset(view);
            pendingCorrectionViewportCenterOffset = null;
            const nextManagementEnabled = Boolean(enabled);
            if (!nextManagementEnabled) {
                correctionViewportFallbackEnabled = false;
            }
            const nextCorrectionBlocks = Array.isArray(blocks) ? blocks : [];
            const activeBlockAvailable = !activeCorrection
                || nextCorrectionBlocks.some(block => (
                    block?.id === activeCorrection.blockID
                ));
            if (activeCorrection
                && ((!nextManagementEnabled && correctionManagementEnabled)
                    || !activeBlockAvailable)) {
                cancelActiveCorrection();
            }
            correctionManagementEnabled = nextManagementEnabled;
            correctionBlocks = nextCorrectionBlocks;
            correctedBlockIDs = Array.isArray(corrected) ? corrected : [];
            correctionAnnotationRanges = normalizeCorrectionAnnotationRanges(
                annotationRanges,
                view.state.doc.length
            );
            view.dispatch({
                effects: setCorrectionRenderingState.of({
                    enabled: correctionManagementEnabled,
                    blocks: correctionBlocks,
                    correctedBlockIDs,
                }),
            });
            repairViewport(viewportCenterOffset);
        },
        focus() {
            activateDOMGlobals(ownerWindow);
            view.focus();
        },
        scrollToOffset(offset) {
            activateDOMGlobals(ownerWindow);
            const requested = Number(offset);
            const position = Number.isFinite(requested)
                ? Math.max(0, Math.min(Math.trunc(requested), view.state.doc.length))
                : 0;
            const requestedDocument = view.state.doc;
            requestEditorScroll(view, position, requestedDocument);
        },
        setDocumentSearchHighlights(value = {}) {
            activateDOMGlobals(ownerWindow);
            view.dispatch({
                effects: setDocumentSearchHighlight.of({
                    matches: Array.isArray(value.matches) ? value.matches : [],
                    activeIndex: Number.isSafeInteger(value.activeIndex)
                        ? value.activeIndex
                        : -1,
                }),
            });
        },
        recordNavigationPoint,
        goNavigationBack,
        goNavigationForward,
        flashRange(from, to) {
            activateDOMGlobals(ownerWindow);
            if (selectionFlashTimer !== null) {
                ownerWindow.clearTimeout?.(selectionFlashTimer);
                selectionFlashTimer = null;
            }
            const length = view.state.doc.length;
            const start = Math.max(0, Math.trunc(Number(from) || 0));
            const end = Math.min(length, Math.trunc(Number(to) || 0));
            if (end <= start) return;
            view.dispatch({
                effects: setSelectionFlash.of({ from: start, to: end }),
            });
            if (typeof ownerWindow.setTimeout !== 'function') return;
            selectionFlashTimer = ownerWindow.setTimeout(() => {
                selectionFlashTimer = null;
                if (destroyed) return;
                view.dispatch({ effects: setSelectionFlash.of(null) });
            }, 1200);
        },
        highlightTranslationBlock(blockID) {
            activateDOMGlobals(ownerWindow);
            if (translationHighlightTimer !== null) {
                ownerWindow.clearTimeout?.(translationHighlightTimer);
                translationHighlightTimer = null;
            }
            view.dispatch({
                effects: setTranslationPairHighlight.of(String(blockID || '')),
            });
            if (typeof ownerWindow.setTimeout !== 'function') return;
            translationHighlightTimer = ownerWindow.setTimeout(() => {
                translationHighlightTimer = null;
                if (destroyed) return;
                view.dispatch({ effects: setTranslationPairHighlight.of(null) });
            }, 3000);
        },
        refreshRendering() {
            activateDOMGlobals(ownerWindow);
            view.dispatch({ effects: refreshInlineRendering.of(null) });
        },
        requestMeasure() {
            activateDOMGlobals(ownerWindow);
            view.requestMeasure();
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            if (selectionFlashTimer !== null) {
                ownerWindow.clearTimeout?.(selectionFlashTimer);
                selectionFlashTimer = null;
            }
            activateDOMGlobals(ownerWindow);
            try {
                for (const feature of referenceFeatureList) {
                    feature.highlight.cancel();
                    feature.popup.destroy();
                }
                navigationBackStack = [];
                navigationForwardStack = [];
                navigationBackAvailable = false;
                navigationForwardAvailable = false;
                if (scrollProgressFrame !== null) {
                    ownerWindow.cancelAnimationFrame?.(scrollProgressFrame);
                    scrollProgressFrame = null;
                }
                view.scrollDOM.removeEventListener(
                    'scroll',
                    scheduleScrollProgress
                );
                interactionRoot.removeEventListener(
                    'mousedown',
                    closeSelectionActions,
                    true
                );
                if (interactionRoot !== ownerWindow.document) {
                    ownerWindow.document.removeEventListener(
                        'mousedown',
                        closeSelectionActionsOutsideRoot,
                        true
                    );
                }
                ownerWindow.document.removeEventListener(
                    'keydown',
                    closeSelectionActionsOnEscape,
                    true
                );
                copyDelivery?.cancel();
                clearCopyShortcutWatch();
                parent.removeEventListener('copy', verifyReaderCopy);
                parent.removeEventListener(
                    'mouseup',
                    openSelectedMarkdownActions,
                    true
                );
                parent.removeEventListener(
                    'dblclick',
                    startCorrectionFromDoubleClick,
                    true
                );
                cancelStalledViewportRepair();
                if (translationHighlightTimer !== null) {
                    ownerWindow.clearTimeout?.(translationHighlightTimer);
                    translationHighlightTimer = null;
                }
                correctionToolbar?.destroy();
                annotationPopup.destroy();
                imagePreview.destroy();
                view.destroy();
            }
            finally {
                removeDOMActivation();
                releaseDOMGlobals(ownerWindow);
            }
        },
    };
}

function normalizeSourceActionRanges(ranges, documentLength) {
    return ranges.flatMap(range => (
        Number.isSafeInteger(range?.from)
        && Number.isSafeInteger(range?.to)
        && range.from >= 0
        && range.to > range.from
        && range.to <= documentLength
            ? [{ from: range.from, to: range.to }]
            : []
    ));
}

function selectionSupportsSourceActions(selection, sourceActionRanges) {
    if (sourceActionRanges === null) return true;
    if (!Array.isArray(selection?.ranges) || !selection.ranges.length) {
        return false;
    }
    return selection.ranges.every(range => (
        Number.isSafeInteger(range?.from)
        && Number.isSafeInteger(range?.to)
        && sourceActionRanges.some(sourceRange => (
            range.from >= sourceRange.from && range.to <= sourceRange.to
        ))
    ));
}

function markdownSelectionKey(selection) {
    const ranges = Array.isArray(selection?.ranges)
        ? selection.ranges
        : [];
    return [
        String(selection?.text || ''),
        ...ranges.map(range => `${range?.from}:${range?.to}`),
    ].join('|');
}

function withoutSelectionTranslationContext(selectionContext) {
    if (!selectionContext || typeof selectionContext !== 'object') {
        return selectionContext;
    }
    const { translationContext, ...annotationContext } = selectionContext;
    return annotationContext;
}

function markdownSelectionSide(selection, sourceActionRanges) {
    if (sourceActionRanges === null) return 'source';
    if (!selection || selection.rangeCount !== 1) return null;
    const range = selection.getRangeAt(0);
    const startSide = translationPairSide(range.startContainer);
    const endSide = translationPairSide(range.endContainer);
    return startSide === 'translated' || endSide === 'translated'
        ? 'translated'
        : 'source';
}

function translationPairSide(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    if (element?.closest?.('.cm-mktero-translation-pair-source')) {
        return 'source';
    }
    if (element?.closest?.('.cm-mktero-translation-pair-translated')) {
        return 'translated';
    }
    return null;
}

function normalizeProtectedCorrectionRanges(ranges, block) {
    if (!Array.isArray(ranges)) return [];
    const normalized = ranges.flatMap(range => (
        Number.isSafeInteger(range?.from)
        && Number.isSafeInteger(range?.to)
        && range.from >= block.from
        && range.to <= block.to
        && range.to > range.from
            ? [{
                from: range.from,
                to: range.to,
                ...(range.kind === 'annotation'
                    ? { kind: 'annotation' }
                    : {}),
            }]
            : []
    )).sort((left, right) => left.from - right.from || left.to - right.to);
    const result = [];
    for (const range of normalized) {
        const previous = result.at(-1);
        if (previous && range.from <= previous.to) {
            previous.to = Math.max(previous.to, range.to);
            if (range.kind === 'annotation') previous.kind = 'annotation';
        }
        else {
            result.push(range);
        }
    }
    return result;
}

function normalizeCorrectionAnnotationRanges(ranges, documentLength) {
    if (!Array.isArray(ranges)) return [];
    return ranges.flatMap(range => (
        String(range?.id || '')
        && Number.isSafeInteger(range?.rangeIndex)
        && range.rangeIndex >= 0
        && Number.isSafeInteger(range?.from)
        && Number.isSafeInteger(range?.to)
        && range.from >= 0
        && range.to > range.from
        && range.to <= documentLength
            ? [{
                id: String(range.id),
                source: String(range.source || ''),
                rangeIndex: range.rangeIndex,
                from: range.from,
                to: range.to,
            }]
            : []
    ));
}

function correctionErrorMessage(error, translate) {
    if (!error) return '';
    return error?.code === 'MARKDOWN_ANNOTATION_PROTECTED'
        ? translate('revision.annotationProtected')
        : translate('revision.saveFailed');
}

function changeTouchesProtectedRange(from, to, range) {
    if (from === to) return from > range.from && from < range.to;
    return from < range.to && to > range.from;
}

function createBlockCorrectionToolbar({
    parent,
    translate,
    onSave,
    onCancel,
    onDelete,
}) {
    const document = parent.ownerDocument;
    const toolbar = createHTMLNode(document, 'div');
    toolbar.className = 'mktero-correction-editor-toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute(
        'aria-label',
        translate('revision.editorActions')
    );
    toolbar.hidden = true;

    const deleteButton = createCorrectionToolbarButton(
        document,
        'mktero-correction-editor-delete'
    );
    const cancelButton = createCorrectionToolbarButton(
        document,
        'mktero-correction-editor-cancel',
        translate('revision.cancel')
    );
    const saveButton = createCorrectionToolbarButton(
        document,
        'mktero-correction-editor-save',
        translate('revision.saveChanges')
    );
    const status = createHTMLNode(document, 'span');
    status.className = 'mktero-correction-editor-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;
    toolbar.append(status, deleteButton, cancelButton, saveButton);

    let activeActions = { onSave, onCancel, onDelete };
    let busy = false;
    let dirty = false;
    let errorMessage = '';
    parent.append(toolbar);

    const listeners = [
        [deleteButton, 'onDelete'],
        [cancelButton, 'onCancel'],
        [saveButton, 'onSave'],
    ].map(([button, actionName]) => {
        const listener = event => {
            event.preventDefault();
            event.stopPropagation();
            activeActions[actionName]?.();
        };
        button.addEventListener('click', listener);
        return { button, listener };
    });

    const syncButtonState = () => {
        deleteButton.disabled = busy;
        cancelButton.disabled = busy;
        saveButton.disabled = busy || !dirty;
    };

    const syncStatus = () => {
        const message = errorMessage || (
            dirty ? translate('revision.unsavedChanges') : ''
        );
        status.textContent = message;
        status.hidden = !message;
    };

    return {
        show(blockType, actions = {}) {
            activeActions = {
                onSave,
                onCancel,
                onDelete,
                ...actions,
            };
            const key = blockType === 'heading'
                ? 'revision.deleteHeading'
                : 'revision.deleteParagraph';
            const label = translate(key);
            deleteButton.textContent = label;
            deleteButton.setAttribute('aria-label', label);
            deleteButton.setAttribute('title', label);
            deleteButton.hidden = blockType === 'table'
                || typeof activeActions.onDelete !== 'function';
            busy = false;
            dirty = false;
            this.setError('');
            syncButtonState();
            toolbar.hidden = false;
        },
        hide() {
            toolbar.hidden = true;
            errorMessage = '';
            status.hidden = true;
        },
        setBusy(nextBusy) {
            busy = Boolean(nextBusy);
            toolbar.setAttribute('aria-busy', String(busy));
            syncButtonState();
        },
        setDirty(nextDirty) {
            dirty = Boolean(nextDirty);
            syncButtonState();
            syncStatus();
        },
        setError(message) {
            errorMessage = message || '';
            syncStatus();
        },
        contains(target) {
            return toolbar.contains(target);
        },
        destroy() {
            for (const { button, listener } of listeners) {
                button.removeEventListener('click', listener);
            }
            toolbar.remove();
        },
    };
}

function createCorrectionToolbarButton(document, className, label = '') {
    const button = createHTMLNode(document, 'button');
    button.type = 'button';
    button.className = [
        'mktero-correction-editor-button',
        className,
    ].join(' ');
    button.textContent = label;
    if (label) {
        button.setAttribute('aria-label', label);
        button.setAttribute('title', label);
    }
    return button;
}

function sharedPrefixLength(left, right) {
    const limit = Math.min(left.length, right.length);
    let index = 0;
    while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
    return index;
}

function createHTMLNode(document, tagName) {
    if (typeof document.createElementNS === 'function') {
        return document.createElementNS(XHTML_NAMESPACE, tagName);
    }
    return document.createElement(tagName);
}

function editorViewportOffset(editorView) {
    const scrollTop = Number(editorView.scrollDOM?.scrollTop);
    if (!Number.isFinite(scrollTop)
        || typeof editorView.lineBlockAtHeight !== 'function') {
        return editorView.viewport.from;
    }
    try {
        return editorView.lineBlockAtHeight(Math.max(0, scrollTop + 8)).from;
    }
    catch {
        return editorView.viewport.from;
    }
}

function editorViewportCenterOffset(editorView, verifyHeight = false) {
    const scrollTop = Number(editorView.scrollDOM?.scrollTop);
    const clientHeight = Number(editorView.scrollDOM?.clientHeight);
    if (!Number.isFinite(scrollTop)
        || !Number.isFinite(clientHeight)
        || clientHeight <= 0) {
        return editorView.viewport.from;
    }
    const height = Math.max(0, scrollTop + clientHeight / 2);
    try {
        const block = editorView.lineBlockAtHeight(height);
        if (!verifyHeight || blockCoversHeight(block, height)) return block.from;
    }
    catch {
        if (!verifyHeight) return editorView.viewport.from;
    }
    return searchEditorOffsetAtHeight(editorView, height);
}

function searchEditorOffsetAtHeight(editorView, height) {
    let low = 0;
    let high = editorView.state.doc.length;
    let closest = editorView.viewport.from;
    for (let attempt = 0; attempt < 24 && low <= high; attempt++) {
        const position = Math.floor((low + high) / 2);
        let block;
        try {
            block = editorView.lineBlockAt(position);
        }
        catch {
            break;
        }
        if (!validHeightBlock(block)) break;
        closest = block.from;
        if (blockCoversHeight(block, height)) return block.from;
        if (block.bottom < height) {
            low = Math.max(position + 1, block.to + 1);
        }
        else {
            high = Math.min(position - 1, block.from - 1);
        }
    }
    return closest;
}

function blockCoversHeight(block, height) {
    return validHeightBlock(block)
        && block.top <= height
        && block.bottom >= height;
}

function validHeightBlock(block) {
    return Number.isSafeInteger(block?.from)
        && Number.isSafeInteger(block?.to)
        && Number.isFinite(block?.top)
        && Number.isFinite(block?.bottom)
        && block.from >= 0
        && block.to >= block.from
        && block.bottom >= block.top;
}

function repairStalledViewport(
    editorView,
    deferRepair = () => {},
    requestedCenterOffset,
    allowInViewRepair = false
) {
    if (editorView.inView && !allowInViewRepair) return false;
    const scrollTop = Number(editorView.scrollDOM?.scrollTop);
    const clientHeight = Number(editorView.scrollDOM?.clientHeight);
    if (!Number.isFinite(scrollTop)
        || !Number.isFinite(clientHeight)
        || clientHeight <= 0) {
        return false;
    }
    const centerOffset = Number.isSafeInteger(requestedCenterOffset)
        ? Math.max(
            0,
            Math.min(requestedCenterOffset, editorView.state.doc.length)
        )
        : editorViewportCenterOffset(editorView, allowInViewRepair);
    if (centerOffset >= editorView.viewport.from
        && centerOffset <= editorView.viewport.to) {
        return false;
    }

    // Zotero's XUL tab can expose window-relative coordinates that make a
    // visible shadow-root editor look offscreen to CodeMirror. Give its
    // virtual viewport a centered target, then retain the user's scroll offset.
    try {
        editorView.dispatch({
            effects: EditorView.scrollIntoView(centerOffset, { y: 'center' }),
        });
        try {
            editorView.measure();
        }
        catch {
            deferRepair(scrollTop, centerOffset);
        }
    }
    finally {
        editorView.scrollDOM.scrollTop = scrollTop;
    }
    return true;
}

function createSourcedEvidence(markdown, sourceMap, target, figureViews) {
    try {
        return createEvidenceSnippet({ markdown, sourceMap, target, figureViews });
    }
    catch {
        return null;
    }
}

function selectionSourceLocation(sourceMap, target, documentLength) {
    const range = target?.ranges?.length === 1 ? target.ranges[0] : null;
    return resolveSourceMapSelectionLocation(sourceMap, range, documentLength);
}

// The offset is a page-boundary comment rendered as a page marker; find that
// marker's index and map it to the nearest source location.
function pageMarkerLocationAt(sourceMap, markdown, offset, documentLength) {
    if (!Number.isSafeInteger(offset)) return null;
    const markers = findMarkdownPageMarkers(markdown);
    const index = markers.findIndex(marker => marker.from === offset);
    if (index < 0) return null;
    return resolvePageMarkerSourceLocation(
        sourceMap,
        markers,
        index,
        documentLength
    );
}

function clampSelectionFocusToPointerLine(view, selection, pointer) {
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
        return;
    }
    const pointerLine = editorLineContaining(view, pointer?.target);
    const focusLine = editorLineContaining(view, selection.focusNode);
    if (!pointerLine || !focusLine || pointerLine === focusLine) return;
    const range = selection.getRangeAt(0);
    if (!pointerTouchesRect(pointer, pointerLine.getBoundingClientRect?.())
        || !Array.from(range.getClientRects?.() || []).some(rect => (
            pointerTouchesRect(pointer, rect, 8)
        ))) {
        return;
    }
    try {
        const anchorPosition = view.posAtDOM(
            selection.anchorNode,
            selection.anchorOffset
        );
        const focusPosition = view.posAtDOM(
            selection.focusNode,
            selection.focusOffset
        );
        const lineFrom = view.posAtDOM(pointerLine, 0);
        const lineTo = view.posAtDOM(
            pointerLine,
            pointerLine.childNodes.length
        );
        const forward = anchorPosition < focusPosition;
        if ((forward && (focusPosition <= lineTo || anchorPosition > lineTo))
            || (!forward
                && (focusPosition >= lineFrom || anchorPosition < lineFrom))) {
            return;
        }
        setSelectionFocus(
            selection,
            pointerLine,
            forward ? pointerLine.childNodes.length : 0,
            forward
        );
    }
    catch {
        // Stale CodeMirror DOM is ignored; the regular selection path can retry.
    }
}

function editorLineContaining(view, node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    const line = element?.closest?.('.cm-line');
    return line && view.dom.contains(line) ? line : null;
}

function setSelectionFocus(selection, node, offset, forward) {
    const anchorNode = selection.anchorNode;
    const anchorOffset = selection.anchorOffset;
    if (typeof selection.setBaseAndExtent === 'function') {
        selection.setBaseAndExtent(anchorNode, anchorOffset, node, offset);
        return;
    }
    const range = node.ownerDocument.createRange();
    if (forward) {
        range.setStart(anchorNode, anchorOffset);
        range.setEnd(node, offset);
    }
    else {
        range.setStart(node, offset);
        range.setEnd(anchorNode, anchorOffset);
    }
    selection.removeAllRanges();
    selection.addRange(range);
}

function createTimedTargetHighlight({
    ownerWindow,
    effect,
    isDestroyed,
}) {
    let timer = null;
    const cancel = () => {
        if (timer === null) return;
        ownerWindow.clearTimeout(timer);
        timer = null;
    };
    const activate = (editorView, target) => {
        cancel();
        editorView.dispatch({ effects: effect.of(target.id) });
        requestEditorScroll(
            editorView,
            target.from,
            editorView.state.doc
        );
        timer = ownerWindow.setTimeout(() => {
            timer = null;
            if (isDestroyed()) return;
            editorView.dispatch({ effects: effect.of(null) });
        }, 3000);
    };
    return { activate, cancel };
}

// What a copy that reached the reader put on the clipboard. A handler that
// supplied the text itself (CodeMirror copies the Markdown source, a note
// editor copies its quote) is matched exactly. Otherwise Firefox copies the
// selection's rendered text, which the selection reports too. A copy from a
// text field inside the reader belongs to that field and is left alone.
function readerCopyRequest(event, view, parent) {
    const supplied = event.defaultPrevented ? clipboardEventText(event) : '';
    if (supplied.trim()) return { text: supplied, exact: true };
    if (event.defaultPrevented) return null;
    const origin = event.composedPath?.()[0] || event.target;
    if (isTextInputElement(origin)) return null;
    const text = readerSelectionText(rootSelectionFor(parent), view);
    return text ? { text, exact: false } : null;
}

function clipboardEventText(event) {
    try {
        return String(event.clipboardData?.getData?.('text/plain') || '');
    }
    catch {
        return '';
    }
}

// The rendered text of a selection that lies inside the reader, or ''.
function readerSelectionText(selection, view) {
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
        return '';
    }
    if (!view.dom.contains(selection.anchorNode)
        || !view.dom.contains(selection.focusNode)) {
        return '';
    }
    return String(selection.toString?.() || '').trim();
}

// The copy Ctrl/Cmd+C should have made when no copy event arrived. The
// selection is offered to CodeMirror as a copy, so a plain passage copies its
// Markdown source exactly as it does normally. A selection CodeMirror leaves
// to the browser, such as one inside a rendered formula or table, copies its
// rendered text. The editor's state must already follow the DOM selection;
// a stale state would copy another passage, so that falls back as well.
function fallbackReaderCopyRequest(view, parent) {
    const selection = rootSelectionFor(parent);
    const rendered = readerSelectionText(selection, view);
    if (!rendered) return null;
    const supplied = stateFollowsSelection(view, selection)
        ? codeMirrorCopyText(selection, view)
        : '';
    return supplied.trim()
        ? { text: supplied, exact: true }
        : { text: rendered, exact: false };
}

function stateFollowsSelection(view, selection) {
    const { main } = view.state.selection;
    if (main.empty) return false;
    try {
        const range = selection.getRangeAt(0);
        const start = view.posAtDOM(range.startContainer, range.startOffset);
        const end = view.posAtDOM(range.endContainer, range.endOffset);
        return Math.min(start, end) === main.from
            && Math.max(start, end) === main.to;
    }
    catch {
        return false;
    }
}

function codeMirrorCopyText(selection, view) {
    let target;
    try {
        target = selection.getRangeAt(0).startContainer;
    }
    catch {
        return '';
    }
    const element = target?.nodeType === 1 ? target : target?.parentElement;
    if (!element || !view.contentDOM.contains(element)) return '';
    const ownerWindow = element.ownerDocument?.defaultView;
    if (!ownerWindow?.Event) return '';
    const data = new Map();
    const event = new ownerWindow.Event('copy', {
        bubbles: true,
        cancelable: true,
    });
    Object.defineProperty(event, 'clipboardData', {
        value: {
            clearData: () => data.clear(),
            setData: (type, value) => data.set(type, String(value)),
            getData: type => data.get(type) || '',
        },
    });
    syntheticCopyDispatch = true;
    try {
        element.dispatchEvent(event);
    }
    catch {
        return '';
    }
    finally {
        syntheticCopyDispatch = false;
    }
    return event.defaultPrevented ? data.get('text/plain') || '' : '';
}

const TEXT_INPUT_TAGS = new Set(['TEXTAREA', 'TEXTBOX', 'SELECT', 'INPUT']);

function isTextInputElement(element) {
    if (!element || element.nodeType !== 1) return false;
    return TEXT_INPUT_TAGS.has(String(element.tagName || '').toUpperCase());
}

function isNavigationBackShortcut(event) {
    return isPlainNavigationChord(event, 'ArrowLeft', '[');
}

function isNavigationForwardShortcut(event) {
    return isPlainNavigationChord(event, 'ArrowRight', ']');
}

// Alt+Arrow and Cmd+bracket, the same chords browsers use for history.
function isPlainNavigationChord(event, arrowKey, bracketKey) {
    const hasOnlyAlt = event.altKey
        && !event.ctrlKey
        && !event.metaKey
        && !event.shiftKey;
    const hasOnlyMeta = event.metaKey
        && !event.altKey
        && !event.ctrlKey
        && !event.shiftKey;
    return hasOnlyAlt && event.key === arrowKey
        || hasOnlyMeta && event.key === bracketKey;
}

function acquireDOMGlobals(ownerWindow) {
    // A page that runs the editor in its own window already has the right DOM
    // globals, and `document`/`window` are read-only there. Only Zotero's
    // bootstrap scope, which is not a window, needs them rebound.
    if (ownerWindow === globalThis) return;
    if (!domWindowReferences.size) {
        previousDOMGlobals = new Map();
        for (const name of DOM_GLOBAL_NAMES) {
            previousDOMGlobals.set(name, {
                exists: Object.hasOwn(globalThis, name),
                value: globalThis[name],
            });
        }
    }
    domWindowReferences.set(
        ownerWindow,
        (domWindowReferences.get(ownerWindow) || 0) + 1
    );
    activateDOMGlobals(ownerWindow);
}

function activateDOMGlobals(ownerWindow) {
    if (ownerWindow === globalThis || activeDOMWindow === ownerWindow) return;
    for (const name of DOM_GLOBAL_NAMES) {
        if (name === 'document') {
            globalThis[name] = ownerWindow.document;
        }
        else if (name === 'getComputedStyle') {
            globalThis[name] = ownerWindow.getComputedStyle?.bind(ownerWindow);
        }
        else {
            globalThis[name] = ownerWindow[name];
        }
    }
    activeDOMWindow = ownerWindow;
}

function installDOMActivation(parent, ownerWindow, refreshViewport) {
    const activate = event => {
        activateDOMGlobals(ownerWindow);
        if (event?.type === 'scroll' || event?.type === 'wheel') {
            refreshViewport?.(event);
        }
    };
    for (const type of DOM_ACTIVATION_EVENTS) {
        parent.addEventListener(type, activate, true);
    }
    const onSelectionChange = () => {
        const anchor = rootSelectionFor(parent)?.anchorNode;
        if (anchor && parent.contains(anchor)) activate();
    };
    ownerWindow.document.addEventListener('selectionchange', onSelectionChange);

    return () => {
        for (const type of DOM_ACTIVATION_EVENTS) {
            parent.removeEventListener(type, activate, true);
        }
        ownerWindow.document.removeEventListener('selectionchange', onSelectionChange);
    };
}

function releaseDOMGlobals(ownerWindow) {
    const references = domWindowReferences.get(ownerWindow) || 0;
    if (!references) return;
    if (references === 1) domWindowReferences.delete(ownerWindow);
    else domWindowReferences.set(ownerWindow, references - 1);

    if (domWindowReferences.size) {
        if (!domWindowReferences.has(activeDOMWindow)) {
            activateDOMGlobals(domWindowReferences.keys().next().value);
        }
        return;
    }

    for (const [name, previous] of previousDOMGlobals) {
        if (previous.exists) globalThis[name] = previous.value;
        else delete globalThis[name];
    }
    previousDOMGlobals = null;
    activeDOMWindow = null;
}
