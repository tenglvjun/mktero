import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorView } from '@codemirror/view';
import { JSDOM } from 'jsdom';
import { createInlineMarkdownEditor } from '../src/editor/inline-markdown-editor.js';
import { createLocalization } from '../src/i18n/localization.js';

test('previews a captioned image from its prose figure reference', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        'The screening process appears in Figure 1.',
        '',
        '![Figure 1. PRISMA flowchart](images/flow.png)',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: path => `blob:mktero-${path}`,
    });
    const reference = document.querySelector('.cm-mktero-figure-reference');

    assert.equal(reference?.textContent, 'Figure 1');
    assert.equal(reference?.getAttribute('role'), 'link');
    assert.equal(reference?.getAttribute('tabindex'), '0');
    reference.dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));

    const popup = document.querySelector('.mktero-figure-preview-popup');
    assert.equal(popup?.getAttribute('aria-label'), 'Figure preview');
    assert.equal(
        popup?.querySelector('img')?.getAttribute('src'),
        'blob:mktero-images/flow.png'
    );
    assert.equal(
        popup?.querySelector('figcaption')?.textContent,
        'Figure 1. PRISMA flowchart'
    );
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('localizes figure reference controls', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: [
            '结果见 Figure 1。',
            '',
            '![Figure 1. 流程图](images/flow.png)',
        ].join('\n'),
        resolveImageURL: path => `blob:mktero-${path}`,
        localization: createLocalization({ zoteroLocale: 'zh-CN' }),
    });
    const reference = document.querySelector('.cm-mktero-figure-reference');

    assert.equal(
        reference.getAttribute('aria-label'),
        '预览并跳转到 Figure 1.'
    );
    reference.dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    assert.equal(
        document.querySelector('.mktero-figure-preview-popup')
            ?.getAttribute('aria-label'),
        '图片预览'
    );

    editor.destroy();
    dom.window.close();
});

test('previews every panel in a referenced shared-caption figure', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        'The ablation is reported in Fig. 2.',
        '',
        '![](images/panel-a.png)',
        '',
        '![](images/panel-b.png)  ',
        'Figure 2. Ablation results.',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: path => `blob:mktero-${path}`,
    });

    document.querySelector('.cm-mktero-figure-reference').dispatchEvent(
        new dom.window.MouseEvent('mouseover', { bubbles: true })
    );

    const popup = document.querySelector('.mktero-figure-preview-popup');
    assert.equal(popup?.querySelectorAll('img').length, 2);
    assert.equal(
        popup?.querySelector('figcaption')?.textContent,
        'Figure 2. Ablation results.'
    );
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('jumps to and highlights a clicked figure reference for three seconds', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        'The screening process appears in Figure 1.',
        '',
        '![Figure 1. PRISMA flowchart](images/flow.png)',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: path => `blob:mktero-${path}`,
    });
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    const figureOffset = markdown.indexOf('![Figure 1.');
    const scheduled = [];
    const originalSetTimeout = dom.window.setTimeout;
    const originalClearTimeout = dom.window.clearTimeout;
    dom.window.setTimeout = (callback, delay) => {
        scheduled.push({ callback, delay });
        return scheduled.length;
    };
    dom.window.clearTimeout = () => {};
    view.lineBlockAt = position => {
        assert.equal(position, figureOffset);
        return { top: 640 };
    };
    view.requestMeasure = request => {
        if (!request?.read) return;
        request.write?.(request.read(view), view);
    };
    view.scrollDOM.scrollTop = 0;
    const reference = document.querySelector('.cm-mktero-figure-reference');
    reference.dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    reference.dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));

    assert.equal(view.scrollDOM.scrollTop, 640);
    assert.equal(document.querySelector('.mktero-figure-preview-popup'), null);
    assert.ok(document.querySelector(
        '.cm-mktero-image.cm-mktero-figure-target-highlight'
    ));
    assert.equal(scheduled.at(-1)?.delay, 3000);

    scheduled.at(-1).callback();
    assert.equal(
        document.querySelector('.cm-mktero-figure-target-highlight'),
        null
    );

    reference.focus();
    reference.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Enter',
    }));
    assert.ok(document.querySelector('.cm-mktero-figure-target-highlight'));
    assert.equal(document.querySelector('.mktero-figure-preview-popup'), null);
    assert.equal(scheduled.at(-1)?.delay, 3000);
    assert.equal(editor.getMarkdown(), markdown);

    dom.window.setTimeout = originalSetTimeout;
    dom.window.clearTimeout = originalClearTimeout;
    editor.destroy();
    dom.window.close();
});
