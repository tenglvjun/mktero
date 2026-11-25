import test from 'node:test';
import assert from 'node:assert/strict';
import {
    projectSourceAnnotation,
    projectSourceAnnotationRanges,
} from '../src/editor/translation-presentation.js';
import {
    collectMarkdownTranslationBlocks,
    createDocumentTranslationViews,
    mapAlignedTranslationSelection,
} from '../src/markdown/markdown-translation-blocks.js';
import { assembleAlignedBlock, createAlignmentPlan } from '../src/markdown/translation-alignment.js';
import { createVisibleMarkdownTextIndex } from '../src/markdown/markdown-visible-text.js';

function viewRange({ translatedFrom: from, translatedTo: to }) {
    return { from, to };
}

function singleBlock(sourceMarkdown, translatedMarkdown, details = {}) {
    return {
        sourceMarkdown,
        translatedMarkdown,
        blockRanges: [{
            sourceFrom: 0,
            sourceTo: sourceMarkdown.length,
            translatedFrom: 0,
            translatedTo: translatedMarkdown.length,
            ...details,
        }],
    };
}

test('projects whole legacy and aligned blocks in a selection spanning several blocks', () => {
    const sourceMarkdown = 'Before that.\n\nLegacy source.\n\nAccuracy improved. Latency fell.\n\nAfter that.';
    const blocks = collectMarkdownTranslationBlocks(sourceMarkdown);
    const { units } = createAlignmentPlan(blocks[2]);
    const aligned = assembleAlignedBlock(blocks[2], [
        { id: units[0].id, translatedMarkdown: '\u51c6\u786e\u7387\u63d0\u9ad8\u4e86\u3002' },
        { id: units[1].id, translatedMarkdown: '\u5ef6\u8fdf\u4e0b\u964d\u4e86\u3002' },
    ], 'zh-CN');
    const views = createDocumentTranslationViews(sourceMarkdown, blocks, [
        { id: blocks[0].id, markdown: 'An earlier item.' },
        { id: blocks[1].id, markdown: 'A longer legacy translation.' },
        aligned,
        { id: blocks[3].id, markdown: 'A later item.' },
    ], { targetLanguage: 'zh-CN' });
    const { blockRanges } = views;
    assert.equal(blockRanges[2].alignmentUnits.length, 2);
    const sourceRanges = Object.freeze([Object.freeze({ from: 1, to: sourceMarkdown.length - 1 })]);
    assert.deepEqual(projectSourceAnnotationRanges(sourceRanges, { sourceMarkdown, ...views }), [
        viewRange(blockRanges[1]),
        viewRange(blockRanges[2]),
    ]);
});

test('maps disjoint verbatim subranges by offset, including failed source blocks', () => {
    const sourceMarkdown = 'Lead.\n\nThis is left untranslated.\n\n`x_2`';
    const translatedMarkdown = 'A longer introduction.\n\nThis is left untranslated.\n\n`x_2`';
    const failed = {
        sourceFrom: sourceMarkdown.indexOf('This'),
        sourceTo: sourceMarkdown.indexOf('\n\n`'),
        translatedFrom: translatedMarkdown.indexOf('This'),
        translatedTo: translatedMarkdown.indexOf('\n\n`'),
        sourceFallback: true,
    };
    const code = {
        sourceFrom: failed.sourceTo + 2, sourceTo: sourceMarkdown.length,
        translatedFrom: failed.translatedTo + 2, translatedTo: translatedMarkdown.length,
    };
    const shifted = (block, from, to) => ({ from: block.translatedFrom + from, to: block.translatedFrom + to });
    const later = { from: failed.sourceFrom + 8, to: failed.sourceFrom + 12 };
    assert.deepEqual(projectSourceAnnotationRanges([
        { from: code.sourceFrom + 1, to: code.sourceTo - 1 },
        later,
        { from: failed.sourceFrom, to: failed.sourceFrom + 4 },
        { ...later },
    ], { sourceMarkdown, translatedMarkdown, blockRanges: [failed, code] }), [
        shifted(failed, 0, 4), shifted(failed, 8, 12), shifted(code, 1, 4),
    ]);
});

