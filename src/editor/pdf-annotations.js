import {
    createNormalizedTextIndex,
    normalizeText,
} from '../markdown/text-normalization.js';

export function annotationClassName(annotation) {
    const type = annotation.type === 'underline' ? 'underline' : 'highlight';
    return [
        'cm-mktero-pdf-annotation',
        `cm-mktero-pdf-annotation--${type}`,
    ].join(' ');
}

export function annotationAttributes(annotation, translate) {
    return {
        'data-annotation-id': String(annotation.id || ''),
        style: `--mktero-annotation-color: ${safeAnnotationColor(
            annotation.color
        )}`,
        role: 'button',
        tabindex: '0',
        'aria-label': translate('annotation.view', {
            text: accessibleAnnotationText(annotation.text),
        }),
    };
}

export function installRenderedAnnotations(
    container,
    annotations,
    translate
) {
    for (const annotation of annotations || []) {
        const text = String(annotation.text || '');
        if (!text) continue;
        const content = container.textContent || '';
        const range = uniqueTextRange(content, text);
        if (!range) continue;
        wrapTextRange(container, range.from, range.to, annotation, translate);
    }
}

function uniqueTextRange(content, annotationText) {
    const exactFrom = content.indexOf(annotationText);
    if (exactFrom >= 0
        && content.indexOf(annotationText, exactFrom + annotationText.length) < 0) {
        return { from: exactFrom, to: exactFrom + annotationText.length };
    }
    if (exactFrom >= 0) return null;

    const normalizedTarget = normalizeText(annotationText);
    if (!normalizedTarget) return null;
    const index = createNormalizedTextIndex(content);
    const normalizedFrom = index.text.indexOf(normalizedTarget);
    if (normalizedFrom < 0
        || index.text.indexOf(
            normalizedTarget,
            normalizedFrom + normalizedTarget.length
        ) >= 0) {
        return null;
    }
    return index.sourceRange(normalizedFrom, normalizedTarget.length);
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
    const element = document.createElement('span');
    element.className = annotationClassName(annotation);
    for (const [name, value] of Object.entries(
        annotationAttributes(annotation, translate)
    )) {
        element.setAttribute(name, value);
    }
    element.append(range.extractContents());
    range.insertNode(element);
}

export function safeAnnotationColor(color) {
    const value = String(color || '').toLowerCase();
    return /^#[0-9a-f]{6}$/.test(value) ? value : '#ffd400';
}

function accessibleAnnotationText(text) {
    const value = String(text || '').replace(/\s+/gu, ' ').trim();
    return value.length <= 200 ? value : `${value.slice(0, 199)}…`;
}
