import { EditorView } from '@codemirror/view';
import { createInlineMarkdownEditor } from '../../src/editor/inline-markdown-editor.js';
import { createLocalization } from '../../src/i18n/localization.js';
import { visibleMarkdownTextForRanges } from '../../src/markdown/markdown-visible-text.js';
import { createVisibleTranslationPairs } from '../../src/ui/markdown-window.js';

let root;
let editor;
let currentDocument;
let evidence = [];
let evidenceCleanup = null;
let evidencePoint = null;
const calls = { translation: 0, annotations: [], copies: [], reveals: [], flashes: [], viewChanges: [] };

export function mount({ source, views, translations, view, css, locale }) {
    const host = document.querySelector('#reader');
    host.lang = locale;
    const localization = createLocalization({ zoteroLocale: locale });
    root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `${css}
        :host {
            display: grid;
            grid-template-columns: 176px minmax(0, 1fr) 272px;
            width: calc(100vw - 48px);
            height: calc(100vh - 48px);
            margin: 24px auto;
            border: 1px solid var(--border);
        }
        :host([data-narrow]) {
            grid-template-columns: 176px 320px minmax(272px, 1fr);
        }
        .fixture-sidebar {
            padding: 16px;
            color: var(--muted);
            background: var(--surface);
            font: 13px var(--ui-font);
        }
    `;
    const outline = document.createElement('aside');
    outline.className = 'fixture-sidebar';
    outline.textContent = localization.t('viewer.outlineTitle');
    const notes = document.createElement('aside');
    notes.className = 'fixture-sidebar';
    notes.textContent = localization.t('viewer.notesTitle');
    // This actual editor parent spans the reading column, not the wider host.
    const parent = document.createElement('section');
    parent.className = 'markdown-editor-host';
    parent.setAttribute('aria-label', 'Reading column');
    root.append(style, outline, parent, notes);
    editor = createInlineMarkdownEditor({
        parent,
        initialMarkdown: '',
        localization,
        shouldAutoTranslateSelection: () => true,
        translateSelection: () => { calls.translation++; },
        copySelectionTranslation: async text => { calls.copies.push(text); },
        createMarkdownAnnotation: async (annotation, selectionContext) => {
            calls.annotations.push({ annotation, selectionContext });
            return annotation;
        },
    });
    setDocument({ source, views, translations, view });
}

export function setDocument({ source, views, translations, view }) {
    currentDocument = { source, views, translations, view };
    const compare = view === 'compare';
    const translated = view === 'translated';
    editor.setDocument({
        markdown: compare ? views.comparisonMarkdown : translated ? views.translatedMarkdown : source,
        sourceMarkdown: source,
        translationView: view,
        sourceActionRanges: compare ? views.comparisonSourceRanges : translated ? [] : null,
        translationRanges: compare ? views.comparisonTranslationRanges : [],
        translationPairs: translated || compare ? createVisibleTranslationPairs({
            translationBlocks: translations,
            translationBlockRanges: views.blockRanges,
        }, translated, compare) : [],
        translateOriginalBlockText: (_id, range) => visibleMarkdownTextForRanges(source, [range]).trim(),
        // Match the host's canonical reveal: replace the translation with the
        // original document before scrolling and flashing the source range.
        revealTranslationSource: block => {
            const ranges = (block.blocks?.length ? block.blocks : [block]).map(source => ({
                from: source.sourceFrom, to: source.sourceTo,
            }));
            if (ranges.some(target => !Number.isSafeInteger(target.from) || !Number.isSafeInteger(target.to)
                || target.from < 0 || target.to <= target.from || target.to > source.length)) {
                throw new Error('The reveal targets must be canonical source ranges');
            }
            const [target] = ranges;
            calls.reveals.push({ source: { from: block.sourceFrom, to: block.sourceTo }, target, ranges });
            setDocument({ ...currentDocument, view: 'original' });
            editor.scrollToOffset(target.from);
            calls.flashes.push(ranges);
            editor.flashRanges(ranges);
        },
        setTranslationView: next => {
            calls.viewChanges.push(next);
            setDocument({ ...currentDocument, view: next });
        },
    });
}

