import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorView } from '@codemirror/view';
import { JSDOM } from 'jsdom';
import {
    MarkdownAnnotationOverlay,
} from '../src/core/markdown-annotation-overlay.js';
import { createInlineMarkdownEditor } from '../src/editor/inline-markdown-editor.js';

function enterTableCellEditing(cell, ownerWindow) {
    cell.dispatchEvent(new ownerWindow.MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));
}

function textNodeContaining(element, text) {
    const walker = element.ownerDocument.createTreeWalker(
        element,
        element.ownerDocument.defaultView.NodeFilter.SHOW_TEXT
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent.includes(text)) return node;
    }
    return null;
}

test('keeps Markdown as the source of truth in a read-only surface', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const initialMarkdown = '# Paper\n\n**Unchanged** source.';
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown,
        resolveImageURL: () => null,
        openLink: () => {},
    });

    assert.ok(document.querySelector('.cm-editor'));
    assert.equal(editor.getMarkdown(), initialMarkdown);
    assert.equal(
        document.querySelector('.cm-content').getAttribute('contenteditable'),
        'false'
    );

    const updatedMarkdown = '# Updated\n\n$E = mc^2$';
    editor.setMarkdown(updatedMarkdown);
    assert.equal(editor.getMarkdown(), updatedMarkdown);
    assert.equal(
        document.querySelector('.cm-content').getAttribute('contenteditable'),
        'false'
    );

    editor.destroy();
    assert.doesNotThrow(() => editor.destroy());
    assert.equal(document.querySelector('.cm-editor'), null);
    dom.window.close();
});

test('shows accessible PDF source actions only for mapped Markdown blocks', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'Mapped paragraph with source.\n\nUnmapped paragraph.';
    const locations = [{
        pageIndex: 2,
        bbox: [100, 200, 900, 300],
    }, {
        pageIndex: 3,
        bbox: [100, 100, 900, 180],
    }];
    const opened = [];
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
        resolveImageURL: () => null,
        openSourceLocation: location => opened.push(location),
    });

    editor.setDocument({
        markdown,
        sourceMap: [{
            type: 'text',
            markdownFrom: 0,
            markdownTo: markdown.indexOf('\n\n'),
            locations,
        }],
    });

    const actions = document.querySelectorAll('.cm-mktero-source-link');
    assert.equal(actions.length, 1);
    assert.equal(actions[0].localName, 'button');
    assert.equal(actions[0].getAttribute('aria-label'), 'View in PDF');
    assert.equal(actions[0].getAttribute('title'), 'View in PDF');
    assert.equal(actions[0].getAttribute('data-location-count'), '2');
    assert.equal(
        actions[0].querySelector('svg')?.getAttribute('data-lucide'),
        'external-link'
    );

    const mappedText = textNodeContaining(
        document.querySelector('.cm-content'),
        'Mapped paragraph'
    );
    const selection = dom.window.getSelection();
    const range = document.createRange();
    range.setStart(mappedText, 0);
    range.setEnd(mappedText, 6);
    selection.removeAllRanges();
    selection.addRange(range);
    actions[0].click();
    await Promise.resolve();

    assert.deepEqual(opened, [locations[0]]);
    assert.equal(selection.toString(), 'Mapped');

    editor.setDocument({ markdown, sourceMap: [] });
    assert.equal(document.querySelector('.cm-mktero-source-link'), null);

    editor.destroy();
    dom.window.close();
});

test('keeps PDF source actions beside rendered image, formula, and table blocks', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const blocks = [
        '![Figure](images/figure.png)',
        '$$\nE = mc^2\n$$',
        '| A | B |\n| --- | --- |\n| 1 | 2 |',
    ];
    const markdown = blocks.join('\n\n');
    const sourceMap = blocks.map((block, index) => {
        const markdownFrom = markdown.indexOf(block);
        return {
            type: ['image', 'equation', 'table'][index],
            markdownFrom,
            markdownTo: markdownFrom + block.length,
            locations: [{
                pageIndex: index,
                bbox: [100, 100, 900, 700],
            }],
        };
    });
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
        resolveImageURL: () => 'blob:figure',
        openSourceLocation: () => {},
    });

    editor.setDocument({ markdown, sourceMap });

    assert.equal(
        document.querySelectorAll('.cm-mktero-source-link').length,
        3
    );
    assert.ok(document.querySelector('.cm-mktero-image'));
    assert.ok(document.querySelector('.cm-mktero-math-display'));
    assert.ok(document.querySelector('.cm-mktero-table'));

    editor.destroy();
    dom.window.close();
});

test('keeps separate PDF source actions for a grouped table caption and body', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const caption = 'Table 1. Values by group';
    const table = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const markdown = `${caption}\n\n${table}`;
    const sourceMap = [caption, table].map((block, index) => ({
        type: index === 0 ? 'text' : 'table',
        markdownFrom: markdown.indexOf(block),
        markdownTo: markdown.indexOf(block) + block.length,
        locations: [{
            pageIndex: index,
            bbox: [100, 100, 900, 300],
        }],
    }));
    const opened = [];
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
        resolveImageURL: () => null,
        openSourceLocation: location => opened.push(location),
    });

    editor.setDocument({ markdown, sourceMap });

    const renderedTable = document.querySelector('.cm-mktero-table');
    const actions = renderedTable.querySelectorAll('.cm-mktero-source-link');
    assert.equal(actions.length, 2);
    actions[1].click();
    await Promise.resolve();
    assert.deepEqual(opened, [sourceMap[1].locations[0]]);

    editor.destroy();
    dom.window.close();
});

test('shows a separate PDF source action for each mapped figure panel', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const panels = [
        '![](images/panel-a.jpg)',
        '![](images/panel-b.jpg)',
    ];
    const markdown = `${panels.join('\n\n')}  \nFigure 1. Panel comparison.`;
    const locations = panels.map((panel, index) => ({
        type: 'image',
        markdownFrom: markdown.indexOf(panel),
        markdownTo: markdown.indexOf(panel) + panel.length,
        locations: [{
            pageIndex: index,
            bbox: [100, 100, 900, 700],
        }],
    }));
    const opened = [];
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
        resolveImageURL: path => `blob:mktero-${path}`,
        openSourceLocation: location => opened.push(location),
    });

    editor.setDocument({ markdown, sourceMap: locations });

    const figure = document.querySelector('.mktero-figure-group');
    const actions = figure.querySelectorAll('.cm-mktero-source-link');
    assert.equal(actions.length, 2);
    assert.equal(figure.querySelectorAll('.mktero-figure-source-panel').length, 2);
    actions[1].click();
    await Promise.resolve();
    assert.deepEqual(opened, [locations[1].locations[0]]);

    editor.destroy();
    dom.window.close();
});

test('omits PDF source actions for malformed source-map entries', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'Mapped paragraph with invalid source coordinates.';
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
        resolveImageURL: () => null,
        openSourceLocation: () => {},
    });

    editor.setDocument({
        markdown,
        sourceMap: [{
            type: 'text',
            markdownFrom: 0,
            markdownTo: markdown.length,
            locations: [{
                pageIndex: 0,
                bbox: [100, 100, 1001, 200],
            }],
        }],
    });

    assert.equal(document.querySelector('.cm-mktero-source-link'), null);

    editor.destroy();
    dom.window.close();
});

test('does not duplicate a paragraph source action on its inline formula', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'Mapped paragraph with inline $x^2$ formula.';
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
        resolveImageURL: () => null,
        openSourceLocation: () => {},
    });

    editor.setDocument({
        markdown,
        sourceMap: [{
            type: 'text',
            markdownFrom: 0,
            markdownTo: markdown.length,
            locations: [{
                pageIndex: 0,
                bbox: [100, 100, 900, 180],
            }],
        }],
    });

    assert.equal(
        document.querySelectorAll('.cm-mktero-source-link').length,
        1
    );
    assert.ok(document.querySelector('.cm-mktero-math'));

    editor.destroy();
    dom.window.close();
});

test('renders matched PDF annotations with their Zotero colors', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
        resolveImageURL: () => null,
    });

    editor.setDocument({
        markdown: 'Important result.',
        annotationOverlay: {
            matched: [{
                id: 'HIGH0001',
                type: 'highlight',
                text: 'Important',
                comment: 'Review this',
                color: '#ffd400',
                pageLabel: '4',
                ranges: [{ from: 0, to: 9 }],
            }],
            unmatched: [],
        },
    });

    const annotation = document.querySelector('.cm-mktero-pdf-annotation');
    assert.equal(annotation.textContent, 'Important');
    assert.ok(annotation.classList.contains(
        'cm-mktero-pdf-annotation--highlight'
    ));
    assert.equal(annotation.getAttribute('data-annotation-id'), 'HIGH0001');
    assert.match(
        annotation.getAttribute('style'),
        /--mktero-annotation-color:\s*#ffd400/
    );
    assert.equal(editor.getMarkdown(), 'Important result.');

    editor.destroy();
    dom.window.close();
});

test('shows one note marker for a commented multiline PDF annotation', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'First line\nsecond line';
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
        resolveImageURL: () => null,
    });

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

    const markers = document.querySelectorAll(
        '.cm-mktero-pdf-annotation-note'
    );
    assert.equal(markers.length, 1);
    assert.equal(markers[0].getAttribute('data-annotation-id'), 'NOTE0001');
    assert.equal(markers[0].getAttribute('role'), 'button');
    assert.equal(markers[0].getAttribute('tabindex'), '0');
    assert.equal(markers[0].textContent, '');
    assert.equal(
        markers[0].namespaceURI,
        'http://www.w3.org/1999/xhtml'
    );
    assert.ok(markers[0].querySelector(
        '.cm-mktero-pdf-annotation-note-icon'
    ));
    assert.match(
        markers[0].getAttribute('style') || '',
        /--mktero-annotation-color:\s*#ffd400/
    );
    assert.match(
        document.querySelector('.cm-mktero-pdf-annotation')
            ?.getAttribute('aria-label') || '',
        /Add or edit note/
    );
    const firstHighlight = document.querySelector(
        '.cm-mktero-pdf-annotation'
    );
    assert.ok(markers[0].compareDocumentPosition(firstHighlight)
        & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);

    markers[0].dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    assert.doesNotMatch(
        document.querySelector('.mktero-annotation-popup')?.textContent || '',
        /Remember this finding/
    );
    const click = new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
    });
    markers[0].dispatchEvent(click);
    assert.equal(click.defaultPrevented, true);
    assert.match(
        document.querySelector('.mktero-annotation-popup')?.textContent || '',
        /Remember this finding/
    );

    editor.setDocument({
        markdown,
        annotationOverlay: {
            matched: [{
                id: 'NOTE0001',
                type: 'highlight',
                text: markdown,
                comment: '',
                color: '#ffd400',
                pageLabel: '4',
                ranges: [{ from: 0, to: markdown.length }],
            }],
            unmatched: [],
        },
    });
    assert.equal(
        document.querySelector('.cm-mktero-pdf-annotation-note'),
        null
    );
    assert.equal(document.querySelector('.mktero-annotation-popup'), null);

    editor.destroy();
    dom.window.close();
});

