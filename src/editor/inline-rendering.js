import { syntaxTree } from '@codemirror/language';
import { Prec, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import {
    createEmptyAnnotationOverlay,
} from '../core/markdown-annotation-overlay.js';
import {
    isSupportedAITargetLanguage,
} from '../config/ai-preferences.js';
import { findMinerUAlgorithmGroups } from '../markdown/markdown-algorithms.js';
import {
    findDisplayMathMatches,
    findInlineMathMatches,
    safeMarkdownLinkURL,
} from '../markdown/markdown-html.js';
import { translateEnglish } from '../i18n/localization.js';
import {
    findAcademicFigureGroups,
    findAcademicTableGroups,
    findConsecutiveImagePacks,
} from '../markdown/markdown-figures.js';
import { analyzeMarkdownCitations } from '../markdown/markdown-citations.js';
import {
    analyzeMarkdownFigureReferences,
} from '../markdown/markdown-figure-references.js';
import { analyzeMarkdownTableReferences } from '../markdown/markdown-table-references.js';
import {
    isEditableTextCorrectionBlock,
} from './correction-interactions.js';
import {
    createTableCaption,
    RenderedTableWidget,
} from './rendered-table-widget.js';
import {
    applyTranslationPresentation,
    normalizeTranslationPresentation,
    sameTranslationPresentation,
} from './translation-presentation.js';
import {
    appendRenderedMarkdown,
    installRenderedCitations,
    installRenderedImagePreview,
    openRenderedLink,
} from './rendered-markdown-dom.js';
import {
    annotationHasComment,
    annotationAttributes,
    annotationClassName,
    createAnnotationNoteMarker,
    installRenderedAnnotations,
} from './pdf-annotations.js';
import { MAX_PDF_ANNOTATION_TEXT_LENGTH } from '../core/pdf-annotation.js';
import {
    subtractChromeRanges,
    visibleTextForRanges,
} from '../markdown/chrome-ranges.js';
import { createVisibleMarkdownTextIndex } from '../markdown/markdown-visible-text.js';
import {
    findTextOccurrences,
    isNumericCitationContent,
    normalizeText,
} from '../markdown/text-normalization.js';
import {
    highlightCodeBlock,
    normalizeCodeBlockLanguage,
} from '../markdown/code-highlighting.js';
import {
    BILINGUAL_LIST_BOUNDARY,
} from '../markdown/markdown-translation-blocks.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const MAX_MATCH_CANDIDATES = 10_000;

export const setReferenceHighlight = StateEffect.define();
export const setTableHighlight = StateEffect.define();
export const setFigureHighlight = StateEffect.define();
export const setAnnotationOverlay = StateEffect.define();
export const setTranslationRanges = StateEffect.define();
export const setTranslationFailures = StateEffect.define();
export const setTranslationPairs = StateEffect.define();
export const setTranslationPairHighlight = StateEffect.define();
export const setInlineEditingRange = StateEffect.define();
export const setCorrectionRenderingState = StateEffect.define();

class RenderedMarkdownWidget extends WidgetType {
    constructor({
        source,
        renderSource = source,
        display,
        from,
        resolveImageURL,
        openLink,
        openImagePreview,
        copyCode,
        renderVersion,
        citations = [],
        annotations = [],
        extraClassName = '',
        tableCaption = null,
        translationPresentation = {},
        translate = translateEnglish,
    }) {
        super();
        this.source = source;
        this.renderSource = renderSource;
        this.display = display;
        this.from = from;
        this.resolveImageURL = resolveImageURL;
        this.openLink = openLink;
        this.openImagePreview = openImagePreview;
        this.copyCode = copyCode;
        this.renderVersion = renderVersion;
        this.citations = citations;
        this.citationKey = citations.map(citation => citation.key).join('|');
        this.annotations = annotations;
        this.annotationKey = JSON.stringify(annotations);
        this.extraClassName = extraClassName;
        this.tableCaption = tableCaption;
        this.translationPresentation = normalizeTranslationPresentation(
            translationPresentation
        );
        this.translate = translate;
    }

    eq(other) {
        return this.source === other.source
            && this.renderSource === other.renderSource
            && this.display === other.display
            && this.from === other.from
            && this.renderVersion === other.renderVersion
            && this.citationKey === other.citationKey
            && this.annotationKey === other.annotationKey
            && this.extraClassName === other.extraClassName
            && this.tableCaption?.text === other.tableCaption?.text
            && sameTranslationPresentation(
                this.translationPresentation,
                other.translationPresentation
            );
    }

    toDOM(view) {
        const document = view.dom.ownerDocument;
        const inline = ['inline', 'image-inline', 'math'].includes(this.display);
        const container = document.createElement(inline ? 'span' : 'div');
        container.className = [
            'cm-mktero-rendered',
            `cm-mktero-${this.display}`,
            this.extraClassName,
        ].filter(Boolean).join(' ');
        applyTranslationPresentation(container, this.translationPresentation);
        container.dataset.markdownFrom = String(this.from);
        container.dataset.markdownTo = String(this.from + this.source.length);
        appendRenderedMarkdown(
            container,
            this.renderSource,
            this.resolveImageURL,
            inline,
            this.translate
        );
        const table = container.querySelector('table');
        if (table && this.tableCaption && !table.querySelector('caption')) {
            table.prepend(createTableCaption(document, this.tableCaption));
        }
        installRenderedCitations(container, this.citations);
        if (['math', 'math-display'].includes(this.display)) {
            wrapRenderedMathAnnotations(
                container,
                this.annotations,
                this.translate
            );
        }
        else {
            installRenderedAnnotations(
                container,
                this.annotations,
                this.translate,
                { source: this.source, sourceFrom: this.from }
            );
        }

        container.addEventListener('mousedown', event => {
            if (event.target?.closest?.('img')) return;
            openRenderedLink(event, this.openLink);
        });
        installRenderedImagePreview(
            container,
            this.openImagePreview,
            this.translate
        );
        if (this.display === 'code-block') {
            enhanceRenderedCodeBlock(container, document, {
                copyCode: this.copyCode,
                translate: this.translate,
            });
        }
        return container;
    }

    ignoreEvent(event) {
        if (event.type === 'mousedown'
            && event.target?.closest?.('.cm-mktero-pdf-annotation')) {
            return true;
        }
        return !event.target?.closest?.(
            '.cm-mktero-citation, .cm-mktero-pdf-annotation'
        );
    }
}

class TranslationFailureWidget extends WidgetType {
    constructor(label) {
        super();
        this.label = label;
    }

    eq(other) {
        return this.label === other.label;
    }

    toDOM(view) {
        const document = view.dom.ownerDocument;
        const container = createHTMLNode(document, 'div');
        container.className = 'cm-mktero-translation-failure';
        container.setAttribute('role', 'status');
        const label = createHTMLNode(document, 'span');
        label.className = 'cm-mktero-translation-failure-label';
        label.textContent = this.label;
        container.appendChild(label);
        return container;
    }
}

class TextMarkerWidget extends WidgetType {
    constructor(text, className) {
        super();
        this.text = text;
        this.className = className;
    }

    eq(other) {
        return this.text === other.text && this.className === other.className;
    }

    toDOM(view) {
        const marker = view.dom.ownerDocument.createElement('span');
        marker.className = this.className;
        marker.textContent = this.text;
        return marker;
    }
}

class TaskCheckboxWidget extends WidgetType {
    constructor(checked, label) {
        super();
        this.checked = checked;
        this.label = label;
    }

    eq(other) {
        return this.checked === other.checked && this.label === other.label;
    }

    toDOM(view) {
        const document = view.dom.ownerDocument;
        const wrapper = document.createElement('span');
        wrapper.className = 'cm-mktero-task';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = this.checked;
        checkbox.disabled = true;
        checkbox.setAttribute('aria-label', this.label);
        wrapper.appendChild(checkbox);
        return wrapper;
    }

    ignoreEvent() {
        return true;
    }
}

class AnnotationNoteWidget extends WidgetType {
    constructor(annotation, translate) {
        super();
        this.annotation = annotation;
        this.translate = translate;
        this.key = JSON.stringify([
            String(annotation.id || ''),
            String(annotation.color || ''),
        ]);
    }

    eq(other) {
        return this.key === other.key;
    }

    toDOM(view) {
        return createAnnotationNoteMarker(
            view.dom.ownerDocument,
            this.annotation,
            this.translate
        );
    }

    ignoreEvent() {
        return false;
    }
}

class CorrectionMarkerWidget extends WidgetType {
    constructor(block, restoreCorrection, onCorrectionError, translate) {
        super();
        this.block = block;
        this.restoreCorrection = restoreCorrection;
        this.onCorrectionError = onCorrectionError;
        this.translate = translate;
    }

    eq(other) {
        return this.block.id === other.block.id
            && this.block.type === other.block.type
            && this.block.from === other.block.from
            && this.block.to === other.block.to;
    }

    toDOM(view) {
        const document = view.dom.ownerDocument;
        const deleted = this.block.from === this.block.to;
        const button = createHTMLNode(document, 'button');
        button.type = 'button';
        button.className = 'cm-mktero-correction-marker';
        button.textContent = this.translate(deleted
            ? 'revision.undoDelete'
            : 'revision.restoreBlock');
        button.setAttribute(
            'aria-label',
            this.translate(deleted
                ? 'revision.undoDeleteLabel'
                : 'revision.restoreBlockLabel')
        );
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            button.disabled = true;
            Promise.resolve(this.restoreCorrection?.(this.block.id))
                .catch(error => this.onCorrectionError?.(error))
                .finally(() => { button.disabled = false; });
        });
        if (!deleted) return button;

        const placeholder = createHTMLNode(document, 'div');
        placeholder.className = 'cm-mktero-deleted-correction';
        const label = createHTMLNode(document, 'span');
        label.className = 'cm-mktero-deleted-correction-label';
        label.textContent = this.translate('revision.deletedBlock');
        placeholder.append(label, button);
        return placeholder;
    }

    ignoreEvent() {
        return true;
    }
}