function selection() {
    return root.getSelection?.() || document.getSelection();
}
function codeMirror() {
    return EditorView.findFromDOM(root.querySelector('.cm-editor'));
}
export function currentView() { return currentDocument.view; }
export function flashState() {
    const view = codeMirror();
    const ranges = [];
    for (const provider of view.state.facet(EditorView.decorations)) {
        const decorations = typeof provider === 'function' ? provider(view) : provider;
        decorations.between(0, view.state.doc.length, (from, to, mark) => {
            if (mark.spec.class === 'cm-mktero-selection-flash') ranges.push({ from, to });
        });
    }
    return {
        ranges,
        text: ranges.map(({ from, to }) => view.state.sliceDoc(from, to)),
        rendered: [...root.querySelectorAll('.cm-mktero-selection-flash')].map(node => node.textContent),
    };
}
export function scrollState() {
    const view = codeMirror();
    return {
        view: currentView(),
        scrollTop: view.scrollDOM.scrollTop,
        scrollLeft: view.scrollDOM.scrollLeft,
        scrollHeight: view.scrollDOM.scrollHeight,
        clientHeight: view.scrollDOM.clientHeight,
        viewport: { ...view.viewport },
        renderedText: view.contentDOM.textContent,
        gaps: view.contentDOM.querySelectorAll('.cm-gap').length,
    };
}
export function offsetVisible(offset) {
    const view = codeMirror();
    const rect = view.coordsAtPos(offset);
    const port = view.scrollDOM.getBoundingClientRect();
    return Boolean(rect && rect.top >= port.top - 1 && rect.bottom <= port.bottom + 1);
}
export function scrollToOffset(offset) { editor.scrollToOffset(offset, { align: 'center' }); }
export function requestMeasure() { editor.requestMeasure(); }
export function scrollToText(text) {
    const offset = editor.getMarkdown().indexOf(text);
    if (offset < 0) throw new Error(`Missing fixture text: ${text}`);
    scrollToOffset(offset);
}
export function setNarrow(narrow) { root.host.toggleAttribute('data-narrow', narrow); }
export function positionText({ text, from = 0, to = from, fraction = 0.5 }) {
    const view = codeMirror();
    const rect = renderedRange({ text, from, to }).getBoundingClientRect();
    if (!rect.height) throw new Error('Scroll the fixture text into view before positioning it');
    const reading = root.querySelector('.markdown-editor-host').getBoundingClientRect();
    const center = (rect.top + rect.bottom) / 2;
    view.scrollDOM.scrollTop += center - (reading.top + reading.height * fraction);
    view.requestMeasure();
}

// Use rendered text to find the native selection ends, including in table
// widgets where the selected characters are outside CodeMirror's text lines.
function renderedRange({ text, from, to, selector = '.cm-line' }) {
    const matches = [...root.querySelectorAll(selector)].filter(node => node.textContent.includes(text));
    if (matches.length !== 1) throw new Error(`Expected one rendered match for ${text}, got ${matches.length}`);
    const [element] = matches;
    const start = element.textContent.indexOf(text);
    function pointAt(offset) {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
            const node = walker.currentNode;
            if (offset <= node.length) return [node, offset];
            offset -= node.length;
        }
        throw new Error('Selection exceeds the rendered element');
    }
    const range = document.createRange();
    range.setStart(...pointAt(start + from));
    range.setEnd(...pointAt(start + to));
    return range;
}

export function select({ text, from, to, selector, backward, endText, endTo }) {
    const range = renderedRange({ text, from, to, selector });
    if (endText) {
        const end = renderedRange({ text: endText, from: 0, to: endTo ?? endText.length, selector });
        range.setEnd(end.endContainer, end.endOffset);
    }
    const native = selection();
    native.removeAllRanges();
    if (backward) {
        native.collapse(range.endContainer, range.endOffset);
        native.extend(range.startContainer, range.startOffset);
    }
    else native.addRange(range);
    return native.toString();
}

