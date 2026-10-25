import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createInlineMarkdownEditor } from '../src/editor/inline-markdown-editor.js';
import { markdownAnnotationRangeMatchesSource } from '../src/core/markdown-local-annotations.js';
import { normalizePdfAnnotationText } from '../src/markdown/pdf-annotation-text.js';

async function highlight(markdown, select) {
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
        const range = document.createRange();
        const mouseTarget = select(document, range);
        document.getSelection().removeAllRanges();
        document.getSelection().addRange(range);
        mouseTarget.dispatchEvent(new dom.window.MouseEvent('mouseup', {
            bubbles: true,
            button: 0,
        }));
        const actions = document.querySelector('.mktero-markdown-selection-actions');
        if (!actions) return null;
        actions.querySelector('[data-color="#2ea8e5"]').click();
        // The create is asynchronous; wait for it instead of a fixed number
        // of microtasks, which a loaded test run can outlast.
        for (let attempt = 0; attempt < 50 && !created.length; attempt++) {
            await new Promise(resolve => setImmediate(resolve));
        }
        return created[0] || null;
    }
    finally {
        editor.destroy();
        dom.window.close();
    }
}

function textNode(root, text) {
    const walker = root.ownerDocument.createTreeWalker(
        root,
        root.ownerDocument.defaultView.NodeFilter.SHOW_TEXT
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent.includes(text)) return node;
    }
    return null;
}

test('a selection across a page-boundary comment maps the text on both sides', async () => {
    const markdown = [
        'First paragraph ends here.',
        '',
        '<!-- zotero-page: 2 -->',
        '',
        'Second paragraph starts here.',
    ].join('\n');
    const annotation = await highlight(markdown, (document, range) => {
        const content = document.querySelector('.cm-content');
        assert.ok(content.querySelector('.page-marker'), 'page marker renders');
        const start = textNode(content, 'ends here');
        const end = textNode(content, 'starts here');
        range.setStart(start, start.textContent.indexOf('ends'));
        range.setEnd(end, end.textContent.indexOf('starts') + 'starts'.length);
        return content;
    });

    assert.ok(annotation, 'the popup opens for a selection across a page break');
    assert.doesNotMatch(annotation.text, /zotero-page|<!--/);
    assert.match(annotation.text, /^ends here\.\s+Second paragraph starts$/);
    const comment = markdown.indexOf('<!--');
    for (const range of annotation.ranges) {
        assert.ok(range.to <= comment || range.from >= markdown.indexOf('-->') + 3);
    }
    assert.equal(
        markdownAnnotationRangeMatchesSource(
            markdown,
            annotation.ranges,
            annotation.text
        ),
        true
    );
});

test('a selection that ends at the start of the next block stays in its block', async () => {
    const markdown = 'First paragraph text.\n\nSecond paragraph.';
    const annotation = await highlight(markdown, (document, range) => {
        const lines = [...document.querySelectorAll('.cm-line')];
        const first = textNode(lines[0], 'First');
        const second = textNode(lines.at(-1), 'Second');
        range.setStart(first, 0);
        range.setEnd(second, 0);
        return document.querySelector('.cm-content');
    });

    const blockEnd = markdown.indexOf('\n');
    assert.equal(annotation.text, 'First paragraph text.');
    assert.deepEqual(annotation.ranges, [{ from: 0, to: blockEnd }]);
});

function selectAcross(content, startText, endText, startOffset = 0) {
    return (document, range) => {
        const root = document.querySelector(content);
        const start = textNode(root, startText);
        const end = textNode(root, endText);
        range.setStart(start, start.textContent.indexOf(startText) + startOffset);
        range.setEnd(end, end.textContent.indexOf(endText) + endText.length);
        return document.querySelector('.cm-content');
    };
}

function assertMatchesSource(markdown, annotation) {
    assert.equal(
        markdownAnnotationRangeMatchesSource(markdown, annotation.ranges, annotation.text),
        true
    );
}

