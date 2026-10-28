// Formulas in the highlights Mktero adds to a Zotero note.
//
// Zotero's note schema renders a formula only as `<span class="math">$…$</span>`
// or `<pre class="math">$$…$$</pre>`, and its highlight node holds text and line
// breaks, never a formula. Zotero serializes an annotation's text as plain
// text, so TeX in it shows as source. These helpers take the HTML Zotero
// produced and split each highlight around its formulas: the text keeps the
// highlight, with its `data-annotation` (Show on Page, color), and each
// formula sits beside it.
//
// The caller supplies `parseHTML(html) => Document`, so this module needs no
// window. Nothing here reads or writes Zotero.

import {
    noteMathSegmentsText,
    noteSegmentTextKey,
} from '../markdown/markdown-visible-text.js';
import { zoteroNoteMathSource } from '../markdown/markdown-html.js';

const PLACEHOLDER_PREFIX = 'MKTERONOTEMATH';
const PLACEHOLDER_SUFFIX = 'END';
// Quotation marks and spacing a note template puts around a highlight's text.
const MAX_HIGHLIGHT_AFFIX_LENGTH = 4;
// Blocks a note keeps a formula block in as it is.
const FORMULA_CONTAINERS = new Set(['body', 'li', 'blockquote', 'div', 'td', 'th']);

// A text Zotero's note serializer passes through unchanged, standing in for
// the highlight of annotation `index` until its formulas are put in.
export function noteMathPlaceholder(index) {
    return `${PLACEHOLDER_PREFIX}${Number(index)}${PLACEHOLDER_SUFFIX}`;
}

/**
 * Replace the placeholder highlights in `html` with their segments.
 * `segmentsByIndex` maps an annotation index to its segments. Returns the new
 * HTML, or null when a placeholder is missing or survives, so the caller can
 * insert the annotations without formulas instead.
 */
export function replaceNoteMathPlaceholders(html, segmentsByIndex, { parseHTML }) {
    const document = parseBody(html, parseHTML);
    if (!document) return null;
    const expected = [...segmentsByIndex.keys()];
    const found = new Set();
    for (const span of highlightSpans(document)) {
        const text = span.textContent || '';
        const match = /MKTERONOTEMATH(\d+)END/u.exec(text);
        if (!match) continue;
        const index = Number(match[1]);
        const segments = segmentsByIndex.get(index);
        if (!segments) return null;
        const placeholder = noteMathPlaceholder(index);
        const at = text.indexOf(placeholder);
        if (text.indexOf(placeholder, at + 1) !== -1) return null;
        const prefix = text.slice(0, at);
        const suffix = text.slice(at + placeholder.length);
        if (!isHighlightAffix(prefix) || !isHighlightAffix(suffix)) return null;
        rebuildHighlight(document, span, segments, prefix, suffix);
        found.add(index);
    }
    if (expected.some(index => !found.has(index))) return null;
    const output = document.body.innerHTML;
    return output.includes(PLACEHOLDER_PREFIX) ? null : output;
}

/**
 * Put formulas into the highlights of a saved note's HTML. `segmentsFor(key)`
 * returns the segments of the annotation with that key, or null. A highlight
 * is rebuilt only when its text is the segments' text, so a highlight edited
 * or matched elsewhere keeps Zotero's text. Returns the new HTML, or null when
 * nothing changed.
 */
export function rewriteNoteHighlightMath(html, segmentsFor, { parseHTML }) {
    const document = parseBody(html, parseHTML);
    if (!document) return null;
    let changed = false;
    for (const span of highlightSpans(document)) {
        const key = highlightAnnotationKey(span);
        if (!key) continue;
        const segments = segmentsFor(key);
        if (!segments?.length) continue;
        const affixes = highlightAffixes(span.textContent || '', segments);
        if (!affixes) continue;
        rebuildHighlight(document, span, segments, affixes.prefix, affixes.suffix);
        changed = true;
    }
    return changed ? document.body.innerHTML : null;
}

function parseBody(html, parseHTML) {
    if (typeof parseHTML !== 'function' || typeof html !== 'string') return null;
    try {
        const document = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
        return document?.body ? document : null;
    }
    catch {
        return null;
    }
}

function highlightSpans(document) {
    return [...document.body.querySelectorAll('span.highlight, span.underline')]
        .filter(span => span.hasAttribute('data-annotation'));
}

function highlightAnnotationKey(span) {
    try {
        const annotation = JSON.parse(
            decodeURIComponent(span.getAttribute('data-annotation') || '')
        );
        const key = annotation?.annotationKey;
        return typeof key === 'string' && key ? key : null;
    }
    catch {
        return null;
    }
}

// The template's text around the highlight's own text: Zotero adds quotation
// marks unless the highlight is in a blockquote. A highlight saved while a
// formula subscript was hidden as emphasis still matches, and the formulas
// inserted are the ones the reader shows now.
function highlightAffixes(spanText, segments) {
    return affixesForExpected(spanText, noteMathSegmentsText(segments))
        || affixesForExpected(spanText, segments?.legacySavedText);
}

