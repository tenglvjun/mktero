import test from 'node:test';
import assert from 'node:assert/strict';
import {
    forceParsing,
    syntaxTreeAvailable,
} from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { JSDOM } from 'jsdom';
import {
    MarkdownAnnotationOverlay,
} from '../src/core/markdown-annotation-overlay.js';
import { visibleDocumentChromeRanges } from '../src/markdown/chrome-ranges.js';
import { createInlineMarkdownEditor } from '../src/editor/inline-markdown-editor.js';
import { selectedMarkdownAnnotation } from '../src/editor/inline-rendering.js';
import { createAnnotationPopup } from '../src/editor/annotation-popup.js';

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

function renderedLineTexts(document) {
    return [...document.querySelectorAll('.cm-line')].map(line => (
        line.textContent
    ));
}

function createAnnotationSelectionEditor(initialMarkdown, annotationID) {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    let created;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown,
        async createMarkdownAnnotation(annotation) {
            created = annotation;
            return { ...annotation, id: annotationID };
        },
    });
    return {
        dom,
        document,
        editor,
        createdAnnotation: () => created,
    };
}

function rectangle(top, right, bottom, left) {
    return {
        top,
        right,
        bottom,
        left,
        width: right - left,
        height: bottom - top,
    };
}

function hasRenderedWidget(view, display) {
    let found = false;
    for (const decorations of view.state.facet(EditorView.decorations)) {
        if (typeof decorations === 'function') continue;
        decorations.between(0, view.state.doc.length, (_from, _to, decoration) => {
            if (decoration.spec.widget?.display === display) found = true;
        });
    }
    return found;
}

function setSelectionGeometry(range, pointerLine, rectangles, lineRect) {
    range.getClientRects = () => rectangles;
    pointerLine.getBoundingClientRect = () => lineRect;
}

async function createHighlightFromSelection(document, pointerLine, pointer) {
    pointerLine.dispatchEvent(new document.defaultView.MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
        ...pointer,
    }));
    const colorButton = document.querySelector('[data-color="#ffd400"]');
    assert.ok(colorButton);
    colorButton.click();
    await Promise.resolve();
    await Promise.resolve();
}

function assertSemanticReferenceOutranksAnnotation({
    markdown,
    referenceText,
    referenceSelector,
    popupSelector,
    resolveImageURL,
}) {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
        resolveImageURL,
    });
    const from = markdown.indexOf(referenceText);
    assert.notEqual(from, -1);
    editor.setDocument({
        markdown,
        annotationOverlay: {
            matched: [{
                id: 'OVERLAP0001',
                source: 'zotero',
                type: 'highlight',
                text: referenceText,
                comment: '',
                color: '#ffd400',
                ranges: [{ from, to: from + referenceText.length }],
            }],
            unmatched: [],
        },
    });

    const scheduled = new Map();
    const originalSetTimeout = dom.window.setTimeout;
    const originalClearTimeout = dom.window.clearTimeout;
    let nextTimerID = 1;
    dom.window.setTimeout = (callback, delay) => {
        const timerID = nextTimerID++;
        scheduled.set(timerID, { callback, delay });
        return timerID;
    };
    dom.window.clearTimeout = timerID => scheduled.delete(timerID);

    const reference = document.querySelector(referenceSelector);
    const annotation = reference?.closest('.cm-mktero-pdf-annotation');
    assert.ok(reference);
    assert.ok(annotation);

    annotation.dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    assert.ok([...scheduled.values()].some(timer => timer.delay === 220));

    reference.dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    for (const timer of [...scheduled.values()]) timer.callback();

    assert.ok(document.querySelector(popupSelector));
    assert.equal(document.querySelector('.mktero-annotation-popup'), null);
    assert.equal(scheduled.size, 0);

    dom.window.setTimeout = originalSetTimeout;
    dom.window.clearTimeout = originalClearTimeout;
    editor.destroy();
    dom.window.close();
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

test('marks translated lines and clears the marks with the next document', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
    });
    const markdown = 'Original paragraph.\n\n翻译段落。';
    const translationFrom = markdown.indexOf('翻译');

    editor.setDocument({
        markdown,
        translationRanges: [{
            from: translationFrom,
            to: markdown.length,
            language: 'zh-CN',
        }],
    });

    const translatedLine = document.querySelector(
        '.cm-mktero-translation-line'
    );
    assert.equal(translatedLine?.textContent, '翻译段落。');
    assert.equal(
        translatedLine?.getAttribute('data-translation-start'),
        'true'
    );
    assert.equal(translatedLine?.getAttribute('lang'), 'zh-CN');

    editor.setMarkdown('Original only.');
    assert.equal(
        document.querySelector('.cm-mktero-translation-line'),
        null
    );

    editor.destroy();
    dom.window.close();
});

test('marks translated block widgets with their content language', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
        resolveImageURL: source => source === 'images/figure.png'
            ? 'blob:translated-figure'
            : null,
    });
    const markdown = [
        'Original paragraph.',
        '',
        'Table 1 Results',
        '',
        '| Metric | Value |',
        '| --- | ---: |',
        '| Score | 42 |',
        '',
        '![图 1](images/figure.png)',
    ].join('\n');
    const translationFrom = markdown.indexOf('Table 1');

    editor.setDocument({
        markdown,
        translationRanges: [{
            from: translationFrom,
            to: markdown.length,
            language: 'zh-CN',
        }],
    });

    const table = document.querySelector('.cm-mktero-table');
    assert.equal(table?.getAttribute('lang'), 'zh-CN');
    assert.equal(
        table?.classList.contains('cm-mktero-translation-block'),
        true
    );
    assert.equal(table?.closest('.cm-mktero-translation-line'), null);
    assert.equal(
        document.querySelector('.cm-mktero-image')?.getAttribute('lang'),
        'zh-CN'
    );

    editor.setDocument({
        markdown,
        translationRanges: [{
            from: translationFrom,
            to: markdown.length,
            language: 'ja-JP',
        }],
    });
    assert.equal(
        document.querySelector('.cm-mktero-table')?.getAttribute('lang'),
        'ja-JP'
    );

    editor.setDocument({
        markdown,
        translationFailures: [{
            id: 'translation-table-failure',
            from: translationFrom,
            to: markdown.length,
        }],
    });
    const failureTable = document.querySelector('.cm-mktero-table');
    assert.equal(failureTable?.hasAttribute('lang'), false);
    assert.equal(
        failureTable?.classList.contains(
            'cm-mktero-translation-failure-block'
        ),
        true
    );
    assert.equal(
        document.querySelector('.cm-mktero-image')?.classList.contains(
            'cm-mktero-translation-failure-block'
        ),
        true
    );

    editor.setDocument({
        markdown,
        translationRanges: [{
            from: markdown.indexOf('Metric'),
            to: markdown.length,
            language: 'zh-CN',
        }],
        translationFailures: [{
            id: 'partial-table-failure',
            from: markdown.indexOf('Score'),
            to: markdown.length,
        }],
    });
    const partialTable = document.querySelector('.cm-mktero-table');
    assert.equal(partialTable?.hasAttribute('lang'), false);
    assert.equal(
        partialTable?.classList.contains('cm-mktero-translation-block'),
        false
    );
    assert.equal(
        partialTable?.classList.contains(
            'cm-mktero-translation-failure-block'
        ),
        false
    );

    editor.setDocument({
        markdown,
        translationRanges: [{
            from: translationFrom,
            to: markdown.length,
            language: 'zh-CN" onclick="alert(1)',
        }],
    });
    const unsafeTable = document.querySelector('.cm-mktero-table');
    assert.equal(unsafeTable?.hasAttribute('lang'), false);
    assert.equal(unsafeTable?.hasAttribute('onclick'), false);
    assert.equal(
        unsafeTable?.classList.contains('cm-mktero-translation-block'),
        false
    );

    editor.destroy();
    dom.window.close();
});

test('pairs bilingual blocks without hover highlighting or per-block actions', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
    });
    const markdown = 'Original paragraph.\n\n\u8bd1\u6587\u6bb5\u843d\u3002';
    const translatedFrom = markdown.indexOf('\u8bd1\u6587');

    editor.setDocument({
        markdown,
        translationPairs: [{
            id: 'translation-0',
            sourceFrom: 0,
            sourceTo: 19,
            translatedFrom,
            translatedTo: markdown.length,
        }],
    });

    const source = document.querySelector(
        '.cm-mktero-translation-pair-source'
    );
    const translated = document.querySelector(
        '.cm-mktero-translation-pair-translated'
    );
    assert.equal(source?.getAttribute('data-translation-block-id'), 'translation-0');
    assert.equal(
        translated?.getAttribute('data-translation-block-id'),
        'translation-0'
    );
    assert.equal(document.querySelector(
        '.cm-mktero-translation-retry-button'
    ), null);

    translated.dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    assert.equal(source.classList.contains('is-translation-pair-active'), false);
    assert.equal(translated.classList.contains('is-translation-pair-active'), false);

    editor.highlightTranslationBlock('translation-0');
    assert.equal(source.classList.contains('is-translation-pair-active'), true);
    assert.equal(translated.classList.contains('is-translation-pair-active'), true);

    editor.setMarkdown('Original only.');
    assert.equal(
        document.querySelector('.cm-mktero-translation-retry-button'),
        null
    );

    editor.destroy();
    dom.window.close();
});

test('marks failed translation fallbacks without a per-block action', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
    });

    editor.setDocument({
        markdown: 'Source fallback.',
        translationFailures: [{
            id: 'translation-0-0-16-paragraph',
            from: 0,
            to: 16,
        }],
    });

    assert.equal(
        document.querySelector('.cm-mktero-translation-failure-line')
            ?.textContent,
        'Source fallback.'
    );
    assert.equal(
        document.querySelector('.cm-mktero-translation-failure-line')
            ?.getAttribute('lang'),
        ''
    );
    assert.equal(
        document.querySelector('.cm-mktero-translation-failure-label')
            ?.textContent,
        'Not translated; showing original'
    );
    assert.equal(
        document.querySelector('.cm-mktero-translation-failure-retry'),
        null
    );

    editor.setMarkdown('Translated.');
    assert.equal(
        document.querySelector('.cm-mktero-translation-failure'),
        null
    );

    editor.destroy();
    dom.window.close();
});

test('rejects malformed translation failure and language decorations', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
    });
    const markdown = 'Source fallback.';

    editor.setDocument({
        markdown,
        translationRanges: [{
            from: 0,
            to: markdown.length,
            language: 'en-US" onclick="alert(1)',
        }],
        translationFailures: [{
            id: 'invalid-negative',
            from: -1,
            to: 4,
        }, {
            id: 'invalid-reversed',
            from: 5,
            to: 2,
        }, {
            id: 'invalid-overflow',
            from: 0,
            to: markdown.length + 1,
        }],
    });

    assert.equal(
        document.querySelector('.cm-mktero-translation-failure'),
        null
    );
    const translatedLine = document.querySelector(
        '.cm-mktero-translation-line'
    );
    assert.equal(translatedLine?.hasAttribute('lang'), false);
    assert.equal(translatedLine?.hasAttribute('onclick'), false);

    editor.destroy();
    dom.window.close();
});

test('rejects unsafe, duplicate, overlapping, and out-of-bounds pairs', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
    });
    const markdown = 'Source.\n\nTranslation.\n\nOther.';
    const translatedFrom = markdown.indexOf('Translation');

    editor.setDocument({
        markdown,
        translationPairs: [{
            id: 'translation-0',
            sourceFrom: 0,
            sourceTo: 7,
            translatedFrom,
            translatedTo: translatedFrom + 12,
        }, {
            id: 'translation-0',
            sourceFrom: markdown.indexOf('Other'),
            sourceTo: markdown.length,
        }, {
            id: 'translation-overlap',
            sourceFrom: 2,
            sourceTo: 7,
        }, {
            id: 'translation-cross-side-overlap',
            sourceFrom: translatedFrom + 2,
            sourceTo: translatedFrom + 8,
        }, {
            id: 'translation-self-overlap',
            sourceFrom: markdown.indexOf('Other'),
            sourceTo: markdown.length,
            translatedFrom: markdown.indexOf('Other') + 1,
            translatedTo: markdown.length,
        }, {
            id: 'translation-overflow',
            sourceFrom: markdown.length,
            sourceTo: markdown.length + 8,
        }, {
            id: 'translation-1" onmouseover="alert(1)',
            sourceFrom: markdown.indexOf('Other'),
            sourceTo: markdown.length,
        }],
    });

    assert.deepEqual(
        [...document.querySelectorAll('[data-translation-block-id]')]
            .map(element => element.getAttribute('data-translation-block-id')),
        ['translation-0', 'translation-0']
    );
    assert.equal(
        document.querySelectorAll('.cm-mktero-translation-retry-button').length,
        0
    );
    assert.equal(document.querySelector('[onmouseover]'), null);

    editor.destroy();
    dom.window.close();
});

test('renders only the first valid failure for a duplicate stable block ID', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
    });
    const markdown = 'First fallback.\n\nSecond fallback.';

    editor.setDocument({
        markdown,
        translationFailures: [{
            id: 'duplicate-block',
            from: 0,
            to: 15,
        }, {
            id: 'duplicate-block',
            from: 17,
            to: markdown.length,
        }],
    });

    assert.equal(
        document.querySelectorAll('.cm-mktero-translation-failure').length,
        1
    );
    assert.equal(
        document.querySelectorAll('.cm-mktero-translation-failure-line').length,
        1
    );
    assert.equal(
        document.querySelector('.cm-mktero-translation-failure-line')
            ?.textContent,
        'First fallback.'
    );

    editor.destroy();
    dom.window.close();
});

test('hides the internal boundary between bilingual lists', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
    });
    const markdown = [
        '- First item',
        '<!-- mktero-bilingual-list-boundary -->',
        '',
        '- 第一项',
    ].join('\n');
    const translationFrom = markdown.lastIndexOf('- 第一项');
    editor.setDocument({
        markdown,
        translationRanges: [{
            from: translationFrom,
            to: markdown.length,
        }],
    });

    const boundary = document.querySelector('.cm-mktero-bilingual-boundary');
    assert.ok(boundary);
    assert.equal(boundary.textContent, '');
    assert.doesNotMatch(
        document.querySelector('.cm-content').textContent,
        /mktero-bilingual-list-boundary/
    );

    editor.setMarkdown('<!-- mktero-bilingual-list-boundary -->');
    assert.match(
        document.querySelector('.cm-content').textContent,
        /mktero-bilingual-list-boundary/
    );

    editor.destroy();
    dom.window.close();
});

test('opens a reliably mapped PDF source from the selection actions', async () => {
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
    mappedText.parentElement.dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
    }));

    assert.equal(document.querySelector('.cm-mktero-source-link'), null);
    const action = document.querySelector(
        '.mktero-markdown-selection-actions [data-action="view-in-pdf"]'
    );
    assert.ok(action);
    assert.equal(action.getAttribute('aria-label'), 'View in PDF');
    assert.equal(action.getAttribute('title'), 'View in PDF');
    assert.equal(
        action.querySelector('svg')?.getAttribute('data-lucide'),
        'external-link'
    );
    action.click();
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(opened, [locations[0]]);
    assert.equal(selection.toString(), 'Mapped');

    editor.destroy();
    dom.window.close();
});

test('opens the continuation page for a selected cross-page text range', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const anchor = 'The mapped paragraph ends with an unfinished expression +';
    const continuation = '(the continuation is on the next PDF page).';
    const markdown = `${anchor}\n\n${continuation}`;
    const locations = [{
        pageIndex: 2,
        bbox: [100, 400, 900, 500],
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
            markdownTo: markdown.length,
            locations,
            locationRanges: [{
                markdownFrom: 0,
                markdownTo: anchor.length,
                location: locations[0],
            }, {
                markdownFrom: anchor.length + 2,
                markdownTo: markdown.length,
                location: locations[1],
            }],
        }],
    });

    const continuationText = textNodeContaining(
        document.querySelector('.cm-content'),
        continuation
    );
    const range = document.createRange();
    range.setStart(continuationText, 0);
    range.setEnd(continuationText, continuation.length);
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);
    continuationText.parentElement.dispatchEvent(new dom.window.MouseEvent(
        'mouseup',
        { bubbles: true, button: 0 }
    ));

    document.querySelector('[data-action="view-in-pdf"]').click();
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(opened, [locations[1]]);

    editor.destroy();
    dom.window.close();
});

