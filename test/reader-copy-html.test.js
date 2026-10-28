import test from 'node:test';
import assert from 'node:assert/strict';
import { forceParsing } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { JSDOM } from 'jsdom';
import { createInlineMarkdownEditor } from '../src/editor/inline-markdown-editor.js';
import {
    MAX_NOTE_CLIPBOARD_FORMULAS,
    MAX_NOTE_CLIPBOARD_SOURCE_LENGTH,
    noteMathClipboardHTML,
    zoteroNoteClipboardHTML,
    zoteroNoteMarkdownHTML,
    zoteroNoteTableClipboardHTML,
} from '../src/markdown/zotero-note-clipboard.js';
import { readerPassageCopy } from '../src/editor/reader-copy-html.js';
import { tableElementToGFM } from '../src/markdown/markdown-table-export.js';
import { renderMarkdownHTML } from '../src/markdown/markdown-html.js';

const PASSAGE = String.raw`where $\mu$ is the mean and $i$ is the locus.`;

function createEditor(markdown, options = {}) {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { window } = dom;
    const editor = createInlineMarkdownEditor({
        parent: window.document.querySelector('#editor'),
        initialMarkdown: '',
        ...options,
    });
    editor.setDocument({ markdown, ...(options.documentOptions || {}) });
    const view = EditorView.findFromDOM(window.document.querySelector('.cm-editor'));
    if (view) forceParsing(view, view.state.doc.length, 1000);
    return { dom, window, document: window.document, editor, view };
}

function dispatchCopy(window, target) {
    const data = new Map();
    const event = new window.Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
        value: {
            clearData: () => data.clear(),
            setData: (type, value) => data.set(type, String(value)),
            getData: type => data.get(type) || '',
        },
    });
    target.dispatchEvent(event);
    return { event, data };
}

function selectNodeContents(window, node) {
    const range = window.document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return range;
}

test('note HTML of a figure caption typesets the formula the reader shows', () => {
    const markdown = String.raw`![Figure 1. point $\\hat{G}$ and $P - \\hat{G}$ isolates.](figures/fig.png)`;
    const from = markdown.indexOf('point');
    const to = markdown.indexOf('isolates.') + 'isolates'.length;
    const html = zoteroNoteClipboardHTML(markdown, { from, to });

    assert.match(html, /<span class="math">\$\\hat\{G\}\$<\/span>/u);
    assert.match(html, /<span class="math">\$P - \\hat\{G\}\$<\/span>/u);
    assert.doesNotMatch(html, />\$hat\{G\}\$</u);
});

test('a copy of a rendered figure caption keeps the formula the reader shows', () => {
    const markdown = String.raw`![Figure 1. point $\\hat{G}$ and the deviation $P - \\hat{G}$ isolates.](figures/fig.png)
`;
    const reader = createEditor(markdown);
    try {
        const caption = reader.document.querySelector('figcaption');
        assert.ok(caption);
        selectNodeContents(reader.window, caption);
        const { event, data } = dispatchCopy(reader.window, caption);

        assert.equal(event.defaultPrevented, true);
        assert.match(data.get('text/plain'), /\$\\hat\{G\}\$/u);
        assert.match(data.get('text/plain'), /\$P - \\hat\{G\}\$/u);
        assert.doesNotMatch(data.get('text/plain'), /\$\\\\hat/u);
        assert.match(data.get('text/html'), /<span class="math">\$\\hat\{G\}\$<\/span>/u);
        assert.equal(noteMathClipboardHTML(data.get('text/html')), data.get('text/html'));
    }
    finally {
        reader.editor.destroy();
        reader.dom.window.close();
    }
});

test('note HTML of a passage keeps every formula, single letters included', () => {
    const markdown = `# Title\n\n${PASSAGE}\n`;
    const from = markdown.indexOf('where');
    const html = zoteroNoteClipboardHTML(markdown, {
        from,
        to: from + PASSAGE.length,
    });

    assert.equal(
        html,
        '<p>where <span class="math">$\\mu$</span> is the mean and '
        + '<span class="math">$i$</span> is the locus.</p>'
    );
});