export function enhanceRenderedCodeBlocks(
    root,
    document,
    options = {}
) {
    for (const pre of root?.querySelectorAll?.('pre') || []) {
        const container = pre.closest?.('.cm-mktero-code-block')
            || wrapCodeBlockContainer(pre, document);
        enhanceRenderedCodeBlock(container, document, options);
    }
}

function enhanceRenderedCodeBlock(
    container,
    document,
    { copyCode, translate = translateEnglish } = {}
) {
    const pre = container.querySelector('pre');
    const codeElement = pre?.querySelector('code');
    if (!pre || !codeElement
        || container.querySelector('.cm-mktero-code-toolbar')) {
        return;
    }

    const code = codeElement.textContent || '';
    const languageMatch = /(?:^|\s)language-([^\s]+)/.exec(
        codeElement.className || ''
    );
    const language = normalizeCodeBlockLanguage(languageMatch?.[1] || '');
    const displayLanguage = language.length > 24
        ? `${language.slice(0, 23)}…`
        : language;
    const toolbar = createHTMLNode(document, 'div');
    toolbar.className = 'cm-mktero-code-toolbar';

    const languageLabel = createHTMLNode(document, 'span');
    languageLabel.className = 'cm-mktero-code-language';
    languageLabel.dataset.language = language;
    languageLabel.textContent = displayLanguage;
    toolbar.append(languageLabel);

    if (typeof copyCode === 'function' && code.trim()) {
        const copyButton = createHTMLNode(document, 'button');
        copyButton.type = 'button';
        copyButton.className = 'cm-mktero-code-copy';
        copyButton.dataset.action = 'copy-code';
        copyButton.setAttribute('aria-label', translate('markdown.codeCopy'));
        copyButton.title = translate('markdown.codeCopy');
        copyButton.textContent = translate('markdown.codeCopy');
        copyButton.addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();
            if (copyButton.disabled) return;
            copyButton.disabled = true;
            try {
                await copyCode(code);
                copyButton.dataset.state = 'copied';
                copyButton.textContent = translate('markdown.codeCopied');
            }
            catch {
                copyButton.dataset.state = 'failed';
                copyButton.textContent = translate('markdown.codeCopyFailed');
            }
            finally {
                copyButton.disabled = false;
            }
        });
        toolbar.append(copyButton);
    }

    const content = createHTMLNode(document, 'div');
    content.className = 'cm-mktero-code-content';
    content.dataset.markdownContent = 'true';
    pre.replaceWith(content);
    content.append(pre);
    pre.dataset.language = language;
    pre.dataset.theme = resolveCodeTheme(document);
    container.insertBefore(toolbar, content);

    void highlightCodeBlock({
        code,
        language,
        theme: pre.dataset.theme,
    }).then(result => {
        if (!result
            || codeElement.textContent !== code
            || hasActiveCodeSelection(document, codeElement)) {
            return;
        }
        if (highlightedCodeText(result.lines) !== code) return;
        renderHighlightedCode(codeElement, result.lines, document);
        codeElement.dataset.highlighted = 'true';
        codeElement.dataset.theme = result.theme;
    });
}

function wrapCodeBlockContainer(pre, document) {
    const container = createHTMLNode(document, 'div');
    container.className = 'cm-mktero-code-block';
    pre.replaceWith(container);
    container.append(pre);
    return container;
}

function highlightedCodeText(lines) {
    return lines
        .map(line => line.map(token => token.content || '').join(''))
        .join('\n');
}

function renderHighlightedCode(codeElement, lines, document) {
    const fragment = document.createDocumentFragment();
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        for (const token of lines[lineIndex]) {
            if (!token.content) continue;
            const span = createHTMLNode(document, 'span');
            span.className = 'cm-mktero-code-token';
            if (isSafeTokenColor(token.color)) {
                span.style.color = token.color;
            }
            const fontStyle = Number(token.fontStyle) || 0;
            if (fontStyle & 1) span.style.fontStyle = 'italic';
            if (fontStyle & 2) span.style.fontWeight = '600';
            if (fontStyle & 4) span.style.textDecoration = 'underline';
            span.textContent = token.content;
            fragment.append(span);
        }
        if (lineIndex < lines.length - 1) {
            fragment.append(document.createTextNode('\n'));
        }
    }
    codeElement.replaceChildren(fragment);
}

function createHTMLNode(document, tagName) {
    if (typeof document.createElementNS === 'function') {
        return document.createElementNS(XHTML_NAMESPACE, tagName);
    }
    return document.createElement(tagName);
}

function resolveCodeTheme(document) {
    const matchMedia = document.defaultView?.matchMedia;
    if (typeof matchMedia !== 'function') return 'light';
    try {
        return matchMedia.call(
            document.defaultView,
            '(prefers-color-scheme: dark)'
        ).matches ? 'dark' : 'light';
    }
    catch {
        return 'light';
    }
}

function hasActiveCodeSelection(document, codeElement) {
    const selection = document.defaultView?.getSelection?.();
    if (!selection?.rangeCount || selection.isCollapsed) return false;
    for (let index = 0; index < selection.rangeCount; index++) {
        try {
            if (selection.getRangeAt(index).intersectsNode(codeElement)) {
                return true;
            }
        }
        catch {
            // Some Zotero DOM implementations do not expose intersectsNode.
        }
    }
    return false;
}

function renderedMarkdownContentContainer(container) {
    return container.querySelector?.('[data-markdown-content]') || container;
}

function isSafeTokenColor(color) {
    return typeof color === 'string'
        && /^#[0-9a-f]{3,8}$/i.test(color);
}

export function createInlineRenderingExtension({
    resolveImageURL,
    openLink,
    openImagePreview,
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
    activateCitation,
    activateTableReference,
    activateFigureReference,
    commitCorrection,
    restoreCorrection,
    onCorrectionError,
    onCorrectionEditingChange,
    translate = translateEnglish,
}) {
    const context = {
        resolveImageURL,
        openLink,
        openImagePreview,
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
        activateCitation,
        activateTableReference,
        activateFigureReference,
        commitCorrection,
        restoreCorrection,
        onCorrectionError,
        onCorrectionEditingChange,
        translate,
        renderVersion: 0,
        highlightedReferenceID: null,
        highlightedTableID: null,
        highlightedFigureID: null,
        annotationOverlay: createEmptyAnnotationOverlay(),
        translationRanges: [],
        translationFailures: [],
        translationPairs: [],
        highlightedTranslationBlockID: null,
        annotationTargets: new Map(),
        editingRange: null,
        correctionManagementEnabled: false,
        correctionBlocks: [],
        correctedBlockIDs: new Set(),
        citationAnalysisDocument: null,
        citationAnalysis: null,
        citationTargets: new Map(),
        tableReferences: createReferenceAnalysisCache(
            analyzeMarkdownTableReferences
        ),
        figureReferences: createReferenceAnalysisCache(
            analyzeMarkdownFigureReferences,
            { indexTargetsByFrom: true }
        ),
    };
    const renderingField = StateField.define({
        create(state) {
            return buildDecorations(state, context);
        },
        update(decorations, transaction) {
            const shouldRefresh = transaction.effects.some(effect => (
                effect.is(refreshInlineRendering)
            ));
            const syntaxTreeChanged = syntaxTree(transaction.startState)
                !== syntaxTree(transaction.state);
            let referenceHighlightChanged = false;
            let tableHighlightChanged = false;
            let figureHighlightChanged = false;
            let annotationOverlayChanged = false;
            let translationRangesChanged = false;
            let translationFailuresChanged = false;
            let translationPairsChanged = false;
            let translationPairHighlightChanged = false;
            let editingRangeChanged = false;
            let correctionStateChanged = false;
            if (shouldRefresh) context.renderVersion++;
            for (const effect of transaction.effects) {
                if (effect.is(setReferenceHighlight)) {
                    context.highlightedReferenceID = effect.value;
                    referenceHighlightChanged = true;
                }
                else if (effect.is(setTableHighlight)) {
                    context.highlightedTableID = effect.value;
                    tableHighlightChanged = true;
                }
                else if (effect.is(setFigureHighlight)) {
                    context.highlightedFigureID = effect.value;
                    figureHighlightChanged = true;
                }
                else if (effect.is(setAnnotationOverlay)) {
                    context.annotationOverlay = effect.value
                        || createEmptyAnnotationOverlay();
                    context.annotationTargets = new Map(
                        (context.annotationOverlay.matched || []).map(
                            annotation => [String(annotation.id || ''), annotation]
                        )
                    );
                    annotationOverlayChanged = true;
                }
                else if (effect.is(setTranslationRanges)) {
                    context.translationRanges = normalizeTranslationRanges(
                        effect.value,
                        transaction.state.doc.length
                    );
                    translationRangesChanged = true;
                }
                else if (effect.is(setTranslationFailures)) {
                    context.translationFailures = normalizeTranslationFailures(
                        effect.value,
                        transaction.state.doc.length
                    );
                    translationFailuresChanged = true;
                }
                else if (effect.is(setTranslationPairs)) {
                    context.translationPairs = normalizeTranslationPairs(
                        effect.value,
                        transaction.state.doc.length
                    );
                    translationPairsChanged = true;
                }
                else if (effect.is(setTranslationPairHighlight)) {
                    const id = String(effect.value || '');
                    context.highlightedTranslationBlockID =
                        context.translationPairs.some(pair => pair.id === id)
                            ? id
                            : null;
                    translationPairHighlightChanged = true;
                }
                else if (effect.is(setInlineEditingRange)) {
                    context.editingRange = effect.value;
                    editingRangeChanged = true;
                }
                else if (effect.is(setCorrectionRenderingState)) {
                    const value = effect.value || {};
                    context.correctionManagementEnabled = Boolean(value.enabled);
                    context.correctionBlocks = Array.isArray(value.blocks)
                        ? value.blocks
                        : [];
                    context.correctedBlockIDs = new Set(
                        value.correctedBlockIDs || []
                    );
                    correctionStateChanged = true;
                }
            }
            if (transaction.docChanged
                || syntaxTreeChanged
                || referenceHighlightChanged
                || tableHighlightChanged
                || figureHighlightChanged
                || annotationOverlayChanged
                || translationRangesChanged
                || translationFailuresChanged
                || translationPairsChanged
                || translationPairHighlightChanged
                || editingRangeChanged
                || correctionStateChanged
                || shouldRefresh) {
                return buildDecorations(transaction.state, context);
            }
            return decorations;
        },
        provide: field => EditorView.decorations.from(field),
    });
    return [
        renderingField,
        Prec.highest(EditorView.domEventHandlers({
            mouseover(event, view) {
                if (selectionActionsLocked(context)) return false;
                referenceInteraction(event, view, context)?.open();
                return false;
            },
            mouseout(event, view) {
                if (selectionActionsLocked(context)) return false;
                const interaction = referenceInteraction(event, view, context);
                if (!interaction
                    || interaction.element.contains(event.relatedTarget)
                    || interaction.popup?.contains(event.relatedTarget)) {
                    return false;
                }
                if (interaction.cancelOpen?.()) return false;
                interaction.popup?.scheduleClose();
                return false;
            },
            focusin(event, view) {
                const interaction = referenceInteraction(event, view, context);
                if (interaction?.openImmediately) {
                    interaction.openImmediately();
                }
                else {
                    interaction?.open();
                }
                return false;
            },
            focusout(event, view) {
                if (selectionActionsLocked(context)) return false;
                referenceInteraction(event, view, context)
                    ?.popup?.scheduleClose();
                return false;
            },
            mousedown(event, view) {
                const interaction = referenceInteraction(event, view, context);
                if (!interaction && event.button === 0) {
                    context.annotationPopup?.close();
                }
                if (event.button === 0
                    && interaction
                    && !interaction.allowTextSelection) {
                    event.preventDefault();
                    return true;
                }
                if (event.button !== 0 || (!event.metaKey && !event.ctrlKey)) {
                    return false;
                }
                const link = event.target?.closest?.('.cm-mktero-link');
                if (!link || !view.dom.contains(link)) return false;

                const position = view.posAtDOM(link, 0);
                const url = safeMarkdownLinkURL(findLinkURL(view.state, position));
                if (!url) return false;
                event.preventDefault();
                openLink?.(url);
                return true;
            },
            click(event, view) {
                const interaction = referenceInteraction(event, view, context);
                if (interaction && event.button === 0) {
                    if (interaction.allowTextSelection
                        && hasSelectedInteractionText(
                            view,
                            interaction.element
                        )) {
                        return false;
                    }
                    event.preventDefault();
                    interaction.activate();
                    return true;
                }
                return false;
            },
            dblclick(event, view) {
                const interaction = referenceInteraction(event, view, context);
                if (interaction && !interaction.allowTextSelection) {
                    event.preventDefault();
                    return true;
                }
                return false;
            },
            keydown(event, view) {
                const interaction = referenceInteraction(event, view, context);
                if (!interaction) return false;
                if (event.key === 'ArrowDown' && interaction.focusPopup) {
                    event.preventDefault();
                    interaction.focusPopup();
                    return true;
                }
                if (!['Enter', ' '].includes(event.key)) return false;
                event.preventDefault();
                interaction.activate();
                return true;
            },
            blur(event, view) {
                for (const popup of referencePopups(context)) {
                    if (!popup?.contains(event.relatedTarget)) popup?.close();
                }
                return false;
            },
        })),
    ];
}