test('reports a PDF source navigation failure from the selection actions', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'Mapped paragraph with source.';
    const failure = new Error('navigation failed');
    const reported = [];
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
        openSourceLocation: async () => {
            throw failure;
        },
        onSourceNavigationError: error => reported.push(error),
    });
    editor.setDocument({
        markdown,
        sourceMap: [{
            type: 'text',
            markdownFrom: 0,
            markdownTo: markdown.length,
            locations: [{ pageIndex: 1, bbox: [100, 200, 900, 300] }],
        }],
    });

    const mappedText = textNodeContaining(
        document.querySelector('.cm-content'),
        'Mapped paragraph'
    );
    const range = document.createRange();
    range.setStart(mappedText, 0);
    range.setEnd(mappedText, 6);
    document.getSelection().addRange(range);
    mappedText.parentElement.dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
    }));
    document.querySelector('[data-action="view-in-pdf"]').click();
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(reported, [failure]);
    const error = document.querySelector('.mktero-annotation-action-error');
    assert.equal(error.hidden, false);
    assert.equal(
        error.textContent,
        'The PDF source location could not be opened.'
    );

    editor.destroy();
    dom.window.close();
});

test('does not render PDF source buttons beside mapped Markdown blocks', () => {
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
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    assert.equal(forceParsing(view, view.state.doc.length, 1000), true);

    assert.equal(
        document.querySelectorAll('.cm-mktero-source-link').length,
        0
    );
    assert.ok(document.querySelector('.cm-mktero-image'));
    assert.ok(document.querySelector('.cm-mktero-math-display'));
    assert.ok(document.querySelector('.cm-mktero-table'));

    editor.destroy();
    dom.window.close();
});

test('refreshes rendered widgets after deferred Markdown parsing completes', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const prefix = Array.from(
        { length: 120 },
        (_, index) => (
            `Paragraph ${index + 1} contains enough text to extend the initial parse.`
        )
    ).join('\n\n');
    const markdown = `${prefix}\n\n$$\nE = mc^2\n$$`;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));

    assert.equal(syntaxTreeAvailable(view.state), false);
    assert.equal(hasRenderedWidget(view, 'math-display'), false);
    assert.equal(forceParsing(view, view.state.doc.length, 1000), true);
    assert.equal(syntaxTreeAvailable(view.state), true);
    assert.equal(hasRenderedWidget(view, 'math-display'), true);

    editor.destroy();
    dom.window.close();
});

test('does not offer PDF source navigation for an invalid mapping', () => {
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

    const line = document.querySelector('.cm-line');
    const range = document.createRange();
    range.selectNodeContents(line);
    document.getSelection().addRange(range);
    line.dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
    }));
    assert.equal(
        document.querySelector('[data-action="view-in-pdf"]'),
        null
    );

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

test('prefers a citation over an overlapping PDF annotation', () => {
    assertSemanticReferenceOutranksAnnotation({
        markdown: [
            'The result is supported by [1].',
            '',
            '## References',
            '',
            '[1] Alpha A. Study. 2024.',
        ].join('\n'),
        referenceText: '[1]',
        referenceSelector: '.cm-mktero-citation',
        popupSelector: '.mktero-citation-popup',
    });
});

test('prefers a table reference over an overlapping PDF annotation', () => {
    assertSemanticReferenceOutranksAnnotation({
        markdown: [
            'The result is reported in Table 5.',
            '',
            'Table 5. Model performance',
            '',
            '| Model | Accuracy |',
            '| --- | ---: |',
            '| LLaMA | 0.72 |',
        ].join('\n'),
        referenceText: 'Table 5',
        referenceSelector: '.cm-mktero-table-reference',
        popupSelector: '.mktero-table-preview-popup',
    });
});

test('prefers a figure reference over an overlapping PDF annotation', () => {
    assertSemanticReferenceOutranksAnnotation({
        markdown: [
            'The architecture is shown in Fig. 1.',
            '',
            '![Fig. 1. Pipeline architecture](images/pipeline.png)',
        ].join('\n'),
        referenceText: 'Fig. 1',
        referenceSelector: '.cm-mktero-figure-reference',
        popupSelector: '.mktero-figure-preview-popup',
        resolveImageURL: path => `blob:mktero-${path}`,
    });
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

test('opens annotation actions only after an intentional hover', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
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
                ranges: [{ from: 0, to: 9 }],
            }],
            unmatched: [],
        },
    });
    const annotation = document.querySelector('.cm-mktero-pdf-annotation');
    const line = document.querySelector('.cm-line');
    const scheduled = new Map();
    const originalSetTimeout = dom.window.setTimeout;
    const originalClearTimeout = dom.window.clearTimeout;
    let nextTimerID = 1;
    dom.window.setTimeout = (callback, delay) => {
        const timerID = nextTimerID++;
        scheduled.set(timerID, { callback, delay });
        return timerID;
    };
    dom.window.clearTimeout = timerID => scheduled.delete(timerID);

    annotation.dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));

    assert.equal(document.querySelector('.mktero-annotation-popup'), null);
    assert.equal([...scheduled.values()].at(-1)?.delay, 220);

    annotation.dispatchEvent(new dom.window.MouseEvent('mouseout', {
        bubbles: true,
        relatedTarget: line,
    }));
    assert.equal(scheduled.size, 0);

    annotation.dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    const [hoverTimerID, hover] = [...scheduled.entries()].at(-1);
    scheduled.delete(hoverTimerID);
    hover.callback();

    assert.ok(document.querySelector('.mktero-annotation-popup'));

    line.dispatchEvent(new dom.window.MouseEvent('mousedown', {
        bubbles: true,
        button: 0,
    }));
    annotation.dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    assert.equal([...scheduled.values()].at(-1)?.delay, 220);

    editor.destroy();
    assert.equal(scheduled.size, 0);
    dom.window.setTimeout = originalSetTimeout;
    dom.window.clearTimeout = originalClearTimeout;
    dom.window.close();
});

test('shows note, PDF navigation, color, and delete actions when focusing a PDF annotation', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    let resolveColorChange;
    let resolveDelete;
    let updatedNote;
    let openedAnnotationID;
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
        updateAnnotationComment(annotationID, comment) {
            updatedNote = { annotationID, comment };
        },
        openAnnotationInPDF(annotationID) {
            openedAnnotationID = annotationID;
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

    annotation.dispatchEvent(new dom.window.FocusEvent('focusin', {
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
    const noteButton = popup.querySelector('.mktero-annotation-note-button');
    assert.ok(noteButton);
    assert.equal(
        noteButton.querySelector('svg')?.getAttribute('data-lucide'),
        'message-square-plus'
    );
    const sourceButton = popup.querySelector('.mktero-annotation-source-button');
    assert.ok(sourceButton);
    assert.equal(
        sourceButton.querySelector('svg')?.getAttribute('data-lucide'),
        'external-link'
    );
    assert.doesNotMatch(popup.textContent, /Private note/);

    sourceButton.click();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(openedAnnotationID, 'HIGH0001');
    assert.equal(document.querySelector('.mktero-annotation-popup'), null);

    annotation.dispatchEvent(new dom.window.FocusEvent('focusin', {
        bubbles: true,
    }));
    document.querySelector('.mktero-annotation-note-button').click();
    const notePopup = document.querySelector('.mktero-annotation-popup');
    const noteInput = notePopup.querySelector('.mktero-annotation-note-input');
    noteInput.value = 'Revised note';
    notePopup.querySelector('.mktero-annotation-note-save').click();
    await Promise.resolve();
    assert.deepEqual(updatedNote, {
        annotationID: 'HIGH0001',
        comment: 'Revised note',
    });
    assert.equal(document.querySelector('.mktero-annotation-popup'), null);

    annotation.dispatchEvent(new dom.window.FocusEvent('focusin', {
        bubbles: true,
    }));
    const colorPopup = document.querySelector('.mktero-annotation-popup');
    colorPopup.querySelector('[data-color="#ff6666"]').click();
    assert.deepEqual(await colorChanged, {
        annotationID: 'HIGH0001',
        color: '#ff6666',
    });
    assert.equal(document.querySelector('.mktero-annotation-popup'), null);

    annotation.dispatchEvent(new dom.window.FocusEvent('focusin', {
        bubbles: true,
    }));
    const reopenedPopup = document.querySelector('.mktero-annotation-popup');
    reopenedPopup.querySelector('.mktero-annotation-delete-button').click();
    assert.equal(await deleted, 'HIGH0001');
    assert.equal(document.querySelector('.mktero-annotation-popup'), null);

    editor.destroy();
    dom.window.close();
});

test('does not offer PDF navigation for a local Markdown annotation', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
        resolveImageURL: () => null,
        openAnnotationInPDF: () => assert.fail(
            'Local Markdown annotations must not open PDF annotations'
        ),
    });
    editor.setDocument({
        markdown: 'Local annotation.',
        annotationOverlay: {
            matched: [{
                id: 'mktero-local-1',
                source: 'markdown',
                type: 'highlight',
                text: 'Local annotation',
                comment: 'Local note',
                color: '#ffd400',
                ranges: [{ from: 0, to: 16 }],
            }],
            unmatched: [],
        },
    });
    const annotation = document.querySelector('.cm-mktero-pdf-annotation');
    annotation.dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));

    assert.equal(
        document.querySelector('.mktero-annotation-source-button'),
        null
    );

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

test('renders inline math followed immediately by CJK prose', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '观察到的基线MADRS评分为$23.6 \\pm 8.3$分，',
        '干预后评分降至$10.2 \\pm 4.8$分。',
    ].join('');
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });
    const inlineMath = [...document.querySelectorAll('.cm-mktero-math')];

    assert.equal(inlineMath.length, 2);
    assert.ok(inlineMath.every(widget => widget.querySelector('math')));
    assert.deepEqual(
        inlineMath.map(widget => widget.querySelector('annotation').textContent),
        ['23.6 \\pm 8.3', '10.2 \\pm 4.8']
    );
    assert.equal(editor.getMarkdown(), markdown);

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

test('commits one paragraph block directly from read-only mode', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = '# Paper\n\nThe sample included 5O people.';
    const from = markdown.indexOf('The sample');
    const to = markdown.length;
    const blocks = [{
        id: 'paragraph-1',
        type: 'paragraph',
        from,
        to,
        markdown: markdown.slice(from, to),
    }];
    const commits = [];
    let bubbledSaveShortcuts = 0;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        onCommitCorrection: async correction => commits.push(correction),
    });
    editor.setCorrectionState({
        enabled: false,
        blocks,
        correctedBlockIDs: [],
    });
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    view.posAtCoords = () => from + 8;
    const content = document.querySelector('.cm-content');
    document.addEventListener('keydown', event => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            bubbledSaveShortcuts++;
        }
    });

    content.dispatchEvent(new dom.window.MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));
    assert.equal(content.getAttribute('contenteditable'), 'true');
    editor.setCorrectionState({ enabled: false, blocks });
    assert.equal(content.getAttribute('contenteditable'), 'true');

    const typo = markdown.indexOf('5O') + 1;
    view.dispatch({ changes: { from: typo, to: typo + 1, insert: '0' } });
    content.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
    }));
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(commits, [{
        blockID: 'paragraph-1',
        replacementMarkdown: 'The sample included 50 people.',
    }]);
    assert.equal(bubbledSaveShortcuts, 0);
    assert.equal(content.getAttribute('contenteditable'), 'false');

    editor.destroy();
    dom.window.close();
});

test('edits prose while protecting formulas in a correction block', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'The value is $E = mc^2$ for 5O participants.';
    const formulaFrom = markdown.indexOf('$E = mc^2$');
    const formulaTo = formulaFrom + '$E = mc^2$'.length;
    const commits = [];
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        onCommitCorrection: async correction => commits.push(correction),
    });
    editor.setCorrectionState({
        enabled: true,
        blocks: [{
            id: 'formula-paragraph',
            type: 'paragraph',
            from: 0,
            to: markdown.length,
            markdown,
            protectedRanges: [{ from: formulaFrom, to: formulaTo }],
        }],
    });
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    const content = document.querySelector('.cm-content');
    const typo = markdown.indexOf('5O');
    view.posAtCoords = () => typo;
    const prose = textNodeContaining(content, 'The value');
    const range = document.createRange();
    range.setStart(prose, prose.textContent.indexOf('value'));
    range.setEnd(prose, prose.textContent.indexOf('value') + 'value'.length);
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);
    prose.parentElement.dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));
    assert.ok(document.querySelector('.mktero-markdown-selection-actions'));

    content.dispatchEvent(new dom.window.MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));

    assert.equal(content.getAttribute('contenteditable'), 'true');
    assert.equal(
        document.querySelector('.mktero-markdown-selection-actions'),
        null
    );
    assert.equal(
        document.querySelector('.mktero-correction-editor-delete').hidden,
        true
    );

    view.dispatch({ changes: { from: 0, to: 3, insert: 'Measured' } });
    const offsetDelta = 'Measured'.length - 'The'.length;
    view.dispatch({
        changes: {
            from: typo + offsetDelta + 1,
            to: typo + offsetDelta + 2,
            insert: '0',
        },
    });
    const exponent = markdown.indexOf('2$') + offsetDelta;
    view.dispatch({ changes: { from: exponent, to: exponent + 1, insert: '3' } });

    assert.equal(
        editor.getMarkdown(),
        'Measured value is $E = mc^2$ for 50 participants.'
    );
    document.querySelector('.mktero-correction-editor-save').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(commits, [{
        blockID: 'formula-paragraph',
        replacementMarkdown: 'Measured value is $E = mc^2$ for 50 participants.',
    }]);

    editor.destroy();
    dom.window.close();
});

test('protects annotated text and submits its exact mapped range', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'Before protected text after.';
    const protectedFrom = markdown.indexOf('protected text');
    const protectedTo = protectedFrom + 'protected text'.length;
    const commits = [];
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        onCommitCorrection: async correction => commits.push(correction),
    });
    editor.setCorrectionState({
        enabled: true,
        blocks: [{
            id: 'annotated-paragraph',
            type: 'paragraph',
            from: 0,
            to: markdown.length,
            markdown,
            protectedRanges: [{
                from: protectedFrom,
                to: protectedTo,
                kind: 'annotation',
            }],
        }],
        annotationRanges: [{
            id: 'mktero-local-1',
            source: 'markdown',
            rangeIndex: 0,
            from: protectedFrom,
            to: protectedTo,
        }],
    });
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    const content = document.querySelector('.cm-content');
    view.posAtCoords = () => 1;
    content.dispatchEvent(new dom.window.MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));

    view.dispatch({ changes: { from: 0, insert: 'New ' } });
    const shiftedFrom = protectedFrom + 4;
    view.dispatch({
        changes: {
            from: shiftedFrom + 1,
            to: shiftedFrom + 2,
            insert: 'X',
        },
    });
    assert.equal(
        document.querySelector('.mktero-correction-editor-status').textContent,
        'This text has an annotation. Delete the annotation before editing it.'
    );
    const afterFrom = editor.getMarkdown().indexOf('after');
    view.dispatch({ changes: { from: afterFrom, insert: 'really ' } });

    assert.equal(
        editor.getMarkdown(),
        'New Before protected text really after.'
    );
    document.querySelector('.mktero-correction-editor-save').click();
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(commits, [{
        blockID: 'annotated-paragraph',
        replacementMarkdown: 'New Before protected text really after.',
        annotationRanges: [{
            id: 'mktero-local-1',
            source: 'markdown',
            rangeIndex: 0,
            from: shiftedFrom,
            to: protectedTo + 4,
        }],
    }]);
    assert.equal(
        document.querySelector('.mktero-correction-editor-delete').hidden,
        true
    );

    editor.destroy();
    dom.window.close();
});

