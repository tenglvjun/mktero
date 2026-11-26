import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidSourceMapEntry } from '../src/core/markdown-source-map.js';
import { projectSourceAnnotation } from '../src/editor/translation-presentation.js';
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

test('locates each sample annotation in its corresponding translated sentence', () => {
    const { sourceMap } = layout();
    const overlay = createPaperAnnotationOverlay(PAPER_MARKDOWN, PAPER_ANNOTATIONS, sourceMap);
    const { views } = createPaperTranslation(PAPER_MARKDOWN, PAPER_TRANSLATIONS_ZH_CN);
    const expected = new Map([
        ['PREVIEW1', '我们把阅读顺序看作版面块之间的成对排序问题，并在分栏约束下解码这个排序。'],
        ['PREVIEW2', '在 1,240 个标注页面上，该方法的 Kendall $\\tau$ 达到 0.947，段落顺序错误比几何基线相对减少 38%，在笔记本 CPU 上每页只多花约 12 ms。'],
        ['PREVIEW3', '它们快且可预测，但当一张图横跨两栏，或者图注放在图旁边而不是下方时就会出错。'],
        ['PREVIEW4', '它在混合三栏以上且带不规则插图的页面上仍然吃力，而且它的判断取决于上游块检测器的质量。'],
    ]);
    const located = new Map(overlay.matched.map(annotation => {
        const { ranges, fallback } = projectSourceAnnotation(annotation.ranges, {
            sourceMarkdown: PAPER_MARKDOWN,
            translatedMarkdown: views.translatedMarkdown,
            blockRanges: views.blockRanges,
        });
        assert.equal(fallback, 'sentence', annotation.id);
        assert.equal(ranges.length, 1, annotation.id);
        const [{ from, to }] = ranges;
        return [annotation.id, views.translatedMarkdown.slice(from, to)];
    }));
    assert.deepEqual(located, expected);
});

test('turns inline LaTeX into readable page text', () => {
    assert.equal(latexToText('b_i \\prec b_j'), 'bᵢ ≺ bⱼ');
    assert.equal(latexToText('\\tau'), 'τ');
});
