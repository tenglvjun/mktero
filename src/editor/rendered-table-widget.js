import { WidgetType } from '@codemirror/view';
import { parseGFMTableRow } from '../markdown/markdown-tables.js';
import { renderTableCaptionContent } from '../markdown/markdown-html.js';
import {
    appendRenderedMarkdown,
    installRenderedCitations,
    installRenderedImagePreview,
    openRenderedLink,
} from './rendered-markdown-dom.js';
import { isCorrectionInteractionTarget } from './correction-interactions.js';
import { installRenderedAnnotations } from './pdf-annotations.js';
import {
    applyTranslationPresentation,
    normalizeTranslationPresentation,
    sameTranslationPresentation,
} from './translation-presentation.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

export class RenderedTableWidget extends WidgetType {
    constructor({
        source,
        annotationSource,
        annotationSourceFrom,
        caption,
        resolveImageURL,
        openLink,
        openImagePreview,
        renderVersion,
        citations = [],
        highlighted = false,
        annotations = [],
        correctionBlock = null,
        correctionManagementEnabled = false,
        corrected = false,
        translationPresentation = {},
        commitCorrection,
        restoreCorrection,
        onCorrectionError,
        onCorrectionEditingChange,
        translate,
    }) {
        super();
        this.source = source;
        this.annotationSource = annotationSource;
        this.annotationSourceFrom = annotationSourceFrom;
        this.caption = caption;
        this.resolveImageURL = resolveImageURL;
        this.openLink = openLink;
        this.openImagePreview = openImagePreview;
        this.renderVersion = renderVersion;
        this.citations = citations;
        this.citationKey = citations.map(citation => citation.key).join('|');
        this.highlighted = highlighted;
        this.annotations = annotations;
        this.annotationKey = JSON.stringify(annotations);
        this.correctionBlock = correctionBlock;
        this.correctionManagementEnabled = correctionManagementEnabled;
        this.corrected = corrected;
        this.translationPresentation = normalizeTranslationPresentation(
            translationPresentation
        );
        this.commitCorrection = commitCorrection;
        this.restoreCorrection = restoreCorrection;
        this.onCorrectionError = onCorrectionError;
        this.onCorrectionEditingChange = onCorrectionEditingChange;
        this.translate = translate;
        this.activeCellEdits = 0;
        this.activeCellSession = null;
        this.destroyed = false;
    }

    eq(other) {
        return this.source === other.source
            && this.annotationSource === other.annotationSource
            && this.annotationSourceFrom === other.annotationSourceFrom
            && this.caption?.text === other.caption?.text
            && this.renderVersion === other.renderVersion
            && this.citationKey === other.citationKey
            && this.highlighted === other.highlighted
            && this.annotationKey === other.annotationKey
            && this.correctionBlock?.id === other.correctionBlock?.id
            && this.correctionManagementEnabled
                === other.correctionManagementEnabled
            && this.corrected === other.corrected
            && sameTranslationPresentation(
                this.translationPresentation,
                other.translationPresentation
            );
    }

    toDOM(view) {
        const document = view.dom.ownerDocument;
        const container = createHTMLNode(document, 'div');
        container.className = [
            'cm-mktero-rendered',
            'cm-mktero-table',
            this.highlighted ? 'cm-mktero-table-target-highlight' : '',
            this.corrected && this.correctionManagementEnabled
                ? 'cm-mktero-corrected-block'
                : '',
        ].filter(Boolean).join(' ');
        applyTranslationPresentation(container, this.translationPresentation);
        container.dataset.markdownFrom = String(this.annotationSourceFrom);
        container.dataset.markdownTo = String(
            this.annotationSourceFrom + this.annotationSource.length
        );
        appendRenderedMarkdown(
            container,
            this.source,
            this.resolveImageURL,
            false,
            this.translate
        );
        const table = container.querySelector('table');
        if (table && this.caption) {
            table.prepend(createTableCaption(document, this.caption));
        }
        installRenderedCitations(container, this.citations);
        this.#configureCells(container);
        installRenderedAnnotations(
            container,
            this.annotations,
            this.translate,
            {
                source: this.annotationSource,
                sourceFrom: this.annotationSourceFrom,
            }
        );
        container.addEventListener('mousedown', event => {
            if (event.target?.closest?.('img')) return;
            openRenderedLink(event, this.openLink);
        });
        installRenderedImagePreview(
            container,
            this.openImagePreview,
            this.translate
        );
        if (this.corrected && this.correctionManagementEnabled) {
            this.#appendRestoreButton(container);
        }
        return container;
    }

