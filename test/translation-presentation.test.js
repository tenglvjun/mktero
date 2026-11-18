import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSourceAnnotationRanges } from '../src/editor/translation-presentation.js';
import {
    collectMarkdownTranslationBlocks,
    createDocumentTranslationViews,
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

test('projects only fully covered verified sentences and does not infer alignment from old or damaged records', () => {
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
    assert.deepEqual(projectSourceAnnotationRanges([{ from, to: to - 1 }], view), []);
    assert.deepEqual(projectSourceAnnotationRanges([{ from: to, to: to + 1 }], view), []);
    assert.deepEqual(projectSourceAnnotationRanges([{ from: 0, to: from + 1 }], view), [viewRange(first)]);
    assert.deepEqual(projectSourceAnnotationRanges([...third.sourceRanges, ...first.sourceRanges], view), [
        viewRange(first), viewRange(third),
    ]);
    assert.deepEqual(projectSourceAnnotationRanges([{ from, to }], viewFor({ id: block.id, markdown: aligned.markdown })), []);
    const damaged = structuredClone(aligned);
    damaged.alignment.units[1].sourceRanges[0].from++;
    assert.deepEqual(projectSourceAnnotationRanges([{ from, to }], viewFor(damaged)), []);
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
