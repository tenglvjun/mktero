import { renderInlineMathTextHTML, renderMarkdownHTML, renderSelectionMathHTML } from '../markdown/markdown-html.js';
import { translateEnglish } from '../i18n/localization.js';
import { alignedCaptionTextRange, alignRenderedCaptions } from './rendered-source-alignment.js';

export function appendRenderedMarkdown(
    container,
    source,
    resolveImageURL,
    unwrapParagraph = false,
    translate = translateEnglish
) {
    const document = container.ownerDocument;
    const html = renderMarkdownHTML(source, {
        resolveImageURL,
        translate,
        exposeImageAssetPath: true,
    });
    const DOMParserType = document.defaultView.DOMParser;
    const parsed = new DOMParserType().parseFromString(
        `<!doctype html><html><body>${html}</body></html>`,
        'text/html'
    );
    let nodes = [...parsed.body.childNodes];
    const contentNodes = nodes.filter(node => (
        node.nodeType !== document.defaultView.Node.TEXT_NODE
            || node.textContent.trim()
    ));
    if (unwrapParagraph
        && contentNodes.length === 1
        && contentNodes[0].localName === 'p') {
        nodes = [...contentNodes[0].childNodes];
    }
    container.append(...nodes.map(node => document.importNode(node, true)));
}

// Appends a line of plain text whose inline math renders, as the outline
// and the note list show headings and quotes.
export function appendInlineMathText(container, text) {
    const document = container.ownerDocument;
    const source = String(text || '');
    if (!/[$\\]/u.test(source)) {
        container.append(document.createTextNode(source));
        return;
    }
    appendMathHTML(container, renderInlineMathTextHTML(source));
}

export function appendSelectionMath(container, segments, mathBudget) {
    appendMathHTML(container, renderSelectionMathHTML(segments, mathBudget));
}

function appendMathHTML(container, html) {
    const document = container.ownerDocument;
    const parsed = new document.defaultView.DOMParser().parseFromString(
        `<!doctype html><html><body>${html}</body></html>`, 'text/html'
    );
    container.append(...[...parsed.body.childNodes].map(node => document.importNode(node, true)));
}

// What a reader sees in an element: rendered math as its symbols, without
// the TeX source MathML keeps in its annotation.
export function renderedPlainText(element) {
    const copy = element.cloneNode(true);
    for (const annotation of copy.querySelectorAll('annotation, annotation-xml')) annotation.remove();
    return String(copy.textContent || '').replace(/\s+/gu, ' ').trim();
}

export function openRenderedLink(event, openLink) {
    if (event.button !== 0) return false;
    const anchor = event.target?.closest?.('a[href]');
    if (!anchor) return false;
    event.preventDefault();
    openLink?.(anchor.getAttribute('href') || '');
    return true;
}

/**
 * Handle clicks on a page-boundary marker inside a rendered block. The
 * widget's `from` is the block start, so the marker is the page comment at
 * that offset; the callback receives the marker's document offset.
 */
export function openRenderedPageMarker(event, blockFrom, openPageMarker) {
    if (event.button !== 0 || typeof openPageMarker !== 'function') {
        return false;
    }
    const marker = event.target?.closest?.('.page-marker');
    if (!marker) return false;
    event.preventDefault();
    event.stopPropagation();
    openPageMarker(Number.isSafeInteger(blockFrom) ? blockFrom : null);
    return true;
}

/**
 * Make page markers keyboard-operable. Only applies when navigation is
 * available, so the read-only snapshot and note surfaces keep plain text.
 * The widget's `from` identifies the marker's document offset, matching the
 * click path, because each rendered block holds a single marker.
 */