export const refreshInlineRendering = StateEffect.define();

function findLinkURL(state, position) {
    let node = syntaxTree(state).resolveInner(position, 1);
    while (node && !['Link', 'Autolink', 'URL'].includes(node.name)) {
        node = node.parent;
    }
    if (node?.name === 'URL') return state.sliceDoc(node.from, node.to);
    const urlNode = node?.getChild('URL');
    if (urlNode) return state.sliceDoc(urlNode.from, urlNode.to);
    if (node?.name !== 'Link') return '';

    const label = node.getChild('LinkLabel');
    let normalizedLabel = label
        ? normalizeLinkLabel(state.sliceDoc(label.from, label.to))
        : '';
    if (!normalizedLabel) {
        const marks = node.getChildren('LinkMark');
        const closingLabel = marks.find(mark => (
            state.sliceDoc(mark.from, mark.to) === ']'
        ));
        if (marks.length && closingLabel) {
            normalizedLabel = normalizeLinkLabel(
                state.sliceDoc(marks[0].to, closingLabel.from)
            );
        }
    }
    if (!normalizedLabel) return '';
    let resolvedURL = '';
    syntaxTree(state).iterate({
        enter(reference) {
            if (resolvedURL || reference.name !== 'LinkReference') return;
            const referenceLabel = reference.node.getChild('LinkLabel');
            const referenceURL = reference.node.getChild('URL');
            if (referenceLabel && referenceURL
                && normalizeLinkLabel(
                    state.sliceDoc(referenceLabel.from, referenceLabel.to)
                ) === normalizedLabel) {
                resolvedURL = state.sliceDoc(referenceURL.from, referenceURL.to);
            }
        },
    });
    return resolvedURL;
}

