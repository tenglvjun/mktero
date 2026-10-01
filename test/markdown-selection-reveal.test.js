import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownRevealTarget } from '../src/core/markdown-selection-reveal.js';

const sourceRange = { markdownFrom: 12, markdownTo: 20 };
const translatedBlock = {
    id: 'paragraph-1',
    sourceFrom: 10,
    sourceTo: 40,
    translatedFrom: 10,
    translatedTo: 30,
    comparisonSourceFrom: 10,
    comparisonSourceTo: 40,
    comparisonTranslationFrom: 42,
    comparisonTranslationTo: 60,
};

test('opens an existing translation beside the original paragraph', () => {
    assert.deepEqual(markdownRevealTarget({
        sourceRange,
        translationView: 'original',
        translationStatus: 'ready',
        blockRanges: [translatedBlock],
    }), { view: 'compare', offset: 12, from: 12, to: 20 });
});

test('keeps the current translation view when the passage is already translated', () => {
    assert.deepEqual(markdownRevealTarget({
        sourceRange,
        translationView: 'translated',
        translationStatus: 'ready',
        blockRanges: [translatedBlock],
    }), { view: 'translated', offset: 12, from: 12, to: 20 });
    assert.deepEqual(markdownRevealTarget({
        sourceRange,
        translationView: 'compare',
        translationStatus: 'partial',
        blockRanges: [translatedBlock],
    }), { view: 'compare', offset: 12, from: 12, to: 20 });
});

test('does not switch views when the selected passage has no complete translation', () => {
    const untranslated = {
        ...translatedBlock,
        comparisonTranslationFrom: null,
        comparisonTranslationTo: null,
    };

    assert.deepEqual(markdownRevealTarget({
        sourceRange,
        translationView: 'original',
        translationStatus: 'partial',
        blockRanges: [untranslated],
    }), { view: 'original', offset: 12, from: 12, to: 20 });
    assert.deepEqual(markdownRevealTarget({
        sourceRange,
        translationView: 'original',
        translationStatus: 'none',
        blockRanges: [translatedBlock],
    }), { view: 'original', offset: 12, from: 12, to: 20 });
});

test('returns to the original when the current view cannot locate the passage', () => {
    assert.deepEqual(markdownRevealTarget({
        sourceRange,
        translationView: 'translated',
        translationStatus: 'ready',
        blockRanges: [],
    }), { view: 'original', offset: 12, from: 12, to: 20 });
});
