import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFigureInput } from './helpers/figure-fixtures.js';
import { bindFigureSourceRanges } from '../src/figures/figure-source-binding.js';
import { resolveFigureCandidates } from '../src/figures/figure-region-resolver.js';

test('owns all panels and internal text while keeping outside prose independent', () => {
    const { input } = makeFigureInput();
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].decision, 'compose');
    assert.equal(candidates[0].panelBlockIds.length, 4);
    assert.equal(candidates[0].ownedTextBlockIds.length, 1);
    assert.deepEqual(candidates[0].visualBBox, [98, 98, 902, 852]);
});

test('does not crop missing geometry or unbound internal text', () => {
    const { input } = makeFigureInput();
    let bound = bindFigureSourceRanges(input);
    delete bound.blocks.find(block => block.role === 'panel').bbox;
    assert.equal(resolveFigureCandidates(bound)[0].decision, 'preserve');
    bound = bindFigureSourceRanges(input);
    bound.blocks.find(block => block.role === 'figure-text').sourceRanges = [];
    assert.equal(resolveFigureCandidates(bound)[0].reason, 'ambiguous-source-range');
});

test('preserves groups overlapping a caption, body paragraph, table or unknown long text', () => {
    for (const kind of ['caption', 'body', 'table', 'unknown']) {
        const { input } = makeFigureInput();
        const bound = bindFigureSourceRanges(input);
        const block = kind === 'caption' ? bound.blocks.at(-1)
            : bound.blocks.find(block => block.role === 'body');
        block.bbox = [400, 420, 600, 480];
        if (kind === 'table') block.type = 'table';
        if (kind === 'unknown') {
            block.role = 'unknown';
            block.text = 'An ordinary explanatory sentence that belongs to the main article.';
        }
        assert.equal(resolveFigureCandidates(bound)[0].decision, 'preserve', kind);
    }
});

test('finds independent geometric groups alongside an explicit parent group', () => {
    const { input } = makeFigureInput();
    const extra = makeFigureInput({ parent: false, interleave: false, boxes: [[100, 100, 900, 800]] }).input;
    const offset = input.markdown.length + 2;
    input.markdown += '\n\n' + extra.markdown.replace('Figure 1.', 'Figure 2.');
    input.pages.push({ ...extra.pages[0], pageIndex: 1,
        markdownRange: { from: offset, to: input.markdown.length } });
    for (const block of extra.blocks) {
        input.blocks.push({ ...block, id: block.id + ':page1', pageIndex: 1,
            text: block.text?.replace('Figure 1.', 'Figure 2.') });
    }
    const groups = resolveFigureCandidates(bindFigureSourceRanges(input));
    assert.equal(groups.length, 2);
    assert.ok(groups.every(group => group.decision === 'compose'));
    assert.deepEqual(groups.map(group => group.pageIndex), [0, 1]);
});

test('preserves shared legends only when geometry and text shape agree', () => {
    const { input } = makeFigureInput();
    const axis = input.blocks.find(block => block.role === 'figure-text');
    input.markdown = input.markdown.replace(axis.text, 'Control');
    axis.text = 'Control';
    axis.parentId = null;
    axis.role = 'unknown';
    axis.bbox = [460, 410, 530, 440];
    input.pages[0].markdownRange.to = input.markdown.length;
    const candidate = resolveFigureCandidates(bindFigureSourceRanges(input))[0];
    assert.equal(candidate.decision, 'compose');
    assert.deepEqual(candidate.ownedTextBlockIds, [axis.id]);
});

test('retains a deterministic preserved candidate when geometric work exceeds its budget', () => {
    const { input } = makeFigureInput({ parent: false });
    const candidates = resolveFigureCandidates(bindFigureSourceRanges(input), {
        limits: { maxComparisons: 0 },
    });
    assert.ok(candidates.length > 0);
    assert.ok(candidates.every(candidate => candidate.decision === 'preserve'));
    assert.ok(candidates.some(candidate => candidate.reason === 'resource-limit'));
});

test('preserves conflicting parent geometry and unknown text without a box', () => {
    for (const change of [
        input => { input.blocks[0].bbox = [100, 100, 200, 200]; },
        input => { const text = input.blocks.find(block => block.role === 'figure-text');
            text.role = 'unknown'; text.bbox = null; },
    ]) {
        const { input } = makeFigureInput();
        change(input);
        assert.equal(resolveFigureCandidates(bindFigureSourceRanges(input))[0].decision, 'preserve');
    }
});

test('keeps the resource-limit summary inside the candidate budget across pages', () => {
    for (const maxFigures of [1, 3, 1000]) {
        const input = { pages: [], blocks: [] };
        for (let pageIndex = 0; pageIndex <= maxFigures; pageIndex++) {
            input.pages.push({ pageIndex, coordinateFrame: 'unknown' });
            input.blocks.push({ id: `p${pageIndex}`, pageIndex, sourceOrdinal: 0,
                type: 'image', role: 'panel', bboxKind: 'unknown', assetPath: 'images/p.png' });
        }
        const candidates = resolveFigureCandidates(input, { limits: { maxFigures } });
        assert.equal(candidates.length, maxFigures);
        assert.equal(candidates.at(-1).reason, 'resource-limit');
    }
});