function normalizeLinkLabel(label) {
    return String(label)
        .replace(/^\[|\]$/g, '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function buildDecorations(state, context) {
    const decorations = [];
    const excludedMathRanges = collectExcludedMathRanges(state);
    const renderedMathRanges = [];
    const analyzedTableReferences = referenceAnalysis(
        state,
        context.tableReferences
    );
    const tableTargetsByFrom = new Map(
        analyzedTableReferences.targets.map(target => [target.from, target])
    );
    referenceAnalysis(state, context.figureReferences);
    const algorithmGroups = findMinerUAlgorithmGroups(state.doc.toString())
        .filter(group => !rangesOverlapEditing(group, context));
    const figureGroups = findAcademicFigureGroups(state.doc.toString())
        .filter(group => !rangesOverlapEditing(group, context));
    const imagePacks = findConsecutiveImagePacks(
        state.doc.toString(),
        figureGroups
    ).filter(group => !rangesOverlapEditing(group, context));
    const renderedFigureGroups = [...figureGroups, ...imagePacks];
    const tableGroups = findAcademicTableGroups(state.doc.toString())
        .filter(group => !rangesOverlapEditing(group, context));
    const renderedGroups = [
        ...algorithmGroups,
        ...renderedFigureGroups,
        ...tableGroups,
    ];
    for (const group of algorithmGroups) {
        decorations.push(renderedRange(group, state, 'algorithm', context));
    }
    for (const group of renderedFigureGroups) {
        decorations.push(renderedRange(group, state, 'image', context));
    }
    for (const group of tableGroups) {
        decorations.push(renderedRange(
            {
                ...group,
                tableTarget: tableTargetsByFrom.get(group.from),
            },
            state,
            group.table.kind === 'gfm' ? 'table' : 'html-block',
            context
        ));
    }

    syntaxTree(state).iterate({
        enter(node) {
            if (node.name !== 'Document'
                && rangeInsideEditing(node, context)) {
                return false;
            }
            if (renderedGroups.some(group => rangeContains(group, node))) {
                return false;
            }
            const result = decorateSyntaxNode(node, state, decorations, context);
            if (result === false) return false;
            const paragraph = node.name === 'Paragraph';
            if (paragraph || isHeadingNode(node.name)) {
                decorateMath(
                    node,
                    state,
                    decorations,
                    excludedMathRanges,
                    context,
                    paragraph,
                    renderedMathRanges
                );
            }
            return undefined;
        },
    });
    decorateCitations(state, decorations, context);
    decorateTableReferences(state, decorations, context);
    decorateFigureReferences(state, decorations, context);
    decoratePDFAnnotations(
        state,
        decorations,
        context,
        [...renderedGroups, ...renderedMathRanges]
    );
    decorateTranslationRanges(state, decorations, context);
    decorateTranslationPairs(state, decorations, context);
    decorateTranslationFailures(state, decorations, context);
    decorateCorrections(state, decorations, context);
    return Decoration.set(decorations, true);
}

function decorateTranslationPairs(state, decorations, context) {
    for (const pair of context.translationPairs) {
        decorateTranslationPairRange(
            state,
            decorations,
            pair.source,
            pair,
            'source',
            context.highlightedTranslationBlockID === pair.id
        );
        decorateTranslationPairRange(
            state,
            decorations,
            pair.translated,
            pair,
            'translated',
            context.highlightedTranslationBlockID === pair.id
        );
    }
}

function decorateTranslationPairRange(
    state,
    decorations,
    range,
    pair,
    side,
    highlighted
) {
    if (!range) return;
    const fromLine = state.doc.lineAt(range.from).number;
    const toLine = state.doc.lineAt(Math.max(range.from, range.to - 1)).number;
    for (let lineNumber = fromLine; lineNumber <= toLine; lineNumber++) {
        decorations.push(Decoration.line({
            class: [
                'cm-mktero-translation-pair',
                `cm-mktero-translation-pair-${side}`,
                highlighted ? 'is-translation-pair-active' : '',
            ].filter(Boolean).join(' '),
            attributes: {
                'data-translation-block-id': pair.id,
            },
        }).range(state.doc.line(lineNumber).from));
    }
}

function decorateTranslationFailures(state, decorations, context) {
    for (const failure of context.translationFailures) {
        const fromLine = state.doc.lineAt(failure.from).number;
        const toLine = state.doc.lineAt(Math.max(
            failure.from,
            failure.to - 1
        )).number;
        for (let lineNumber = fromLine; lineNumber <= toLine; lineNumber++) {
            decorations.push(Decoration.line({
                class: 'cm-mktero-translation-failure-line',
                attributes: { lang: '' },
            }).range(state.doc.line(lineNumber).from));
        }
        decorations.push(Decoration.widget({
            block: true,
            side: -1,
            widget: new TranslationFailureWidget(
                context.translate('ai.translationFailedBlock')
            ),
        }).range(state.doc.lineAt(failure.from).from));
    }
}

function decorateTranslationRanges(state, decorations, context) {
    for (const range of context.translationRanges) {
        const fromLine = state.doc.lineAt(range.from).number;
        const toLine = state.doc.lineAt(Math.max(range.from, range.to - 1)).number;
        for (let lineNumber = fromLine; lineNumber <= toLine; lineNumber++) {
            decorations.push(Decoration.line({
                class: 'cm-mktero-translation-line',
                attributes: {
                    ...(lineNumber === fromLine
                        ? { 'data-translation-start': 'true' }
                        : {}),
                    ...(range.language ? { lang: range.language } : {}),
                },
            }).range(state.doc.line(lineNumber).from));
        }
    }
}

function normalizeTranslationRanges(ranges, documentLength) {
    if (!Array.isArray(ranges)) return [];
    return ranges.flatMap(range => (
        Number.isSafeInteger(range?.from)
        && Number.isSafeInteger(range?.to)
        && range.from >= 0
        && range.to > range.from
        && range.to <= documentLength
            ? [{
                from: range.from,
                to: range.to,
                language: normalizeTranslationLanguage(range.language),
            }]
            : []
    ));
}

function normalizeTranslationLanguage(language) {
    const value = String(language || '').trim();
    return isSupportedAITargetLanguage(value) ? value : '';
}

function normalizeTranslationFailures(failures, documentLength) {
    if (!Array.isArray(failures)) return [];
    const seen = new Set();
    return failures.flatMap(failure => {
        const id = String(failure?.id || '');
        if (!id || seen.has(id)
            || !Number.isSafeInteger(failure?.from)
            || !Number.isSafeInteger(failure?.to)
            || failure.from < 0
            || failure.to <= failure.from
            || failure.to > documentLength) {
            return [];
        }
        seen.add(id);
        return [{
            id,
            from: failure.from,
            to: failure.to,
        }];
    });
}

function normalizeTranslationPairs(pairs, documentLength) {
    if (!Array.isArray(pairs)) return [];
    const seen = new Set();
    const acceptedRanges = [];
    return pairs.flatMap(pair => {
        const id = String(pair?.id || '');
        const source = normalizeTranslationPairRange(
            pair?.sourceFrom,
            pair?.sourceTo,
            documentLength
        );
        const translated = normalizeTranslationPairRange(
            pair?.translatedFrom,
            pair?.translatedTo,
            documentLength
        );
        if (!isStableTranslationBlockID(id)
            || seen.has(id)
            || !source && !translated
            || source && overlapsTranslationPairRange(source, acceptedRanges)
            || translated && overlapsTranslationPairRange(
                translated,
                [...acceptedRanges, source].filter(Boolean)
            )) {
            return [];
        }
        seen.add(id);
        if (source) acceptedRanges.push(source);
        if (translated) acceptedRanges.push(translated);
        return [{
            id,
            source,
            translated,
        }];
    });
}

function isStableTranslationBlockID(id) {
    return /^[A-Za-z0-9._:-]{1,256}$/.test(id);
}

function overlapsTranslationPairRange(range, accepted) {
    return accepted.some(candidate => (
        range.from < candidate.to && range.to > candidate.from
    ));
}

function normalizeTranslationPairRange(from, to, documentLength) {
    return Number.isSafeInteger(from)
        && Number.isSafeInteger(to)
        && from >= 0
        && to > from
        && to <= documentLength
        ? { from, to }
        : null;
}

function decoratePDFAnnotations(state, decorations, context, renderedRanges) {
    for (const annotation of context.annotationOverlay?.matched || []) {
        const validRanges = (annotation.ranges || []).filter(range => (
            validAnnotationRange(range, state.doc.length)
        ));
        const noteOffset = annotationStartOffset(validRanges);
        for (const range of annotation.ranges || []) {
            if (!validAnnotationRange(range, state.doc.length)) continue;
            if (rangesOverlapEditing(range, context)) continue;
            if (renderedRanges.some(rendered => rangeContains(rendered, range))) {
                continue;
            }
            decorations.push(Decoration.mark({
                class: annotationClassName(annotation),
                attributes: annotationAttributes(annotation, context.translate),
            }).range(range.from, range.to));
        }
        const noteRendered = renderedRanges.some(range => (
            rangeContainsStartOffset(range, noteOffset)
        ));
        if (noteOffset !== null
            && !noteRendered
            && !positionInsideEditing(noteOffset, context)
            && annotationHasComment(annotation)) {
            decorations.push(Decoration.widget({
                widget: new AnnotationNoteWidget(annotation, context.translate),
                side: -1,
            }).range(noteOffset));
        }
    }
}

function validAnnotationRange(range, documentLength) {
    return Number.isInteger(range?.from)
        && Number.isInteger(range?.to)
        && range.from >= 0
        && range.to > range.from
        && range.to <= documentLength;
}

function rangeContains(outer, inner) {
    return inner.from >= outer.from && inner.to <= outer.to;
}

function rangeContainsStartOffset(range, offset) {
    return Number.isInteger(offset)
        && offset >= range.from
        && offset < range.to;
}

function annotationStartOffset(ranges) {
    let startOffset = null;
    for (const range of ranges || []) {
        if (!Number.isInteger(range?.from)
            || !Number.isInteger(range?.to)
            || range.to <= range.from) {
            continue;
        }
        startOffset = Math.min(startOffset ?? range.from, range.from);
    }
    return startOffset;
}

function decorateCitations(state, decorations, context) {
    const result = citationAnalysis(state, context);
    const hiddenSuperscriptMarkup = new Set();
    const superscriptContent = new Map();
    for (const affiliation of result.affiliations) {
        const markup = affiliation.markerMarkup;
        if (!markup
            || rangesOverlapEditing(affiliation, context)
            || citationRangeIsExcluded(state, markup.contentFrom)) {
            continue;
        }
        hideSuperscriptMarkup(decorations, markup, hiddenSuperscriptMarkup);
        decorations.push(Decoration.mark({
            class: [
                'cm-mktero-affiliation-marker',
                markup.raiseContent
                    ? 'cm-mktero-citation-superscript'
                    : '',
            ].filter(Boolean).join(' '),
        }).range(markup.contentFrom, markup.contentTo));
    }
    for (const citation of result.citations) {
        const markup = citation.superscriptMarkup;
        if (rangesOverlapEditing(citation, context)
            || citationRangeIsExcluded(state, citation.from)) {
            continue;
        }
        if (markup) {
            hideSuperscriptMarkup(
                decorations,
                markup,
                hiddenSuperscriptMarkup
            );
            rememberSuperscriptContent(
                superscriptContent,
                markup,
                citation
            );
        }
        decorations.push(Decoration.mark({
            class: citationClassName(citation),
            attributes: citationAttributes(citation, context.translate),
        }).range(citation.from, citation.to));
    }
    decorateSuperscriptResidue(decorations, superscriptContent);

    const highlighted = context.citationTargets.get(
        context.highlightedReferenceID
    );
    if (highlighted) {
        decorations.push(Decoration.mark({
            class: 'cm-mktero-reference-highlight',
        }).range(highlighted.from, highlighted.to));
    }
}

function rememberSuperscriptContent(content, markup, citation) {
    if (!markup.raiseContent) return;
    const key = `${markup.wrapperFrom}:${markup.wrapperTo}`;
    const entry = content.get(key) || { markup, citationRanges: [] };
    entry.citationRanges.push({ from: citation.from, to: citation.to });
    content.set(key, entry);
}

function decorateSuperscriptResidue(decorations, content) {
    for (const { markup, citationRanges } of content.values()) {
        let from = markup.contentFrom;
        const ranges = citationRanges.sort((left, right) => (
            left.from - right.from || left.to - right.to
        ));
        for (const range of ranges) {
            if (from < range.from) {
                decorations.push(Decoration.mark({
                    class: 'cm-mktero-citation-superscript',
                }).range(from, range.from));
            }
            from = Math.max(from, range.to);
        }
        if (from < markup.contentTo) {
            decorations.push(Decoration.mark({
                class: 'cm-mktero-citation-superscript',
            }).range(from, markup.contentTo));
        }
    }
}

function hideSuperscriptMarkup(decorations, markup, hiddenMarkup) {
    const markupKey = `${markup.wrapperFrom}:${markup.wrapperTo}`;
    if (hiddenMarkup.has(markupKey)) return;
    hiddenMarkup.add(markupKey);
    if (markup.wrapperFrom < markup.contentFrom) {
        decorations.push(Decoration.replace({}).range(
            markup.wrapperFrom,
            markup.contentFrom
        ));
    }
    if (markup.contentTo < markup.wrapperTo) {
        decorations.push(Decoration.replace({}).range(
            markup.contentTo,
            markup.wrapperTo
        ));
    }
}

function citationAnalysis(state, context) {
    if (context.citationAnalysisDocument === state.doc) {
        return context.citationAnalysis;
    }
    const result = analyzeMarkdownCitations(state.doc.toString());
    context.citationAnalysisDocument = state.doc;
    context.citationAnalysis = result;
    context.citationTargets = new Map(
        [...result.references, ...result.affiliations]
            .map(target => [target.id, target])
    );
    return result;
}

function createReferenceAnalysisCache(analyze, {
    indexTargetsByFrom = false,
} = {}) {
    return {
        analyze,
        document: null,
        result: null,
        targets: new Map(),
        targetsByFrom: indexTargetsByFrom ? new Map() : null,
    };
}

function referenceAnalysis(state, cache) {
    if (cache.document === state.doc) return cache.result;
    const result = cache.analyze(state.doc.toString());
    cache.document = state.doc;
    cache.result = result;
    cache.targets = new Map(
        result.targets.map(target => [target.id, target])
    );
    if (cache.targetsByFrom) {
        cache.targetsByFrom = new Map(
            result.targets.map(target => [target.from, target])
        );
    }
    return result;
}

function decorateTableReferences(state, decorations, context) {
    decoratePreviewReferences(
        state,
        decorations,
        context,
        referenceAnalysis(state, context.tableReferences).references,
        context.tableReferences.targets,
        {
            className: 'cm-mktero-table-reference',
            targetAttribute: 'data-table-target-id',
        }
    );
}

function decorateFigureReferences(state, decorations, context) {
    decoratePreviewReferences(
        state,
        decorations,
        context,
        referenceAnalysis(state, context.figureReferences).references,
        context.figureReferences.targets,
        {
            className: 'cm-mktero-figure-reference',
            targetAttribute: 'data-figure-target-id',
        }
    );
}

function decoratePreviewReferences(
    state,
    decorations,
    context,
    references,
    targets,
    { className, targetAttribute }
) {
    for (const reference of references) {
        const target = targets.get(reference.targetId);
        if (!target || rangesOverlapEditing(reference, context)) continue;
        decorations.push(Decoration.mark({
            class: className,
            attributes: {
                role: 'link',
                tabindex: '0',
                'aria-label': context.translate('reference.previewAndJump', {
                    label: target.label,
                }),
                [targetAttribute]: target.id,
            },
        }).range(reference.from, reference.to));
    }
}

function citationRangeIsExcluded(state, position) {
    let node = syntaxTree(state).resolveInner(position, 1);
    while (node) {
        if (['InlineCode', 'FencedCode', 'CodeBlock', 'Image', 'URL', 'HTMLBlock']
            .includes(node.name)) {
            return true;
        }
        if (node.name === 'Link') {
            const source = state.sliceDoc(node.from, node.to);
            return !isBracketedNumericCitation(source);
        }
        node = node.parent;
    }
    return false;
}

function citationLabel(targets, kind, translate) {
    if (kind === 'affiliation') {
        if (targets.length === 1) {
            return translate('citation.viewAffiliationOne', {
                number: targets[0].label ?? targets[0].number,
            });
        }
        return translate('citation.viewAffiliationMany', {
            count: targets.length,
        });
    }
    if (targets.length === 1) {
        const target = targets[0];
        return Number.isInteger(target.number)
            ? translate('citation.viewReferenceNumber', { number: target.number })
            : translate('citation.viewReferenceText', { text: target.text });
    }
    return translate('citation.viewReferenceMany', { count: targets.length });
}

function citationElement(event, view) {
    const citation = event.target?.closest?.('.cm-mktero-citation');
    return citation && view.dom.contains(citation) ? citation : null;
}

function referenceInteraction(event, view, context) {
    const noteMarker = annotationNoteElement(event, view);
    if (noteMarker) {
        const target = context.annotationTargets.get(
            noteMarker.getAttribute('data-annotation-id') || ''
        );
        if (!target) return null;
        const openNote = () => {
            closeReferencePopupsExcept(context, context.annotationPopup);
            context.annotationPopup?.openNote({
                anchor: noteMarker,
                annotation: target,
            });
        };
        return {
            element: noteMarker,
            popup: context.annotationPopup,
            open() {},
            activate: openNote,
        };
    }
    const citation = citationElement(event, view);
    if (citation) {
        return {
            element: citation,
            popup: context.citationPopup,
            open() {
                closeReferencePopupsExcept(context, context.citationPopup);
                openCitationPopup(citation, view, context);
            },
            focusPopup() {
                closeReferencePopupsExcept(context, context.citationPopup);
                openCitationPopup(citation, view, context, true);
            },
            activate() {
                activateCitationElement(citation, view, context);
            },
        };
    }
    const previewReference = previewReferenceInteraction(event, view, context);
    if (previewReference) return previewReference;

    const annotation = annotationElement(event, view);
    if (annotation) {
        const target = context.annotationTargets.get(
            annotation.getAttribute('data-annotation-id') || ''
        );
        if (!target) return null;
        const openActions = focus => {
            closeReferencePopupsExcept(context, context.annotationPopup);
            context.annotationPopup?.openActions({
                anchor: annotation,
                annotation: target,
                focus,
            });
        };
        const openNote = () => {
            closeReferencePopupsExcept(context, context.annotationPopup);
            context.annotationPopup?.openNote({
                anchor: annotation,
                annotation: target,
            });
        };
        return {
            element: annotation,
            popup: context.annotationPopup,
            open() {
                context.annotationPopup?.scheduleOpenActions?.({
                    anchor: annotation,
                    annotation: target,
                    beforeOpen: () => closeReferencePopupsExcept(
                        context,
                        context.annotationPopup
                    ),
                });
            },
            cancelOpen: () => (
                context.annotationPopup?.cancelScheduledOpen?.(annotation)
            ),
            openImmediately: () => openActions(false),
            focusPopup: () => openActions(true),
            activate: openNote,
            allowTextSelection: true,
        };
    }
    return null;
}

function hasSelectedInteractionText(view, element) {
    const selection = view.dom.ownerDocument.getSelection?.();
    if (!selection || selection.isCollapsed) return false;
    return element.contains(selection.anchorNode)
        || element.contains(selection.focusNode);
}

export function selectedMarkdownAnnotation(view, chromeRanges = []) {
    const selection = view.dom.ownerDocument.getSelection?.();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
        return null;
    }
    const range = selection.getRangeAt(0);
    if (!selectionNodeInEditor(view, range.startContainer)
        || !selectionNodeInEditor(view, range.endContainer)) {
        return null;
    }
    const selectedText = selection.toString();
    if (!selectedText.trim()) return null;
    const renderedStart = renderedSelectionContainer(
        range.startContainer,
        view
    );
    const renderedEnd = renderedSelectionContainer(range.endContainer, view);
    if (renderedStart || renderedEnd) {
        return renderedStart && renderedStart === renderedEnd
            ? selectedRenderedMarkdownAnnotation(
                view,
                range,
                selectedText,
                chromeRanges
            )
            : null;
    }
    const renderedIntersections = intersectingRenderedContent(view, range);
    if (renderedIntersections === null) return null;
    try {
        const first = view.posAtDOM(range.startContainer, range.startOffset);
        const second = view.posAtDOM(range.endContainer, range.endOffset);
        const selectionFrom = Math.min(first, second);
        const selectionTo = Math.max(first, second);
        const leadingWhitespace = selectedText.length
            - selectedText.trimStart().length;
        const trailingWhitespace = selectedText.length
            - selectedText.trimEnd().length;
        const from = selectionFrom + leadingWhitespace;
        const to = selectionTo - trailingWhitespace;
        if (to <= from) return null;
        if (renderedIntersections.length) {
            return selectedInlineMathAnnotation(
                view,
                renderedIntersections,
                from,
                to,
                chromeRanges
            );
        }
        return annotationSelectionWithoutChrome(view, from, to, chromeRanges);
    }
    catch {
        return null;
    }
}

