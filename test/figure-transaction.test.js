import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFigureInput, createTestPNG } from './helpers/figure-fixtures.js';
import { bindFigureSourceRanges } from '../src/figures/figure-source-binding.js';
import { resolveFigureCandidates } from '../src/figures/figure-region-resolver.js';
import { composeFigureDraft } from '../src/figures/figure-transaction.js';

function fixture(options = {}) {
    const source = makeFigureInput(options);
    const input = bindFigureSourceRanges(source.input);
    const candidate = resolveFigureCandidates(input).find(value => value.decision === 'compose');
    assert.ok(candidate);
    return { ...source, input, candidate, completed: [{ candidate,
        crop: { data: createTestPNG(800, 750), mimeType: 'image/png', width: 800, height: 750 },
        assetPath: 'generated/figures/restored.png' }] };
}

test('replaces only owned ranges and preserves original fragments, assets and outside prose', () => {
    const { input, completed, bodyText, axisLabel, caption } = fixture();
    const before = structuredClone(input);
    const draft = composeFigureDraft(input, completed);
    assert.ok(draft.input.markdown.includes(bodyText));
    assert.ok(!draft.input.markdown.includes(axisLabel));
    assert.equal(draft.input.markdown.split(caption).length - 1, 1);
    assert.equal(draft.input.assets.length, input.assets.length + 1);
    assert.equal(draft.blueprints.length, 1);
    assert.ok(draft.blueprints[0].provenance.fragments.some(fragment => fragment.markdown === axisLabel));
    for (const block of draft.input.blocks) {
        for (const range of block.sourceRanges || []) {
            assert.ok(range.from >= 0 && range.to <= draft.input.markdown.length);
            if (block.role === 'body') assert.equal(draft.input.markdown.slice(range.from, range.to), bodyText);
        }
    }
    assert.equal(draft.input.pages[0].markdownRange.to, draft.input.markdown.length);
    assert.deepEqual(input, before);
});

test('keeps the outside occurrence of duplicate axis labels', () => {
    const { input, completed, bodyText } = fixture({ repeated: true });
    const draft = composeFigureDraft(input, completed);
    assert.equal(draft.input.markdown.split('Accuracy').length - 1, 1);
    assert.ok(draft.input.markdown.includes(bodyText));
    assert.equal(draft.blueprints[0].provenance.fragments.filter(fragment => fragment.markdown === 'Accuracy').length, 2);
});

test('preserves originals when the PNG, provenance budget or asset destination is invalid', () => {
    for (const variant of ['png', 'budget', 'path']) {
        const { input, completed } = fixture();
        if (variant === 'png') completed[0].crop.data = Uint8Array.of(1, 2, 3);
        if (variant === 'path') completed[0].assetPath = input.assets[0].path;
        const draft = composeFigureDraft(input, completed, variant === 'budget'
            ? { limits: { maxMapBytes: 10 } } : {});
        assert.equal(draft.input.markdown, input.markdown);
        assert.deepEqual(draft.input.assets, input.assets);
        assert.equal(draft.blueprints.length, 0);
        assert.equal(draft.preserved.length, 1);
    }
});

test('refuses consumption outside the crop and never invents a caption for an explicit parent', () => {
    const { input, completed } = fixture();
    completed[0].candidate.visualBBox = [100, 100, 450, 400];
    const rejected = composeFigureDraft(input, completed);
    assert.equal(rejected.input.markdown, input.markdown);

    const withoutCaption = { ...input, blocks: input.blocks.filter(block => block.role !== 'caption') };
    const candidate = resolveFigureCandidates(withoutCaption).find(value => value.decision === 'compose');
    assert.ok(candidate);
    const draft = composeFigureDraft(withoutCaption, [{ ...completed[0], candidate }]);
    assert.equal(draft.blueprints[0].label, null);
    assert.ok(draft.input.markdown.includes('![](generated/figures/restored.png)'));
});