test('note HTML takes a whole formula a range cuts and leaves out page chrome', () => {
    const markdown = 'Text $\\alpha + \\beta$ end.\n\nRunning header\n\n$$\nx^2\n$$';
    const cut = markdown.indexOf('+');
    assert.equal(
        zoteroNoteClipboardHTML(markdown, { from: 0, to: cut }),
        '<p>Text <span class="math">$\\alpha + \\beta$</span></p>'
    );

    const header = markdown.indexOf('Running header');
    const html = zoteroNoteClipboardHTML(markdown, { from: 0, to: markdown.length }, {
        chromeRanges: [{ from: header, to: header + 'Running header'.length }],
    });
    assert.doesNotMatch(html, /Running header/u);
    assert.match(html, /<pre class="math">\$\$x\^2\$\$<\/pre>/u);
});

test('note HTML is empty for bad ranges, huge copies, and stays escaped', () => {
    const markdown = 'A <img src=x onerror=alert(1)> and $x</span><b>$';
    assert.equal(zoteroNoteClipboardHTML(markdown, { from: 4, to: 2 }), '');
    assert.equal(zoteroNoteClipboardHTML(markdown, {}), '');
    assert.equal(
        zoteroNoteClipboardHTML('$x$ '.repeat(MAX_NOTE_CLIPBOARD_SOURCE_LENGTH), {
            from: 0,
            to: MAX_NOTE_CLIPBOARD_SOURCE_LENGTH + 1,
        }),
        ''
    );
    const html = zoteroNoteClipboardHTML(markdown, { from: 0, to: markdown.length });
    assert.doesNotMatch(html, /<img|<b>/u);
    assert.match(html, /&lt;img/u);

    assert.equal(zoteroNoteTableClipboardHTML('Not a table.'), '');
    assert.match(
        zoteroNoteTableClipboardHTML('| A | B |\n| --- | --- |\n| $i$ | $\\beta$ |'),
        /<td><span class="math">\$i\$<\/span><\/td>/u
    );
});

test('a hosted note paste accepts only note math markup', () => {
    const formula = '<pre class="math">$$\\hat{G}_t$$</pre>';
    assert.equal(noteMathClipboardHTML(formula), formula);
    assert.equal(noteMathClipboardHTML('  <span class="math">$\\mu$</span>  '), '<span class="math">$\\mu$</span>');
    assert.equal(noteMathClipboardHTML('<p>Plain words</p>'), '');
    assert.equal(
        noteMathClipboardHTML('<pre class="math">$$x$$</pre><script>alert(1)</script>'),
        ''
    );
    assert.equal(
        noteMathClipboardHTML('<span class="math" onclick="alert(1)">$x$</span>'),
        ''
    );
});

test('note HTML is left out without a formula or a table, or with too many formulas', () => {
    const plain = 'Plain **bold** words with a [link](https://example.org).';
    assert.equal(zoteroNoteClipboardHTML(plain, { from: 0, to: plain.length }), '');

    const many = Array.from(
        { length: MAX_NOTE_CLIPBOARD_FORMULAS + 1 },
        (_, index) => `$x_${index}$`
    ).join(' ');
    assert.equal(zoteroNoteClipboardHTML(many, { from: 0, to: many.length }), '');

    const table = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    assert.match(zoteroNoteClipboardHTML(table, { from: 0, to: table.length }), /<table>/u);
});

test('a keyboard copy of a passage adds its note HTML beside the Markdown', async () => {
    const markdown = `${PASSAGE}\n\nSecond.`;
    const reader = createEditor(markdown);
    try {
        // CodeMirror copies only when the DOM selection is inside it.
        const line = reader.document.querySelector('.cm-line');
        selectNodeContents(reader.window, line);
        reader.view.dispatch({ selection: { anchor: 0, head: PASSAGE.length } });
        const { event, data } = dispatchCopy(reader.window, reader.view.contentDOM);

        assert.equal(event.defaultPrevented, true);
        assert.equal(data.get('text/plain'), PASSAGE);
        assert.match(data.get('text/html'), /<span class="math">\$i\$<\/span>/u);
        assert.match(data.get('text/html'), /<span class="math">\$\\mu\$<\/span>/u);
    }
    finally {
        reader.editor.destroy();
        reader.dom.window.close();
    }
});