function annotationSelectionWithoutChrome(view, from, to, chromeRanges) {
    const ranges = subtractChromeRanges({ from, to }, chromeRanges);
    if (!ranges.length) return null;
    const text = visibleTextForRanges(view.state.doc.toString(), ranges).trim();
    if (!text || text.length > MAX_PDF_ANNOTATION_TEXT_LENGTH) return null;
    return { text, ranges };
}

function selectedRenderedMarkdownAnnotation(
    view,
    range,
    selectedText,
    chromeRanges = []
) {
    const start = renderedSelectionContainer(range.startContainer, view);
    const end = renderedSelectionContainer(range.endContainer, view);
    if (!start || start !== end) return null;
    const sourceFrom = Number(start.dataset.markdownFrom);
    const sourceTo = Number(start.dataset.markdownTo);
    if (!Number.isInteger(sourceFrom)
        || !Number.isInteger(sourceTo)
        || sourceFrom < 0
        || sourceTo <= sourceFrom
        || sourceTo > view.state.doc.length) {
        return null;
    }
    const text = selectedText.trim();
    if (!text || text.length > MAX_PDF_ANNOTATION_TEXT_LENGTH) return null;
    const source = view.state.sliceDoc(sourceFrom, sourceTo);
    const content = renderedMarkdownContentContainer(start);
    const renderedOffset = renderedSelectionTextOffset(
        content,
        range,
        selectedText
    );
    if (renderedOffset === null) return null;
    const renderedCandidates = findTextOccurrences(
        content.textContent || '',
        text,
        MAX_MATCH_CANDIDATES
    );
    if (renderedCandidates.truncated) return null;
    const ordinal = renderedCandidates.offsets.indexOf(renderedOffset);
    if (ordinal < 0) return null;
    const visible = createVisibleMarkdownTextIndex(source);
    const candidates = findTextOccurrences(
        visible.text,
        text,
        MAX_MATCH_CANDIDATES
    );
    if (candidates.truncated || ordinal >= candidates.offsets.length) {
        return null;
    }
    const selectedRange = visible.sourceRange(
        candidates.offsets[ordinal],
        text.length
    );
    const ranges = subtractChromeRanges({
        from: sourceFrom + selectedRange.from,
        to: sourceFrom + selectedRange.to,
    }, chromeRanges);
    if (!ranges.length) return null;
    return { text, ranges };
}

function renderedSelectionTextOffset(container, range, selectedText) {
    const document = container.ownerDocument;
    const prefix = document.createRange();
    try {
        prefix.selectNodeContents(container);
        prefix.setEnd(range.startContainer, range.startOffset);
    }
    catch {
        return null;
    }
    const leadingWhitespace = selectedText.length
        - selectedText.trimStart().length;
    return prefix.toString().length + leadingWhitespace;
}

function intersectingRenderedContent(view, range) {
    if (typeof range.intersectsNode !== 'function') return null;
    const intersections = [];
    for (const container of view.dom.querySelectorAll(
        '.cm-mktero-rendered[data-markdown-from][data-markdown-to]'
    )) {
        try {
            if (range.intersectsNode(container)) intersections.push(container);
        }
        catch {
            return null;
        }
    }
    return intersections;
}

