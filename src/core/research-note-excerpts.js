const HIGHLIGHT = 'span.highlight[data-annotation], span.underline[data-annotation]';
const ITEM_URI = /^https?:\/\/zotero\.org\/(?:users\/(?:local\/[A-Za-z0-9]+|\d+)|groups\/\d+)\/items\/[A-Z0-9]{8}$/u;

function decodeMetadata(node, attribute) {
    try {
        return JSON.parse(decodeURIComponent(node.getAttribute(attribute)));
    }
    catch {
        return null;
    }
}

function rectsAreValid(rects) {
    return Array.isArray(rects) && rects.length > 0
        && rects.every(rect => Array.isArray(rect) && rect.length === 4
            && rect.every(Number.isFinite));
}

function annotationSource(node) {
    const data = decodeMetadata(node, 'data-annotation');
    const position = data?.position;
    if (!ITEM_URI.test(data?.attachmentURI) || !Number.isSafeInteger(position?.pageIndex)
        || position.pageIndex < 0 || !rectsAreValid(position.rects)
        || (position.nextPageRects !== undefined && !rectsAreValid(position.nextPageRects))) return null;
    return {
        attachmentURI: data.attachmentURI,
        annotationKey: /^[A-Z0-9]{8}$/u.test(data.annotationKey) ? data.annotationKey : null,
        pageLabel: typeof data.pageLabel === 'string' ? data.pageLabel : '',
        position: {
            pageIndex: position.pageIndex,
            rects: position.rects,
            ...(position.nextPageRects ? { nextPageRects: position.nextPageRects } : {}),
        },
    };
}

function citationFor(highlight) {
    const item = decodeMetadata(highlight, 'data-annotation')?.citationItem;
    if (!Array.isArray(item?.uris) || !item.uris.length
        || !item.uris.every(uri => ITEM_URI.test(uri))) return null;
    return { uris: item.uris, locator: typeof item.locator === 'string' ? item.locator : '' };
}

function quoteText(node) {
    if (node.nodeType === 3) return node.nodeValue;
    if (node.localName === 'br') return '\n';
    if (['script', 'style', 'template'].includes(node.localName)) return '';
    return Array.from(node.childNodes || [], quoteText).join('');
}

function nextPart(node) {
    let next = node.nextSibling;
    while (next?.nodeType === 3 && !next.nodeValue.trim()) next = next.nextSibling;
    return next;
}

// A display formula can split a single native highlight across paragraphs.
function continuations(first, sourceKey) {
    const parts = [{ kind: 'quote', text: quoteText(first) }];
    let last = first;
    for (;;) {
        const next = nextPart(last);
        if (next?.matches?.(HIGHLIGHT)
            && JSON.stringify(annotationSource(next)) === sourceKey) {
            parts.push({ kind: 'quote', text: quoteText(next) });
            last = next;
            continue;
        }
        if (next?.matches?.('span.math')) {
            const after = nextPart(next);
            if (!after?.matches?.(HIGHLIGHT)
                || JSON.stringify(annotationSource(after)) !== sourceKey) break;
            parts.push({ kind: 'inline', text: next.textContent },
                { kind: 'quote', text: quoteText(after) });
            last = after;
            continue;
        }
        if (!next && last.parentElement?.localName === 'p') {
            const formula = last.parentElement.nextElementSibling;
            const after = formula?.nextElementSibling?.firstElementChild;
            if (formula?.matches('pre.math') && after?.matches(HIGHLIGHT)
                && formula.nextElementSibling.localName === 'p'
                && JSON.stringify(annotationSource(after)) === sourceKey) {
                parts.push({ kind: 'display', text: formula.textContent },
                    { kind: 'quote', text: quoteText(after) });
                last = after;
                continue;
            }
        }
        break;
    }
    return { parts, last };
}

export function readResearchNoteExcerpts(html, { parseHTML }) {
    const document = parseHTML('<!doctype html><html><body>' + html + '</body></html>');
    const rows = new Map();
    let last = null;
    let covered = false;
    for (const node of document?.body?.querySelectorAll(HIGHLIGHT) || []) {
        if (covered) {
            if (node === last) covered = false;
            continue;
        }
        const source = annotationSource(node);
        if (!source) continue;
        const sourceKey = JSON.stringify(source);
        const quote = continuations(node, sourceKey);
        last = quote.last;
        covered = last !== node;
        const text = quote.parts.map(part => part.kind === 'display'
            ? '\n' + part.text + '\n' : part.text).join('');
        if (!text.trim()) continue;
        const type = node.classList.contains('underline') ? 'underline' : 'highlight';
        const citationItem = citationFor(node);
        const id = JSON.stringify([source, type, quote.parts, citationItem]);
        if (!rows.has(id)) rows.set(id, { id, source, type, text, citationItem, parts: quote.parts });
    }
    return [...rows.values()];
}

export function researchNoteReviewHTML(excerpts, labels, { parseHTML }) {
    const document = parseHTML('<!doctype html><html><body></body></html>');
    const body = document.body;
    function block(tag, text = '', parent = body) {
        const element = document.createElement(tag);
        element.textContent = text;
        parent.appendChild(element);
        return element;
    }
    block('h2', labels.title);
    block('h3', labels.question);
    block('p');
    block('h3', labels.excerpts);
    for (const excerpt of excerpts) {
        const { attachmentURI, position, pageLabel, annotationKey } = excerpt.source;
        const annotation = { attachmentURI, position, pageLabel };
        if (annotationKey) annotation.annotationKey = annotationKey;
        if (excerpt.citationItem) annotation.citationItem = excerpt.citationItem;
        const metadata = encodeURIComponent(JSON.stringify(annotation));
        // The native editor can keep highlight fragments without surrounding
        // quotation marks when the excerpt lives in a blockquote.
        const quote = block('blockquote');
        let paragraph = block('p', '', quote);
        for (const part of excerpt.parts) {
            if (part.kind === 'display') {
                block('pre', part.text, quote).className = 'math';
                paragraph = block('p', '', quote);
                continue;
            }
            const node = document.createElement('span');
            node.className = part.kind === 'inline' ? 'math' : excerpt.type;
            if (part.kind === 'quote') node.setAttribute('data-annotation', metadata);
            const lines = part.text.split('\n');
            lines.forEach((line, index) => {
                if (index) node.appendChild(document.createElement('br'));
                node.appendChild(document.createTextNode(line));
            });
            paragraph.appendChild(node);
        }
        if (excerpt.citationItem) {
            const citation = document.createElement('span');
            const item = document.createElement('span');
            citation.className = 'citation';
            citation.setAttribute('data-citation', encodeURIComponent(JSON.stringify({
                citationItems: [excerpt.citationItem], properties: {},
            })));
            item.className = 'citation-item';
            item.textContent = [excerpt.title, pageLabel].filter(Boolean).join(', ');
            citation.append('(', item, ')');
            paragraph.append(' ', citation);
        }
    }
    block('h3', labels.judgment);
    block('p');
    return body.innerHTML;
}