test('does not show a note marker for a whitespace-only comment', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
        resolveImageURL: () => null,
    });

    editor.setDocument({
        markdown: 'Important result.',
        annotationOverlay: {
            matched: [{
                id: 'NOTE0002',
                type: 'highlight',
                text: 'Important',
                comment: ' \n\t ',
                color: '#ffd400',
                pageLabel: '4',
                ranges: [{ from: 0, to: 9 }],
            }],
            unmatched: [],
        },
    });

    assert.equal(
        document.querySelector('.cm-mktero-pdf-annotation-note'),
        null
    );

    editor.destroy();
    dom.window.close();
});

test('renders a PDF trademark annotation over MinerU superscript markup', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'BOSE $^{®}$ headphones';
    const annotation = {
        id: 'MARK0005',
        type: 'highlight',
        text: '®',
        comment: 'Trademark note',
        color: '#ffd400',
        pageLabel: '4',
        pageIndex: 3,
        sortIndex: '00010',
    };
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
    });
    const annotationOverlay = await overlay.resolve(42, markdown);
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
        resolveImageURL: () => null,
    });

    editor.setDocument({ markdown, annotationOverlay });

    const rendered = document.querySelector('.cm-mktero-pdf-annotation');
    assert.ok(rendered);
    assert.match(rendered.textContent, /®/);
    assert.match(
        rendered.getAttribute('style'),
        /--mktero-annotation-color:\s*#ffd400/
    );
    const noteMarker = document.querySelectorAll(
        '.cm-mktero-pdf-annotation-note'
    );
    assert.equal(noteMarker.length, 1);
    noteMarker[0].dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));
    assert.match(
        document.querySelector('.mktero-annotation-popup')?.textContent || '',
        /Trademark note/
    );

    editor.destroy();
    dom.window.close();
});

test('shows one note marker when an annotation covers formula content', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'Result $x+y$ observed.';
    const from = markdown.indexOf('x+y');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
        resolveImageURL: () => null,
    });

    editor.setDocument({
        markdown,
        annotationOverlay: {
            matched: [{
                id: 'MATH0001',
                type: 'highlight',
                text: 'x+y',
                comment: 'Formula note',
                color: '#ff6666',
                pageLabel: '7',
                ranges: [{ from, to: from + 3 }],
            }],
            unmatched: [],
        },
    });

    const rendered = document.querySelector(
        '.cm-mktero-math .cm-mktero-pdf-annotation'
    );
    assert.ok(rendered);
    assert.match(rendered.textContent, /x\s*\+\s*y/);
    const noteMarkers = document.querySelectorAll(
        '.cm-mktero-pdf-annotation-note'
    );
    assert.equal(noteMarkers.length, 1);
    assert.ok(rendered.contains(noteMarkers[0]));
    assert.equal(rendered.firstElementChild, noteMarkers[0]);

    noteMarkers[0].dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));
    assert.match(
        document.querySelector('.mktero-annotation-popup')?.textContent || '',
        /Formula note/
    );
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('edits PDF annotation notes safely after clicking the note marker', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    let updatedNote;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
        resolveImageURL: () => null,
        updateAnnotationComment(annotationID, comment) {
            updatedNote = { annotationID, comment };
        },
    });
    editor.setDocument({
        markdown: 'Important result.',
        annotationOverlay: {
            matched: [{
                id: 'HIGH0001',
                type: 'highlight',
                text: 'Important',
                comment: '<img src=x onerror=alert(1)> Review this',
                color: '#ffd400',
                pageLabel: '4',
                ranges: [{ from: 0, to: 9 }],
            }],
            unmatched: [],
        },
    });
    const annotation = document.querySelector('.cm-mktero-pdf-annotation');
    const noteMarker = document.querySelector(
        '.cm-mktero-pdf-annotation-note'
    );

    annotation.dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    assert.doesNotMatch(
        document.querySelector('.mktero-annotation-popup')?.textContent || '',
        /Review this/
    );

    noteMarker.dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    assert.doesNotMatch(
        document.querySelector('.mktero-annotation-popup')?.textContent || '',
        /Review this/
    );
    assert.equal(noteMarker.getAttribute('role'), 'button');
    assert.equal(noteMarker.getAttribute('tabindex'), '0');
    assert.equal(noteMarker.getAttribute('aria-label'), 'Edit note');

    noteMarker.dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));

    const popup = document.querySelector('.mktero-annotation-popup');
    assert.equal(annotation.getAttribute('role'), 'button');
    assert.equal(annotation.getAttribute('tabindex'), '0');
    assert.equal(popup.getAttribute('role'), 'dialog');
    assert.match(popup.textContent, /Page 4/);
    assert.match(popup.textContent, /<img src=x onerror=alert\(1\)> Review this/);
    assert.equal(popup.querySelector('img'), null);
    const input = popup.querySelector('.mktero-annotation-note-input');
    assert.equal(
        input.value,
        '<img src=x onerror=alert(1)> Review this'
    );
    input.value = 'Revised safely';
    popup.querySelector('.mktero-annotation-note-save').click();
    await Promise.resolve();
    assert.deepEqual(updatedNote, {
        annotationID: 'HIGH0001',
        comment: 'Revised safely',
    });
    assert.equal(document.querySelector('.mktero-annotation-popup'), null);

    editor.destroy();
    assert.equal(document.querySelector('.mktero-annotation-popup'), null);
    dom.window.close();
});

test('adds a note after clicking a PDF annotation without a comment', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    let updatedNote;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
        resolveImageURL: () => null,
        updateAnnotationComment(annotationID, comment) {
            updatedNote = { annotationID, comment };
        },
    });
    editor.setDocument({
        markdown: 'Important result.',
        annotationOverlay: {
            matched: [{
                id: 'HIGH0001',
                type: 'highlight',
                text: 'Important',
                comment: '',
                color: '#ffd400',
                pageLabel: '4',
                ranges: [{ from: 0, to: 9 }],
            }],
            unmatched: [],
        },
    });
    const annotation = document.querySelector('.cm-mktero-pdf-annotation');

    annotation.dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    assert.ok(document.querySelector('.mktero-annotation-actions'));

    annotation.dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));
    const popup = document.querySelector('.mktero-annotation-popup');
    assert.equal(popup.querySelector('.mktero-annotation-actions'), null);
    const input = popup.querySelector('.mktero-annotation-note-input');
    assert.equal(input.value, '');
    assert.equal(document.activeElement, input);

    input.value = 'New note';
    popup.querySelector('.mktero-annotation-note-save').click();
    await Promise.resolve();

    assert.deepEqual(updatedNote, {
        annotationID: 'HIGH0001',
        comment: 'New note',
    });
    assert.equal(document.querySelector('.mktero-annotation-popup'), null);

    editor.destroy();
    dom.window.close();
});

test('shows color and delete actions when hovering a PDF annotation', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    let resolveColorChange;
    let resolveDelete;
    const colorChanged = new Promise(resolve => {
        resolveColorChange = resolve;
    });
    const deleted = new Promise(resolve => {
        resolveDelete = resolve;
    });
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
        resolveImageURL: () => null,
        changeAnnotationColor(annotationID, color) {
            resolveColorChange({ annotationID, color });
        },
        deleteAnnotation(annotationID) {
            resolveDelete(annotationID);
        },
    });
    editor.setDocument({
        markdown: 'Important result.',
        annotationOverlay: {
            matched: [{
                id: 'HIGH0001',
                type: 'highlight',
                text: 'Important',
                comment: 'Private note',
                color: '#ffd400',
                pageLabel: '4',
                ranges: [{ from: 0, to: 9 }],
            }],
            unmatched: [],
        },
    });
    const annotation = document.querySelector('.cm-mktero-pdf-annotation');

    annotation.dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));

    const popup = document.querySelector('.mktero-annotation-popup');
    const colorButtons = popup.querySelectorAll(
        '.mktero-annotation-color-button'
    );
    assert.equal(colorButtons.length, 8);
    assert.equal(
        popup.querySelector('[data-color="#ffd400"]')
            ?.getAttribute('aria-pressed'),
        'true'
    );
    assert.doesNotMatch(popup.textContent, /Private note/);

    popup.querySelector('[data-color="#ff6666"]').click();
    assert.deepEqual(await colorChanged, {
        annotationID: 'HIGH0001',
        color: '#ff6666',
    });
    assert.equal(document.querySelector('.mktero-annotation-popup'), null);

    annotation.dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    const reopenedPopup = document.querySelector('.mktero-annotation-popup');
    reopenedPopup.querySelector('.mktero-annotation-delete-button').click();
    assert.equal(await deleted, 'HIGH0001');
    assert.equal(document.querySelector('.mktero-annotation-popup'), null);

    editor.destroy();
    dom.window.close();
});

test('renders PDF annotations inside a rendered Markdown table', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '| Claim |',
        '| --- |',
        '| Important result |',
    ].join('\n');
    const from = 20;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
        resolveImageURL: () => null,
    });

    editor.setDocument({
        markdown,
        annotationOverlay: {
            matched: [{
                id: 'TABLE001',
                type: 'underline',
                text: 'Important',
                comment: 'Table note',
                color: '#2ea8e5',
                pageLabel: '5',
                ranges: [{ from, to: from + 9 }],
            }],
            unmatched: [],
        },
    });

    const annotation = document.querySelector(
        '.cm-mktero-table td .cm-mktero-pdf-annotation'
    );
    assert.equal(annotation.textContent, 'Important');
    assert.ok(annotation.classList.contains(
        'cm-mktero-pdf-annotation--underline'
    ));
    assert.equal(annotation.getAttribute('data-annotation-id'), 'TABLE001');
    const noteMarker = annotation.querySelector(
        '.cm-mktero-pdf-annotation-note'
    );
    assert.ok(noteMarker);
    assert.equal(annotation.firstElementChild, noteMarker);
    noteMarker.dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));
    assert.match(
        document.querySelector('.mktero-annotation-popup').textContent,
        /Table note/
    );

    editor.destroy();
    dom.window.close();
});

