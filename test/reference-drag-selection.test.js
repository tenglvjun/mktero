import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorView } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { createInlineMarkdownEditor } from '../src/editor/inline-markdown-editor.js';
import { startsSelectableDrag } from '../src/editor/inline-rendering.js';

const CITED = [
    '# Paper',
    '',
    'Relaxation methods reduce anxiety<sup>2</sup> in most trials.',
    '',
    '## References',
    '',
    '[2] Beta B. Second paper. 2020.',
].join('\n');

function mount(markdown, options = {}) {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        ...options,
    });
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    return { dom, document, editor, view };
}

function press(dom, element, type, extras = {}) {
    const event = new dom.window.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        ...extras,
    });
    element.dispatchEvent(event);
    return event;
}

test('a drag can start on a citation in running text', () => {
    const { dom, document, editor, view } = mount(CITED);
    try {
        const citation = document.querySelector('.cm-line .cm-mktero-citation');
        assert.ok(citation, 'citation renders as a mark on the line');

        press(dom, citation, 'mousedown', { buttons: 1 });

        // The reference handler used to claim the press, so CodeMirror never
        // started a mouse selection and the drag went nowhere.
        assert.ok(view.inputState.mouseSelection);
    }
    finally {
        editor.destroy();
        dom.window.close();
    }
});

test('the click that ends a drag from a citation does not open it', () => {
    const { dom, document, editor } = mount(CITED);
    try {
        const citation = document.querySelector('.cm-line .cm-mktero-citation');
        const after = [...citation.closest('.cm-line').childNodes]
            .find(node => node.nodeType === 3 && node.textContent.includes('trials'));
        const range = document.createRange();
        range.setStart(citation.firstChild, 0);
        range.setEnd(after, after.textContent.indexOf('trials'));
        document.getSelection().removeAllRanges();
        document.getSelection().addRange(range);

        const click = press(dom, citation, 'click');

        assert.equal(click.defaultPrevented, false);
    }
    finally {
        editor.destroy();
        dom.window.close();
    }
});

test('a plain click on a citation still opens it', () => {
    const { dom, document, editor } = mount(CITED);
    try {
        const citation = document.querySelector('.cm-line .cm-mktero-citation');
        document.getSelection().removeAllRanges();

        const click = press(dom, citation, 'click');

        assert.equal(click.defaultPrevented, true);
    }
    finally {
        editor.destroy();
        dom.window.close();
    }
});

function referenceIn(html) {
    const dom = new JSDOM(`<div class="cm-content">${html}</div>`);
    return dom.window.document.querySelector('.ref');
}

test('a reference mark on a line starts a selectable drag', () => {
    const element = referenceIn(
        '<div class="cm-line">See <span class="cm-mktero-figure-reference ref">Figure 3</span> shows</div>'
    );

    assert.equal(startsSelectableDrag({ element }), true);
});

test('a reference inside a widget keeps preventing the drag default', () => {
    const inTable = referenceIn(
        '<div class="cm-mktero-rendered cm-mktero-html-table" contenteditable="false">'
        + '<table><tr><td><span class="cm-mktero-citation ref">2</span></td></tr></table></div>'
    );
    const inLineWidget = referenceIn(
        '<div class="cm-line">Text<span class="cm-mktero-math" contenteditable="false">'
        + '<sup class="cm-mktero-citation ref">1</sup></span></div>'
    );

    assert.equal(startsSelectableDrag({ element: inTable }), false);
    assert.equal(startsSelectableDrag({ element: inLineWidget }), false);
});

test('a footnote marker drawn as a widget on a line starts a selectable drag', () => {
    const element = referenceIn(
        '<div class="cm-line">Text<span class="cm-mktero-footnote-ref ref" '
        + 'contenteditable="false">†</span> more</div>'
    );

    assert.equal(startsSelectableDrag({ element }), true);
});

test('a highlight that already allowed selection still does', () => {
    assert.equal(startsSelectableDrag({
        element: null,
        allowTextSelection: true,
    }), true);
});

const IN_WIDGETS = [
    '# Paper',
    '',
    '| Model |',
    '| --- |',
    '| Zhang et al. [16] |',
    '',
    '<table><tr><td>Kong et al. [41]</td></tr></table>',
    '',
    '![](images/panel-a.jpg)',
    '',
    '![](images/panel-b.jpg)  ',
    'FIG. 1: Results use the method from Ref. [16].',
    '',
    '## References',
    '',
    '[16] H. Zhang. Pedal estimation. 2025.',
    '[41] Q. Kong. Piano transcription. 2021.',
].join('\n');

function mountWidgets() {
    return mount(IN_WIDGETS, {
        resolveImageURL: path => `blob:mktero-${path}`,
        openLink: () => {},
    });
}

const WIDGET_CITATIONS = [
    ['a GFM table cell', '.cm-mktero-table .cm-mktero-citation'],
    ['an HTML table cell', '.cm-mktero-html-table .cm-mktero-citation'],
    ['a figure caption', 'figcaption .cm-mktero-citation'],
];