test('a keyboard copy is standard Markdown: reader TeX, no page chrome', () => {
    const header = 'Journal Running Header';
    const markdown = [
        String.raw`Estimate $\hat {G} _ {t}$ first.`,
        '<!-- zotero-page: 2 -->',
        header,
        '',
        '$$',
        String.raw`\int_ {0} ^ {1} f \tag{1}`,
        '$$',
    ].join('\n');
    const from = markdown.indexOf(header);
    const reader = createEditor(markdown, {
        documentOptions: {
            chromeRanges: [{ from, to: from + header.length + 1 }],
        },
    });
    try {
        const line = reader.document.querySelector('.cm-line');
        selectNodeContents(reader.window, line);
        reader.view.dispatch({ selection: { anchor: 0, head: markdown.length } });
        const { event, data } = dispatchCopy(reader.window, reader.view.contentDOM);

        assert.equal(event.defaultPrevented, true);
        assert.equal(data.get('text/plain'), [
            String.raw`Estimate $\hat{G} _{t}$ first.`,
            '',
            '$$',
            String.raw`\int_{0} ^{1} f \tag{1}`,
            '$$',
        ].join('\n'));
        assert.match(data.get('text/html'), /<span class="math">\$\\hat\{G\} _\{t\}\$<\/span>/u);
        assert.match(data.get('text/html'), /<pre class="math">\$\$\\int_\{0\} \^\{1\} f \\tag\{1\}\$\$<\/pre>/u);
        assert.doesNotMatch(data.get('text/html'), /Running Header/u);
    }
    finally {
        reader.editor.destroy();
        reader.dom.window.close();
    }
});

test('a keyboard copy writes an HTML table as a GFM table with its formulas', () => {
    const markdown = 'Intro.\n\n<table><tr><th>Norm</th></tr><tr><td>$a|b$</td></tr></table>\n\nEnd.';
    const reader = createEditor(markdown);
    try {
        const line = reader.document.querySelector('.cm-line');
        selectNodeContents(reader.window, line);
        reader.view.dispatch({ selection: { anchor: 0, head: markdown.length } });
        const { data } = dispatchCopy(reader.window, reader.view.contentDOM);

        assert.equal(
            data.get('text/plain'),
            'Intro.\n\n| Norm |\n| --- |\n| $a\\vert b$ |\n\nEnd.'
        );
        assert.match(data.get('text/html'), /<table>/u);
    }
    finally {
        reader.editor.destroy();
        reader.dom.window.close();
    }
});

test('a copy without formulas, a stale state, or after destroy gets no note HTML', () => {
    const markdown = 'Plain **bold** words.\n\nMean $\\mu$ here.';
    const reader = createEditor(markdown);
    try {
        const line = reader.document.querySelector('.cm-line');
        selectNodeContents(reader.window, line);
        reader.view.dispatch({ selection: { anchor: 0, head: 21 } });
        const plain = dispatchCopy(reader.window, reader.view.contentDOM);
        assert.equal(plain.data.get('text/plain'), 'Plain **bold** words.');
        assert.equal(plain.data.has('text/html'), false);

        // Another handler wrote text that is not CodeMirror's selection.
        reader.view.dispatch({ selection: { anchor: markdown.indexOf('Mean'), head: markdown.length } });
        const foreign = new Map();
        const event = new reader.window.Event('copy', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clipboardData', {
            value: {
                clearData: () => foreign.clear(),
                setData: (type, value) => foreign.set(type, String(value)),
                getData: type => foreign.get(type) || '',
            },
        });
        reader.view.contentDOM.addEventListener('copy', copy => {
            copy.clipboardData.setData('text/plain', 'Someone else');
            copy.preventDefault();
            copy.stopImmediatePropagation();
        }, { capture: true, once: true });
        reader.view.contentDOM.dispatchEvent(event);
        assert.equal(foreign.get('text/plain'), 'Someone else');
        assert.equal(foreign.has('text/html'), false);
    }
    finally {
        reader.editor.destroy();
    }
    // The listener left with the editor.
    const after = dispatchCopy(reader.window, reader.document.querySelector('#editor'));
    assert.equal(after.data.size, 0);
    reader.dom.window.close();
});

test('a copy inside a rendered display formula copies its source and note HTML', () => {
    const markdown = 'Intro.\n\n$$\n\\hat{G} = \\mu \\tag{2}\n$$\n\nEnd.';
    const reader = createEditor(markdown);
    try {
        const formula = reader.document.querySelector('.cm-mktero-math-display');
        assert.ok(formula);
        const math = formula.querySelector('math') || formula;
        selectNodeContents(reader.window, math);
        const { event, data } = dispatchCopy(reader.window, math);

        assert.equal(event.defaultPrevented, true);
        assert.equal(data.get('text/plain'), '$$\n\\hat{G} = \\mu \\tag{2}\n$$');
        assert.equal(
            data.get('text/html'),
            '<pre class="math">$$\\hat{G} = \\mu \\tag{2}$$</pre>'
        );
    }
    finally {
        reader.editor.destroy();
        reader.dom.window.close();
    }
});

