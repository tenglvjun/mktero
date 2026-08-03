import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createDehyphenatedPdfAnnotationTextIndex,
    createPdfAnnotationTextIndex,
    normalizePdfAnnotationText,
} from '../src/markdown/pdf-annotation-text.js';

test('normalizes mathematical operator whitespace while preserving source ranges', () => {
    const markdown = 'Results (p<0.001), (r=0.563), from −3 to +2, ±2.';
    const pdf = 'Results (p < 0.001), (r = 0.563), from − 3 to + 2, ± 2.';
    const index = createPdfAnnotationTextIndex(pdf);
    const normalized = normalizePdfAnnotationText(pdf);
    const target = 'p<0.001';
    const from = index.text.indexOf(target);
    const range = index.sourceRange(from, target.length);

    assert.equal(normalizePdfAnnotationText(markdown), normalized);
    assert.equal(normalized, 'Results (p<0.001), (r=0.563), from -3 to +2, ±2.');
    assert.equal(pdf.slice(range.from, range.to), 'p < 0.001');
    assert.equal(normalizePdfAnnotationText('well - being'), 'well - being');
});

test('normalizes MinerU LaTeX symbols while preserving source ranges', () => {
    const markdown = 'Difference 0.30\\;^{\\circ}C; window \\pm2.';
    const pdf = 'Difference 0.30 °C; window ± 2.';
    const markdownIndex = createPdfAnnotationTextIndex(markdown);
    const pdfIndex = createPdfAnnotationTextIndex(pdf);
    const normalized = 'Difference 0.30°C; window ±2.';

    assert.equal(markdownIndex.text, normalized);
    assert.equal(pdfIndex.text, normalized);

    const degree = '0.30°C';
    const markdownDegreeRange = markdownIndex.sourceRange(
        normalized.indexOf(degree),
        degree.length
    );
    const pdfDegreeRange = pdfIndex.sourceRange(
        normalized.indexOf(degree),
        degree.length
    );
    assert.equal(
        markdown.slice(markdownDegreeRange.from, markdownDegreeRange.to),
        '0.30\\;^{\\circ}C'
    );
    assert.equal(
        pdf.slice(pdfDegreeRange.from, pdfDegreeRange.to),
        '0.30 °C'
    );

    const plusMinus = '±2';
    const plusMinusRange = markdownIndex.sourceRange(
        normalized.indexOf(plusMinus),
        plusMinus.length
    );
    assert.equal(
        markdown.slice(plusMinusRange.from, plusMinusRange.to),
        '\\pm2'
    );
    assert.equal(normalizePdfAnnotationText('\\pmod2'), '\\pmod2');
});

test('leaves escaped, malformed, and oversized LaTeX-like input unchanged', () => {
    const fragment = '\\\\pm2 0.30\\\\;^{\\circ}C \\pmod2 \\pmatrix '
        + '\\input{secret} 0.30\\;^{\\cir';
    const source = Array(1_000).fill(fragment).join(' ');

    assert.equal(normalizePdfAnnotationText(source), source);
});

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