test('accepts visible whole blocks after PDF round trips, but not missing visible text', () => {
    for (const [source, translated] of [
        ['## **Full heading** ##', '## **Titre complet** ##'],
        ['**A full paragraph.**', '**Un paragraphe complet.**'],
        ['A heading\n---------', 'Un titre\n--------'],
    ]) {
        const index = createVisibleMarkdownTextIndex(source, [], { imageMath: true });
        const text = index.text.trim();
        const { from, to } = index.sourceRange(index.text.indexOf(text), text.length);
        const view = singleBlock(source, translated);
        assert.ok(from > 0 || to < source.length, source);
        assert.deepEqual(projectSourceAnnotationRanges([{ from, to }], view), [viewRange(view.blockRanges[0])]);
        assert.deepEqual(projectSourceAnnotationRanges([{ from: from + 1, to }], view), []);
        assert.deepEqual(projectSourceAnnotationRanges([{ from, to: to - 1 }], view), []);
        assert.deepEqual(projectSourceAnnotationRanges([{ from, to: from + 1 }, { from: from + 2, to }], view), []);
    }
    assert.deepEqual(projectSourceAnnotationRanges([{ from: 1, to: 8 }], singleBlock('*literal', '*mot')), []);
});

test('does not guess partial legacy matches even with a shared substring and equal lengths', () => {
    const view = singleBlock('word rose.', 'word fell.');
    assert.deepEqual(projectSourceAnnotationRanges([{ from: 0, to: 4 }], view), []);
    assert.deepEqual(projectSourceAnnotationRanges([{ from: 0, to: 10 }], view), [{ from: 0, to: 10 }]);
});

test('projects sentence-contained annotations and does not infer alignment from old or damaged records', () => {
    const sourceMarkdown = 'Fig. 2 rose. Latency fell. Accuracy improved.';
    const [block] = collectMarkdownTranslationBlocks(sourceMarkdown);
    const { units } = createAlignmentPlan(block);
    const aligned = assembleAlignedBlock(block, [
        { id: units[0].id, translatedMarkdown: 'La fig. 2 monte.' },
        { id: units[1].id, translatedMarkdown: 'La latence diminue.' },
        { id: units[2].id, translatedMarkdown: 'La pr\u00e9cision augmente.' },
    ], 'fr-FR');
    const viewFor = translation => ({
        sourceMarkdown,
        ...createDocumentTranslationViews(sourceMarkdown, [block], [translation], { targetLanguage: 'fr-FR' }),
    });
    const view = viewFor(aligned);
    const [first, second, third] = view.blockRanges[0].alignmentUnits;
    const [from, to] = [second.sourceRanges[0].from, second.sourceRanges[0].to];
    assert.deepEqual(projectSourceAnnotationRanges([{ from, to }], view), [viewRange(second)]);
    assert.deepEqual(projectSourceAnnotationRanges([{ from, to: to - 1 }], view), [viewRange(second)]);
    const thirdFrom = third.sourceRanges[0].from;
    assert.deepEqual(projectSourceAnnotationRanges([{
        from: thirdFrom + 1,
        to: thirdFrom + 3,
    }], view), [viewRange(third)]);
    assert.deepEqual(projectSourceAnnotationRanges([{ from: 0, to: from + 1 }], view), [viewRange(first)]);
    assert.deepEqual(projectSourceAnnotationRanges([...third.sourceRanges, ...first.sourceRanges], view), [
        viewRange(first), viewRange(third),
    ]);
    assert.deepEqual(projectSourceAnnotationRanges([{ from, to }], viewFor({ id: block.id, markdown: aligned.markdown })), []);
    const damaged = structuredClone(aligned);
    damaged.alignment.units[1].sourceRanges[0].from++;
    assert.deepEqual(projectSourceAnnotationRanges([{ from, to }], viewFor(damaged)), []);
});

