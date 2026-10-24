import test from 'node:test';
import assert from 'node:assert/strict';
import { expandMarkdownRangeToMathBoundaries } from '../src/markdown/markdown-visible-text.js';

test('expands range when start falls inside inline math', () => {
    const markdown = 'The material $M_0$ is the mutable artifact.';
    const range = { from: 15, to: 18 }; // Inside "M_0"
    const expanded = expandMarkdownRangeToMathBoundaries(markdown, range);

    assert.equal(expanded.from, 13); // Start of $M_0$
    assert.equal(expanded.to, 18); // Original end
});

test('expands range when end falls inside inline math', () => {
    const markdown = 'The gain also transfers to $S_{test}$.';
    const range = { from: 0, to: 35 }; // Ends inside "S_{test}"
    const expanded = expandMarkdownRangeToMathBoundaries(markdown, range);

    assert.equal(expanded.from, 0); // Original start
    assert.equal(expanded.to, 37); // End of $S_{test}$ (right after closing $)
});

test('expands range when both boundaries fall inside inline math', () => {
    const markdown = 'formula $\\hat{G} = \\mu + \\sum_{i}\\beta_{i}g_{i}$ text';
    const range = { from: 10, to: 45 }; // Inside the formula
    const expanded = expandMarkdownRangeToMathBoundaries(markdown, range);

    assert.equal(expanded.from, 8); // Start of formula
    assert.equal(expanded.to, 48); // End of formula (right after closing $)
});

test('expands range when start falls inside display math', () => {
    const markdown = 'text\n$$\\mathcal{P} = (\\mathcal{M}_0, O, E_{dev}, E_{test})$$\nmore';
    const range = { from: 10, to: 50 };
    const expanded = expandMarkdownRangeToMathBoundaries(markdown, range);

    assert.equal(expanded.from, 5); // Start of $$
    assert.equal(expanded.to, 61); // End of $$ (right after closing $$)
});

test('expands range when end falls inside display math', () => {
    const markdown = 'Text\n$$\n\\mathcal{AO}\n$$\nMore';
    const range = { from: 0, to: 15 }; // End inside the math content
    const expanded = expandMarkdownRangeToMathBoundaries(markdown, range);

    assert.equal(expanded.from, 0);
    assert.equal(expanded.to, 24); // End of $$...$$\n (match.end)
});

test('does not expand when range does not intersect math', () => {
    const markdown = 'Plain text $x$ and more plain text.';
    const range = { from: 0, to: 10 };
    const expanded = expandMarkdownRangeToMathBoundaries(markdown, range);

    assert.equal(expanded.from, 0);
    assert.equal(expanded.to, 10);
});

test('does not expand when range covers complete inline math', () => {
    const markdown = 'text $x$ text';
    const range = { from: 5, to: 8 }; // Exactly $x$
    const expanded = expandMarkdownRangeToMathBoundaries(markdown, range);

    assert.equal(expanded.from, 5);
    assert.equal(expanded.to, 8);
});

test('expands when selection starts at opening delimiter', () => {
    const markdown = 'The $n = 22$ formula';
    const range = { from: 4, to: 8 }; // From $ to =
    const expanded = expandMarkdownRangeToMathBoundaries(markdown, range);

    assert.equal(expanded.from, 4);
    assert.equal(expanded.to, 12); // To closing $
});

test('expands when selection ends at closing delimiter', () => {
    const markdown = 'The $n = 22$ formula';
    const range = { from: 6, to: 12 }; // From = to $
    const expanded = expandMarkdownRangeToMathBoundaries(markdown, range);

    assert.equal(expanded.from, 4); // To opening $
    assert.equal(expanded.to, 12);
});

test('handles multiple math ranges in selection', () => {
    const markdown = 'First $a$ and second $b$ text';
    const range = { from: 8, to: 24 }; // Crosses both formulas
    const expanded = expandMarkdownRangeToMathBoundaries(markdown, range);

    assert.equal(expanded.from, 6); // Start of $a$
    assert.equal(expanded.to, 24); // End of $b$
});

test('handles parenthesis-delimited inline math', () => {
    const markdown = 'Formula \\(x^2\\) here';
    const range = { from: 10, to: 13 };
    const expanded = expandMarkdownRangeToMathBoundaries(markdown, range);

    assert.equal(expanded.from, 8); // Start of \(
    assert.equal(expanded.to, 15); // End of \)
});

test('handles bracket-delimited display math', () => {
    const markdown = 'Text\n\\[\nE = mc^2\n\\]\nMore';
    const range = { from: 8, to: 15 }; // Range inside the math content
    const expanded = expandMarkdownRangeToMathBoundaries(markdown, range);

    assert.equal(expanded.from, 5); // Start of \[
    assert.equal(expanded.to, 20); // End of \]\n (match.end)
});

test('does not expand invalid range', () => {
    const markdown = 'Text $x$ text';
    const invalid = { from: 10, to: 5 }; // Invalid: from > to
    const expanded = expandMarkdownRangeToMathBoundaries(markdown, invalid);

    assert.equal(expanded.from, invalid.from);
    assert.equal(expanded.to, invalid.to);
});

test('handles empty markdown', () => {
    const expanded = expandMarkdownRangeToMathBoundaries('', { from: 0, to: 0 });
    assert.equal(expanded.from, 0);
    assert.equal(expanded.to, 0);
});

test('handles range at document start', () => {
    const markdown = '$x$ text';
    const range = { from: 0, to: 2 };
    const expanded = expandMarkdownRangeToMathBoundaries(markdown, range);

    assert.equal(expanded.from, 0);
    assert.equal(expanded.to, 3); // End of $x$
});

test('handles range at document end', () => {
    const markdown = 'text $y$';
    const range = { from: 6, to: 8 };
    const expanded = expandMarkdownRangeToMathBoundaries(markdown, range);

    assert.equal(expanded.from, 5); // Start of $y$
    assert.equal(expanded.to, 8);
});

test('preserves range that starts and ends outside math', () => {
    const markdown = 'Before $math$ after';
    const range = { from: 0, to: 19 };
    const expanded = expandMarkdownRangeToMathBoundaries(markdown, range);

    assert.equal(expanded.from, 0);
    assert.equal(expanded.to, 19);
});
