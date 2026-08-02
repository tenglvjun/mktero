import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createEvidenceSnippet,
    formatEvidenceMarkdown,
} from '../src/markdown/markdown-evidence.js';
import { createLocalization, translateEnglish } from '../src/i18n/localization.js';

const SOURCE_MAP = [{
    type: 'text',
    markdownFrom: 0,
    markdownTo: 28,
    locations: [
        { pageIndex: 2, bbox: [100, 120, 900, 220] },
        { pageIndex: 3, bbox: [100, 80, 900, 160] },
        { pageIndex: 2, bbox: [100, 120, 900, 220] },
    ],
}];

test('creates a quoted evidence snippet for a reliably mapped selection', () => {
    const snippet = createEvidenceSnippet({
        markdown: 'A reliable result is reported.',
        sourceMap: SOURCE_MAP,
        target: {
            kind: 'selection',
            text: 'reliable result',
            ranges: [{ from: 2, to: 17 }],
        },
    });

    assert.deepEqual(snippet, {
        kind: 'selection',
        markdown: '> reliable result',
        locations: [
            { pageIndex: 2, bbox: [100, 120, 900, 220] },
            { pageIndex: 3, bbox: [100, 80, 900, 160] },
        ],
        pageIndexes: [2, 3],
    });
});

test('creates evidence for a selection spanning rendered inline math', () => {
    const markdown = 'Before $n = 22$ after.';
    const snippet = createEvidenceSnippet({
        markdown,
        sourceMap: [{
            type: 'text',
            markdownFrom: 0,
            markdownTo: markdown.length,
            locations: [{ pageIndex: 0, bbox: [100, 100, 900, 200] }],
        }],
        target: {
            kind: 'selection',
            text: 'Before n = 22 after.',
            ranges: [{ from: 0, to: markdown.length }],
        },
    });

    assert.equal(snippet.markdown, '> Before n \\= 22 after\\.');
});

test('formats evidence with localized links for every source page', () => {
    const snippet = createEvidenceSnippet({
        markdown: 'A reliable result is reported.',
        sourceMap: SOURCE_MAP,
        target: {
            kind: 'selection',
            text: 'reliable result',
            ranges: [{ from: 2, to: 17 }],
        },
    });
    const reference = {
        title: 'Paper [draft] <script>',
        pages: [
            {
                pageIndex: 2,
                pageNumber: 3,
                href: 'zotero://open-pdf/library/items/ABC123?page=3',
            },
            {
                pageIndex: 3,
                pageNumber: 4,
                href: 'zotero://open-pdf/library/items/ABC123?page=4',
            },
        ],
    };
    const messages = {
        'evidence.source.single': 'Source: [{title}, p. {page}]({href})',
        'evidence.source.multiple': 'Source: {title}, {pages}',
        'evidence.pageLink': '[p. {page}]({href})',
        'evidence.pageSeparator': ', ',
    };

    assert.equal(formatEvidenceMarkdown(
        snippet,
        reference,
        (key, values = {}) => Object.entries(values).reduce(
            (message, [name, value]) => message.replace(`{${name}}`, value),
            messages[key]
        )
    ), [
        '> reliable result',
        '',
        'Source: Paper \\[draft\\] \\<script\\>, [p. 3](zotero://open-pdf/library/items/ABC123?page=3), [p. 4](zotero://open-pdf/library/items/ABC123?page=4)',
    ].join('\n'));
});

test('formats a single source page in the active Zotero language', () => {
    const snippet = {
        markdown: '> Evidence',
        pageIndexes: [0],
    };
    const reference = {
        title: 'Paper',
        pages: [{
            pageIndex: 0,
            pageNumber: 1,
            href: 'zotero://open-pdf/library/items/ABC123?page=1',
        }],
    };

    assert.equal(
        formatEvidenceMarkdown(snippet, reference, translateEnglish),
        '> Evidence\n\nSource: [Paper, p. 1]('
            + 'zotero://open-pdf/library/items/ABC123?page=1)'
    );
    const chinese = createLocalization({ zoteroLocale: 'zh-CN' });
    assert.equal(
        formatEvidenceMarkdown(snippet, reference, chinese.t.bind(chinese)),
        '> Evidence\n\n来源：[Paper，第 1 页]('
            + 'zotero://open-pdf/library/items/ABC123?page=1)'
    );
});

test('rejects selections that are not fully covered by one reliable source block', () => {
    assert.throws(() => createEvidenceSnippet({
        markdown: 'A reliable result is reported. Unmapped conclusion.',
        sourceMap: SOURCE_MAP,
        target: {
            kind: 'selection',
            text: 'result is reported. Unmapped',
            ranges: [{ from: 11, to: 39 }],
        },
    }), error => error?.code === 'MKTERO_EVIDENCE_SOURCE_UNAVAILABLE');
});

