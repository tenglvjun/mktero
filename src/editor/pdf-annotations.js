import {
    findTextOccurrences,
} from '../markdown/text-normalization.js';
import {
    createPdfAnnotationTextIndex,
    normalizePdfAnnotationText,
} from '../markdown/pdf-annotation-text.js';
import {
    createVisibleMarkdownTextIndex,
} from '../markdown/markdown-visible-text.js';
import { accessibleAnnotationText } from '../core/pdf-annotation.js';
import { translateEnglish } from '../i18n/localization.js';
import {
    createLucideIcon,
    LUCIDE_ICONS,
} from '../icons/lucide-icon.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const MAX_RENDERED_MATCH_CANDIDATES = 10_000;

export function annotationClassName(annotation) {
    const type = annotation.type === 'underline' ? 'underline' : 'highlight';
    return [
        'cm-mktero-pdf-annotation',
        `cm-mktero-pdf-annotation--${type}`,
    ].join(' ');
}

export function annotationHasComment(annotation) {
    return Boolean(String(annotation?.comment || '').trim());
}

export function annotationAttributes(annotation, translate) {
    return {
        'data-annotation-id': String(annotation.id || ''),
        style: `--mktero-annotation-color: ${safeAnnotationColor(
            annotation.color
        )}`,
        role: 'button',
        tabindex: '0',
        'aria-label': translate('annotation.edit', {
            text: accessibleAnnotationText(annotation.text),
        }),
    };
}

export function createAnnotationNoteMarker(
    document,
    annotation,
    translate = translateEnglish
) {
    if (!annotationHasComment(annotation)) return null;
    const marker = document.createElementNS(XHTML_NAMESPACE, 'span');
    marker.className = 'cm-mktero-pdf-annotation-note';
    marker.setAttribute('data-annotation-id', String(annotation.id || ''));
    marker.setAttribute(
        'style',
        `--mktero-annotation-color: ${safeAnnotationColor(annotation.color)}`
    );
    marker.setAttribute('role', 'button');
    marker.setAttribute('tabindex', '0');
    marker.setAttribute('aria-label', translate('annotation.editNote'));
    const icon = createLucideIcon(document, LUCIDE_ICONS.messageSquareText, {
        className: 'cm-mktero-pdf-annotation-note-icon',
    });
    marker.append(icon);
    return marker;
}

export function installRenderedAnnotations(
    container,
    annotations,
    translate,
    { source = '', sourceFrom = 0 } = {}
) {
    for (const annotation of annotations || []) {
        const text = String(annotation.text || '');
        if (!text) continue;
        const content = visibleContainerText(container);
        const range = renderedTextRange(
            content,
            text,
            annotation,
            source,
            sourceFrom
        );
        if (!range) continue;
        wrapTextRange(container, range.from, range.to, annotation, translate);
    }
}

// MathML keeps the TeX source in a hidden <annotation> element, so a formula
// appears twice in textContent. Matching against that text breaks any
// annotation that spans the formula, so both the search text and the range
// walker skip the hidden math source.
export function hiddenMathTextNode(node) {
    return Boolean(node?.parentElement?.closest?.(
        'annotation, annotation-xml'
    ));
}

function visibleContainerText(container) {
    const document = container?.ownerDocument;
    if (!document) return '';
    const walker = document.createTreeWalker(
        container,
        document.defaultView.NodeFilter.SHOW_TEXT
    );
    let text = '';
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (hiddenMathTextNode(node)) continue;
        text += node.textContent;
    }
    return text;
}

function renderedTextRange(
    content,
    annotationText,
    annotation,
    source,
    sourceFrom
) {
    if (source && !annotationSourceRange(annotation, source, sourceFrom)) {
        return null;
    }
    const exact = findTextOccurrences(
        content,
        annotationText,
        MAX_RENDERED_MATCH_CANDIDATES
    );
    if (!exact.truncated) {
        const ordinal = sourceOccurrenceOrdinal(
            source,
            sourceFrom,
            annotation,
            annotationText,
            false
        );
        const exactFrom = exact.offsets[ordinal ?? -1];
        if (exactFrom !== undefined) {
            return { from: exactFrom, to: exactFrom + annotationText.length };
        }
        if (exact.offsets.length === 1) {
            return {
                from: exact.offsets[0],
                to: exact.offsets[0] + annotationText.length,
            };
        }
    }
    if (exact.offsets.length) return null;

    const normalizedTarget = normalizePdfAnnotationText(annotationText);
    if (!normalizedTarget) return null;
    const index = createPdfAnnotationTextIndex(content);
    const normalized = findTextOccurrences(
        index.text,
        normalizedTarget,
        MAX_RENDERED_MATCH_CANDIDATES
    );
    if (normalized.truncated) return null;
    const ordinal = sourceOccurrenceOrdinal(
        source,
        sourceFrom,
        annotation,
        normalizedTarget,
        true
    );
    const normalizedFrom = normalized.offsets[ordinal ?? -1];
    if (normalizedFrom !== undefined) {
        return index.sourceRange(normalizedFrom, normalizedTarget.length);
    }
    const sourceDerived = sourceDerivedTextRange(
        content,
        annotation,
        source,
        sourceFrom
    );
    if (sourceDerived) return sourceDerived;
    if (normalized.offsets.length === 1) {
        return index.sourceRange(
            normalized.offsets[0],
            normalizedTarget.length
        );
    }
    return null;
}