function selectedInlineMathAnnotation(
    view,
    containers,
    from,
    to,
    chromeRanges = []
) {
    for (const container of containers) {
        const markdownFrom = Number(container.dataset.markdownFrom);
        const markdownTo = Number(container.dataset.markdownTo);
        if (!container.classList.contains('cm-mktero-math')
            || !Number.isSafeInteger(markdownFrom)
            || !Number.isSafeInteger(markdownTo)
            || markdownFrom < from
            || markdownTo > to) {
            return null;
        }
    }
    const visible = createVisibleMarkdownTextIndex(
        view.state.sliceDoc(from, to)
    ).text;
    const text = normalizeText(visible);
    if (!text || text.length > MAX_PDF_ANNOTATION_TEXT_LENGTH) return null;
    const ranges = subtractChromeRanges({ from, to }, chromeRanges);
    if (!ranges.length) return null;
    return { text, ranges };
}

function renderedSelectionContainer(node, view) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    const container = element?.closest?.(
        '.cm-mktero-rendered[data-markdown-from][data-markdown-to]'
    );
    return container && view.dom.contains(container) ? container : null;
}

function selectionNodeInEditor(view, node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    return Boolean(element && view.dom.contains(element));
}

export function selectionAnchor(selection, fallback, pointer) {
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const rect = pointerSelectionRect(range, pointer)
        || firstVisibleSelectionRect(range, fallback)
        || fallback?.getBoundingClientRect?.()
        || emptyRect();
    const snapshot = {
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height,
    };
    return { getBoundingClientRect: () => snapshot };
}

function pointerSelectionRect(range, pointer) {
    const clientX = Number(pointer?.clientX);
    if (!Number.isFinite(clientX)) return null;
    const tolerance = 8;
    const rect = Array.from(range?.getClientRects?.() || []).find(candidate => (
        pointerTouchesRect(pointer, candidate, tolerance)
    ));
    if (!rect) return null;
    const anchorX = Math.max(rect.left, Math.min(rect.right, clientX));
    return {
        top: rect.top,
        right: anchorX,
        bottom: rect.bottom,
        left: anchorX,
        width: 0,
        height: rect.height,
    };
}

export function pointerTouchesRect(pointer, rect, tolerance = 0) {
    const clientX = Number(pointer?.clientX);
    const clientY = Number(pointer?.clientY);
    return Number.isFinite(clientX)
        && Number.isFinite(clientY)
        && rect?.width > 0
        && rect?.height > 0
        && clientX >= rect.left - tolerance
        && clientX <= rect.right + tolerance
        && clientY >= rect.top - tolerance
        && clientY <= rect.bottom + tolerance;
}

function firstVisibleSelectionRect(range, fallback) {
    const rectangles = Array.from(range?.getClientRects?.() || [])
        .filter(rect => rect.width > 0 && rect.height > 0);
    const ownerWindow = range?.commonAncestorContainer?.ownerDocument
        ?.defaultView || fallback?.ownerDocument?.defaultView;
    const viewportWidth = ownerWindow?.innerWidth || 0;
    const viewportHeight = ownerWindow?.innerHeight || 0;
    const first = rectangles.find(rect => (
        rect.bottom > 0
        && rect.right > 0
        && rect.top < viewportHeight
        && rect.left < viewportWidth
    )) || rectangles[0];
    if (first) return mergeSelectionLineRects(rectangles, first);
    return range?.getBoundingClientRect?.() || null;
}

function mergeSelectionLineRects(rectangles, first) {
    const lineRects = rectangles.filter(rect => (
        Math.min(rect.bottom, first.bottom) > Math.max(rect.top, first.top)
    ));
    const top = Math.min(...lineRects.map(rect => rect.top));
    const right = Math.max(...lineRects.map(rect => rect.right));
    const bottom = Math.max(...lineRects.map(rect => rect.bottom));
    const left = Math.min(...lineRects.map(rect => rect.left));
    return {
        top,
        right,
        bottom,
        left,
        width: right - left,
        height: bottom - top,
    };
}

function emptyRect() {
    return { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 };
}

function referencePopups(context) {
    return [
        context.annotationPopup,
        context.citationPopup,
        ...previewReferenceTypes(context).map(type => type.popup),
    ];
}

function annotationElement(event, view) {
    const annotation = event.target?.closest?.('.cm-mktero-pdf-annotation');
    return annotation && view.dom.contains(annotation) ? annotation : null;
}

function annotationNoteElement(event, view) {
    const marker = event.target?.closest?.('.cm-mktero-pdf-annotation-note');
    return marker && view.dom.contains(marker) ? marker : null;
}

function closeReferencePopupsExcept(context, retainedPopup) {
    for (const popup of referencePopups(context)) {
        if (popup !== retainedPopup) popup?.close();
    }
}

function selectionActionsLocked(context) {
    return Boolean(context.annotationPopup?.isSelectionOpen?.());
}

function previewReferenceTypes(context) {
    return [
        {
            selector: '.cm-mktero-table-reference',
            targetAttribute: 'data-table-target-id',
            targets: context.tableReferences.targets,
            popup: context.tablePreviewPopup,
            activate: context.activateTableReference,
        },
        {
            selector: '.cm-mktero-figure-reference',
            targetAttribute: 'data-figure-target-id',
            targets: context.figureReferences.targets,
            popup: context.figurePreviewPopup,
            activate: context.activateFigureReference,
        },
    ];
}

function previewReferenceInteraction(event, view, context) {
    for (const type of previewReferenceTypes(context)) {
        const element = event.target?.closest?.(type.selector);
        if (!element || !view.dom.contains(element)) continue;
        const target = type.targets.get(
            element.getAttribute(type.targetAttribute) || ''
        );
        if (!target) return null;
        return {
            element,
            popup: type.popup,
            open() {
                closeReferencePopupsExcept(context, type.popup);
                type.popup?.open({ anchor: element, target });
            },
            activate() {
                type.popup?.close();
                type.activate?.(view, target);
            },
        };
    }
    return null;
}

function targetsForCitation(citation, context) {
    return (citation.getAttribute('data-citation-ids') || '')
        .split(/\s+/)
        .map(id => context.citationTargets.get(id))
        .filter(Boolean);
}

function openCitationPopup(citation, view, context, focusFirst = false) {
    const kind = citation.getAttribute('data-citation-kind');
    context.citationPopup?.open({
        anchor: citation,
        targets: targetsForCitation(citation, context),
        label: context.translate(kind === 'affiliation'
            ? 'citation.affiliations'
            : 'citation.details'),
        focusFirst,
        sourceItemID: context.sourceItemID,
        onListReferenceLibraries: context.onListReferenceLibraries,
        onGetReferenceStatus: context.onGetReferenceStatus,
        onSearchReferenceMetadata: context.onSearchReferenceMetadata,
        onImportReference: context.onImportReference,
        onOpenReferenceMatch: context.onOpenReferenceMatch,
        onSubscribeReferenceUpdates: context.onSubscribeReferenceUpdates,
        onActivate(target) {
            context.activateCitation?.(
                view,
                target,
                citationOrigin(citation)
            );
        },
    });
}

function activateCitationElement(citation, view, context) {
    const target = targetsForCitation(citation, context)[0];
    if (!target) return false;
    context.citationPopup?.close();
    context.activateCitation?.(view, target, citationOrigin(citation));
    return true;
}

function citationOrigin(citation) {
    const from = Number(citation.getAttribute('data-citation-from'));
    const to = Number(citation.getAttribute('data-citation-to'));
    return Number.isSafeInteger(from) && Number.isSafeInteger(to)
        ? { from, to }
        : null;
}

