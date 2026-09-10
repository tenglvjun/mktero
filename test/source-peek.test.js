import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizedBBoxToCanvasRect,
    paddedNormalizedBBox,
    selectSourcePeek,
    sourcePeekKey,
} from '../src/core/source-peek.js';

function entry(from, to, locations) {
    return {
        type: 'text',
        markdownFrom: from,
        markdownTo: to,
        locations,
    };
}

function location(pageIndex, bbox = [100, 200, 800, 360]) {
    return { pageIndex, bbox };
}

test('selects the covering source-map entry for the reading offset', () => {
    const peek = selectSourcePeek([
        entry(0, 20, [location(0, [10, 10, 900, 80])]),
        entry(20, 80, [location(1, [120, 200, 780, 340])]),
        entry(80, 120, [location(2)]),
    ], 44, 120);

    assert.deepEqual(peek, {
        pageIndex: 1,
        bbox: [120, 200, 780, 340],
        markdownFrom: 20,
        markdownTo: 80,
    });
});

test('uses the tightest covering entry when ranges nest', () => {
    const peek = selectSourcePeek([
        entry(0, 100, [location(0, [10, 10, 900, 900])]),
        entry(20, 50, [location(0, [100, 200, 700, 300])]),
    ], 30, 100);

    assert.deepEqual(peek.bbox, [100, 200, 700, 300]);
    assert.equal(peek.markdownFrom, 20);
});

test('falls back to the nearest previous mapped block', () => {
    const peek = selectSourcePeek([
        entry(0, 20, [location(0)]),
        entry(40, 80, [location(3, [50, 60, 400, 120])]),
    ], 30, 80);

    assert.equal(peek.pageIndex, 0);
    assert.deepEqual(peek.bbox, [100, 200, 800, 360]);
});

test('unions same-page boxes and ignores later pages in the same entry', () => {
    const peek = selectSourcePeek([
        entry(0, 40, [
            location(2, [100, 200, 400, 300]),
            location(2, [120, 280, 500, 420]),
            location(3, [10, 10, 900, 900]),
        ]),
    ], 12, 40);

    assert.deepEqual(peek, {
        pageIndex: 2,
        bbox: [100, 200, 500, 420],
        markdownFrom: 0,
        markdownTo: 40,
    });
});

test('returns null without a usable mapping', () => {
    assert.equal(selectSourcePeek([], 0, 10), null);
    assert.equal(selectSourcePeek(null, 0, 10), null);
    assert.equal(selectSourcePeek([
        entry(10, 20, [location(0)]),
    ], 0, 20), null);
    assert.equal(selectSourcePeek([
        entry(0, 10, [{ pageIndex: 0, bbox: [0, 0, 0, 0] }]),
    ], 4, 10), null);
});

test('builds a stable peek key and padded canvas crop', () => {
    const peek = {
        pageIndex: 4,
        bbox: [100, 200, 300, 400],
    };
    assert.equal(sourcePeekKey(peek), '4');
    assert.equal(sourcePeekKey(null), '');
    assert.deepEqual(
        paddedNormalizedBBox([100, 200, 300, 400], 0.1),
        [80, 180, 320, 420]
    );
    assert.deepEqual(
        normalizedBBoxToCanvasRect([250, 250, 750, 750], 200, 400),
        { x: 50, y: 100, width: 100, height: 200 }
    );
});