test('uses the resolved source range for repeated text in rendered widgets', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '| Claim | Claim |',
        '| --- | --- |',
        '| repeated | repeated |',
    ].join('\n');
    const from = markdown.lastIndexOf('repeated');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
        resolveImageURL: () => null,
    });

    editor.setDocument({
        markdown,
        annotationOverlay: {
            matched: [{
                id: 'TABLE003',
                type: 'highlight',
                text: 'repeated',
                comment: '',
                color: '#ffd400',
                pageLabel: '5',
                ranges: [{ from, to: from + 'repeated'.length }],
            }],
            unmatched: [],
        },
    });

    const cells = [...document.querySelectorAll('.cm-mktero-table td')];
    assert.equal(cells[0].querySelector('.cm-mktero-pdf-annotation'), null);
    const annotation = cells[1].querySelector(
        '.cm-mktero-pdf-annotation'
    );
    assert.equal(annotation?.textContent, 'repeated');

    const range = document.createRange();
    range.selectNodeContents(annotation);
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);
    const mouseDown = new dom.window.MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
    });
    annotation.dispatchEvent(mouseDown);

    const click = new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
    });
    annotation.dispatchEvent(click);

    assert.equal(mouseDown.defaultPrevented, false);
    assert.equal(click.defaultPrevented, false);
    assert.equal(document.getSelection().toString(), 'repeated');
    assert.equal(document.querySelector('.mktero-annotation-popup'), null);

    editor.destroy();
    dom.window.close();
});

test('renders PDF annotations inside an academic figure caption', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = '![Figure 1. Important result.](images/figure.png)';
    const from = markdown.indexOf('Important result');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
        resolveImageURL: () => 'blob:mktero-figure',
    });

    editor.setDocument({
        markdown,
        annotationOverlay: {
            matched: [{
                id: 'FIGURE01',
                type: 'highlight',
                text: 'Important result',
                comment: 'Figure note',
                color: '#a28ae5',
                pageLabel: '6',
                ranges: [{ from, to: from + 'Important result'.length }],
            }],
            unmatched: [],
        },
    });

    const annotation = document.querySelector(
        '.mktero-figure figcaption .cm-mktero-pdf-annotation'
    );
    assert.equal(annotation?.textContent, 'Important result');
    assert.match(
        annotation?.getAttribute('style') || '',
        /--mktero-annotation-color:\s*#a28ae5/
    );

    editor.destroy();
    dom.window.close();
});

test('normalizes PDF annotation whitespace inside rendered widgets', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '| Claim |',
        '| --- |',
        '| Important result |',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
        resolveImageURL: () => null,
    });

    editor.setDocument({
        markdown,
        annotationOverlay: {
            matched: [{
                id: 'TABLE002',
                type: 'highlight',
                text: 'Important\nresult',
                comment: '',
                color: '#ffd400',
                pageLabel: '5',
                matchKind: 'normalized',
                ranges: [{ from: 20, to: 36 }],
            }],
            unmatched: [],
        },
    });

    assert.equal(
        document.querySelector(
            '.cm-mktero-table td .cm-mktero-pdf-annotation'
        ).textContent,
        'Important result'
    );

    editor.destroy();
    dom.window.close();
});

test('renders inactive Markdown formatting and formulas without rewriting source', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = '# Paper\n\n**Bold** and $E = mc^2$.';
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
        openLink: () => {},
    });

    assert.equal(editor.getMarkdown(), markdown);
    assert.equal(document.querySelector('.cm-mktero-strong').textContent, 'Bold');
    assert.ok(document.querySelector('.cm-mktero-math math'));
    assert.doesNotMatch(document.querySelector('.cm-content').textContent, /\*\*Bold\*\*/);

    editor.destroy();
    dom.window.close();
});

test('keeps Markdown escape slashes hidden in the read-only view', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = '\\- fast, convenient online submission';
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
    });
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    const content = document.querySelector('.cm-content');

    assert.equal(content.textContent, '- fast, convenient online submission');
    assert.equal(editor.getMarkdown(), markdown);

    view.posAtCoords = () => 0;
    content.dispatchEvent(new dom.window.MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));

    assert.equal(content.getAttribute('contenteditable'), 'false');
    assert.equal(content.textContent, '- fast, convenient online submission');
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('keeps inline formulas in the prose flow without block paragraph wrappers', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'Anxiety symptoms have a Cronbach $\\alpha$ of .92, while '
        + 'depression symptoms have a Cronbach $\\alpha$ of .89 and the modified '
        + 'measure has a Cronbach $\\alpha$ of .84.';
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
    });
    const inlineMath = [...document.querySelectorAll('.cm-mktero-math')];

    assert.equal(inlineMath.length, 3);
    assert.ok(inlineMath.every(widget => widget.localName === 'span'));
    assert.ok(inlineMath.every(widget => widget.querySelector('p') === null));

    editor.destroy();
    dom.window.close();
});

test('keeps rendered Markdown read-only on double-click', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'Intro\n\n**Bold** text';
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
    });
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    const content = document.querySelector('.cm-content');
    const boldPosition = markdown.indexOf('Bold');
    assert.equal(content.getAttribute('contenteditable'), 'false');
    content.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
    }));
    assert.equal(editor.getMarkdown(), markdown);
    view.dispatch({ selection: { anchor: boldPosition } });
    view.posAtCoords = () => boldPosition;
    const bold = document.querySelector('.cm-mktero-strong');

    bold.dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));
    bold.dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));
    assert.doesNotMatch(document.querySelector('.cm-content').textContent, /\*\*Bold\*\*/);

    bold.dispatchEvent(new dom.window.MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));
    assert.ok(document.querySelector('.cm-mktero-strong'));
    assert.doesNotMatch(document.querySelector('.cm-content').textContent, /\*\*Bold\*\*/);
    assert.equal(content.getAttribute('contenteditable'), 'false');
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('renders externally replaced Markdown in read-only mode', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'Intro\n\n**Bold**';
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
    });
    editor.setMarkdown('# New document');

    assert.equal(document.querySelector('.cm-content').getAttribute('contenteditable'), 'false');
    assert.equal(document.querySelector('.cm-content').textContent.trim(), 'New document');
    assert.equal(editor.getMarkdown(), '# New document');

    editor.destroy();
    dom.window.close();
});

test('does not apply source-code underlines to rendered headings', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: 'Intro\n\n# Rendered heading',
        resolveImageURL: () => null,
    });
    const heading = document.querySelector('.cm-mktero-heading-1');
    const renderedText = heading.textContent;
    const hasSourceHighlight = Boolean(heading.querySelector('span[class]'));

    editor.destroy();
    dom.window.close();

    assert.equal(renderedText, 'Rendered heading');
    assert.equal(hasSourceHighlight, false);
});

