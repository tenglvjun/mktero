import { renderMarkdownHTML } from '../markdown/markdown-html.js';
import { translateEnglish } from '../i18n/localization.js';

export function appendRenderedMarkdown(
    container,
    source,
    resolveImageURL,
    unwrapParagraph = false
) {
    const document = container.ownerDocument;
    const html = renderMarkdownHTML(source, { resolveImageURL });
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

export function openRenderedLink(event, openLink) {
    if (event.button !== 0) return false;
    const anchor = event.target?.closest?.('a[href]');
    if (!anchor) return false;
    event.preventDefault();
    openLink?.(anchor.getAttribute('href') || '');
    return true;
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

export function installRenderedCitations(container, citations = []) {
    const caption = container.querySelector('figcaption');
    if (!caption || !citations.length) return;

    const captionText = caption.textContent || '';
    let markerSearchFrom = 0;
    let previousMarkerFrom = null;
    let markerIndex = -1;
    for (const citation of citations) {
        if (citation.markerFrom !== previousMarkerFrom) {
            markerIndex = captionText.indexOf(
                citation.marker,
                markerSearchFrom
            );
            if (markerIndex < 0) continue;
            markerSearchFrom = markerIndex + citation.marker.length;
            previousMarkerFrom = citation.markerFrom;
        }
        if (markerIndex < 0) continue;
        wrapCaptionText(
            caption,
            markerIndex + citation.targetOffset,
            citation.targetLength,
            citation
        );
    }
}

function wrapCaptionText(caption, from, length, citation) {
    const document = caption.ownerDocument;
    const nodeFilter = document.defaultView.NodeFilter;
    const walker = document.createTreeWalker(
        caption,
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
    const element = document.createElement('span');
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
