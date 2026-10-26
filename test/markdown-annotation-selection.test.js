import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createInlineMarkdownEditor } from '../src/editor/inline-markdown-editor.js';
import {
    collectMarkdownTranslationBlocks,
    createDocumentTranslationViews,
    mapComparisonRangeToSource,
} from '../src/markdown/markdown-translation-blocks.js';
import { markdownAnnotationRangeMatchesSource } from '../src/core/markdown-local-annotations.js';

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

function selectAndHighlight(document, ownerWindow, target, color = '#2ea8e5', eventTarget = null) {
    const range = document.createRange();
    if (typeof target === 'function') {
        target(range);
    }
    else {
        range.selectNodeContents(target);
    }
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);
    const mouseTarget = eventTarget
        || (target.nodeType ? target : document.querySelector('.cm-content'));
    mouseTarget.dispatchEvent(new ownerWindow.MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
    }));
    const actions = document.querySelector('.mktero-markdown-selection-actions');
    assert.ok(actions);
    actions.querySelector(`[data-color="${color}"]`).click();
    return actions;
}

test('creates a local highlight from a whole heading line without Markdown marks', async () => {
    const markdown = '### 3.1 Execution State and Schema Authoring\n\nBody paragraph.';
    const created = [];
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        createMarkdownAnnotation: async annotation => {
            created.push(annotation);
            return annotation;
        },
    });
    const line = [...document.querySelectorAll('.cm-line')].find(candidate => (
        candidate.textContent.includes('3.1 Execution State')
    ));
    assert.ok(line);
    selectAndHighlight(document, dom.window, line);
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(created.length, 1);
    assert.equal(created[0].text, '3.1 Execution State and Schema Authoring');
    assert.deepEqual(created[0].ranges, [{ from: 0, to: 44 }]);
    assert.equal(
        markdownAnnotationRangeMatchesSource(
            markdown,
            created[0].ranges,
            created[0].text
        ),
        true
    );

    editor.destroy();
    dom.window.close();
});

test('creates a bilingual highlight from a display math formula', async () => {
    const formula = '(R_t, \\Delta\\Sigma_t, a_t)';
    const markdown = [
        'Given the current execution context.',
        '',
        '$$',
        formula,
        '$$',
        '',
        'where R_t denotes the trace.',
    ].join('\n');
    const blocks = collectMarkdownTranslationBlocks(markdown);
    const translations = blocks.filter(block => block.translatable).map(block => ({
        id: block.id,
        markdown: `${block.markdown} 译文。`,
    }));
    const views = createDocumentTranslationViews(markdown, blocks, translations);
    const created = [];
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
        createMarkdownAnnotation: async (annotation, selectionContext) => {
            const ranges = annotation.ranges.map(range => (
                mapComparisonRangeToSource(range, views.blockRanges)
            ));
            created.push({ annotation, selectionContext, ranges });
            return annotation;
        },
    });
    editor.setDocument({
        markdown: views.comparisonMarkdown,
        sourceActionRanges: views.blockRanges.flatMap(range => (
            Number.isSafeInteger(range.comparisonSourceFrom)
                && Number.isSafeInteger(range.comparisonSourceTo)
                && range.comparisonSourceTo > range.comparisonSourceFrom
                ? [{
                    from: range.comparisonSourceFrom,
                    to: range.comparisonSourceTo,
                }]
                : []
        )),
        translationPairs: views.blockRanges.map(range => ({
            id: range.id,
            sourceFrom: range.comparisonSourceFrom,
            sourceTo: range.comparisonSourceTo,
            translatedFrom: range.comparisonTranslationFrom,
            translatedTo: range.comparisonTranslationTo,
        })),
        translationRanges: views.comparisonTranslationRanges,
    });

    const math = document.querySelector('.cm-mktero-math-display');
    assert.ok(math);
    selectAndHighlight(document, dom.window, math);
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(created.length, 1);
    assert.equal(created[0].selectionContext.side, 'source');
    assert.equal(created[0].annotation.text, formula);
    assert.ok(created[0].ranges.every(Boolean));
    assert.equal(
        markdownAnnotationRangeMatchesSource(
            markdown,
            created[0].ranges,
            created[0].annotation.text
        ),
        true
    );

    editor.destroy();
    dom.window.close();
});

test('creates a bilingual heading highlight that maps back to original Markdown', async () => {
    const markdown = '### 3.1 Execution State and Schema Authoring\n\nBody paragraph.';
    const blocks = collectMarkdownTranslationBlocks(markdown);
    const views = createDocumentTranslationViews(markdown, blocks, [{
        id: blocks[0].id,
        markdown: '### 3.1 执行状态与模式设计',
    }, {
        id: blocks[1].id,
        markdown: '正文。',
    }]);
    const created = [];
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
        createMarkdownAnnotation: async (annotation, selectionContext) => {
            const ranges = annotation.ranges.map(range => (
                mapComparisonRangeToSource(range, views.blockRanges)
            ));
            created.push({ annotation, selectionContext, ranges });
            return annotation;
        },
    });
    editor.setDocument({
        markdown: views.comparisonMarkdown,
        sourceActionRanges: views.blockRanges.map(range => ({
            from: range.comparisonSourceFrom,
            to: range.comparisonSourceTo,
        })),
        translationPairs: views.blockRanges.map(range => ({
            id: range.id,
            sourceFrom: range.comparisonSourceFrom,
            sourceTo: range.comparisonSourceTo,
            translatedFrom: range.comparisonTranslationFrom,
            translatedTo: range.comparisonTranslationTo,
        })),
        translationRanges: views.comparisonTranslationRanges,
    });

    const line = [...document.querySelectorAll('.cm-line')].find(candidate => (
        candidate.textContent.includes('3.1 Execution State')
    ));
    assert.ok(line);
    selectAndHighlight(document, dom.window, line);
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(created.length, 1);
    assert.equal(created[0].selectionContext.side, 'source');
    assert.equal(created[0].annotation.text, '3.1 Execution State and Schema Authoring');
    assert.ok(created[0].ranges.every(Boolean));
    assert.equal(
        markdownAnnotationRangeMatchesSource(
            markdown,
            created[0].ranges,
            created[0].annotation.text
        ),
        true
    );

    editor.destroy();
    dom.window.close();
});

