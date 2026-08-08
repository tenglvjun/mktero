import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createInlineMarkdownEditor } from '../src/editor/inline-markdown-editor.js';

test('renders selectable block translations without changing Markdown', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = '# Paper\n\nOriginal English paragraph.';
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.getElementById('editor'),
        initialMarkdown: markdown,
    });

    editor.setDocument({
        markdown,
        annotationOverlay: null,
        sourceMap: [],
        translationOverlay: {
            visible: true,
            targetLanguage: 'zh-CN',
            segments: [{
                id: 'segment-000001',
                from: markdown.indexOf('Original'),
                to: markdown.length,
                anchor: markdown.length,
                kind: 'paragraph',
                text: '原始英文段落包含公式 $x^2$。',
            }],
        },
    });

    const widget = document.querySelector('.cm-mktero-translation');
    assert.ok(widget);
    assert.match(widget.textContent, /原始英文段落包含公式/u);
    assert.ok(widget.querySelector('.math-inline'));
    assert.ok(widget.querySelector('math'));
    assert.equal(widget.getAttribute('lang'), 'zh-CN');
    assert.equal(widget.getAttribute('dir'), 'auto');
    assert.equal(editor.getMarkdown(), markdown);
    assert.equal(
        document.querySelector('.cm-content').getAttribute('contenteditable'),
        'false'
    );

    editor.setDocument({
        markdown,
        annotationOverlay: null,
        sourceMap: [],
        translationOverlay: {
            visible: false,
            targetLanguage: 'zh-CN',
            segments: [{
                id: 'segment-000001',
                anchor: markdown.length,
                kind: 'paragraph',
                text: '原始英文段落。',
            }],
        },
    });
    assert.equal(document.querySelector('.cm-mktero-translation'), null);
    assert.equal(editor.getMarkdown(), markdown);

    editor.setMarkdown('# Replacement');
    assert.equal(document.querySelector('.cm-mktero-translation'), null);
    assert.equal(editor.getMarkdown(), '# Replacement');

    editor.destroy();
    dom.window.close();
});

test('sanitizes adversarial HTML while still rendering translated math', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = '# Paper\n\nOriginal English paragraph.';
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.getElementById('editor'),
        initialMarkdown: markdown,
    });

    editor.setDocument({
        markdown,
        annotationOverlay: null,
        sourceMap: [],
        translationOverlay: {
            visible: true,
            targetLanguage: 'zh-CN',
            segments: [{
                id: 'segment-000001',
                from: markdown.indexOf('Original'),
                to: markdown.length,
                anchor: markdown.length,
                kind: 'paragraph',
                text: '原始公式 $E=mc^2$ <script>alert(1)</script>'
                    + '<img src=x onerror=alert(1)> 继续。',
            }],
        },
    });

    const widget = document.querySelector('.cm-mktero-translation');
    assert.ok(widget);
    assert.ok(widget.querySelector('.math-inline'));
    assert.ok(widget.querySelector('math'));
    assert.equal(widget.querySelectorAll('script').length, 0);
    assert.equal(widget.querySelectorAll('img').length, 0);
    assert.ok(!widget.querySelector('[onerror]'));
    assert.doesNotMatch(widget.innerHTML, /<(?:script|img)\b/i);
    assert.match(widget.innerHTML, /&lt;script&gt;/);
    assert.match(widget.innerHTML, /&lt;img /);
    assert.match(widget.textContent, /原始公式/);
    assert.match(widget.textContent, /继续/);

    editor.destroy();
    dom.window.close();
});