for (const [place, selector] of WIDGET_CITATIONS) {
    test(`a press on a citation in ${place} starts a native drag`, () => {
        const { dom, document, editor, view } = mountWidgets();
        try {
            const citation = document.querySelector(selector);
            assert.ok(citation, `citation renders in ${place}`);

            const down = press(dom, citation, 'mousedown', { buttons: 1 });

            // A drag inside a widget is the browser's, as on plain caption or
            // cell text: nothing may cancel the press or claim it for
            // CodeMirror's own mouse selection.
            assert.equal(down.defaultPrevented, false);
            assert.equal(view.inputState.mouseSelection, null);
        }
        finally {
            editor.destroy();
            dom.window.close();
        }
    });
}

function selectFromInto(document, element, after) {
    const range = document.createRange();
    range.setStart(element.firstChild, 0);
    range.setEnd(after, Math.min(3, after.textContent.length));
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);
}

test('the click that ends a drag from a citation in a widget does not open it', () => {
    const { dom, document, editor } = mountWidgets();
    try {
        const citation = document.querySelector(
            '.cm-mktero-html-table .cm-mktero-citation'
        );
        selectFromInto(document, citation, citation.nextSibling);

        const click = press(dom, citation, 'click');

        assert.equal(click.defaultPrevented, false);
        assert.equal(document.getSelection().isCollapsed, false);
    }
    finally {
        editor.destroy();
        dom.window.close();
    }
});

test('a plain click on a citation in a rendered widget still opens it', () => {
    const { dom, document, editor } = mountWidgets();
    try {
        const citation = document.querySelector(
            '.cm-mktero-html-table .cm-mktero-citation'
        );
        document.getSelection().removeAllRanges();

        const click = press(dom, citation, 'click');

        assert.equal(click.defaultPrevented, true);
    }
    finally {
        editor.destroy();
        dom.window.close();
    }
});

const FOOTNOTE_SYMBOL = [
    'The Sharpe Ratio $^{\\dagger}$ measures return.',
    '',
    '<!-- mktero-note: footnote -->',
    '> $^{\\dagger}$ Calculated over the full period.',
].join('\n');

function mountFootnote() {
    const mounted = mount(FOOTNOTE_SYMBOL);
    ensureSyntaxTree(mounted.view.state, mounted.view.state.doc.length, 1000);
    mounted.view.dispatch({});
    return mounted;
}

test('a drag can start on an inline footnote marker', () => {
    const { dom, document, editor, view } = mountFootnote();
    try {
        const marker = document.querySelector('.cm-mktero-footnote-ref');
        assert.ok(marker?.closest('.cm-line'), 'the marker sits on a line');
        assert.equal(marker.contentEditable, 'false');

        press(dom, marker, 'mousedown', { buttons: 1 });

        assert.ok(view.inputState.mouseSelection);
    }
    finally {
        editor.destroy();
        dom.window.close();
    }
});

test('the click that ends a drag from a footnote marker does not jump', () => {
    const { dom, document, editor, view } = mountFootnote();
    try {
        const marker = document.querySelector('.cm-mktero-footnote-ref');
        const line = marker.closest('.cm-line');
        const after = [...line.childNodes]
            .find(node => node.nodeType === 3 && node.textContent.includes('measures'));
        const range = document.createRange();
        range.setStartBefore(marker);
        range.setEnd(after, after.textContent.indexOf('measures'));
        document.getSelection().removeAllRanges();
        document.getSelection().addRange(range);
        const scrollTop = view.scrollDOM.scrollTop;

        const click = press(dom, marker, 'click');

        assert.equal(click.defaultPrevented, false);
        assert.equal(view.scrollDOM.scrollTop, scrollTop);
    }
    finally {
        editor.destroy();
        dom.window.close();
    }
});

test('a plain click on a footnote marker still jumps', () => {
    const { dom, document, editor, view } = mountFootnote();
    try {
        const marker = document.querySelector('.cm-mktero-footnote-ref');
        const positions = [];
        view.lineBlockAt = position => {
            positions.push(position);
            return { top: 720 };
        };
        view.requestMeasure = request => {
            if (request?.read) request.write?.(request.read(view), view);
        };
        document.getSelection().removeAllRanges();

        const click = press(dom, marker, 'click');

        assert.equal(click.defaultPrevented, true);
        assert.ok(positions.includes(FOOTNOTE_SYMBOL.indexOf('> $^{')));
    }
    finally {
        editor.destroy();
        dom.window.close();
    }
});

test('a click on a note marker inside an existing selection still opens the note', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'First line of the passage.';
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
        resolveImageURL: () => null,
    });
    try {
        editor.setDocument({
            markdown,
            annotationOverlay: {
                matched: [{
                    id: 'NOTE0001',
                    type: 'highlight',
                    text: markdown,
                    comment: 'Remember this finding',
                    color: '#ffd400',
                    pageLabel: '4',
                    ranges: [{ from: 0, to: markdown.length }],
                }],
                unmatched: [],
            },
        });
        const marker = document.querySelector('.cm-mktero-pdf-annotation-note');
        assert.ok(marker);
        // The reader selected the whole paragraph earlier; the marker's own
        // press is claimed by the editor, so that selection stays.
        const range = document.createRange();
        range.selectNodeContents(document.querySelector('.cm-line'));
        document.getSelection().removeAllRanges();
        document.getSelection().addRange(range);

        press(dom, marker, 'mousedown');
        const click = press(dom, marker, 'click');

        assert.equal(click.defaultPrevented, true);
        assert.match(
            document.querySelector('.mktero-annotation-popup')?.textContent || '',
            /Remember this finding/
        );
    }
    finally {
        editor.destroy();
        dom.window.close();
    }
});
