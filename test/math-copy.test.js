import test from 'node:test';
import assert from 'node:assert/strict';
import { forceParsing } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { JSDOM } from 'jsdom';
import {
    createInlineMarkdownEditor,
} from '../src/editor/inline-markdown-editor.js';
import { enhanceRenderedMathBlocks } from '../src/editor/inline-rendering.js';
import {
    renderZoteroNoteHTML,
} from '../src/markdown/zotero-note-html-renderer.js';

function createEditor(markdown, options = {}) {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const copies = [];
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        copyCode: async (...args) => {
            copies.push(args);
        },
        ...options,
    });
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    if (view) forceParsing(view, view.state.doc.length, 1000);
    return { dom, document, editor, copies };
}

async function clickCopyButton(button) {
    button.click();
    // The handler awaits the clipboard write before it reports its state.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

test('copies the rendered LaTeX from a display formula', async () => {
    const { dom, document, editor, copies } = createEditor(
        'Intro\n\n$$\nE = mc^2\n$$\n\nEnd'
    );

    const container = document.querySelector('.cm-mktero-math-display');
    assert.ok(container);
    const button = container.querySelector('.cm-mktero-math-copy');
    assert.ok(button);
    assert.equal(button.dataset.action, 'copy-math');
    assert.equal(button.getAttribute('aria-label'), 'Copy LaTeX');
    assert.equal(button.textContent, 'Copy LaTeX');

    await clickCopyButton(button);

    assert.deepEqual(copies, [[
        'E = mc^2',
        { html: '<pre class="math">$$E = mc^2$$</pre>' },
    ]]);
    assert.equal(button.dataset.state, 'copied');
    assert.equal(button.textContent, 'LaTeX copied');
    assert.equal(button.disabled, false);

    editor.destroy();
    dom.window.close();
});

test('does not offer formula copying for inline math', async () => {
    const { dom, document, editor } = createEditor('Value $a_i$ in prose');

    assert.ok(document.querySelector('.cm-mktero-math'));
    assert.equal(document.querySelector('.cm-mktero-math-copy'), null);
    assert.equal(document.querySelector('.cm-mktero-math-toolbar'), null);

    editor.destroy();
    dom.window.close();
});

test('omits the formula copy action without a clipboard handler', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '$$\nE = mc^2\n$$',
    });
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    forceParsing(view, view.state.doc.length, 1000);

    assert.ok(document.querySelector('.cm-mktero-math-display'));
    assert.equal(document.querySelector('.cm-mktero-math-copy'), null);

    editor.destroy();
    dom.window.close();
});

test('copies the source of a formula shown as plain TeX', async () => {
    const oversized = `$$\n${'a+'.repeat(6000)}a\n$$`;
    const { dom, document, editor, copies } = createEditor(oversized);

    const fallback = document.querySelector(
        '.cm-mktero-math-display .math-fallback'
    );
    assert.ok(fallback);
    const button = document.querySelector('.cm-mktero-math-copy');
    assert.ok(button);

    await clickCopyButton(button);

    assert.equal(copies.length, 1);
    assert.equal(copies[0].length, 1);
    assert.ok(copies[0][0].startsWith('a+a+'));
    assert.ok(copies[0][0].length > 100);
    assert.equal(copies[0][0].includes('$'), false);

    editor.destroy();
    dom.window.close();
});

test('copies rejected TeX that the reader shows as plain source', async () => {
    const { dom, document, editor, copies } = createEditor(
        'Before\n\n$$\n\\def\\x{boom}\n$$\n\nAfter'
    );

    assert.ok(document.querySelector('.cm-mktero-math-display .math-fallback'));
    await clickCopyButton(document.querySelector('.cm-mktero-math-copy'));

    assert.deepEqual(copies, [['\\def\\x{boom}']]);

    editor.destroy();
    dom.window.close();
});

