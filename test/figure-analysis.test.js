import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRestoredFigureDocument } from './helpers/restored-figure-fixture.js';
import { analyzeDocumentFigures } from '../src/figures/figure-analysis.js';
import { analyzeMarkdownFigureReferences } from '../src/markdown/markdown-figure-references.js';
import { extractMarkdownAssetOutline } from '../src/markdown/markdown-asset-outline.js';
import { createEvidenceSnippet } from '../src/markdown/markdown-evidence.js';
import {
    collectMarkdownTranslationBlocks, createDocumentTranslationViews,
} from '../src/markdown/markdown-translation-blocks.js';

test('shares one restored image and its identity across references, outline and evidence', async () => {
    const document = await makeRestoredFigureDocument();
    const { markdown, figureMap } = document;
    const figureViews = analyzeDocumentFigures(markdown, { figureMap });
    assert.equal(figureViews.length, 1);
    const figure = figureViews[0];
    assert.equal(figure.sourceId, figureMap.figures[0].id);
    assert.equal(figure.images.length, 1);
    const refs = analyzeMarkdownFigureReferences(markdown, { figureViews });
    assert.equal(refs.references.length, 1);
    assert.equal(refs.targets[0].sourceId, figure.sourceId);
    assert.equal(refs.targets[0].figure.source, figure.source);
    const outline = extractMarkdownAssetOutline(markdown, [], { figureViews });
    assert.equal(outline.length, 1);
    assert.equal(outline[0].sourceId, figure.sourceId);
    assert.equal(outline[0].imageSource, figure.assetPath);
    const snippet = createEvidenceSnippet({
        ...document, figureViews, target: { kind: 'block', ...figure.imageRange },
    });
    assert.ok(snippet.markdown.includes('Treatment response'));
    assert.deepEqual(snippet.locations, [figure.location]);
});

test('uses a unique panel label and falls back to the parent when it is ambiguous', async () => {
    const { markdown: original, figureMap } = await makeRestoredFigureDocument();
    const markdown = original + '\n\nSee Fig. 1a and Figure 1b.';
    const [figure] = figureMap.figures;
    figure.panels[0].label = '(a)';
    figure.panels[1].label = 'b';
    figure.panels[2].label = 'b';
    const figureViews = analyzeDocumentFigures(markdown, { figureMap });
    const refs = analyzeMarkdownFigureReferences(markdown, { figureViews });
    assert.equal(refs.references.length, 3);
    assert.deepEqual(refs.targets.find(target => target.key === '1a').location.bbox, figure.panels[0].bbox);
    assert.deepEqual(refs.targets.find(target => target.key === '1b').location.bbox, figure.visualBBox);
    assert.ok(refs.targets.every(target => target.sourceId === figure.id));
});

test('keeps restored and adjacent legacy figures separate, including an uncaptioned restored image', async () => {
    const document = await makeRestoredFigureDocument();
    const figure = document.figureMap.figures[0];
    const from = figure.render.range.from;
    const image = `![](${figure.render.assetPath})`;
    const markdown = document.markdown.slice(0, from) + image
        + '\n\n![](images/next.png)\n\nFigure 2. Independent result.';
    figure.label = null;
    figure.render.range = { from, to: from + image.length };
    figure.render.captionRanges = [];
    const views = analyzeDocumentFigures(markdown, { figureMap: document.figureMap });
    assert.equal(views.length, 2);
    assert.equal(views[0].sourceId, figure.id);
    assert.equal(views[1].caption.label, 'Figure 2.');
    assert.ok(!views[1].source.includes(figure.render.assetPath));
});

test('ignores corrupt metadata and refuses duplicate image anchors or stale caption labels', async () => {
    const document = await makeRestoredFigureDocument();
    for (const mutate of [
        map => { map.version = 99; },
        map => { map.figures[0].render.range.from++; },
        map => { map.figures[0].render.assetPath = '../bad.png'; },
        map => { map.figures[0].visualBBox = [0, 0, Infinity, 100]; },
        map => { map.figures[0].label = 'Figure 99.'; },
        map => { map.figures.push(structuredClone(map.figures[0])); },
    ]) {
        const figureMap = structuredClone(document.figureMap);
        mutate(figureMap);
        const views = analyzeDocumentFigures(document.markdown, { figureMap });
        assert.equal(views.length, 1);
        assert.equal(views[0].sourceId, null);
    }
    const duplicate = document.markdown + '\n\n' + document.markdown;
    assert.ok(analyzeDocumentFigures(duplicate, { figureMap: document.figureMap })
        .every(figure => figure.sourceId === null));
});

test('binds translated and comparison captions to actual output ranges with one complete image', async () => {
    const { markdown, figureMap } = await makeRestoredFigureDocument();
    const blocks = collectMarkdownTranslationBlocks(markdown);
    const translations = blocks.filter(block => block.translatable).map(block => ({
        id: block.id,
        markdown: block.requestMarkdown.replace('Treatment response in four panels.', 'Results in all four panels.'),
    }));
    const views = createDocumentTranslationViews(markdown, blocks, translations, { figureMap });
    const [translated] = views.translatedFigureViews;
    const [comparison] = views.comparisonFigureViews;
    assert.equal(views.translatedFigureViews.length, 1);
    assert.equal(views.comparisonFigureViews.length, 1);
    assert.equal(translated.sourceId, figureMap.figures[0].id);
    assert.equal(comparison.sourceId, translated.sourceId);
    assert.equal(translated.viewKind, 'translation');
    assert.equal(comparison.viewKind, 'comparison');
    assert.ok(translated.caption.text.includes('Results in all four panels.'));
    assert.equal(views.comparisonMarkdown.split(comparison.assetPath).length - 1, 1);
    assert.ok(comparison.translatedCaption.text.includes('Results in all four panels.'));
    assert.equal(views.comparisonMarkdown.slice(comparison.translatedCaption.from,
        comparison.translatedCaption.to), comparison.translatedCaption.text);
    assert.ok(comparison.source.includes(comparison.translatedCaption.text));
    assert.ok(blocks.every(block => !block.requestMarkdown?.includes('Time since treatment')));
    const unchanged = createDocumentTranslationViews(markdown, blocks,
        blocks.filter(block => block.translatable).map(block => ({
            id: block.id, markdown: block.requestMarkdown,
        })), { figureMap });
    assert.equal(unchanged.comparisonFigureViews[0].translatedCaption, null);
});
