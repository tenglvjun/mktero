import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MAX_DOCUMENT_SEARCH_MATCHES,
    searchMarkdownDocument,
} from '../src/markdown/markdown-document-search.js';

test('finds visible prose and maps matches back onto Markdown source', () => {
    const result = searchMarkdownDocument('See **BERT** in methods.', 'BERT');

    assert.deepEqual(result, {
        matches: [{ from: 6, to: 10 }],
        truncated: false,
    });
});

test('skips hidden chrome ranges', () => {
    const markdown = 'CHROME\n\nVisible BERT here.';
    const result = searchMarkdownDocument(markdown, 'CHROME', {
        chromeRanges: [{ from: 0, to: 8 }],
    });

    assert.deepEqual(result, {
        matches: [],
        truncated: false,
    });
    assert.deepEqual(
        searchMarkdownDocument(markdown, 'BERT', {
            chromeRanges: [{ from: 0, to: 8 }],
        }).matches,
        [{ from: 16, to: 20 }]
    );
});

test('matches case-insensitively by default', () => {
    const result = searchMarkdownDocument(
        'The bert model and BERT.',
        'BERT'
    );

    assert.deepEqual(result.matches, [
        { from: 4, to: 8 },
        { from: 19, to: 23 },
    ]);
    assert.equal(result.truncated, false);
});

test('can match case-sensitively', () => {
    const result = searchMarkdownDocument(
        'The bert model and BERT.',
        'BERT',
        { caseSensitive: true }
    );

    assert.deepEqual(result.matches, [{ from: 19, to: 23 }]);
});

test('treats regex characters as literal text', () => {
    const result = searchMarkdownDocument('Use C++ and a.b here.', 'a.b');

    assert.deepEqual(result.matches, [{ from: 12, to: 15 }]);
});

test('does not match raw math delimiters', () => {
    const result = searchMarkdownDocument('Before $n = 22$ after.', '$n');

    assert.deepEqual(result, {
        matches: [],
        truncated: false,
    });
});

test('returns no matches for an empty query', () => {
    assert.deepEqual(searchMarkdownDocument('BERT appears here.', ''), {
        matches: [],
        truncated: false,
    });
});

test('stops after the match budget and reports truncation', () => {
    const result = searchMarkdownDocument('aaaa', 'a', { maxMatches: 2 });

    assert.deepEqual(result, {
        matches: [
            { from: 0, to: 1 },
            { from: 1, to: 2 },
        ],
        truncated: true,
    });
    assert.equal(MAX_DOCUMENT_SEARCH_MATCHES, 10_000);
});
