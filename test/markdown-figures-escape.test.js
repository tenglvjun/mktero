import test from 'node:test';
import assert from 'node:assert/strict';
import {
    escapeImageDescription,
    unescapeImageDescription,
} from '../src/markdown/markdown-figures.js';

// Golden values captured from the original implementation. The single-pass
// refactor must not change escaping behavior.
const ESCAPED = [
    ['', ''],
    ['[', '\\['],
    [']', '\\]'],
    ['\\', '\\\\'],
    ['\\[', '\\\\['],
    ['\\]', '\\\\]'],
    ['\\\\', '\\\\\\'],
    ['a[b]c', 'a\\[b\\]c'],
    ['\\*', '\\*'],
    ['\\[x\\]', '\\\\[x\\\\]'],
    ['Fig. 1 [a] and \\text', 'Fig. 1 \\[a\\] and \\\\text'],
    ['[[[]]]', '\\[\\[\\[\\]\\]\\]'],
    ['text ] [ text', 'text \\] \\[ text'],
    ['head\\[', 'head\\\\['],
    ['\\]tail', '\\\\]tail'],
    ['_', '_'],
    ['a\\\\b', 'a\\\\\\b'],
    ['Fig. 2 (a) \\*b\\*', 'Fig. 2 (a) \\*b\\*'],
];

test('escapes image descriptions exactly like the original escaping', () => {
    for (const [value, expected] of ESCAPED) {
        assert.equal(
            escapeImageDescription(value),
            expected,
            JSON.stringify(value)
        );
    }
});

test('keeps existing Markdown escapes single and escapes raw backslashes', () => {
    assert.equal(escapeImageDescription('\\*'), '\\*');
    assert.equal(escapeImageDescription('a \\_ b'), 'a \\_ b');
    assert.equal(escapeImageDescription('\\'), '\\\\');
    assert.equal(escapeImageDescription('a[b]'), 'a\\[b\\]');
});

test('round-trips well-formed captions through escaping', () => {
    for (const value of [
        '',
        '[',
        ']',
        'a[b]c',
        '\\*',
        'Fig. 1 [a]',
        'text ] [ text',
        '\\text',
    ]) {
        assert.equal(
            unescapeImageDescription(escapeImageDescription(value)),
            value,
            JSON.stringify(value)
        );
    }
});