test('creates a bilingual highlight from the SKILL.state schema paragraph', async () => {
    const paragraph = [
        'Unlike conversational runtimes, SKILL.state treats execution state as a first-class runtime abstraction.',
        ' The state contains only information required for future execution and is represented using a structured schema defined for the domain.',
        ' Schemas are authored once per domain rather than per task; for example, across all 100 diverse challenge instances in the InterCode CTF benchmark, the agent reuses a single static 5-field schema (discovered_flags, tested_hypotheses, active_files, working_dir, cmd_summary).',
    ].join('');
    const markdown = [
        '### 3.1 Execution State and Schema Authoring',
        '',
        paragraph,
    ].join('\n');
    const blocks = collectMarkdownTranslationBlocks(markdown);
    const views = createDocumentTranslationViews(markdown, blocks, [{
        id: blocks[0].id,
        markdown: '### 3.1 执行状态与模式设计',
    }, {
        id: blocks[1].id,
        markdown: '与对话式运行时不同，SKILL.state将执行状态视为一等公民的运行时抽象。',
    }]);
    const created = [];
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
        createMarkdownAnnotation: async (annotation, selectionContext) => {
            const ranges = annotation.ranges.map(range => (
                mapComparisonRangeToSource(range, views.blockRanges)
            ));
            created.push({ annotation, selectionContext, ranges });
            return annotation;
        },
    });
    editor.setDocument({
        markdown: views.comparisonMarkdown,
        sourceActionRanges: views.blockRanges.map(range => ({
            from: range.comparisonSourceFrom,
            to: range.comparisonSourceTo,
        })),
        translationPairs: views.blockRanges.map(range => ({
            id: range.id,
            sourceFrom: range.comparisonSourceFrom,
            sourceTo: range.comparisonSourceTo,
            translatedFrom: range.comparisonTranslationFrom,
            translatedTo: range.comparisonTranslationTo,
        })),
        translationRanges: views.comparisonTranslationRanges,
    });

    const start = textNodeContaining(
        document.querySelector('.cm-content'),
        'Unlike conversational runtimes'
    );
    const end = textNodeContaining(
        document.querySelector('.cm-content'),
        'cmd_summary'
    );
    assert.ok(start);
    assert.ok(end);
    selectAndHighlight(document, dom.window, range => {
        range.setStart(
            start,
            start.textContent.indexOf('Unlike conversational runtimes')
        );
        range.setEnd(
            end,
            Math.min(
                end.textContent.length,
                end.textContent.indexOf('cmd_summary') + 'cmd_summary'.length
            )
        );
    });
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(created.length, 1);
    assert.equal(created[0].selectionContext.side, 'source');
    assert.ok(created[0].ranges.every(Boolean));
    assert.equal(
        markdownAnnotationRangeMatchesSource(
            markdown,
            created[0].ranges,
            created[0].annotation.text
        ),
        true
    );

    editor.destroy();
    dom.window.close();
});

test('expands a partial formula selection to the whole formula', async () => {
    const markdown = '![Figure 2 established, that is $Y=D(X)$ is the maximum.](generated/figures/fig-2.png)';
    const created = [];
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
        createMarkdownAnnotation: async annotation => {
            created.push(annotation);
            return annotation;
        },
    });
    const figcaption = document.querySelector('figcaption');
    const before = textNodeContaining(figcaption, 'that is');
    const equals = textNodeContaining(figcaption, '=');
    selectAndHighlight(document, dom.window, range => {
        range.setStart(before, before.textContent.indexOf('that is'));
        range.setEnd(equals, 1);
    }, '#2ea8e5', equals);
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(created[0].text, 'that is Y=D(X)');
    const [{ from, to }] = created[0].ranges;
    assert.equal(markdown.slice(from, to), 'that is $Y=D(X)$');

    editor.destroy();
    dom.window.close();
});

test('creates a highlight across rendered math in a figure caption', async () => {
    const markdown = '![Figure 2 established, that is $Y=D(X)$ is the maximum.](generated/figures/fig-2.png)';
    const created = [];
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
        createMarkdownAnnotation: async annotation => {
            created.push(annotation);
            return annotation;
        },
    });
    const figcaption = document.querySelector('figcaption');
    const before = textNodeContaining(figcaption, 'that is');
    const after = textNodeContaining(figcaption, 'maximum');
    selectAndHighlight(document, dom.window, range => {
        const start = before.textContent.indexOf('that is');
        range.setStart(before, start);
        range.setEnd(after, after.textContent.indexOf('maximum') + 'maximum'.length);
    }, '#2ea8e5', after);
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(created.length, 1);
    assert.equal(created[0].text, 'that is Y=D(X) is the maximum');
    const [{ from, to }] = created[0].ranges;
    assert.equal(markdown.slice(from, to), 'that is $Y=D(X)$ is the maximum');

    editor.destroy();
    dom.window.close();
});