test('a copy across cells of a rendered table copies them as a table', () => {
    const markdown = 'Intro.\n\n| Model | Loss |\n| --- | --- |\n| A | $\\alpha_i$ |\n| B | $i$ |\n\nEnd.';
    const reader = createEditor(markdown);
    try {
        const cells = [...reader.document.querySelectorAll('.cm-mktero-table td')];
        assert.equal(cells.length, 4);
        const range = reader.document.createRange();
        range.setStart(cells[0].firstChild || cells[0], 0);
        range.setEnd(cells[3], cells[3].childNodes.length);
        const selection = reader.window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        const { event, data } = dispatchCopy(reader.window, cells[0]);

        assert.equal(event.defaultPrevented, true);
        assert.match(data.get('text/plain'), /^\| A \| \$\\alpha_i\$ \|/u);
        assert.match(data.get('text/html'), /<table>/u);
        assert.match(data.get('text/html'), /<span class="math">\$i\$<\/span>/u);
    }
    finally {
        reader.editor.destroy();
        reader.dom.window.close();
    }
});

test('a copy from a text field or outside the reader keeps the browser copy', () => {
    const reader = createEditor(`${PASSAGE}\n`);
    try {
        const input = reader.document.createElement('input');
        reader.view.dom.appendChild(input);
        const fromInput = dispatchCopy(reader.window, input);
        assert.equal(fromInput.event.defaultPrevented, false);
        assert.equal(fromInput.data.size, 0);

        // A plain passage selected outside .cm-content stays the browser's.
        const line = reader.document.querySelector('.cm-line');
        selectNodeContents(reader.window, line);
        const outside = dispatchCopy(
            reader.window,
            reader.document.querySelector('.cm-editor')
        );
        assert.equal(outside.event.defaultPrevented, false);
    }
    finally {
        reader.editor.destroy();
        reader.dom.window.close();
    }
});

test('Copy as Markdown of an OCR table keeps formulas with bars as TeX', () => {
    const dom = new JSDOM(`<body>${renderMarkdownHTML(
        '<table><tr><td>Norm</td><td>$\\|x\\|_2$</td></tr>'
        + '<tr><td>Set</td><td>$a|b$ and $i$</td></tr></table>'
    )}</body>`);
    try {
        const gfm = tableElementToGFM(dom.window.document.querySelector('table'));
        assert.equal(
            gfm,
            '| Norm | $\\Vert x\\Vert _2$ |\n| --- | --- |\n| Set | $a\\vert b$ and $i$ |'
        );
        const html = zoteroNoteTableClipboardHTML(gfm);
        assert.match(html, /<span class="math">\$a\\vert b\$<\/span>/u);
        assert.match(html, /<span class="math">\$i\$<\/span>/u);
    }
    finally {
        dom.window.close();
    }
});

test('a reader passage copy has both flavors, and a cell copy reads as its text', () => {
    const passage = String.raw`Mean $\mu _ {i}$ here.`;
    assert.deepEqual(readerPassageCopy(passage, { from: 0, to: passage.length }), {
        text: String.raw`Mean $\mu _{i}$ here.`,
        html: String.raw`<p>Mean <span class="math">$\mu _{i}$</span> here.</p>`,
    });

    const table = '<table><tr><td>Norm $x _ {2}$</td></tr></table>';
    const from = table.indexOf('Norm');
    const copy = readerPassageCopy(table, { from, to: table.indexOf('</td>') });
    assert.equal(copy.text, 'Norm $x _{2}$');
    assert.equal(readerPassageCopy(passage, { from: 3, to: 1 }), null);
});

test('a sourced quote gets note HTML with its formulas and source link', () => {
    const html = zoteroNoteMarkdownHTML([
        String.raw`> Estimate $\hat{G}_t$ \<b\>here\</b\>\.`,
        '',
        'Source: [Paper, p. 3](zotero://open-pdf/library/items/ABC123?page=3)',
    ].join('\n'));

    assert.match(html, /<blockquote>/u);
    assert.match(html, /<span class="math">\$\\hat\{G\}_t\$<\/span>/u);
    assert.match(html, /&lt;b&gt;here&lt;\/b&gt;\./u);
    assert.match(html, /<a href="zotero:\/\/open-pdf\/library\/items\/ABC123\?page=3"/u);
    assert.equal(zoteroNoteMarkdownHTML('   '), '');
    assert.equal(zoteroNoteMarkdownHTML('x'.repeat(MAX_NOTE_CLIPBOARD_SOURCE_LENGTH + 1)), '');
});