export function popupLayout({ saveScope = false } = {}) {
    const popup = root.querySelector('.mktero-translation-source-popup');
    if (!popup) return null;
    const panel = popup.querySelector('.mktero-translation-source').dataset.panel;
    const text = panel !== 'collapsed' ? popup.querySelector(saveScope
        ? '.mktero-translation-annotation-details[open] .mktero-translation-annotation-text'
        : '.mktero-translation-source-text') : null;
    const reading = root.querySelector('.markdown-editor-host').getBoundingClientRect();
    const box = popup.getBoundingClientRect();
    const native = selection();
    const toolbar = popup.querySelector('.mktero-translation-source-toolbar').getBoundingClientRect();
    const layout = {
        id: popup.id,
        view: currentView(),
        panel,
        saveScope,
        obsoleteSourceUI: popup.querySelectorAll('[data-action="source-more"], .mktero-translation-source-more, [data-panel="more"]').length,
        expansion: popup.dataset.expansion,
        box: box.toJSON(),
        selectionRect: native.rangeCount ? native.getRangeAt(0).getBoundingClientRect().toJSON() : null,
        reading: reading.toJSON(),
        hostWidth: root.host.getBoundingClientRect().width,
        toolbar: toolbar.toJSON(),
        popupOverflow: popup.scrollHeight - popup.clientHeight,
        actions: Array.from(popup.querySelectorAll('button[data-action]'), button => {
            const rect = button.getBoundingClientRect();
            if (!rect.width || !rect.height) return null;
            const hit = root.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            return {
                name: button.dataset.action,
                box: rect.toJSON(),
                visible: !button.disabled
                    && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1
                    && rect.left >= box.left - 1 && rect.right <= box.right + 1
                    && button.contains(hit),
            };
        }).filter(Boolean),
    };
    if (!text) return layout;
    const scrollport = saveScope ? text.closest('details') : text;
    const portBox = scrollport.getBoundingClientRect();
    const textBox = text.getBoundingClientRect();
    const preview = text.closest('.mktero-translation-source-preview');
    const summary = saveScope ? scrollport.querySelector('summary') : null;
    const summaryBox = summary?.getBoundingClientRect();
    const clientBox = element => {
        const rect = element.getBoundingClientRect();
        const left = rect.left + element.clientLeft;
        const top = rect.top + element.clientTop;
        return { left, top, right: left + element.clientWidth, bottom: top + element.clientHeight };
    };
    // The annotation body grows naturally inside the one details scrollport.
    // Clip its text Range to the actual client area, including a visible
    // summary (also when sticky), rather than treating the whole body as visible.
    const clips = [textBox, clientBox(scrollport), clientBox(preview), clientBox(popup)];
    const left = Math.max(...clips.map(rect => rect.left));
    const right = Math.min(...clips.map(rect => rect.right));
    const top = Math.max(...clips.map(rect => rect.top), summaryBox?.bottom ?? -Infinity);
    const bottom = Math.min(...clips.map(rect => rect.bottom));
    const range = document.createRange();
    range.selectNodeContents(text);
    const lines = Array.from(range.getClientRects());
    const lineIsVisible = line => line?.top >= top - 1 && line.bottom <= bottom + 1
        && line.left >= left - 1 && line.right <= right + 1;
    const wheelPoint = { x: (left + right) / 2, y: (top + bottom) / 2 };
    const wheelHit = root.elementFromPoint(wheelPoint.x, wheelPoint.y);
    return {
        ...layout,
        textBox: textBox.toJSON(),
        scrollport: saveScope ? 'details' : 'source-text',
        scrollportBox: portBox.toJSON(),
        scrollportClientBox: clientBox(scrollport),
        scrollportOverflowY: getComputedStyle(scrollport).overflowY,
        summaryBox: summaryBox?.toJSON() || null,
        summaryPosition: summary ? getComputedStyle(summary).position : null,
        textOverflowY: getComputedStyle(text).overflowY,
        textMaxHeight: getComputedStyle(text).maxHeight,
        textClientHeight: text.clientHeight,
        textScrollHeight: text.scrollHeight,
        visibleTextBox: { left, right, top, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) },
        sourceHeight: scrollport.clientHeight,
        sourceScrollHeight: scrollport.scrollHeight,
        sourceLineHeight: parseFloat(getComputedStyle(text).lineHeight),
        horizontalOverflow: scrollport.scrollWidth - scrollport.clientWidth,
        scrollRange: scrollport.scrollHeight - scrollport.clientHeight,
        scrollTop: scrollport.scrollTop,
        firstLineVisible: lineIsVisible(lines[0]),
        lastLineVisible: lineIsVisible(lines.at(-1)),
        firstLineBox: lines[0]?.toJSON() || null,
        lastLineBox: lines.at(-1)?.toJSON() || null,
        wheelPoint,
        wheelTarget: describeNode(wheelHit),
        wheelPointInSource: bottom > top && right > left && (text.contains(wheelHit) || wheelHit === scrollport),
    };
}

