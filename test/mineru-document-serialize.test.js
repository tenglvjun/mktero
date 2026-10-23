import test from 'node:test';
import assert from 'node:assert/strict';
import { projectMinerULayout } from '../src/mineru/document/result-bundle.js';
import { buildMinerUDocumentIR, isPreparedMinerUDocument, prepareMinerUDocument } from '../src/mineru/document/prepare.js';
import { DOCUMENT_STRUCTURE, serializeDocumentIR } from '../src/mineru/document/serialize.js';
import { isValidSourceMapEntry } from '../src/core/markdown-source-map.js';
import { renderMarkdownHTML } from '../src/markdown/markdown-html.js';

const PAGE = [1000, 1000];
const IMAGE = 'images/a.jpg';

function line(bbox, ...spans) {
    return {
        bbox,
        spans: spans.map(span => typeof span === 'string' ? { bbox, type: 'text', content: span } : { bbox, ...span }),
    };
}

function block(type, bbox, ...lines) {
    return { type, bbox, lines: lines.length ? lines : [line(bbox, 'x')] };
}

function text(bbox, content, type = 'text') {
    return { type, bbox, lines: [line(bbox, ...[].concat(content))] };
}

function page(pageIndex, blocks, discarded = []) {
    return { page_idx: pageIndex, page_size: PAGE, para_blocks: blocks, discarded_blocks: discarded };
}

function bundle(pages, assets = [{ path: IMAGE, mimeType: 'image/jpeg', data: new Uint8Array([1]) }]) {
    return {
        markdown: 'MinerU full.md',
        assets,
        assetBasePath: '',
        layout: projectMinerULayout({ _backend: 'hybrid', pdf_info: pages }),
        contentList: [],
        extractedPages: pages.length,
        totalPages: pages.length,
    };
}

const BODY = 'The proposed method learns a representation of the signal that';
const REST = 'generalizes across tasks without retraining the whole model.';

function sampleBundle() {
    return bundle([
        page(0, [
            { ...text([100, 100, 900, 130], 'A Study of Things', 'title'), level: 1 },
            text([100, 150, 900, 170], '1. Introduction', 'title'),
            text([100, 180, 900, 860], `${BODY} uses 5 * 3 and costs $5 per arch-`),
            { type: 'image', bbox: [100, 600, 900, 800], blocks: [
                { type: 'image_body', bbox: [100, 600, 900, 780], lines: [line([100, 600, 900, 780], { type: 'image', image_path: 'a.jpg' })] },
                { type: 'image_caption', bbox: [100, 780, 900, 800], lines: [line([100, 780, 900, 800], 'Fig. 1. A caption with [1] and ', { type: 'inline_equation', content: 'x^2' })] },
            ] },
        ], [
            text([100, 20, 900, 40], 'Running Header Of The Journal'),
            text([100, 950, 900, 980], '1 A page footnote.'),
        ].map((item, index) => ({ ...item, type: index ? 'page_footnote' : 'header' }))),
        page(1, [
            text([100, 100, 900, 200], `itecture that ${REST}`),
            text([100, 220, 900, 240], '• First point of the list'),
            text([100, 245, 900, 265], '• Second point of the list'),
            { type: 'table', bbox: [100, 300, 900, 500], blocks: [
                { type: 'table_caption', bbox: [100, 300, 900, 320], lines: [line([100, 300, 900, 320], 'Table 1 Results')] },
                { type: 'table_body', bbox: [100, 320, 900, 480], lines: [line([100, 320, 900, 480], { type: 'table', html: '<table><tr><td><eq>a &lt; b</eq></td></tr></table>' })] },
                { type: 'table_footnote', bbox: [100, 480, 900, 500], lines: [line([100, 480, 900, 500], 'Values are means.')] },
            ] },
            { type: 'interline_equation', bbox: [300, 520, 700, 560], lines: [line([300, 520, 700, 560], { type: 'interline_equation', content: 'E = mc^2' })] },
            text([100, 600, 900, 620], 'www.example.org/data'),
            text([100, 650, 900, 670], 'References', 'title'),
            text([100, 680, 900, 700], '1. A. Author. A title. 2020.', 'ref_text'),
        ], [text([100, 20, 900, 40], 'Running Header Of The Journal')].map(item => ({ ...item, type: 'header' }))),
    ]);
}

test('writes the document IR as Markdown in reading order', () => {
    const prepared = prepareMinerUDocument(sampleBundle());
    assert.equal(prepared.markdown, [
        '# A Study of Things',
        '## 1. Introduction',
        `${BODY} uses 5 \\* 3 and costs \\$5 per architecture that ${REST}`,
        '![Fig. 1. A caption with \\[1\\] and $x^2$](images/a.jpg)',
        '- First point of the list\n- Second point of the list',
        'Table 1 Results',
        '<table><tr><td> $a < b$ </td></tr></table>',
        'Values are means.',
        '$$\nE = mc^2\n$$',
        '[www.example.org/data](https://www.example.org/data)',
        '## References',
        '1. A. Author. A title. 2020.',
    ].join('\n\n'));
    assert.equal(prepared.documentStructure, DOCUMENT_STRUCTURE);
    assert.deepEqual(prepared.chromeRanges, []);
    for (const field of ['contentList', 'layout', 'detailedLayout']) assert.equal(field in prepared, false);
    assert.equal(prepared.extractedPages, 2);
});