test('a selection across two HTML table cells saves one space between them', async () => {
    const markdown = '<table><tr><td>Alpha</td><td>Beta</td></tr></table>\n\nAfter.';
    const annotation = await highlight(markdown, selectAcross('.cm-mktero-html-table', 'Alpha', 'Beta'));

    assert.equal(annotation.text, 'Alpha Beta');
    assert.deepEqual(annotation.ranges.map(range => markdown.slice(range.from, range.to)), ['Alpha', 'Beta']);
    assertMatchesSource(markdown, annotation);
    // Saved before cells were separated.
    assert.equal(markdownAnnotationRangeMatchesSource(markdown, annotation.ranges, 'AlphaBeta'), true);
});

test('a selection over a footnote superscript saves the glyphs the reader shows', async () => {
    for (const [markdown, expected] of [
        ['Alice Smith $^{*}$ wrote this.', 'Smith∗ wrote'],
        ['Alice Smith$^{\\ast}$ wrote this.', 'Smith∗ wrote'],
        ['Alice Smith $^{\\star}$ wrote this.', 'Smith⋆ wrote'],
        ['Alice Smith $^{a,*}$ wrote this.', 'Smitha,∗ wrote'],
        ['Alice Smith $^{\\S}$ wrote this.', 'Smith§ wrote'],
        ['Alice Smith $^{\\#}$ wrote this.', 'Smith# wrote'],
        ['Alice Smith $^{\\dag}$ wrote this.', 'Smith† wrote'],
        ['Alice Smith$^{1,\\dagger}$ wrote this.', 'Smith1,† wrote'],
        [
            'Alice Smith$^{\\star}$ wrote this.\n\n<!-- mktero-note: footnote -->\n> $^{\\star}$ Corresponding author.',
            'Smith* wrote',
        ],
    ]) {
        const annotation = await highlight(markdown, selectAcross('.cm-content', 'Smith', ' wrote'));
        assert.equal(annotation?.text, expected, markdown);
        assertMatchesSource(markdown, annotation);
    }
    // Stored raw before the glyphs were saved.
    const raw = 'Alice Smith $^{\\star}$ wrote this.';
    assert.equal(
        markdownAnnotationRangeMatchesSource(
            raw,
            [{ from: raw.indexOf('Smith'), to: raw.indexOf(' this') }],
            'Smith $^{\\star}$ wrote'
        ),
        true
    );
});

test('a link selection leaves out the title and the autolink marks', async () => {
    const titled = 'See [the text](https://x.org "Title") now.';
    const titledAnnotation = await highlight(titled, selectAcross('.cm-content', 'See', 'now'));
    assert.equal(titledAnnotation.text, 'See the text now');
    assertMatchesSource(titled, titledAnnotation);

    const autolink = 'Visit <https://x.org/a> today.';
    const autolinkAnnotation = await highlight(autolink, selectAcross('.cm-content', 'Visit', 'today'));
    assert.equal(autolinkAnnotation.text, 'Visit https://x.org/a today');
    for (const range of autolinkAnnotation.ranges) {
        assert.doesNotMatch(autolink.slice(range.from, range.to), /[<>]/u);
    }
    assertMatchesSource(autolink, autolinkAnnotation);
});

test('a footnote link with several marks shows and saves all of them', async () => {
    const markdown = [
        'Alice Smith$^{1,\\dagger}$ wrote this.',
        '',
        '<!-- mktero-note: footnote -->',
        '> $^{1}$ First note.',
        '',
        '<!-- mktero-note: footnote -->',
        '> $^{\\dagger}$ Corresponding author.',
    ].join('\n');
    const annotation = await highlight(markdown, (document, range) => {
        const line = document.querySelector('.cm-line');
        // The link shows every mark, as the PDF prints them.
        assert.deepEqual(
            [...line.querySelectorAll('.cm-mktero-footnote-ref')].map(mark => mark.textContent),
            ['1,†']
        );
        const start = textNode(line, 'Smith');
        const end = textNode(line, ' wrote');
        range.setStart(start, start.textContent.indexOf('Smith'));
        range.setEnd(end, end.textContent.indexOf(' wrote') + ' wrote'.length);
        return line;
    });

    assert.equal(annotation?.text, 'Smith1,† wrote');
    assert.equal(
        normalizePdfAnnotationText(annotation.text),
        normalizePdfAnnotationText('Smith1,† wrote')
    );
    assert.equal(
        markdownAnnotationRangeMatchesSource(markdown, annotation.ranges, annotation.text),
        true
    );
});