function decorateSyntaxNode(node, state, decorations, context) {
    if (node.name === 'CommentBlock'
        && state.sliceDoc(node.from, node.to).trim()
            === BILINGUAL_LIST_BOUNDARY
        && context.translationRanges.some(range => (
            range.from >= node.to
            && !state.sliceDoc(node.to, range.from).trim()
        ))) {
        decorations.push(Decoration.line({
            class: 'cm-mktero-bilingual-boundary',
        }).range(state.doc.lineAt(node.from).from));
        decorations.push(Decoration.replace({}).range(node.from, node.to));
        return false;
    }

    if (isHeadingNode(node.name)) {
        const level = Number(node.name.at(-1));
        decorations.push(Decoration.line({
            class: `cm-mktero-heading cm-mktero-heading-${level}`,
        }).range(node.from));
        return;
    }

    const inlineClasses = {
        StrongEmphasis: 'cm-mktero-strong',
        Emphasis: 'cm-mktero-emphasis',
        Strikethrough: 'cm-mktero-strikethrough',
        InlineCode: 'cm-mktero-code',
    };
    if (inlineClasses[node.name]) {
        decorations.push(Decoration.mark({
            class: inlineClasses[node.name],
        }).range(node.from, node.to));
        return;
    }

    if (['HeaderMark', 'EmphasisMark', 'StrikethroughMark', 'CodeMark'].includes(node.name)) {
        const parent = node.node.parent;
        if (parent) {
            let to = node.to;
            if (node.name === 'HeaderMark' && state.sliceDoc(to, to + 1) === ' ') to++;
            decorations.push(Decoration.replace({}).range(node.from, to));
        }
        return;
    }

    if (node.name === 'Escape'
        && state.sliceDoc(node.from, node.from + 1) === '\\') {
        decorations.push(Decoration.replace({}).range(node.from, node.from + 1));
        return;
    }

    if (node.name === 'Link') {
        const source = state.sliceDoc(node.from, node.to);
        if (!isBracketedNumericCitation(source)
            && findLinkURL(state, node.from + 1)) {
            decorateLink(node, state, decorations);
        }
        return;
    }

    if (node.name === 'Autolink') {
        const url = node.node.getChild('URL');
        if (url) {
            decorations.push(Decoration.mark({
                class: 'cm-mktero-link',
            }).range(url.from, url.to));
            if (node.from < url.from) {
                decorations.push(Decoration.replace({}).range(node.from, url.from));
            }
            if (url.to < node.to) {
                decorations.push(Decoration.replace({}).range(url.to, node.to));
            }
        }
        return false;
    }

    if (node.name === 'URL') {
        const parentName = node.node.parent?.name;
        if (!['Link', 'Autolink', 'LinkReference'].includes(parentName)) {
            decorations.push(Decoration.mark({
                class: 'cm-mktero-link',
            }).range(node.from, node.to));
        }
        return;
    }

    if (node.name === 'LinkReference') {
        decorations.push(Decoration.replace({}).range(node.from, node.to));
        return false;
    }

    if (node.name === 'QuoteMark') {
        const parent = node.node.parent;
        const line = state.doc.lineAt(node.from);
        decorations.push(Decoration.line({
            class: 'cm-mktero-blockquote',
        }).range(line.from));
        if (parent) {
            let to = node.to;
            if (state.sliceDoc(to, to + 1) === ' ') to++;
            decorations.push(Decoration.replace({}).range(node.from, to));
        }
        return;
    }

    if (node.name === 'ListMark') {
        const item = node.node.parent;
        if (item) {
            const listType = item.parent?.name;
            const ordered = listType === 'OrderedList';
            decorations.push(Decoration.replace({
                widget: new TextMarkerWidget(
                    ordered ? state.sliceDoc(node.from, node.to) : '•',
                    ordered ? 'cm-mktero-list-number' : 'cm-mktero-list-bullet'
                ),
            }).range(node.from, node.to));
        }
        return;
    }

    if (node.name === 'TaskMarker') {
        const task = node.node.parent;
        if (task) {
            decorations.push(Decoration.replace({
                widget: new TaskCheckboxWidget(
                    /x/i.test(state.sliceDoc(node.from, node.to)),
                    context.translate('editor.taskItem')
                ),
            }).range(node.from, node.to));
        }
        return;
    }

    if (node.name === 'HorizontalRule') {
        decorations.push(renderedRange(node, state, 'divider', context));
        return false;
    }

    if (node.name === 'Table') {
        decorations.push(renderedRange(node, state, 'table', context));
        return false;
    }
    if (['FencedCode', 'CodeBlock'].includes(node.name)) {
        const range = node.name === 'CodeBlock'
            ? { from: state.doc.lineAt(node.from).from, to: node.to }
            : node;
        decorations.push(renderedRange(range, state, 'code-block', context));
        return false;
    }
    if (['HTMLBlock', 'CommentBlock'].includes(node.name)
        && shouldRenderHTMLBlock(state.sliceDoc(node.from, node.to))) {
        decorations.push(renderedRange(node, state, 'html-block', context));
        return false;
    }
    if (node.name === 'Image') {
        const parent = node.node.parent;
        const blockRange = parent?.name === 'Paragraph'
            ? standaloneImageLineRange(node, state)
            : null;
        if (blockRange) {
            decorations.push(renderedRange(blockRange, state, 'image', context));
            return false;
        }
        decorations.push(Decoration.replace({
            widget: new RenderedMarkdownWidget({
                source: state.sliceDoc(node.from, node.to),
                display: 'image-inline',
                from: node.from,
                ...context,
            }),
        }).range(node.from, node.to));
        return false;
    }
    return undefined;
}

function standaloneImageLineRange(node, state) {
    const line = state.doc.lineAt(node.from);
    if (node.to > line.to) return null;
    if (state.sliceDoc(line.from, node.from).trim()) return null;
    if (state.sliceDoc(node.to, line.to).trim()) return null;
    return { from: line.from, to: line.to };
}

function decorateLink(node, state, decorations) {
    const marks = node.node.getChildren('LinkMark');
    const closingLabel = marks.find(mark => state.sliceDoc(mark.from, mark.to) === ']');
    if (!marks.length || !closingLabel) return;
    const labelFrom = marks[0].to;
    const labelTo = closingLabel.from;
    if (labelFrom < labelTo) {
        decorations.push(Decoration.mark({
            class: 'cm-mktero-link',
        }).range(labelFrom, labelTo));
        decorations.push(Decoration.replace({}).range(node.from, labelFrom));
        decorations.push(Decoration.replace({}).range(labelTo, node.to));
    }
}

function decorateMath(
    node,
    state,
    decorations,
    excludedRanges,
    context,
    renderDisplayMath,
    renderedMathRanges
) {
    const source = state.sliceDoc(node.from, node.to);
    const displayMatches = findDisplayMathMatches(source);
    const displayRanges = displayMatches.map(match => ({
        from: node.from + match.start,
        to: node.from + match.end,
    }));
    if (renderDisplayMath) {
        for (const match of displayMatches) {
            const matchFrom = node.from + match.start;
            const matchTo = node.from + match.end;
            decorations.push(renderedMathRange(
                match.raw,
                matchFrom,
                matchTo,
                'math-display',
                context
            ));
            renderedMathRanges.push({ from: matchFrom, to: matchTo });
        }
    }

    for (const match of findInlineMathMatches(source)) {
        const matchFrom = node.from + match.start;
        const matchTo = node.from + match.end;
        if (rangeOverlapsAny(matchFrom, matchTo, displayRanges)
            || rangeOverlapsAny(matchFrom, matchTo, excludedRanges)) continue;
        if (hasSuperscriptCitationMarkup(
            state,
            context,
            matchFrom,
            matchTo
        )) {
            continue;
        }
        const citationContent = dollarWrappedNumericCitationContent(match.raw);
        if (citationContent) {
            const contentFrom = matchFrom + citationContent.from;
            const contentTo = matchFrom + citationContent.to;
            if (matchFrom < contentFrom) {
                decorations.push(Decoration.replace({}).range(matchFrom, contentFrom));
            }
            if (contentTo < matchTo) {
                decorations.push(Decoration.replace({}).range(contentTo, matchTo));
            }
            continue;
        }
        decorations.push(renderedMathRange(
            match.raw,
            matchFrom,
            matchTo,
            'math',
            context,
            true,
            findAncestorAt(state, matchFrom, 'Link') ? 'cm-mktero-link' : ''
        ));
        renderedMathRanges.push({ from: matchFrom, to: matchTo });
    }
}

function hasSuperscriptCitationMarkup(state, context, from, to) {
    const result = citationAnalysis(state, context);
    return result.citations.some(citation => (
        citation.superscriptMarkup?.wrapperFrom === from
            && citation.superscriptMarkup.wrapperTo === to
    )) || result.affiliations.some(affiliation => (
        affiliation.markerMarkup?.wrapperFrom === from
            && affiliation.markerMarkup.wrapperTo === to
    ));
}

function isBracketedNumericCitation(source) {
    return source.startsWith('[')
        && source.endsWith(']')
        && isNumericCitationContent(source.slice(1, -1).trim());
}

function dollarWrappedNumericCitationContent(source) {
    if (!source.startsWith('$') || !source.endsWith('$')) return null;
    const content = source.slice(1, -1);
    const trimmed = content.trim();
    if (!isBracketedNumericCitation(trimmed)) return null;
    const from = 1 + content.indexOf(trimmed);
    return { from, to: from + trimmed.length };
}

function renderedRange(node, state, display, context) {
    const source = node.table?.source || state.sliceDoc(node.from, node.to);
    const translationPresentation = translationPresentationForRange(
        context,
        node.from,
        node.to
    );
    const tableIsHighlighted = node.tableTarget?.id
        && node.tableTarget.id === context.highlightedTableID;
    const figureIsHighlighted = context.figureReferences.targetsByFrom
        ?.get(node.from)?.id === context.highlightedFigureID;
    const annotations = annotationsForRange(
        context.annotationOverlay,
        node.from,
        node.to
    );
    if (display === 'table') {
        const tableFrom = node.table?.from ?? node.from;
        const tableTo = node.table?.to ?? node.to;
        const correctionBlock = context.correctionBlocks.find(block => (
            block.type === 'table'
            && block.from === tableFrom
            && block.to === tableTo
        ));
        return Decoration.replace({
            widget: new RenderedTableWidget({
                source,
                annotationSource: state.sliceDoc(node.from, node.to),
                annotationSourceFrom: node.from,
                caption: node.caption,
                citations: renderedCitationDescriptors(
                    state,
                    context,
                    node.from,
                    node.to
                ),
                highlighted: tableIsHighlighted,
                annotations,
                correctionBlock,
                correctionManagementEnabled:
                    context.correctionManagementEnabled,
                corrected: context.correctedBlockIDs.has(
                    correctionBlock?.id
                ),
                commitCorrection: context.commitCorrection,
                restoreCorrection: context.restoreCorrection,
                onCorrectionError: context.onCorrectionError,
                onCorrectionEditingChange: context.onCorrectionEditingChange,
                translationPresentation,
                ...context,
            }),
            block: true,
        }).range(node.from, node.to);
    }
    return Decoration.replace({
        widget: new RenderedMarkdownWidget({
            source: state.sliceDoc(node.from, node.to),
            renderSource: node.renderSource,
            display,
            from: node.from,
            citations: display === 'image'
                || (display === 'html-block'
                    && /^\s*<table\b/i.test(source))
                ? renderedCitationDescriptors(
                    state,
                    context,
                    node.from,
                    node.to
                )
                : [],
            annotations,
            extraClassName: [
                display === 'html-block'
                    && (node.table?.kind === 'html'
                        || /^\s*<table\b/i.test(source))
                    ? 'cm-mktero-html-table'
                    : '',
                tableIsHighlighted
                    ? 'cm-mktero-table-target-highlight'
                    : '',
                figureIsHighlighted
                    ? 'cm-mktero-figure-target-highlight'
                    : '',
            ].filter(Boolean).join(' '),
            tableCaption: node.table?.kind === 'html'
                ? node.caption
                : null,
            translationPresentation,
            ...context,
        }),
        block: true,
    }).range(node.from, node.to);
}