test('records an exact, valid source map with per-page ranges', () => {
    const prepared = prepareMinerUDocument(sampleBundle());
    const { markdown, sourceMap } = prepared;
    assert.ok(sourceMap.every(entry => isValidSourceMapEntry(entry, markdown.length)));
    const paragraph = sourceMap.find(entry => markdown.slice(entry.markdownFrom, entry.markdownTo).startsWith(BODY));
    assert.equal(paragraph.type, 'text');
    assert.deepEqual(paragraph.locations.map(location => location.pageIndex), [0, 1]);
    const [first, second] = paragraph.locationRanges;
    assert.equal(first.location.pageIndex, 0);
    assert.equal(second.location.pageIndex, 1);
    assert.ok(markdown.slice(first.markdownFrom, first.markdownTo).endsWith('per arch'));
    assert.ok(markdown.slice(second.markdownFrom, second.markdownTo).startsWith('itecture that'));
    assert.equal(first.markdownTo, second.markdownFrom);
    const image = sourceMap.find(entry => entry.type === 'image');
    assert.equal(image.locations.length, 1);
    assert.deepEqual(image.locations[0], { pageIndex: 0, bbox: [100, 600, 900, 780] });
    const caption = sourceMap.find(entry => markdown.slice(entry.markdownFrom, entry.markdownTo) === 'Table 1 Results');
    assert.deepEqual(caption.locations, [{ pageIndex: 1, bbox: [100, 300, 900, 320] }]);
    assert.equal(sourceMap.find(entry => entry.type === 'table').locations[0].pageIndex, 1);
    assert.equal(sourceMap.find(entry => entry.type === 'equation').locations[0].pageIndex, 1);
    // Every visible character belongs to exactly one entry; only the blank
    // lines between blocks are unmapped.
    const owners = new Array(markdown.length).fill(0);
    for (const entry of sourceMap) {
        for (let index = entry.markdownFrom; index < entry.markdownTo; index++) owners[index]++;
    }
    assert.ok(owners.every((count, index) => count === 1 || count === 0 && /\s/u.test(markdown[index])));
});

test('records block ranges for every serialized block', () => {
    const ir = buildMinerUDocumentIR(sampleBundle());
    const { markdown, blockRanges } = serializeDocumentIR(ir);
    const flow = ir.blocks.filter(item => item.role !== 'chrome' && item.role !== 'page-note');
    for (const item of flow) assert.ok(blockRanges.has(item.id), item.id);
    const figure = blockRanges.get(flow.find(item => item.kind === 'image').id);
    const [unit] = figure.units;
    assert.equal(markdown.slice(unit.image.from, unit.image.to), '![Fig. 1. A caption with \\[1\\] and $x^2$](images/a.jpg)');
    assert.equal(markdown.slice(unit.caption.from, unit.caption.to), 'Fig. 1. A caption with \\[1\\] and $x^2$');
    assert.equal(unit.caption.text, 'Fig. 1. A caption with [1] and $x^2$');
    const table = blockRanges.get(flow.find(item => item.kind === 'table').id);
    assert.deepEqual(table.units.map(item => item.kind), ['text', 'table', 'text']);
    assert.equal(table.units[2].footnote, true);
});

test('keeps decorations and page notes out of the Markdown', () => {
    const { markdown } = prepareMinerUDocument(sampleBundle());
    assert.doesNotMatch(markdown, /Running Header|page footnote/u);
});

test('renders captions, tables, lists, and links from the serialized Markdown', () => {
    const html = renderMarkdownHTML(prepareMinerUDocument(sampleBundle()).markdown, {
        resolveImageURL: source => `https://example.test/${source}`,
    });
    assert.match(html, /<figcaption><span class="mktero-figure-label">Fig\. 1\.<\/span> A caption with \[1\] and /u);
    assert.match(html, /<ul>\s*<li>First point of the list<\/li>\s*<li>Second point of the list<\/li>\s*<\/ul>/u);
    assert.match(html, /<table>/u);
    assert.match(html, /<a href="https:\/\/www\.example\.org\/data"/u);
    assert.match(html, /<h2[^>]*>1\. Introduction<\/h2>/u);
});

