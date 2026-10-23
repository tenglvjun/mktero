import { syntaxTree } from '@codemirror/language';
import { EditorState, Prec, StateEffect, StateField } from '@codemirror/state';
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
    findAcademicTableGroups,
    findConsecutiveImagePacks,
    parseFigureLayoutMarker,
} from '../markdown/markdown-figures.js';
import { findAuthorNoteLatexCommands } from '../markdown/markdown-citations.js';
import { stripMathDelimiters } from '../markdown/math-source.js';
import {
    computeDocumentFigures,
    computeFigureReferences,
    computeMarkdownCitations,
    computeMarkdownFootnotes,
    computeTableReferences,
} from '../markdown/markdown-analysis-cache.js';
import {
    isEditableTextCorrectionBlock,
} from './correction-interactions.js';
import {
    enhanceTableCopyActions,
} from './table-copy-actions.js';
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
    installPageMarkerButtons,
    installRenderedCitations,
    installRenderedImagePreview,
    openRenderedLink,
    openRenderedPageMarker,
} from './rendered-markdown-dom.js';
import { replacePendingFigureImages } from './figure-placeholder.js';
import { rootSelectionFor } from './root-selection.js';
import {
    blockHeightRecorder,
    createBlockHeightIdentity,
    createBlockHeightMemory,
    holdBlockHeightWhileImagesLoad,
} from './block-height-memory.js';
import {
    annotationHasComment,
    annotationAttributes,
    annotationClassName,
    createAnnotationNoteMarker,
    hiddenMathTextNode,
    installRenderedAnnotations,
} from './pdf-annotations.js';
import { MAX_PDF_ANNOTATION_TEXT_LENGTH } from '../core/pdf-annotation.js';
import { collectFigureImageNodes } from '../figures/figure-model.js';
import {
    findPaperTitleHeading,
    subtractChromeRanges,
} from '../markdown/chrome-ranges.js';
import {
    createVisibleMarkdownTextIndex,
    visibleMarkdownTextForRanges,
} from '../markdown/markdown-visible-text.js';
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
import { findMarkdownDirectives, SECTION_LABEL_KEYS } from '../markdown/markdown-directives.js';
import { footnoteMarkKeys } from '../markdown/footnote-marks.js';

// Expanded sections stay open across a translation that copies the same
// directives: the key is the kind plus the ordinal of that kind. An edit
// that moves a section remaps the key through the overlapping range.
const toggleMarkdownSection = StateEffect.define();
const expandMarkdownSections = StateEffect.define();

export function markdownSectionExpandEffect(state, position) {
    const current = state.field(markdownSectionField, false);
    if (!current) return null;
    const pos = normalizeSectionPosition(position, state.doc.length);
    if (pos == null) return null;
    const section = current.sections.find(candidate => (
        positionInsideSection(state.doc, candidate, pos)
    ));
    if (!section || current.expanded.has(section.key)) return null;
    return expandMarkdownSections.of([section.key]);
}

export function expandMarkdownSectionAt(view, position) {
    const effect = markdownSectionExpandEffect(view?.state, position);
    if (!effect) return false;
    view.dispatch({ effects: effect });
    return true;
}

const markdownSectionField = StateField.define({
    create(state) {
        return {
            ...indexMarkdownDirectives(state.doc.toString()),
            expanded: new Set(),
        };
    },
    update(value, transaction) {
        let next = transaction.docChanged
            ? updateDirectiveState(value, transaction)
            : value;
        let expanded = next.expanded;
        let expandedChanged = false;
        for (const effect of transaction.effects) {
            if (effect.is(toggleMarkdownSection)) {
                const key = String(effect.value || '');
                if (!next.sections.some(section => section.key === key)) continue;
                expanded = new Set(expanded);
                if (expanded.has(key)) expanded.delete(key);
                else expanded.add(key);
                expandedChanged = true;
            }
            else if (effect.is(expandMarkdownSections)) {
                const keys = Array.isArray(effect.value) ? effect.value : [];
                let updated = null;
                for (const key of keys) {
                    if (!next.sections.some(section => section.key === key)
                        || expanded.has(key)) {
                        continue;
                    }
                    updated = updated || new Set(expanded);
                    updated.add(key);
                }
                if (updated) {
                    expanded = updated;
                    expandedChanged = true;
                }
            }
        }
        if (next === value && !expandedChanged) return value;
        return expanded === next.expanded ? next : { ...next, expanded };
    },
});

// Only a transaction that sets the selection reveals a section: a jump to
// an annotation, a search hit, or a source position. Any other transaction
// leaves a section the reader collapsed closed, even with the cursor inside.
function markdownSectionTransactionExtender(transaction) {
    if (!transaction.selection) return null;
    const current = transaction.startState.field(markdownSectionField, false);
    if (!current?.sections.length) return null;
    const head = transaction.newSelection.main.head;
    const sections = transaction.docChanged
        ? mapDirectiveSections(current.sections, transaction.changes)
        : current.sections;
    const section = sections.find(candidate => (
        positionInsideSection(transaction.newDoc, candidate, head)
    ));
    if (!section || current.expanded.has(section.key)) return null;
    if (transaction.effects.some(effect => (
        effect.is(toggleMarkdownSection) && effect.value === section.key
    ))) {
        return null;
    }
    if (transaction.effects.some(effect => (
        effect.is(expandMarkdownSections)
        && Array.isArray(effect.value)
        && effect.value.includes(section.key)
    ))) {
        return null;
    }
    return { effects: expandMarkdownSections.of([section.key]) };
}

class MarkdownSectionToggleWidget extends WidgetType {
    constructor({ key, expanded, label, actionLabel }) {
        super();
        this.key = key;
        this.expanded = expanded;
        this.label = label;
        this.actionLabel = actionLabel;
    }

    eq(other) {
        return other.key === this.key
            && other.expanded === this.expanded
            && other.label === this.label
            && other.actionLabel === this.actionLabel;
    }

    // The button stays the same element when the section opens or closes,
    // so keyboard focus stays on it.
    updateDOM(button) {
        if (!button?.classList?.contains('mktero-section-toggle')) return false;
        this.#apply(button);
        return true;
    }

    // The visible label names the section; `aria-expanded` gives its state
    // and the title the action.
    #apply(button) {
        button.dataset.sectionKey = this.key;
        button.setAttribute('aria-expanded', this.expanded ? 'true' : 'false');
        button.title = this.actionLabel;
        button.textContent = this.label;
    }

    toDOM(view) {
        const ownerDocument = view.dom.ownerDocument;
        const button = ownerDocument.createElementNS?.(XHTML_NAMESPACE, 'button')
            || ownerDocument.createElement('button');
        button.type = 'button';
        button.className = 'mktero-section-toggle';
        this.#apply(button);
        const dispatchToggle = () => {
            view.dispatch({ effects: toggleMarkdownSection.of(button.dataset.sectionKey) });
        };
        button.addEventListener('mousedown', event => {
            event.stopPropagation();
        });
        // Enter and Space toggle here, so the editor never sees them;
        // preventing their default also stops the click they would fire.
        button.addEventListener('keydown', event => {
            if (!isSectionToggleKey(event)) return;
            event.preventDefault();
            event.stopPropagation();
            dispatchToggle();
        });
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            dispatchToggle();
        });
        return button;
    }

    ignoreEvent(event) {
        return event.type !== 'mousedown'
            && event.type !== 'mouseup'
            && event.type !== 'click'
            && event.type !== 'keydown'
            && event.type !== 'keyup'
            && event.type !== 'keypress';
    }
}

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const MAX_MATCH_CANDIDATES = 10_000;
// A stable empty range list, so "no ranges" keeps one identity across renders
// and the rendering field can tell it apart from a real change.
const NO_CONTEXT_RANGES = Object.freeze([]);
const INLINE_WIDGET_DISPLAYS = new Set(['inline', 'image-inline', 'math']);

