import test from 'node:test';
import assert from 'node:assert/strict';
import {
    absorbBlankLines,
    mapChromeRanges,
    normalizeChromeRanges,
    subtractChromeRanges,
    visibleTextForRanges,
} from '../src/markdown/chrome-ranges.js';

test('drops invalid chrome range collections', () => {
    assert.deepEqual(normalizeChromeRanges(null, 10), []);
    assert.deepEqual(normalizeChromeRanges([{ from: 1, to: 0 }], 10), []);
    assert.deepEqual(normalizeChromeRanges([{ from: 0, to: 11 }], 10), []);
    assert.deepEqual(normalizeChromeRanges([{ from: 0, to: 1 }], 0), []);
});

test('merges overlapping and adjacent chrome ranges', () => {
    assert.deepEqual(
        normalizeChromeRanges([{ from: 5, to: 8 }, { from: 0, to: 2 }, { from: 2, to: 4 }], 20),
        [{ from: 0, to: 4 }, { from: 5, to: 8 }]
    );
});

test('subtracts chrome from a selection and concatenates visible text', () => {
    const markdown = 'Hello\n\n12\n\nWorld';
    const chrome = normalizeChromeRanges([{ from: 5, to: 11 }], markdown.length);
    const ranges = subtractChromeRanges({ from: 0, to: markdown.length }, chrome);
    assert.deepEqual(ranges, [{ from: 0, to: 5 }, { from: 11, to: markdown.length }]);
    assert.equal(visibleTextForRanges(markdown, ranges), 'HelloWorld');
});

test('returns no ranges when the selection is only chrome', () => {
    assert.deepEqual(
        subtractChromeRanges({ from: 5, to: 11 }, [{ from: 5, to: 11 }]),
        []
    );
});

test('absorbs neighboring blank lines into chrome ranges', () => {
    const markdown = 'Hello\n\n12\n\nWorld';
    const absorbed = absorbBlankLines(markdown, [{ from: 7, to: 9 }]);
    assert.equal(markdown.slice(absorbed[0].from, absorbed[0].to), '\n\n12\n\n');
});

test('maps chrome ranges through an unrelated replacement and drops overlaps', () => {
    const markdown = 'AAA\nCHROME\nBBB';
    const chrome = [{ from: 4, to: 10 }];
    const shifted = mapChromeRanges(
        chrome,
        [{ from: 0, to: 3, replacementLength: 7 }],
        markdown.length + 4
    );
    assert.deepEqual(shifted, [{ from: 8, to: 14 }]);
    assert.deepEqual(
        mapChromeRanges(chrome, [{ from: 4, to: 10, replacementLength: 0 }], 8),
        []
    );
});

test('maps chrome ranges using original-document transform coordinates', () => {
    const chrome = [{ from: 4, to: 10 }];
    const shifted = mapChromeRanges(
        chrome,
        [
            { from: 0, to: 3, replacementLength: 7 },
            { from: 11, to: 14, replacementLength: 3 },
        ],
        18
    );
    assert.deepEqual(shifted, [{ from: 8, to: 14 }]);
});