export function installPageMarkerButtons(container, blockFrom, openPageMarker) {
    if (typeof openPageMarker !== 'function') return;
    for (const marker of container.querySelectorAll('.page-marker')) {
        marker.setAttribute('role', 'button');
        marker.setAttribute('tabindex', '0');
        marker.addEventListener('keydown', event => {
            if (!['Enter', ' '].includes(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            openPageMarker(Number.isSafeInteger(blockFrom) ? blockFrom : null);
        });
    }
}

export function installRenderedImagePreview(
    container,
    openImagePreview,
    translate = translateEnglish
) {
    for (const image of container.querySelectorAll('img')) {
        const alt = image.getAttribute('alt') || translate('image.fallbackAlt');
        image.setAttribute('role', 'button');
        image.setAttribute('tabindex', '0');
        image.setAttribute('aria-haspopup', 'dialog');
        image.setAttribute('aria-label', translate('image.previewNamed', { alt }));
    }
    container.addEventListener('mousedown', event => {
        if (!event.target?.closest?.('img')) return;
        event.preventDefault();
    });
    container.addEventListener('click', event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey) return;
        openImage(event.target?.closest?.('img'), event, openImagePreview);
    });
    container.addEventListener('keydown', event => {
        if (!['Enter', ' '].includes(event.key)) return;
        openImage(event.target?.closest?.('img'), event, openImagePreview);
    });
}

export function installRenderedCitations(container, citations = [], figureSource = null) {
    if (!citations.length) return;
    const caption = container.querySelector('figcaption');
    if (caption && figureSource) {
        const unplaced = installAlignedCaptionCitations(container, citations, figureSource);
        if (unplaced) {
            const table = container.querySelector('table');
            if (table) installCitationsByText(table, unplaced);
            return;
        }
    }
    const target = caption || container.querySelector('table') || container;
    installCitationsByText(target, citations);
}

function installAlignedCaptionCitations(container, citations, { source, from }) {
    const captions = alignRenderedCaptions(container, source);
    if (!captions.length) return null;
    const outsideCaptions = [];
    // Wrapping splits text nodes. Place later ranges first so earlier
    // offsets in the same text node are still valid.
    for (let index = citations.length - 1; index >= 0; index--) {
        const citation = citations[index];
        const range = { from: citation.from - from, to: citation.to - from };
        const caption = captions.find(candidate => (
            candidate.from <= range.from && range.to <= candidate.to
        ));
        if (!caption) {
            outsideCaptions.push(citation);
            continue;
        }
        const domRange = alignedCaptionTextRange(caption, range);
        if (domRange?.toString() === citation.text) wrapCitationRange(domRange, citation);
    }
    return outsideCaptions.reverse();
}

function installCitationsByText(target, citations) {
    const targetText = target.textContent || '';
    let markerSearchFrom = 0;
    let previousMarkerFrom = null;
    let markerIndex = -1;
    for (const citation of citations) {
        if (citation.markerFrom !== previousMarkerFrom) {
            markerIndex = targetText.indexOf(
                citation.marker,
                markerSearchFrom
            );
            if (markerIndex < 0) continue;
            markerSearchFrom = markerIndex + citation.marker.length;
            previousMarkerFrom = citation.markerFrom;
        }
        if (markerIndex < 0) continue;
        wrapRenderedText(
            target,
            markerIndex + citation.targetOffset,
            citation.targetLength,
            citation
        );
    }
}

function wrapRenderedText(target, from, length, citation) {
    const document = target.ownerDocument;
    const nodeFilter = document.defaultView.NodeFilter;
    const walker = document.createTreeWalker(
        target,
        nodeFilter.SHOW_TEXT
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
        if (from + length > offset && from + length <= nextOffset) {
            endNode = node;
            endOffset = from + length - offset;
            break;
        }
        offset = nextOffset;
    }
    if (!startNode || !endNode) return;

    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    wrapCitationRange(range, citation);
}

function wrapCitationRange(range, citation) {
    const ancestor = range.commonAncestorContainer;
    const parent = ancestor.nodeType === 1 ? ancestor : ancestor.parentElement;
    if (parent?.closest('a') || (range.startContainer !== range.endContainer
        && range.cloneContents().querySelector('a'))) return;
    const element = parent.ownerDocument.createElement('span');
    element.className = citation.className;
    for (const [name, value] of Object.entries(citation.attributes)) {
        element.setAttribute(name, value);
    }
    element.append(range.extractContents());
    range.insertNode(element);
}

function openImage(image, event, openImagePreview) {
    if (!image) return false;
    event.preventDefault();
    event.stopPropagation();
    openImagePreview?.({
        src: image.currentSrc || image.getAttribute('src') || '',
        alt: image.getAttribute('alt') || '',
    });
    return true;
}