export const setReferenceHighlight = StateEffect.define();
export const setTableHighlight = StateEffect.define();
export const setFigureHighlight = StateEffect.define();
export const setFigureViews = StateEffect.define();
export const setPendingFigures = StateEffect.define();
export const setRestoredFigures = StateEffect.define();
export const setAnnotationOverlay = StateEffect.define();
export const setChromeRanges = StateEffect.define();
export const setDocumentTitle = StateEffect.define();
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
        openPageMarker,
        copyCode,
        renderVersion,
        citations = [],
        annotations = [],
        extraClassName = '',
        tableCaption = null,
        translationPresentation = {},
        translate = translateEnglish,
        pendingFigures = null,
        restoredFigures = null,
        resolveRestoredFigureURL = null,
        blockHeights = null,
    }) {
        super();
        this.source = source;
        this.renderSource = renderSource;
        this.display = display;
        this.from = from;
        this.resolveImageURL = resolveImageURL;
        this.openLink = openLink;
        this.openImagePreview = openImagePreview;
        this.openPageMarker = openPageMarker;
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
        this.pendingFigures = pendingFigures;
        this.restoredFigures = restoredFigures;
        this.resolveRestoredFigureURL = resolveRestoredFigureURL;
        this.blockHeights = blockHeights;
        this.blockHeightIdentity = INLINE_WIDGET_DISPLAYS.has(display)
            ? null
            : createBlockHeightIdentity(
                display,
                from,
                renderSource === source
                    ? source
                    : `${source}\u0000${renderSource}`
            );
    }

    get estimatedHeight() {
        return this.blockHeights?.estimate(this.blockHeightIdentity) ?? -1;
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
            && this.pendingFigures === other.pendingFigures
            && this.restoredFigures === other.restoredFigures
            && this.tableCaption?.text === other.tableCaption?.text
            && sameTranslationPresentation(
                this.translationPresentation,
                other.translationPresentation
            );
    }

    toDOM(view) {
        const document = view.dom.ownerDocument;
        const inline = INLINE_WIDGET_DISPLAYS.has(this.display);
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
            if (openRenderedPageMarker(event, this.from, this.openPageMarker)) {
                return;
            }
            openRenderedLink(event, this.openLink);
        });
        installPageMarkerButtons(container, this.from, this.openPageMarker);
        installRenderedImagePreview(
            container,
            this.openImagePreview,
            this.translate
        );
        if (this.pendingFigures?.size) {
            replacePendingFigureImages(
                container,
                this.pendingFigures,
                this.translate,
                this.restoredFigures,
                this.resolveRestoredFigureURL,
            );
        }
        if (!inline) {
            holdBlockHeightWhileImagesLoad(
                container,
                view,
                this.estimatedHeight
            );
        }
        if (this.display === 'code-block') {
            enhanceRenderedCodeBlock(container, document, {
                copyCode: this.copyCode,
                translate: this.translate,
            });
        }
        if (this.display === 'math-display') {
            // Appended after the annotation pass, which moves the container's
            // children into an annotation wrapper when one covers the formula.
            enhanceRenderedMathBlock(container, document, {
                copyCode: this.copyCode,
                translate: this.translate,
                source: this.source,
            });
        }
        if (this.extraClassName.includes('cm-mktero-html-table')) {
            // An OCR HTML table has no Markdown block behind it, so it offers
            // the CSV export only.
            enhanceTableCopyActions(container, container.querySelector('table'), {
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

// A footnote mark written as a TeX command (`$^{\dagger}$`) is shown as its
// symbol. A mark decoration cannot wrap the math widget that would cover the
// same range, so the widget carries the link itself.
class FootnoteMarkWidget extends WidgetType {
    constructor(text, className, attributes) {
        super();
        this.text = text;
        this.className = className;
        this.attributes = attributes;
    }

    eq(other) {
        return this.text === other.text
            && this.className === other.className
            && JSON.stringify(this.attributes) === JSON.stringify(other.attributes);
    }

    toDOM(view) {
        const marker = view.dom.ownerDocument.createElement('span');
        marker.className = this.className;
        for (const [name, value] of Object.entries(this.attributes)) marker.setAttribute(name, value);
        marker.textContent = this.text;
        return marker;
    }

    ignoreEvent() {
        return false;
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

/**
 * Add the copy-LaTeX action to every display formula in a rendered document.
 *
 * Saved snapshots keep TeX as text (`<pre class="math">$$…$$</pre>`) instead
 * of the reader's KaTeX MathML, so they need their own entry point next to
 * `enhanceRenderedCodeBlocks`.
 */
export function enhanceRenderedMathBlocks(
    root,
    document,
    options = {}
) {
    for (const pre of root?.querySelectorAll?.('pre.math') || []) {
        // A host that re-enhances the same tree must not nest another wrapper.
        if (pre.closest?.('.cm-mktero-math-block')) continue;
        enhanceRenderedMathBlock(
            wrapMathBlockContainer(pre, document),
            document,
            options
        );
    }
}

function wrapMathBlockContainer(pre, document) {
    const container = createHTMLNode(document, 'div');
    container.className = 'cm-mktero-math-block';
    pre.replaceWith(container);
    container.append(pre);
    return container;
}

function enhanceRenderedMathBlock(
    container,
    document,
    { copyCode, translate = translateEnglish, source = '' } = {}
) {
    if (typeof copyCode !== 'function'
        || container.querySelector('.cm-mktero-math-toolbar')) {
        return;
    }
    const latex = renderedMathSource(container, source);
    if (!latex) return;

    const toolbar = createHTMLNode(document, 'div');
    toolbar.className = 'cm-mktero-math-toolbar';
    const copyButton = createHTMLNode(document, 'button');
    copyButton.type = 'button';
    copyButton.className = 'cm-mktero-math-copy';
    copyButton.dataset.action = 'copy-math';
    copyButton.setAttribute('aria-label', translate('markdown.mathCopy'));
    copyButton.title = translate('markdown.mathCopy');
    copyButton.textContent = translate('markdown.mathCopy');
    copyButton.addEventListener('click', async event => {
        // The widget container also listens for mousedown to open links, and
        // a formula can be wrapped in an annotation that reacts to clicks.
        event.preventDefault();
        event.stopPropagation();
        if (copyButton.disabled) return;
        copyButton.disabled = true;
        try {
            await copyCode(latex);
            copyButton.dataset.state = 'copied';
            copyButton.textContent = translate('markdown.mathCopied');
        }
        catch {
            copyButton.dataset.state = 'failed';
            copyButton.textContent = translate('markdown.mathCopyFailed');
        }
        finally {
            copyButton.disabled = false;
        }
    });
    toolbar.append(copyButton);
    container.append(toolbar);
}

/**
 * Read the LaTeX behind one display formula.
 *
 * KaTeX already puts the source it rendered in the MathML `annotation`, which
 * is the normalized TeX the reader shows. A formula past the math render budget
 * falls back to `<code class="math-fallback">`, a saved snapshot keeps the raw
 * source as text, and a widget can always hand over the Markdown it rendered.
 */
function renderedMathSource(container, source = '') {
    const annotation = container.querySelector(
        'annotation[encoding="application/x-tex"]'
    );
    const annotationText = annotation?.textContent?.trim();
    if (annotationText) return annotationText;
    const fallback = container.querySelector('.math-fallback');
    // Container text is the last resort: for rendered MathML it is the flattened
    // formula, which is worse than the widget's own source.
    const raw = fallback?.textContent
        || source
        || container.textContent
        || '';
    return stripMathDelimiters(raw);
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
    const selection = rootSelectionFor(codeElement)
        || document.defaultView?.getSelection?.();
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
    resolveRestoredFigureURL,
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
    openPageMarker = null,
    activateCitation,
    activateTableReference,
    activateFigureReference,
    activateFootnoteJump,
    commitCorrection,
    restoreCorrection,
    onCorrectionError,
    onCorrectionEditingChange,
    translate = translateEnglish,
    analysisCache = null,
}) {
    const context = {
        resolveImageURL,
        resolveRestoredFigureURL,
        analysisCache,
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
        openPageMarker,
        activateCitation,
        activateTableReference,
        activateFigureReference,
        activateFootnoteJump,
        commitCorrection,
        restoreCorrection,
        onCorrectionError,
        onCorrectionEditingChange,
        translate,
        blockHeights: createBlockHeightMemory(),
        renderVersion: 0,
        highlightedReferenceID: null,
        highlightedTableID: null,
        highlightedFigureID: null,
        figureViews: null,
        pendingFigures: null,
        restoredFigures: null,
        annotationOverlay: createEmptyAnnotationOverlay(),
        chromeRanges: [],
        documentTitle: '',
        paperTitleHeading: null,
        translationRanges: [],
        translationRangesSource: null,
        translationFailures: [],
        translationFailuresSource: null,
        translationPairs: [],
        translationPairsSource: null,
        highlightedTranslationBlockID: null,
        annotationTargets: new Map(),
        editingRange: null,
        correctionManagementEnabled: false,
        correctionBlocks: [],
        correctedBlockIDs: new Set(),
        citationAnalysisDocument: null,
        citationAnalysis: null,
        citationTargets: new Map(),
        footnoteAnalysisDocument: null,
        footnoteLinks: [],
        footnoteQuoteTargets: new Map(),
        footnoteCitationTargets: new Map(),
        footnoteOwnedRanges: [],
        footnoteSuperscriptWrappers: [],
        tableReferences: createReferenceAnalysisCache(
            source => computeTableReferences(context.analysisCache, source)
        ),
        figureReferences: createReferenceAnalysisCache(
            source => computeFigureReferences(
                context.analysisCache,
                source,
                context.figureViews
            ),
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
            // `setDocument` re-dispatches its whole effect list on every model
            // update, and the normalisers below build fresh arrays, so an
            // identity check on the effect value alone is not enough. A
            // document replacement always wins: the length-dependent ranges
            // have to be re-clipped even when the caller passes the same array.
            const documentChanged = transaction.docChanged;
            let referenceHighlightChanged = false;
            let tableHighlightChanged = false;
            let figureHighlightChanged = false;
            let figureViewsChanged = false;
            let pendingFiguresChanged = false;
            let restoredFiguresChanged = false;
            let annotationOverlayChanged = false;
            let chromeRangesChanged = false;
            let documentTitleChanged = false;
            let translationRangesChanged = false;
            let translationFailuresChanged = false;
            let translationPairsChanged = false;
            let translationPairHighlightChanged = false;
            let editingRangeChanged = false;
            let correctionStateChanged = false;
            if (shouldRefresh) context.renderVersion++;
            for (const effect of transaction.effects) {
                if (effect.is(setReferenceHighlight)) {
                    if (effect.value === context.highlightedReferenceID) continue;
                    context.highlightedReferenceID = effect.value;
                    referenceHighlightChanged = true;
                }
                else if (effect.is(setTableHighlight)) {
                    if (effect.value === context.highlightedTableID) continue;
                    context.highlightedTableID = effect.value;
                    tableHighlightChanged = true;
                }
                else if (effect.is(setFigureHighlight)) {
                    if (effect.value === context.highlightedFigureID) continue;
                    context.highlightedFigureID = effect.value;
                    figureHighlightChanged = true;
                }
                else if (effect.is(setFigureViews)) {
                    const views = Array.isArray(effect.value) ? effect.value : null;
                    if (!documentChanged && views === context.figureViews) continue;
                    context.figureViews = views;
                    context.figureReferences.document = null;
                    figureViewsChanged = true;
                }
                else if (effect.is(setPendingFigures)) {
                    const pending = effect.value instanceof Map
                        ? effect.value
                        : null;
                    if (pending === context.pendingFigures) continue;
                    context.pendingFigures = pending;
                    pendingFiguresChanged = true;
                }
                else if (effect.is(setRestoredFigures)) {
                    const restored = effect.value instanceof Map
                        ? effect.value
                        : null;
                    if (restored === context.restoredFigures) continue;
                    context.restoredFigures = restored;
                    restoredFiguresChanged = true;
                }
                else if (effect.is(setAnnotationOverlay)) {
                    const overlay = effect.value
                        || createEmptyAnnotationOverlay();
                    if (overlay === context.annotationOverlay) continue;
                    context.annotationOverlay = overlay;
                    context.annotationTargets = new Map(
                        (overlay.matched || []).map(
                            annotation => [String(annotation.id || ''), annotation]
                        )
                    );
                    annotationOverlayChanged = true;
                }
                else if (effect.is(setChromeRanges)) {
                    const ranges = Array.isArray(effect.value)
                        ? effect.value
                        : NO_CONTEXT_RANGES;
                    if (!documentChanged && ranges === context.chromeRanges) continue;
                    context.chromeRanges = ranges;
                    chromeRangesChanged = true;
                }
                else if (effect.is(setDocumentTitle)) {
                    const title = String(effect.value || '');
                    if (title === context.documentTitle) continue;
                    context.documentTitle = title;
                    documentTitleChanged = true;
                }
                else if (effect.is(setTranslationRanges)) {
                    const source = effect.value || NO_CONTEXT_RANGES;
                    if (!documentChanged
                        && source === context.translationRangesSource) continue;
                    context.translationRangesSource = source;
                    context.translationRanges = normalizeTranslationRanges(
                        source,
                        transaction.state.doc.length
                    );
                    translationRangesChanged = true;
                }
                else if (effect.is(setTranslationFailures)) {
                    const source = effect.value || NO_CONTEXT_RANGES;
                    if (!documentChanged
                        && source === context.translationFailuresSource) continue;
                    context.translationFailuresSource = source;
                    context.translationFailures = normalizeTranslationFailures(
                        source,
                        transaction.state.doc.length
                    );
                    translationFailuresChanged = true;
                }
                else if (effect.is(setTranslationPairs)) {
                    const source = effect.value || NO_CONTEXT_RANGES;
                    if (!documentChanged
                        && source === context.translationPairsSource) continue;
                    context.translationPairsSource = source;
                    context.translationPairs = normalizeTranslationPairs(
                        source,
                        transaction.state.doc.length
                    );
                    translationPairsChanged = true;
                }
                else if (effect.is(setTranslationPairHighlight)) {
                    const id = String(effect.value || '');
                    const highlighted =
                        context.translationPairs.some(pair => pair.id === id)
                            ? id
                            : null;
                    if (highlighted === context.highlightedTranslationBlockID) continue;
                    context.highlightedTranslationBlockID = highlighted;
                    translationPairHighlightChanged = true;
                }
                else if (effect.is(setInlineEditingRange)) {
                    if (effect.value === context.editingRange) continue;
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
            // Typing inside the open correction block only shifts later
            // decorations. Rebuilding the whole paper here re-runs citation
            // and figure analysis on every keystroke.
            const sectionExpansionChanged = transaction.effects.some(effect => (
                effect.is(toggleMarkdownSection)
                || effect.is(expandMarkdownSections)
            ));
            if (correctionEditCanReuseDecorations(
                transaction,
                context,
                {
                    shouldRefresh,
                    sectionExpansionChanged,
                    referenceHighlightChanged,
                    tableHighlightChanged,
                    figureHighlightChanged,
                    figureViewsChanged,
                    pendingFiguresChanged,
                    restoredFiguresChanged,
                    annotationOverlayChanged,
                    chromeRangesChanged,
                    documentTitleChanged,
                    translationRangesChanged,
                    translationFailuresChanged,
                    translationPairsChanged,
                    translationPairHighlightChanged,
                    editingRangeChanged,
                    correctionStateChanged,
                }
            )) {
                context.editingRange = mapRangeThroughChanges(
                    context.editingRange,
                    transaction.changes
                );
                return decorations.map(transaction.changes);
            }
            if (transaction.docChanged && !figureViewsChanged) {
                context.figureViews = null;
                context.figureReferences.document = null;
            }
            if (transaction.docChanged
                || syntaxTreeChanged
                || referenceHighlightChanged
                || tableHighlightChanged
                || figureHighlightChanged
                || figureViewsChanged
                || pendingFiguresChanged
                || restoredFiguresChanged
                || annotationOverlayChanged
                || chromeRangesChanged
                || documentTitleChanged
                || translationRangesChanged
                || translationFailuresChanged
                || translationPairsChanged
                || translationPairHighlightChanged
                || editingRangeChanged
                || correctionStateChanged
                || sectionExpansionChanged
                || shouldRefresh) {
                return buildDecorations(transaction.state, context);
            }
            return decorations;
        },
        provide: field => EditorView.decorations.from(field),
    });
    return [
        markdownSectionField,
        EditorState.transactionExtender.of(markdownSectionTransactionExtender),
        renderingField,
        blockHeightRecorder(context.blockHeights),
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
                const targetsAnnotationPopup = event.composedPath?.()
                    .some(target => context.annotationPopup?.contains(target));
                if (!interaction
                    && !targetsAnnotationPopup
                    && event.button === 0) {
                    context.annotationPopup?.close({ saveNote: true });
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

function correctionEditCanReuseDecorations(transaction, context, flags) {
    if (!context.editingRange || !transaction.docChanged) return false;
    if (Object.values(flags).some(Boolean)) return false;
    return changesStayInside(transaction.changes, context.editingRange);
}

function changesStayInside(changes, range) {
    let inside = true;
    changes.iterChanges((from, to) => {
        if (from < range.from || to > range.to) inside = false;
    });
    return inside;
}

function mapRangeThroughChanges(range, changes) {
    if (!range) return null;
    const from = changes.mapPos(range.from, 1);
    const to = changes.mapPos(range.to, -1);
    if (!Number.isSafeInteger(from)
        || !Number.isSafeInteger(to)
        || to < from) {
        return null;
    }
    return { from, to };
}

function buildDecorations(state, context) {
    // One snapshot per rebuild. Materialising the document is cheap but it is
    // not free on a 900 KB comparison view, and this function used to ask for
    // it five separate times.
    const markdown = state.doc.toString();
    context.paperTitleHeading = findPaperTitleHeading(
        markdown,
        context.documentTitle
    );
    const decorations = [];
    const directiveLayer = collectDirectiveDecorations(
        state,
        directiveStateFor(state),
        context.translate
    );
    const directiveSkipRanges = directiveLayer.skipRanges;
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
    const algorithmGroups = findMinerUAlgorithmGroups(markdown)
        .filter(group => !rangesOverlapEditing(group, context));
    const figureGroups = (context.figureViews
        || computeDocumentFigures(context.analysisCache, markdown))
        .map(group => group.translatedCaption ? { ...group, to: group.imageRange.to } : group)
        .filter(group => !rangesOverlapEditing(group, context));
    const imagePacks = findConsecutiveImagePacks(
        markdown,
        figureGroups
    ).filter(group => !rangesOverlapEditing(group, context));
    const renderedFigureGroups = [...figureGroups, ...imagePacks];
    const tableGroups = findAcademicTableGroups(markdown)
        .filter(group => !rangesOverlapEditing(group, context));
    const renderedGroups = [
        ...algorithmGroups,
        ...renderedFigureGroups,
        ...tableGroups,
    ].filter(group => !rangeOverlapsAny(group.from, group.to, directiveSkipRanges));
    for (const group of renderedGroups) {
        if (algorithmGroups.includes(group)) {
            decorations.push(renderedRange(group, state, 'algorithm', context));
            continue;
        }
        if (tableGroups.includes(group)) {
            decorations.push(renderedRange(
                {
                    ...group,
                    tableTarget: tableTargetsByFrom.get(group.from),
                },
                state,
                group.table.kind === 'gfm' ? 'table' : 'html-block',
                context
            ));
            continue;
        }
        decorations.push(renderedRange(group, state, 'image', context));
    }

    syntaxTree(state).iterate({
        enter(node) {
            if (node.name !== 'Document'
                && rangeInsideEditing(node, context)) {
                return false;
            }
            if (rangeInsideAny(node.from, node.to, directiveSkipRanges)) {
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
    decorateFootnotes(
        state,
        decorations,
        context,
        [...renderedGroups, ...renderedMathRanges]
    );
    decorateCitations(state, decorations, context);
    decorateTableReferences(state, decorations, context);
    decorateFigureReferences(state, decorations, context);
    decorateChromeRanges(state, decorations, context);
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
    const visible = decorations.filter(decoration => (
        !decorationOverlapsRanges(decoration, directiveSkipRanges)
    ));
    for (const note of directiveLayer.notes) {
        if (decorationOverlapsRanges(note.quote, directiveSkipRanges)) continue;
        decorateNoteQuoteLines(state, visible, note.quote);
    }
    visible.push(...directiveLayer.decorations);
    return Decoration.set(visible, true);
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

function decorateChromeRanges(state, decorations, context) {
    for (const range of context.chromeRanges || []) {
        if (!validAnnotationRange(range, state.doc.length)) continue;
        decorations.push(Decoration.replace({}).range(range.from, range.to));
    }
}

function decoratePDFAnnotations(state, decorations, context, renderedRanges) {
    const chromeRanges = context.chromeRanges || [];
    for (const annotation of context.annotationOverlay?.matched || []) {
        const validRanges = (annotation.ranges || []).filter(range => (
            validAnnotationRange(range, state.doc.length)
        ));
        const visibleRanges = validRanges.flatMap(range => (
            subtractChromeRanges(range, chromeRanges)
        ));
        let noteOffset = annotationStartOffset(validRanges);
        if (offsetInsideChrome(noteOffset, chromeRanges)) {
            noteOffset = visibleRanges[0]?.from ?? null;
        }
        for (const range of visibleRanges) {
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

function offsetInsideChrome(offset, chromeRanges) {
    return Number.isInteger(offset)
        && (chromeRanges || []).some(range => (
            range.from <= offset && offset < range.to
        ));
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
    // A paired footnote owns its superscript wrapper. Decorating that same
    // range as a reference would hide the wrapper twice.
    indexFootnotes(state, context);
    const footnoteRanges = context.footnoteOwnedRanges;
    const hiddenSuperscriptMarkup = new Set();
    const superscriptContent = new Map();
    for (const affiliation of result.affiliations) {
        const markup = affiliation.markerMarkup;
        if (!markup
            || rangesOverlapEditing(affiliation, context)
            || citationRangeIsExcluded(state, markup.contentFrom)
            || overlapsFootnoteRange(
                markup.wrapperFrom,
                markup.wrapperTo,
                footnoteRanges
            )) {
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
        const wrapperFrom = markup?.wrapperFrom ?? citation.from;
        const wrapperTo = markup?.wrapperTo ?? citation.to;
        if (rangesOverlapEditing(citation, context)
            || citationRangeIsExcluded(state, citation.from)
            || overlapsFootnoteRange(wrapperFrom, wrapperTo, footnoteRanges)
            || overlapsFootnoteRange(
                citation.from,
                citation.to,
                footnoteRanges
            )) {
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
    const result = computeMarkdownCitations(
        context.analysisCache,
        state.doc.toString()
    );
    context.citationAnalysisDocument = state.doc;
    context.citationAnalysis = result;
    context.citationTargets = new Map(
        [...result.references, ...result.affiliations]
            .map(target => [target.id, target])
    );
    return result;
}

const FOOTNOTE_MATH_WRAPPER = /^(?:\$|\\\()(?:\{\s*\})?\^\s*\{\s*([^{}\r\n]{1,24}?)\s*\}(?:\$|\\\))$/u;

function indexFootnotes(state, context) {
    if (context.footnoteAnalysisDocument === state.doc) return;
    const result = computeMarkdownFootnotes(
        context.analysisCache,
        state.doc.toString()
    );
    const links = [];
    const quoteTargets = new Map();
    const citationTargets = new Map();
    const ownedRanges = [];
    const superscriptWrappers = [];
    result.notes.forEach((note, index) => {
        if (!note.citation) return;
        const citing = footnoteCitationMarkup(state, note.citation);
        const mark = footnoteMarkMarkup(state, note.mark);
        if (!citing || !mark) return;
        const id = String(index);
        const label = note.label || note.key;
        links.push({ id, label, citing, mark });
        quoteTargets.set(id, {
            id,
            from: note.quote.from,
            to: note.quote.to,
            label,
        });
        citationTargets.set(id, {
            id,
            from: note.citation.wrapperFrom,
            to: note.citation.wrapperTo,
            label,
        });
        ownedRanges.push(
            { from: citing.wrapperFrom, to: citing.wrapperTo },
            { from: mark.wrapperFrom, to: mark.wrapperTo }
        );
        if (citing.raiseContent) superscriptWrappers.push(citing);
        if (mark.raiseContent) superscriptWrappers.push(mark);
    });
    context.footnoteAnalysisDocument = state.doc;
    context.footnoteLinks = links;
    context.footnoteQuoteTargets = quoteTargets;
    context.footnoteCitationTargets = citationTargets;
    context.footnoteOwnedRanges = ownedRanges;
    context.footnoteSuperscriptWrappers = superscriptWrappers;
}

function decorateFootnotes(state, decorations, context, replacedRanges) {
    indexFootnotes(state, context);
    const hiddenMarkup = new Set();
    for (const link of context.footnoteLinks) {
        const label = { mark: link.label };
        decorateFootnoteEndpoint(
            state,
            decorations,
            context,
            link.citing,
            {
                className: 'cm-mktero-footnote-ref',
                ariaLabel: context.translate(
                    'markdown.footnote.jumpToNote',
                    label
                ),
                index: link.id,
            },
            hiddenMarkup,
            replacedRanges
        );
        decorateFootnoteEndpoint(
            state,
            decorations,
            context,
            link.mark,
            {
                className: 'cm-mktero-footnote-back',
                ariaLabel: context.translate(
                    'markdown.footnote.backToText',
                    label
                ),
                index: link.id,
            },
            hiddenMarkup,
            replacedRanges
        );
    }
}

function decorateFootnoteEndpoint(
    state,
    decorations,
    context,
    markup,
    spec,
    hiddenMarkup,
    replacedRanges
) {
    // Only the delimiters around the mark are replaced; the mark itself may
    // hold a rendered symbol such as `\dagger`.
    if (!markup
        || rangesOverlapEditing({
            from: markup.wrapperFrom,
            to: markup.wrapperTo,
        }, context)
        || citationRangeIsExcluded(state, markup.contentFrom)
        || markup.wrapperFrom < markup.contentFrom
            && rangeOverlapsAny(markup.wrapperFrom, markup.contentFrom, replacedRanges)
        || markup.contentTo < markup.wrapperTo
            && rangeOverlapsAny(markup.contentTo, markup.wrapperTo, replacedRanges)
        || !markup.raiseContent
            && rangeOverlapsAny(markup.wrapperFrom, markup.wrapperTo, replacedRanges)) {
        return;
    }
    const className = [
        spec.className,
        markup.raiseContent ? 'cm-mktero-citation-superscript' : '',
    ].filter(Boolean).join(' ');
    const attributes = {
        role: 'link',
        tabindex: '0',
        'aria-label': spec.ariaLabel,
        'data-footnote-index': spec.index,
    };
    const content = state.sliceDoc(markup.contentFrom, markup.contentTo);
    if (markup.raiseContent && content.includes('\\')) {
        const [symbol] = footnoteMarkKeys(content);
        if (!symbol || rangeOverlapsAny(markup.wrapperFrom, markup.wrapperTo, replacedRanges)) return;
        decorations.push(Decoration.replace({
            widget: new FootnoteMarkWidget(symbol, className, attributes),
        }).range(markup.wrapperFrom, markup.wrapperTo));
        return;
    }
    if (markup.raiseContent) {
        hideSuperscriptMarkup(decorations, markup, hiddenMarkup);
    }
    decorations.push(Decoration.mark({ class: className, attributes }).range(markup.contentFrom, markup.contentTo));
}

function footnoteCitationMarkup(state, citation) {
    if (!citation
        || !validFootnoteRange(state, citation.wrapperFrom, citation.wrapperTo)
        || !validFootnoteRange(state, citation.from, citation.to)
        || citation.from < citation.wrapperFrom
        || citation.to > citation.wrapperTo) {
        return null;
    }
    return {
        wrapperFrom: citation.wrapperFrom,
        wrapperTo: citation.wrapperTo,
        contentFrom: citation.from,
        contentTo: citation.to,
        raiseContent: citation.wrapperFrom < citation.from
            || citation.to < citation.wrapperTo,
    };
}

function footnoteMarkMarkup(state, mark) {
    if (!validFootnoteRange(state, mark?.from, mark?.to)) return null;
    const raw = state.sliceDoc(mark.from, mark.to);
    const math = FOOTNOTE_MATH_WRAPPER.exec(raw);
    if (!math) {
        return {
            wrapperFrom: mark.from,
            wrapperTo: mark.to,
            contentFrom: mark.from,
            contentTo: mark.to,
            raiseContent: false,
        };
    }
    const contentFrom = mark.from + math[0].indexOf(math[1]);
    const contentTo = contentFrom + math[1].length;
    if (contentFrom < mark.from || contentTo > mark.to) return null;
    return {
        wrapperFrom: mark.from,
        wrapperTo: mark.to,
        contentFrom,
        contentTo,
        raiseContent: true,
    };
}

function validFootnoteRange(state, from, to) {
    return Number.isSafeInteger(from)
        && Number.isSafeInteger(to)
        && from >= 0
        && to > from
        && to <= state.doc.length;
}

function hasFootnoteSuperscriptMarkup(state, context, from, to) {
    indexFootnotes(state, context);
    return context.footnoteSuperscriptWrappers.some(markup => (
        markup.wrapperFrom === from && markup.wrapperTo === to
    ));
}

// The footnote layer draws a mark written as a TeX command itself.
function insideFootnoteMark(state, context, from, to) {
    indexFootnotes(state, context);
    return context.footnoteSuperscriptWrappers.some(markup => (
        markup.contentFrom <= from && to <= markup.contentTo
    ));
}

function overlapsFootnoteRange(from, to, ranges) {
    return (ranges || []).some(range => from < range.to && range.from < to);
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
    const footnote = footnoteReferenceInteraction(event, view, context);
    if (footnote) return footnote;
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
    const selection = rootSelectionFor(view.dom);
    if (!selection || selection.isCollapsed) return false;
    return element.contains(selection.anchorNode)
        || element.contains(selection.focusNode);
}

export function selectedMarkdownAnnotation(view, chromeRanges = []) {
    const selection = rootSelectionFor(view.dom);
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
        return null;
    }
    const range = selection.getRangeAt(0);
    if (!selectionNodeInEditor(view, range.startContainer)
        || !selectionNodeInEditor(view, range.endContainer)) {
        return null;
    }
    const renderedStart = renderedSelectionContainer(
        range.startContainer,
        view
    );
    const renderedEnd = renderedSelectionContainer(range.endContainer, view);
    if (renderedStart && renderedStart === renderedEnd) {
        if (isRenderedMathContainer(renderedStart)) {
            return selectedRenderedMathAnnotation(
                view,
                renderedStart,
                chromeRanges
            );
        }
        const selectedText = selection.toString();
        if (!selectedText.trim()) return null;
        return selectedRenderedMarkdownAnnotation(
            view,
            range,
            selectedText,
            chromeRanges
        );
    }
    const selectedText = selection.toString();
    if (!selectedText.trim()) return null;
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
            ) || (
                renderedIntersections.every(isRenderedMathContainer)
                    ? annotationSelectionWithoutChrome(
                        view,
                        from,
                        to,
                        chromeRanges
                    )
                    : null
            );
        }
        return annotationSelectionWithoutChrome(view, from, to, chromeRanges);
    }
    catch {
        return null;
    }
}

function annotationSelectionWithoutChrome(view, from, to, chromeRanges) {
    const markdown = view.state.doc.toString();
    const expanded = expandRangeToMathBoundaries(markdown, from, to);
    const ranges = subtractChromeRanges(expanded, chromeRanges);
    if (!ranges.length) return null;
    const text = visibleMarkdownTextForRanges(
        markdown,
        ranges
    ).trim();
    if (!text || text.length > MAX_PDF_ANNOTATION_TEXT_LENGTH) return null;
    return { text, ranges };
}

function selectedRenderedMathAnnotation(view, container, chromeRanges) {
    const sourceFrom = Number(container.dataset.markdownFrom);
    const sourceTo = Number(container.dataset.markdownTo);
    if (!Number.isInteger(sourceFrom)
        || !Number.isInteger(sourceTo)
        || sourceFrom < 0
        || sourceTo <= sourceFrom
        || sourceTo > view.state.doc.length) {
        return null;
    }
    const text = visibleMathAnnotationText(
        view.state.sliceDoc(sourceFrom, sourceTo)
    );
    if (!text || text.length > MAX_PDF_ANNOTATION_TEXT_LENGTH) return null;
    const ranges = subtractChromeRanges(
        { from: sourceFrom, to: sourceTo },
        chromeRanges
    );
    if (!ranges.length) return null;
    return { text, ranges };
}

function visibleMathAnnotationText(source) {
    const display = findDisplayMathMatches(source);
    if (coversWholeSource(source, display[0])) {
        return normalizeText(display[0].text);
    }
    const inline = findInlineMathMatches(source);
    if (coversWholeSource(source, inline[0])) {
        return normalizeText(inline[0].text);
    }
    return normalizeText(createVisibleMarkdownTextIndex(source).text);
}

function coversWholeSource(source, match) {
    return Boolean(match)
        && !source.slice(0, match.start).trim()
        && !source.slice(match.end).trim();
}

function isRenderedMathContainer(container) {
    return container.classList.contains('cm-mktero-math')
        || container.classList.contains('cm-mktero-math-display');
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
    // A figure caption is rendered from the image description; selecting it
    // annotates the caption range instead of trying to match the rendered
    // text (which includes math) against the Markdown source.
    const captionRange = renderedFigureCaptionRange(range, source);
    if (captionRange) {
        const selectedCaption = selectedRenderedCaptionRange(
            start,
            range,
            source,
            captionRange
        );
        if (!selectedCaption) return null;
        const ranges = subtractChromeRanges({
            from: sourceFrom + selectedCaption.from,
            to: sourceFrom + selectedCaption.to,
        }, chromeRanges);
        return ranges.length
            ? { text: selectedCaption.text, ranges }
            : null;
    }
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
    const selectedRange = expandRangeToMathBoundaries(
        source,
        visible.sourceRange(candidates.offsets[ordinal], text.length).from,
        visible.sourceRange(candidates.offsets[ordinal], text.length).to
    );
    const ranges = subtractChromeRanges({
        from: sourceFrom + selectedRange.from,
        to: sourceFrom + selectedRange.to,
    }, chromeRanges);
    if (!ranges.length) return null;
    return { text, ranges };
}

// The browser selection string includes the TeX source MathML keeps in a
// hidden <annotation> node, which duplicates every formula in the text. Walk
// the selection instead so the text matches what the reader shows.
function visibleSelectionText(container, range) {
    const document = container.ownerDocument;
    const walker = document.createTreeWalker(
        container,
        document.defaultView.NodeFilter.SHOW_TEXT
    );
    let text = '';
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (hiddenMathTextNode(node)) continue;
        let intersects = false;
        try {
            intersects = range.intersectsNode(node);
        }
        catch {
            intersects = false;
        }
        if (!intersects) continue;
        const from = node === range.startContainer ? range.startOffset : 0;
        const to = node === range.endContainer
            ? range.endOffset
            : node.textContent.length;
        text += node.textContent.slice(from, to);
    }
    return text;
}

function selectedRenderedCaptionRange(
    container,
    range,
    source,
    captionRange
) {
    const caption = source.slice(captionRange.from, captionRange.to);
    const visible = createVisibleMarkdownTextIndex(caption);
    const compactVisible = createCompactVisibleTextIndex(visible.text);
    const compactNeedle = compactRenderedText(
        visibleSelectionText(container, range)
    );
    const candidates = findTextOccurrences(
        compactVisible.text,
        compactNeedle,
        MAX_MATCH_CANDIDATES
    );
    if (candidates.truncated || candidates.offsets.length !== 1) return null;
    const sourceRange = compactVisible.sourceRange(
        candidates.offsets[0],
        compactNeedle.length
    );
    const mappedRange = visible.sourceRange(
        sourceRange.from,
        sourceRange.to - sourceRange.from
    );
    const expanded = expandRangeToMathBoundaries(
        source,
        captionRange.from + mappedRange.from,
        captionRange.from + mappedRange.to
    );
    const text = createVisibleMarkdownTextIndex(
        source.slice(expanded.from, expanded.to)
    ).text;
    return { from: expanded.from, to: expanded.to, text };
}

// A selection boundary inside $...$ or $$...$$ only covers part of the math
// source, which leaves a stray delimiter in the extracted text and breaks the
// PDF lookup. Growing the range to the math boundary keeps the text plain.
function expandRangeToMathBoundaries(source, from, to) {
    let start = from;
    let end = to;
    const matches = [
        ...findDisplayMathMatches(source),
        ...findInlineMathMatches(source),
    ];
    for (const match of matches) {
        if (start > match.start && start < match.end) start = match.start;
        if (end > match.start && end < match.end) end = match.end;
    }
    return { from: start, to: end };
}

function createCompactVisibleTextIndex(text) {
    const source = String(text || '');
    const output = [];
    const sourceOffsets = [];
    for (let offset = 0; offset < source.length; offset += 1) {
        if (/\s/u.test(source[offset])) continue;
        output.push(source[offset]);
        sourceOffsets.push(offset);
    }
    return {
        text: output.join(''),
        sourceRange(from, length) {
            return {
                from: sourceOffsets[from],
                to: sourceOffsets[from + length - 1] + 1,
            };
        },
    };
}

function compactRenderedText(value) {
    return String(value || '').replace(/\s+/gu, '');
}

function normalizeVisibleText(value) {
    return String(value || '').replace(/\s+/gu, ' ').trim();
}

function renderedFigureCaptionRange(range, source) {
    const node = range.startContainer;
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    if (!element?.closest?.('figcaption')) return null;
    const captioned = collectFigureImageNodes(source).filter(image => (
        image.captionRange.to > image.captionRange.from
    ));
    return captioned.length === 1 ? captioned[0].captionRange : null;
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

// Hover must not replace selection actions or a note the reader is typing.
function selectionActionsLocked(context) {
    return Boolean(context.annotationPopup?.isSelectionOpen?.()
        || context.annotationPopup?.isNoteOpen?.());
}

function footnoteReferenceTypes(context) {
    return [
        {
            selector: '.cm-mktero-footnote-ref',
            targetAttribute: 'data-footnote-index',
            targets: context.footnoteQuoteTargets,
            activate: context.activateFootnoteJump,
        },
        {
            selector: '.cm-mktero-footnote-back',
            targetAttribute: 'data-footnote-index',
            targets: context.footnoteCitationTargets,
            activate: context.activateFootnoteJump,
        },
    ];
}

function footnoteReferenceInteraction(event, view, context) {
    for (const type of footnoteReferenceTypes(context)) {
        const element = event.target?.closest?.(type.selector);
        if (!element || !view.dom.contains(element)) continue;
        const target = type.targets?.get(
            element.getAttribute(type.targetAttribute) || ''
        );
        if (!target) return null;
        return {
            element,
            popup: null,
            open() {},
            activate() {
                context.citationPopup?.close();
                context.tablePreviewPopup?.close();
                context.figurePreviewPopup?.close();
                type.activate?.(view, target);
            },
        };
    }
    return null;
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

    if (node.name === 'CommentBlock'
        && parseFigureLayoutMarker(state.sliceDoc(node.from, node.to))) {
        // Layout markers only drive the renderer; never show the raw comment.
        decorations.push(Decoration.replace({}).range(node.from, node.to));
        return false;
    }

    if (isHeadingNode(node.name)) {
        const level = Number(node.name.at(-1));
        const title = context.paperTitleHeading;
        const titleIndex = title?.partOffsets.indexOf(node.from) ?? -1;
        decorations.push(Decoration.line({
            class: [
                'cm-mktero-heading',
                `cm-mktero-heading-${level}`,
                titleIndex >= 0 ? 'cm-mktero-document-title' : '',
                titleIndex > 0 ? 'cm-mktero-document-title-continued' : '',
            ].filter(Boolean).join(' '),
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
        // A formula may contain link-like source such as "[L_{v|u}\phi](v)".
        // Exclude it only when the math is inside code/image/URL syntax, never
        // when the parser merely found a link inside the formula.
        if (rangeOverlapsAny(matchFrom, matchTo, displayRanges)
            || rangeInsideAny(matchFrom, matchTo, excludedRanges)) continue;
        if (hasSuperscriptCitationMarkup(
            state,
            context,
            matchFrom,
            matchTo
        ) || hasFootnoteSuperscriptMarkup(
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

    decorateAuthorNoteLatexCommands(
        source,
        node.from,
        state,
        decorations,
        excludedRanges,
        renderedMathRanges,
        context
    );
}

function decorateAuthorNoteLatexCommands(
    source,
    nodeFrom,
    state,
    decorations,
    excludedRanges,
    renderedMathRanges,
    context
) {
    for (const match of findAuthorNoteLatexCommands(source)) {
        const matchFrom = nodeFrom + match.start;
        const matchTo = nodeFrom + match.end;
        if (rangeOverlapsAny(matchFrom, matchTo, excludedRanges)
            || rangeOverlapsAny(matchFrom, matchTo, renderedMathRanges)
            || insideFootnoteMark(state, context, matchFrom, matchTo)) {
            continue;
        }
        decorations.push(renderedMathRange(
            match.raw,
            matchFrom,
            matchTo,
            'math',
            context,
            true,
            authorNoteLatexClassName(state, context, matchFrom, matchTo),
            `$${match.raw}$`
        ));
        renderedMathRanges.push({ from: matchFrom, to: matchTo });
    }
}

function authorNoteLatexClassName(state, context, from, to) {
    const result = citationAnalysis(state, context);
    const markups = [
        ...result.citations.map(citation => citation.superscriptMarkup),
        ...result.affiliations.map(affiliation => affiliation.markerMarkup),
    ].filter(Boolean);
    for (const markup of markups) {
        if (!markup.raiseContent) continue;
        if (from >= markup.contentFrom && to <= markup.contentTo) {
            return 'cm-mktero-citation-superscript';
        }
        if (from === markup.wrapperTo) {
            return 'cm-mktero-citation-superscript';
        }
    }
    return '';
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
    const highlightedFigure = context.figureReferences.targets.get(context.highlightedFigureID);
    const figureIsHighlighted = highlightedFigure?.from === node.from;
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
        const overlaps = (annotation.ranges || []).some(range => (
            Number.isInteger(range?.from)
            && Number.isInteger(range?.to)
            && range.from < to
            && range.to > from
        ));
        if (!overlaps) return [];
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
    extraClassName = '',
    renderSource = source
) {
    return Decoration.replace({
        widget: new RenderedMarkdownWidget({
            source,
            renderSource,
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
    const before = container.querySelectorAll(
        '.cm-mktero-pdf-annotation'
    ).length;
    installRenderedAnnotations(container, annotations, translate);
    const textual = container.querySelectorAll(
        '.cm-mktero-pdf-annotation'
    ).length > before;
    if (textual) return;
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

function rangeInsideAny(from, to, ranges) {
    return ranges.some(range => range.from <= from && range.to >= to);
}

function shouldRenderHTMLBlock(source) {
    return /^\s*(?:<!--\s*zotero-page:|<table\b)/i.test(source);
}

function directiveStateFor(state) {
    return state.field(markdownSectionField, false) || {
        ...indexMarkdownDirectives(state.doc.toString()),
        expanded: new Set(),
    };
}

function indexMarkdownDirectives(markdown) {
    const found = findMarkdownDirectives(markdown);
    const counts = new Map();
    return {
        notes: found.notes,
        directives: found.directives,
        sections: found.sections.map(section => {
            const ordinal = counts.get(section.kind) || 0;
            counts.set(section.kind, ordinal + 1);
            return {
                ...section,
                ordinal,
                key: `${section.kind}:${ordinal}`,
            };
        }),
    };
}

function updateDirectiveState(value, transaction) {
    if (shouldReparseDirectives(value, transaction)) {
        const next = indexMarkdownDirectives(transaction.newDoc.toString());
        return {
            ...next,
            expanded: reconcileExpandedSections(
                value.sections,
                next.sections,
                value.expanded,
                transaction.changes,
                transaction.startState.doc.length
            ),
        };
    }
    return {
        ...value,
        sections: mapDirectiveSections(value.sections, transaction.changes),
        notes: mapDirectiveNotes(value.notes, transaction.changes),
        directives: mapDirectiveRanges(value.directives, transaction.changes),
    };
}

function shouldReparseDirectives(value, transaction) {
    if (isFullDocumentReplacement(
        transaction.changes,
        transaction.startState.doc.length
    )) {
        return true;
    }
    let reparse = false;
    transaction.changes.iterChanges((from, to, _fromB, _toB, insert) => {
        if (String(insert).includes('<!--')) reparse = true;
        if (directiveRangesTouch(value, from, to)) reparse = true;
    });
    return reparse;
}

function directiveRangesTouch(value, from, to) {
    return [...value.sections, ...value.notes, ...value.directives].some(range => (
        range.from < to && from < range.to
    ));
}

function isFullDocumentReplacement(changes, length) {
    if (length === 0) return true;
    let full = false;
    changes.iterChanges((from, to) => {
        if (from === 0 && to === length) full = true;
    });
    return full;
}

function reconcileExpandedSections(
    previous,
    next,
    expanded,
    changes,
    previousLength
) {
    const nextKeys = new Set(next.map(section => section.key));
    if (isFullDocumentReplacement(changes, previousLength)) {
        return new Set([...expanded].filter(key => nextKeys.has(key)));
    }
    const mapped = previous
        .filter(section => expanded.has(section.key))
        .map(section => mapDirectiveSection(section, changes))
        .filter(Boolean);
    const used = new Set();
    const result = new Set();
    for (const section of next) {
        const index = mapped.findIndex((old, candidate) => (
            !used.has(candidate)
            && old.kind === section.kind
            && old.from < section.to
            && section.from < old.to
        ));
        if (index < 0) continue;
        used.add(index);
        result.add(section.key);
    }
    return result;
}

function mapDirectiveSections(sections, changes) {
    return sections.flatMap(section => {
        const mapped = mapDirectiveSection(section, changes);
        return mapped ? [mapped] : [];
    });
}

function mapDirectiveSection(section, changes) {
    const open = mapRangeThroughChanges(section.open, changes);
    const close = mapRangeThroughChanges(section.close, changes);
    if (!open || !close || close.from < open.to) return null;
    return {
        ...section,
        open,
        close,
        from: open.from,
        to: close.to,
        content: { from: open.to, to: close.from },
    };
}

function mapDirectiveNotes(notes, changes) {
    return notes.flatMap(note => {
        const range = mapRangeThroughChanges(note, changes);
        const quote = mapRangeThroughChanges(note.quote, changes);
        if (!range || !quote) return [];
        return [{ ...note, ...range, quote }];
    });
}

function mapDirectiveRanges(ranges, changes) {
    return ranges.flatMap(range => {
        const mapped = mapRangeThroughChanges(range, changes);
        return mapped ? [{ ...range, ...mapped }] : [];
    });
}

function normalizeSectionPosition(position, length) {
    const numeric = Number(position);
    if (!Number.isFinite(numeric)) return null;
    return Math.max(0, Math.min(Math.trunc(numeric), length));
}

function positionInsideSection(doc, section, position) {
    if (!Number.isSafeInteger(position) || !section) return false;
    return position >= sectionInteriorStart(doc, section)
        && position < section.to;
}

function sectionInteriorStart(doc, section) {
    const line = doc.lineAt(Math.min(section.open.from, doc.length));
    const commentEnd = Math.min(section.open.to, line.to);
    if (doc.sliceString(line.from, section.open.from).trim()
        || doc.sliceString(commentEnd, line.to).trim()) {
        return section.open.to;
    }
    return Math.min(doc.length, line.to < doc.length ? line.to + 1 : line.to);
}

function sectionLabel(kind, translate) {
    const key = SECTION_LABEL_KEYS[kind];
    return key ? translate(key) : kind;
}

function isSectionToggleKey(event) {
    return event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar';
}

function collectDirectiveDecorations(state, directiveState, translate) {
    const decorations = [];
    const skipRanges = [];
    const owned = new Set();
    const doc = state.doc;
    for (const section of directiveState.sections) {
        owned.add(rangeKey(section.open));
        owned.add(rangeKey(section.close));
        const expanded = directiveState.expanded.has(section.key);
        const openLine = directiveLineRange(doc, section.open.from, section.open.to);
        const closeLine = directiveLineRange(doc, section.close.from, section.close.to);
        const widget = Decoration.replace({
            widget: new MarkdownSectionToggleWidget({
                key: section.key,
                expanded,
                label: sectionLabel(section.kind, translate || translateEnglish),
                actionLabel: (translate || translateEnglish)(expanded
                    ? 'markdown.section.collapse'
                    : 'markdown.section.expand'),
            }),
            block: true,
        }).range(openLine.from, openLine.contentTo);
        decorations.push(widget);
        skipRanges.push({ from: openLine.from, to: openLine.contentTo });
        if (expanded) {
            pushCollapsedDirectiveLine(doc, decorations, skipRanges, closeLine);
            continue;
        }
        if (openLine.to < closeLine.to) {
            const hiddenRange = { from: openLine.to, to: closeLine.to };
            decorations.push(Decoration.replace({ block: true }).range(
                hiddenRange.from,
                hiddenRange.to
            ));
            skipRanges.push(hiddenRange);
        }
    }
    for (const note of directiveState.notes) {
        owned.add(rangeKey(note));
        pushHiddenDirective(doc, decorations, skipRanges, note);
    }
    for (const directive of directiveState.directives) {
        if (owned.has(rangeKey(directive))) continue;
        pushHiddenDirective(doc, decorations, skipRanges, directive);
    }
    return {
        decorations,
        skipRanges,
        notes: directiveState.notes,
    };
}

function pushHiddenDirective(doc, decorations, skipRanges, range) {
    const lineRange = directiveLineRange(doc, range.from, range.to);
    if (lineRange.to <= lineRange.from) return;
    if (skipRanges.some(skip => (
        lineRange.from >= skip.from && lineRange.contentTo <= skip.to
    ))) {
        return;
    }
    pushCollapsedDirectiveLine(doc, decorations, skipRanges, lineRange);
}

function pushCollapsedDirectiveLine(doc, decorations, skipRanges, lineRange) {
    if (!lineRange || lineRange.contentTo <= lineRange.from) return;
    decorations.push(Decoration.line({
        class: 'cm-mktero-directive-line',
    }).range(lineRange.from));
    decorations.push(Decoration.replace({}).range(lineRange.from, lineRange.contentTo));
    skipRanges.push({ from: lineRange.from, to: lineRange.contentTo });
}

// contentTo stops before the line break so the next line can still take a
// line decoration. `to` includes that break when the directive owns the line,
// which is where a collapsed section's hidden range starts.
function directiveLineRange(doc, from, to) {
    if (!Number.isSafeInteger(from)
        || !Number.isSafeInteger(to)
        || to <= from
        || doc.length === 0) {
        return { from: 0, to: 0, contentTo: 0 };
    }
    const start = Math.max(0, Math.min(from, doc.length));
    const end = Math.max(start, Math.min(to, doc.length));
    const line = doc.lineAt(start);
    const endLine = doc.lineAt(Math.max(start, end - 1));
    const ownsLine = line.number === endLine.number
        && !doc.sliceString(line.from, start).trim()
        && !doc.sliceString(end, line.to).trim();
    return {
        from: ownsLine ? line.from : start,
        contentTo: ownsLine ? line.to : end,
        to: ownsLine && endLine.to < doc.length ? endLine.to + 1 : (ownsLine ? endLine.to : end),
    };
}

function decorateNoteQuoteLines(state, decorations, quote) {
    if (!quote || quote.to <= quote.from) return;
    const fromLine = state.doc.lineAt(quote.from).number;
    const toLine = state.doc.lineAt(Math.max(quote.from, quote.to - 1)).number;
    for (let lineNumber = fromLine; lineNumber <= toLine; lineNumber++) {
        decorations.push(Decoration.line({
            class: 'cm-mktero-note',
        }).range(state.doc.line(lineNumber).from));
    }
}

function decorationOverlapsRanges(decoration, ranges) {
    return ranges.some(range => {
        if (decoration.from === decoration.to) {
            return range.from <= decoration.from && decoration.from < range.to;
        }
        return decoration.from < range.to && range.from < decoration.to;
    });
}

function rangeKey(range) {
    return `${range.from}:${range.to}`;
}
