import test from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { isMinerUMiddleJSON, projectMinerUMiddleJSON } from '../src/mineru/document/ingest-middle-v2.js';
import { validateMinerULayout } from '../src/mineru/document/result-bundle.js';
import { buildMinerUDocumentIR, prepareMinerUDocument } from '../src/mineru/document/prepare.js';
import { extractMinerULocalResultFromZip } from '../src/mineru/local-result.js';
import { prepareLocalMinerUResult } from '../src/mineru/local-conversion.js';

// Synthetic DocVortex Middle JSON 2.0, shaped like MinerU 4.0's
// middle_json.json: [0, 1] boxes, inline spans, page sizes in points.
const text = (content, styles) => ({ type: 'text', content, ...(styles ? { styles } : {}) });
const box = (x0, y0, x1, y1) => [x0 / 1000, y0 / 1000, x1 / 1000, y1 / 1000];
const LONG = 'The proposed model learns representations of the signal that generalize across tasks, '
    + 'and it keeps what it learned while it adapts to new ones in a few steps of training on each of the';

function middle(pages, sizes = pages.map((_, index) => ({ page_idx: index, width_pt: 600, height_pt: 800 }))) {
    return {
        schema: 'docvortex.middle',
        schema_version: '2.0',
        metadata: { file_suffix: 'pdf', producer: { name: 'mineru', version: '4.0.12' } },
        extensions: { mineru: { tier: 'standard', parse_mode: 'ocr' }, docvortex_layout: { version: 1, pages: sizes } },
        is_full_document: true,
        pages: pages.map((blocks, page_idx) => ({ page_idx, blocks: blocks.map((block, index) => ({ index, ...block })) })),
    };
}

const PAPER = middle([
    [
        { type: 'header', bbox: box(100, 20, 900, 35), content: [text('Journal of Things 12 (2026)')] },
        { type: 'doc_title', level: 1, bbox: box(100, 60, 900, 100), content: [text('A Study of Things')] },
        { type: 'paragraph_title', level: 2, bbox: box(100, 120, 400, 140), content: [text('1. Introduction')] },
        {
            type: 'text',
            bbox: box(100, 150, 900, 300),
            content: [text('Things matter'), text('1', ['superscript']), text(' and cost '), { type: 'equation_inline', content: 'x^2' },
                text(' units, as '), { type: 'hyperlink', url: 'https://example.org', content: [text('shown here')] }, text('.')],
        },
        { type: 'equation', bbox: box(300, 310, 700, 340), content: 'E = mc^2' },
        {
            type: 'list',
            sub_type: 'text',
            bbox: box(100, 350, 900, 420),
            content: [
                { type: 'text', content: [text('• first point of the list')] },
                { type: 'text', content: [text('• second point of the list')] },
            ],
        },
        {
            type: 'table',
            bbox: box(100, 430, 900, 600),
            content: [
                { type: 'table_caption', content: [text('Table 1. Results of the study.')] },
                { type: 'table_body', bbox: box(100, 450, 900, 600), content: '<table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>' },
            ],
        },
        { type: 'text', bbox: box(100, 800, 900, 960), content: [text(LONG)] },
        { type: 'page_footnote', bbox: box(100, 965, 900, 985), content: [text('1', ['superscript']), text(' A note about things.')] },
        { type: 'page_number', bbox: box(480, 988, 520, 998), content: [text('1')] },
    ],
    [
        {
            type: 'table',
            continues_prev: true,
            bbox: box(100, 60, 900, 120),
            content: [{ type: 'table_body', bbox: box(100, 60, 900, 120), content: '<table><tr><td>3</td><td>4</td></tr></table>' }],
        },
        { type: 'text', continues_prev: true, bbox: box(100, 130, 900, 200), content: [text('new tasks, which we show on six benchmarks.')] },
        {
            type: 'image',
            bbox: box(100, 220, 900, 600),
            content: [
                { type: 'image_body', bbox: box(100, 220, 900, 560), content: '', image_path: 'images/page_1_image_2.png' },
                { type: 'image_caption', content: [text('Figure 1. The thing.')] },
            ],
        },
        {
            type: 'chart',
            bbox: box(100, 620, 900, 900),
            content: [
                { type: 'chart_body', bbox: box(100, 620, 900, 880), content: '<table><tr><td>year</td><td>value</td></tr></table>', image_path: 'images/page_1_chart_3.png' },
                { type: 'chart_caption', content: [text('Figure 2. Values over the years.')] },
            ],
        },
        { type: 'paragraph_title', level: 2, bbox: box(100, 910, 400, 930), content: [text('References')] },
        { type: 'list', sub_type: 'ref_text', bbox: box(100, 935, 900, 990), content: [
            { type: 'ref_text', content: [text('[1] A. Author. A paper. 2020.')] },
        ] },
    ],
]);

