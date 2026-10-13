import test from 'node:test';
import assert from 'node:assert/strict';
import {
    LANDMARK_TYPE_FIGURE,
    LANDMARK_TYPE_HEADING,
    LANDMARK_TYPE_NOTE,
    mergeLandmarks,
    nextLandmark,
    previousLandmark,
} from '../src/ui/landmark-navigation.js';

test('merges and sorts landmarks from all three sources', () => {
    const items = mergeLandmarks({
        headings: [
            { text: 'Methods', offset: 400, level: 2 },
            { text: 'Title', offset: 0, level: 1 },
        ],
        assets: [{ text: 'Figure 1', offset: 250 }],
        noteOffsets: [300],
    });
    assert.deepEqual(items.map(item => item.type), [
        LANDMARK_TYPE_HEADING,
        LANDMARK_TYPE_FIGURE,
        LANDMARK_TYPE_NOTE,
        LANDMARK_TYPE_HEADING,
    ]);
    assert.deepEqual(items.map(item => item.offset), [0, 250, 300, 400]);
    assert.equal(items[0].text, 'Title');
});

test('keeps the heading when landmarks share an offset', () => {
    const items = mergeLandmarks({
        headings: [{ text: 'Results', offset: 500 }],
        assets: [{ text: 'Figure 3', offset: 500 }],
        noteOffsets: [500],
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].type, LANDMARK_TYPE_HEADING);
    assert.equal(items[0].text, 'Results');
});

test('drops invalid offsets', () => {
    const items = mergeLandmarks({
        headings: [
            { text: 'Bad', offset: -1 },
            { text: 'Fractional', offset: 1.5 },
            { text: 'Good', offset: 10 },
        ],
        assets: [null, {}],
        noteOffsets: [Number.NaN, 20],
    });
    assert.deepEqual(items.map(item => item.offset), [10, 20]);
});

test('tolerates missing and empty sources', () => {
    assert.deepEqual(mergeLandmarks(), []);
    assert.deepEqual(mergeLandmarks({ headings: [], noteOffsets: [] }), []);
    assert.deepEqual(mergeLandmarks({ headings: undefined, assets: null }), []);
});

test('accepts plain offsets as notes', () => {
    const items = mergeLandmarks({ noteOffsets: [5, 15] });
    assert.deepEqual(items.map(item => item.type), [
        LANDMARK_TYPE_NOTE,
        LANDMARK_TYPE_NOTE,
    ]);
});

test('next finds the first strictly later landmark', () => {
    const items = mergeLandmarks({
        headings: [{ text: 'A', offset: 10 }],
        noteOffsets: [30],
    });
    assert.equal(nextLandmark(items, 0).offset, 10);
    assert.equal(nextLandmark(items, 9).offset, 10);
    assert.equal(nextLandmark(items, 10).offset, 30);
    assert.equal(nextLandmark(items, 30), null);
    assert.equal(nextLandmark(items, 1000), null);
});

test('previous finds the last strictly earlier landmark', () => {
    const items = mergeLandmarks({
        headings: [{ text: 'A', offset: 10 }],
        noteOffsets: [30],
    });
    assert.equal(previousLandmark(items, 1000).offset, 30);
    assert.equal(previousLandmark(items, 30).offset, 10);
    assert.equal(previousLandmark(items, 10), null);
    assert.equal(previousLandmark(items, 0), null);
});

test('search tolerates a missing or empty list', () => {
    assert.equal(nextLandmark([], 0), null);
    assert.equal(previousLandmark(undefined, 5), null);
});
