import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTwoColumnFigureInput } from './helpers/figure-fixtures.js';
import { bindFigureSourceRanges } from '../src/figures/figure-source-binding.js';
import { resolveFigureCandidates } from '../src/figures/figure-region-resolver.js';
import { composeFigureDraft } from '../src/figures/figure-transaction.js';

function restore(source) {
    const input = bindFigureSourceRanges(source.input);
    const candidate = resolveFigureCandidates(input).find(value => value.decision === 'compose');
    assert.ok(candidate, 'expected a composed candidate');
    return { ...source, input, candidate, completed: [{ candidate,
        crop: { data: source.crop, mimeType: 'image/png', width: 800, height: 750 },
        assetPath: 'generated/figures/restored.png' }] };
}

test('composes a full-width figure whose panels are split across two columns', () => {
    const source = makeTwoColumnFigureInput();
    const { candidate } = restore(source);
    assert.equal(candidate.decision, 'compose');
    assert.equal(candidate.label, 'Fig. 1 |');
    assert.deepEqual(candidate.panelBlockIds, [
        'mineru:p0:b3', 'mineru:p0:b6', 'mineru:p0:b8',
        'mineru:p0:b14', 'mineru:p0:b16', 'mineru:p0:b18',
    ]);
    assert.deepEqual(candidate.captionBlockIds, ['mineru:p0:b9', 'mineru:p0:b19']);
    assert.deepEqual(candidate.ownedTextBlockIds, ['mineru:p0:b0', 'mineru:p0:b2', 'mineru:p0:b5']);
    assert.deepEqual(candidate.captionBBox, [58.8, 446.8, 934.5, 562]);
    assert.ok(candidate.visualBBox[3] >= 440.5);
});

test('merges caption halves that are ordered right column first in the Markdown', () => {
    const source = makeTwoColumnFigureInput({ variant: 'reversed-caption' });
    const { candidate } = restore(source);
    assert.equal(candidate.decision, 'compose');
    assert.equal(candidate.label, 'Fig. 2 |');
    assert.deepEqual(candidate.captionBlockIds, ['mineru:p0:b8', 'mineru:p0:b4']);
    assert.deepEqual(candidate.ownedTextBlockIds, ['mineru:p0:b0']);
});

test('joins split captions in column order and removes every figure fragment', () => {
    const source = makeTwoColumnFigureInput();
    const { input, completed, captionLeft, captionRight, bodyText, axisText } = restore(source);
    const draft = composeFigureDraft(input, completed);
    assert.equal(draft.preserved.length, 0);
    assert.equal(draft.blueprints.length, 1);
    const markdown = draft.input.markdown;
    assert.ok(markdown.includes(`![${captionLeft} ${captionRight}](generated/figures/restored.png)`));
    assert.ok(!markdown.includes(axisText));
    assert.ok(!markdown.includes('![](images/'));
    assert.ok(markdown.includes(bodyText));
    assert.equal(markdown.split(captionLeft).length - 1, 1);
    assert.equal(markdown.split(captionRight).length - 1, 1);
    assert.deepEqual(draft.blueprints[0].captionBBox, [58.8, 446.8, 934.5, 562]);
});

test('joins split captions in column order when the label half comes last', () => {
    const source = makeTwoColumnFigureInput({ variant: 'reversed-caption' });
    const { input, completed, captionLeft, captionRight, bodyText } = restore(source);
    const draft = composeFigureDraft(input, completed);
    const markdown = draft.input.markdown;
    assert.ok(markdown.includes(`![${captionLeft} ${captionRight}](generated/figures/restored.png)`));
    assert.ok(markdown.includes(bodyText));
    assert.ok(!/^b$/mu.test(markdown));
});

test('composes when an in-band annotation is absent from the Markdown', () => {
    const source = makeTwoColumnFigureInput({ axisInMarkdown: false });
    const { input, candidate } = restore(source);
    assert.equal(candidate.decision, 'compose');
    assert.ok(!candidate.ownedTextBlockIds.includes('mineru:p0:b0'));
    const draft = composeFigureDraft(input, [{
        candidate,
        crop: { data: source.crop, mimeType: 'image/png', width: 800, height: 750 },
        assetPath: 'generated/figures/restored.png',
    }]);
    assert.equal(draft.blueprints.length, 1);
});

test('still preserves prose inside the figure band', () => {
    const source = makeTwoColumnFigureInput();
    const input = bindFigureSourceRanges(source.input);
    const prose = input.blocks.find(block => block.id === 'mineru:p0:b10');
    prose.bbox = [520, 420, 940, 438];
    const candidates = resolveFigureCandidates(input);
    assert.ok(candidates.every(candidate => candidate.decision === 'preserve'));
    assert.ok(candidates.some(candidate => candidate.reason === 'foreign-content-overlap'));
});