test('renders formulas in headings and link labels', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        'Intro',
        '',
        '## Result $E = mc^2$',
        '',
        '[Equation $x^2$](https://example.com)',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
        openLink: () => {},
    });

    assert.equal(document.querySelectorAll('.cm-mktero-math math').length, 2);
    assert.ok(document.querySelector('.cm-mktero-link.cm-mktero-math'));
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('renders paper tables, cached images, page markers, and safe links inline', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const opened = [];
    const markdown = [
        'Intro',
        '',
        '| Source | Value |',
        '| --- | --- |',
        '| [MinerU](https://mineru.net) | 42 |',
        '',
        '![Figure](images/figure.png)',
        '',
        '<table><tr><td>Raw table</td></tr></table>',
        '',
        '<!-- zotero-page: 2 -->',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: source => source === 'images/figure.png'
            ? 'blob:mktero-figure'
            : null,
        openLink: url => opened.push(url),
    });

    assert.equal(document.querySelector('.cm-mktero-table table th').textContent, 'Source');
    assert.equal(
        document.querySelector('.cm-mktero-image img').getAttribute('src'),
        'blob:mktero-figure'
    );
    assert.equal(
        document.querySelector('.cm-mktero-html-table table td').textContent,
        'Raw table'
    );
    assert.match(document.querySelector('.page-marker').textContent, /Page 2/);

    document.querySelector('.cm-mktero-table a').dispatchEvent(
        new dom.window.MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            button: 0,
        })
    );
    assert.deepEqual(opened, ['https://mineru.net']);
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('keeps rendered GFM table cells read-only', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        'Before',
        '',
        '| Name | Value |',
        '| --- | ---: |',
        '| Score | 42 |',
        '',
        'After',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
        openLink: () => {},
    });
    const valueCell = document.querySelector('.cm-mktero-table tbody td:last-child');

    assert.equal(valueCell.getAttribute('contenteditable'), 'false');
    enterTableCellEditing(valueCell, dom.window);
    assert.equal(valueCell.getAttribute('contenteditable'), 'false');
    valueCell.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'F2',
        bubbles: true,
        cancelable: true,
    }));
    assert.equal(valueCell.getAttribute('contenteditable'), 'false');
    assert.equal(valueCell.textContent, '42');
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('renders an academic caption above a read-only GFM table', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        'Table 3 Means and standard deviations',
        '',
        '| Measure | m | SD |',
        '| --- | ---: | ---: |',
        '| Valence | 414.55 | 87.37 |',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
        openLink: () => {},
    });
    const caption = document.querySelector('.cm-mktero-table caption');

    assert.equal(caption?.textContent, 'Table 3 Means and standard deviations');
    assert.equal(
        caption?.querySelector('.mktero-table-label')?.textContent,
        'Table 3'
    );

    const valueCell = document.querySelector(
        '.cm-mktero-table tbody td:last-child'
    );
    enterTableCellEditing(valueCell, dom.window);
    assert.equal(valueCell.getAttribute('contenteditable'), 'false');
    assert.equal(valueCell.textContent, '87.37');
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('renders an academic caption above a one-column GFM table', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        'Table 1 Scores',
        '',
        '| Value |',
        '| --- |',
        '| 42 |',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
        openLink: () => {},
    });

    assert.equal(
        document.querySelector('.cm-mktero-table caption')?.textContent,
        'Table 1 Scores'
    );
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('renders a MinerU HTML table and its preceding caption as one table', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        'Table 3 Means and standard deviations of desired emotions',
        '',
        '<table><tr><td>Measure</td><td>m</td><td>SD</td></tr></table>',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
        openLink: () => {},
    });
    const table = document.querySelector('.cm-mktero-html-table table');

    assert.equal(
        table?.querySelector('caption')?.textContent,
        'Table 3 Means and standard deviations of desired emotions'
    );
    assert.equal(
        table?.querySelector('.mktero-table-label')?.textContent,
        'Table 3'
    );
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('recognizes a referenced MinerU table with a split heading and description', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        'The inclusion criteria are described in Table 2.',
        '',
        '## Table 2',
        '',
        'PICO criteria for inclusion and exclusion in systematic review.',
        '',
        '<table><tr><td>Parameters</td><td>Inclusion Criteria</td>',
        '<td>Exclusion Criteria</td></tr></table>',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });
    const reference = document.querySelector('.cm-mktero-table-reference');
    const table = document.querySelector('.cm-mktero-html-table table');

    assert.equal(reference?.textContent, 'Table 2');
    assert.equal(
        table?.querySelector('caption')?.textContent,
        'Table 2 PICO criteria for inclusion and exclusion in systematic review.'
    );
    assert.deepEqual(
        [...table.querySelectorAll('td')].map(cell => cell.textContent),
        ['Parameters', 'Inclusion Criteria', 'Exclusion Criteria']
    );

    reference.dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    assert.equal(
        document.querySelector('.mktero-table-preview-caption')?.textContent,
        'Table 2 PICO criteria for inclusion and exclusion in systematic review.'
    );
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('recognizes a referenced MinerU table with a plain-text Roman label', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        'The downstream tasks are summarized in Table I.',
        '',
        'TABLE I  ',
        'OVERVIEW OF DOWNSTREAM BCI TASKS AND DATASETS.',
        '',
        '<table><tr><td>BCI Tasks</td><td>Datasets</td></tr></table>',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });
    const reference = document.querySelector('.cm-mktero-table-reference');
    const table = document.querySelector('.cm-mktero-html-table table');

    assert.equal(reference?.textContent, 'Table I');
    assert.equal(
        table?.querySelector('caption')?.textContent,
        'TABLE I OVERVIEW OF DOWNSTREAM BCI TASKS AND DATASETS.'
    );
    assert.equal(
        table?.querySelector('.mktero-table-label')?.textContent,
        'TABLE I'
    );
    assert.deepEqual(
        [...table.querySelectorAll('td')].map(cell => cell.textContent),
        ['BCI Tasks', 'Datasets']
    );

    reference.dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    assert.equal(
        document.querySelector('.mktero-table-preview-caption')?.textContent,
        'TABLE I OVERVIEW OF DOWNSTREAM BCI TASKS AND DATASETS.'
    );
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('renders a blank-line-separated table label with caption typography', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        'TABLE V',
        '',
        'COMPARISON OF DIFFERENT ADAPTATION PARADIGMS.',
        '',
        '<table><tr><td>Paradigm</td><td>Performance</td></tr></table>',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });
    const tableBlock = document.querySelector('.cm-mktero-html-block');
    const caption = tableBlock?.querySelector('caption');

    assert.equal(
        caption?.textContent,
        'TABLE V COMPARISON OF DIFFERENT ADAPTATION PARADIGMS.'
    );
    assert.equal(tableBlock?.querySelector('p'), null);
    assert.equal(
        caption?.matches(
            '.cm-mktero-html-block table caption'
        ),
        true
    );
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('previews a uniquely captioned table from its prose reference', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '# Results',
        '',
        'Model performance is reported in Table 5.',
        '',
        'Table 5. Open-source model performance',
        '',
        '| Model | Accuracy |',
        '| --- | ---: |',
        '| LLaMA | 0.72 |',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
    });
    const reference = document.querySelector('.cm-mktero-table-reference');

    assert.equal(reference?.textContent, 'Table 5');
    assert.equal(reference?.getAttribute('role'), 'link');
    assert.equal(reference?.getAttribute('tabindex'), '0');

    reference.dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));

    const popup = document.querySelector('.mktero-table-preview-popup');
    assert.equal(popup?.getAttribute('aria-label'), 'Table preview');
    assert.equal(
        popup?.querySelector('.mktero-table-preview-caption')?.textContent,
        'Table 5. Open-source model performance'
    );
    assert.deepEqual(
        [...popup.querySelectorAll('th, td')].map(cell => cell.textContent),
        ['Model', 'Accuracy', 'LLaMA', '0.72']
    );
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('jumps to and highlights a clicked table reference for three seconds', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '# Results',
        '',
        'Model performance is reported in Table 5.',
        '',
        'Table 5. Open-source model performance',
        '',
        '| Model | Accuracy |',
        '| --- | ---: |',
        '| LLaMA | 0.72 |',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    const tableOffset = markdown.indexOf('Table 5. Open-source');
    const scheduled = [];
    const originalSetTimeout = dom.window.setTimeout;
    const originalClearTimeout = dom.window.clearTimeout;
    dom.window.setTimeout = (callback, delay) => {
        scheduled.push({ callback, delay });
        return scheduled.length;
    };
    dom.window.clearTimeout = () => {};
    view.lineBlockAt = position => {
        assert.equal(position, tableOffset);
        return { top: 720 };
    };
    view.requestMeasure = request => {
        if (!request?.read) return;
        request.write?.(request.read(view), view);
    };
    view.scrollDOM.scrollTop = 0;
    const reference = document.querySelector('.cm-mktero-table-reference');
    reference.dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));

    reference.dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));

    assert.equal(view.scrollDOM.scrollTop, 720);
    assert.equal(document.querySelector('.mktero-table-preview-popup'), null);
    assert.match(
        document.querySelector('.cm-mktero-table-target-highlight')?.textContent
            || '',
        /Open-source model performance[\s\S]*LLaMA[\s\S]*0\.72/
    );
    assert.equal(scheduled.at(-1)?.delay, 3000);

    scheduled.at(-1).callback();
    assert.equal(
        document.querySelector('.cm-mktero-table-target-highlight'),
        null
    );
    assert.equal(editor.getMarkdown(), markdown);

    dom.window.setTimeout = originalSetTimeout;
    dom.window.clearTimeout = originalClearTimeout;
    editor.destroy();
    dom.window.close();
});

test('activates a table reference from the keyboard', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        'See Table S2 for the supplemental result.',
        '',
        'Table S2. Supplemental result',
        '',
        '| Measure | Value |',
        '| --- | ---: |',
        '| Recall | 0.91 |',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    const tableOffset = markdown.indexOf('Table S2. Supplemental');
    let navigatedOffset = null;
    view.lineBlockAt = position => {
        navigatedOffset = position;
        return { top: 440 };
    };
    view.requestMeasure = request => {
        if (request?.read) request.write?.(request.read(view), view);
    };
    const reference = document.querySelector('.cm-mktero-table-reference');

    reference.focus();
    reference.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Enter',
    }));

    assert.equal(navigatedOffset, tableOffset);
    assert.ok(document.querySelector('.cm-mktero-table-target-highlight'));
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('previews and highlights a referenced raw HTML table', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        'The comparison appears in Table IV.',
        '',
        'Table IV. Cohort comparison',
        '',
        '<table><tr><th>Cohort</th><th>Score</th></tr>',
        '<tr><td>Control</td><td>82</td></tr></table>',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });
    const reference = document.querySelector('.cm-mktero-table-reference');

    reference.dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    assert.deepEqual(
        [...document.querySelectorAll(
            '.mktero-table-preview-popup th, .mktero-table-preview-popup td'
        )].map(cell => cell.textContent),
        ['Cohort', 'Score', 'Control', '82']
    );

    reference.dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));
    assert.ok(document.querySelector(
        '.cm-mktero-html-table.cm-mktero-table-target-highlight'
    ));
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('hides paired MinerU algorithm wrapper tags while preserving its content', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '<div class="mineru-algorithm" style="white-space: pre-wrap; font-family:monospace;">',
        'Algorithm 1: Continual learning',
        '',
        'Input: task $T_{i}$',
        '',
        'Training Stage:',
        '    Optimize $C_{i}$;',
        '</div>',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });
    const algorithm = document.querySelector(
        '.cm-mktero-algorithm .mktero-algorithm'
    );

    assert.match(algorithm?.textContent || '', /Algorithm 1: Continual learning/);
    assert.match(algorithm?.textContent || '', /Optimize/);
    assert.equal(algorithm?.querySelectorAll('.math-inline').length, 2);
    assert.doesNotMatch(
        document.querySelector('.cm-content')?.textContent || '',
        /<\/?div/
    );
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('renders quotes, lists, read-only tasks, and dividers', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        'Intro',
        '',
        '> Quoted finding',
        '',
        '- [ ] Verify result',
        '- Supporting item',
        '',
        '---',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
        openLink: () => {},
    });

    assert.equal(document.querySelector('.cm-mktero-blockquote').textContent, 'Quoted finding');
    assert.equal(document.querySelector('.cm-mktero-list-bullet').textContent, '•');
    const checkbox = document.querySelector('.cm-mktero-task input');
    assert.equal(checkbox.checked, false);
    assert.equal(checkbox.disabled, true);
    assert.ok(document.querySelector('.cm-mktero-divider hr'));

    checkbox.click();
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('opens an inline Markdown link through the host on modifier-click', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const opened = [];
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: 'Intro\n\n[Open paper](https://example.com/paper)',
        resolveImageURL: () => null,
        openLink: url => opened.push(url),
    });

    document.querySelector('.cm-mktero-link').dispatchEvent(
        new dom.window.MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
            button: 0,
        })
    );
    assert.deepEqual(opened, ['https://example.com/paper']);

    editor.destroy();
    dom.window.close();
});

test('does not open an unsafe inline Markdown link', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const opened = [];
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: 'Intro\n\n[Unsafe](javascript:alert(1))',
        resolveImageURL: () => null,
        openLink: url => opened.push(url),
    });

    document.querySelector('.cm-mktero-link').dispatchEvent(
        new dom.window.MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
            button: 0,
        })
    );
    assert.deepEqual(opened, []);

    editor.destroy();
    dom.window.close();
});

test('opens all reference, autolink, and bare URL Markdown links', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const opened = [];
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: [
            'Intro',
            '',
            '[Reference][paper]',
            '',
            '[Collapsed][]',
            '',
            '[Shortcut]',
            '',
            '<https://example.com/autolink>',
            '',
            'https://example.com/bare',
            '',
            '[paper]: https://example.com/reference',
            '[collapsed]: https://example.com/collapsed',
            '[shortcut]: https://example.com/shortcut',
        ].join('\n'),
        resolveImageURL: () => null,
        openLink: url => opened.push(url),
    });

    for (const link of document.querySelectorAll('.cm-mktero-link')) {
        link.dispatchEvent(new dom.window.MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
            button: 0,
        }));
    }
    assert.deepEqual(opened, [
        'https://example.com/reference',
        'https://example.com/collapsed',
        'https://example.com/shortcut',
        'https://example.com/autolink',
        'https://example.com/bare',
    ]);
    assert.doesNotMatch(document.querySelector('.cm-content').textContent, /\[paper\]:/);

    editor.destroy();
    dom.window.close();
});

test('keeps statistical confidence intervals as plain text instead of links', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = '95%CI[-0.56,-0.05] and [source](https://example.com).';
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });

    assert.deepEqual(
        [...document.querySelectorAll('.cm-mktero-link')]
            .map(link => link.textContent),
        ['source']
    );
    assert.match(
        document.querySelector('.cm-content').textContent,
        /\[-0\.56,-0\.05\]/
    );

    editor.destroy();
    dom.window.close();
});

