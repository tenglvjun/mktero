import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createInlineMarkdownEditor } from '../src/editor/inline-markdown-editor.js';
import { RenderedTableWidget } from '../src/editor/rendered-table-widget.js';

const MARKDOWN = [
    '# Paper',
    '',
    '| Model | Note |',
    '| --- | --- |',
    '| Zhang et al. [16] | Pedal model |',
    '',
    '## References',
    '',
    '[16] H. Zhang. Pedal estimation. 2025.',
].join('\n');

function mount({ correctable = false } = {}) {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: MARKDOWN,
        ...(correctable ? { onCommitCorrection: async () => {} } : {}),
    });
    if (correctable) {
        const from = MARKDOWN.indexOf('| Model');
        const to = MARKDOWN.indexOf('\n\n## References');
        editor.setCorrectionState({
            enabled: true,
            blocks: [{
                id: 'table',
                type: 'table',
                from,
                to,
                markdown: MARKDOWN.slice(from, to),
                protectedRanges: [],
            }],
        });
    }
    return { dom, document, editor };
}

function dispatch(dom, element, type) {
    const event = new dom.window.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
    });
    element.dispatchEvent(event);
    return event;
}

for (const correctable of [false, true]) {
    const label = correctable ? 'a correctable' : 'a';
    test(`a click on a citation in ${label} GFM table opens it`, () => {
        const { dom, document, editor } = mount({ correctable });
        try {
            const citation = document.querySelector('.cm-mktero-table .cm-mktero-citation');
            assert.equal(citation?.textContent, '16');

            const click = dispatch(dom, citation, 'click');

            // The reader handled the click: it opens the reference.
            assert.equal(click.defaultPrevented, true);
        }
        finally {
            editor.destroy();
            dom.window.close();
        }
    });

    test(`hovering a citation in ${label} GFM table shows its reference`, () => {
        const { dom, document, editor } = mount({ correctable });
        try {
            const citation = document.querySelector('.cm-mktero-table .cm-mktero-citation');

            dispatch(dom, citation, 'mouseover');

            assert.match(
                document.querySelector('.mktero-citation-popup')?.textContent || '',
                /H\. Zhang\. Pedal estimation\. 2025\./
            );
        }
        finally {
            editor.destroy();
            dom.window.close();
        }
    });
}

test('a press on a GFM table citation stays with the browser', () => {
    const { dom, document, editor } = mount();
    try {
        const citation = document.querySelector('.cm-mktero-table .cm-mktero-citation');

        const mousedown = dispatch(dom, citation, 'mousedown');

        // A drag from the citation selects natively, as on any cell text.
        assert.equal(mousedown.defaultPrevented, false);
    }
    finally {
        editor.destroy();
        dom.window.close();
    }
});

test('a mark inside a cell being corrected keeps its events in the cell', () => {
    const dom = new JSDOM(
        '<div class="cm-mktero-table"><table><tr>'
        + '<td contenteditable="true"><span class="cm-mktero-pdf-annotation">x</span></td>'
        + '<td contenteditable="false"><span class="cm-mktero-citation">16</span></td>'
        + '</tr></table></div>'
    );
    const document = dom.window.document;
    const widget = new RenderedTableWidget({ source: '| x |', from: 0 });
    const event = (type, target) => ({ type, target });
    const editedMark = document.querySelector('td[contenteditable="true"] span');
    const citation = document.querySelector('td[contenteditable="false"] span');

    // While its cell is edited, the click places the caret.
    assert.equal(widget.ignoreEvent(event('click', editedMark)), true);
    // A citation elsewhere in the table still reaches the reader.
    assert.equal(widget.ignoreEvent(event('click', citation)), false);
    assert.equal(widget.ignoreEvent(event('mousedown', citation)), true);
});
