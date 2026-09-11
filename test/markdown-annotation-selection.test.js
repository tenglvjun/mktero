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

function selectAndHighlight(document, ownerWindow, target, color = '#2ea8e5') {
    const range = document.createRange();
    if (typeof target === 'function') {
        target(range);
    }
    else {
        range.selectNodeContents(target);
    }
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);
    const eventTarget = target.nodeType ? target : document.querySelector('.cm-content');
    eventTarget.dispatchEvent(new ownerWindow.MouseEvent('mouseup', {
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
