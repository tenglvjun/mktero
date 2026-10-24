import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createMarkdownAnalysisCache,
    DEFAULT_ANALYSIS_NAMESPACE_LIMIT,
    computeAlignedMarkdownOutline,
    computeDocumentFigures,
    computeMarkdownFootnotes,
    headingLevelsForDocumentStructure,
} from '../src/markdown/markdown-analysis-cache.js';

test('reuses a cached analysis for the same Markdown string', () => {
    const cache = createMarkdownAnalysisCache();
    let calls = 0;
    const first = cache.compute('citations', '# Paper', [], () => {
        calls += 1;
        return { citations: [1, 2] };
    });
    const second = cache.compute('citations', '# Paper', [], () => {
        calls += 1;
        return { citations: [3] };
    });
    assert.equal(calls, 1);
    assert.equal(second, first);
    assert.deepEqual(cache.stats(), { hits: 1, misses: 1 });
});

test('separates namespaces that share one Markdown key', () => {
    const cache = createMarkdownAnalysisCache();
    const citations = cache.compute('citations', '# Paper', [], () => 'citations');
    const figures = cache.compute('figures', '# Paper', [], () => 'figures');
    assert.equal(citations, 'citations');
    assert.equal(figures, 'figures');
    assert.equal(cache.size(), 2);
});

test('keeps several dep-variants under one Markdown key', () => {
    const cache = createMarkdownAnalysisCache();
    let calls = 0;
    const outline = ranges => cache.compute(
        'outline',
        '# Paper',
        [ranges, 'title'],
        () => {
            calls += 1;
            return `outline:${ranges}`;
        }
    );
    // The comparison outline and the original outline read the same source
    // Markdown with different chrome ranges. Neither may evict the other.
    assert.equal(outline('source'), 'outline:source');
    assert.equal(outline('comparison'), 'outline:comparison');
    assert.equal(calls, 2);
    assert.equal(outline('source'), 'outline:source');
    assert.equal(outline('comparison'), 'outline:comparison');
    assert.equal(calls, 2, 'both variants stayed warm');
    assert.equal(cache.size(), 2);
});

test('bounds the variants kept under one key', () => {
    const cache = createMarkdownAnalysisCache({ variantLimit: 2 });
    const compute = variant => cache.compute('outline', '# Paper', [variant], () => variant);
    compute('a');
    compute('b');
    compute('c');
    assert.equal(cache.size(), 2);
    assert.equal(compute('a'), 'a');
    assert.equal(cache.stats().misses, 4, 'the oldest variant was dropped');
});

test('recomputes when an identity dependency changes', () => {
    const cache = createMarkdownAnalysisCache();
    const figureMapA = { id: 'a' };
    const figureMapB = { id: 'b' };
    const analyze = figureMap => cache.compute(
        'figures',
        '# Paper',
        [figureMap, 'comparison'],
        () => figureMap.id
    );
    assert.equal(analyze(figureMapA), 'a');
    assert.equal(analyze(figureMapA), 'a');
    assert.equal(analyze(figureMapB), 'b');
    assert.equal(cache.size(), 2);
});

test('recomputes when the dependency arity changes', () => {
    const cache = createMarkdownAnalysisCache();
    let calls = 0;
    const compute = deps => cache.compute('outline', '# Paper', deps, () => {
        calls += 1;
        return deps.length;
    });
    assert.equal(compute([]), 0);
    assert.equal(compute([null]), 1);
    assert.equal(calls, 2);
});

test('keeps the three views of one paper and evicts the least recently used', () => {
    const cache = createMarkdownAnalysisCache({ namespaceLimit: 3 });
    const compute = key => cache.compute('citations', key, [], () => `value:${key}`);
    compute('source');
    compute('translated');
    compute('comparison');
    assert.equal(cache.size(), 3);
    assert.deepEqual(cache.stats(), { hits: 0, misses: 3 });

    // All three views of one paper stay resident, so switching back is free.
    assert.equal(compute('source'), 'value:source');
    assert.equal(compute('comparison'), 'value:comparison');
    assert.equal(compute('translated'), 'value:translated');
    assert.deepEqual(cache.stats(), { hits: 3, misses: 3 });

    // Touching "source" last makes "comparison" the least recently used entry.
    compute('source');
    compute('fourth');
    assert.equal(cache.size(), 3);
    assert.equal(compute('comparison'), 'value:comparison');
    assert.equal(cache.stats().misses, 5, 'comparison was evicted and recomputed');
    assert.equal(compute('source'), 'value:source');
    assert.equal(cache.stats().hits, 5, 'source survived the eviction');
});

test('honours the default namespace limit', () => {
    const cache = createMarkdownAnalysisCache();
    for (let index = 0; index < DEFAULT_ANALYSIS_NAMESPACE_LIMIT + 2; index++) {
        cache.compute('citations', `doc-${index}`, [], () => index);
    }
    assert.equal(cache.size(), DEFAULT_ANALYSIS_NAMESPACE_LIMIT);
});