test('maps a partial annotation to its containing verified sentence', () => {
    const sourceMarkdown = 'The sample was retained. Accuracy improved.';
    const [block] = collectMarkdownTranslationBlocks(sourceMarkdown);
    const { units } = createAlignmentPlan(block);
    const aligned = assembleAlignedBlock(block, [
        { id: units[0].id, translatedMarkdown: '保留了样本。' },
        { id: units[1].id, translatedMarkdown: '准确性提高了。' },
    ], 'zh-CN');
    const views = createDocumentTranslationViews(
        sourceMarkdown,
        [block],
        [aligned],
        { targetLanguage: 'zh-CN' }
    );
    const firstUnit = views.blockRanges[0].alignmentUnits[0];
    const from = sourceMarkdown.indexOf('sample');
    const to = from + 'sample'.length;
    const projection = projectSourceAnnotation([{ from, to }], {
        sourceMarkdown,
        ...views,
    });

    assert.deepEqual(projection, {
        ranges: [viewRange(firstUnit)],
        fallback: 'sentence',
    });
    assert.deepEqual(projectSourceAnnotationRanges([{ from, to }], {
        sourceMarkdown,
        ...views,
    }), [viewRange(firstUnit)]);

    const crossing = projectSourceAnnotation([{
        from,
        to: sourceMarkdown.indexOf('Accuracy') + 3,
    }], { sourceMarkdown, ...views });
    assert.deepEqual(crossing, { ranges: [], fallback: null });
});

test('maps a partial annotation to its verified sentence group without crossing its boundary', () => {
    const sourceMarkdown = 'The estimate is 1.2. this remains uncertain. Accuracy improved.';
    const [block] = collectMarkdownTranslationBlocks(sourceMarkdown);
    const { units } = createAlignmentPlan(block);
    const aligned = assembleAlignedBlock(block, [
        { id: units[0].id, translatedMarkdown: '估计值为 1.2，这仍不确定。' },
        { id: units[1].id, translatedMarkdown: '准确性提高了。' },
    ], 'zh-CN');
    const views = createDocumentTranslationViews(
        sourceMarkdown,
        [block],
        [aligned],
        { targetLanguage: 'zh-CN' }
    );
    const [group, followingSentence] = views.blockRanges[0].alignmentUnits;
    const partial = sourceMarkdown.indexOf('uncertain');
    const projection = projectSourceAnnotation([{
        from: partial,
        to: partial + 'uncertain'.length,
    }], { sourceMarkdown, ...views });

    assert.equal(group.sourceKind, 'sentence-group');
    assert.deepEqual(projection, {
        ranges: [viewRange(group)],
        fallback: 'sentence',
    });

    const crossing = projectSourceAnnotation([{
        from: partial,
        to: sourceMarkdown.indexOf('Accuracy') + 3,
    }], { sourceMarkdown, ...views });
    assert.deepEqual(crossing, { ranges: [], fallback: null });
    assert.notDeepEqual(projection.ranges, [viewRange(followingSentence)]);
});

test('aligns embedded figure captions for annotation projection and translated selection', () => {
    const sourceMarkdown = '![Figure 1. Flowchart of study selection.](figure.png)';
    const [block] = collectMarkdownTranslationBlocks(sourceMarkdown);
    const plan = createAlignmentPlan(block);
    assert.ok(plan, 'an embedded figure caption needs verified sentence alignment');

    const aligned = assembleAlignedBlock(block, plan.units.map(unit => ({
        id: unit.id,
        translatedMarkdown: '研究选择流程图。',
    })), 'zh-CN');
    const views = createDocumentTranslationViews(
        sourceMarkdown,
        [block],
        [aligned],
        { targetLanguage: 'zh-CN' }
    );
    const unit = views.blockRanges[0].alignmentUnits[0];
    const captionFrom = sourceMarkdown.indexOf('Flowchart');
    const projection = projectSourceAnnotation([{
        from: captionFrom,
        to: captionFrom + 'Flowchart'.length,
    }], { sourceMarkdown, ...views });
    const selectedTranslation = mapAlignedTranslationSelection({
        from: unit.translatedFrom + 1,
        to: unit.translatedTo - 1,
    }, views.blockRanges, 'translated');

    assert.deepEqual(projection, {
        ranges: [viewRange(unit)],
        fallback: 'sentence',
    });
    assert.deepEqual(selectedTranslation, [unit]);
});

