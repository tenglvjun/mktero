import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createInlineMarkdownEditor } from '../src/editor/inline-markdown-editor.js';

function createEditor(markdown) {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });
    return { dom, document, editor };
}

test('highlights document search matches without creating a selection', () => {
    const markdown = 'See BERT in methods and BERT again.';
    const { dom, document, editor } = createEditor(markdown);
    const first = markdown.indexOf('BERT');
    const second = markdown.lastIndexOf('BERT');

    try {
        editor.setDocumentSearchHighlights({
            matches: [
                { from: first, to: first + 4 },
                { from: second, to: second + 4 },
            ],
            activeIndex: 1,
        });

        const matches = [...document.querySelectorAll('.cm-mktero-search-match')];
        assert.deepEqual(matches.map(match => match.textContent), ['BERT', 'BERT']);
        assert.equal(
            document.querySelector('.cm-mktero-search-match.is-active')?.textContent,
            'BERT'
        );
        assert.equal(matches[1].classList.contains('is-active'), true);
        assert.equal(matches[0].classList.contains('is-active'), false);
        assert.equal(document.querySelector('.mktero-annotation-popup'), null);
    }
    finally {
        editor.destroy();
        dom.window.close();
    }
});

test('clears document search highlights when the document is replaced', () => {
    const markdown = 'See BERT in methods.';
    const { dom, document, editor } = createEditor(markdown);
    const from = markdown.indexOf('BERT');

    try {
        editor.setDocumentSearchHighlights({
            matches: [{ from, to: from + 4 }],
            activeIndex: 0,
        });
        assert.equal(
            document.querySelector('.cm-mktero-search-match')?.textContent,
            'BERT'
        );

        editor.setDocument({ markdown: 'See BERT in methods.' });
        assert.equal(document.querySelector('.cm-mktero-search-match'), null);
    }
    finally {
        editor.destroy();
        dom.window.close();
    }
});
