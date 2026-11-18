import { createInlineMarkdownEditor } from '../../src/editor/inline-markdown-editor.js';
import { createLocalization } from '../../src/i18n/localization.js';
import { createVisibleTranslationPairs } from '../../src/ui/markdown-window.js';

let root;
let editor;
const calls = { translation: 0, annotations: [] };

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
        createMarkdownAnnotation: async (annotation, selectionContext) => {
            calls.annotations.push({ annotation, selectionContext });
            return annotation;
        },
    });
    setDocument({ source, views, translations, view });
}

export function setDocument({ source, views, translations, view }) {
    const compare = view === 'compare';
    editor.setDocument({
        markdown: compare ? views.comparisonMarkdown : views.translatedMarkdown,
        sourceMarkdown: source,
        translationView: view,
        sourceActionRanges: compare ? views.comparisonSourceRanges : [],
        translationRanges: compare ? views.comparisonTranslationRanges : [],
        translationPairs: createVisibleTranslationPairs({
            translationBlocks: translations,
            translationBlockRanges: views.blockRanges,
        }, !compare, compare),
    });
}

function selection() {
    return root.getSelection?.() || document.getSelection();
}

// Use rendered text to find the native selection ends, including in table
// widgets where the selected characters are outside CodeMirror's text lines.
export function select({ text, from, to, selector = '.cm-line', backward }) {
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
    const native = selection();
    native.removeAllRanges();
    if (backward) {
        native.collapse(range.endContainer, range.endOffset);
        native.extend(range.startContainer, range.startOffset);
    }
    else native.addRange(range);
    return native.toString();
}

export function popupLayout() {
    const popup = root.querySelector('.mktero-translation-source-popup');
    const text = popup?.querySelector('.mktero-translation-source-text');
    if (!text) return null;
    const reading = root.querySelector('.markdown-editor-host').getBoundingClientRect();
    const box = popup.getBoundingClientRect();
    // The body or its wrapper may scroll, but the whole popup must not.
    let scroll = text;
    while (scroll && scroll !== popup && !['auto', 'scroll'].includes(getComputedStyle(scroll).overflowY)) {
        scroll = scroll.parentElement;
    }
    const port = scroll === popup ? text : scroll;
    const portBox = port.getBoundingClientRect();
    const top = portBox.top + port.clientTop;
    const bottom = top + port.clientHeight;
    const range = document.createRange();
    range.selectNodeContents(text);
    const lines = Array.from(range.getClientRects());
    const lineIsVisible = line => line?.top >= top - 1 && line.bottom <= bottom + 1;
    return {
        id: popup.id,
        box: box.toJSON(),
        selectionRect: selection().getRangeAt(0).getBoundingClientRect().toJSON(),
        reading: reading.toJSON(),
        hostWidth: root.host.getBoundingClientRect().width,
        sourceHeight: port.clientHeight,
        sourceLineHeight: parseFloat(getComputedStyle(text).lineHeight),
        horizontalOverflow: port.scrollWidth - port.clientWidth,
        scrollRange: port.scrollHeight - port.clientHeight,
        scrollTop: port.scrollTop,
        popupOverflow: popup.scrollHeight - popup.clientHeight,
        firstLineVisible: lineIsVisible(lines[0]),
        lastLineVisible: lineIsVisible(lines.at(-1)),
        wheelPoint: { x: portBox.left + port.clientWidth / 2, y: (top + bottom) / 2 },
        actions: Array.from(popup.querySelectorAll('button[data-action]'), button => {
            const rect = button.getBoundingClientRect();
            const hit = root.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            return {
                name: button.dataset.action,
                visible: rect.width > 0 && rect.height > 0 && !button.disabled
                    && rect.top >= bottom - 1 && rect.bottom <= box.bottom + 1
                    && rect.left >= box.left - 1 && rect.right <= box.right + 1
                    && button.contains(hit),
            };
        }),
    };
}

export function clear() { selection().removeAllRanges(); }
export function selectionState() {
    const native = selection();
    return { text: native.toString(), collapsed: native.isCollapsed };
}
export function destroy() { editor.destroy(); }
export function counters() { return calls; }
