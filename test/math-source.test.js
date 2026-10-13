import test from 'node:test';
import assert from 'node:assert/strict';
import { stripMathDelimiters } from '../src/markdown/math-source.js';

test('strips display math delimiters', () => {
    assert.equal(stripMathDelimiters('$$E = mc^2$$'), 'E = mc^2');
    assert.equal(stripMathDelimiters('$$ E = mc^2 $$'), 'E = mc^2');
    assert.equal(stripMathDelimiters('\\[E = mc^2\\]'), 'E = mc^2');
});

test('strips inline math delimiters', () => {
    assert.equal(stripMathDelimiters('$a_i$'), 'a_i');
    assert.equal(stripMathDelimiters('\\(a_i\\)'), 'a_i');
});

test('keeps a formula that has no delimiters', () => {
    assert.equal(stripMathDelimiters('\\alpha_1'), '\\alpha_1');
    assert.equal(stripMathDelimiters('  a_i  '), 'a_i');
});

test('returns an empty string for empty input', () => {
    assert.equal(stripMathDelimiters(''), '');
    assert.equal(stripMathDelimiters('   '), '');
    assert.equal(stripMathDelimiters(null), '');
    assert.equal(stripMathDelimiters(undefined), '');
});

test('keeps delimiters that are not a single pair around the source', () => {
    // A paragraph that merely starts and ends with `$` is not one formula.
    assert.equal(stripMathDelimiters('$a$ + $b$'), '$a$ + $b$');
    assert.equal(stripMathDelimiters('$$\nE = mc^2\n$$'), 'E = mc^2');
});

test('keeps an empty delimiter pair untouched', () => {
    assert.equal(stripMathDelimiters('$$$$'), '$$$$');
    assert.equal(stripMathDelimiters('$$'), '$$');
});

test('unwraps a multiline display formula', () => {
    assert.equal(
        stripMathDelimiters(
            '$$\n\\begin{aligned}\na &= b \\\\\n\\end{aligned}\n$$'
        ),
        '\\begin{aligned}\na &= b \\\\\n\\end{aligned}'
    );
});