test('creates a highlight in a caption with repeated word fragments', async () => {
    const caption = 'Figure 5 Interval tachogram values together with the order p '
        + 'of the chosen model and minimal values.';
    const markdown = `![${caption}](generated/figures/fig-5.png)`;
    const created = [];
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => 'blob:mktero-figure',
        createMarkdownAnnotation: async annotation => {
            created.push(annotation);
            return annotation;
        },
    });
    const figcaption = document.querySelector('figcaption');
    const node = textNodeContaining(figcaption, 'Interval tachogram');
    assert.ok(node);
    const from = markdown.indexOf('Interval tachogram');
    const to = markdown.indexOf('order p') + 'order p'.length;
    selectAndHighlight(document, dom.window, range => {
        range.setStart(node, node.textContent.indexOf('Interval tachogram'));
        range.setEnd(node, node.textContent.indexOf('order p') + 'order p'.length);
    }, '#2ea8e5', node);
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(created.length, 1);
    assert.equal(created[0].text, 'Interval tachogram values together with the order p');
    assert.deepEqual(created[0].ranges, [{ from, to }]);

    editor.destroy();
    dom.window.close();
});

test('creates a highlight from a figure caption selection', async () => {
    const caption = 'Figure 5. Ablation results for PaIRSet augmentation strategies. '
        + 'Significance markers: \\* p \\leq 0.05 , \\*\\* p \\leq 0.01 .';
    const markdown = `![${caption}](generated/figures/fig-1.png)`;
    const created = [];
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
        createMarkdownAnnotation: async annotation => {
            created.push(annotation);
            return annotation;
        },
    });
    const figcaption = document.querySelector('figcaption');
    assert.ok(figcaption);
    const markerNode = textNodeContaining(figcaption, 'Significance markers');
    assert.ok(markerNode);
    const markerOffset = markerNode.textContent.indexOf('Significance markers');
    selectAndHighlight(document, dom.window, range => {
        range.setStart(markerNode, markerOffset);
        range.setEnd(markerNode, markerNode.textContent.length);
    });
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(created.length, 1);
    assert.equal(created[0].ranges.length, 1);
    const [{ from, to }] = created[0].ranges;
    assert.equal(
        created[0].text,
        'Significance markers: * p \\leq 0.05 , ** p \\leq 0.01 .'
    );
    assert.equal(
        markdown.slice(from, to),
        'Significance markers: \\* p \\leq 0.05 , \\*\\* p \\leq 0.01 .'
    );
    assert.equal(markdown.slice(from, to).includes('Figure 5'), false);

    editor.destroy();
    dom.window.close();
});

// The image description doubles the formula's backslash ("$\\Delta$"). The
// saved text is the formula's TeX, "\Delta", as the caption renders it, and
// the caption shows "Δ": the highlight is placed from its source range.
test('shows a highlight made in a caption whose formula the description escapes', async () => {
    const caption = 'Figure 4: Validation-unit-specific effects of execution paradigms. '
        + 'Heatmaps report the corresponding $\\\\Delta$ in percentage points.)';
    const markdown = `![${caption}](generated/figures/fig-p7-b78.png)`;
    const created = [];
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => 'blob:mktero-figure',
        createMarkdownAnnotation: async annotation => {
            created.push(annotation);
            return annotation;
        },
    });
    const figcaption = document.querySelector('figcaption');
    const start = textNodeContaining(figcaption, 'Validation-unit');
    const end = textNodeContaining(figcaption, 'percentage points.)');
    assert.ok(start && end && start !== end);
    selectAndHighlight(document, dom.window, range => {
        range.setStart(start, start.textContent.indexOf('Validation-unit'));
        range.setEnd(end, end.textContent.length);
    }, '#ffd400', start);
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(created.length, 1);
    const from = markdown.indexOf('Validation-unit');
    const to = markdown.indexOf('](generated');
    assert.deepEqual(created[0].ranges, [{ from, to }]);
    assert.ok(created[0].text.endsWith(
        'corresponding \\Delta in percentage points.)'
    ));
    assert.equal(created[0].text.includes('\\\\'), false);
    assert.equal(
        markdownAnnotationRangeMatchesSource(
            markdown,
            created[0].ranges,
            created[0].text
        ),
        true
    );

    editor.setDocument({
        markdown,
        annotationOverlay: {
            matched: [{
                id: 'CAPTION1',
                type: 'highlight',
                comment: '',
                color: '#ffd400',
                pageLabel: '8',
                pageIndex: 7,
                ...created[0],
            }],
            unmatched: [],
        },
    });

    const highlights = document.querySelectorAll(
        'figcaption .cm-mktero-pdf-annotation'
    );
    assert.equal(highlights.length, 1);
    const shown = visibleText(highlights[0]);
    assert.ok(shown.startsWith('Validation-unit-specific effects'));
    assert.ok(shown.endsWith('corresponding Δ in percentage points.)'));
    assert.equal(
        highlights[0].closest('figcaption')?.querySelector(
            '.mktero-figure-label .cm-mktero-pdf-annotation'
        ),
        null
    );

    editor.destroy();
    dom.window.close();
});

function visibleText(element) {
    const walker = element.ownerDocument.createTreeWalker(
        element,
        element.ownerDocument.defaultView.NodeFilter.SHOW_TEXT
    );
    let text = '';
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement?.closest('annotation, annotation-xml')) continue;
        text += node.textContent;
    }
    return text;
}

