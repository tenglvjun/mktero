import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidSourceMapEntry } from '../src/core/markdown-source-map.js';
import {
    createPaperAnnotationOverlay,
    createPaperSourceMap,
    createPaperTranslation,
    latexToText,
    layoutPaperPages,
    segmentPaperMarkdown,
    toPlaceholderMarkdown,
} from '../preview/document.js';
import {
    PAPER_ANNOTATIONS,
    PAPER_MARKDOWN,
    PAPER_TRANSLATIONS_ZH_CN,
} from '../preview/fixture/paper.js';

// Close enough to a serif face for layout; the browser measures real glyphs.
const measure = (text, style) => text.length * style.size * 0.47;

function layout() {
    const segments = segmentPaperMarkdown(PAPER_MARKDOWN);
    const pages = layoutPaperPages(segments, { measure });
    return { segments, pages, sourceMap: createPaperSourceMap(segments, pages) };
}

test('segments cover the sample paper without gaps', () => {
    const { segments } = layout();
    assert.equal(segments[0].kind, 'title');
    assert.equal(segments.at(-1).kind, 'reference');
    for (const segment of segments) {
        assert.equal(PAPER_MARKDOWN.slice(segment.from, segment.to), segment.markdown);
    }
    assert.ok(segments.some(segment => segment.kind === 'math'));
    assert.ok(segments.some(segment => segment.kind === 'code'));
    assert.ok(segments.some(segment => segment.kind === 'table'));
    assert.ok(segments.some(segment => segment.kind === 'figure'));
});

test('lays the paper out on simulated pages with a valid source map', () => {
    const { segments, pages, sourceMap } = layout();
    assert.ok(pages.length >= 2);
    assert.equal(sourceMap.length, segments.length);
    for (const entry of sourceMap) {
        assert.equal(isValidSourceMapEntry(entry, PAPER_MARKDOWN.length), true, JSON.stringify(entry));
    }
    for (const page of pages) {
        for (const item of page.items) {
            assert.ok(item.y + item.height <= 792, `item overflows page ${page.index}`);
        }
    }
});

test('every translatable block has a translation the reader accepts', () => {
    const translation = createPaperTranslation(PAPER_MARKDOWN, PAPER_TRANSLATIONS_ZH_CN);
    assert.deepEqual(translation.missing, []);
    assert.deepEqual(translation.invalid, []);
    const used = new Set(translation.blocks
        .filter(block => block.translatable)
        .flatMap(block => [...PAPER_TRANSLATIONS_ZH_CN.keys()]
            .filter(prefix => block.markdown.startsWith(prefix))));
    assert.deepEqual([...PAPER_TRANSLATIONS_ZH_CN.keys()].filter(key => !used.has(key)), []);
    assert.match(translation.views.translatedMarkdown, /为多栏科学 PDF 学习阅读顺序/);
    assert.match(translation.views.translatedMarkdown, /Kendall \$\\tau\$ 达到 0\.947/);
});

test('rejects a translation that drops a protected fragment', () => {
    const translation = createPaperTranslation(PAPER_MARKDOWN, PAPER_TRANSLATIONS_ZH_CN);
    const block = translation.blocks.find(candidate => candidate.markdown.startsWith('For each pair of blocks'));
    assert.throws(() => toPlaceholderMarkdown(block, '对于每一对块，一个小网络估计概率：'), /protected fragment/);
});

test('matches every sample annotation to the Markdown and a page', () => {
    const { sourceMap } = layout();
    const overlay = createPaperAnnotationOverlay(PAPER_MARKDOWN, PAPER_ANNOTATIONS, sourceMap);
    assert.equal(overlay.unmatched.length, 0);
    assert.equal(overlay.matched.length, PAPER_ANNOTATIONS.length);
    for (const annotation of overlay.matched) {
        const [range] = annotation.ranges;
        assert.equal(PAPER_MARKDOWN.slice(range.from, range.to), annotation.text);
        assert.ok(Number.isInteger(annotation.pageIndex));
    }
});

test('turns inline LaTeX into readable page text', () => {
    assert.equal(latexToText('b_i \\prec b_j'), 'bᵢ ≺ bⱼ');
    assert.equal(latexToText('\\tau'), 'τ');
});