export function clear() { selection().removeAllRanges(); }
export function selectionState() {
    const native = selection();
    return { text: native.toString(), collapsed: native.isCollapsed };
}
export function selectionSnapshot() {
    const native = selection();
    const view = codeMirror();
    const inEditor = node => Boolean(node && view.contentDOM.contains(node));
    return {
        ...selectionState(),
        anchor: inEditor(native.anchorNode) ? view.posAtDOM(native.anchorNode, native.anchorOffset) : null,
        focus: inEditor(native.focusNode) ? view.posAtDOM(native.focusNode, native.focusOffset) : null,
        connected: Boolean(native.anchorNode?.isConnected && native.focusNode?.isConnected),
    };
}
// Observe native events without changing selection, scrolling, or runtime handlers.
export function startEvidence() {
    evidenceCleanup?.();
    evidence = [];
    const listeners = [];
    for (const target of [document, root]) {
        for (const type of ['wheel', 'scroll', 'selectionchange', 'mousedown', 'mouseup', 'click', 'toggle', 'focusin', 'focusout']) {
            const handler = event => recordEvidence(`${target === root ? 'shadow' : 'document'}:${type}`, {
                target: describeNode(event.target),
                targetAction: event.target?.dataset?.action,
                targetIsConnected: event.target?.isConnected ?? null,
                relatedTarget: describeNode(event.relatedTarget),
                relatedTargetIsConnected: event.relatedTarget?.isConnected ?? null,
                path: event.composedPath().map(describeNode),
                deltaY: event.deltaY,
                targetScrollTop: event.target.scrollTop,
            });
            target.addEventListener(type, handler, true);
            listeners.push(() => target.removeEventListener(type, handler, true));
        }
    }
    const scroller = codeMirror().scrollDOM;
    const ownScrollTop = Object.getOwnPropertyDescriptor(scroller, 'scrollTop');
    const nativeScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    Object.defineProperty(scroller, 'scrollTop', {
        configurable: true,
        get() { return nativeScrollTop.get.call(this); },
        set(value) {
            recordEvidence('editor-scroll-write', { requestedScrollTop: value, stack: new Error().stack });
            nativeScrollTop.set.call(this, value);
        },
    });
    const observer = new MutationObserver(records => {
        if (records.some(record => [...record.removedNodes].some(node => (
            node.matches?.('.mktero-translation-source-popup')
        )))) recordEvidence('popup-removed');
    });
    observer.observe(root, { childList: true, subtree: true });
    evidenceCleanup = () => {
        listeners.forEach(remove => remove());
        observer.disconnect();
        if (ownScrollTop) Object.defineProperty(scroller, 'scrollTop', ownScrollTop);
        else delete scroller.scrollTop;
    };
    recordEvidence('start');
}
function describeNode(node) {
    if (node === window) return 'window';
    if (node === document) return 'document';
    if (node === root) return 'shadowRoot';
    if (node?.nodeType === Node.TEXT_NODE) return `text:${node.textContent.slice(0, 70)}`;
    return node?.localName ? `${node.localName}${node.id ? `#${node.id}` : ''}${node.className ? `.${String(node.className).replaceAll(' ', '.')}` : ''}` : String(node);
}
export function recordEvidence(label, details = {}) {
    if (!evidenceCleanup) return;
    if (details.point) evidencePoint = details.point;
    const view = codeMirror();
    const native = selection();
    const popup = root.querySelector('.mktero-translation-source-popup');
    const source = popup?.querySelector('.mktero-translation-source-text');
    const hit = evidencePoint ? root.elementFromPoint(evidencePoint.x, evidencePoint.y) : null;
    evidence.push({
        label, time: performance.now(), ...details,
        selection: { ...selectionSnapshot(), anchorNode: describeNode(native.anchorNode),
            anchorOffset: native.anchorOffset, focusNode: describeNode(native.focusNode), focusOffset: native.focusOffset },
        scrollTop: view.scrollDOM.scrollTop, viewport: { ...view.viewport },
        selectionRect: native.rangeCount ? native.getRangeAt(0).getBoundingClientRect().toJSON() : null,
        popup: popup?.getBoundingClientRect().toJSON() || null,
        activeElement: describeNode(root.activeElement || document.activeElement),
        sourceScrollTop: source?.scrollTop,
        sourceClientHeight: source?.clientHeight,
        sourceScrollHeight: source?.scrollHeight,
        sourceTextBox: source?.getBoundingClientRect().toJSON() || null,
        hit: describeNode(hit), hitInPopup: Boolean(hit && popup?.contains(hit)),
        hitInSource: Boolean(hit && source?.contains(hit)),
    });
}
export function finishEvidence() {
    evidenceCleanup?.();
    evidenceCleanup = null;
    return evidence;
}
export function destroy() { evidenceCleanup?.(); editor.destroy(); }
export function counters() { return calls; }