test('does not start direct correction from an interactive link', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = '[Source](https://example.com) text.';
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        onCommitCorrection: async () => {},
    });
    editor.setCorrectionState({
        enabled: false,
        blocks: [{
            id: 'paragraph-1',
            type: 'paragraph',
            from: 0,
            to: markdown.length,
            markdown,
        }],
    });
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    const content = document.querySelector('.cm-content');
    view.posAtCoords = () => 1;

    document.querySelector('.cm-mktero-link').dispatchEvent(
        new dom.window.MouseEvent('dblclick', {
            bubbles: true,
            cancelable: true,
            button: 0,
        })
    );

    assert.equal(content.getAttribute('contenteditable'), 'false');
    assert.equal(
        document.querySelector('.mktero-correction-editor-toolbar').hidden,
        true
    );

    view.dispatch({ selection: { anchor: 1 } });
    document.querySelector('.cm-mktero-link').dispatchEvent(
        new dom.window.KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
        })
    );
    assert.equal(content.getAttribute('contenteditable'), 'false');

    view.posAtCoords = () => markdown.indexOf('text');
    content.dispatchEvent(new dom.window.MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));
    assert.equal(content.getAttribute('contenteditable'), 'true');

    editor.destroy();
    dom.window.close();
});

test('uses the clicked rendered line when CodeMirror coordinates lag behind',
    async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        'Keywords: wearable devices; ovulation.',
        '',
        'Copyright 2024 Authors. This long paragraph contains a URL '
            + 'https://example.com/article and enough text to wrap across lines.',
    ].join('\n');
    const keywordsFrom = markdown.indexOf('Keywords');
    const copyrightFrom = markdown.indexOf('Copyright');
    const submissions = [];
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        onCommitCorrection: async correction => submissions.push(correction),
    });
    editor.setCorrectionState({
        enabled: false,
        blocks: [{
            id: 'keywords',
            type: 'paragraph',
            from: keywordsFrom,
            to: keywordsFrom + 'Keywords: wearable devices; ovulation.'.length,
        }, {
            id: 'copyright',
            type: 'paragraph',
            from: copyrightFrom,
            to: markdown.length,
        }],
    });
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    view.posAtCoords = () => copyrightFrom + 1;
    const keywordLine = [...document.querySelectorAll('.cm-line')].find(line => (
        line.textContent.startsWith('Keywords:')
    ));
    assert.ok(keywordLine);

    keywordLine.dispatchEvent(new dom.window.MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));
    view.dispatch({
        changes: {
            from: keywordsFrom,
            to: keywordsFrom + 1,
            insert: 'k',
        },
    });
    document.querySelector('.mktero-correction-editor-save').click();
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(submissions, [{
        blockID: 'keywords',
        replacementMarkdown: 'keywords: wearable devices; ovulation.',
    }]);

    const copyrightLine = [...document.querySelectorAll('.cm-line')].find(line => (
        line.textContent.startsWith('Copyright')
    ));
    assert.ok(copyrightLine);
    copyrightLine.dispatchEvent(new dom.window.MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));
    assert.equal(
        document.querySelector('.cm-content').getAttribute('contenteditable'),
        'true'
    );

    editor.destroy();
    dom.window.close();
});

test('does not start correction from an open selection actions popup', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'Select this Markdown text.';
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        onCommitCorrection: async () => {},
    });
    editor.setCorrectionState({
        enabled: false,
        blocks: [{
            id: 'paragraph-1',
            type: 'paragraph',
            from: 0,
            to: markdown.length,
        }],
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
    const popup = document.querySelector('.mktero-markdown-selection-actions');
    assert.ok(popup);

    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    view.posAtCoords = () => 0;
    popup.dispatchEvent(new dom.window.MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));

    assert.equal(
        document.querySelector('.cm-content').getAttribute('contenteditable'),
        'false'
    );

    editor.destroy();
    dom.window.close();
});

test('deletes a whole correction block after removing its final character', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'O';
    const from = 0;
    const submissions = [];
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        onCommitCorrection: async correction => submissions.push(correction),
    });
    editor.setCorrectionState({
        enabled: true,
        blocks: [{
            id: 'paragraph-1',
            type: 'paragraph',
            from,
            to: markdown.length,
            markdown: markdown.slice(from),
        }],
    });
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    view.posAtCoords = () => from + 1;
    const content = document.querySelector('.cm-content');
    content.dispatchEvent(new dom.window.MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));

    view.dispatch({
        changes: { from, to: markdown.length, insert: '' },
    });
    assert.equal(editor.getMarkdown(), '');

    content.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        metaKey: true,
        bubbles: true,
        cancelable: true,
    }));
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(submissions, [{
        blockID: 'paragraph-1',
        replacementMarkdown: '',
    }]);
    assert.equal(editor.getMarkdown(), '');

    editor.destroy();
    dom.window.close();
});

test('opens block correction actions directly from read-only mode', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'Remove this paragraph.';
    const submissions = [];
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        onCommitCorrection: async correction => submissions.push(correction),
    });
    editor.setCorrectionState({
        enabled: false,
        blocks: [{
            id: 'paragraph-1',
            type: 'paragraph',
            from: 0,
            to: markdown.length,
            markdown,
        }],
    });
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    view.posAtCoords = () => 1;
    const content = document.querySelector('.cm-content');
    const begin = () => content.dispatchEvent(new dom.window.MouseEvent(
        'dblclick',
        {
            bubbles: true,
            cancelable: true,
            button: 0,
        }
    ));

    begin();
    const toolbar = document.querySelector(
        '.mktero-correction-editor-toolbar'
    );
    const saveButton = toolbar.querySelector(
        '.mktero-correction-editor-save'
    );
    const cancelButton = toolbar.querySelector(
        '.mktero-correction-editor-cancel'
    );
    const deleteButton = toolbar.querySelector(
        '.mktero-correction-editor-delete'
    );
    assert.equal(toolbar.hidden, false);
    assert.equal(saveButton.textContent, 'Save changes');
    assert.equal(cancelButton.textContent, 'Cancel');
    assert.equal(deleteButton.textContent, 'Delete paragraph');
    assert.equal(saveButton.disabled, true);
    assert.equal(
        toolbar.querySelector('.mktero-correction-editor-status').hidden,
        true
    );

    view.dispatch({ changes: { from: 0, to: 6, insert: 'Keep' } });
    assert.equal(saveButton.disabled, false);
    assert.equal(
        toolbar.querySelector('.mktero-correction-editor-status').textContent,
        'Unsaved changes'
    );
    cancelButton.click();
    assert.equal(editor.getMarkdown(), markdown);
    assert.equal(toolbar.hidden, true);
    assert.deepEqual(submissions, []);

    begin();
    view.dispatch({ selection: { anchor: 1 } });
    content.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'F2',
        bubbles: true,
        cancelable: true,
    }));
    assert.equal(content.getAttribute('contenteditable'), 'true');
    assert.equal(saveButton.disabled, true);
    cancelButton.click();

    begin();
    view.dispatch({
        changes: {
            from: markdown.length - 1,
            to: markdown.length,
            insert: '!',
        },
    });
    saveButton.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(submissions, [{
        blockID: 'paragraph-1',
        replacementMarkdown: 'Remove this paragraph!',
    }]);
    assert.equal(toolbar.hidden, true);

    begin();
    document.querySelector('.mktero-correction-editor-delete').click();
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(submissions, [{
        blockID: 'paragraph-1',
        replacementMarkdown: 'Remove this paragraph!',
    }, {
        blockID: 'paragraph-1',
        replacementMarkdown: '',
    }]);
    assert.equal(editor.getMarkdown(), '');
    assert.equal(content.getAttribute('contenteditable'), 'false');
    assert.equal(toolbar.hidden, true);

    editor.destroy();
    assert.equal(
        document.querySelector('.mktero-correction-editor-toolbar'),
        null
    );
    dom.window.close();
});

test('collapses the empty lines left by a deleted block in read-only mode', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = '# Study\n\n\n\nConclusion.';
    const deletedBlock = {
        id: 'deleted-paragraph',
        type: 'paragraph',
        from: '# Study\n\n'.length,
        to: '# Study\n\n'.length,
        markdown: '',
    };
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });

    editor.setCorrectionState({
        enabled: false,
        blocks: [deletedBlock],
        correctedBlockIDs: [deletedBlock.id],
    });

    assert.deepEqual(renderedLineTexts(document), [
        'Study',
        '',
        'Conclusion.',
    ]);

    editor.setCorrectionState({
        enabled: true,
        blocks: [deletedBlock],
        correctedBlockIDs: [deletedBlock.id],
    });
    assert.deepEqual(renderedLineTexts(document), [
        'Study',
        '',
        '',
        '',
        'Conclusion.',
    ]);
    assert.ok(document.querySelector('.cm-mktero-deleted-correction'));

    editor.setCorrectionState({
        enabled: false,
        blocks: [deletedBlock],
        correctedBlockIDs: [deletedBlock.id],
    });
    assert.deepEqual(renderedLineTexts(document), [
        'Study',
        '',
        'Conclusion.',
    ]);

    editor.destroy();
    dom.window.close();
});

test('collapses deleted block gaps at document boundaries', () => {
    const cases = [{
        name: 'first block with blank-line whitespace',
        markdown: '\n \t\nAfter',
        positions: [0],
        expected: ['After'],
    }, {
        name: 'last block with blank-line whitespace',
        markdown: 'Before\n \t\n',
        positions: ['Before\n \t\n'.length],
        expected: ['Before'],
    }, {
        name: 'middle block with blank-line whitespace',
        markdown: 'Before\n\n\n \t\nAfter',
        positions: ['Before\n\n'.length],
        expected: ['Before', '', 'After'],
    }, {
        name: 'adjacent blocks',
        markdown: 'Before\n\n\n\n\n\nAfter',
        positions: [8, 10],
        expected: ['Before', '', 'After'],
    }];

    for (const scenario of cases) {
        const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
            pretendToBeVisual: true,
        });
        const { document } = dom.window;
        const blocks = scenario.positions.map((position, index) => ({
            id: `deleted-${index}`,
            type: 'paragraph',
            from: position,
            to: position,
            markdown: '',
        }));
        const editor = createInlineMarkdownEditor({
            parent: document.querySelector('#editor'),
            initialMarkdown: scenario.markdown,
        });

        editor.setCorrectionState({
            enabled: false,
            blocks,
            correctedBlockIDs: blocks.map(block => block.id),
        });

        assert.deepEqual(
            renderedLineTexts(document),
            scenario.expected,
            scenario.name
        );

        editor.destroy();
        dom.window.close();
    }
});

test('ignores malformed deleted block ranges in read-only mode', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'Before\n\nAfter';
    const blocks = [
        null,
        { id: 'negative', type: 'paragraph', from: -1, to: -1 },
        {
            id: 'oversized',
            type: 'paragraph',
            from: Number.MAX_SAFE_INTEGER,
            to: Number.MAX_SAFE_INTEGER,
        },
        { id: 'string', type: 'paragraph', from: '8', to: '8' },
        { id: 'table', type: 'table', from: 8, to: 8 },
        { id: 'unknown', type: 'unknown', from: 8, to: 8 },
        { id: 'missing-type', from: 8, to: 8 },
        { type: 'paragraph', from: 8, to: 8 },
        { id: 'not-deleted', type: 'paragraph', from: 0, to: 6 },
    ];
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });

    editor.setCorrectionState({
        enabled: false,
        blocks,
        correctedBlockIDs: [
            'negative',
            'oversized',
            'string',
            'table',
            'unknown',
            'missing-type',
            undefined,
            'not-deleted',
        ],
    });

    assert.deepEqual(renderedLineTexts(document), ['Before', '', 'After']);

    editor.setCorrectionState({
        enabled: true,
        blocks,
        correctedBlockIDs: [
            'negative',
            'oversized',
            'string',
            'table',
            'unknown',
            'missing-type',
            undefined,
            'not-deleted',
        ],
    });
    assert.equal(
        document.querySelectorAll('.cm-mktero-correction-marker').length,
        1
    );

    editor.destroy();
    dom.window.close();
});

test('shows a compact deleted-block restore only in correction mode', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const restores = [];
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
        onCommitCorrection: async () => {},
        onRestoreCorrection: async blockID => restores.push(blockID),
    });
    editor.setCorrectionState({
        enabled: false,
        blocks: [{
            id: 'deleted-paragraph',
            type: 'paragraph',
            from: 0,
            to: 0,
            markdown: '',
        }],
        correctedBlockIDs: ['deleted-paragraph'],
    });

    assert.equal(
        document.querySelector('.cm-mktero-correction-marker'),
        null
    );
    assert.equal(
        document.querySelector('.cm-mktero-deleted-correction'),
        null
    );

    editor.setCorrectionState({
        enabled: true,
        blocks: [{
            id: 'deleted-paragraph',
            type: 'paragraph',
            from: 0,
            to: 0,
            markdown: '',
        }],
        correctedBlockIDs: ['deleted-paragraph'],
    });

    const placeholder = document.querySelector(
        '.cm-mktero-deleted-correction'
    );
    const restoreButton = document.querySelector(
        '.cm-mktero-correction-marker'
    );
    assert.ok(placeholder);
    assert.match(placeholder.textContent, /deleted content/i);
    assert.ok(restoreButton);
    assert.equal(restoreButton.textContent, 'Undo deletion');
    restoreButton.click();
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(restores, ['deleted-paragraph']);

    editor.destroy();
    dom.window.close();
});

test('restores a deleted correction block when saving fails', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'O';
    const errors = [];
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        onCommitCorrection: async () => {
            throw new Error('disk full');
        },
        onCorrectionError: error => errors.push(error.message),
    });
    editor.setCorrectionState({
        enabled: true,
        blocks: [{
            id: 'paragraph-1',
            type: 'paragraph',
            from: 0,
            to: markdown.length,
            markdown,
        }],
    });
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    view.posAtCoords = () => 0;
    const content = document.querySelector('.cm-content');
    content.dispatchEvent(new dom.window.MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));
    view.dispatch({ changes: { from: 0, to: markdown.length, insert: '' } });
    content.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        metaKey: true,
        bubbles: true,
        cancelable: true,
    }));
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(errors, ['disk full']);
    assert.equal(editor.getMarkdown(), '');
    assert.equal(content.getAttribute('contenteditable'), 'true');
    assert.equal(
        document.querySelector('.mktero-correction-editor-status').textContent,
        'The correction could not be saved.'
    );
    document.querySelector('.mktero-correction-editor-cancel').click();
    assert.equal(editor.getMarkdown(), markdown);
    assert.equal(content.getAttribute('contenteditable'), 'false');

    editor.destroy();
    dom.window.close();
});

test('does not save a correction while an IME composition is active', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'Recognition text.';
    const submissions = [];
    let bubbledSaveShortcuts = 0;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        onCommitCorrection: async correction => submissions.push(correction),
    });
    editor.setCorrectionState({
        enabled: true,
        blocks: [{
            id: 'paragraph-1',
            type: 'paragraph',
            from: 0,
            to: markdown.length,
            markdown,
        }],
    });
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    view.posAtCoords = () => 1;
    const content = document.querySelector('.cm-content');
    document.addEventListener('keydown', event => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            bubbledSaveShortcuts++;
        }
    });
    content.dispatchEvent(new dom.window.MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));
    content.dispatchEvent(new dom.window.CompositionEvent('compositionstart', {
        bubbles: true,
        cancelable: true,
        data: '校',
    }));
    content.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        metaKey: true,
        isComposing: true,
        bubbles: true,
        cancelable: true,
    }));
    content.dispatchEvent(new dom.window.CompositionEvent('compositionend', {
        bubbles: true,
        data: '校',
    }));
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(submissions, []);
    assert.equal(bubbledSaveShortcuts, 0);
    assert.equal(content.getAttribute('contenteditable'), 'true');

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