function sourceOccurrenceOrdinal(
    source,
    sourceFrom,
    annotation,
    target,
    normalized
) {
    if (!source || !Number.isInteger(sourceFrom)) return null;
    const annotationRange = annotationSourceRange(
        annotation,
        source,
        sourceFrom
    );
    if (!annotationRange) return null;

    const visibleIndex = createVisibleMarkdownTextIndex(source);
    const index = normalized
        ? createPdfAnnotationTextIndex(
            visibleIndex.text,
            offset => visibleIndex.sourceOffsetAt(offset)
        )
        : visibleIndex;
    const candidates = findTextOccurrences(
        index.text,
        target,
        MAX_RENDERED_MATCH_CANDIDATES
    );
    if (candidates.truncated) return null;
    return candidates.offsets.findIndex(offset => {
        const range = index.sourceRange(offset, target.length);
        return range.from + sourceFrom === annotationRange.from
            && range.to + sourceFrom === annotationRange.to;
    });
}

// The saved text can differ from the rendered caption (for example when math
// delimiters or KaTeX spacing were part of the selection). The source range is
// authoritative, so when every text lookup misses, wrap the visible text that
// the range itself produces.
function sourceDerivedTextRange(content, annotation, source, sourceFrom) {
    if (!source || !Number.isInteger(sourceFrom)) return null;
    const range = annotationSourceRange(annotation, source, sourceFrom);
    if (!range) return null;
    const visible = createVisibleMarkdownTextIndex(source);
    const from = Math.max(0, range.from - sourceFrom);
    const to = Math.min(source.length, range.to - sourceFrom);
    const text = visible.visibleOffsetAt
        ? visible.text.slice(
            visible.visibleOffsetAt(from),
            visible.visibleOffsetAt(to)
        ).trim()
        : '';
    if (!text) return null;
    const at = content.indexOf(text);
    return at < 0 ? null : { from: at, to: at + text.length };
}

function annotationSourceRange(annotation, source, sourceFrom) {
    return (annotation.ranges || []).find(range => (
        Number.isInteger(range?.from)
        && Number.isInteger(range?.to)
        && range.from >= sourceFrom
        && range.to > range.from
        && range.to <= sourceFrom + source.length
    ));
}

function wrapTextRange(container, from, to, annotation, translate) {
    const document = container.ownerDocument;
    const walker = document.createTreeWalker(
        container,
        document.defaultView.NodeFilter.SHOW_TEXT
    );
    let offset = 0;
    let startNode = null;
    let startOffset = 0;
    let endNode = null;
    let endOffset = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (hiddenMathTextNode(node)) continue;
        const nextOffset = offset + node.textContent.length;
        if (!startNode && from >= offset && from < nextOffset) {
            startNode = node;
            startOffset = from - offset;
        }
        if (to > offset && to <= nextOffset) {
            endNode = node;
            endOffset = to - offset;
            break;
        }
        offset = nextOffset;
    }
    if (!startNode || !endNode) return;

    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    const element = document.createElementNS(XHTML_NAMESPACE, 'span');
    element.className = annotationClassName(annotation);
    for (const [name, value] of Object.entries(
        annotationAttributes(annotation, translate)
    )) {
        element.setAttribute(name, value);
    }
    const noteMarker = annotation.showNoteMarker === false
        ? null
        : createAnnotationNoteMarker(document, annotation, translate);
    if (noteMarker) element.append(noteMarker);
    element.append(range.extractContents());
    range.insertNode(element);
}

export function safeAnnotationColor(color) {
    const value = String(color || '').toLowerCase();
    return /^#[0-9a-f]{6}$/.test(value) ? value : '#ffd400';
}

export function annotationPageLabel(annotation) {
    if (annotation.pageLabel) return String(annotation.pageLabel);
    return Number.isInteger(annotation.pageIndex) && annotation.pageIndex >= 0
        ? String(annotation.pageIndex + 1)
        : '';
}
