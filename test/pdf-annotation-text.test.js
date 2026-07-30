import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createDehyphenatedPdfAnnotationTextIndex,
} from '../src/markdown/pdf-annotation-text.js';

test('maps PDF line-end hyphens back to their original source range', () => {
    const source = '😀 Words were inves-\ntigated and evidence-based.';
    const index = createDehyphenatedPdfAnnotationTextIndex(source);
    const target = 'investigated';
    const from = index.text.indexOf(target);
    const range = index.sourceRange(from, target.length);

    assert.equal(
        index.text,
        '😀 Words were investigated and evidence-based.'
    );
    assert.equal(source.slice(range.from, range.to), 'inves-\ntigated');
});

test('preserves lexical hyphens without following whitespace', () => {
    const index = createDehyphenatedPdfAnnotationTextIndex(
        'evidence-based and well- being'
    );

    assert.equal(index.text, 'evidence-based and wellbeing');
});