test('shows resolved reference text when a rendered citation is hovered', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '# Paper',
        '',
        'Numeric evidence [1] and prior work (Münte et al., 2002).',
        '',
        '## References',
        '',
        '[1] Alpha A. Numeric evidence. Journal. 2024.',
        '[2] Münte, T. F., Altenmüller, E., & Jäncke, L. (2002). The musician’s brain.',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });
    const citations = [...document.querySelectorAll('.cm-mktero-citation')];

    assert.deepEqual(citations.map(citation => citation.textContent), [
        '1',
        '(Münte et al., 2002)',
    ]);
    assert.ok(citations.every(citation => citation.getAttribute('role') === 'link'));
    assert.ok(citations.every(citation => citation.getAttribute('tabindex') === '0'));

    citations[0].dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));

    const popup = document.querySelector('.mktero-citation-popup');
    assert.equal(popup?.getAttribute('role'), 'dialog');
    assert.equal(popup?.getAttribute('aria-label'), 'Citation details');
    assert.match(popup?.textContent || '', /Alpha A\. Numeric evidence\. Journal\. 2024\./);
    assert.equal(
        citations[0].getAttribute('aria-describedby'),
        popup?.getAttribute('id')
    );
    assert.equal(editor.getMarkdown(), markdown);

    popup.querySelector('.mktero-citation-popup-content').dispatchEvent(
        new dom.window.WheelEvent('wheel', { bubbles: true })
    );
    assert.ok(document.querySelector('.mktero-citation-popup'));

    editor.setMarkdown('# Replaced document');
    assert.equal(document.querySelector('.mktero-citation-popup'), null);

    editor.destroy();
    assert.equal(document.querySelector('.mktero-citation-popup'), null);
    dom.window.close();
});

test('renders bracketed numeric citations with full-width separators', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '# 论文',
        '',
        '组合证据 [1，2]。',
        '',
        '## 参考文献',
        '',
        '[1] 张三。第一项研究。2023。',
        '[2] 李四。第二项研究。2024。',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });

    assert.deepEqual(
        [...document.querySelectorAll('.cm-mktero-citation')]
            .map(citation => citation.textContent),
        ['1', '2']
    );

    editor.destroy();
    dom.window.close();
});

test('renders dollar-wrapped numeric citations emitted by the PDF converter', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '# Paper',
        '',
        'Toolformer taught models to call external APIs $[34]$,',
        'alongside related systems $[30, 33]$.',
        '',
        '## References',
        '',
        '[30] Shishir Patil et al. Gorilla. 2023.',
        '[33] Yujia Qin et al. ToolLLM. 2023.',
        '[34] Timo Schick et al. Toolformer. 2023.',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });

    const citations = [...document.querySelectorAll('.cm-mktero-citation')];
    assert.deepEqual(citations.map(node => node.textContent), ['34', '30', '33']);
    const [citation] = citations;
    assert.equal(citation?.textContent, '34');
    assert.match(
        document.querySelector('.cm-content')?.textContent || '',
        /external APIs \[34\],alongside related systems \[30, 33\]\./
    );
    citation.dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    assert.match(
        document.querySelector('.mktero-citation-popup')?.textContent || '',
        /Timo Schick et al\. Toolformer\. 2023\./
    );

    editor.destroy();
    dom.window.close();
});

test('renders citations recovered after a misplaced references heading', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '# Paper',
        '',
        '## I. INTRODUCTION',
        '',
        'Prior work $[1]$ and related systems $[2–3]$.',
        '',
        '## REFERENCES',
        '',
        'modulation continues here from the discussion paragraph.',
        '',
        '## B. Limitations',
        '',
        'Limitations text.',
        '',
        '## VII. CONCLUSION',
        '',
        'Conclusion text.',
        '',
        '[1] Alpha A. First paper. 2024.',
        '',
        '[2] Beta B. Second paper. 2024.',
        '',
        '[3] Gamma G. Third paper. 2025.',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });

    const citations = [...document.querySelectorAll('.cm-mktero-citation')];
    assert.deepEqual(
        citations.map(citation => citation.textContent),
        ['1', '2–3']
    );
    assert.equal(document.querySelector('.cm-mktero-math'), null);
    assert.match(
        document.querySelector('.cm-content')?.textContent || '',
        /Prior work \[1\] and related systems \[2–3\]\./
    );

    citations[1].dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    assert.equal(
        document.querySelectorAll('.mktero-citation-popup-item').length,
        2
    );
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('does not make superscript footnotes interactive in bracket-style papers', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '# Paper',
        '',
        'A practitioner note appears here $^{1}$ and another here $^{2}$.',
        '',
        'The system has (1) discovery, (2) verification, and (3) memory.',
        '',
        'ReAct $[50]$ formalized the agent cycle, supported by $[20]$.',
        '',
        '## References',
        '',
        '[1] Alpha A. First academic paper. 2020.',
        '[2] Beta B. Second academic paper. 2021.',
        '[20] Twenty T. Twentieth academic paper. 2024.',
        '[50] Yao, S. ReAct: Synergizing reasoning and acting. 2022.',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });

    const citations = [...document.querySelectorAll('.cm-mktero-citation')];
    assert.deepEqual(citations.map(citation => citation.textContent), [
        '50',
        '20',
    ]);
    assert.equal(
        document.querySelector('[data-citation-ids="number:1"]'),
        null
    );
    assert.equal(
        document.querySelector('[data-citation-ids="number:2"]'),
        null
    );
    assert.equal(
        document.querySelector('[data-citation-ids="number:3"]'),
        null
    );

    citations[0].dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    assert.match(
        document.querySelector('.mktero-citation-popup')?.textContent || '',
        /ReAct: Synergizing reasoning and acting/
    );
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('renders HTML superscript citations as interactive reference links', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '# Paper',
        '',
        'Relaxation methods reduce anxiety<sup>2–4</sup>.',
        '',
        '## References',
        '',
        '[2] Beta B. Second paper. 2020.',
        '[3] Gamma G. Third paper. 2021.',
        '[4] Delta D. Fourth paper. 2022.',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });

    const citation = document.querySelector('.cm-mktero-citation');
    assert.equal(citation?.textContent, '2–4');
    assert.ok(citation?.classList.contains('cm-mktero-citation-superscript'));
    assert.doesNotMatch(
        document.querySelector('.cm-content')?.textContent || '',
        /<\/?sup>/
    );

    citation.dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    const popup = document.querySelector('.mktero-citation-popup');
    assert.equal(
        popup?.querySelectorAll('.mktero-citation-popup-item').length,
        3
    );
    assert.match(popup?.textContent || '', /Beta B\. Second paper\. 2020\./);
    assert.match(popup?.textContent || '', /Delta D\. Fourth paper\. 2022\./);
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('keeps LaTeX superscript citations interactive instead of rendering math', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '# Paper',
        '',
        'Relaxation methods reduce anxiety $^{2-4}$.',
        '',
        '## References',
        '',
        '[2] Beta B. Second paper. 2020.',
        '[3] Gamma G. Third paper. 2021.',
        '[4] Delta D. Fourth paper. 2022.',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });

    const citation = document.querySelector('.cm-mktero-citation');
    assert.equal(citation?.textContent, '2-4');
    assert.ok(citation?.classList.contains('cm-mktero-citation-superscript'));
    assert.equal(document.querySelector('.cm-mktero-math'), null);
    assert.doesNotMatch(
        document.querySelector('.cm-content')?.textContent || '',
        /\$|\^|\{|\}/
    );

    citation.dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    assert.equal(
        document.querySelectorAll('.mktero-citation-popup-item').length,
        3
    );
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('renders dominant superscript citations beside parenthetical sample sizes', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '# Paper',
        '',
        '## Introduction',
        '',
        'Imaging supports diagnosis $^{1-2}$ and monitoring $^{3-4}$.',
        'Anxiety outcomes were also reported $^{5-6}$.',
        'Fentanyl dose was CG (29) versus EG (18).',
        '',
        '## References',
        '',
        '1. First reference.',
        '2. Second reference.',
        '3. Third reference.',
        '4. Fourth reference.',
        '5. Fifth reference.',
        '6. Sixth reference.',
        '18. Eighteenth reference.',
        '29. Twenty-ninth reference.',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });
    const citations = [...document.querySelectorAll('.cm-mktero-citation')];

    assert.deepEqual(
        citations.map(citation => citation.textContent),
        ['1-2', '3-4', '5-6']
    );
    assert.ok(citations.every(citation => (
        citation.classList.contains('cm-mktero-citation-superscript')
    )));
    assert.equal(document.querySelector('.cm-mktero-math'), null);

    editor.destroy();
    dom.window.close();
});

