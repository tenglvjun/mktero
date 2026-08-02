import { markdown } from '@codemirror/lang-markdown';
import { searchKeymap } from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { GFM } from '@lezer/markdown';
import {
    createEmptyAnnotationOverlay,
} from '../core/markdown-annotation-overlay.js';
import { createLocalization } from '../i18n/localization.js';
import {
    createInlineRenderingExtension,
    refreshInlineRendering,
    selectedMarkdownAnnotation,
    selectionAnchor,
    setAnnotationOverlay,
    setSourceMap,
    setFigureHighlight,
    setReferenceHighlight,
    setTableHighlight,
} from './inline-rendering.js';
import { createImagePreview } from './image-preview.js';
import { createCitationPopup } from './citation-popup.js';
import { createAnnotationPopup } from './annotation-popup.js';
import { createFigurePreviewPopup } from './figure-preview-popup.js';
import { createTablePreviewPopup } from './table-preview-popup.js';

const editorNavigationMeasureKey = {};
const DOM_GLOBAL_NAMES = [
    'document',
    'window',
    'Window',
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
    openLink,
    createMarkdownAnnotation,
    changeAnnotationColor,
    updateAnnotationComment,
    deleteAnnotation,
    openSourceLocation,
    onSourceNavigationError,
    localization = createLocalization(),
}) {
    const t = localization.t.bind(localization);
    if (!parent) throw new Error(t('error.editorParentRequired'));
    const ownerWindow = parent.ownerDocument?.defaultView;
    if (!ownerWindow) throw new Error(t('error.editorWindowRequired'));
    acquireDOMGlobals(ownerWindow);
    const imagePreview = createImagePreview(parent, { localization });
    const citationPopup = createCitationPopup(parent, { localization });
    const annotationPopup = createAnnotationPopup(parent, {
        localization,
        createMarkdownAnnotation: typeof createMarkdownAnnotation === 'function'
            ? async annotation => {
                const saved = await createMarkdownAnnotation(annotation);
                ownerWindow.getSelection?.()?.removeAllRanges?.();
                return saved;
            }
            : undefined,
        changeAnnotationColor,
        updateAnnotationComment,
        deleteAnnotation,
    });
    const tablePreviewPopup = createTablePreviewPopup(parent, {
        resolveImageURL,
        localization,
    });
    const figurePreviewPopup = createFigurePreviewPopup(parent, {
        resolveImageURL,
        localization,
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
        ...referenceFeatureList.map(feature => feature.popup),
    ];
    let view;
    const removeDOMActivation = installDOMActivation(
        parent,
        ownerWindow,
        event => {
            if (!view) return;
            if (interactionPopups.some(popup => popup.contains(event.target))) {
                return;
            }
            if (event.type === 'scroll' || event.type === 'wheel') {
                for (const popup of interactionPopups) popup.close();
            }
            view.requestMeasure();
            if (event.type === 'scroll'
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
                    openLink,
                    openImagePreview: imagePreview.open,
                    citationPopup,
                    tablePreviewPopup,
                    figurePreviewPopup,
                    annotationPopup,
                    openSourceLocation,
                    onSourceNavigationError,
                    activateCitation:
                        referenceFeatures.citation.highlight.activate,
                    activateTableReference:
                        referenceFeatures.table.highlight.activate,
                    activateFigureReference:
                        referenceFeatures.figure.highlight.activate,
                    translate: t,
                }),
                EditorView.editable.of(false),
                EditorState.readOnly.of(true),
                keymap.of(searchKeymap),
                EditorView.lineWrapping,
            ],
        });
        const root = parent.getRootNode?.();
        view = new EditorView({
            state,
            parent,
            root: root?.nodeType === 9 || root?.nodeType === 11 ? root : undefined,
        });
    }
    catch (error) {
        for (const feature of referenceFeatureList) feature.popup.destroy();
        annotationPopup.destroy();
        imagePreview.destroy();
        removeDOMActivation();
        releaseDOMGlobals(ownerWindow);
        throw error;
    }
    const openSelectedMarkdownActions = event => {
        if (event.button !== 0) return;
        if (interactionPopups.some(popup => popup.contains(event.target))) {
            return;
        }
        activateDOMGlobals(ownerWindow);
        const selection = selectedMarkdownAnnotation(view);
        if (!selection) return;
        for (const popup of interactionPopups) {
            if (popup !== annotationPopup) popup.close();
        }
        annotationPopup.openSelection({
            anchor: selectionAnchor(
                ownerWindow.document.getSelection?.(),
                event.target
            ),
            selection,
        });
    };
    const closeSelectionActions = event => {
        if (event.button === 0 && !annotationPopup.contains(event.target)) {
            annotationPopup.close();
        }
    };
    parent.addEventListener('mousedown', closeSelectionActions, true);
    parent.addEventListener('mouseup', openSelectedMarkdownActions, true);
    const setDocument = ({ markdown, annotationOverlay, sourceMap }) => {
        activateDOMGlobals(ownerWindow);
        for (const feature of referenceFeatureList) {
            feature.popup.close();
            feature.highlight.cancel();
        }
        annotationPopup.close();
        const value = String(markdown || '');
        const effects = [
            ...referenceFeatureList.map(feature => feature.effect.of(null)),
            setAnnotationOverlay.of(
                annotationOverlay || createEmptyAnnotationOverlay()
            ),
            setSourceMap.of(Array.isArray(sourceMap) ? sourceMap : []),
        ];
        if (value === view.state.doc.toString()) {
            view.dispatch({ effects });
            return;
        }
        view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: value },
            effects,
        });
    };
    return {
        getMarkdown() {
            return view.state.doc.toString();
        },
        setDocument,
        setMarkdown(markdown) {
            setDocument({
                markdown,
                annotationOverlay: createEmptyAnnotationOverlay(),
            });
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
        refreshRendering() {
            activateDOMGlobals(ownerWindow);
            view.dispatch({ effects: refreshInlineRendering.of(null) });
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            activateDOMGlobals(ownerWindow);
            try {
                for (const feature of referenceFeatureList) {
                    feature.highlight.cancel();
                    feature.popup.destroy();
                }
                parent.removeEventListener(
                    'mousedown',
                    closeSelectionActions,
                    true
                );
                parent.removeEventListener(
                    'mouseup',
                    openSelectedMarkdownActions,
                    true
                );
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

function acquireDOMGlobals(ownerWindow) {
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
    if (activeDOMWindow === ownerWindow) return;
    for (const name of DOM_GLOBAL_NAMES) {
        globalThis[name] = name === 'document'
            ? ownerWindow.document
            : ownerWindow[name];
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
        const anchor = ownerWindow.document.getSelection?.().anchorNode;
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