function captionPointerEvent(ownerWindow, type, node, offset, extras = {}) {
    const event = new ownerWindow.MouseEvent(type, {
        bubbles: true,
        button: 0,
        buttons: type === 'mousemove' ? 1 : 0,
        detail: 1,
        ...extras,
    });
    Object.defineProperty(event, 'rangeParent', { value: node });
    Object.defineProperty(event, 'rangeOffset', { value: offset });
    return event;
}

test('clamps a figure-caption drag that leaked into the previous paragraph', async () => {
    const markdown = [
        'Before the figure, this paragraph must not be selected.',
        '',
        '![Figure 1. Consolidated Standards of Reporting Trial.](generated/figures/fig-1.png)',
        '',
        'After the figure, this paragraph stays outside.',
    ].join('\n');
    const created = [];
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
        createMarkdownAnnotation: async annotation => {
            created.push(annotation);
            return annotation;
        },
    });
    const figcaption = document.querySelector('figcaption');
    const captionText = textNodeContaining(figcaption, 'Reporting');
    const before = textNodeContaining(
        document.querySelector('#editor'),
        'Before the figure'
    );
    assert.ok(captionText);
    assert.ok(before);
    const start = captionText.textContent.indexOf('Reporting');
    const focus = captionText.textContent.indexOf('Trial') + 'Trial'.length;
    figcaption.dispatchEvent(captionPointerEvent(
        dom.window,
        'mousedown',
        captionText,
        start
    ));
    document.getSelection().setBaseAndExtent(before, 0, captionText, focus);
    document.dispatchEvent(new dom.window.Event('selectionchange'));

    const selection = document.getSelection();
    assert.equal(figcaption.contains(selection.anchorNode), true);
    assert.equal(figcaption.contains(selection.focusNode), true);
    assert.equal(selection.anchorOffset, start);
    assert.equal(selection.focusOffset, focus);

    figcaption.dispatchEvent(new dom.window.MouseEvent('mouseup', {
        bubbles: true,
        button: 0,
    }));
    const actions = document.querySelector('.mktero-markdown-selection-actions');
    assert.ok(actions);
    actions.querySelector('[data-color="#2ea8e5"]').click();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(created.length, 1);
    assert.equal(created[0].text, 'Reporting Trial');
    assert.equal(created[0].text.includes('Before the figure'), false);

    editor.destroy();
    dom.window.close();
});

test('does not clamp a caption selection whose gesture started in the paragraph', async () => {
    const markdown = [
        'Before the figure, this paragraph must not be selected.',
        '',
        '![Figure 1. Consolidated Standards of Reporting Trial.](generated/figures/fig-1.png)',
        '',
        'After the figure, this paragraph stays outside.',
    ].join('\n');
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
    });
    const figcaption = document.querySelector('figcaption');
    const captionText = textNodeContaining(figcaption, 'Reporting');
    const before = textNodeContaining(
        document.querySelector('#editor'),
        'Before the figure'
    );
    before.parentElement.dispatchEvent(captionPointerEvent(
        dom.window,
        'mousedown',
        before,
        0
    ));
    document.getSelection().setBaseAndExtent(before, 0, captionText, 8);
    document.dispatchEvent(new dom.window.Event('selectionchange'));
    assert.equal(document.getSelection().anchorNode, before);

    editor.destroy();
    dom.window.close();
});

test('does not clamp once the pointer has entered the following paragraph', async () => {
    const markdown = [
        'Before the figure, this paragraph must not be selected.',
        '',
        '![Figure 1. Consolidated Standards of Reporting Trial.](generated/figures/fig-1.png)',
        '',
        'After the figure, this paragraph stays outside.',
    ].join('\n');
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
    });
    const figcaption = document.querySelector('figcaption');
    const captionText = textNodeContaining(figcaption, 'Reporting');
    const before = textNodeContaining(
        document.querySelector('#editor'),
        'Before the figure'
    );
    const after = textNodeContaining(
        document.querySelector('#editor'),
        'After the figure'
    );
    const start = captionText.textContent.indexOf('Reporting');
    figcaption.dispatchEvent(captionPointerEvent(
        dom.window,
        'mousedown',
        captionText,
        start
    ));
    after.parentElement.dispatchEvent(captionPointerEvent(
        dom.window,
        'mousemove',
        after,
        0,
        { buttons: 1, clientX: 8, clientY: 8 }
    ));
    document.getSelection().setBaseAndExtent(before, 0, captionText, start + 4);
    document.dispatchEvent(new dom.window.Event('selectionchange'));
    assert.equal(document.getSelection().anchorNode, before);

    editor.destroy();
    dom.window.close();
});

test('a re-entered caption selectionchange does not loop', async () => {
    const markdown = '![Figure 1. Consolidated Standards of Reporting Trial.](generated/figures/fig-1.png)';
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
    });
    const figcaption = document.querySelector('figcaption');
    const captionText = textNodeContaining(figcaption, 'Reporting');
    const beforeHost = document.createElement('p');
    beforeHost.textContent = 'Before the figure, leaked.';
    document.body.append(beforeHost);
    const before = beforeHost.firstChild;
    const start = captionText.textContent.indexOf('Reporting');
    figcaption.dispatchEvent(captionPointerEvent(
        dom.window,
        'mousedown',
        captionText,
        start
    ));
    const selection = document.getSelection();
    const original = selection.setBaseAndExtent.bind(selection);
    let writes = 0;
    selection.setBaseAndExtent = (...args) => {
        writes += 1;
        if (writes > 4) throw new Error('caption selection clamp looped');
        original(...args);
        if (writes === 1) {
            document.dispatchEvent(new dom.window.Event('selectionchange'));
        }
    };
    selection.setBaseAndExtent(before, 0, captionText, start + 4);
    document.dispatchEvent(new dom.window.Event('selectionchange'));
    assert.ok(writes <= 4);
    assert.equal(figcaption.contains(selection.anchorNode), true);

    editor.destroy();
    dom.window.close();
});