test('distinguishes continued figure steps from a subfigure reference', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '# Paper',
        '',
        'Pipeline continued, (3) validate input, (4) repair errors, '
            + 'and (5) generate output.',
        '',
        'The first layer is shown in (Fig. 1a).',
        '',
        '![Fig. 1. Pipeline architecture](images/pipeline.png)',
        '',
        '## References',
        '',
        '[3] Alpha A. Validation paper. 2020.',
        '[4] Beta B. Repair paper. 2021.',
        '[5] Gamma G. Output paper. 2022.',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: path => `blob:mktero-${path}`,
    });
    const continuationLine = [...document.querySelectorAll('.cm-line')]
        .find(line => line.textContent.includes('Pipeline continued'));
    const referenceLine = [...document.querySelectorAll('.cm-line')]
        .find(line => line.textContent.includes('first layer'));

    assert.equal(continuationLine.querySelector('.cm-mktero-citation'), null);
    assert.equal(
        referenceLine.querySelector('.cm-mktero-figure-reference')?.textContent,
        'Fig. 1a'
    );
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('keeps Unicode superscript citation glyphs at their native position', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '# Paper',
        '',
        'Relaxation methods reduce anxiety²⁻⁴.',
        '',
        '## References',
        '',
        '[2] Beta B. Second paper. 2020.',
        '[3] Gamma G. Third paper. 2021.',
        '[4] Delta D. Fourth paper. 2022.',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });

    const citation = document.querySelector('.cm-mktero-citation');
    assert.equal(citation?.textContent, '²⁻⁴');
    assert.ok(!citation?.classList.contains('cm-mktero-citation-superscript'));

    citation.dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    assert.equal(
        document.querySelectorAll('.mktero-citation-popup-item').length,
        3
    );
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('shows author affiliations instead of references for front-matter superscripts', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '# Acceptability of Artificial Intelligence Therapy',
        '',
        'Ashish Mehta $^{1}$, BA; Andrea Niles $^{2}$, PhD',
        '',
        '$^{1}$ Department of Psychology, Stanford University. '
            + '$^{2}$ Youper, Inc.',
        '',
        '## Abstract',
        '',
        'Prior work supports this result $^{1}$.',
        '',
        '## References',
        '',
        '[1] Smith, A. (2020). Actual cited paper.',
        '[2] Beta B. Another cited paper. 2021.',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    const affiliations = [...document.querySelectorAll('.cm-mktero-affiliation-marker')];
    const citations = [...document.querySelectorAll('.cm-mktero-citation')];

    assert.deepEqual(affiliations.map(marker => marker.textContent), ['1', '2']);
    assert.deepEqual(citations.map(citation => citation.textContent), ['1', '2', '1']);
    assert.equal(citations[0].getAttribute('aria-label'), 'View author affiliation 1');
    assert.doesNotMatch(
        document.querySelector('.cm-content')?.textContent || '',
        /<\/?sup>/
    );

    citations[0].dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    let popup = document.querySelector('.mktero-citation-popup');
    assert.equal(popup?.getAttribute('aria-label'), 'Author affiliations');
    assert.match(
        popup?.textContent || '',
        /Department of Psychology, Stanford University\./
    );
    assert.doesNotMatch(popup?.textContent || '', /Actual cited paper/);

    const affiliationOffset = markdown.indexOf('Department of Psychology');
    let navigatedOffset = null;
    view.lineBlockAt = position => {
        navigatedOffset = position;
        return { top: 480 };
    };
    view.requestMeasure = request => {
        if (request?.read) request.write?.(request.read(view), view);
    };
    citations[0].dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));
    assert.equal(navigatedOffset, affiliationOffset);
    assert.match(
        document.querySelector('.cm-mktero-reference-highlight')?.textContent || '',
        /Department of Psychology, Stanford University\./
    );

    citations.at(-1).dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    popup = document.querySelector('.mktero-citation-popup');
    assert.equal(popup?.getAttribute('aria-label'), 'Citation details');
    assert.match(popup?.textContent || '', /Actual cited paper/);
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('links an author affiliation before a corresponding-author symbol', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '# AI-based Cognitive-linguistic Features',
        '',
        'Lingfeng Xu $^{1,**}$',
        '',
        '$^{1}$ College of Health Solutions, Arizona State University, USA',
        '',
        '## Abstract',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });
    const authorLine = [...document.querySelectorAll('.cm-line')]
        .find(line => line.textContent.includes('Lingfeng Xu'));
    const citations = [
        ...authorLine.querySelectorAll('.cm-mktero-citation'),
    ];

    assert.deepEqual(
        citations.map(citation => citation.textContent),
        ['1']
    );
    assert.deepEqual(
        [...authorLine.querySelectorAll('.cm-mktero-citation-superscript')]
            .map(element => element.textContent),
        ['1', ',**']
    );
    citations[0].dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    assert.match(
        document.querySelector('.mktero-citation-popup')?.textContent || '',
        /College of Health Solutions, Arizona State University, USA/
    );
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('links affiliations after leading equal-contribution and corresponding-author symbols', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '# Towards autonomous biology',
        '',
        'Renjian Song $^{*1}$, Yaokai Fu $^{*1}$, Ziyan Zhao $^{1}$, '
            + 'Jigang Yu $^{1}$, Qing Yuan $^{1}$, Chang-Ting Chen $^{**2}$',
        '',
        '\\*These authors contributed equally to this manuscript',
        '',
        '\\*\\*Corresponding author. Email: charlie.chen@bota.bio',
        '',
        '$^{1}$ Bota Biosciences, Hangzhou, China',
        '',
        '$^{2}$ Bota Biosciences, Lafayette, CA, USA',
        '',
        '## Abstract',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });
    const authorLine = [...document.querySelectorAll('.cm-line')]
        .find(line => line.textContent.includes('Renjian Song'));
    const citations = [
        ...authorLine.querySelectorAll('.cm-mktero-citation'),
    ];

    assert.deepEqual(
        citations.map(citation => citation.textContent),
        ['1', '1', '1', '1', '1', '2']
    );
    assert.deepEqual(
        [...authorLine.querySelectorAll('.cm-mktero-citation-superscript')]
            .map(element => element.textContent)
            .filter(text => /\*/.test(text)),
        ['*', '*', '**']
    );
    assert.equal(citations[0].getAttribute('aria-label'), 'View author affiliation 1');
    assert.equal(citations.at(-1).getAttribute('aria-label'), 'View author affiliation 2');
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('renders alphabetic author affiliations as interactive superscripts', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '# Paper',
        '',
        'Serge Steenen $^{a,b,*}$; Fabiënne Linke $^{b}$',
        '',
        '$^{a}$ Department of Surgery',
        '',
        '$^{b}$ Department of Public Health',
        '',
        '## Abstract',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });
    const authorLine = [...document.querySelectorAll('.cm-line')]
        .find(line => line.textContent.includes('Serge Steenen'));
    const citations = [
        ...authorLine.querySelectorAll('.cm-mktero-citation'),
    ];

    assert.deepEqual(
        citations.map(citation => citation.textContent),
        ['a', 'b', 'b']
    );
    assert.match(authorLine.textContent, /a,b,\*/);
    assert.deepEqual(
        [...document.querySelectorAll('.cm-mktero-affiliation-marker')]
            .map(marker => marker.textContent),
        ['a', 'b']
    );
    assert.equal(document.querySelector('.cm-mktero-math'), null);

    citations[0].dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    const popup = document.querySelector('.mktero-citation-popup');
    assert.equal(citations[0].getAttribute('aria-label'), 'View author affiliation a');
    assert.match(popup?.textContent || '', /\[a\]Department of Surgery/);

    editor.destroy();
    dom.window.close();
});

test('opens every reference in a grouped citation from its popup', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '# Paper',
        '',
        'Combined evidence [1–2].',
        '',
        '## References',
        '',
        '[1] Alpha A. First target. 2023.',
        '',
        '[2] Beta B. Second target. 2024.',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    const secondOffset = markdown.indexOf('[2] Beta');
    let navigatedOffset = null;
    view.lineBlockAt = position => {
        navigatedOffset = position;
        return { top: 720 };
    };
    view.requestMeasure = request => {
        if (request?.read) request.write?.(request.read(view), view);
    };

    const citation = document.querySelector('.cm-mktero-citation');
    citation.dispatchEvent(
        new dom.window.MouseEvent('mouseover', { bubbles: true })
    );
    const targets = [...document.querySelectorAll('.mktero-citation-popup-item')];
    assert.equal(targets.length, 2);

    citation.focus();
    citation.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'ArrowDown',
    }));
    assert.equal(document.activeElement, targets[0]);

    targets[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Escape',
    }));
    assert.equal(document.querySelector('.mktero-citation-popup'), null);
    assert.equal(document.activeElement, citation);

    citation.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'ArrowDown',
    }));
    const reopenedTargets = [
        ...document.querySelectorAll('.mktero-citation-popup-item'),
    ];
    assert.equal(document.activeElement, reopenedTargets[0]);
    reopenedTargets[1].focus();
    assert.ok(document.querySelector('.mktero-citation-popup'));

    reopenedTargets[1].click();

    assert.equal(navigatedOffset, secondOffset);
    assert.match(
        document.querySelector('.cm-mktero-reference-highlight')?.textContent || '',
        /Beta B\. Second target\. 2024\./
    );
    assert.equal(document.querySelector('.mktero-citation-popup'), null);

    editor.destroy();
    dom.window.close();
});

test('jumps to and highlights a clicked citation reference for three seconds', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '# Paper',
        '',
        'Finding [1].',
        '',
        '## References',
        '',
        '[1] Alpha A. Target reference. 2024.',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    const referenceOffset = markdown.indexOf('[1] Alpha');
    const scheduled = [];
    const originalSetTimeout = dom.window.setTimeout;
    const originalClearTimeout = dom.window.clearTimeout;
    dom.window.setTimeout = (callback, delay) => {
        scheduled.push({ callback, delay });
        return scheduled.length;
    };
    dom.window.clearTimeout = () => {};
    view.lineBlockAt = position => {
        assert.equal(position, referenceOffset);
        return { top: 640 };
    };
    view.requestMeasure = request => {
        if (!request?.read) return;
        request.write?.(request.read(view), view);
    };
    view.scrollDOM.scrollTop = 0;

    document.querySelector('.cm-mktero-citation').dispatchEvent(
        new dom.window.MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            button: 0,
        })
    );

    assert.equal(view.scrollDOM.scrollTop, 640);
    assert.match(
        document.querySelector('.cm-mktero-reference-highlight')?.textContent || '',
        /Alpha A\. Target reference\. 2024\./
    );
    assert.equal(scheduled.at(-1)?.delay, 3000);

    scheduled.at(-1).callback();
    assert.equal(document.querySelector('.cm-mktero-reference-highlight'), null);
    assert.equal(editor.getMarkdown(), markdown);

    dom.window.setTimeout = originalSetTimeout;
    dom.window.clearTimeout = originalClearTimeout;
    editor.destroy();
    dom.window.close();
});

test('refreshes rendered assets without changing the Markdown document', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'Intro\n\n![Figure](images/figure.png)';
    let imageURL = null;
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => imageURL,
        openLink: () => {},
    });

    assert.equal(document.querySelector('.cm-mktero-image img'), null);
    imageURL = 'blob:mktero-refreshed-figure';
    editor.refreshRendering();

    assert.equal(editor.getMarkdown(), markdown);
    assert.equal(
        document.querySelector('.cm-mktero-image img').getAttribute('src'),
        imageURL
    );

    editor.destroy();
    dom.window.close();
});