test('reports a failed copy without leaving the button disabled', async () => {
    const { dom, document, editor } = createEditor('$$\nE = mc^2\n$$', {
        copyCode: async () => {
            throw new Error('clipboard unavailable');
        },
    });

    const button = document.querySelector('.cm-mktero-math-copy');
    await clickCopyButton(button);

    assert.equal(button.dataset.state, 'failed');
    assert.equal(button.textContent, 'Copy failed');
    assert.equal(button.disabled, false);

    editor.destroy();
    dom.window.close();
});

test('adds formula copying to a saved snapshot that keeps TeX', async () => {
    const dom = new JSDOM(
        `<!doctype html><div id="root">${renderZoteroNoteHTML(
            '$$\nE = mc^2\n$$\n\nInline $a_i$ and\n\n```js\nlet x = 1;\n```'
        )}</div>`,
        { pretendToBeVisual: true }
    );
    const { document } = dom.window;
    const root = document.querySelector('#root');
    const copies = [];
    const options = {
        copyCode: async (...args) => {
            copies.push(args);
        },
    };

    enhanceRenderedMathBlocks(root, document, options);
    enhanceRenderedMathBlocks(root, document, options);

    const wrapper = root.querySelector('.cm-mktero-math-block');
    assert.ok(wrapper);
    assert.equal(root.querySelectorAll('.cm-mktero-math-block').length, 1);
    assert.equal(root.querySelectorAll('.cm-mktero-math-copy').length, 1);
    assert.equal(wrapper.querySelector('pre.math').textContent, '$$E = mc^2$$');

    // Inline math and code blocks keep their existing rendering.
    assert.equal(root.querySelector('span.math .cm-mktero-math-copy'), null);
    assert.equal(
        root.querySelector('pre code').closest('.cm-mktero-math-block'),
        null
    );

    await clickCopyButton(wrapper.querySelector('.cm-mktero-math-copy'));

    assert.deepEqual(copies, [[
        'E = mc^2',
        { html: '<pre class="math">$$E = mc^2$$</pre>' },
    ]]);

    dom.window.close();
});

test('escapes hostile TeX in the formula HTML flavor', async () => {
    const latex = '<img src=x onerror=1>';
    const dom = new JSDOM('<!doctype html><div id="root"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const root = document.querySelector('#root');
    const pre = document.createElement('pre');
    pre.className = 'math';
    pre.textContent = `$$${latex}$$`;
    root.append(pre);
    const copies = [];
    enhanceRenderedMathBlocks(root, document, {
        copyCode: async (...args) => {
            copies.push(args);
        },
    });

    await clickCopyButton(root.querySelector('.cm-mktero-math-copy'));

    assert.equal(copies[0][0], latex);
    assert.equal(
        copies[0][1].html,
        '<pre class="math">$$&lt;img src=x onerror=1&gt;$$</pre>'
    );
    const html = copies[0][1].html;
    assert.equal(html.includes('<img'), false);
    assert.equal(html.includes('<script'), false);
    assert.match(html, /class="math"/);
    const parsed = new JSDOM(html).window.document;
    assert.equal(parsed.querySelector('img, script'), null);
    assert.equal(parsed.querySelector('pre.math').textContent, `$$${latex}$$`);
    for (const element of parsed.querySelectorAll('*')) {
        for (const attribute of [...element.attributes]) {
            assert.equal(/^on/i.test(attribute.name), false);
        }
    }

    dom.window.close();
});

test('copies a display formula as Zotero note math HTML', async () => {
    const latex = 'a^2+b^2=c^2';
    const { dom, document, editor, copies } = createEditor(
        `$$\n${latex}\n$$`
    );

    await clickCopyButton(document.querySelector('.cm-mktero-math-copy'));

    assert.deepEqual(copies, [[
        latex,
        { html: `<pre class="math">$$${latex}$$</pre>` },
    ]]);

    editor.destroy();
    dom.window.close();
});