async function highlightedAnnotation(markdown, select) {
    const created = [];
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
        createMarkdownAnnotation: async annotation => {
            created.push(annotation);
            return annotation;
        },
    });
    try {
        select(document, dom.window);
        await Promise.resolve();
        await Promise.resolve();
        return created[0];
    }
    finally {
        editor.destroy();
        dom.window.close();
    }
}

function selectText(document, ownerWindow, node, from, to) {
    selectAndHighlight(document, ownerWindow, range => {
        range.setStart(node, from);
        range.setEnd(node, to);
    }, '#2ea8e5', node);
}

test('partial inline markup selection saves the text the reader sees', async () => {
    const bold = 'We report **strong results** today.';
    const boldEnd = 'strong results';
    const boldAnnotation = await highlightedAnnotation(bold, (document, ownerWindow) => {
        const content = document.querySelector('.cm-content');
        const start = textNodeContaining(content, 'We report');
        const end = textNodeContaining(content, boldEnd);
        selectAndHighlight(document, ownerWindow, range => {
            range.setStart(start, start.textContent.indexOf('We report'));
            range.setEnd(end, end.textContent.indexOf(boldEnd) + boldEnd.length);
        }, '#2ea8e5', end);
    });
    assert.equal(boldAnnotation.text, 'We report strong results');
    assert.deepEqual(boldAnnotation.ranges, [
        { from: 0, to: bold.indexOf('**') },
        {
            from: bold.indexOf(boldEnd),
            to: bold.indexOf(boldEnd) + boldEnd.length,
        },
    ]);
    assert.equal(boldAnnotation.ranges.some(range => (
        bold.slice(range.from, range.to).includes('**')
    )), false);
    assert.equal(
        markdownAnnotationRangeMatchesSource(
            bold,
            boldAnnotation.ranges,
            boldAnnotation.text
        ),
        true
    );

    const conclusions = '**Conclusions** we found more.';
    const conclusionsAnnotation = await highlightedAnnotation(
        conclusions,
        (document, ownerWindow) => {
            const content = document.querySelector('.cm-content');
            const start = textNodeContaining(content, 'Conclusions');
            const end = textNodeContaining(content, 'we found');
            selectAndHighlight(document, ownerWindow, range => {
                range.setStart(start, start.textContent.indexOf('Conclusions'));
                range.setEnd(
                    end,
                    end.textContent.indexOf('found') + 'found'.length
                );
            }, '#2ea8e5', end);
        }
    );
    assert.equal(conclusionsAnnotation.text, 'Conclusions we found');
    assert.equal(conclusionsAnnotation.ranges.some(range => (
        conclusions.slice(range.from, range.to).includes('**')
    )), false);
    assert.equal(
        markdownAnnotationRangeMatchesSource(
            conclusions,
            conclusionsAnnotation.ranges,
            conclusionsAnnotation.text
        ),
        true
    );

    const link = 'See [paper](https://x.org/a) now.';
    const linkAnnotation = await highlightedAnnotation(link, (document, ownerWindow) => {
        const content = document.querySelector('.cm-content');
        const start = textNodeContaining(content, 'paper');
        const end = textNodeContaining(content, 'now.');
        selectAndHighlight(document, ownerWindow, range => {
            range.setStart(start, start.textContent.indexOf('per'));
            range.setEnd(end, end.textContent.indexOf('now.') + 'now.'.length);
        }, '#2ea8e5', end);
    });
    assert.equal(linkAnnotation.text, 'per now.');
    assert.equal(linkAnnotation.ranges.some(range => (
        link.slice(range.from, range.to).includes('](')
    )), false);
    assert.equal(
        markdownAnnotationRangeMatchesSource(
            link,
            linkAnnotation.ranges,
            linkAnnotation.text
        ),
        true
    );
});

test('a previously stored partial-mark annotation still matches its old text', () => {
    const markdown = 'We report **strong results** today.';
    const to = markdown.indexOf('strong results') + 'strong results'.length;
    assert.equal(
        markdownAnnotationRangeMatchesSource(
            markdown,
            [{ from: 0, to }],
            'We report **strong results'
        ),
        true
    );
    const table = '<table><tr><td colspan="2">td</td></tr></table>';
    const tagFrom = table.indexOf('<td') + 1;
    assert.equal(table.slice(tagFrom, tagFrom + 2), 'td');
    assert.equal(
        markdownAnnotationRangeMatchesSource(
            table,
            [{ from: tagFrom, to: tagFrom + 2 }],
            'td'
        ),
        true
    );
});

test('selecting python in a fenced code body does not save the info string', async () => {
    const markdown = 'Intro.\n\n```python\nprint(python)\n```\n';
    const annotation = await highlightedAnnotation(markdown, (document, ownerWindow) => {
        const code = document.querySelector('.cm-mktero-code-block code');
        const node = textNodeContaining(code, 'print(python)');
        const offset = node.textContent.indexOf('python');
        selectText(document, ownerWindow, node, offset, offset + 'python'.length);
    });
    const bodyPython = markdown.indexOf('print(python)') + 'print('.length;
    assert.equal(annotation.text, 'python');
    assert.deepEqual(annotation.ranges, [{
        from: bodyPython,
        to: bodyPython + 'python'.length,
    }]);
    assert.equal(
        markdownAnnotationRangeMatchesSource(
            markdown,
            annotation.ranges,
            annotation.text
        ),
        true
    );
});