test('commits a rendered GFM table cell directly from read-only mode', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '| Name | Value |',
        '| --- | ---: |',
        '| Score | 42 |',
    ].join('\n');
    const commits = [];
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        onCommitCorrection: async correction => commits.push(correction),
    });
    editor.setCorrectionState({
        enabled: false,
        blocks: [{
            id: 'table-1',
            type: 'table',
            from: 0,
            to: markdown.length,
            markdown,
        }],
        correctedBlockIDs: [],
    });
    const valueCell = document.querySelector(
        '.cm-mktero-table tbody td:last-child'
    );

    enterTableCellEditing(valueCell, dom.window);
    assert.equal(valueCell.getAttribute('contenteditable'), 'true');
    valueCell.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
    }));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(commits, []);
    assert.equal(valueCell.getAttribute('contenteditable'), 'true');
    valueCell.textContent = '43';
    valueCell.dispatchEvent(new dom.window.Event('input', {
        bubbles: true,
    }));
    valueCell.dispatchEvent(new dom.window.FocusEvent('blur'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(commits.length, 0);
    assert.equal(valueCell.getAttribute('contenteditable'), 'true');
    document.querySelector('.mktero-correction-editor-save').click();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(commits.length, 1);
    assert.equal(commits[0].blockID, 'table-1');
    assert.match(commits[0].replacementMarkdown, /\| Score \| 43 \|/);

    editor.destroy();
    dom.window.close();
});

test('keeps protected formula, citation, and annotation table cells read-only', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '| Kind | Value | Note |',
        '| --- | --- | --- |',
        '| Citation | $[2,10]$ | Editable citation note |',
        '| Formula | $x^2$ | Editable formula note |',
        '| Note | Annotated value | Editable annotation note |',
    ].join('\n');
    const citation = '$[2,10]$';
    const formula = '$x^2$';
    const annotated = 'Annotated value';
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        onCommitCorrection: async () => {},
    });
    editor.setCorrectionState({
        enabled: true,
        blocks: [{
            id: 'protected-table',
            type: 'table',
            from: 0,
            to: markdown.length,
            markdown,
            protectedRanges: [{
                from: markdown.indexOf(citation),
                to: markdown.indexOf(citation) + citation.length,
            }, {
                from: markdown.indexOf(formula),
                to: markdown.indexOf(formula) + formula.length,
            }, {
                from: markdown.indexOf(annotated),
                to: markdown.indexOf(annotated) + annotated.length,
                kind: 'annotation',
            }],
        }],
    });
    const citationCell = document.querySelector(
        '.cm-mktero-table tbody tr:first-child td:nth-child(2)'
    );
    const citationNote = document.querySelector(
        '.cm-mktero-table tbody tr:first-child td:nth-child(3)'
    );
    const formulaCell = document.querySelector(
        '.cm-mktero-table tbody tr:nth-child(2) td:nth-child(2)'
    );
    const annotationCell = document.querySelector(
        '.cm-mktero-table tbody tr:last-child td:nth-child(2)'
    );
    const annotationNote = document.querySelector(
        '.cm-mktero-table tbody tr:last-child td:nth-child(3)'
    );

    enterTableCellEditing(citationCell, dom.window);
    enterTableCellEditing(formulaCell, dom.window);
    enterTableCellEditing(annotationCell, dom.window);
    assert.equal(citationCell.getAttribute('contenteditable'), 'false');
    assert.equal(formulaCell.getAttribute('contenteditable'), 'false');
    assert.equal(annotationCell.getAttribute('contenteditable'), 'false');
    assert.equal(
        annotationCell.getAttribute('title'),
        'This text has an annotation. Delete the annotation before editing it.'
    );
    assert.equal(
        document.querySelector('.mktero-correction-editor-toolbar').hidden,
        true
    );

    enterTableCellEditing(citationNote, dom.window);
    assert.equal(citationNote.getAttribute('contenteditable'), 'true');
    assert.equal(
        document.querySelector('.mktero-correction-editor-toolbar').hidden,
        false
    );
    enterTableCellEditing(annotationNote, dom.window);
    assert.equal(annotationNote.getAttribute('contenteditable'), 'true');

    editor.destroy();
    dom.window.close();
});

test('edits escaped pipes and pads ragged GFM table rows', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '| Name | Value | Note |',
        '| --- | ---: | --- |',
        '| A \\| B | 42 |',
    ].join('\n');
    const commits = [];
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        onCommitCorrection: async correction => commits.push(correction),
    });
    editor.setCorrectionState({
        enabled: true,
        blocks: [{
            id: 'table-ragged',
            type: 'table',
            from: 0,
            to: markdown.length,
            markdown,
        }],
    });
    const cells = document.querySelectorAll('.cm-mktero-table tbody td');

    assert.equal(cells.length, 3);
    assert.equal(cells[0].textContent, 'A | B');
    enterTableCellEditing(cells[2], dom.window);
    cells[2].textContent = 'Added';
    cells[2].dispatchEvent(new dom.window.Event('input', {
        bubbles: true,
    }));
    document.querySelector('.mktero-correction-editor-save').click();
    await new Promise(resolve => setImmediate(resolve));

    assert.match(commits[0].replacementMarkdown, /\| A \\| B \| 42 \| Added \|/);
    editor.destroy();
    dom.window.close();
});

test('edits a captioned GFM table and restores its table block', async () => {
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
    const tableFrom = markdown.indexOf('| Measure');
    const commits = [];
    const restores = [];
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        onCommitCorrection: async correction => commits.push(correction),
        onRestoreCorrection: async blockID => restores.push(blockID),
    });
    editor.setCorrectionState({
        enabled: false,
        blocks: [{
            id: 'captioned-table',
            type: 'table',
            from: tableFrom,
            to: markdown.length,
            markdown: markdown.slice(tableFrom),
        }],
        correctedBlockIDs: ['captioned-table'],
    });
    assert.equal(
        document.querySelector('.cm-mktero-correction-marker'),
        null
    );
    assert.equal(
        document.querySelector('.cm-mktero-corrected-block'),
        null
    );

    editor.setCorrectionState({
        enabled: true,
        blocks: [{
            id: 'captioned-table',
            type: 'table',
            from: tableFrom,
            to: markdown.length,
            markdown: markdown.slice(tableFrom),
        }],
        correctedBlockIDs: ['captioned-table'],
    });
    const valueCell = document.querySelector(
        '.cm-mktero-table tbody td:last-child'
    );

    enterTableCellEditing(valueCell, dom.window);
    assert.equal(valueCell.getAttribute('contenteditable'), 'true');
    valueCell.textContent = '87.38';
    valueCell.dispatchEvent(new dom.window.Event('input', {
        bubbles: true,
    }));
    document.querySelector('.mktero-correction-editor-save').click();
    await new Promise(resolve => setImmediate(resolve));
    const restoreButton = document.querySelector(
        '.cm-mktero-correction-marker'
    );
    assert.equal(
        restoreButton.namespaceURI,
        'http://www.w3.org/1999/xhtml'
    );
    restoreButton.click();
    await new Promise(resolve => setImmediate(resolve));

    assert.match(commits[0].replacementMarkdown, /\| Valence \| 414\.55 \| 87\.38 \|/);
    assert.deepEqual(restores, ['captioned-table']);
    editor.destroy();
    dom.window.close();
});

test('keeps table cell input inert and restores the cell when saving fails', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '| Name | Value |',
        '| --- | --- |',
        '| Score | 42 |',
    ].join('\n');
    const errors = [];
    let attemptedCorrection;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        onCommitCorrection: async correction => {
            attemptedCorrection = correction;
            throw new Error('disk full');
        },
        onCorrectionError: error => errors.push(error.message),
    });
    editor.setCorrectionState({
        enabled: true,
        blocks: [{
            id: 'table-1',
            type: 'table',
            from: 0,
            to: markdown.length,
            markdown,
        }],
    });
    const valueCell = document.querySelector(
        '.cm-mktero-table tbody td:last-child'
    );

    enterTableCellEditing(valueCell, dom.window);
    valueCell.textContent = '<img src=x onerror=alert(1)>\n43';
    valueCell.dispatchEvent(new dom.window.Event('input', {
        bubbles: true,
    }));
    document.querySelector('.mktero-correction-editor-save').click();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(valueCell.querySelector('img'), null);
    assert.equal(valueCell.textContent, '<img src=x onerror=alert(1)>\n43');
    assert.equal(valueCell.getAttribute('contenteditable'), 'true');
    assert.doesNotMatch(attemptedCorrection.replacementMarkdown, /<img/i);
    assert.doesNotMatch(attemptedCorrection.replacementMarkdown, /\n43/);
    assert.match(
        attemptedCorrection.replacementMarkdown,
        /&lt;img src=x onerror=alert\(1\)&gt; 43/
    );
    assert.deepEqual(errors, ['disk full']);
    document.querySelector('.mktero-correction-editor-cancel').click();
    assert.equal(valueCell.textContent, '42');
    editor.destroy();
    dom.window.close();
});

test('does not open annotation actions while a table cell is being edited', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '| Name | Value |',
        '| --- | --- |',
        '| Score | 42 |',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        createMarkdownAnnotation: async annotation => annotation,
    });
    editor.setCorrectionState({
        enabled: true,
        blocks: [{
            id: 'table-1',
            type: 'table',
            from: 0,
            to: markdown.length,
            markdown,
        }],
    });
    const cell = document.querySelector('.cm-mktero-table tbody td:last-child');
    enterTableCellEditing(cell, dom.window);
    const range = document.createRange();
    range.selectNodeContents(cell);
    document.getSelection().addRange(range);

    cell.dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
    }));

    assert.equal(
        document.querySelector('.mktero-markdown-selection-actions'),
        null
    );
    editor.destroy();
    assert.equal(
        document.querySelector('.mktero-correction-editor-toolbar'),
        null
    );
    dom.window.close();
});

test('does not open a text correction while a table edit is active', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        'Intro text.',
        '',
        '| Name | Value |',
        '| --- | --- |',
        '| Score | 42 |',
    ].join('\n');
    const tableFrom = markdown.indexOf('| Name');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        onCommitCorrection: async () => {},
    });
    editor.setCorrectionState({
        enabled: false,
        blocks: [{
            id: 'paragraph-1',
            type: 'paragraph',
            from: 0,
            to: 'Intro text.'.length,
        }, {
            id: 'table-1',
            type: 'table',
            from: tableFrom,
            to: markdown.length,
        }],
    });
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    const content = document.querySelector('.cm-content');
    const cell = document.querySelector('.cm-mktero-table tbody td:last-child');
    enterTableCellEditing(cell, dom.window);
    assert.equal(cell.getAttribute('contenteditable'), 'true');

    view.posAtCoords = () => 1;
    content.dispatchEvent(new dom.window.MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));
    assert.equal(content.getAttribute('contenteditable'), 'false');
    assert.equal(cell.getAttribute('contenteditable'), 'true');

    document.querySelector('.mktero-correction-editor-cancel').click();
    content.dispatchEvent(new dom.window.MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));
    assert.equal(content.getAttribute('contenteditable'), 'true');

    editor.destroy();
    dom.window.close();
});

test('cancels an active table edit when the document is reset', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '| Name | Value |',
        '| --- | --- |',
        '| Score | 42 |',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        onCommitCorrection: async () => {},
    });
    editor.setCorrectionState({
        enabled: true,
        blocks: [{
            id: 'table-1',
            type: 'table',
            from: 0,
            to: markdown.length,
            markdown,
        }],
    });
    const valueCell = document.querySelector(
        '.cm-mktero-table tbody td:last-child'
    );

    enterTableCellEditing(valueCell, dom.window);
    assert.equal(valueCell.getAttribute('contenteditable'), 'true');
    editor.setDocument({ markdown });

    assert.equal(valueCell.getAttribute('contenteditable'), 'false');
    assert.equal(
        document.querySelector('.mktero-correction-editor-toolbar').hidden,
        true
    );

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

test('renders citations inside rendered tables as interactive references', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '# Paper',
        '',
        '| Model |',
        '| --- |',
        '| Zhang et al. [16] |',
        '',
        '<table><tr><td>Kong et al. [41]</td></tr></table>',
        '',
        '## References',
        '',
        '[16] H. Zhang. Pedal estimation. 2025.',
        '[41] Q. Kong. Piano transcription. 2021.',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });

    const markdownCitation = document.querySelector(
        '.cm-mktero-table .cm-mktero-citation'
    );
    const htmlCitation = document.querySelector(
        '.cm-mktero-html-table .cm-mktero-citation'
    );
    assert.equal(markdownCitation?.textContent, '16');
    assert.equal(htmlCitation?.textContent, '41');
    htmlCitation?.dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    assert.match(
        document.querySelector('.mktero-citation-popup')?.textContent || '',
        /Q\. Kong\. Piano transcription\. 2021\./
    );
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('renders table citations in bilingual documents with numbered references', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '# MUSIC-JEPA',
        '',
        '## 4. RESULTS',
        '',
        '<table><tr><td>Kong et al. [41]</td></tr></table>',
        '',
        '## 6. REFERENCES',
        '',
        '## 6. 参考文献',
        '',
        '[41] Q. Kong. Piano transcription. 2021.',
        '',
        '[41] Q. Kong。钢琴转录。2021。',
        '',
        '[42] Y. Yan. Automatic transcription. 2024.',
        '',
        '[42] Y. Yan。自动转录。2024。',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });

    const citation = document.querySelector(
        '.cm-mktero-html-table .cm-mktero-citation'
    );
    assert.equal(citation?.textContent, '41');
    citation?.dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    assert.match(
        document.querySelector('.mktero-citation-popup')?.textContent || '',
        /Q\. Kong/
    );

    editor.destroy();
    dom.window.close();
});

test('attaches a trailing MinerU table caption as the table header', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const captionText = [
        'Table 1. Model selection criteria for stages I and II; number of',
        'parameters (N. Par.), root mean square error (RMSE), concordance',
        'correlation coefficient (CCC), Pearson correlation coefficient (r)',
        'between fitted and predicted test data, and Bayesian information',
        'criterion (BIC).',
    ].join(' ');
    const markdown = [
        '<table><tr><td>Model</td><td>BIC</td></tr></table>',
        '',
        captionText,
        '',
        'Following paragraph.',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });
    const table = document.querySelector('.cm-mktero-html-table table');

    assert.equal(table?.querySelector('caption')?.textContent, captionText);
    assert.equal(
        table?.querySelector('.mktero-table-label')?.textContent,
        'Table 1.'
    );
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('recovers adjacent table and figure captions assigned to the same image', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const tableCaption = [
        'Table 2. Histogram of BMI and body mass index (BMI)',
        'classification.',
    ].join(' ');
    const figureCaption = [
        'Figure 1. Histogram of Body Mass Index (BMI)',
        'classification.',
    ].join(' ');
    const markdown = [
        '<table><tr><td>Category</td><td>BMI</td></tr></table>',
        '',
        `![${tableCaption}](images/histogram.jpg)`,
        figureCaption,
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => 'blob:mktero-histogram',
    });

    assert.equal(
        document.querySelector('.cm-mktero-html-table caption')?.textContent,
        tableCaption
    );
    assert.equal(
        document.querySelector('.mktero-figure figcaption')?.textContent,
        figureCaption
    );
    assert.equal(
        document.querySelector('.mktero-figure-label')?.textContent,
        'Figure 1.'
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

test('leaves non-repository GitHub URLs as ordinary links', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: 'Docs: https://github.com/owner/repo/wiki',
        resolveImageURL: () => null,
        openLink: () => {},
    });

    assert.equal(document.querySelector('.cm-mktero-github-link'), null);
    assert.equal(
        document.querySelector('.cm-mktero-link')?.textContent,
        'https://github.com/owner/repo/wiki'
    );

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

