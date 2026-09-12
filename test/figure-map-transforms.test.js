import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRestoredFigureDocument } from './helpers/restored-figure-fixture.js';
import { mapFigureMapThroughEdits } from '../src/figures/figure-map-transforms.js';

test('moves figure and caption ranges without changing their source identity or PDF geometry', async () => {
    const document = await makeRestoredFigureDocument();
    const original = structuredClone(document.figureMap);
    const next = mapFigureMapThroughEdits(document.figureMap, [{ from: 0, to: 0, replacementLength: 12 }],
        'New prefix. ' + document.markdown);
    assert.equal(next.figures[0].id, original.figures[0].id);
    assert.equal(next.figures[0].render.range.from, original.figures[0].render.range.from + 12);
    assert.equal(next.figures[0].render.captionRanges[0].from, original.figures[0].render.captionRanges[0].from + 12);
    assert.deepEqual(next.figures[0].visualBBox, original.figures[0].visualBBox);
    assert.deepEqual(next.figures[0].provenance, original.figures[0].provenance);
    assert.equal(next.markdownHash, null);
    assert.deepEqual(document.figureMap, original);
});

test('invalidates a changed figure image and rejects overlapping edit ranges', async () => {
    const document = await makeRestoredFigureDocument();
    const range = document.figureMap.figures[0].render.range;
    const next = mapFigureMapThroughEdits(document.figureMap, [{ ...range, replacementLength: 0 }],
        document.markdown.slice(0, range.from) + document.markdown.slice(range.to));
    assert.equal(next.figures.length, 0);
    assert.throws(() => mapFigureMapThroughEdits(document.figureMap, [
        { from: 0, to: 10, replacementLength: 1 }, { from: 5, to: 11, replacementLength: 1 },
    ], document.markdown));
});