test('rejects selection text that does not match its claimed Markdown range', () => {
    assert.throws(() => createEvidenceSnippet({
        markdown: 'A reliable result is reported.',
        sourceMap: SOURCE_MAP,
        target: {
            kind: 'selection',
            text: 'A fabricated conclusion',
            ranges: [{ from: 2, to: 17 }],
        },
    }), error => error?.code === 'MKTERO_EVIDENCE_INVALID');
});

test('copies a mapped prose block as safe visible Markdown', () => {
    const markdown = '**Important** result <script>alert(1)</script>.';
    const snippet = createEvidenceSnippet({
        markdown,
        sourceMap: [{
            type: 'text',
            markdownFrom: 0,
            markdownTo: markdown.length,
            locations: [{ pageIndex: 0, bbox: [100, 100, 900, 200] }],
        }],
        target: { kind: 'block', from: 0, to: markdown.length },
    });

    assert.equal(
        snippet.markdown,
        '> Important result \\<script\\>alert\\(1\\)\\<\\/script\\>\\.'
    );
});

test('neutralizes Markdown syntax, math, and bare links in quoted prose', () => {
    const markdown = 'Prefix # Result\nhttps://example.com and $x$ > baseline.';
    const snippet = createEvidenceSnippet({
        markdown,
        sourceMap: [{
            type: 'text',
            markdownFrom: 0,
            markdownTo: markdown.length,
            locations: [{ pageIndex: 0, bbox: [100, 100, 900, 200] }],
        }],
        target: { kind: 'block', from: 0, to: markdown.length },
    });

    assert.equal(snippet.markdown, [
        '> Prefix \\# Result',
        '> https\\:\\/\\/example\\.com and x \\> baseline\\.',
    ].join('\n'));
});

test('preserves a safe mapped display equation', () => {
    const markdown = '$$\nE = mc^2\n$$';
    const snippet = createEvidenceSnippet({
        markdown,
        sourceMap: [{
            type: 'equation',
            markdownFrom: 0,
            markdownTo: markdown.length,
            locations: [{ pageIndex: 4, bbox: [200, 300, 800, 420] }],
        }],
        target: { kind: 'block', from: 0, to: markdown.length },
    });

    assert.equal(snippet.markdown, markdown);
});

test('copies a mapped GFM table without forwarding raw HTML', () => {
    const markdown = [
        '| Claim | Value |',
        '| --- | --- |',
        '| **A** <script>x</script> | 42 |',
    ].join('\n');
    const snippet = createEvidenceSnippet({
        markdown,
        sourceMap: [{
            type: 'table',
            markdownFrom: 0,
            markdownTo: markdown.length,
            locations: [{ pageIndex: 5, bbox: [100, 180, 900, 760] }],
        }],
        target: { kind: 'block', from: 0, to: markdown.length },
    });

    assert.equal(snippet.markdown, [
        '| Claim | Value |',
        '| --- | --- |',
        '| A \\<script\\>x\\<\\/script\\> | 42 |',
    ].join('\n'));
});

test('copies a mapped image caption without its cache path', () => {
    const markdown = '![Figure 1. Important result](images/figure.png)';
    const snippet = createEvidenceSnippet({
        markdown,
        sourceMap: [{
            type: 'image',
            markdownFrom: 0,
            markdownTo: markdown.length,
            locations: [{ pageIndex: 6, bbox: [80, 100, 920, 700] }],
        }],
        target: { kind: 'block', from: 0, to: markdown.length },
    });

    assert.equal(snippet.markdown, '> Figure 1\\. Important result');
    assert.doesNotMatch(snippet.markdown, /images\/figure\.png/);
});

test('copies the shared caption for a mapped figure panel', () => {
    const first = '![](images/panel-a.png)';
    const markdown = [
        first,
        '',
        '![](images/panel-b.png)  ',
        'Figure 2. Comparison across panels.',
    ].join('\n');
    const snippet = createEvidenceSnippet({
        markdown,
        sourceMap: [{
            type: 'image',
            markdownFrom: 0,
            markdownTo: first.length,
            locations: [{ pageIndex: 7, bbox: [80, 100, 460, 700] }],
        }],
        target: { kind: 'block', from: 0, to: first.length },
    });

    assert.equal(snippet.markdown, '> Figure 2\\. Comparison across panels\\.');
});