test('renders CJK prose beside dollar-wrapped numeric citations', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '# 论文',
        '',
        '结果$[55, 56, 58]$和结论$[56, 60, 77]$，仍见$[130]$。',
        '',
        '## 参考文献',
        '',
        '[55] 第五十五项研究。',
        '[56] 第五十六项研究。',
        '[58] 第五十八项研究。',
        '[60] 第六十项研究。',
        '[77] 第七十七项研究。',
        '[130] 第一百三十项研究。',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });

    assert.ok(renderedLineTexts(document).includes(
        '结果[55, 56, 58]和结论[56, 60, 77]，仍见[130]。'
    ));
    const citations = [...document.querySelectorAll('.cm-mktero-citation')];
    assert.deepEqual(
        citations.map(citation => citation.textContent),
        ['55', '56', '58', '56', '60', '77', '130']
    );
    assert.equal(document.querySelector('.cm-mktero-math'), null);
    citations[0].dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    assert.match(
        document.querySelector('.mktero-citation-popup')?.textContent || '',
        /第五十五项研究。/
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

test('hovers LaTeX superscript citations with bare numbered references', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '# Paper',
        '',
        '## INTRODUCTION',
        '',
        'WHO published guidance for 2018-2030 $^{1}$ and later evidence $^{2}$.',
        '',
        '## REFERENCES',
        '',
        '1 World Health Organization. Global action plan. 2018.',
        '',
        '2 World Health Organization. Global recommendations. 2020.',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });

    const citation = document.querySelector('.cm-mktero-citation');
    assert.equal(citation?.textContent, '1');
    citation?.dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    assert.match(
        document.querySelector('.mktero-citation-popup')?.textContent || '',
        /World Health Organization\. Global action plan\. 2018\./
    );

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
    const rows = [...document.querySelectorAll('.mktero-citation-popup-item')];
    const targets = [...document.querySelectorAll('.mktero-citation-popup-primary')];
    assert.equal(rows.length, 2);
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
        ...document.querySelectorAll('.mktero-citation-popup-primary'),
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

test('returns to the citation origin after jumping to its reference', () => {
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
    const availability = [];
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        onNavigationBackChange: available => availability.push(available),
    });
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    const referenceOffset = markdown.indexOf('[1] Alpha');
    view.lineBlockAt = position => {
        assert.equal(position, referenceOffset);
        return { top: 640 };
    };
    view.requestMeasure = request => {
        if (request?.read) request.write?.(request.read(view), view);
    };
    view.scrollDOM.scrollTop = 128;

    document.querySelector('.cm-mktero-citation').dispatchEvent(
        new dom.window.MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            button: 0,
        })
    );

    assert.deepEqual(availability, [true]);
    assert.equal(view.scrollDOM.scrollTop, 640);
    assert.equal(editor.returnToCitation(), true);
    assert.equal(view.scrollDOM.scrollTop, 128);
    assert.deepEqual(availability, [true, false]);
    assert.equal(editor.returnToCitation(), false);

    editor.destroy();
    dom.window.close();
});

test('clears the citation return point when the Markdown document changes', () => {
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
    view.lineBlockAt = () => ({ top: 640 });
    view.requestMeasure = request => {
        if (request?.read) request.write?.(request.read(view), view);
    };

    document.querySelector('.cm-mktero-citation').click();
    editor.setMarkdown('# Replaced');

    assert.equal(editor.returnToCitation(), false);

    editor.destroy();
    dom.window.close();
});

test('returns to a citation with the reader back shortcut', () => {
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
    view.lineBlockAt = () => ({ top: 640 });
    view.requestMeasure = request => {
        if (request?.read) request.write?.(request.read(view), view);
    };
    view.scrollDOM.scrollTop = 128;
    document.querySelector('.cm-mktero-citation').click();

    const shortcut = new dom.window.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'ArrowLeft',
        altKey: true,
    });
    document.querySelector('.cm-content').dispatchEvent(shortcut);

    assert.equal(shortcut.defaultPrevented, true);
    assert.equal(view.scrollDOM.scrollTop, 128);
    assert.equal(editor.returnToCitation(), false);

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

test('packs consecutive uncaptioned images and isolated panel letters into one figure', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = [
        '![](images/a.png)',
        '',
        '',
        '![](images/b.png)',
        '',
        'C',
        '',
        '![](images/c.png)',
        '',
        '![](images/d.png)',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: path => `blob:mktero-${path}`,
        openLink: () => {},
    });

    const figure = document.querySelector('.mktero-figure-group-horizontal');
    assert.equal(figure?.querySelectorAll('img').length, 4);
    assert.equal(
        figure?.querySelector('.mktero-figure-panel-label')?.textContent,
        'C'
    );
    assert.equal(document.querySelectorAll('.cm-mktero-image').length, 1);
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

test('attaches a trailing caption to one composite figure with a panel label', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const caption = String.raw`Figure 3. (a) Trace plots of Markov chains and `
        + String.raw`(b) Markov chain Monte Carlo (MCMC) draws from the posterior `
        + String.raw`distribution of the parameters $\beta_{0}, \theta_{0}, \pi, `
        + String.raw`\sigma_{\eta}, \sigma_{w}$ , and $\sigma_{\epsilon}$ based on `
        + 'a sample of length 3000.';
    const markdown = [
        '![](images/posterior.jpg)  ',
        '(b) Draws from posterior distribution  ',
        caption,
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => 'blob:mktero-posterior',
    });

    assert.equal(
        document.querySelector('.mktero-figure-label')?.textContent,
        'Figure 3.'
    );
    assert.equal(
        document.querySelector('.mktero-figure-panel-label')?.textContent,
        '(b) Draws from posterior distribution'
    );
    assert.equal(
        document.querySelector('.mktero-figure figcaption')
            ?.textContent.startsWith('Figure 3.'),
        true
    );
    assert.equal(editor.getMarkdown(), markdown);

    editor.destroy();
    dom.window.close();
});

test('renders marked vertical MinerU panels as one figure group', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const captionText = 'Fig. 5 Ovulation prediction (a) sensitivities and '
        + '(b) positive predictive values (PPV).';
    const markdown = [
        '(A)   ',
        '![](images/panel-a.jpg)   ',
        '(B)',
        '',
        `![${captionText}](images/panel-b.jpg)`,
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: path => `blob:mktero-${path}`,
        openLink: () => {},
    });

    const figure = document.querySelector('.mktero-figure-group-vertical');
    assert.equal(document.querySelectorAll('.mktero-figure-group').length, 1);
    assert.equal(figure?.querySelectorAll('img').length, 2);
    assert.deepEqual(
        [...figure.querySelectorAll('.mktero-figure-panel-label-before')]
            .map(label => label.textContent),
        ['(A)', '(B)']
    );
    assert.equal(figure?.querySelector('figcaption')?.textContent, captionText);
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

test('does not start correction from the image preview stage', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'Intro\n\n![Figure](images/figure.png)';
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => 'blob:mktero-preview-figure',
        onCommitCorrection: async () => {},
    });
    editor.setCorrectionState({
        enabled: false,
        blocks: [{
            id: 'paragraph-1',
            type: 'paragraph',
            from: 0,
            to: 'Intro'.length,
        }],
    });
    const renderedImage = document.querySelector('.cm-mktero-image img');
    renderedImage.dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));
    const stage = document.querySelector('.mktero-image-preview-stage');
    assert.ok(stage);

    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    view.posAtCoords = () => 0;
    stage.dispatchEvent(new dom.window.MouseEvent('dblclick', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));

    assert.equal(
        document.querySelector('.cm-content').getAttribute('contenteditable'),
        'false'
    );

    editor.destroy();
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

test('places translation last, expands results below, and translates again', async () => {
    const dom = new JSDOM('<!doctype html><div id="popup-parent"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const parent = document.querySelector('#popup-parent');
    const anchor = document.createElement('span');
    parent.appendChild(anchor);
    let resolveTranslation;
    let emitTranslationDelta;
    let translationCalls = 0;
    let copiedText;
    const popup = createAnnotationPopup(parent, {
        translateSelection: (text, selectionContext, { onTextDelta } = {}) => {
            translationCalls += 1;
            emitTranslationDelta = onTextDelta;
            assert.equal(text, 'Selected **text**');
            assert.deepEqual(selectionContext, { side: 'source' });
            if (translationCalls === 1) {
                onTextDelta('<b>Trans', '<b>Trans');
                onTextDelta('lated</b>', '<b>Translated</b>');
            }
            else {
                onTextDelta('Re', 'Re');
            }
            return new Promise(resolve => {
                resolveTranslation = resolve;
            });
        },
        copySelectionTranslation: text => {
            copiedText = text;
        },
        copySourcedMarkdown: async () => {},
        openSourceLocation: async () => {},
        createMarkdownAnnotation: async () => {},
    });

    popup.openSelection({
        anchor,
        selection: { text: 'Selected **text**' },
        selectionContext: { side: 'source' },
        copyTarget: { kind: 'selection' },
        sourceLocation: { pageIndex: 0 },
        canCopySource: true,
    });

    assert.equal(translationCalls, 0);
    const actions = parent.querySelector('.mktero-markdown-selection-actions');
    const toolbar = actions.querySelector(
        ':scope > .mktero-markdown-selection-toolbar'
    );
    assert.ok(toolbar);
    assert.deepEqual(
        [...toolbar.children]
            .filter(element => element.matches('button'))
            .map(element => element.dataset.action),
        [
            'add-note',
            'view-in-pdf',
            'copy-with-source',
            'translate-selection',
        ]
    );
    const translationPanel = actions.querySelector(
        '.mktero-selection-translation'
    );
    assert.equal(toolbar.nextElementSibling, translationPanel);
    assert.equal(translationPanel.hidden, true);
    const translateButton = actions.querySelector(
        '[data-action="translate-selection"]'
    );
    assert.ok(translateButton);
    assert.equal(
        actions.querySelector('[data-action="cancel-selection-translation"]'),
        null
    );

    translateButton.click();
    assert.equal(translationCalls, 1);
    assert.equal(actions.dataset.translationStatus, 'loading');
    assert.equal(translateButton.hidden, true);
    assert.equal(translationPanel.hidden, false);
    assert.ok(actions.querySelector('[data-action="cancel-selection-translation"]'));
    const result = actions.querySelector('.mktero-selection-translation-result');
    assert.equal(result.hidden, false);
    assert.equal(result.textContent, '<b>Translated</b>');
    assert.equal(result.querySelector('b'), null);

    resolveTranslation({ text: '<b>Translated</b>' });
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(actions.dataset.translationStatus, 'success');
    assert.equal(translateButton.hidden, true);
    assert.equal(result.textContent, '<b>Translated</b>');
    assert.equal(result.querySelector('b'), null);
    emitTranslationDelta(' late', 'Late streamed text');
    assert.equal(result.textContent, '<b>Translated</b>');
    assert.deepEqual(
        [...translationPanel.querySelectorAll(
            '.mktero-selection-translation-actions button'
        )].map(element => element.dataset.action),
        [
            'retranslate-selection',
            'copy-selection-translation',
        ]
    );
    const retranslateButton = actions.querySelector(
        '[data-action="retranslate-selection"]'
    );
    const copyButton = actions.querySelector(
        '[data-action="copy-selection-translation"]'
    );
    assert.ok(retranslateButton);
    assert.equal(
        retranslateButton.getAttribute('aria-label'),
        'Translate selection again'
    );
    assert.ok(copyButton);
    copyButton.click();
    assert.equal(copiedText, '<b>Translated</b>');

    retranslateButton.click();
    assert.equal(translationCalls, 2);
    assert.equal(actions.dataset.translationStatus, 'loading');
    assert.equal(result.hidden, false);
    assert.equal(result.textContent, 'Re');
    assert.ok(actions.querySelector(
        '[data-action="cancel-selection-translation"]'
    ));

    resolveTranslation({ text: 'Retranslated' });
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(actions.dataset.translationStatus, 'success');
    assert.equal(result.textContent, 'Retranslated');
    actions.querySelector('[data-action="copy-selection-translation"]').click();
    assert.equal(copiedText, 'Retranslated');

    popup.destroy();
    dom.window.close();
});

test('automatically translates a stable Markdown selection once after 250ms', async () => {
    const dom = new JSDOM('<!doctype html><div id="popup-parent"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const parent = document.querySelector('#popup-parent');
    const anchor = document.createElement('span');
    parent.appendChild(anchor);
    const scheduled = [];
    const originalSetTimeout = dom.window.setTimeout;
    const originalClearTimeout = dom.window.clearTimeout;
    let nextTimerID = 1;
    dom.window.setTimeout = (callback, delay) => {
        const timer = { callback, delay, id: nextTimerID++ };
        scheduled.push(timer);
        return timer.id;
    };
    dom.window.clearTimeout = timerID => {
        const index = scheduled.findIndex(timer => timer.id === timerID);
        if (index >= 0) scheduled.splice(index, 1);
    };
    let translationCalls = 0;
    let resolveTranslation;
    let cancellations = 0;
    const popup = createAnnotationPopup(parent, {
        shouldAutoTranslateSelection: () => true,
        translateSelection: () => {
            translationCalls += 1;
            return new Promise(resolve => {
                resolveTranslation = resolve;
            });
        },
        cancelSelectionTranslation: () => {
            cancellations += 1;
        },
    });

    popup.openSelection({
        anchor,
        selection: { text: 'Stable selection' },
        selectionContext: { side: 'source' },
    });

    assert.equal(translationCalls, 0);
    assert.equal(scheduled.filter(timer => timer.delay === 250).length, 1);
    scheduled.find(timer => timer.delay === 250).callback();
    assert.equal(translationCalls, 1);
    assert.equal(scheduled.filter(timer => timer.delay === 250).length, 0);

    popup.close();
    assert.equal(cancellations, 1);
    resolveTranslation({ text: 'Translated' });
    await Promise.resolve();

    dom.window.setTimeout = originalSetTimeout;
    dom.window.clearTimeout = originalClearTimeout;
    dom.window.close();
});

test('shows a localized error when a selection exceeds the translation limit', async () => {
    const dom = new JSDOM('<!doctype html><div id="popup-parent"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const parent = document.querySelector('#popup-parent');
    const anchor = document.createElement('span');
    parent.appendChild(anchor);
    let emitTranslationDelta;
    const popup = createAnnotationPopup(parent, {
        translateSelection: async (_text, _context, { onTextDelta } = {}) => {
            emitTranslationDelta = onTextDelta;
            onTextDelta('Partial', 'Partial translation');
            const error = new Error('too large');
            error.code = 'AI_INPUT_TOO_LARGE';
            throw error;
        },
    });

    popup.openSelection({
        anchor,
        selection: { text: 'A long selection' },
        selectionContext: { side: 'source' },
    });
    parent.querySelector('[data-action="translate-selection"]').click();
    await Promise.resolve();
    await Promise.resolve();

    const actions = parent.querySelector('.mktero-markdown-selection-actions');
    assert.equal(actions.dataset.translationStatus, 'error');
    const result = actions.querySelector('.mktero-selection-translation-result');
    assert.equal(result.hidden, true);
    assert.equal(result.textContent, '');
    emitTranslationDelta(' late', 'Late partial translation');
    assert.equal(result.hidden, true);
    assert.equal(result.textContent, '');
    assert.equal(
        actions.querySelector('.mktero-selection-translation-error').textContent,
        'Select a shorter passage and try again.'
    );

    popup.destroy();
    dom.window.close();
});

test('clears streamed selection text on cancellation and ignores late deltas', () => {
    const dom = new JSDOM('<!doctype html><div id="popup-parent"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const parent = document.querySelector('#popup-parent');
    const anchor = document.createElement('span');
    parent.appendChild(anchor);
    let onTextDelta;
    let cancellations = 0;
    const popup = createAnnotationPopup(parent, {
        translateSelection: (_text, _context, options) => {
            onTextDelta = options.onTextDelta;
            return new Promise(() => {});
        },
        cancelSelectionTranslation: () => {
            cancellations += 1;
        },
    });

    popup.openSelection({
        anchor,
        selection: { text: 'Selected text' },
    });
    const actions = parent.querySelector('.mktero-markdown-selection-actions');
    actions.querySelector('[data-action="translate-selection"]').click();
    onTextDelta('Partial', 'Partial translation');

    const result = actions.querySelector('.mktero-selection-translation-result');
    assert.equal(result.hidden, false);
    assert.equal(result.textContent, 'Partial translation');

    actions.querySelector('[data-action="cancel-selection-translation"]').click();
    assert.equal(cancellations, 1);
    assert.equal(actions.dataset.translationStatus, 'idle');
    assert.equal(result.textContent, '');
    onTextDelta(' late', 'Partial translation late');
    assert.equal(result.hidden, true);
    assert.equal(result.textContent, '');

    popup.destroy();
    dom.window.close();
});

test('does not let a late selection translation replace a newer popup state', async () => {
    const dom = new JSDOM('<!doctype html><div id="popup-parent"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const parent = document.querySelector('#popup-parent');
    const firstAnchor = document.createElement('span');
    const secondAnchor = document.createElement('span');
    parent.append(firstAnchor, secondAnchor);
    const resolves = [];
    const deltas = [];
    let cancellations = 0;
    const popup = createAnnotationPopup(parent, {
        translateSelection: (_text, _context, { onTextDelta } = {}) => {
            deltas.push(onTextDelta);
            return new Promise(resolve => resolves.push(resolve));
        },
        cancelSelectionTranslation: () => {
            cancellations += 1;
        },
    });

    popup.openSelection({
        anchor: firstAnchor,
        selection: { text: 'First' },
    });
    parent.querySelector('[data-action="translate-selection"]').click();
    popup.openSelection({
        anchor: secondAnchor,
        selection: { text: 'Second' },
    });
    parent.querySelector('[data-action="translate-selection"]').click();
    assert.equal(cancellations, 1);
    assert.equal(resolves.length, 2);

    deltas[0]('Stale', 'Stale first stream');
    const currentResult = parent.querySelector(
        '.mktero-selection-translation-result'
    );
    assert.equal(currentResult.hidden, true);
    assert.equal(currentResult.textContent, '');
    deltas[1]('Current', 'Current second stream');
    assert.equal(currentResult.hidden, false);
    assert.equal(currentResult.textContent, 'Current second stream');

    resolves[0]({ text: 'Stale first result' });
    await Promise.resolve();
    assert.equal(
        currentResult.textContent,
        'Current second stream'
    );
    assert.equal(
        parent.querySelector('.mktero-markdown-selection-actions')
            .dataset.translationStatus,
        'loading'
    );

    resolves[1]({ text: 'Current second result' });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(
        parent.querySelector('.mktero-selection-translation-result').textContent,
        'Current second result'
    );

    popup.destroy();
    dom.window.close();
});

test('allows annotations only from original bilingual selections', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'AI original.\n\nAI translated.';
    const created = [];
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
        createMarkdownAnnotation: async (annotation, selectionContext) => {
            created.push({ annotation, selectionContext });
            return annotation;
        },
    });
    editor.setDocument({
        markdown,
        sourceActionRanges: [{ from: 0, to: 12 }, {
            from: -1,
            to: Number.MAX_SAFE_INTEGER,
        }],
        translationPairs: [{
            id: 'translation-0',
            sourceFrom: null,
            sourceTo: null,
            translatedFrom: 14,
            translatedTo: markdown.length,
        }],
    });
    const original = textNodeContaining(
        document.querySelector('.cm-content'),
        'AI original.'
    );
    const translated = textNodeContaining(
        document.querySelector('.cm-content'),
        'AI translated.'
    );
    const selection = document.getSelection();
    const select = (start, startOffset, end, endOffset) => {
        const range = document.createRange();
        range.setStart(start, startOffset);
        range.setEnd(end, endOffset);
        selection.removeAllRanges();
        selection.addRange(range);
        end.parentElement.dispatchEvent(new dom.window.MouseEvent('mouseup', {
            bubbles: true,
            button: 0,
        }));
    };

    select(translated, 0, translated, 2);
    assert.equal(
        document.querySelector('.mktero-markdown-selection-actions'),
        null
    );

    select(original, 0, translated, translated.textContent.length);
    assert.equal(
        document.querySelector('.mktero-markdown-selection-actions'),
        null
    );

    select(original, 0, original, 2);
    const actions = document.querySelector('.mktero-markdown-selection-actions');
    assert.ok(actions);
    actions.querySelector('[data-color="#ffd400"]').click();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(created.length, 1);
    assert.equal(created[0].annotation.text, 'AI');
    assert.deepEqual(created[0].selectionContext, { side: 'source' });

    editor.destroy();
    dom.window.close();
});

test('passes selection translation callbacks and bounded raw-source context', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const prefix = Array.from({ length: 10 }, () => 'P'.repeat(100))
        .join('\n');
    const selectedText = 'Selected text';
    const suffix = Array.from({ length: 10 }, () => 'S'.repeat(100))
        .join('\n');
    const markdown = `${prefix}${selectedText}${suffix}`;
    const calls = [];
    let cancellations = 0;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
        translateSelection: async (
            text,
            selectionContext,
            { onTextDelta } = {},
        ) => {
            calls.push({ text, selectionContext });
            onTextDelta('Streamed ', 'Streamed ');
            onTextDelta('selection', 'Streamed selection');
            return { text: 'Translated selection' };
        },
        cancelSelectionTranslation: () => {
            cancellations += 1;
        },
        copySelectionTranslation: () => {},
    });
    editor.setDocument({ markdown });

    const text = textNodeContaining(
        document.querySelector('.cm-content'),
        selectedText
    );
    const range = document.createRange();
    const selectedOffset = text.textContent.indexOf(selectedText);
    range.setStart(text, selectedOffset);
    range.setEnd(text, selectedOffset + selectedText.length);
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);
    text.parentElement.dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
    }));

    const actions = document.querySelector(
        '.mktero-markdown-selection-actions'
    );
    assert.ok(actions);
    actions.querySelector('[data-action="translate-selection"]').click();
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(calls, [{
        text: selectedText,
        selectionContext: {
            side: 'source',
            translationContext: markdown.slice(
                Math.max(0, markdown.indexOf(selectedText) - 800),
                markdown.indexOf(selectedText) + selectedText.length + 800
            ),
        },
    }]);
    assert.equal(
        actions.querySelector('.mktero-selection-translation-result').textContent,
        'Translated selection'
    );
    assert.equal(cancellations, 0);

    editor.destroy();
    dom.window.close();
});

