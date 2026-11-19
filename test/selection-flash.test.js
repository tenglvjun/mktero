import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import {
    createSelectionFlashExtension,
    selectionFlashRanges,
    setSelectionFlash,
} from '../src/editor/selection-flash.js';

function highlightedRanges(state, field) {
    const ranges = [];
    state.field(field).between(0, state.doc.length, (from, to) => ranges.push({ from, to }));
    return ranges;
}

test('flashes disjoint source passages without highlighting the text between them', () => {
    const field = createSelectionFlashExtension();
    const original = EditorState.create({ doc: 'First. Unselected. Last.', extensions: [field] });
    const state = original.update({ effects: setSelectionFlash.of([
        { from: 19, to: 24 }, { from: 0, to: 6 },
    ]) }).state;
    assert.deepEqual(highlightedRanges(state, field), [
        { from: 0, to: 6 }, { from: 19, to: 24 },
    ]);
    const cleared = state.update({ effects: setSelectionFlash.of(null) }).state;
    assert.deepEqual(highlightedRanges(cleared, field), []);
});

test('merges only touching source passages and rejects invalid offsets', () => {
    assert.deepEqual(selectionFlashRanges([
        { from: 8, to: 12 }, { from: 3, to: 5 }, { from: 1, to: 3 },
        { from: 2, to: 4 }, { from: -1, to: 2 }, { from: 8, to: 8 },
        { from: 13, to: 21 }, { from: '0', to: 2 },
    ], 20), [{ from: 1, to: 5 }, { from: 8, to: 12 }]);
});

test('retains the total flash length budget across several source passages', () => {
    assert.deepEqual(selectionFlashRanges([
        { from: 0, to: 3000 }, { from: 4000, to: 6000 }, { from: 7000, to: 8000 },
    ], 8000), [{ from: 0, to: 3000 }, { from: 4000, to: 5000 }]);
    assert.deepEqual(selectionFlashRanges({ from: 2, to: 8000 }, 8000), [
        { from: 2, to: 4002 },
    ]);
});