test('rejects typed blocks that cannot be exported in their safe structure', () => {
    const cases = [
        { type: 'equation', markdown: '$inline math$' },
        { type: 'table', markdown: 'not | a valid table' },
        {
            type: 'image',
            markdown: '![images/private-cache/figure.png]('
                + 'images/private-cache/figure.png)',
        },
    ];

    for (const entry of cases) {
        assert.throws(() => createEvidenceSnippet({
            markdown: entry.markdown,
            sourceMap: [{
                type: entry.type,
                markdownFrom: 0,
                markdownTo: entry.markdown.length,
                locations: [{ pageIndex: 0, bbox: [100, 100, 900, 300] }],
            }],
            target: {
                kind: 'block',
                from: 0,
                to: entry.markdown.length,
            },
        }), error => error?.code === 'MKTERO_EVIDENCE_UNSUPPORTED');
    }
});

test('rejects unsafe display equations instead of copying executable macros', () => {
    for (const markdown of [
        '$$\n\\def\\unsafe{payload}\n$$',
        '$$\n\\href{javascript:alert(1)}{unsafe}\n$$',
        '$$\nE = mc^2\n$$\n\n[unsafe](javascript:alert(1))\n\n$$',
    ]) {
        assert.throws(() => createEvidenceSnippet({
            markdown,
            sourceMap: [{
                type: 'equation',
                markdownFrom: 0,
                markdownTo: markdown.length,
                locations: [{ pageIndex: 0, bbox: [100, 100, 900, 300] }],
            }],
            target: { kind: 'block', from: 0, to: markdown.length },
        }), error => error?.code === 'MKTERO_EVIDENCE_UNSUPPORTED');
    }
});

test('rejects oversized evidence and injected Zotero links', () => {
    const markdown = 'x'.repeat(1025);
    assert.throws(() => createEvidenceSnippet({
        markdown,
        sourceMap: [{
            type: 'text',
            markdownFrom: 0,
            markdownTo: markdown.length,
            locations: [{ pageIndex: 0, bbox: [100, 100, 900, 300] }],
        }],
        target: { kind: 'block', from: 0, to: markdown.length },
        maxContentLength: 1024,
    }), error => error?.code === 'MKTERO_EVIDENCE_TOO_LARGE');

    assert.throws(() => formatEvidenceMarkdown({
        markdown: '> Evidence',
        pageIndexes: [0],
    }, {
        title: 'Paper',
        pages: [{
            pageIndex: 0,
            pageNumber: 1,
            href: 'zotero://open-pdf/library/items/ABC?page=1)\n<script>',
        }],
    }, () => ''), error => error?.code === 'MKTERO_EVIDENCE_INVALID');

    assert.throws(() => formatEvidenceMarkdown({
        markdown: '> Evidence',
        pageIndexes: [0],
    }, {
        title: 'Paper',
        pages: [{
            pageIndex: 0,
            pageNumber: 2,
            href: 'zotero://open-pdf/library/items/ABC?page=1',
        }],
    }, () => ''), error => error?.code === 'MKTERO_EVIDENCE_INVALID');

    assert.throws(() => formatEvidenceMarkdown({
        markdown: '> Evidence',
        pageIndexes: [0],
    }, {
        title: 'Paper',
        pages: [{
            pageIndex: 0,
            pageNumber: 1,
            href: 'zotero://open-pdf/groups/1)\nInjected/items/ABC?page=1',
        }],
    }, () => ''), error => error?.code === 'MKTERO_EVIDENCE_INVALID');
});

test('enforces limits after snippet generation and source attribution', () => {
    const image = '![](images/panel-a.png)';
    const markdown = [
        image,
        '',
        '![](images/panel-b.png)  ',
        `Figure 1. ${'x'.repeat(80)}`,
    ].join('\n');
    assert.throws(() => createEvidenceSnippet({
        markdown,
        sourceMap: [{
            type: 'image',
            markdownFrom: 0,
            markdownTo: image.length,
            locations: [{ pageIndex: 0, bbox: [100, 100, 900, 300] }],
        }],
        target: { kind: 'block', from: 0, to: image.length },
        maxContentLength: 64,
    }), error => error?.code === 'MKTERO_EVIDENCE_TOO_LARGE');

    assert.throws(() => formatEvidenceMarkdown({
        markdown: '> Evidence',
        pageIndexes: [0],
    }, {
        title: `Paper ${'x'.repeat(80)}`,
        pages: [{
            pageIndex: 0,
            pageNumber: 1,
            href: 'zotero://open-pdf/library/items/ABC?page=1',
        }],
    }, translateEnglish, {
        maxContentLength: 64,
    }), error => error?.code === 'MKTERO_EVIDENCE_TOO_LARGE');
});