    ignoreEvent(event) {
        if (this.#canCorrect()) return true;
        if (event.type === 'mousedown'
            && event.target?.closest?.('.cm-mktero-pdf-annotation')) {
            return true;
        }
        return !event.target?.closest?.('.cm-mktero-pdf-annotation');
    }

    #configureCells(container) {
        const cells = [...container.querySelectorAll('th, td')];
        for (const cell of cells) setCellReadOnly(cell, true);
        if (!this.#canCorrect()) return;
        const model = parseGFMTable(this.source);
        if (!model) return;
        const columnCount = model.header.length;
        const values = [model.header, ...model.body].flat();
        cells.forEach((cell, index) => {
            const protection = this.#cellProtection(model.cellRanges[index]);
            if (protection) {
                if (protection.kind === 'annotation') {
                    cell.setAttribute(
                        'title',
                        this.translate('revision.annotationProtected')
                    );
                }
                return;
            }
            this.#configureCell(cell, {
                model,
                values,
                index,
                columnCount,
            });
        });
    }

    #cellProtection(range) {
        if (!range || !Array.isArray(this.correctionBlock?.protectedRanges)) {
            return null;
        }
        const from = this.correctionBlock.from + range.from;
        const to = this.correctionBlock.from + range.to;
        return this.correctionBlock.protectedRanges.find(protectedRange => (
            protectedRange?.from < to && protectedRange?.to > from
        )) || null;
    }

    #configureCell(cell, { model, values, index, columnCount }) {
        cell.setAttribute('tabindex', '0');
        cell.setAttribute('spellcheck', 'false');
        let editing = false;
        let busy = false;
        let originalNodes = [];
        let originalValue = '';
        let error = false;
        const notify = () => {
            if (this.destroyed) return;
            this.onCorrectionEditingChange?.({
                editing,
                dirty: editing
                    && normalizeCellValue(cell.textContent) !== originalValue,
                busy,
                error,
                save: commit,
                cancel,
            });
        };
        const finishEditing = () => {
            if (!editing) return false;
            editing = false;
            busy = false;
            setCellReadOnly(cell, true);
            this.#changeActiveCellEdits(-1);
            if (this.activeCellSession?.cell === cell) {
                this.activeCellSession = null;
            }
            return true;
        };
        const begin = () => {
            if (editing || busy) return false;
            if (this.activeCellSession
                && this.activeCellSession.cancel?.() === false) {
                return false;
            }
            editing = true;
            error = false;
            originalNodes = [...cell.childNodes].map(node => (
                node.cloneNode(true)
            ));
            originalValue = values[index] || '';
            cell.textContent = originalValue;
            setCellReadOnly(cell, false);
            this.#changeActiveCellEdits(1);
            this.activeCellSession = { cell, cancel };
            notify();
            cell.focus();
            return true;
        };
        const cancel = ({ focus = true, force = false } = {}) => {
            if (busy && !force) return false;
            if (!finishEditing()) return false;
            cell.replaceChildren(...originalNodes);
            error = false;
            notify();
            if (focus) cell.focus();
            return true;
        };
        const commit = () => {
            if (!editing || busy) return false;
            const nextValue = normalizeCellValue(cell.textContent);
            if (nextValue === originalValue) {
                notify();
                return false;
            }
            const replacementMarkdown = serializeTableCellChange({
                model,
                values,
                index,
                nextValue,
                columnCount,
            });
            busy = true;
            error = false;
            notify();
            Promise.resolve().then(() => this.commitCorrection?.({
                blockID: this.correctionBlock.id,
                replacementMarkdown,
            })).then(() => {
                if (this.destroyed) return;
                values[index] = nextValue;
                if (!editing) return;
                finishEditing();
                cell.textContent = nextValue;
                notify();
            }).catch(caughtError => {
                if (this.destroyed) return;
                busy = false;
                error = true;
                notify();
                cell.focus();
                this.onCorrectionError?.(caughtError);
            });
            return true;
        };
        cell.addEventListener('dblclick', event => {
            if (isCorrectionInteractionTarget(event.target)) return;
            event.preventDefault();
            event.stopPropagation();
            begin();
        });
        cell.addEventListener('input', () => {
            if (!editing || busy) return;
            error = false;
            notify();
        });
        cell.addEventListener('keydown', event => {
            if (!editing
                && ['Enter', 'F2'].includes(event.key)
                && !isCorrectionInteractionTarget(event.target)) {
                event.preventDefault();
                begin();
                return;
            }
            if (editing && event.key === 'Escape') {
                event.preventDefault();
                cancel();
                return;
            }
            if (editing
                && event.key === 'Enter'
                && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                commit();
            }
        });
    }

    #changeActiveCellEdits(delta) {
        this.activeCellEdits = Math.max(0, this.activeCellEdits + delta);
    }

    #canCorrect() {
        return Boolean(this.correctionBlock
            && typeof this.commitCorrection === 'function');
    }

    #appendRestoreButton(container) {
        const button = createHTMLNode(container.ownerDocument, 'button');
        button.type = 'button';
        button.className = 'cm-mktero-correction-marker';
        button.textContent = this.translate('revision.restoreBlock');
        button.setAttribute(
            'aria-label',
            this.translate('revision.restoreBlockLabel')
        );
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            button.disabled = true;
            Promise.resolve(this.restoreCorrection?.(this.correctionBlock.id))
                .catch(error => this.onCorrectionError?.(error))
                .finally(() => { button.disabled = false; });
        });
        container.append(button);
    }

    destroy() {
        const wasEditing = this.activeCellEdits > 0;
        const cancel = this.activeCellSession?.cancel;
        this.destroyed = true;
        cancel?.({ focus: false, force: true });
        this.activeCellSession = null;
        if (wasEditing) {
            this.activeCellEdits = 0;
            this.onCorrectionEditingChange?.({
                editing: false,
                dirty: false,
                busy: false,
                error: false,
                cancel,
            });
        }
    }
}

