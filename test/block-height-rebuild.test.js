import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorView } from '@codemirror/view';
import { JSDOM } from 'jsdom';
import { createInlineMarkdownEditor } from '../src/editor/inline-markdown-editor.js';

const LINE_HEIGHT = 20;

// jsdom has no layout. Stack the editor's top-level children so CodeMirror's
// measure pass reads real block heights: `heights` maps a widget class to a
// function of the element giving the height it lays out at, and every other
// line is LINE_HEIGHT tall.
function installStackedLayout(window, heights) {
    const rect = (top, height, width = 800) => ({
        top,
        bottom: top + height,
        left: 0,
        right: width,
        width,
        height,
        x: 0,
        y: top,
    });
    const heightOf = element => {
        for (const [className, height] of Object.entries(heights)) {
            if (element.classList?.contains(className)) return height(element);
        }
        return element.classList?.contains('cm-line') ? LINE_HEIGHT : 0;
    };
    const contentHeight = content => [...content.children]
        .reduce((total, child) => total + heightOf(child), 0);
    window.Element.prototype.getBoundingClientRect = function () {
        if (this.matches?.('.cm-editor, .cm-scroller, .cm-content')) {
            const content = this.classList.contains('cm-content')
                ? this
                : this.querySelector('.cm-content');
            return rect(0, Math.max(1, contentHeight(content)));
        }
        const content = this.parentElement;
        if (content?.classList?.contains('cm-content')) {
            let top = 0;
            for (const child of content.children) {
                if (child === this) break;
                top += heightOf(child);
            }
            return rect(top, heightOf(this));
        }
        return rect(0, 0, 0);
    };
    window.Range.prototype.getClientRects = () => [rect(0, LINE_HEIGHT, 8)];
    window.Range.prototype.getBoundingClientRect = () => rect(0, LINE_HEIGHT, 8);
}

function highlightOverlay(markdown, text) {
    const from = markdown.indexOf(text);
    return {
        matched: [{
            id: 'HIGHLIGHT1',
            type: 'highlight',
            text,
            comment: '',
            color: '#ffd400',
            pageLabel: '6',
            ranges: [{ from, to: from + text.length }],
        }],
        unmatched: [],
    };
}

function nextFrame(window) {
    return new Promise(resolve => window.requestAnimationFrame(() => resolve()));
}

test('keeps a measured figure height when a caption highlight rebuilds it', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { window } = dom;
    installStackedLayout(window, { 'cm-mktero-image': () => 1000 });
    const markdown = [
        '![Figure 5. Interval tachogram of 256 consecutive RR values.](images/figure.png)',
        'Text after the figure.',
    ].join('\n\n');
    const editor = createInlineMarkdownEditor({
        parent: window.document.querySelector('#editor'),
        initialMarkdown: '',
        resolveImageURL: () => 'blob:mktero-figure',
    });
    editor.setDocument({
        markdown,
        annotationOverlay: { matched: [], unmatched: [] },
    });
    const view = EditorView.findFromDOM(window.document.querySelector('.cm-editor'));
    view.measure();
    assert.equal(view.lineBlockAt(0).height, 1000);

    editor.setDocument({
        markdown,
        annotationOverlay: highlightOverlay(markdown, 'Interval tachogram'),
    });

    assert.ok(window.document.querySelector(
        '.cm-mktero-image figcaption .cm-mktero-pdf-annotation'
    ));
    // Until the next measure, CodeMirror sizes the rebuilt figure from its
    // estimate. One line here moves everything below the figure up.
    assert.equal(view.lineBlockAt(0).height, 1000);

    editor.destroy();
    window.close();
});

test('keeps a measured table height when a cell highlight rebuilds it', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { window } = dom;
    installStackedLayout(window, { 'cm-mktero-table': () => 1200 });
    const markdown = [
        '| Variable | Description |',
        '| --- | --- |',
        '| SDNN | Standard deviation of all NN intervals |',
        '| RMSSD | Square root of the mean squared differences |',
        '',
        'Text after the table.',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: window.document.querySelector('#editor'),
        initialMarkdown: '',
    });
    editor.setDocument({
        markdown,
        annotationOverlay: { matched: [], unmatched: [] },
    });
    const view = EditorView.findFromDOM(window.document.querySelector('.cm-editor'));
    view.measure();
    assert.equal(view.lineBlockAt(0).height, 1200);

    editor.setDocument({
        markdown,
        annotationOverlay: highlightOverlay(markdown, 'Square root of the mean'),
    });

    assert.ok(window.document.querySelector(
        '.cm-mktero-table .cm-mktero-pdf-annotation'
    ));
    assert.equal(view.lineBlockAt(0).height, 1200);

    editor.destroy();
    window.close();
});

test('measures a figure again when its image finishes loading', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { window } = dom;
    let figureHeight = 40;
    installStackedLayout(window, { 'cm-mktero-image': () => figureHeight });
    const markdown = [
        '![Figure 5. Interval tachogram of 256 consecutive RR values.](images/figure.png)',
        'Text after the figure.',
    ].join('\n\n');
    const editor = createInlineMarkdownEditor({
        parent: window.document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => 'blob:mktero-figure',
    });
    const view = EditorView.findFromDOM(window.document.querySelector('.cm-editor'));
    // The first measure runs before the image decodes and sees only the caption.
    view.measure();
    assert.equal(view.lineBlockAt(0).height, 40);

    figureHeight = 1000;
    window.document.querySelector('.cm-mktero-image img')
        .dispatchEvent(new window.Event('load'));
    await nextFrame(window);

    assert.equal(view.lineBlockAt(0).height, 1000);

    editor.destroy();
    window.close();
});

test('holds a rebuilt figure at its measured height until its new image loads', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { window } = dom;
    // An undecoded image lays out at zero height, so the block is only its
    // caption until the image loads; a min-height still holds it open.
    installStackedLayout(window, {
        'cm-mktero-image': element => Math.max(
            Number.parseFloat(element.style.minHeight) || 0,
            element.querySelector('img')?.dataset.decoded ? 1000 : 40
        ),
    });
    const loadImage = () => {
        const image = window.document.querySelector('.cm-mktero-image img');
        image.dataset.decoded = 'true';
        image.dispatchEvent(new window.Event('load'));
    };
    const markdown = [
        '![Figure 5. Interval tachogram of 256 consecutive RR values.](images/figure.png)',
        'Text after the figure.',
    ].join('\n\n');
    const editor = createInlineMarkdownEditor({
        parent: window.document.querySelector('#editor'),
        initialMarkdown: '',
        resolveImageURL: () => 'blob:mktero-figure',
    });
    editor.setDocument({
        markdown,
        annotationOverlay: { matched: [], unmatched: [] },
    });
    const view = EditorView.findFromDOM(window.document.querySelector('.cm-editor'));
    view.measure();
    loadImage();
    await nextFrame(window);
    assert.equal(view.lineBlockAt(0).height, 1000);

    editor.setDocument({
        markdown,
        annotationOverlay: highlightOverlay(markdown, 'Interval tachogram'),
    });
    // The rebuilt figure has a new image that has not decoded yet.
    view.measure();
    assert.equal(view.lineBlockAt(0).height, 1000);

    loadImage();
    await nextFrame(window);
    assert.equal(
        window.document.querySelector('.cm-mktero-image').style.minHeight,
        ''
    );
    assert.equal(view.lineBlockAt(0).height, 1000);

    editor.destroy();
    window.close();
});
