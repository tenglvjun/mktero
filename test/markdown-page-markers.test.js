import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createPageMarkerSourceMap,
    findMarkdownPageMarkers,
    pageMarkerPageIndex,
    resolvePageMarkerSourceLocation,
} from '../src/core/markdown-page-markers.js';

test('finds page marker comments with their exact offsets', () => {
    const markdown = 'Para one.\n\n<!-- zotero-page: 2 -->\n\nPara two.';
    assert.deepEqual(findMarkdownPageMarkers(markdown), [{
        page: '2',
        from: 11,
        to: 34,
    }]);
});

test('finds every page marker in document order', () => {
    const markdown = [
        'First',
        '',
        '<!-- zotero-page: 1 -->',
        '',
        'Second',
        '',
        '<!-- zotero-page: 12 -->',
        '',
        'Third',
    ].join('\n');
    const markers = findMarkdownPageMarkers(markdown);
    assert.equal(markers.length, 2);
    assert.deepEqual(markers.map(marker => marker.page), ['1', '12']);
    assert.ok(markers[0].from < markers[1].from);
    assert.equal(markdown.slice(markers[1].from, markers[1].to),
        '<!-- zotero-page: 12 -->');
});

test('ignores page marker comments that are not standalone blocks', () => {
    const markdown = [
        'inline <!-- zotero-page: 2 --> text',
        '',
        'text <!-- zotero-page: 4 -->',
    ].join('\n');
    assert.deepEqual(findMarkdownPageMarkers(markdown), []);
});

test('accepts non-numeric page labels as display text', () => {
    const markdown = '<!-- zotero-page: A-1 -->\n\nPara.';
    assert.deepEqual(findMarkdownPageMarkers(markdown), [{
        page: 'A-1',
        from: 0,
        to: 25,
    }]);
});

test('returns no markers for non-string input', () => {
    assert.deepEqual(findMarkdownPageMarkers(null), []);
    assert.deepEqual(findMarkdownPageMarkers(undefined), []);
    assert.deepEqual(findMarkdownPageMarkers(42), []);
});

test('builds whole-page source map entries from markers', () => {
    const markdown = [
        'Para one.',
        '',
        '<!-- zotero-page: 2 -->',
        '',
        'Para two.',
        '',
        '<!-- zotero-page: 3 -->',
        '',
        'Para three.',
    ].join('\n');
    const markers = findMarkdownPageMarkers(markdown);
    const sourceMap = createPageMarkerSourceMap(markdown, markers);
    assert.equal(sourceMap.length, 2);
    assert.equal(sourceMap[0].type, 'page');
    assert.equal(sourceMap[0].markdownFrom, markers[0].to);
    assert.equal(sourceMap[0].markdownTo, markers[1].from);
    assert.deepEqual(sourceMap[0].locations, [{
        pageIndex: 1,
        bbox: [0, 0, 1000, 1000],
    }]);
    assert.deepEqual(sourceMap[1].locations, [{
        pageIndex: 2,
        bbox: [0, 0, 1000, 1000],
    }]);
});

test('derives the page index from the numeric label', () => {
    assert.equal(
        pageMarkerPageIndex({ page: '4' }, 9),
        3
    );
    assert.equal(
        pageMarkerPageIndex({ page: '1' }, 9),
        0
    );
});

test('falls back to the ordinal position for non-numeric labels', () => {
    assert.equal(
        pageMarkerPageIndex({ page: 'A-1' }, 3),
        3
    );
    assert.equal(pageMarkerPageIndex({ page: 'iv' }, 0), 0);
    assert.equal(pageMarkerPageIndex({ page: '0' }, 4), 4);
    assert.equal(pageMarkerPageIndex(null, 2), 2);
    assert.equal(pageMarkerPageIndex({ page: '' }, -1), null);
});

test('last page marker entry extends to the document end', () => {
    const markdown = 'Para one.\n\n<!-- zotero-page: 2 -->\n\nTail.';
    const markers = findMarkdownPageMarkers(markdown);
    const sourceMap = createPageMarkerSourceMap(markdown, markers);
    assert.equal(sourceMap.length, 1);
    assert.equal(sourceMap[0].markdownTo, markdown.length);
});

test('page marker source map is empty without markers', () => {
    assert.deepEqual(createPageMarkerSourceMap('no markers here', []), []);
    assert.deepEqual(createPageMarkerSourceMap('', null), []);
    const markdown = 'No page boundaries.';
    assert.deepEqual(
        createPageMarkerSourceMap(markdown, findMarkdownPageMarkers(markdown)),
        []
    );
});