export function createTableCaption(document, caption) {
    const element = createHTMLNode(document, 'caption');
    const html = renderTableCaptionContent(caption);
    if (!html) return element;
    const DOMParserType = document.defaultView.DOMParser;
    const parsed = new DOMParserType().parseFromString(
        `<!doctype html><html><body>${html}</body></html>`,
        'text/html'
    );
    element.append(...[...parsed.body.childNodes].map(node => (
        document.importNode(node, true)
    )));
    return element;
}

function parseGFMTable(source) {
    const value = String(source);
    const trimmed = value.trim();
    const sourceOffset = value.indexOf(trimmed);
    const lines = tableSourceLines(trimmed, sourceOffset);
    if (lines.length < 2) return null;
    const header = parseGFMTableRow(lines[0].text);
    const separator = parseGFMTableRow(lines[1].text);
    if (!header.length || separator.length !== header.length) return null;
    const alignment = separator.map(cell => {
        const value = cell.trim();
        if (!/^:?-{3,}:?$/.test(value)) return null;
        if (value.startsWith(':') && value.endsWith(':')) return 'center';
        if (value.endsWith(':')) return 'right';
        if (value.startsWith(':')) return 'left';
        return 'none';
    });
    if (alignment.includes(null)) return null;
    const headerRanges = tableRowCellRanges(lines[0]);
    const bodyRanges = [];
    const body = lines.slice(2).map(line => {
        const row = parseGFMTableRow(line.text);
        const ranges = tableRowCellRanges(line);
        while (row.length < header.length) row.push('');
        while (ranges.length < header.length) ranges.push(null);
        bodyRanges.push(ranges.slice(0, header.length));
        return row.slice(0, header.length);
    });
    return {
        header,
        alignment,
        body,
        cellRanges: [
            ...headerRanges.slice(0, header.length),
            ...bodyRanges.flat(),
        ],
    };
}