test('clamps an out-of-range limit', () => {
    const zero = createMarkdownAnalysisCache({ namespaceLimit: 0 });
    zero.compute('citations', 'a', [], () => 1);
    zero.compute('citations', 'b', [], () => 2);
    assert.equal(zero.size(), 1);

    const invalid = createMarkdownAnalysisCache({
        namespaceLimit: Number.NaN,
        variantLimit: Number.NaN,
    });
    invalid.compute('citations', 'a', [], () => 1);
    invalid.compute('citations', 'b', [], () => 2);
    assert.equal(invalid.size(), 2);
    invalid.compute('citations', 'c', [], () => 3);
    invalid.compute('citations', 'd', [], () => 4);
    invalid.compute('citations', 'e', [], () => 5);
    assert.equal(
        invalid.size(),
        DEFAULT_ANALYSIS_NAMESPACE_LIMIT,
        'an invalid limit falls back to the default'
    );
});

test('bypasses the cache for unusable keys', () => {
    const cache = createMarkdownAnalysisCache();
    let calls = 0;
    const factory = () => {
        calls += 1;
        return calls;
    };
    assert.equal(cache.compute('citations', '', [], factory), 1);
    assert.equal(cache.compute('citations', null, [], factory), 2);
    assert.equal(cache.compute('citations', 42, [], factory), 3);
    assert.equal(cache.size(), 0);
    assert.equal(cache.compute('citations', '# Paper', [], null), undefined);
});

test('clear drops every entry and counter', () => {
    const cache = createMarkdownAnalysisCache();
    cache.compute('citations', '# Paper', [], () => 1);
    cache.compute('citations', '# Paper', [], () => 1);
    assert.equal(cache.size(), 1);
    cache.clear();
    assert.equal(cache.size(), 0);
    assert.deepEqual(cache.stats(), { hits: 0, misses: 0 });
});

test('computeDocumentFigures ignores viewRanges for the original view', () => {
    // The comparison outline analyses the source document again with the same
    // viewKind but different viewRanges. analyzeDocumentFigures ignores
    // viewRanges for the original view, so those must share one entry.
    const cache = createMarkdownAnalysisCache();
    const figureMap = { figures: [] };
    const first = computeDocumentFigures(cache, '# Paper', {
        figureMap,
        viewRanges: null,
        viewKind: 'original',
    });
    assert.ok(Array.isArray(first));
    const second = computeDocumentFigures(cache, '# Paper', {
        figureMap,
        viewRanges: [{ id: 'block' }],
        viewKind: 'original',
    });
    assert.equal(second, first, 'viewRanges does not create a second variant');
    assert.deepEqual(cache.stats(), { hits: 1, misses: 1 });
    assert.equal(cache.size(), 1);
});

test('computeDocumentFigures keeps one variant per translated view kind', () => {
    const cache = createMarkdownAnalysisCache();
    const figureMap = { figures: [] };
    const viewRanges = [{ id: 'block' }];
    const translation = computeDocumentFigures(cache, '# Paper', {
        figureMap,
        viewRanges,
        viewKind: 'translation',
    });
    const comparison = computeDocumentFigures(cache, '# Paper', {
        figureMap,
        viewRanges,
        viewKind: 'comparison',
    });
    assert.notEqual(translation, comparison);
    assert.equal(
        computeDocumentFigures(cache, '# Paper', {
            figureMap,
            viewRanges,
            viewKind: 'translation',
        }),
        translation
    );
    assert.equal(cache.stats().hits, 1);
    assert.equal(cache.size(), 2);
});

test('computeMarkdownFootnotes reuses one analysis per Markdown string', () => {
    const cache = createMarkdownAnalysisCache();
    const markdown = [
        'A claim $^{1}$.',
        '',
        '<!-- mktero-note: footnote -->',
        '> $^{1}$ The source.',
    ].join('\n');
    const first = computeMarkdownFootnotes(cache, markdown);
    const second = computeMarkdownFootnotes(cache, markdown);
    assert.equal(second, first);
    assert.equal(first.notes.length, 1);
    assert.equal(first.notes[0].key, '1');
    assert.equal(cache.stats().hits, 1);
    assert.equal(cache.stats().misses, 1);

    const direct = computeMarkdownFootnotes(null, markdown);
    assert.notEqual(direct, first);
    assert.equal(direct.notes[0].key, '1');

    const other = computeMarkdownFootnotes(cache, `${markdown}\n`);
    assert.notEqual(other, first);
    assert.equal(cache.stats().misses, 2);
});

test('the compute helpers work without a cache', () => {
    const figures = computeDocumentFigures(null, '# Paper\n\n![Figure 1](a.png)', {});
    assert.ok(Array.isArray(figures));
});

test('keeps producer heading levels for a structured document outline', () => {
    const markdown = '# Paper\n\n## 1 Introduction\n\nText.\n\n### 1.1 Scope\n\nText.\n\n## 2 Methods\n\nText.';
    assert.equal(headingLevelsForDocumentStructure('mineru-ir-v1'), 'structural');
    assert.equal(headingLevelsForDocumentStructure(undefined), 'inferred');
    const cache = createMarkdownAnalysisCache();
    const structural = computeAlignedMarkdownOutline(cache, markdown, { headingLevels: 'structural' });
    assert.deepEqual(structural.map(heading => heading.level), [1, 2, 3, 2]);
    const inferred = computeAlignedMarkdownOutline(cache, markdown);
    assert.notEqual(inferred, structural);
});