test('resolves a marker to its own whole-page entry', () => {
    const markdown = 'Para one.\n\n<!-- zotero-page: 4 -->\n\nPara two.';
    const markers = findMarkdownPageMarkers(markdown);
    const sourceMap = createPageMarkerSourceMap(markdown, markers);
    assert.deepEqual(
        resolvePageMarkerSourceLocation(sourceMap, markers, 0, markdown.length),
        { pageIndex: 3, bbox: [0, 0, 1000, 1000] }
    );
});

test('resolves a marker to the nearest following mapped block', () => {
    const markdown = 'Header\n\n<!-- zotero-page: 2 -->\n\nMapped paragraph.';
    const markers = findMarkdownPageMarkers(markdown);
    const sourceMap = [{
        type: 'text',
        markdownFrom: markers[0].to,
        markdownTo: markdown.length,
        locations: [{ pageIndex: 1, bbox: [10, 20, 900, 200] }],
    }];
    assert.deepEqual(
        resolvePageMarkerSourceLocation(sourceMap, markers, 0, markdown.length),
        { pageIndex: 1, bbox: [10, 20, 900, 200] }
    );
});

test('resolves a marker before any entry to the first following entry', () => {
    const markdown = '<!-- zotero-page: 1 -->\n\nPara one.\n\nPara two.';
    const markers = findMarkdownPageMarkers(markdown);
    const sourceMap = [{
        type: 'text',
        markdownFrom: markers[0].to,
        markdownTo: markdown.length,
        locations: [{ pageIndex: 0, bbox: [0, 0, 900, 900] }],
    }];
    assert.deepEqual(
        resolvePageMarkerSourceLocation(sourceMap, markers, 0, markdown.length),
        { pageIndex: 0, bbox: [0, 0, 900, 900] }
    );
});

test('resolves a marker inside a real source map to the mapped block', () => {
    const markdown = 'Para.\n\n<!-- zotero-page: 2 -->\n\nUnmapped tail.';
    const markers = findMarkdownPageMarkers(markdown);
    // A populated source map with no usable entries: the whole-page label
    // fallback still applies.
    assert.deepEqual(
        resolvePageMarkerSourceLocation(
            [{ type: 'text', markdownFrom: 0, markdownTo: 4, locations: [] }],
            markers,
            0,
            markdown.length
        ),
        { pageIndex: 1, bbox: [0, 0, 1000, 1000] }
    );
});

test('falls back to the marker label when the document has no source map', () => {
    const markdown = 'Para one.\n\n<!-- zotero-page: 7 -->\n\nPara two.';
    const markers = findMarkdownPageMarkers(markdown);
    assert.deepEqual(
        resolvePageMarkerSourceLocation([], markers, 0, markdown.length),
        { pageIndex: 6, bbox: [0, 0, 1000, 1000] }
    );
});

test('falls back to the ordinal position without a numeric label', () => {
    const markdown = 'Para one.\n\n<!-- zotero-page: iv -->\n\nPara two.';
    const markers = findMarkdownPageMarkers(markdown);
    assert.deepEqual(
        resolvePageMarkerSourceLocation([], markers, 0, markdown.length),
        { pageIndex: 0, bbox: [0, 0, 1000, 1000] }
    );
});

test('rejects invalid marker indexes and malformed markers', () => {
    const markdown = '<!-- zotero-page: 2 -->';
    const markers = findMarkdownPageMarkers(markdown);
    assert.equal(resolvePageMarkerSourceLocation([], markers, 1), null);
    assert.equal(resolvePageMarkerSourceLocation([], markers, -1), null);
    assert.equal(
        resolvePageMarkerSourceLocation([], [{ from: 5, to: 5 }], 0),
        null
    );
    assert.equal(resolvePageMarkerSourceLocation([], null, 0), null);
});

test('ignores out-of-range entries and falls back to the marker label', () => {
    const markdown = '<!-- zotero-page: 2 -->\n\nPara.';
    const markers = findMarkdownPageMarkers(markdown);
    const sourceMap = [{
        type: 'page',
        markdownFrom: markers[0].to,
        markdownTo: 10_000,
        locations: [{ pageIndex: 9, bbox: [0, 0, 1000, 1000] }],
    }];
    assert.deepEqual(
        resolvePageMarkerSourceLocation(sourceMap, markers, 0, markdown.length),
        { pageIndex: 1, bbox: [0, 0, 1000, 1000] }
    );
});