function tableSourceLines(source, sourceOffset) {
    const lines = [];
    let from = 0;
    while (from < source.length) {
        const newline = source.indexOf('\n', from);
        const rawTo = newline === -1 ? source.length : newline;
        const to = rawTo > from && source[rawTo - 1] === '\r'
            ? rawTo - 1
            : rawTo;
        lines.push({
            text: source.slice(from, to),
            from: sourceOffset + from,
        });
        if (newline === -1) break;
        from = newline + 1;
    }
    return lines;
}

function tableRowCellRanges(line) {
    const leadingWhitespace = line.text.match(/^\s*/)?.[0].length || 0;
    const trailingWhitespace = line.text.match(/\s*$/)?.[0].length || 0;
    const trimmedTo = line.text.length - trailingWhitespace;
    const source = line.text.slice(leadingWhitespace, trimmedTo);
    if (!source.includes('|')) return [];
    let from = source.startsWith('|') ? 1 : 0;
    let to = source.length;
    if (source.endsWith('|') && !source.endsWith('\\|')) to--;
    const ranges = [];
    let cellFrom = from;
    for (let index = from; index < to; index++) {
        if (source[index] === '\\' && source[index + 1] === '|') {
            index++;
            continue;
        }
        if (source[index] !== '|') continue;
        ranges.push({
            from: line.from + leadingWhitespace + cellFrom,
            to: line.from + leadingWhitespace + index,
        });
        cellFrom = index + 1;
    }
    ranges.push({
        from: line.from + leadingWhitespace + cellFrom,
        to: line.from + leadingWhitespace + to,
    });
    return ranges;
}

function serializeGFMTable(table) {
    const formatRow = cells => `| ${cells.map(escapeTableCell).join(' | ')} |`;
    const separator = table.alignment.map(alignment => {
        if (alignment === 'center') return ':---:';
        if (alignment === 'right') return '---:';
        if (alignment === 'left') return ':---';
        return '---';
    });
    return [
        formatRow(table.header),
        formatRow(separator),
        ...table.body.map(formatRow),
    ].join('\n');
}

function normalizeCellValue(value) {
    return String(value || '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

function escapeTableCell(value) {
    return String(value)
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/(?<!\\)\|/g, '\\|');
}

function serializeTableCellChange({
    model,
    values,
    index,
    nextValue,
    columnCount,
}) {
    const nextValues = [...values];
    nextValues[index] = nextValue;
    const nextModel = {
        ...model,
        header: nextValues.slice(0, columnCount),
        body: [],
    };
    for (let offset = columnCount;
        offset < nextValues.length;
        offset += columnCount) {
        nextModel.body.push(nextValues.slice(offset, offset + columnCount));
    }
    return serializeGFMTable(nextModel);
}

function setCellReadOnly(cell, readOnly) {
    cell.setAttribute('contenteditable', readOnly ? 'false' : 'true');
    cell.setAttribute('aria-readonly', readOnly ? 'true' : 'false');
}

function createHTMLNode(document, tagName) {
    if (typeof document.createElementNS === 'function') {
        return document.createElementNS(XHTML_NAMESPACE, tagName);
    }
    return document.createElement(tagName);
}