test('renders a cached image inside paragraph text', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'Intro\n\nSee ![Figure](images/figure.png) for details.';
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => 'blob:mktero-inline-figure',
        openLink: () => {},
    });

    assert.equal(
        document.querySelector('.cm-mktero-image-inline img').getAttribute('src'),
        'blob:mktero-inline-figure'
    );
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('renders an image on its own hard-break line at reading width', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        'Intro',
        '',
        '![](images/figure.jpg)  ',
        'Figure description.',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => 'blob:mktero-figure',
        openLink: () => {},
    });

    assert.equal(
        document.querySelector('.cm-mktero-image img').getAttribute('src'),
        'blob:mktero-figure'
    );
    assert.equal(document.querySelector('.cm-mktero-image-inline'), null);
    assert.match(document.querySelector('.cm-content').textContent, /Figure description\./);
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('renders an academic image description as a selectable read-only caption', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const captionText = 'Figure 1. PRISMA flowchart of included studies.';
    const markdown = `![${captionText}](images/figure.png)`;
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => 'blob:mktero-captioned-figure',
        openLink: () => {},
    });
    const figure = document.querySelector('.cm-mktero-image .mktero-figure');
    const image = figure?.querySelector('img');
    const caption = figure?.querySelector('figcaption');

    assert.equal(caption?.textContent, captionText);
    assert.equal(image?.getAttribute('alt'), captionText);

    const range = document.createRange();
    range.selectNodeContents(caption);
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);
    assert.equal(document.getSelection().toString(), captionText);

    image.dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));
    assert.equal(
        document.querySelector('.mktero-image-preview-image')?.getAttribute('alt'),
        captionText
    );
    document.querySelector('[aria-label="Close image preview"]').click();

    caption.dispatchEvent(new dom.window.MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));
    assert.ok(document.querySelector('.cm-mktero-image .mktero-figure'));
    assert.equal(
        document.querySelector('.cm-mktero-image figcaption').textContent,
        captionText
    );
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('renders EvoBrain model notation inside its figure caption', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = '![Fig. 2. The backbone is progressively adapted from '
        + '$M_{0}$ to $M_{1},\\\\ldots,M_{N}$.](images/evobrain.jpg)';
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => 'blob:mktero-evobrain',
    });
    const figure = document.querySelector('.cm-mktero-image .mktero-figure');
    const caption = figure?.querySelector('figcaption');

    assert.equal(caption?.querySelectorAll('.math-inline').length, 2);
    assert.equal(caption?.querySelectorAll('msub').length, 3);
    assert.match(caption?.innerHTML || '', /<mo>…<\/mo>/);
    assert.equal(
        figure?.querySelector('img')?.getAttribute('alt'),
        'Fig. 2. The backbone is progressively adapted from '
            + 'M_{0} to M_{1},\\ldots,M_{N}.'
    );
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('renders one shared caption for consecutive MinerU figure panels', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const captionText = 'Figure 2. Symptom reduction over time in the full sample. '
        + 'The gray shaded region indicates bootstrapped SEs. Model details '
        + 'are described in the Results for Aim 2.';
    const markdown = `${captionText}  \n`
        + '![](images/panel-a.jpg)\n\n'
        + '![](images/panel-b.jpg)';
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: path => `blob:mktero-${path}`,
        openLink: () => {},
    });

    const figure = document.querySelector('.mktero-figure-group');
    assert.equal(figure?.querySelectorAll('img').length, 2);
    assert.equal(figure?.querySelector('figcaption')?.textContent, captionText);
    assert.equal(
        figure?.querySelector('.mktero-figure-label')?.textContent,
        'Figure 2.'
    );
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('shows resolved references cited inside a shared figure caption', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '# Paper',
        '',
        '![](images/panel-a.jpg)',
        '',
        '![](images/panel-b.jpg)  ',
        'FIG. 1: Results use the method from Ref. [1].',
        '',
        '[1] Alpha A. Figure method. Journal. 2024.',
        '',
        '[2] Beta B. Supporting analysis. Journal. 2023.',
        '',
        '[3] Gamma G. Validation study. Journal. 2022.',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: path => `blob:mktero-${path}`,
        openLink: () => {},
    });
    const citation = document.querySelector(
        '.mktero-figure-group figcaption .cm-mktero-citation'
    );

    assert.equal(citation?.textContent, '1');
    citation.dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    assert.match(
        document.querySelector('.mktero-citation-popup')?.textContent || '',
        /Alpha A\. Figure method\. Journal\. 2024\./
    );
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('previews a rendered image with zoom and drag controls', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'Intro\n\n![Figure](images/figure.png)';
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => 'blob:mktero-preview-figure',
    });
    const renderedImage = document.querySelector('.cm-mktero-image img');
    assert.equal(renderedImage.getAttribute('role'), 'button');
    assert.equal(renderedImage.getAttribute('tabindex'), '0');
    assert.equal(renderedImage.getAttribute('aria-haspopup'), 'dialog');

    renderedImage.dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));

    const dialog = document.querySelector('.mktero-image-preview');
    const previewImage = dialog?.querySelector('.mktero-image-preview-image');
    const scale = dialog?.querySelector('.mktero-image-preview-scale');
    assert.equal(dialog?.getAttribute('role'), 'dialog');
    assert.equal(dialog?.getAttribute('aria-modal'), 'true');
    assert.equal(previewImage?.getAttribute('src'), 'blob:mktero-preview-figure');
    assert.equal(previewImage?.getAttribute('alt'), 'Figure');
    assert.equal(scale?.textContent, '100%');
    assert.ok(document.querySelector('.cm-mktero-image'));
    assert.equal(document.querySelector('.cm-editor').hasAttribute('inert'), true);
    assert.equal(document.querySelector('.cm-editor').getAttribute('aria-hidden'), 'true');

    const closeButton = dialog.querySelector('[aria-label="Close image preview"]');
    const zoomOutButton = dialog.querySelector('[aria-label="Zoom out"]');
    const zoomInButton = dialog.querySelector('[aria-label="Zoom in"]');
    assert.equal(
        zoomOutButton.querySelector('svg')?.getAttribute('data-lucide'),
        'zoom-out'
    );
    assert.equal(
        zoomInButton.querySelector('svg')?.getAttribute('data-lucide'),
        'zoom-in'
    );
    assert.equal(
        closeButton.querySelector('svg')?.getAttribute('data-lucide'),
        'x'
    );
    assert.equal(zoomOutButton.textContent, '');
    assert.equal(zoomInButton.textContent, '');
    assert.equal(closeButton.textContent, '');
    assert.equal(document.activeElement, closeButton);
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Tab',
        cancelable: true,
    }));
    assert.equal(document.activeElement, zoomOutButton);
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        cancelable: true,
    }));
    assert.equal(document.activeElement, closeButton);

    zoomInButton.click();
    assert.equal(scale.textContent, '125%');
    assert.match(previewImage.style.transform, /scale\(1\.25\)/);

    dialog.querySelector('[aria-label="Zoom out"]').click();
    assert.equal(scale.textContent, '100%');
    previewImage.dispatchEvent(new dom.window.MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 10,
        clientY: 20,
    }));
    dom.window.dispatchEvent(new dom.window.MouseEvent('mousemove', {
        clientX: 50,
        clientY: 80,
    }));
    dom.window.dispatchEvent(new dom.window.MouseEvent('mouseup'));
    assert.match(previewImage.style.transform, /translate\(40px, 60px\)/);
    assert.equal(editor.getMarkdown(), markdown);

    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(document.querySelector('.mktero-image-preview'), null);
    assert.equal(document.querySelector('.cm-editor').hasAttribute('inert'), false);
    assert.equal(document.querySelector('.cm-editor').getAttribute('aria-hidden'), null);

    renderedImage.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
    }));
    assert.ok(document.querySelector('.mktero-image-preview'));

    editor.destroy();
    assert.equal(document.querySelector('.mktero-image-preview'), null);
    dom.window.close();
});

test('previews an image inside a rendered table without editing the cell', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        'Intro',
        '',
        '| Result | Image |',
        '| --- | --- |',
        '| A | ![Table figure](images/table-figure.png) |',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => 'blob:mktero-table-figure',
    });
    const tableImage = document.querySelector('.cm-mktero-table img');
    const mouseDown = new dom.window.MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
    });

    tableImage.dispatchEvent(mouseDown);
    tableImage.dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));

    assert.equal(mouseDown.defaultPrevented, true);
    assert.equal(
        document.querySelector('.mktero-image-preview-image')?.getAttribute('alt'),
        'Table figure'
    );
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('allows rendered block text to be selected without revealing its source', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'Intro\n\n```text\nselect this text\n```';
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
        openLink: () => {},
    });
    const code = document.querySelector('.cm-mktero-code-block pre');
    const range = document.createRange();
    range.selectNodeContents(code);
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);

    const mouseDown = new dom.window.MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
    });
    code.dispatchEvent(mouseDown);
    code.dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));

    assert.equal(mouseDown.defaultPrevented, false);
    assert.match(document.getSelection().toString(), /select this text/);
    assert.ok(document.querySelector('.cm-mktero-code-block'));
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('shows Markdown annotation actions after selecting ordinary text', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: 'Select this Markdown text.',
    });
    const line = document.querySelector('.cm-line');
    const range = document.createRange();
    range.selectNodeContents(line);
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);

    line.dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
    }));

    const actions = document.querySelector(
        '.mktero-markdown-selection-actions'
    );
    assert.ok(actions);
    assert.ok(actions.querySelector('[data-action="add-note"]'));
    assert.match(document.getSelection().toString(), /Select this Markdown text/);

    editor.destroy();
    dom.window.close();
});

test('creates a local highlight from uniquely located rendered block text', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    let created;
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: '```text\nselect this text\n```',
        async createMarkdownAnnotation(annotation) {
            created = annotation;
            return { ...annotation, id: 'mktero-local-1' };
        },
    });
    const code = document.querySelector('.cm-mktero-code-block pre');
    const range = document.createRange();
    range.selectNodeContents(code);
    document.getSelection().addRange(range);

    code.dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
    }));
    document.querySelector('[data-color="#ffd400"]').click();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(created.text, 'select this text');
    assert.deepEqual(created.ranges, [{ from: 8, to: 24 }]);

    editor.destroy();
    dom.window.close();
});

test('creates a local highlight from the selected repeated rendered text', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    let created;
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: '```text\nrepeat repeat\n```',
        async createMarkdownAnnotation(annotation) {
            created = annotation;
            return { ...annotation, id: 'mktero-local-1' };
        },
    });
    const code = document.querySelector('.cm-mktero-code-block pre');
    const textNode = textNodeContaining(code, 'repeat repeat');
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 'repeat'.length);
    document.getSelection().addRange(range);

    code.dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
    }));
    const colorButton = document.querySelector('[data-color="#ffd400"]');
    assert.ok(colorButton);
    colorButton.click();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(created.text, 'repeat');
    assert.deepEqual(created.ranges, [{ from: 8, to: 14 }]);

    editor.destroy();
    dom.window.close();
});

test('maps repeated rendered table text from its selected cell', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '| Claim | Claim |',
        '| --- | --- |',
        '| repeat | repeat |',
    ].join('\n');
    let created;
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        async createMarkdownAnnotation(annotation) {
            created = annotation;
            return { ...annotation, id: 'mktero-local-1' };
        },
    });
    const cells = document.querySelectorAll('.cm-mktero-table td');
    const textNode = textNodeContaining(cells[1], 'repeat');
    const range = document.createRange();
    range.selectNodeContents(textNode);
    document.getSelection().addRange(range);

    cells[1].dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
    }));
    const colorButton = document.querySelector('[data-color="#ffd400"]');
    assert.ok(colorButton);
    colorButton.click();
    await Promise.resolve();
    await Promise.resolve();

    const from = markdown.lastIndexOf('repeat');
    assert.equal(created.text, 'repeat');
    assert.deepEqual(created.ranges, [{ from, to: from + 6 }]);

    editor.destroy();
    dom.window.close();
});