test('offers selection translation only on source text in supported views', () => {
    const createEditor = ({ markdown, sourceActionRanges, translationPairs, calls }) => {
        const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
            pretendToBeVisual: true,
        });
        const { document } = dom.window;
        const editor = createInlineMarkdownEditor({
            parent: document.querySelector('#editor'),
            initialMarkdown: '',
            translateSelection: () => {
                calls.push(true);
                return Promise.resolve({ text: 'Translated' });
            },
        });
        editor.setDocument({
            markdown,
            sourceActionRanges,
            translationPairs,
        });
        return { dom, document, editor };
    };
    const select = (document, dom, text) => {
        const node = textNodeContaining(
            document.querySelector('.cm-content'),
            text
        );
        const range = document.createRange();
        range.selectNodeContents(node);
        document.getSelection().removeAllRanges();
        document.getSelection().addRange(range);
        node.parentElement.dispatchEvent(new dom.window.MouseEvent('mouseup', {
            bubbles: true,
            button: 0,
        }));
    };

    const originalCalls = [];
    const original = createEditor({
        markdown: 'Original text.',
        sourceActionRanges: null,
        translationPairs: [],
        calls: originalCalls,
    });
    select(original.document, original.dom, 'Original text.');
    assert.ok(original.document.querySelector(
        '[data-action="translate-selection"]'
    ));
    original.editor.destroy();
    original.dom.window.close();

    const source = 'Original text.';
    const translated = 'Translated text.';
    const bilingualCalls = [];
    const bilingual = createEditor({
        markdown: `${source}\n\n${translated}`,
        sourceActionRanges: [{ from: 0, to: source.length }],
        translationPairs: [{
            id: 'translation-0',
            sourceFrom: 0,
            sourceTo: source.length,
            translatedFrom: source.length + 2,
            translatedTo: source.length + 2 + translated.length,
        }],
        calls: bilingualCalls,
    });
    select(bilingual.document, bilingual.dom, translated);
    assert.equal(
        bilingual.document.querySelector('[data-action="translate-selection"]'),
        null
    );
    select(bilingual.document, bilingual.dom, source);
    assert.ok(bilingual.document.querySelector(
        '[data-action="translate-selection"]'
    ));
    bilingual.editor.destroy();
    bilingual.dom.window.close();

    const translationCalls = [];
    const translation = createEditor({
        markdown: translated,
        sourceActionRanges: [],
        translationPairs: [],
        calls: translationCalls,
    });
    select(translation.document, translation.dom, translated);
    assert.equal(
        translation.document.querySelector('.mktero-markdown-selection-actions'),
        null
    );
    assert.deepEqual(translationCalls, []);
    translation.editor.destroy();
    translation.dom.window.close();
});

test('does not create duplicate automatic selection translations for repeated mouseup', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const scheduled = [];
    const originalSetTimeout = dom.window.setTimeout;
    const originalClearTimeout = dom.window.clearTimeout;
    let nextTimerID = 1;
    dom.window.setTimeout = (callback, delay) => {
        const timer = { callback, delay, id: nextTimerID++ };
        scheduled.push(timer);
        return timer.id;
    };
    dom.window.clearTimeout = timerID => {
        const index = scheduled.findIndex(timer => timer.id === timerID);
        if (index >= 0) scheduled.splice(index, 1);
    };
    let calls = 0;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: 'Repeat this selection.',
        shouldAutoTranslateSelection: () => true,
        translateSelection: () => {
            calls += 1;
            return new Promise(() => {});
        },
    });
    const line = document.querySelector('.cm-line');
    const range = document.createRange();
    range.selectNodeContents(line);
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);

    const dispatchMouseup = () => line.dispatchEvent(new dom.window.MouseEvent(
        'mouseup',
        { bubbles: true, button: 0 }
    ));
    dispatchMouseup();
    dispatchMouseup();

    assert.equal(
        scheduled.filter(timer => timer.delay === 250).length,
        1
    );
    scheduled.find(timer => timer.delay === 250).callback();
    assert.equal(calls, 1);

    editor.destroy();
    dom.window.setTimeout = originalSetTimeout;
    dom.window.clearTimeout = originalClearTimeout;
    dom.window.close();
});

test('closes selection actions when clicking outside the editor', () => {
    const dom = new JSDOM(
        '<!doctype html><button id="outside">Outside</button><div id="editor"></div>',
        { pretendToBeVisual: true }
    );
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: 'Select this Markdown text.',
    });
    const line = document.querySelector('.cm-line');
    const range = document.createRange();
    range.selectNodeContents(line);
    document.getSelection().addRange(range);
    line.dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
    }));
    assert.ok(document.querySelector('.mktero-markdown-selection-actions'));

    document.querySelector('.mktero-annotation-color-button').dispatchEvent(
        new dom.window.MouseEvent('mousedown', {
            bubbles: true,
            button: 0,
        })
    );
    assert.ok(document.querySelector('.mktero-markdown-selection-actions'));

    const retargetedPopupClick = new dom.window.MouseEvent('mousedown', {
        bubbles: true,
        button: 0,
    });
    Object.defineProperty(retargetedPopupClick, 'composedPath', {
        value: () => [
            document.querySelector('.mktero-annotation-color-button'),
            document,
            dom.window,
        ],
    });
    document.querySelector('#outside').dispatchEvent(retargetedPopupClick);
    assert.ok(document.querySelector('.mktero-markdown-selection-actions'));

    document.querySelector('#outside').dispatchEvent(
        new dom.window.MouseEvent('mousedown', {
            bubbles: true,
            button: 0,
        })
    );

    assert.equal(
        document.querySelector('.mktero-markdown-selection-actions'),
        null
    );

    editor.destroy();
    dom.window.close();
});

test('keeps shadow selection actions open on a retargeted popup press', () => {
    const dom = new JSDOM(
        '<!doctype html><button id="outside">Outside</button><div id="host"></div>',
        {
            pretendToBeVisual: true,
        }
    );
    const { document } = dom.window;
    const host = document.querySelector('#host');
    const shadow = host.attachShadow({ mode: 'open' });
    const parent = document.createElement('div');
    shadow.appendChild(parent);
    const editor = createInlineMarkdownEditor({
        document,
        parent,
        initialMarkdown: 'Select this Markdown text.',
    });
    const line = shadow.querySelector('.cm-line');
    const range = document.createRange();
    range.selectNodeContents(line);
    const originalGetSelection = document.getSelection;
    document.getSelection = () => ({
        anchorNode: range.startContainer,
        anchorOffset: range.startOffset,
        collapse() {},
        extend() {},
        focusNode: range.endContainer,
        focusOffset: range.endOffset,
        getRangeAt: () => range,
        isCollapsed: false,
        removeAllRanges() {},
        rangeCount: 1,
        toString: () => range.toString(),
    });
    line.dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true,
        composed: true,
        button: 0,
    }));
    assert.ok(shadow.querySelector('.mktero-markdown-selection-actions'));

    const press = new dom.window.MouseEvent('mousedown', {
        bubbles: true,
        composed: true,
        button: 0,
    });
    Object.defineProperty(press, 'composedPath', {
        value: () => [host, document, dom.window],
    });
    shadow.querySelector('.mktero-annotation-color-button')
        .dispatchEvent(press);

    assert.ok(shadow.querySelector('.mktero-markdown-selection-actions'));

    document.querySelector('#outside').dispatchEvent(
        new dom.window.MouseEvent('mousedown', {
            bubbles: true,
            button: 0,
        })
    );
    assert.equal(
        shadow.querySelector('.mktero-markdown-selection-actions'),
        null
    );

    document.getSelection = originalGetSelection;
    editor.destroy();
    dom.window.close();
});

test('closes unfocused selection actions with Escape', () => {
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
    document.getSelection().addRange(range);
    line.dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
    }));
    assert.ok(document.querySelector('.mktero-markdown-selection-actions'));

    const escape = new dom.window.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Escape',
    });
    document.dispatchEvent(escape);

    assert.equal(escape.defaultPrevented, true);
    assert.equal(
        document.querySelector('.mktero-markdown-selection-actions'),
        null
    );

    editor.destroy();
    dom.window.close();
});