test('an HTML table cell selection maps the rendered text, not tags or entities', async () => {
    const entity = '<table><tr><td>A &amp; B</td></tr></table>';
    const entityAnnotation = await highlightedAnnotation(
        entity,
        (document, ownerWindow) => {
            const cell = document.querySelector('.cm-mktero-html-table td');
            const node = textNodeContaining(cell, 'A');
            selectText(document, ownerWindow, node, 0, node.textContent.length);
        }
    );
    const entityFrom = entity.indexOf('A &amp; B');
    assert.equal(entityAnnotation.text, 'A & B');
    assert.deepEqual(entityAnnotation.ranges, [{
        from: entityFrom,
        to: entityFrom + 'A &amp; B'.length,
    }]);
    assert.equal(
        markdownAnnotationRangeMatchesSource(
            entity,
            entityAnnotation.ranges,
            entityAnnotation.text
        ),
        true
    );

    const tagged = '<table><tr><td>A &amp; B</td><td colspan="2">td</td></tr></table>';
    const taggedAnnotation = await highlightedAnnotation(
        tagged,
        (document, ownerWindow) => {
            const cell = [...document.querySelectorAll('.cm-mktero-html-table td')]
                .find(candidate => candidate.textContent === 'td');
            const node = textNodeContaining(cell, 'td');
            selectText(document, ownerWindow, node, 0, node.textContent.length);
        }
    );
    const taggedFrom = tagged.lastIndexOf('>td<') + 1;
    assert.equal(taggedAnnotation.text, 'td');
    assert.deepEqual(taggedAnnotation.ranges, [{
        from: taggedFrom,
        to: taggedFrom + 2,
    }]);

    const colspan = '<table><tr><td colspan="2">2</td></tr></table>';
    const colspanAnnotation = await highlightedAnnotation(
        colspan,
        (document, ownerWindow) => {
            const node = textNodeContaining(
                document.querySelector('.cm-mktero-html-table td'),
                '2'
            );
            const offset = node.textContent.indexOf('2');
            selectText(document, ownerWindow, node, offset, offset + 1);
        }
    );
    const colspanFrom = colspan.indexOf('>2<') + 1;
    assert.equal(colspanAnnotation.text, '2');
    assert.deepEqual(colspanAnnotation.ranges, [{
        from: colspanFrom,
        to: colspanFrom + 1,
    }]);
    assert.equal(
        markdownAnnotationRangeMatchesSource(
            colspan,
            colspanAnnotation.ranges,
            colspanAnnotation.text
        ),
        true
    );
});

test('selecting the plain cell after inline math in a table opens a highlight', async () => {
    const markdown = '| $x$ | x |\n| --- | --- |\n';
    const annotation = await highlightedAnnotation(markdown, (document, ownerWindow) => {
        const cells = [...document.querySelectorAll('.cm-mktero-table th, .cm-mktero-table td')];
        const node = textNodeContaining(cells[1], 'x');
        selectText(document, ownerWindow, node, 0, node.textContent.length);
    });
    const from = markdown.indexOf('| x |') + '| '.length;
    assert.equal(annotation.text, 'x');
    assert.deepEqual(annotation.ranges, [{ from, to: from + 1 }]);
    assert.equal(markdown.slice(from, from + 1), 'x');
    assert.equal(
        markdownAnnotationRangeMatchesSource(
            markdown,
            annotation.ranges,
            annotation.text
        ),
        true
    );
});

// A cell formula renders as glyphs ("a/b" stacked, "ŷ"), so the cell text
// cannot be found in its Markdown. The selection maps by position instead.
test('a table cell selection across a formula opens a highlight and shows it', async () => {
    const gfm = '| Metric | Value |\n| --- | --- |\n| ratio $\\frac{a}{b}$ grows fast | 3 |\n';
    const html = '<table><tr><td>Metric</td><td>Value</td></tr>'
        + '<tr><td>estimate $\\hat{y}_{t+1}$ is close</td><td>3</td></tr></table>';
    for (const [markdown, first, last, formula] of [
        [gfm, 'ratio', 'grows fast', '$\\frac{a}{b}$'],
        [html, 'estimate', 'is close', '$\\hat{y}_{t+1}$'],
    ]) {
        const created = [];
        const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
            pretendToBeVisual: true,
        });
        const { document } = dom.window;
        const editor = createInlineMarkdownEditor({
            parent: document.querySelector('#editor'),
            initialMarkdown: markdown,
            resolveImageURL: () => null,
            createMarkdownAnnotation: async annotation => {
                created.push(annotation);
                return annotation;
            },
        });
        const cell = [...document.querySelectorAll('td')]
            .find(candidate => candidate.textContent.includes(last));
        const start = textNodeContaining(cell, first);
        const end = textNodeContaining(cell, last);
        selectAndHighlight(document, dom.window, range => {
            range.setStart(start, start.textContent.indexOf(first));
            range.setEnd(end, end.textContent.indexOf(last) + last.length);
        }, '#ffd400', start);
        await Promise.resolve();
        await Promise.resolve();

        assert.equal(created.length, 1, markdown);
        const from = markdown.indexOf(first);
        const to = markdown.indexOf(last) + last.length;
        assert.deepEqual(created[0].ranges, [{ from, to }]);
        assert.ok(markdown.slice(from, to).includes(formula));
        assert.equal(
            markdownAnnotationRangeMatchesSource(
                markdown,
                created[0].ranges,
                created[0].text
            ),
            true
        );

        editor.setDocument({
            markdown,
            annotationOverlay: {
                matched: [{
                    id: 'CELL0001',
                    type: 'highlight',
                    comment: '',
                    color: '#ffd400',
                    ...created[0],
                }],
                unmatched: [],
            },
        });
        const highlights = document.querySelectorAll(
            'td .cm-mktero-pdf-annotation'
        );
        assert.equal(highlights.length, 1, markdown);
        assert.ok(highlights[0].querySelector('.math-inline'));
        const shown = visibleText(highlights[0]);
        assert.ok(shown.startsWith(first) && shown.endsWith(last), shown);

        editor.destroy();
        dom.window.close();
    }
});