test('writes algorithms in the MinerU container and code in a long enough fence', () => {
    const prepared = prepareMinerUDocument(bundle([page(0, [
        { type: 'code', sub_type: 'algorithm', bbox: [100, 100, 900, 300], blocks: [
            { type: 'code_caption', bbox: [100, 100, 900, 120], lines: [line([100, 100, 900, 120], 'Algorithm 1 Train')] },
            { type: 'code_body', bbox: [100, 120, 900, 300], lines: [
                line([100, 120, 900, 140], 'Input: ', { type: 'inline_equation', content: 'x' }),
                line([100, 140, 900, 160], '</div> return'),
            ] },
        ] },
        { type: 'code', guess_lang: 'Python<script>', bbox: [100, 400, 900, 500], blocks: [
            { type: 'code_body', bbox: [100, 400, 900, 500], lines: [line([100, 400, 900, 500], 'print("```")')] },
        ] },
    ])]));
    assert.equal(prepared.markdown, [
        'Algorithm 1 Train',
        '<div class="mineru-algorithm" style="white-space: pre-wrap; font-family:monospace;">\nInput: $x$\n\\</div> return\n</div>',
        '````\nprint("```")\n````',
    ].join('\n\n'));
    // The reader renders each top-level block on its own.
    const algorithm = prepared.markdown.split('\n\n')[1];
    const html = renderMarkdownHTML(algorithm);
    assert.match(html, /^<section class="mktero-algorithm">/u);
    assert.match(html, /&lt;\/div&gt; return/u);
    assert.doesNotMatch(renderMarkdownHTML(prepared.markdown), /<script/iu);
});

test('turns a figure-captioned table into its image and keeps an unresolved image caption', () => {
    const prepared = prepareMinerUDocument(bundle([page(0, [
        { type: 'table', bbox: [100, 100, 900, 400], blocks: [
            { type: 'table_caption', bbox: [100, 100, 900, 120], lines: [line([100, 100, 900, 120], 'Figure 5. Forest plot.')] },
            { type: 'table_body', bbox: [100, 120, 900, 400], lines: [line([100, 120, 900, 400], { type: 'table', html: '<table><tr><td>x</td></tr></table>', image_path: 'a.jpg' })] },
        ] },
        { type: 'image', bbox: [100, 500, 900, 700], blocks: [
            { type: 'image_body', bbox: [100, 500, 900, 680], lines: [line([100, 500, 900, 680], { type: 'image', image_path: 'missing.jpg' })] },
            { type: 'image_caption', bbox: [100, 680, 900, 700], lines: [line([100, 680, 900, 700], 'Fig. 2. Lost image.')] },
        ] },
    ])]));
    assert.equal(prepared.markdown, '![Figure 5. Forest plot.](images/a.jpg)\n\nFig. 2. Lost image.');
});

test('adds a layout marker for a captioned run of panels', () => {
    const assets = ['a.jpg', 'b.jpg'].map(name => ({ path: `images/${name}`, mimeType: 'image/jpeg', data: new Uint8Array([1]) }));
    const panel = (x, name) => ({ type: 'image', bbox: [x, 100, x + 380, 400], blocks: [
        { type: 'image_body', bbox: [x, 100, x + 380, 400], lines: [line([x, 100, x + 380, 400], { type: 'image', image_path: name })] },
    ] });
    const prepared = prepareMinerUDocument(bundle([page(0, [
        panel(100, 'a.jpg'),
        panel(520, 'b.jpg'),
        text([100, 420, 900, 440], 'Figure 1. Two panels side by side.'),
    ])], assets));
    assert.match(prepared.markdown, /^<!-- mktero-figure-layout: columns=2 rows=2 -->\n!\[\]\(images\/a\.jpg\)\n\n!\[\]\(images\/b\.jpg\)\n\nFigure 1\. Two panels/u);
    assert.ok(prepared.sourceMap.every(entry => isValidSourceMapEntry(entry, prepared.markdown.length)));
});

test('is deterministic and idempotent', () => {
    const first = prepareMinerUDocument(sampleBundle());
    const second = prepareMinerUDocument(sampleBundle());
    assert.deepEqual(first.markdown, second.markdown);
    assert.deepEqual(first.sourceMap, second.sourceMap);
    assert.equal(isPreparedMinerUDocument(first), true);
    assert.equal(prepareMinerUDocument(first), first);
});

test('falls back to the content list, then to MinerU Markdown', () => {
    const fromContentList = prepareMinerUDocument({
        markdown: 'ignored',
        assets: [],
        contentList: [
            { type: 'text', text: 'Content list paragraph.', pageIndex: 0, bbox: [100, 100, 900, 200] },
        ],
    });
    assert.equal(fromContentList.markdown, 'Content list paragraph.');
    assert.equal(fromContentList.documentStructure, DOCUMENT_STRUCTURE);
    const fromMarkdown = prepareMinerUDocument({ markdown: '# Raw', assets: [] });
    assert.equal(fromMarkdown.markdown, '# Raw');
    assert.equal(fromMarkdown.documentStructure, undefined);
    assert.deepEqual(fromMarkdown.chromeRanges, []);
});