test('keeps selection actions stable while crossing hoverable content', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const highlightedText = 'Existing highlighted sentence.';
    const selectedText = 'New selected sentence.';
    const markdown = [
        `${highlightedText} Evidence [1]. ${selectedText}`,
        '',
        '## References',
        '',
        '[1] Alpha A. Study. 2024.',
    ].join('\n');
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
    });
    editor.setDocument({
        markdown,
        annotationOverlay: {
            matched: [{
                id: 'PDF0001',
                source: 'zotero',
                type: 'highlight',
                text: highlightedText,
                comment: '',
                color: '#ffd400',
                ranges: [{ from: 0, to: highlightedText.length }],
            }],
            unmatched: [],
        },
    });
    const line = [...document.querySelectorAll('.cm-line')].find(
        candidate => candidate.textContent.includes(selectedText)
    );
    const selectedNode = textNodeContaining(line, selectedText);
    const range = document.createRange();
    range.selectNodeContents(selectedNode);
    document.getSelection().addRange(range);

    line.dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
    }));
    assert.ok(document.querySelector('.mktero-markdown-selection-actions'));
    const scheduled = new Map();
    const originalSetTimeout = dom.window.setTimeout;
    const originalClearTimeout = dom.window.clearTimeout;
    let nextTimerID = 1;
    dom.window.setTimeout = (callback, delay) => {
        const timerID = nextTimerID++;
        scheduled.set(timerID, { callback, delay });
        return timerID;
    };
    dom.window.clearTimeout = timerID => scheduled.delete(timerID);

    const annotation = document.querySelector('.cm-mktero-pdf-annotation');
    annotation.dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    for (const timer of [...scheduled.values()]) timer.callback();

    assert.ok(document.querySelector('.mktero-markdown-selection-actions'));

    annotation.dispatchEvent(new dom.window.MouseEvent('mouseout', {
        bubbles: true,
        relatedTarget: line,
    }));

    assert.ok(document.querySelector('.mktero-markdown-selection-actions'));
    assert.equal(scheduled.size, 0);

    const citation = document.querySelector('.cm-mktero-citation');
    citation.dispatchEvent(new dom.window.MouseEvent('mouseover', {
        bubbles: true,
    }));
    citation.dispatchEvent(new dom.window.MouseEvent('mouseout', {
        bubbles: true,
        relatedTarget: line,
    }));

    assert.ok(document.querySelector('.mktero-markdown-selection-actions'));
    assert.equal(document.querySelector('.mktero-citation-popup'), null);
    assert.equal(scheduled.size, 0);

    const selectionPopup = document.querySelector('.mktero-annotation-popup');
    selectionPopup.dispatchEvent(new dom.window.MouseEvent('mouseenter'));
    selectionPopup.dispatchEvent(new dom.window.MouseEvent('mouseleave'));

    assert.ok(document.querySelector('.mktero-markdown-selection-actions'));
    assert.equal(scheduled.size, 0);

    annotation.dispatchEvent(new dom.window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
    }));
    assert.equal(
        document.querySelector('.mktero-markdown-selection-actions'),
        null
    );
    assert.ok(document.querySelector('.mktero-annotation-note-input'));

    dom.window.setTimeout = originalSetTimeout;
    dom.window.clearTimeout = originalClearTimeout;
    editor.destroy();
    dom.window.close();
});

test('anchors selection actions above the first selected line', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    Object.defineProperties(dom.window, {
        innerWidth: { configurable: true, value: 1000 },
        innerHeight: { configurable: true, value: 800 },
    });
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: 'First selected line.\nSecond selected line.',
    });
    const content = document.querySelector('.cm-content');
    const range = document.createRange();
    range.selectNodeContents(content);
    range.getClientRects = () => [{
        top: 300,
        right: 440,
        bottom: 320,
        left: 300,
        width: 140,
        height: 20,
    }, {
        top: 302,
        right: 700,
        bottom: 318,
        left: 450,
        width: 250,
        height: 16,
    }, {
        top: 500,
        right: 400,
        bottom: 520,
        left: 300,
        width: 100,
        height: 20,
    }];
    document.getSelection().addRange(range);
    const originalGetBoundingClientRect =
        dom.window.HTMLElement.prototype.getBoundingClientRect;
    dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
        if (this.classList.contains('mktero-annotation-popup')) {
            return { height: 60, width: 300 };
        }
        return originalGetBoundingClientRect.call(this);
    };

    content.dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
    }));

    const popup = document.querySelector('.mktero-annotation-popup');
    assert.equal(popup?.dataset.placement, 'top');
    assert.equal(popup?.style.left, '350px');
    assert.equal(popup?.style.top, '230px');

    editor.destroy();
    dom.window.HTMLElement.prototype.getBoundingClientRect =
        originalGetBoundingClientRect;
    dom.window.close();
});

test('anchors selection actions near the pointer release line', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    Object.defineProperties(dom.window, {
        innerWidth: { configurable: true, value: 1000 },
        innerHeight: { configurable: true, value: 800 },
    });
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: 'First selected line.\nSecond selected line.',
    });
    const content = document.querySelector('.cm-content');
    const range = document.createRange();
    range.selectNodeContents(content);
    range.getClientRects = () => [{
        top: 300,
        right: 700,
        bottom: 320,
        left: 300,
        width: 400,
        height: 20,
    }, {
        top: 500,
        right: 400,
        bottom: 520,
        left: 300,
        width: 100,
        height: 20,
    }];
    document.getSelection().addRange(range);
    const originalGetBoundingClientRect =
        dom.window.HTMLElement.prototype.getBoundingClientRect;
    dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
        if (this.classList.contains('mktero-annotation-popup')) {
            return { height: 60, width: 300 };
        }
        return originalGetBoundingClientRect.call(this);
    };

    content.dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
        clientX: 360,
        clientY: 510,
    }));

    const popup = document.querySelector('.mktero-annotation-popup');
    assert.equal(popup?.dataset.placement, 'top');
    assert.equal(popup?.style.left, '210px');
    assert.equal(popup?.style.top, '430px');

    editor.destroy();
    dom.window.HTMLElement.prototype.getBoundingClientRect =
        originalGetBoundingClientRect;
    dom.window.close();
});

test('copies a reliably mapped selection with its source', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const copied = [];
    const markdown = 'Select this mapped Markdown text.';
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        copySourcedMarkdown: async target => copied.push(target),
    });
    editor.setDocument({
        markdown,
        sourceMap: [{
            type: 'text',
            markdownFrom: 0,
            markdownTo: markdown.length,
            locations: [{ pageIndex: 1, bbox: [100, 100, 900, 200] }],
        }],
    });
    const line = document.querySelector('.cm-line');
    const text = textNodeContaining(line, markdown);
    const range = document.createRange();
    range.selectNodeContents(text);
    document.getSelection().addRange(range);
    line.dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
    }));

    const copy = document.querySelector(
        '.mktero-markdown-selection-actions '
        + '[data-action="copy-with-source"]'
    );
    assert.ok(copy);
    copy.click();
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(copied, [{
        kind: 'selection',
        text: markdown,
        ranges: [{ from: 0, to: markdown.length }],
    }]);

    editor.destroy();
    dom.window.close();
});

test('keeps PDF navigation when a mapped selection cannot be copied with source', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'Selection with many mapped source regions.';
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        copySourcedMarkdown: async () => assert.fail('must not copy'),
        openSourceLocation: async () => {},
    });
    editor.setDocument({
        markdown,
        sourceMap: [{
            type: 'text',
            markdownFrom: 0,
            markdownTo: markdown.length,
            locations: Array.from({ length: 257 }, (_, index) => ({
                pageIndex: index,
                bbox: [100, 100, 900, 200],
            })),
        }],
    });
    const line = document.querySelector('.cm-line');
    const range = document.createRange();
    range.selectNodeContents(line);
    document.getSelection().addRange(range);
    line.dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
    }));

    assert.ok(document.querySelector('[data-action="view-in-pdf"]'));
    assert.equal(
        document.querySelector('[data-action="copy-with-source"]'),
        null
    );

    editor.destroy();
    dom.window.close();
});

test('shows selection actions across inline math', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const markdown = 'Before $n = 22$ after.';
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
    const line = document.querySelector('.cm-line');
    const start = textNodeContaining(line, 'Before');
    const end = textNodeContaining(line, 'after.');
    const range = document.createRange();
    range.setStart(start, 0);
    range.setEnd(end, end.textContent.length);
    document.getSelection().addRange(range);

    line.dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
    }));

    assert.ok(document.querySelector('.cm-mktero-math'));
    const actions = document.querySelector('.mktero-markdown-selection-actions');
    assert.ok(actions);
    actions.querySelector('[data-color="#ffd400"]').click();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(created.text, 'Before n = 22 after.');
    assert.deepEqual(created.ranges, [{ from: 0, to: markdown.length }]);

    editor.destroy();
    dom.window.close();
});

test('does not offer sourced actions for an unmapped selection', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: 'Unmapped selection.',
        copySourcedMarkdown: async () => assert.fail('must not copy'),
        openSourceLocation: async () => assert.fail('must not navigate'),
    });
    const line = document.querySelector('.cm-line');
    const range = document.createRange();
    range.selectNodeContents(line);
    document.getSelection().addRange(range);
    line.dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
    }));

    assert.equal(
        document.querySelector('[data-action="copy-with-source"]'),
        null
    );
    assert.equal(
        document.querySelector('[data-action="view-in-pdf"]'),
        null
    );

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

test('creates a highlight immediately after an existing abstract highlight', async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const existingText = 'Based on BBT and HR, we developed algorithms that '
        + 'predicted the fertile window with an accuracy of 87.46%, '
        + 'sensitivity of 69.30%, specificity of 92.00%, and AUC of 0.8993 '
        + 'and menses with an accuracy of 89.60%, sensitivity of 70.70%, and '
        + 'specificity of 94.30%, and AUC of 0.7849 among regular '
        + 'menstruators.';
    const selectedText = 'For irregular menstruators, the accuracy, '
        + 'sensitivity, specificity and AUC were 72.51%, 21.00%, 82.90%, '
        + 'and 0.5808 respectively, for fertile window prediction and '
        + '75.90%, 36.30%, 84.40%, and 0.6759 for menses prediction.';
    const markdown = `${existingText} ${selectedText}`;
    let created;
    const editor = createInlineMarkdownEditor({
        document,
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
        async createMarkdownAnnotation(annotation) {
            created = annotation;
            return { ...annotation, id: 'mktero-local-irregular' };
        },
    });
    editor.setDocument({
        markdown,
        annotationOverlay: {
            matched: [{
                id: 'PDF0001',
                source: 'zotero',
                type: 'highlight',
                text: existingText,
                comment: '',
                color: '#ffd400',
                pageLabel: '1',
                ranges: [{ from: 0, to: existingText.length }],
            }],
            unmatched: [],
        },
    });
    const line = document.querySelector('.cm-line');
    const selectedNode = textNodeContaining(line, selectedText);
    const range = document.createRange();
    range.selectNodeContents(selectedNode);
    document.getSelection().addRange(range);

    line.dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
    }));
    const colorButton = document.querySelector('[data-color="#ffd400"]');
    assert.ok(colorButton);
    colorButton.click();
    await Promise.resolve();
    await Promise.resolve();

    const from = markdown.indexOf(selectedText);
    assert.equal(created.text, selectedText);
    assert.deepEqual(created.ranges, [{
        from,
        to: from + selectedText.length,
    }]);

    editor.destroy();
    dom.window.close();
});

test('clamps a paragraph-end selection mapped into the next block', async () => {
    const existingText = 'Based on BBT and HR, the algorithms worked among '
        + 'regular menstruators.';
    const selectedText = 'For irregular menstruators, the accuracy, '
        + 'sensitivity, specificity and AUC were 72.51%, 21.00%, 82.90%, '
        + 'and 0.5808 respectively, for fertile window prediction and '
        + '75.90%, 36.30%, 84.40%, and 0.6759 for menses prediction.';
    const conclusion = 'Conclusions: By combining BBT and HR we obtained '
        + 'relatively ideal predictions.';
    const markdown = `${existingText} ${selectedText}\n\n${conclusion}`;
    const {
        dom,
        document,
        editor,
        createdAnnotation,
    } = createAnnotationSelectionEditor('', 'mktero-local-irregular');
    editor.setDocument({
        markdown,
        annotationOverlay: {
            matched: [{
                id: 'PDF0001',
                source: 'zotero',
                type: 'highlight',
                text: existingText,
                comment: '',
                color: '#ffd400',
                pageLabel: '1',
                ranges: [{ from: 0, to: existingText.length }],
            }],
            unmatched: [],
        },
    });
    const lines = [...document.querySelectorAll('.cm-line')];
    const targetLine = lines.find(line => line.textContent.includes(selectedText));
    const conclusionLine = lines.find(line => line.textContent.includes(conclusion));
    const selectedNode = textNodeContaining(targetLine, selectedText);
    const conclusionNode = textNodeContaining(conclusionLine, conclusion);
    const range = document.createRange();
    range.setStart(selectedNode, 0);
    range.setEnd(conclusionNode, conclusion.indexOf('relatively ideal'));
    setSelectionGeometry(range, targetLine, [
        rectangle(428, 1120, 456, 404),
        rectangle(468, 760, 496, 404),
    ], rectangle(400, 1120, 456, 300));
    document.getSelection().addRange(range);

    await createHighlightFromSelection(document, targetLine, {
        clientX: 1118,
        clientY: 452,
    });

    const created = createdAnnotation();
    const from = markdown.indexOf(selectedText);
    assert.equal(created.text, selectedText);
    assert.deepEqual(created.ranges, [{
        from,
        to: from + selectedText.length,
    }]);

    editor.destroy();
    dom.window.close();
});

test('preserves an intentional selection released in the next block', async () => {
    const markdown = 'First selected paragraph.\n\nSecond selected paragraph.';
    const {
        dom,
        document,
        editor,
        createdAnnotation,
    } = createAnnotationSelectionEditor(
        markdown,
        'mktero-local-cross-paragraph'
    );
    const lines = [...document.querySelectorAll('.cm-line')];
    const firstNode = textNodeContaining(lines[0], 'First selected');
    const secondNode = textNodeContaining(lines[2], 'Second selected');
    const secondEnd = 'Second selected'.length;
    const range = document.createRange();
    range.setStart(firstNode, 0);
    range.setEnd(secondNode, secondEnd);
    setSelectionGeometry(range, lines[2], [
        rectangle(400, 620, 428, 300),
        rectangle(468, 540, 496, 300),
    ], rectangle(468, 800, 496, 300));
    document.getSelection().addRange(range);

    await createHighlightFromSelection(document, lines[2], {
        clientX: 530,
        clientY: 482,
    });

    const created = createdAnnotation();
    assert.deepEqual(created.ranges, [{
        from: 0,
        to: markdown.indexOf('Second selected') + secondEnd,
    }]);

    editor.destroy();
    dom.window.close();
});

test('clamps a backward selection mapped into the previous block', async () => {
    const previous = 'Previous paragraph should not be selected.';
    const selectedText = 'For irregular menstruators, select this paragraph.';
    const markdown = `${previous}\n\n${selectedText}`;
    const {
        dom,
        document,
        editor,
        createdAnnotation,
    } = createAnnotationSelectionEditor(markdown, 'mktero-local-backward');
    const lines = [...document.querySelectorAll('.cm-line')];
    const previousNode = textNodeContaining(lines[0], previous);
    const selectedNode = textNodeContaining(lines[2], selectedText);
    const selection = document.getSelection();
    selection.setBaseAndExtent(
        selectedNode,
        selectedText.length,
        previousNode,
        previous.indexOf('should')
    );
    const range = selection.getRangeAt(0);
    setSelectionGeometry(range, lines[2], [
        rectangle(400, 650, 428, 380),
        rectangle(468, 760, 496, 300),
    ], rectangle(468, 800, 496, 300));

    await createHighlightFromSelection(document, lines[2], {
        clientX: 302,
        clientY: 482,
    });

    const created = createdAnnotation();
    const from = markdown.indexOf(selectedText);
    assert.equal(created.text, selectedText);
    assert.deepEqual(created.ranges, [{
        from,
        to: from + selectedText.length,
    }]);

    editor.destroy();
    dom.window.close();
});

test('skips chrome when selecting Markdown across page chrome', () => {
    const markdown = 'Hello\n\n12\n\nWorld';
    const chromeRanges = [{ from: 5, to: 11 }];
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
    });
    editor.setDocument({ markdown });
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    const lines = [...document.querySelectorAll('.cm-line')];
    const hello = textNodeContaining(lines[0], 'Hello');
    const world = textNodeContaining(lines[4], 'World');
    const range = document.createRange();
    range.setStart(hello, hello.textContent.indexOf('Hello'));
    range.setEnd(world, world.textContent.indexOf('World') + 'World'.length);
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);

    const selected = selectedMarkdownAnnotation(view, chromeRanges);
    assert.deepEqual(selected.ranges, [
        { from: 0, to: 5 },
        { from: 11, to: 16 },
    ]);
    assert.equal(selected.text.includes('12'), false);
    assert.equal(selected.text.replace(/\s+/gu, ''), 'HelloWorld');

    const chromeNode = textNodeContaining(lines[2], '12');
    const chromeRange = document.createRange();
    chromeRange.selectNodeContents(chromeNode);
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(chromeRange);
    assert.equal(selectedMarkdownAnnotation(view, chromeRanges), null);

    editor.destroy();
    dom.window.close();
});