// The renderer typesets formulas only in a cell outside `code`. A caption or
// code keeps showing `$…$`, so its saved text keeps it and still matches.
test('a selection over an untypeset formula in an HTML table keeps matching', async () => {
    for (const [markdown, selector] of [
        ['<table><caption>rate $\\Delta$ high</caption><tr><td>A</td></tr></table>', 'caption'],
        ['<table><tr><td><code>rate $\\Delta$ high</code></td></tr></table>', 'td code'],
    ]) {
        const annotation = await highlightedAnnotation(markdown, (document, ownerWindow) => {
            const element = document.querySelector(`.cm-mktero-html-table ${selector}`);
            const node = textNodeContaining(element, 'rate');
            selectText(document, ownerWindow, node, 0, node.textContent.length);
        });
        assert.ok(annotation, markdown);
        assert.equal(annotation.text, 'rate $\\Delta$ high', markdown);
        assert.equal(
            markdownAnnotationRangeMatchesSource(
                markdown,
                annotation.ranges,
                annotation.text
            ),
            true,
            markdown
        );
    }
});

test('a selection across two formula cells keeps one range and one mark per cell', async () => {
    const markdown = '| A | B |\n| --- | --- |\n| ratio $\\frac{a}{b}$ | grows $\\hat{y}$ fast |\n';
    const created = [];
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: markdown,
        resolveImageURL: () => null,
        createMarkdownAnnotation: async annotation => {
            created.push(annotation);
            return annotation;
        },
    });
    const cells = [...document.querySelectorAll('td')];
    const start = textNodeContaining(cells[0], 'ratio');
    const end = textNodeContaining(cells[1], 'grows');
    selectAndHighlight(document, dom.window, range => {
        range.setStart(start, start.textContent.indexOf('ratio'));
        range.setEnd(end, end.textContent.indexOf('grows') + 'grows'.length);
    }, '#ffd400', start);
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(created.length, 1);
    const firstFrom = markdown.indexOf('ratio');
    const secondFrom = markdown.indexOf('grows');
    assert.deepEqual(created[0].ranges, [
        { from: firstFrom, to: markdown.indexOf(' | grows') },
        { from: secondFrom, to: secondFrom + 'grows'.length },
    ]);
    assert.equal(created[0].text, 'ratio \\frac{a}{b} grows');

    editor.setDocument({
        markdown,
        annotationOverlay: {
            matched: [{
                id: 'CELLS001',
                type: 'highlight',
                color: '#ffd400',
                ...created[0],
                comment: 'Across cells',
            }],
            unmatched: [],
        },
    });
    const marks = [...document.querySelectorAll('td .cm-mktero-pdf-annotation')];
    assert.deepEqual(marks.map(mark => visibleText(mark)), ['ratio ab', 'grows']);
    assert.equal(
        document.querySelectorAll('.cm-mktero-pdf-annotation-note').length,
        1
    );

    editor.destroy();
    dom.window.close();
});

test('an indented code block maps a word on the first line to that line', async () => {
    const markdown = 'Intro.\n\n    foo one\n    foo two\n';
    const annotation = await highlightedAnnotation(markdown, (document, ownerWindow) => {
        const code = document.querySelector('.cm-mktero-code-block pre');
        const node = textNodeContaining(code, 'foo one');
        const offset = node.textContent.indexOf('foo one');
        selectText(document, ownerWindow, node, offset, offset + 'foo'.length);
    });
    const firstFoo = markdown.indexOf('foo one');
    assert.equal(annotation.text, 'foo');
    assert.deepEqual(annotation.ranges, [{ from: firstFoo, to: firstFoo + 3 }]);
});

test('an indented code block still opens a highlight for a word on one line', async () => {
    const markdown = 'Intro.\n\n    foo one\n    foo two\n';
    const annotation = await highlightedAnnotation(markdown, (document, ownerWindow) => {
        const code = document.querySelector('.cm-mktero-code-block pre');
        const node = textNodeContaining(code, 'one');
        const offset = node.textContent.indexOf('one');
        selectText(document, ownerWindow, node, offset, offset + 'one'.length);
    });
    const one = markdown.indexOf('one');
    assert.equal(annotation.text, 'one');
    assert.deepEqual(annotation.ranges, [{ from: one, to: one + 3 }]);
});

for (const [label, table] of [
    ['a formula', '<table><tr><td>$x^2$</td><td>plain</td></tr></table>'],
    ['an entity the mapping does not decode', '<table><tr><td>2 &times; 3</td><td>plain</td></tr></table>'],
    ['a caption', '<table><caption>Table 1</caption><tr><td>plain</td></tr></table>'],
]) {
    test(`a plain HTML table cell is still selectable next to ${label}`, async () => {
        const annotation = await highlightedAnnotation(table, (document, ownerWindow) => {
            const cell = [...document.querySelectorAll('.cm-mktero-html-table td')]
                .find(candidate => candidate.textContent.includes('plain'));
            const node = textNodeContaining(cell, 'plain');
            const offset = node.textContent.indexOf('plain');
            selectText(document, ownerWindow, node, offset, offset + 'plain'.length);
        });
        const from = table.indexOf('plain');
        assert.equal(annotation?.text, 'plain');
        assert.deepEqual(annotation.ranges, [{ from, to: from + 5 }]);
    });
}