function translationPresentationForRange(context, from, to) {
    const translationFailure = context.translationFailures.some(range => (
        from >= range.from && to <= range.to
    ));
    if (translationFailure) {
        return { language: '', sourceFallback: true };
    }
    const translation = context.translationRanges.find(range => (
        from >= range.from && to <= range.to
    ));
    return {
        language: translation?.language || '',
        sourceFallback: false,
    };
}

function decorateCorrections(state, decorations, context) {
    if (!context.correctionManagementEnabled) {
        for (const range of deletedCorrectionGapRanges(state, context)) {
            decorations.push(Decoration.replace({}).range(
                range.from,
                range.to
            ));
        }
        return;
    }
    for (const block of context.correctionBlocks) {
        if (!isRenderableTextCorrection(block, state, context)
            || rangesOverlapEditing(block, context)) {
            continue;
        }
        if (block.to > block.from) {
            decorations.push(Decoration.mark({
                class: 'cm-mktero-corrected-block',
            }).range(block.from, block.to));
        }
        decorations.push(Decoration.widget({
            widget: new CorrectionMarkerWidget(
                block,
                context.restoreCorrection,
                context.onCorrectionError,
                context.translate
            ),
            side: 1,
            block: block.from === block.to,
        }).range(block.to));
    }
}

function deletedCorrectionGapRanges(state, context) {
    const markdown = state.doc.toString();
    const ranges = [];
    for (const block of context.correctionBlocks) {
        if (!isRenderableTextCorrection(block, state, context)
            || block.from !== block.to) {
            continue;
        }
        let from = block.from;
        let to = blankSeparatorEnd(markdown, block.from);
        if (to === from) from = blankSeparatorStart(markdown, block.from);
        if (to > from) ranges.push({ from, to });
    }
    ranges.sort((left, right) => left.from - right.from);
    const merged = [];
    for (const range of ranges) {
        const previous = merged.at(-1);
        if (!previous || range.from > previous.to) {
            merged.push({ ...range });
        }
        else {
            previous.to = Math.max(previous.to, range.to);
        }
    }
    return merged;
}

function isRenderableTextCorrection(block, state, context) {
    return Boolean(block
        && typeof block === 'object'
        && typeof block.id === 'string'
        && block.id
        && isEditableTextCorrectionBlock(block)
        && Number.isSafeInteger(block.from)
        && Number.isSafeInteger(block.to)
        && block.from >= 0
        && block.to >= block.from
        && block.to <= state.doc.length
        && context.correctedBlockIDs.has(block.id));
}

function blankSeparatorEnd(markdown, position) {
    let cursor = position;
    let end = position;
    while (cursor < markdown.length) {
        let lineEnd = cursor;
        while (markdown[lineEnd] === ' ' || markdown[lineEnd] === '\t') {
            lineEnd++;
        }
        if (markdown[lineEnd] === '\r' && markdown[lineEnd + 1] === '\n') {
            lineEnd++;
        }
        if (markdown[lineEnd] !== '\n') break;
        cursor = lineEnd + 1;
        end = cursor;
    }
    return end;
}

function blankSeparatorStart(markdown, position) {
    let cursor = position;
    let start = position;
    while (cursor > 0) {
        let lineStart = cursor;
        while (markdown[lineStart - 1] === ' '
            || markdown[lineStart - 1] === '\t') {
            lineStart--;
        }
        if (markdown[lineStart - 1] !== '\n') break;
        lineStart--;
        if (markdown[lineStart - 1] === '\r') lineStart--;
        cursor = lineStart;
        start = cursor;
    }
    return start;
}

function rangesOverlapEditing(range, context) {
    const editing = context.editingRange;
    return Boolean(editing
        && range.from < editing.to
        && range.to > editing.from);
}

function rangeInsideEditing(range, context) {
    const editing = context.editingRange;
    return Boolean(editing
        && range.from >= editing.from
        && range.to <= editing.to);
}

function positionInsideEditing(position, context) {
    const editing = context.editingRange;
    return Boolean(editing
        && position >= editing.from
        && position <= editing.to);
}

function annotationsForRange(overlay, from, to) {
    return (overlay?.matched || []).flatMap(annotation => {
        const contained = (annotation.ranges || []).some(range => (
            Number.isInteger(range?.from)
            && Number.isInteger(range?.to)
            && range.from >= from
            && range.to > range.from
            && range.to <= to
        ));
        if (!contained) return [];
        return [{
            ...annotation,
            showNoteMarker: rangeContainsStartOffset(
                { from, to },
                annotationStartOffset(annotation.ranges)
            ),
        }];
    });
}

function renderedCitationDescriptors(state, context, from, to) {
    return citationAnalysis(state, context).citations
        .filter(citation => citation.from >= from && citation.to <= to)
        .map(citation => renderedCitationDescriptor(
            state,
            citation,
            from,
            to,
            context.translate
        ));
}

function renderedCitationDescriptor(
    state,
    citation,
    rangeFrom,
    rangeTo,
    translate
) {
    const markerRange = visibleCitationMarkerRange(
        state,
        citation,
        rangeFrom,
        rangeTo
    );
    const markerSource = state.sliceDoc(markerRange.from, markerRange.to);
    const targetPrefix = state.sliceDoc(markerRange.from, citation.from);
    const target = visibleMarkdownText(
        state.sliceDoc(citation.from, citation.to)
    );
    return {
        key: `${citation.from}:${citation.to}:${citation.referenceIds.join(',')}`,
        markerFrom: markerRange.from,
        marker: visibleMarkdownText(markerSource),
        targetOffset: visibleMarkdownText(targetPrefix).length,
        targetLength: target.length,
        className: citationClassName(citation),
        attributes: citationAttributes(citation, translate),
    };
}

function visibleCitationMarkerRange(state, citation, rangeFrom, rangeTo) {
    const markup = citation.superscriptMarkup;
    if (markup
        && markup.wrapperFrom >= rangeFrom
        && markup.wrapperTo <= rangeTo) {
        return { from: markup.wrapperFrom, to: markup.wrapperTo };
    }

    const prefixFrom = Math.max(rangeFrom, citation.from - 80);
    const prefix = state.sliceDoc(prefixFrom, citation.from);
    const openingOffset = prefix.lastIndexOf('[');
    const suffixTo = Math.min(rangeTo, citation.to + 80);
    const suffix = state.sliceDoc(citation.to, suffixTo);
    const closingOffset = suffix.indexOf(']');
    if (openingOffset >= 0
        && closingOffset >= 0
        && !/[\]\r\n]/.test(prefix.slice(openingOffset + 1))
        && !/[\[\r\n]/.test(suffix.slice(0, closingOffset))) {
        return {
            from: prefixFrom + openingOffset,
            to: citation.to + closingOffset + 1,
        };
    }
    return { from: citation.from, to: citation.to };
}

function visibleMarkdownText(value) {
    return String(value).replace(
        /\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g,
        '$1'
    );
}

function citationClassName(citation) {
    return [
        'cm-mktero-citation',
        citation.superscriptMarkup?.raiseContent
            ? 'cm-mktero-citation-superscript'
            : '',
    ].filter(Boolean).join(' ');
}

function citationAttributes(citation, translate) {
    return {
        role: 'link',
        tabindex: '0',
        'aria-label': citationLabel(citation.references, citation.kind, translate),
        'data-citation-ids': citation.referenceIds.join(' '),
        'data-citation-kind': citation.kind,
        'data-citation-from': String(citation.from),
        'data-citation-to': String(citation.to),
    };
}

function renderedMathRange(
    source,
    from,
    to,
    display,
    context,
    inline = false,
    extraClassName = ''
) {
    return Decoration.replace({
        widget: new RenderedMarkdownWidget({
            source,
            display,
            from,
            annotations: annotationsOverlappingRange(
                context.annotationOverlay,
                from,
                to
            ),
            extraClassName,
            ...context,
        }),
        block: !inline,
    }).range(from, to);
}

function annotationsOverlappingRange(overlay, from, to) {
    return (overlay?.matched || []).flatMap(annotation => {
        const overlaps = (annotation.ranges || []).some(range => (
            Number.isInteger(range?.from)
            && Number.isInteger(range?.to)
            && range.from < to
            && range.to > from
        ));
        return overlaps ? [{
            ...annotation,
            ranges: [{ from, to }],
            showNoteMarker: rangeContainsStartOffset(
                { from, to },
                annotationStartOffset(annotation.ranges)
            ),
        }] : [];
    });
}

function wrapRenderedMathAnnotations(container, annotations, translate) {
    for (const annotation of annotations) {
        const wrapper = container.ownerDocument.createElementNS(
            XHTML_NAMESPACE,
            'span'
        );
        wrapper.className = annotationClassName(annotation);
        for (const [name, value] of Object.entries(
            annotationAttributes(annotation, translate)
        )) {
            wrapper.setAttribute(name, value);
        }
        if (annotation.showNoteMarker) {
            const noteMarker = createAnnotationNoteMarker(
                container.ownerDocument,
                annotation,
                translate
            );
            if (noteMarker) wrapper.append(noteMarker);
        }
        wrapper.append(...container.childNodes);
        container.append(wrapper);
    }
}

function collectExcludedMathRanges(state) {
    const ranges = [];
    syntaxTree(state).iterate({
        enter(node) {
            if (['InlineCode', 'FencedCode', 'CodeBlock', 'Image', 'URL']
                .includes(node.name)) {
                ranges.push({ from: node.from, to: node.to });
            }
        },
    });
    return ranges;
}

function isHeadingNode(name) {
    return /^(?:ATXHeading[1-6]|SetextHeading[12])$/.test(name);
}

function findAncestorAt(state, position, name) {
    let node = syntaxTree(state).resolveInner(position, 1);
    while (node && node.name !== name) node = node.parent;
    return node;
}

function rangeOverlapsAny(from, to, ranges) {
    return ranges.some(range => range.from < to && range.to > from);
}

function shouldRenderHTMLBlock(source) {
    return /^\s*(?:<!--\s*zotero-page:|<table\b)/i.test(source);
}
