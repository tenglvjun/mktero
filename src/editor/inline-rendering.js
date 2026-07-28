import { syntaxTree } from '@codemirror/language';
import { Prec, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import {
    findDisplayMathMatches,
    findInlineMathMatches,
    safeMarkdownLinkURL,
} from '../markdown/markdown-html.js';
import { translateEnglish } from '../i18n/localization.js';
import {
    findAcademicFigureGroups,
    findAcademicTableGroups,
} from '../markdown/markdown-figures.js';
import { analyzeMarkdownCitations } from '../markdown/markdown-citations.js';
import {
    analyzeMarkdownFigureReferences,
} from '../markdown/markdown-figure-references.js';
import { analyzeMarkdownTableReferences } from '../markdown/markdown-table-references.js';
import { RenderedTableWidget } from './rendered-table-widget.js';
import {
    appendRenderedMarkdown,
    installRenderedCitations,
    installRenderedImagePreview,
    openRenderedLink,
} from './rendered-markdown-dom.js';

export const setReferenceHighlight = StateEffect.define();
export const setTableHighlight = StateEffect.define();
export const setFigureHighlight = StateEffect.define();

class RenderedMarkdownWidget extends WidgetType {
    constructor({
        source,
        display,
        from,
        resolveImageURL,
        openLink,
        openImagePreview,
        renderVersion,
        citations = [],
        extraClassName = '',
        translate = translateEnglish,
    }) {
        super();
        this.source = source;
        this.display = display;
        this.from = from;
        this.resolveImageURL = resolveImageURL;
        this.openLink = openLink;
        this.openImagePreview = openImagePreview;
        this.renderVersion = renderVersion;
        this.citations = citations;
        this.citationKey = citations.map(citation => citation.key).join('|');
        this.extraClassName = extraClassName;
        this.translate = translate;
    }

    eq(other) {
        return this.source === other.source
            && this.display === other.display
            && this.from === other.from
            && this.renderVersion === other.renderVersion
            && this.citationKey === other.citationKey
            && this.extraClassName === other.extraClassName;
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
        appendRenderedMarkdown(
            container,
            this.source,
            this.resolveImageURL,
            inline
        );
        installRenderedCitations(container, this.citations);

        container.addEventListener('mousedown', event => {
            if (event.target?.closest?.('img')) return;
            openRenderedLink(event, this.openLink);
        });
        installRenderedImagePreview(
            container,
            this.openImagePreview,
            this.translate
        );
        return container;
    }

    ignoreEvent(event) {
        return !event.target?.closest?.('.cm-mktero-citation');
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

export function createInlineRenderingExtension({
    resolveImageURL,
    openLink,
    openImagePreview,
    citationPopup,
    tablePreviewPopup,
    figurePreviewPopup,
    activateCitation,
    activateTableReference,
    activateFigureReference,
    translate = translateEnglish,
}) {
    const context = {
        resolveImageURL,
        openLink,
        openImagePreview,
        citationPopup,
        tablePreviewPopup,
        figurePreviewPopup,
        activateCitation,
        activateTableReference,
        activateFigureReference,
        translate,
        renderVersion: 0,
        highlightedReferenceID: null,
        highlightedTableID: null,
        highlightedFigureID: null,
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
            let referenceHighlightChanged = false;
            let tableHighlightChanged = false;
            let figureHighlightChanged = false;
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
            }
            if (transaction.docChanged
                || referenceHighlightChanged
                || tableHighlightChanged
                || figureHighlightChanged
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
                referenceInteraction(event, view, context)?.open();
                return false;
            },
            mouseout(event, view) {
                const interaction = referenceInteraction(event, view, context);
                if (!interaction
                    || interaction.element.contains(event.relatedTarget)
                    || interaction.popup?.contains(event.relatedTarget)) {
                    return false;
                }
                interaction.popup?.scheduleClose();
                return false;
            },
            focusin(event, view) {
                referenceInteraction(event, view, context)?.open();
                return false;
            },
            focusout(event, view) {
                referenceInteraction(event, view, context)
                    ?.popup?.scheduleClose();
                return false;
            },
            mousedown(event, view) {
                if (event.button === 0
                    && referenceInteraction(event, view, context)) {
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
                    event.preventDefault();
                    interaction.activate();
                    return true;
                }
                return false;
            },
            dblclick(event, view) {
                if (referenceInteraction(event, view, context)) {
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
    const analyzedTableReferences = referenceAnalysis(
        state,
        context.tableReferences
    );
    const tableTargetsByFrom = new Map(
        analyzedTableReferences.targets.map(target => [target.from, target])
    );
    referenceAnalysis(state, context.figureReferences);
    const figureGroups = findAcademicFigureGroups(state.doc.toString());
    const tableGroups = findAcademicTableGroups(state.doc.toString());
    const renderedGroups = [...figureGroups, ...tableGroups];
    for (const group of figureGroups) {
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
                    paragraph
                );
            }
            return undefined;
        },
    });
    decorateCitations(state, decorations, context);
    decorateTableReferences(state, decorations, context);
    decorateFigureReferences(state, decorations, context);
    return Decoration.set(decorations, true);
}

function rangeContains(outer, inner) {
    return inner.from >= outer.from && inner.to <= outer.to;
}

function decorateCitations(state, decorations, context) {
    const result = citationAnalysis(state, context);
    const hiddenSuperscriptMarkup = new Set();
    const superscriptContent = new Map();
    for (const affiliation of result.affiliations) {
        const markup = affiliation.markerMarkup;
        if (!markup || citationRangeIsExcluded(state, markup.contentFrom)) {
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
        if (citationRangeIsExcluded(state, citation.from)) {
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
        if (!target) continue;
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
                number: targets[0].number,
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
    return previewReferenceInteraction(event, view, context);
}

function referencePopups(context) {
    return [
        context.citationPopup,
        ...previewReferenceTypes(context).map(type => type.popup),
    ];
}

function closeReferencePopupsExcept(context, retainedPopup) {
    for (const popup of referencePopups(context)) {
        if (popup !== retainedPopup) popup?.close();
    }
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
        onActivate(target) {
            context.activateCitation?.(view, target);
        },
    });
}

function activateCitationElement(citation, view, context) {
    const target = targetsForCitation(citation, context)[0];
    if (!target) return false;
    context.citationPopup?.close();
    context.activateCitation?.(view, target);
    return true;
}

function decorateSyntaxNode(node, state, decorations, context) {
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
        if (!isBracketedNumericCitation(source)) {
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
    renderDisplayMath
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
    return /^\[\s*\d+(?:\s*(?:[,;，；]\s*\d+|[-–—]\s*\d+))*\s*\]$/.test(
        source
    );
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
    const tableIsHighlighted = node.tableTarget?.id
        && node.tableTarget.id === context.highlightedTableID;
    const figureIsHighlighted = context.figureReferences.targetsByFrom
        ?.get(node.from)?.id === context.highlightedFigureID;
    if (display === 'table') {
        return Decoration.replace({
            widget: new RenderedTableWidget({
                source,
                caption: node.caption,
                highlighted: tableIsHighlighted,
                ...context,
            }),
            block: true,
        }).range(node.from, node.to);
    }
    return Decoration.replace({
        widget: new RenderedMarkdownWidget({
            source: state.sliceDoc(node.from, node.to),
            display,
            from: node.from,
            citations: display === 'image'
                ? renderedCitationDescriptors(
                    state,
                    context,
                    node.from,
                    node.to
                )
                : [],
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
            ...context,
        }),
        block: true,
    }).range(node.from, node.to);
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
            extraClassName,
            ...context,
        }),
        block: !inline,
    }).range(from, to);
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