function selectBetween(document, ownerWindow, start, startText, end, endText) {
    const content = document.querySelector('.cm-content');
    const startNode = textNodeContaining(content, start);
    const endNode = textNodeContaining(content, end);
    selectAndHighlight(document, ownerWindow, range => {
        range.setStart(startNode, startNode.textContent.indexOf(startText));
        range.setEnd(
            endNode,
            endNode.textContent.indexOf(endText) + endText.length
        );
    }, '#2ea8e5', endNode);
}

test('a selection over a hidden superscript wrapper saves the reader text', async () => {
    const cited = 'The Value<sup>2</sup> grows.\n\n<sup>2</sup> A note.';
    const citedAnnotation = await highlightedAnnotation(cited, (document, ownerWindow) => {
        selectBetween(document, ownerWindow, 'The Value', 'Value', ' grows.', ' grows');
    });
    assert.equal(citedAnnotation.text, 'Value2 grows');
    assert.equal(
        markdownAnnotationRangeMatchesSource(cited, citedAnnotation.ranges, citedAnnotation.text),
        true
    );

    const dagger = 'Alice Smith$^{\\dagger}$ wrote this.';
    const daggerAnnotation = await highlightedAnnotation(dagger, (document, ownerWindow) => {
        selectBetween(document, ownerWindow, 'Alice Smith', 'Smith', ' wrote this.', ' wrote');
    });
    assert.equal(daggerAnnotation.text, 'Smith† wrote');
    assert.equal(
        markdownAnnotationRangeMatchesSource(dagger, daggerAnnotation.ranges, daggerAnnotation.text),
        true
    );
});

test('an annotation stored with raw superscript markup still matches', () => {
    const cited = 'The Value<sup>2</sup> grows.\n\n<sup>2</sup> A note.';
    const dagger = 'Alice Smith$^{\\dagger}$ wrote this.';
    assert.equal(
        markdownAnnotationRangeMatchesSource(
            cited,
            [{ from: cited.indexOf('Value'), to: cited.indexOf(' grows') }],
            'Value<sup>2</sup>'
        ),
        true
    );
    assert.equal(
        markdownAnnotationRangeMatchesSource(
            dagger,
            [{ from: dagger.indexOf('Smith'), to: dagger.indexOf(' this') }],
            'Smith$^{\\dagger}$ wrote'
        ),
        true
    );
});

test('a selection across hidden page chrome saves separated words', async () => {
    const markdown = 'Hello\n\n12\n\nWorld';
    const chromeFrom = markdown.indexOf('\n\n12\n\n');
    const chromeTo = chromeFrom + '\n\n12\n\n'.length;
    const created = [];
    const dom = new JSDOM('<!doctype html><div id="editor"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const editor = createInlineMarkdownEditor({
        parent: document.querySelector('#editor'),
        initialMarkdown: '',
        createMarkdownAnnotation: async annotation => {
            created.push(annotation);
            return annotation;
        },
    });
    try {
        editor.setDocument({
            markdown,
            chromeRanges: [{ from: chromeFrom, to: chromeTo }],
        });
        selectBetween(document, dom.window, 'Hello', 'Hello', 'World', 'World');
        await Promise.resolve();
        await Promise.resolve();
    }
    finally {
        editor.destroy();
        dom.window.close();
    }
    assert.equal(created.length, 1);
    assert.equal(created[0].text, 'Hello World');
    assert.deepEqual(created[0].ranges, [
        { from: 0, to: chromeFrom },
        { from: chromeTo, to: markdown.length },
    ]);
    assert.equal(
        markdownAnnotationRangeMatchesSource(markdown, created[0].ranges, created[0].text),
        true
    );
    // Saved before segments were separated.
    assert.equal(
        markdownAnnotationRangeMatchesSource(markdown, created[0].ranges, 'HelloWorld'),
        true
    );
});

test('annotations stored before marks, cells and link titles were shown still match', () => {
    const marks = 'Alice Smith $^{*}$ and Lee$^{1,\\dagger}$ wrote.';
    assert.equal(
        markdownAnnotationRangeMatchesSource(
            marks,
            [{ from: marks.indexOf('Smith'), to: marks.indexOf(' wrote') }],
            'Smith $^{*}$ and Lee$^{1,\\dagger}$'
        ),
        true
    );
    const titled = 'See [the text](https://x.org "Title") now.';
    assert.equal(
        markdownAnnotationRangeMatchesSource(
            titled,
            [{ from: 0, to: titled.lastIndexOf('.') }],
            'See the text "Title" now'
        ),
        true
    );
    const table = '<table><tr><td>Alpha</td><td>Beta</td></tr></table>';
    const cells = [
        { from: table.indexOf('Alpha'), to: table.indexOf('Alpha') + 5 },
        { from: table.indexOf('Beta'), to: table.indexOf('Beta') + 4 },
    ];
    assert.equal(markdownAnnotationRangeMatchesSource(table, cells, 'AlphaBeta'), true);
    assert.equal(markdownAnnotationRangeMatchesSource(table, cells, 'Alpha Beta'), true);
});