const ASSETS = ['images/page_1_image_2.png', 'images/page_1_chart_3.png']
    .map(path => ({ path, mimeType: 'image/png', data: new Uint8Array([1]) }));

function prepared() {
    const layout = projectMinerUMiddleJSON(PAPER);
    return prepareMinerUDocument({ markdown: '', assets: ASSETS, assetBasePath: '', contentList: [], layout });
}

test('projects MinerU 4.0 middle JSON to the layout the document pipeline reads', () => {
    assert.equal(isMinerUMiddleJSON(PAPER), true);
    assert.equal(isMinerUMiddleJSON({ pdf_info: [] }), false);
    const layout = projectMinerUMiddleJSON(PAPER);
    assert.equal(validateMinerULayout(layout), true);
    assert.equal(layout.version, '4.0.12');
    assert.equal(layout.effort, 'standard');
    assert.equal(layout.ocrEnabled, true);
    assert.deepEqual(layout.pages.map(page => page.pageSize), [[600, 800], [600, 800]]);
    assert.deepEqual(layout.pages[0].blocks.map(block => block.type),
        ['title', 'title', 'text', 'interline_equation', 'text', 'text', 'table', 'text']);
    assert.deepEqual(layout.pages[0].discarded.map(block => block.type), ['header', 'page_footnote', 'page_number']);
    assert.deepEqual(layout.pages[0].blocks[2].bbox, [60, 120, 540, 240]);
    assert.deepEqual(layout.pages[0].blocks[2].lines[0].spans, [
        { type: 'text', content: 'Things matter' },
        { type: 'inline_equation', content: '^{1}' },
        { type: 'text', content: ' and cost ' },
        { type: 'inline_equation', content: 'x^2' },
        { type: 'text', content: ' units, as ' },
        { type: 'text', content: 'shown here', linkURL: 'https://example.org' },
        { type: 'text', content: '.' },
    ]);
    assert.equal(layout.diagnostics.continuations, 1);
});