test('hides chromeRanges in the Markdown reader without changing source', () => {
    const markdown = 'Hello\n\n12\n\nWorld';
    const chromeFrom = markdown.indexOf('\n\n12\n\n');
    const chromeTo = chromeFrom + '\n\n12\n\n'.length;
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
    });
    editor.setDocument({
        markdown,
        chromeRanges: [{ from: chromeFrom, to: chromeTo }],
    });
    assert.equal(editor.getMarkdown(), markdown);
    assert.equal(
        renderedLineTexts(document).some(text => text.trim() === '12'),
        false
    );
    assert.equal(
        renderedLineTexts(document).some(text => text.includes('Hello')),
        true
    );
    editor.destroy();
    dom.window.close();
});

test('keeps the paper title styled after hiding leading publisher chrome', () => {
    const markdown = [
        'Check for updates',
        '',
        'REVIEW ARTICLE OPEN',
        '',
        '# Systematic review and meta-analysis',
        '',
        'Han Li',
    ].join('\n');
    const titleFrom = markdown.indexOf('# Systematic');
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
    });
    editor.setDocument({
        markdown,
        chromeRanges: visibleDocumentChromeRanges(markdown, [
            { from: 0, to: titleFrom + 2 },
        ]),
    });
    const titleLine = [...document.querySelectorAll('.cm-line')].find(line => (
        line.textContent.includes('Systematic review')
    ));
    assert.ok(titleLine?.className.includes('cm-mktero-heading-1'));
    assert.equal(
        renderedLineTexts(document).some(text => (
            text.includes('Check for updates')
        )),
        false
    );
    editor.destroy();
    dom.window.close();
});

test('does not paint annotation marks on hidden chrome', () => {
    const markdown = 'Hello\n\n12\n\nWorld';
    const chromeFrom = markdown.indexOf('\n\n12\n\n');
    const chromeTo = chromeFrom + '\n\n12\n\n'.length;
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
    });
    editor.setDocument({
        markdown,
        chromeRanges: [{ from: chromeFrom, to: chromeTo }],
        annotationOverlay: {
            matched: [{
                id: 'HIGH0001',
                type: 'highlight',
                text: 'HelloWorld',
                color: '#ffd400',
                ranges: [{ from: 0, to: markdown.length }],
            }],
            unmatched: [],
        },
    });
    const marks = [...document.querySelectorAll('.cm-mktero-pdf-annotation')];
    assert.equal(marks.some(mark => mark.textContent.includes('12')), false);
    assert.equal(marks.some(mark => mark.textContent.includes('Hello')), true);
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
    const originalGetComputedStyle = globalThis.getComputedStyle;
    let measureRequests = 0;
    let synchronousMeasures = 0;
    let computedStyleWindow = null;
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
    const firstWindowGetComputedStyle = firstDOM.window.getComputedStyle;
    const secondWindowGetComputedStyle = secondDOM.window.getComputedStyle;
    firstDOM.window.getComputedStyle = function(element) {
        computedStyleWindow = this;
        return firstWindowGetComputedStyle.call(firstDOM.window, element);
    };
    secondDOM.window.getComputedStyle = function(element) {
        computedStyleWindow = this;
        return secondWindowGetComputedStyle.call(secondDOM.window, element);
    };
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
    globalThis.getComputedStyle(firstDOM.window.document.body);
    const styleActivatedFirstWindow = computedStyleWindow === firstDOM.window;

    firstDOM.window.document.querySelector('.cm-content').dispatchEvent(
        new firstDOM.window.KeyboardEvent('keydown', {
            key: 'a',
            bubbles: true,
        })
    );
    const keyActivatedFirstWindow = globalThis.window === firstDOM.window;

    secondEditor.focus();
    globalThis.getComputedStyle(secondDOM.window.document.body);
    const styleActivatedSecondWindow = computedStyleWindow === secondDOM.window;

    secondEditor.destroy();
    firstEditor.destroy();
    secondDOM.window.close();
    firstDOM.window.close();
    EditorView.prototype.requestMeasure = originalRequestMeasure;
    EditorView.prototype.measure = originalMeasure;

    assert.equal(scrollActivatedFirstWindow, true);
    assert.equal(scrollRequestedMeasure, true);
    assert.equal(scrollMeasuredSynchronously, true);
    assert.equal(styleActivatedFirstWindow, true);
    assert.equal(keyActivatedFirstWindow, true);
    assert.equal(styleActivatedSecondWindow, true);
    assert.equal(globalThis.getComputedStyle, originalGetComputedStyle);
});

test('bridges the owning Zotero window style API for CodeMirror scrolling', () => {
    const previousGetComputedStyle = Object.getOwnPropertyDescriptor(
        globalThis,
        'getComputedStyle'
    );
    delete globalThis.getComputedStyle;
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    dom.window.Range.prototype.getClientRects = () => [];
    dom.window.scrollBy = () => {};
    const windowGetComputedStyle = dom.window.getComputedStyle;
    let styleCalls = 0;
    dom.window.getComputedStyle = function(element) {
        assert.equal(this, dom.window);
        styleCalls++;
        return windowGetComputedStyle.call(dom.window, element);
    };
    let editor;

    try {
        const parent = dom.window.document.querySelector('#editor');
        editor = createInlineMarkdownEditor({
            parent,
            initialMarkdown: Array.from(
                { length: 200 },
                (_, index) => `Paragraph ${index + 1}`
            ).join('\n\n'),
        });
        const view = EditorView.findFromDOM(parent.querySelector('.cm-editor'));
        view.docView.coordsAt = () => rectangle(2000, 10, 2020, 0);
        const styleCallsBeforeScroll = styleCalls;

        assert.doesNotThrow(() => {
            view.dispatch({
                effects: EditorView.scrollIntoView(
                    view.state.doc.length,
                    { y: 'center' }
                ),
            });
            view.docView.scrollIntoView(view.viewState.scrollTarget);
        });
        assert.ok(styleCalls > styleCallsBeforeScroll);
    }
    finally {
        editor?.destroy();
        dom.window.close();
        if (previousGetComputedStyle) {
            Object.defineProperty(
                globalThis,
                'getComputedStyle',
                previousGetComputedStyle
            );
        }
        else {
            delete globalThis.getComputedStyle;
        }
    }
});

function createStalledViewportFixture({
    paragraphCount,
    targetParagraph,
    scrollTop,
}) {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    dom.window.Range.prototype.getClientRects = () => [];
    const { document } = dom.window;
    const targetText = `Paragraph ${targetParagraph}`;
    const markdown = Array.from(
        { length: paragraphCount },
        (_, index) => `Paragraph ${index + 1}`
    ).join('\n\n');
    const blocks = Array.from({ length: paragraphCount }, (_, index) => {
        const text = `Paragraph ${index + 1}`;
        const from = markdown.indexOf(text);
        return {
            id: `paragraph-${index + 1}`,
            type: 'paragraph',
            from,
            to: from + text.length,
            markdown: text,
        };
    });
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
    });
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    const scroller = view.scrollDOM;
    const targetOffset = markdown.indexOf(targetText);
    const targetBlock = view.lineBlockAt(targetOffset);
    Object.defineProperty(view, 'inView', {
        configurable: true,
        get: () => false,
    });
    Object.defineProperty(scroller, 'clientHeight', {
        configurable: true,
        value: 800,
    });
    view.lineBlockAtHeight = () => targetBlock;
    scroller.scrollTop = scrollTop;

    return {
        blocks,
        document,
        dom,
        editor,
        markdown,
        scroller,
        targetOffset,
        targetText,
        view,
    };
}

test('renders the scrolled region when Zotero geometry marks the editor out of view', () => {
    const {
        document,
        dom,
        editor,
        scroller,
        targetOffset,
        targetText,
        view,
    } = createStalledViewportFixture({
        paragraphCount: 200,
        targetParagraph: 160,
        scrollTop: 2400,
    });

    scroller.dispatchEvent(new dom.window.Event('scroll', {
        bubbles: true,
    }));

    const renderedText = document.querySelector('.cm-content').textContent;
    const resultingScrollTop = scroller.scrollTop;
    const resultingViewport = view.viewport;

    editor.destroy();
    dom.window.close();

    assert.match(renderedText, /Paragraph 160/);
    assert.ok(resultingViewport.from <= targetOffset);
    assert.ok(resultingViewport.to >= targetOffset + targetText.length);
    assert.equal(resultingScrollTop, 2400);
});

test('keeps the scrolled region rendered when correction mode is enabled', () => {
    const {
        blocks,
        document,
        dom,
        editor,
        markdown,
        scroller,
        targetOffset,
        targetText,
        view,
    } = createStalledViewportFixture({
        paragraphCount: 40,
        targetParagraph: 32,
        scrollTop: 600,
    });

    editor.setDocument({ markdown, sourceMap: [] });
    editor.setCorrectionState({ enabled: true, blocks });

    const renderedText = document.querySelector('.cm-content').textContent;
    const resultingScrollTop = scroller.scrollTop;
    const resultingViewport = view.viewport;

    editor.destroy();
    dom.window.close();

    assert.match(renderedText, new RegExp(targetText));
    assert.ok(resultingViewport.from <= targetOffset);
    assert.ok(resultingViewport.to >= targetOffset + targetText.length);
    assert.equal(resultingScrollTop, 600);
});

test('keeps a scrolled correction rendered when height lookup stays stale',
    async () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    dom.window.Range.prototype.getClientRects = () => [];
    const { document } = dom.window;
    const paragraphCount = 40;
    const targetParagraph = 25;
    const paragraphs = Array.from(
        { length: paragraphCount },
        (_, index) => `Paragraph ${index + 1} ${'content '.repeat(8)}`.trim()
    );
    const markdown = paragraphs.join('\n\n');
    const createBlocks = value => {
        let from = 0;
        return value.split('\n\n').map((text, index) => {
            const block = {
                id: `paragraph-${index + 1}`,
                type: 'paragraph',
                from,
                to: from + text.length,
                markdown: text,
            };
            from += text.length + 2;
            return block;
        });
    };
    const viewportOffsets = [];
    let editor;
    editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        onViewportChange: offset => viewportOffsets.push(offset),
        async onCommitCorrection(correction) {
            const updatedMarkdown = editor.getMarkdown();
            editor.setDocument({ markdown: updatedMarkdown, sourceMap: [] });
            editor.setCorrectionState({
                enabled: true,
                blocks: createBlocks(updatedMarkdown),
                correctedBlockIDs: [correction.blockID],
            });
        },
    });
    const blocks = createBlocks(markdown);
    editor.setCorrectionState({ enabled: true, blocks });
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    const scroller = view.scrollDOM;
    const targetText = paragraphs[targetParagraph - 1];
    const targetOffset = markdown.indexOf(targetText);
    const targetBlock = view.lineBlockAt(targetOffset);
    Object.defineProperty(view, 'inView', {
        configurable: true,
        get: () => false,
    });
    Object.defineProperty(scroller, 'clientHeight', {
        configurable: true,
        value: 800,
    });
    Object.defineProperty(scroller, 'scrollHeight', {
        configurable: true,
        value: Math.max(view.contentHeight, targetBlock.bottom + 800),
    });
    scroller.scrollTop = Math.max(0, targetBlock.top - 400);
    scroller.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
    assert.match(document.querySelector('.cm-content').textContent, /Paragraph 25/);

    view.posAtCoords = () => targetOffset + 10;
    document.querySelector('.cm-content').dispatchEvent(
        new dom.window.MouseEvent('dblclick', {
            bubbles: true,
            cancelable: true,
            button: 0,
        })
    );
    viewportOffsets.length = 0;
    view.dispatch({
        changes: {
            from: targetOffset,
            insert: 'Edited ',
        },
    });
    assert.deepEqual(viewportOffsets, []);
    document.querySelector('.mktero-correction-editor-save').click();
    await new Promise(resolve => setImmediate(resolve));

    const updatedTargetOffset = editor.getMarkdown().indexOf('Edited Paragraph 25');
    const renderedText = document.querySelector('.cm-content').textContent;
    const resultingViewport = view.viewport;

    const nextTargetText = paragraphs[31];
    const nextTargetOffset = editor.getMarkdown().indexOf(nextTargetText);
    const nextTargetBlock = view.lineBlockAt(nextTargetOffset);
    view.lineBlockAtHeight = () => view.lineBlockAt(0);
    scroller.scrollTop = Math.max(0, nextTargetBlock.top - 400);
    scroller.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
    const renderedAfterScroll = document.querySelector('.cm-content').textContent;
    const viewportAfterScroll = view.viewport;

    editor.destroy();
    dom.window.close();

    assert.match(renderedText, /Edited Paragraph 25/);
    assert.ok(
        resultingViewport.from <= updatedTargetOffset,
        JSON.stringify({ resultingViewport, updatedTargetOffset })
    );
    assert.ok(
        resultingViewport.to >= updatedTargetOffset + targetText.length,
        JSON.stringify({ resultingViewport, updatedTargetOffset })
    );
    assert.match(renderedAfterScroll, /Paragraph 32/);
    assert.ok(viewportAfterScroll.from <= nextTargetOffset);
    assert.ok(viewportAfterScroll.to >= nextTargetOffset + nextTargetText.length);
});

test('restores scrolling after a deferred stalled viewport measurement', () => {
    const {
        blocks,
        dom,
        editor,
        scroller,
        view,
    } = createStalledViewportFixture({
        paragraphCount: 40,
        targetParagraph: 32,
        scrollTop: 600,
    });
    const scheduled = new Map();
    let nextFrame = 0;
    dom.window.requestAnimationFrame = callback => {
        nextFrame++;
        scheduled.set(nextFrame, callback);
        return nextFrame;
    };
    dom.window.cancelAnimationFrame = frame => scheduled.delete(frame);
    view.requestMeasure = () => {};
    let measurements = 0;
    view.measure = () => {
        measurements++;
        if (measurements === 1) throw new Error('geometry unavailable');
        scroller.scrollTop = 950;
    };

    editor.setCorrectionState({ enabled: true, blocks });
    assert.equal(scroller.scrollTop, 600);
    assert.equal(scheduled.size, 1);
    const [[frame, callback]] = scheduled;
    scheduled.delete(frame);
    callback();

    assert.equal(measurements, 2);
    assert.equal(scroller.scrollTop, 600);

    editor.destroy();
    dom.window.close();
});

test('cancels a deferred viewport measurement when the editor is destroyed', () => {
    const {
        blocks,
        dom,
        editor,
        view,
    } = createStalledViewportFixture({
        paragraphCount: 40,
        targetParagraph: 32,
        scrollTop: 600,
    });
    const scheduled = new Map();
    const canceled = [];
    let nextFrame = 0;
    dom.window.requestAnimationFrame = callback => {
        nextFrame++;
        scheduled.set(nextFrame, callback);
        return nextFrame;
    };
    dom.window.cancelAnimationFrame = frame => {
        canceled.push(frame);
        scheduled.delete(frame);
    };
    view.requestMeasure = () => {};
    let measurements = 0;
    view.measure = () => {
        measurements++;
        throw new Error('geometry unavailable');
    };

    editor.setCorrectionState({ enabled: true, blocks });
    const [[frame, callback]] = scheduled;
    editor.destroy();

    assert.ok(canceled.includes(frame));
    callback();
    assert.equal(measurements, 1);

    dom.window.close();
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

test('reports the first visible Markdown offset to the owning reader', () => {
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const offsets = [];
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '# Paper\n\nOriginal text.',
        onViewportChange: offset => offsets.push(offset),
    });

    const updatedMarkdown = '# Updated\n\nUpdated text.';
    editor.setMarkdown(updatedMarkdown);
    const scroller = document.querySelector('.cm-scroller');
    scroller.scrollTop = 12;
    scroller.dispatchEvent(new dom.window.Event('scroll', {
        bubbles: true,
    }));

    editor.destroy();
    dom.window.close();

    assert.ok(offsets.length > 0);
    assert.ok(offsets.at(-1) > 0);
    assert.ok(offsets.at(-1) < updatedMarkdown.length);
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