function affixesForExpected(spanText, expected) {
    const spanKey = noteSegmentTextKey(spanText);
    const expectedKey = noteSegmentTextKey(expected);
    if (!expectedKey || !spanKey.includes(expectedKey)) return null;
    if (spanKey.length - expectedKey.length > MAX_HIGHLIGHT_AFFIX_LENGTH * 2) {
        return null;
    }
    const prefixKey = spanKey.slice(0, spanKey.indexOf(expectedKey));
    const suffixKey = spanKey.slice(prefixKey.length + expectedKey.length);
    if (!isHighlightAffix(prefixKey) || !isHighlightAffix(suffixKey)) return null;
    return {
        prefix: leadingAffix(spanText, prefixKey),
        suffix: trailingAffix(spanText, suffixKey),
    };
}

function isHighlightAffix(text) {
    return text.length <= MAX_HIGHLIGHT_AFFIX_LENGTH
        && !/[\p{L}\p{N}]/u.test(text);
}

function leadingAffix(text, key) {
    if (!key) return '';
    const trimmed = text.trimStart();
    return trimmed.startsWith(key) ? key : '';
}

function trailingAffix(text, key) {
    if (!key) return '';
    const trimmed = text.trimEnd();
    return trimmed.endsWith(key) ? key : '';
}

// Replaces `span` with one highlight per run of text and the formulas between
// them. A display formula ends the paragraph it is in and the text after it
// starts a new one, as the note shows a formula block.
function rebuildHighlight(document, span, segments, prefix, suffix) {
    const runs = buildRuns(segments, prefix, suffix);
    const nodes = [];
    for (const run of runs) {
        if (run.type === 'text') {
            if (!run.text) continue;
            const highlight = span.cloneNode(false);
            appendTextWithBreaks(document, highlight, run.text);
            nodes.push(highlight);
            continue;
        }
        nodes.push(mathElement(document, run));
    }
    span.replaceWith(...nodes);
    for (const node of nodes) {
        if (node.localName === 'pre') liftDisplayFormula(document, node);
    }
}

function buildRuns(segments, prefix, suffix) {
    const runs = [];
    const pushText = text => {
        const last = runs.at(-1);
        if (last?.type === 'text') last.text += text;
        else runs.push({ type: 'text', text });
    };
    if (prefix) pushText(prefix);
    for (const segment of segments) {
        if (segment.type === 'math') runs.push(segment);
        else pushText(segment.text || '');
    }
    if (suffix) pushText(suffix);
    return runs;
}

function mathElement(document, segment) {
    if (segment.display) {
        const pre = document.createElement('pre');
        pre.setAttribute('class', 'math');
        pre.textContent = `$$${segment.tex}$$`;
        return pre;
    }
    const span = document.createElement('span');
    span.setAttribute('class', 'math');
    span.textContent = `$${segment.tex}$`;
    return span;
}

function appendTextWithBreaks(document, element, text) {
    const lines = String(text).split(/\r?\n/u);
    lines.forEach((line, index) => {
        if (index) element.appendChild(document.createElement('br'));
        if (line) element.appendChild(document.createTextNode(line));
    });
}

// A `<pre>` inside a paragraph is not a note block. Split the paragraph at
// the formula; inside a heading or an inline element, show it inline.
function liftDisplayFormula(document, pre) {
    const parent = pre.parentNode;
    const name = parent?.localName;
    if (FORMULA_CONTAINERS.has(name)) return;
    if (name !== 'p') {
        inlineDisplayFormula(document, pre);
        return;
    }
    const after = document.createElement('p');
    while (pre.nextSibling) after.appendChild(pre.nextSibling);
    parent.after(pre);
    pre.after(after);
    trimEdgeBreaks(parent);
    trimEdgeBreaks(after);
    if (!hasContent(parent)) parent.remove();
    if (!hasContent(after)) after.remove();
}

function inlineDisplayFormula(document, pre) {
    const tex = String(pre.textContent || '').replace(/^\$\$|\$\$$/gu, '');
    const inline = zoteroNoteMathSource(tex, false);
    if (inline) {
        const span = document.createElement('span');
        span.setAttribute('class', 'math');
        span.textContent = `$${inline}$`;
        pre.replaceWith(span);
        return;
    }
    pre.replaceWith(document.createTextNode(tex));
}

function trimEdgeBreaks(element) {
    while (element.firstChild?.localName === 'br') element.firstChild.remove();
    while (element.lastChild?.localName === 'br') element.lastChild.remove();
    const first = edgeTextNode(element, 'firstChild');
    if (first) first.nodeValue = first.nodeValue.trimStart();
    const last = edgeTextNode(element, 'lastChild');
    if (last) last.nodeValue = last.nodeValue.trimEnd();
}

// The text at the start or end of `element`, through the highlight that holds
// it, so the space before a split formula block does not stay behind.
function edgeTextNode(element, edge) {
    let node = element[edge];
    while (node?.nodeType === 1 && node.localName === 'span' && !isMathSpan(node)) {
        node = node[edge];
    }
    return node?.nodeType === 3 ? node : null;
}

function isMathSpan(node) {
    return node.getAttribute?.('class') === 'math';
}

function hasContent(element) {
    if (String(element.textContent || '').trim()) return true;
    return Boolean(element.querySelector?.('img, span.math, pre.math, span.citation'));
}
