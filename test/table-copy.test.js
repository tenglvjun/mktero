import test from 'node:test';
import assert from 'node:assert/strict';
import { forceParsing } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { JSDOM } from 'jsdom';
import {
    createInlineMarkdownEditor,
} from '../src/editor/inline-markdown-editor.js';
import {
    enhanceRenderedTableBlocks,
} from '../src/editor/table-copy-actions.js';

const GFM_TABLE = [
    '| Model | Acc. |',
    '| --- | ---: |',
    '| A | 91.2 |',
].join('\n');

const HTML_TABLE = '<table><tr><td>Raw</td><td>Table</td></tr></table>';

function createEditor(markdown, options = {}) {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const copies = [];
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        copyCode: async code => {
            copies.push(code);
        },
        ...options,
    });
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    if (view) forceParsing(view, view.state.doc.length, 1000);
    return { dom, document, editor, copies };
}

async function click(button) {
    button.click();
    // The handler awaits the clipboard write before it reports its state.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

test('offers Markdown and CSV copying from a GFM table', async () => {
    const { dom, document, editor, copies } = createEditor(GFM_TABLE);

    const container = document.querySelector('.cm-mktero-table');
    assert.ok(container);
    const buttons = [...container.querySelectorAll('.cm-mktero-table-copy')];
    assert.deepEqual(
        buttons.map(button => button.dataset.action),
        ['copy-table-markdown', 'copy-table-csv']
    );
    assert.equal(buttons[0].textContent, 'Copy as Markdown');
    assert.equal(buttons[1].textContent, 'Copy as CSV');

    await click(buttons[0]);
    assert.deepEqual(copies, [GFM_TABLE]);
    assert.equal(buttons[0].textContent, 'Copied');

    // The second action clears the state the first one left behind.
    await click(buttons[1]);
    assert.deepEqual(copies, [GFM_TABLE, 'Model,Acc.\r\nA,91.2']);
    assert.equal(buttons[1].textContent, 'Copied');
    assert.equal(buttons[0].textContent, 'Copy as Markdown');
    assert.equal(buttons[0].dataset.state, undefined);

    editor.destroy();
    dom.window.close();
});

test('converts an OCR HTML table back to Markdown and CSV', async () => {
    const { dom, document, editor, copies } = createEditor(HTML_TABLE);

    const container = document.querySelector('.cm-mktero-html-table');
    assert.ok(container);
    const buttons = [...container.querySelectorAll('.cm-mktero-table-copy')];
    assert.deepEqual(
        buttons.map(button => button.dataset.action),
        ['copy-table-markdown', 'copy-table-csv']
    );

    await click(buttons[0]);
    assert.deepEqual(copies, ['| Raw | Table |\n| --- | --- |']);
    assert.equal(buttons[0].textContent, 'Copied');

    await click(buttons[1]);
    assert.deepEqual(copies, ['| Raw | Table |\n| --- | --- |', 'Raw,Table']);

    editor.destroy();
    dom.window.close();
});

test('omits the table actions when no clipboard handler is available', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: GFM_TABLE,
    });
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    forceParsing(view, view.state.doc.length, 1000);

    assert.ok(document.querySelector('.cm-mktero-table'));
    assert.equal(document.querySelector('.cm-mktero-table-copy'), null);

    editor.destroy();
    dom.window.close();
});

test('reports a failed table copy without leaving the button disabled', async () => {
    const { dom, document, editor } = createEditor(GFM_TABLE, {
        copyCode: async () => {
            throw new Error('clipboard unavailable');
        },
    });

    const button = document.querySelector('[data-action="copy-table-csv"]');
    await click(button);

    assert.equal(button.dataset.state, 'failed');
    assert.equal(button.textContent, 'Copy failed');
    assert.equal(button.disabled, false);

    editor.destroy();
    dom.window.close();
});

test('adds table copying to the tables of a saved snapshot', async () => {
    const dom = new JSDOM(
        '<!doctype html><div id="root">'
        + '<p>Before</p>'
        + '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>'
        + '<table><tr><td>Nested</td>'
        + '<td><table><tr><td>inner</td></tr></table></td></tr></table>'
        + '</div>',
        { pretendToBeVisual: true }
    );
    const { document } = dom.window;
    const root = document.querySelector('#root');
    const copies = [];
    const options = {
        copyCode: async code => {
            copies.push(code);
        },
    };

    enhanceRenderedTableBlocks(root, document, options);
    enhanceRenderedTableBlocks(root, document, options);

    const wrappers = [...root.querySelectorAll('.cm-mktero-table-copy-block')];
    assert.equal(wrappers.length, 2);
    assert.equal(
        root.querySelectorAll(
            '.cm-mktero-table-copy-block .cm-mktero-table-copy-block'
        ).length,
        0
    );
    assert.equal(wrappers[0].querySelector('table').parentElement, wrappers[0]);

    const buttons = [...root.querySelectorAll('.cm-mktero-table-copy')];
    assert.deepEqual(
        buttons.map(button => button.dataset.action),
        [
            'copy-table-markdown',
            'copy-table-csv',
            'copy-table-markdown',
            'copy-table-csv',
        ]
    );

    await click(buttons[0]);
    assert.deepEqual(copies, ['| A | B |\n| --- | --- |\n| 1 | 2 |']);
    await click(buttons[1]);
    assert.deepEqual(copies, ['| A | B |\n| --- | --- |\n| 1 | 2 |', 'A,B\r\n1,2']);

    dom.window.close();
});

test('leaves a snapshot with no table untouched', () => {
    const dom = new JSDOM(
        '<!doctype html><div id="root"><p>Nothing here</p></div>',
        { pretendToBeVisual: true }
    );
    const { document } = dom.window;
    const root = document.querySelector('#root');

    enhanceRenderedTableBlocks(root, document, { copyCode: async () => {} });

    assert.equal(root.querySelector('.cm-mktero-table-copy-block'), null);
    assert.equal(root.querySelector('.cm-mktero-table-toolbar'), null);

    dom.window.close();
});

test('leaves a snapshot table alone when no clipboard handler is available', () => {
    const dom = new JSDOM(
        '<!doctype html><div id="root"><table><tr><td>1</td></tr></table></div>',
        { pretendToBeVisual: true }
    );
    const { document } = dom.window;
    const root = document.querySelector('#root');

    enhanceRenderedTableBlocks(root, document, { copyCode: null });

    assert.equal(root.querySelector('.cm-mktero-table-copy-block'), null);
    assert.equal(root.querySelector('.cm-mktero-table-toolbar'), null);

    dom.window.close();
});

test('leaves a snapshot table without rows unwrapped', () => {
    const dom = new JSDOM(
        '<!doctype html><div id="root"><table></table></div>',
        { pretendToBeVisual: true }
    );
    const { document } = dom.window;
    const root = document.querySelector('#root');

    enhanceRenderedTableBlocks(root, document, { copyCode: async () => {} });

    assert.equal(root.querySelector('.cm-mktero-table-copy-block'), null);
    assert.ok(root.querySelector('table'));

    dom.window.close();
});
