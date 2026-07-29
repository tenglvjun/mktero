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

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
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
        'aria-label': translate(
            annotationHasComment(annotation)
                ? 'annotation.viewWithNote'
                : 'annotation.view',
            { text: accessibleAnnotationText(annotation.text) }
        ),
    };
}

export function createAnnotationNoteMarker(document, annotation) {
    if (!annotationHasComment(annotation)) return null;
    const marker = document.createElementNS(XHTML_NAMESPACE, 'span');
    marker.className = 'cm-mktero-pdf-annotation-note';
    marker.setAttribute('data-annotation-id', String(annotation.id || ''));
    marker.setAttribute(
        'style',
        `--mktero-annotation-color: ${safeAnnotationColor(annotation.color)}`
    );
    marker.setAttribute('aria-hidden', 'true');
    const icon = document.createElementNS(SVG_NAMESPACE, 'svg');
    icon.setAttribute('class', 'cm-mktero-pdf-annotation-note-icon');
    icon.setAttribute('viewBox', '0 0 16 16');
    icon.setAttribute('focusable', 'false');
    const bubble = document.createElementNS(SVG_NAMESPACE, 'path');
    bubble.setAttribute('class', 'cm-mktero-pdf-annotation-note-bubble');
    bubble.setAttribute(
        'd',
        'M4 2.25h8A1.75 1.75 0 0 1 13.75 4v5A1.75 1.75 0 0 1 12 10.75H7.1L4 13.5v-2.75A1.75 1.75 0 0 1 2.25 9V4A1.75 1.75 0 0 1 4 2.25Z'
    );
    const lines = document.createElementNS(SVG_NAMESPACE, 'path');
    lines.setAttribute('class', 'cm-mktero-pdf-annotation-note-line');
    lines.setAttribute('d', 'M5 5.25h6M5 7.75h4.5');
    icon.append(bubble, lines);
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
        const content = container.textContent || '';
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
        : createAnnotationNoteMarker(document, annotation);
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