test('reads a MinerU 4.0 paper as continuous Markdown', () => {
    const { markdown, sourceMap } = prepared();
    const blocks = markdown.split('\n\n');
    assert.equal(blocks[0], '# A Study of Things');
    assert.equal(blocks[1], '## 1. Introduction');
    assert.equal(blocks[2], 'Things matter $^{1}$ and cost $x^2$ units, as [shown here](https://example.org).');
    assert.match(markdown, /\$\$\nE = mc\^2\n\$\$/u);
    assert.match(markdown, /- first point of the list\n- second point of the list/u);
    // The table continued on the next page is one table.
    assert.match(markdown, /<table><tr><td>a<\/td><td>b<\/td><\/tr><tr><td>1<\/td><td>2<\/td><\/tr><tr><td>3<\/td><td>4<\/td><\/tr><\/table>/u);
    // The paragraph MinerU continued on the next page is one paragraph.
    assert.ok(markdown.includes(`${LONG} new tasks, which we show on six benchmarks.`));
    assert.match(markdown, /!\[Figure 1\. The thing\.\]\(images\/page_1_image_2\.png\)/u);
    assert.match(markdown, /!\[Figure 2\. Values over the years\.\]\(images\/page_1_chart_3\.png\)/u);
    // The page footnote is a note; running headers and page numbers are gone.
    assert.match(markdown, /<!-- mktero-note: footnote -->\n> \$\^\{1\}\$ A note about things\./u);
    assert.doesNotMatch(markdown, /Journal of Things/u);
    assert.match(markdown, /## References\n\n\[1\] A\. Author\. A paper\. 2020\./u);
    // The joined paragraph keeps a location on each page.
    const at = markdown.indexOf(LONG);
    const joined = sourceMap.filter(entry => entry.markdownFrom >= at && entry.markdownTo <= at + LONG.length + 60);
    assert.deepEqual([...new Set(joined.flatMap(entry => entry.locations.map(location => location.pageIndex)))], [0, 1]);
});

test('drops what the middle JSON does not carry safely', () => {
    const layout = projectMinerUMiddleJSON(middle([[
        { type: 'text', bbox: [0.1, 0.1, 1.5, 0.2], content: [text('Box out of range keeps its text.')] },
        { type: 'mystery', bbox: box(0, 0, 10, 10), content: [] },
        { type: 'text', content: 'not spans' },
        { type: 'image', bbox: box(100, 300, 900, 400), content: [{ type: 'image_body', content: '' }] },
        { type: 'text', bbox: box(100, 500, 900, 600), content: [text('x'.repeat(10)), { type: 'equation_inline', content: 7 }] },
    ]], []));
    assert.equal(layout.diagnostics.unsizedPages, 1);
    assert.deepEqual(layout.pages[0].pageSize, [1000, 1000]);
    assert.deepEqual(layout.pages[0].blocks.map(block => block.type), ['text', 'text']);
    assert.equal(layout.pages[0].blocks[0].bbox, undefined);
    assert.equal(layout.diagnostics.unknownTypes.mystery, 1);
    assert.ok(layout.diagnostics.droppedFields >= 2);
    assert.equal(projectMinerUMiddleJSON({ schema: 'docvortex.middle', schema_version: '1.0', pages: [] }), null);
    assert.throws(() => projectMinerUMiddleJSON(middle([[{ type: 'text', content: [text('a')] }, { type: 'text', content: [text('b')] }]]), { maxBlocks: 1 }),
        /block limit/u);
});

test('reads middle_json.json from a local MinerU archive into the document pipeline', () => {
    const archive = zipSync({
        'markdown.md': strToU8('# A Study of Things\n\nMinerU Markdown'),
        'middle_json.json': strToU8(JSON.stringify(PAPER)),
        'images/page_1_image_2.png': new Uint8Array([1]),
        'images/page_1_chart_3.png': new Uint8Array([1]),
    });
    const raw = extractMinerULocalResultFromZip(archive);
    assert.equal(validateMinerULayout(raw.layout), true);
    const result = prepareLocalMinerUResult(raw);
    assert.equal(result.documentStructure, 'mineru-ir-v1');
    assert.ok(result.sourceMap.length > 5);
    assert.match(result.markdown, /^# A Study of Things\n\n## 1\. Introduction/u);
    assert.equal(result.layout, undefined);

    // Without readable structure the service's Markdown stays.
    const plain = extractMinerULocalResultFromZip(zipSync({
        'markdown.md': strToU8('# Plain'),
        'middle_json.json': strToU8('{"schema":"docvortex.middle","pdf_info":[]}'),
    }));
    assert.equal(plain.layout, undefined);
    assert.equal(prepareLocalMinerUResult(plain).markdown, '# Plain');
    assert.equal(extractMinerULocalResultFromZip(zipSync({
        'markdown.md': strToU8('# Broken'),
        'middle_json.json': strToU8('{not json'),
    })).layout, undefined);
});

test('a table of contents is text, not the paper outline', () => {
    const layout = projectMinerUMiddleJSON(middle([[
        { type: 'doc_title', level: 1, bbox: box(100, 60, 900, 100), content: [text('A Long Report')] },
        { type: 'index', bbox: box(100, 120, 900, 300), content: [
            { type: 'paragraph_title', level: 2, content: [text('1 Background 3')] },
            { type: 'text', content: [text('2 Methods 7')] },
        ] },
    ]]));
    const ir = buildMinerUDocumentIR({ markdown: '', assets: [], contentList: [], layout });
    assert.deepEqual(ir.blocks.filter(block => block.role === 'heading').map(block => block.level), [1]);
});

const page = blocks => middle([blocks]);
const markdownOf = parsed => prepareMinerUDocument({
    markdown: '', assets: [], assetBasePath: '', contentList: [], layout: projectMinerUMiddleJSON(parsed),
}).markdown;

test('a list that goes on to the next page keeps its entries apart', () => {
    const markdown = markdownOf(middle([
        [{ type: 'list', sub_type: 'ref_text', bbox: box(100, 800, 900, 980), content: [
            { type: 'ref_text', content: [text('[1] A. Author. First paper. 2020.')] },
        ] }],
        [{ type: 'list', sub_type: 'ref_text', continues_prev: true, bbox: box(100, 60, 900, 200), content: [
            { type: 'ref_text', content: [text('[2] B. Author. Second paper. 2021.')] },
        ] }],
    ]));
    assert.match(markdown, /\[1\] A\. Author\. First paper\. 2020\.\n\n\[2\] B\. Author\. Second paper\. 2021\./u);
    const list = markdownOf(middle([
        [{ type: 'list', sub_type: 'text', bbox: box(100, 800, 900, 980), content: [{ type: 'text', content: [text('• first point')] }] }],
        [{ type: 'list', sub_type: 'text', continues_prev: true, bbox: box(100, 60, 900, 200), content: [{ type: 'text', content: [text('• second point')] }] }],
    ]));
    assert.match(list, /- first point\n- second point/u);
});

test('a continuation never moves text across a heading or an equation', () => {
    const markdown = markdownOf(page([
        { type: 'text', bbox: box(100, 100, 900, 150), content: [text('We define')] },
        { type: 'equation', bbox: box(300, 160, 700, 190), content: 'a=b' },
        { type: 'text', continues_prev: true, bbox: box(100, 200, 900, 250), content: [text('where a is a thing.')] },
        { type: 'paragraph_title', level: 2, bbox: box(100, 300, 400, 320), content: [text('2. Methods')] },
        { type: 'text', continues_prev: true, bbox: box(100, 330, 900, 380), content: [text('Methods follow here.')] },
    ]));
    assert.ok(markdown.indexOf('We define') < markdown.indexOf('a=b'));
    assert.ok(markdown.indexOf('a=b') < markdown.indexOf('where a is a thing.'));
    assert.ok(markdown.indexOf('## 2. Methods') < markdown.indexOf('Methods follow here.'));
});

test('text split by style reads as printed, and nothing with text is dropped', () => {
    const markdown = markdownOf(page([
        { type: 'text', bbox: box(100, 100, 900, 150), content: [
            text('An inter'), text('national', ['bold']), text(' study of '), { type: 'code_inline', content: 'f' }, text('() by '),
            { type: 'hyperlink', url: 'https://example.org', content: [text('Smith')] }, text("'s group, 10"), text('−3', ['superscript']),
            text(' and the 4'), text('th', ['superscript']), text(' run.'), { type: 'mystery_inline', content: ' Kept text.' },
        ] },
        { type: 'list', bbox: box(100, 200, 900, 300), content: [
            { type: 'text', content: [text('1. item with')] },
            { type: 'equation', content: 'x+y' },
        ] },
        { type: 'sidebar_box', bbox: box(100, 400, 900, 450), content: [text('An unknown block keeps its text.')] },
    ]));
    assert.match(markdown, /An international study of f\(\) by \[Smith\]\(https:\/\/example\.org\)'s group, 10 \$\^\{−3\}\$ and the 4th run\. Kept text\./u);
    assert.match(markdown, /\$\$\nx\+y\n\$\$/u);
    assert.match(markdown, /An unknown block keeps its text\./u);
});

test('limits an inherited hyperlink box to its linked text group', () => {
    const layout = projectMinerUMiddleJSON(middle([[
        { type: 'text', bbox: box(100, 100, 900, 150), content: [
            { type: 'hyperlink', url: 'https://example.org', bbox: box(100, 100, 450, 150),
                content: [
                    { ...text('shown'), bbox: box(100, 100, 250, 150) },
                    { ...text(' here'), bbox: box(250, 100, 450, 150) },
                ] },
            text(' and ordinary text'),
        ] },
    ]]));
    const ir = buildMinerUDocumentIR({ layout, assets: [] });
    const spans = ir.blocks[0].fragments[0].lines[0].spans;

    assert.equal(spans.length, 2);
    assert.deepEqual(spans[0].bbox, [100, 100, 450, 150]);
    assert.equal(spans[0].linkURL, 'https://example.org');
    assert.equal(spans[1].bbox, undefined);
    assert.equal(spans[1].linkURL, undefined);
});

test('keeps known span geometry when adjacent Middle JSON text omits a bbox', () => {
    const layout = projectMinerUMiddleJSON(middle([[
        { type: 'text', bbox: box(100, 100, 900, 150), content: [
            { ...text('known'), bbox: box(100, 100, 350, 150) },
            text(' unavailable'),
        ] },
    ]]));
    const spans = layout.pages[0].blocks[0].lines[0].spans;

    assert.equal(spans.length, 1);
    assert.deepEqual(spans[0].bbox, [60, 80, 210, 120]);
});
test('keeps unsafe MinerU hyperlink targets as ordinary text', () => {
    const markdown = markdownOf(page([
        { type: 'text', bbox: box(100, 100, 900, 150), content: [
            { type: 'hyperlink', url: 'javascript:alert(1)', content: [text('unsafe')] },
            text(' and '),
            { type: 'hyperlink', url: 'https://example.org/safe_target', content: [text('safe')] },
        ] },
    ]));
    assert.equal(markdown, 'unsafe and [safe](https://example.org/safe_target)');
});
test('keeps spaces between adjacent MinerU hyperlinks', () => {
    const markdown = markdownOf(page([
        { type: 'text', bbox: box(100, 100, 900, 150), content: [
            { type: 'hyperlink', url: 'https://example.org/a', content: [text('GitHub')] },
            text(' '),
            { type: 'hyperlink', url: 'https://example.org/b', content: [text('Project')] },
        ] },
    ]));
    assert.equal(markdown, '[GitHub](https://example.org/a) [Project](https://example.org/b)');
});
test('a table MinerU marks as continued joins the previous one below a heading line', () => {
    const markdown = markdownOf(middle([
        [{ type: 'table', bbox: box(100, 500, 900, 900), content: [
            { type: 'table_body', bbox: box(100, 500, 900, 900), content: '<table><tr><td>a</td><td>b</td></tr></table>' },
        ] }],
        [
            { type: 'text', bbox: box(100, 40, 900, 60), content: [text('Table 1 (continued)')] },
            { type: 'table', continues_prev: true, bbox: box(100, 300, 900, 500), content: [
                { type: 'table_body', bbox: box(100, 300, 900, 500), content: '<table><tr><td>c</td><td>d</td></tr></table>' },
            ] },
        ],
    ]));
    assert.match(markdown, /<td>a<\/td><td>b<\/td><\/tr><tr><td>c<\/td><td>d<\/td>/u);
});

test('a structure the pipeline cannot read falls back to the service Markdown', () => {
    const layout = projectMinerUMiddleJSON(page([{ type: 'text', bbox: box(100, 100, 900, 150), content: [text('x')] }]));
    layout.pages[0].blocks.push({ type: 'text', get lines() { throw new Error('broken'); } });
    const result = prepareLocalMinerUResult({ markdown: '# Service', assets: [], assetBasePath: '', layout });
    assert.equal(result.markdown, '# Service');
});

test('code, algorithms, and image-only equations keep their content', () => {
    const markdown = markdownOf(page([
        { type: 'code', sub_type: 'code', guess_lang: 'python', bbox: box(100, 100, 900, 200), content: [
            { type: 'code_body', bbox: box(100, 100, 900, 200), content: 'print(1)\nprint(2)' },
            { type: 'code_caption', content: [text('Listing 1. Two prints.')] },
        ] },
        { type: 'code', sub_type: 'algorithm', bbox: box(100, 300, 900, 400), content: [
            { type: 'algorithm_body', bbox: box(100, 300, 900, 400), content: [text('for '), { type: 'equation_inline', content: 'i' }, text(' in range\nreturn')] },
        ] },
        { type: 'equation', bbox: box(300, 500, 700, 540), content: '', image_path: 'images/eq.png' },
    ]));
    assert.match(markdown, /```python\nprint\(1\)\nprint\(2\)\n```/u);
    assert.match(markdown, /for \$i\$ in range\nreturn/u);
    assert.match(markdown, /Listing 1\. Two prints\./u);
});

test('chart data MinerU read follows the chart in a collapsed section', async () => {
    const { markdown } = prepared();
    assert.match(markdown, /!\[Figure 2\. Values over the years\.\]\(images\/page_1_chart_3\.png\)\n\n<!-- mktero-section: chart-data -->\n\n<table><tr><td>year<\/td><td>value<\/td><\/tr><\/table>\n\n<!-- \/mktero-section -->/u);
    const verbatim = prepareMinerUDocument({ markdown: '', assets: ASSETS, assetBasePath: '', contentList: [], layout: projectMinerUMiddleJSON(page([
        { type: 'chart', bbox: box(100, 100, 900, 500), content: [
            { type: 'chart_body', bbox: box(100, 100, 900, 480), content: 'year, value\n2020, 3\n```', image_path: 'images/page_1_chart_3.png' },
        ] },
        { type: 'chart', bbox: box(100, 600, 900, 900), content: [
            { type: 'chart_body', bbox: box(100, 600, 900, 880), content: '<script>x</script>', image_path: 'images/page_1_image_2.png' },
        ] },
    ])) }).markdown;
    assert.match(verbatim, /<!-- mktero-section: chart-data -->\n\n````text\nyear, value\n2020, 3\n```\n````\n\n<!-- \/mktero-section -->/u);
    // Data that is not a table is code, never markup. Parse the document:
    // a tag regexp misses case and attributes.
    assert.match(verbatim, /```text\n<script>x<\/script>\n```/u);
    const { renderMarkdownHTML } = await import('../src/markdown/markdown-html.js');
    const { parseHTML } = await import('linkedom');
    const { document } = parseHTML(`<html><body>${renderMarkdownHTML(verbatim)}</body></html>`);
    assert.equal(document.querySelector('script'), null);
    const renderedCode = [...document.querySelectorAll('code')].map(node => node.textContent).join('\n');
    assert.equal(renderedCode.includes('<script>x</script>'), true);
});

test('a raised mark becomes math only with literal TeX characters', () => {
    const spans = content => projectMinerUMiddleJSON(page([
        { type: 'text', bbox: box(100, 100, 900, 150), content },
    ])).pages[0].blocks[0].lines[0].spans;
    assert.deepEqual(spans([text('Value'), text('a#', ['superscript']), text(' here.')]).map(span => span.content),
        ['Value', '^{a\\#}', ' here.']);
    // A backslash is never written into math: the raised text stays text.
    assert.deepEqual(spans([text('Value'), text('a\\b', ['superscript'])]).map(span => span.type), ['text']);
});