test('does not offer a partial annotation across rendered boundaries', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: '```text\nfirst\n```\n\nsecond',
        async createMarkdownAnnotation() {
            assert.fail('A cross-boundary annotation must not be created');
        },
    });
    const code = document.querySelector('.cm-mktero-code-block pre');
    const secondLine = [...document.querySelectorAll('.cm-line')].find(
        line => line.textContent.includes('second')
    );
    const firstText = textNodeContaining(code, 'first');
    const secondText = textNodeContaining(secondLine, 'second');
    const range = document.createRange();
    range.setStart(firstText, 0);
    range.setEnd(secondText, secondText.textContent.length);
    document.getSelection().addRange(range);

    secondLine.dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
    }));

    assert.equal(
        document.querySelector('.mktero-markdown-selection-actions'),
        null
    );

    editor.destroy();
    dom.window.close();
});

test('creates a local highlight from the selected Markdown text', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    let created;
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: 'Select this Markdown text.',
        async createMarkdownAnnotation(annotation) {
            created = annotation;
            return {
                ...annotation,
                id: 'mktero-local-1',
                matchKind: 'local',
            };
        },
    });
    const line = document.querySelector('.cm-line');
    const range = document.createRange();
    range.selectNodeContents(line);
    document.getSelection().addRange(range);
    line.dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
    }));

    const colorButton = document.querySelector(
        '.mktero-markdown-selection-actions [data-color="#ff6666"]'
    );
    colorButton.dispatchEvent(new dom.window.MouseEvent('mousedown', {
        bubbles: true,
        button: 0,
    }));
    colorButton.dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
    }));
    colorButton.click();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(created.text, 'Select this Markdown text.');
    assert.equal(created.color, '#ff6666');
    assert.deepEqual(created.ranges, [{ from: 0, to: 26 }]);
    assert.equal(created.source, 'markdown');
    assert.equal(document.getSelection().rangeCount, 0);
    assert.equal(document.querySelector('.mktero-annotation-popup'), null);

    editor.destroy();
    dom.window.close();
});

test('creates a local highlight and note from the selection note action', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    let created;
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: 'Select this Markdown text.',
        async createMarkdownAnnotation(annotation) {
            created = annotation;
            return { ...annotation, id: 'mktero-local-1' };
        },
    });
    const line = document.querySelector('.cm-line');
    const range = document.createRange();
    range.selectNodeContents(line);
    document.getSelection().addRange(range);
    line.dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
    }));

    const noteAction = document.querySelector('[data-action="add-note"]');
    assert.equal(
        noteAction.querySelector('svg')?.getAttribute('data-lucide'),
        'message-square-plus'
    );
    noteAction.click();
    const input = document.querySelector('.mktero-annotation-note-input');
    input.value = 'My Markdown note';
    document.querySelector('.mktero-annotation-note-save').click();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(created.text, 'Select this Markdown text.');
    assert.equal(created.comment, 'My Markdown note');
    assert.equal(created.color, '#ffd400');
    assert.deepEqual(created.ranges, [{ from: 0, to: 26 }]);
    assert.equal(document.querySelector('.mktero-annotation-popup'), null);

    editor.destroy();
    dom.window.close();
});

test('keeps rendered block Markdown read-only on double-click', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'Intro\n\n    const answer = 42;';
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
        openLink: () => {},
    });

    assert.match(
        document.querySelector('.cm-mktero-code-block pre').textContent,
        /const answer = 42;/
    );
    assert.equal(editor.getMarkdown(), markdown);

    document.querySelector('.cm-mktero-code-block').dispatchEvent(
        new dom.window.MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            button: 0,
        })
    );
    assert.ok(document.querySelector('.cm-mktero-code-block'));

    document.querySelector('.cm-mktero-code-block').dispatchEvent(
        new dom.window.MouseEvent('dblclick', {
            bubbles: true,
            cancelable: true,
            button: 0,
        })
    );
    assert.ok(document.querySelector('.cm-mktero-code-block'));
    assert.match(
        document.querySelector('.cm-mktero-code-block pre').textContent,
        /const answer = 42;/
    );
    assert.equal(
        document.querySelector('.cm-content').getAttribute('contenteditable'),
        'false'
    );

    editor.destroy();
    dom.window.close();
});

test('supports editors owned by two Zotero windows at the same time', () => {
    const firstDOM = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const secondDOM = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const firstEditor = createInlineMarkdownEditor({
        parent: firstDOM.window.document.querySelector('#editor'),
        initialMarkdown: '# First',
        resolveImageURL: () => null,
    });
    let secondEditor;

    assert.doesNotThrow(() => {
        secondEditor = createInlineMarkdownEditor({
            parent: secondDOM.window.document.querySelector('#editor'),
            initialMarkdown: '# Second',
            resolveImageURL: () => null,
        });
    });
    firstEditor.setMarkdown('# First updated');
    secondEditor.setMarkdown('# Second updated');
    assert.equal(firstEditor.getMarkdown(), '# First updated');
    assert.equal(secondEditor.getMarkdown(), '# Second updated');

    secondEditor.destroy();
    firstEditor.destroy();
    secondDOM.window.close();
    firstDOM.window.close();
});

test('activates the owning Zotero window before CodeMirror handles scrolling', () => {
    const originalRequestMeasure = EditorView.prototype.requestMeasure;
    const originalMeasure = EditorView.prototype.measure;
    let measureRequests = 0;
    let synchronousMeasures = 0;
    EditorView.prototype.requestMeasure = function(...args) {
        measureRequests++;
        return originalRequestMeasure.apply(this, args);
    };
    EditorView.prototype.measure = function(...args) {
        synchronousMeasures++;
        return originalMeasure.apply(this, args);
    };
    const firstDOM = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const secondDOM = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const firstEditor = createInlineMarkdownEditor({
        parent: firstDOM.window.document.querySelector('#editor'),
        initialMarkdown: Array.from(
            { length: 200 },
            (_, index) => `Paragraph ${index + 1}`
        ).join('\n\n'),
    });
    const secondEditor = createInlineMarkdownEditor({
        parent: secondDOM.window.document.querySelector('#editor'),
        initialMarkdown: '# Second window',
    });

    const measureRequestsBeforeScroll = measureRequests;
    const synchronousMeasuresBeforeScroll = synchronousMeasures;
    firstDOM.window.document.querySelector('.cm-scroller').dispatchEvent(
        new firstDOM.window.Event('scroll')
    );
    const scrollActivatedFirstWindow = globalThis.window === firstDOM.window;
    const scrollRequestedMeasure = measureRequests > measureRequestsBeforeScroll;
    const scrollMeasuredSynchronously = (
        synchronousMeasures > synchronousMeasuresBeforeScroll
    );

    firstDOM.window.document.querySelector('.cm-content').dispatchEvent(
        new firstDOM.window.KeyboardEvent('keydown', {
            key: 'a',
            bubbles: true,
        })
    );
    const keyActivatedFirstWindow = globalThis.window === firstDOM.window;

    secondEditor.destroy();
    firstEditor.destroy();
    secondDOM.window.close();
    firstDOM.window.close();
    EditorView.prototype.requestMeasure = originalRequestMeasure;
    EditorView.prototype.measure = originalMeasure;

    assert.equal(scrollActivatedFirstWindow, true);
    assert.equal(scrollRequestedMeasure, true);
    assert.equal(scrollMeasuredSynchronously, true);
    assert.equal(keyActivatedFirstWindow, true);
});

test('corrects outline navigation after the offscreen heading is rendered', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = Array.from(
        { length: 100 },
        (_, index) => `## Heading ${index}\n\nParagraph`
    ).join('\n\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    const targetOffset = markdown.indexOf('## Heading 80');
    let measuredNavigations = 0;
    const measuredScrollPositions = [];
    Object.defineProperty(view, 'viewport', {
        configurable: true,
        get() {
            return measuredNavigations > 1
                ? { from: targetOffset, to: targetOffset + 13 }
                : { from: 0, to: 20 };
        },
    });
    view.lineBlockAt = position => {
        assert.equal(position, targetOffset);
        return {
            top: measuredNavigations > 1 ? 1320 : 1200,
            bottom: measuredNavigations > 1 ? 1350 : 1230,
            height: 30,
            from: targetOffset,
            to: targetOffset + 13,
            type: 0,
        };
    };
    view.requestMeasure = request => {
        if (!request?.read) return;
        measuredNavigations++;
        const measurement = request.read(view);
        measuredScrollPositions.push(measurement?.top);
        request.write?.(measurement, view);
    };
    view.scrollDOM.scrollTop = 0;

    editor.scrollToOffset(targetOffset);
    const resultingScrollTop = view.scrollDOM.scrollTop;
    const resultingMarkdown = editor.getMarkdown();

    editor.destroy();
    dom.window.close();

    assert.equal(measuredNavigations, 2);
    assert.deepEqual(measuredScrollPositions, [1200, 1320]);
    assert.equal(resultingScrollTop, 1320);
    assert.equal(resultingMarkdown, markdown);
});

test('cancels a pending outline navigation when the document changes', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = `${'# Long document\n\n'.repeat(20)}## Target`;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    let pendingNavigation;
    view.requestMeasure = request => {
        if (request?.read) pendingNavigation = request;
    };
    view.scrollDOM.scrollTop = 0;

    editor.scrollToOffset(markdown.indexOf('## Target'));
    editor.setMarkdown('# Short');
    const measurement = pendingNavigation.read(view);
    pendingNavigation.write(measurement, view);
    const resultingScrollTop = view.scrollDOM.scrollTop;

    editor.destroy();
    dom.window.close();

    assert.equal(measurement, null);
    assert.equal(resultingScrollTop, 0);
});

test('observes editor resizes through the owning Zotero window', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const observedElements = [];
    dom.window.ResizeObserver = class {
        observe(element) {
            observedElements.push(element);
        }

        disconnect() {}
    };
    const editor = createInlineMarkdownEditor({
        parent: dom.window.document.querySelector('#editor'),
        initialMarkdown: '# Paper\n\n![Figure](figure.png)',
        resolveImageURL: () => 'blob:figure',
    });
    const observedEditorScroller = observedElements.some(element => (
        element.classList?.contains('cm-scroller')
    ));

    editor.destroy();
    dom.window.close();

    assert.equal(observedEditorScroller, true);
});

test('observes editor visibility through the owning Zotero window', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const observedElements = [];
    dom.window.IntersectionObserver = class {
        observe(element) {
            observedElements.push(element);
        }

        disconnect() {}
    };
    const editor = createInlineMarkdownEditor({
        parent: dom.window.document.querySelector('#editor'),
        initialMarkdown: Array.from(
            { length: 200 },
            (_, index) => `Paragraph ${index + 1}`
        ).join('\n\n'),
    });
    const observedEditorContent = observedElements.some(element => (
        element.classList?.contains('cm-content')
    ));

    editor.destroy();
    dom.window.close();

    assert.equal(observedEditorContent, true);
});