test('projects cached caption highlights in Translation and resolves selections in both views', () => {
    const original = 'Fig. 1. Selection flowchart.';
    const translated = 'Fig. 1. 研究选择流程图。';
    for (const gap of ['\n', '\n\n']) {
        const sourceMarkdown = '![](images/flow.png)' + gap + original;
        const blocks = collectMarkdownTranslationBlocks(sourceMarkdown);
        const captionBlock = blocks.find(block => block.translatable);
        const translation = {
            id: captionBlock.id,
            markdown: captionBlock.requestMarkdown.replace('Selection flowchart.', '研究选择流程图。'),
        };
        const views = createDocumentTranslationViews(sourceMarkdown, blocks, [translation]);
        const from = sourceMarkdown.indexOf('flowchart');
        const projection = projectSourceAnnotation([{ from, to: from + 'flowchart'.length }], { sourceMarkdown, ...views });
        assert.equal(projection.fallback, 'caption');
        assert.deepEqual(projection.ranges.map(range => views.translatedMarkdown.slice(range.from, range.to)), [translated]);
        for (const [view, markdown] of [['translated', views.translatedMarkdown], ['compare', views.comparisonMarkdown]]) {
            const phrase = markdown.indexOf('选择');
            const [unit] = mapAlignedTranslationSelection({ from: phrase, to: phrase + 2 }, views.blockRanges, view);
            assert.deepEqual(unit?.sourceRanges, [{ from: sourceMarkdown.indexOf(original), to: sourceMarkdown.length }]);
        }
    }
});

test('requires every source segment of a split unit without filling gaps in the annotation', () => {
    const a = { from: 0, to: 3 };
    const b = { from: 6, to: 9 };
    const view = singleBlock('One...two and more.', 'Un et deux et la suite.', {
        alignmentUnits: [{ id: 's1', sourceRanges: [a, b], translatedFrom: 0, translatedTo: 10 }],
    });
    assert.deepEqual(projectSourceAnnotationRanges([a], view), []);
    assert.deepEqual(projectSourceAnnotationRanges([b, a, a], view), [{ from: 0, to: 10 }]);
});

test('ignores malformed or out-of-bounds annotations, blocks and units without clipping them', () => {
    const view = singleBlock('One. Two.\nExtra.', 'Un. Deux.\nSuite.', {
        sourceTo: 9,
        translatedTo: 9,
        alignmentUnits: [
            { id: 'wrong-source', sourceRanges: [{ from: null, to: 1 }], translatedFrom: 0, translatedTo: 2 },
            { id: 'wrong-view', sourceRanges: [{ from: 0, to: 1 }], translatedFrom: -1, translatedTo: 5 },
            { id: 'wrong-to', sourceRanges: [{ from: 0, to: 1 }], translatedFrom: 5, translatedTo: null },
            { id: 'next-block', sourceRanges: [{ from: 0, to: 1 }], translatedFrom: 5, translatedTo: 11 },
            { id: 'empty', sourceRanges: [], translatedFrom: 2, translatedTo: 5 },
            { id: 'sparse', sourceRanges: new Array(1), translatedFrom: 3, translatedTo: 7 },
            { id: 'ok', sourceRanges: [{ from: 0, to: 4 }], translatedFrom: 0, translatedTo: 3 },
            null,
        ],
    });
    const [valid] = view.blockRanges;
    view.blockRanges = [null, { ...valid, sourceFrom: -1 }, { ...valid, sourceTo: Symbol() },
        { ...valid, translatedTo: 20 }, valid];
    assert.deepEqual(projectSourceAnnotationRanges([
        null, { from: null, to: 9 }, { from: -1, to: 9 }, { from: 0, to: 20 },
        { from: '0', to: 8 }, { from: 0.1, to: 8 }, { from: 4, to: 4 }, { from: 5, to: 4 },
        { from: 0, to: 4 },
    ], view), [{ from: 0, to: 3 }]);
    assert.deepEqual(projectSourceAnnotationRanges([{ from: 0, to: 4 }], { ...view, translatedMarkdown: null }), []);
    assert.deepEqual(projectSourceAnnotationRanges(null, view), []);
});
