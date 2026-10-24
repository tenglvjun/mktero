import test from 'node:test';
import assert from 'node:assert/strict';
import { projectMinerULayout } from '../src/mineru/document/result-bundle.js';
import { buildMinerUDocumentIR, prepareMinerUDocument } from '../src/mineru/document/prepare.js';
import { findMarkdownDirectives } from '../src/markdown/markdown-directives.js';

const PAGE = [1000, 1000];

function line(bbox, ...spans) {
    return { bbox, spans: spans.map(span => typeof span === 'string' ? { bbox, type: 'text', content: span } : { bbox, ...span }) };
}

function text(bbox, content, type = 'text') {
    return { type, bbox, lines: [line(bbox, ...[].concat(content))] };
}

function title(bbox, content, level = 2) {
    return { ...text(bbox, content, 'title'), level };
}

function photo(bbox, name, footnote) {
    return {
        type: 'image',
        bbox,
        blocks: [
            { type: 'image_body', bbox, lines: [line(bbox, { type: 'image', image_path: name })] },
            ...(footnote ? [{ type: 'image_footnote', bbox, lines: [line(bbox, footnote)] }] : []),
        ],
    };
}

function page(pageIndex, blocks, discarded = []) {
    return { page_idx: pageIndex, page_size: PAGE, para_blocks: blocks, discarded_blocks: discarded };
}

function prepare(pages, names = []) {
    const assets = names.map(name => ({ path: `images/${name}`, mimeType: 'image/jpeg', data: new Uint8Array([1]) }));
    const bundle = {
        markdown: '', assets, assetBasePath: '', contentList: [],
        layout: projectMinerULayout({ _backend: 'hybrid', pdf_info: pages }),
        extractedPages: pages.length, totalPages: pages.length,
    };
    const ir = buildMinerUDocumentIR(bundle);
    return { ir, ...prepareMinerUDocument(bundle, { ir }) };
}

const sup = content => ({ type: 'inline_equation', content });
const ABSTRACT = 'Abstract—We study how a representation of the signal generalizes across tasks without retraining, '
    + 'and we show that the model keeps what it learned while it adapts to the new task in a few steps. '
    + 'Experiments on six benchmarks confirm the method improves accuracy and reduces forgetting compared with strong baselines.';

test('gathers first-page metadata into an article information section below the author line', () => {
    const { markdown, ir } = prepare([page(0, [
        title([100, 60, 900, 120], 'A Study of Things', 1),
        text([200, 130, 800, 150], ['Ann Author', sup('^{1}'), ', Bob Builder', sup('^{2}')]),
        text([200, 155, 800, 170], [sup('^{1}'), 'Department of Physics, University of Somewhere, City']),
        text([200, 172, 800, 187], [sup('^{2}'), 'Institute of Things, Elsewhere']),
        text([200, 190, 800, 205], 'Correspondence: ann@example.org'),
        text([100, 220, 900, 500], ABSTRACT),
        title([100, 520, 900, 540], '1. Introduction'),
        text([100, 550, 900, 800], ['The body starts here', sup('^{3}'), ' and reads on.']),
    ], [
        { ...text([100, 900, 900, 930], 'This work was supported by the National Science Foundation.'), type: 'page_footnote' },
        { ...text([100, 860, 900, 890], [sup('^{3}'), 'A real footnote of the text.']), type: 'page_footnote' },
        { ...text([100, 830, 900, 855], [sup('^{2}'), 'Work done while at Elsewhere.']), type: 'page_footnote' },
    ])]);
    const head = markdown.split('\n\n');
    assert.deepEqual(head.slice(0, 8), [
        '# A Study of Things',
        'Ann Author $^{1}$, Bob Builder $^{2}$',
        '<!-- mktero-section: article-info -->',
        '$^{1}$ Department of Physics, University of Somewhere, City',
        '$^{2}$ Institute of Things, Elsewhere',
        'Correspondence: ann@example.org',
        '$^{2}$ Work done while at Elsewhere.',
        'This work was supported by the National Science Foundation.',
    ]);
    assert.equal(head[8], '<!-- /mktero-section -->');
    assert.equal(head[9], ABSTRACT);
    const { sections } = findMarkdownDirectives(markdown);
    assert.deepEqual(sections.map(section => section.kind), ['article-info']);
    assert.equal(ir.diagnostics.sections[0].anchor, ir.blocks.find(block => block.id === 'p0-5').id);
    // A marked note of the text is still a footnote, after its paragraph.
    assert.match(markdown, /reads on\.\n\n<!-- mktero-note: footnote -->\n> \$\^\{3\}\$ A real footnote of the text\./u);
});

test('keeps a keyword list MinerU discarded under its label', () => {
    const { markdown } = prepare([page(0, [
        title([100, 60, 900, 120], 'A Study of Things', 1),
        text([100, 220, 900, 500], ABSTRACT),
        title([100, 520, 300, 540], 'KEYWORDS'),
        title([100, 700, 900, 720], '1 Introduction'),
    ], [{ ...text([100, 545, 900, 560], 'signal, representation, transfer'), type: 'page_footnote' }])]);
    assert.match(markdown, /## KEYWORDS\n\nsignal, representation, transfer\n\n## 1 Introduction/u);
    assert.doesNotMatch(markdown, /mktero-section/u);
});

test('leaves a first page without metadata alone', () => {
    const { markdown } = prepare([page(0, [
        title([100, 60, 900, 120], 'A Study of Things', 1),
        text([200, 130, 800, 150], 'Ann Author, Bob Builder'),
        text([100, 220, 900, 500], ABSTRACT),
    ])]);
    assert.doesNotMatch(markdown, /mktero-section/u);
});

const BIO_A = 'Ann Author received the Ph.D. degree from the University of Somewhere in 2017.';
const BIO_B = 'She is currently a research professor with the College of Computer Science.';
const BIO_C = 'Bob Builder received the B.S. degree in Electronics from Elsewhere University in 2022.';
const BIO_D = 'Cy Coder received the M.S. degree from the Institute of Things in 2010.';

test('puts author biographies and their photos in a section after the references', () => {
    const { markdown } = prepare([
        page(0, [title([100, 60, 900, 120], 'A Study of Things', 1), text([100, 220, 900, 500], ABSTRACT)]),
        page(1, [
            title([100, 50, 400, 70], 'References'),
            text([60, 80, 480, 110], '[1] A. Author, “A title,” Journal, 2020.', 'ref_text'),
            photo([520, 80, 620, 180], 'a.jpg'),
            text([60, 115, 480, 145], '[2] B. Builder, “Another title,” Journal, 2021.', 'ref_text'),
            text([60, 150, 480, 180], '[3] C. Coder, “A third title,” Journal, 2022.', 'ref_text'),
            title([150, 600, 400, 620], 'VIII. BIOGRAPHY SECTION'),
            text([640, 80, 920, 110], BIO_A),
            text([640, 110, 920, 180], BIO_B),
            photo([90, 700, 190, 800], 'b.jpg', BIO_C),
            photo([520, 700, 620, 800], 'c.jpg'),
            text([640, 700, 920, 760], BIO_D),
        ]),
    ], ['a.jpg', 'b.jpg', 'c.jpg']);
    const tail = markdown.slice(markdown.indexOf('## VIII. BIOGRAPHY SECTION')).split('\n\n');
    assert.deepEqual(tail, [
        '## VIII. BIOGRAPHY SECTION',
        '<!-- mktero-section: author-biographies -->',
        '![](images/a.jpg)',
        BIO_A,
        BIO_B,
        '![](images/b.jpg)',
        BIO_C,
        '![](images/c.jpg)',
        BIO_D,
        '<!-- /mktero-section -->',
    ]);
});

test('does not treat a single biography-like sentence as a section', () => {
    const { markdown } = prepare([page(0, [
        title([100, 60, 900, 120], 'A Study of Things', 1),
        title([100, 130, 900, 150], 'References'),
        text([100, 160, 900, 180], '[1] A. Author, “A title,” Journal, 2020.', 'ref_text'),
        text([100, 200, 900, 230], BIO_A),
    ])]);
    assert.doesNotMatch(markdown, /author-biographies/u);
});

test('puts the reporting summary checklist, not the Methods note of that name, in its section', () => {
    const { markdown } = prepare([
        page(0, [
            title([100, 60, 900, 120], 'A Study of Things', 1),
            title([100, 300, 900, 320], 'Reporting summary'),
            text([100, 330, 900, 360], 'Further information on research design is available in the Reporting Summary linked to this article.'),
            title([100, 400, 900, 420], 'Data availability'),
            text([100, 430, 900, 460], 'Data are available from the authors.'),
        ]),
        page(1, [
            title([30, 40, 400, 90], 'nature portfolio'),
            text([500, 95, 730, 110], 'Last updated by author(s): Mar 4, 2025'),
            title([30, 150, 330, 180], 'Reporting Summary'),
            text([30, 190, 900, 220], 'Nature Portfolio wishes to improve the reproducibility of the work that we publish.'),
            title([30, 280, 130, 295], 'Statistics'),
            text([30, 300, 900, 330], 'For all statistical analyses, confirm that the following items are present.'),
        ]),
    ]);
    const { sections } = findMarkdownDirectives(markdown);
    assert.deepEqual(sections.map(section => section.kind), ['reporting-summary']);
    const inside = markdown.slice(sections[0].content.from, sections[0].content.to).trim();
    assert.match(inside, /^## nature portfolio[\s\S]*## Reporting Summary[\s\S]*## Statistics[\s\S]*present\.$/u);
    assert.match(markdown.slice(0, sections[0].from), /## Reporting summary\n\nFurther information[\s\S]*Data are available/u);
    assert.ok(markdown.trimEnd().endsWith('<!-- /mktero-section -->'));
});

test('source map entries of a section stay exact and skip the directives', () => {
    const { markdown, sourceMap } = prepare([page(0, [
        title([100, 60, 900, 120], 'A Study of Things', 1),
        text([200, 155, 800, 170], [sup('^{1}'), 'Department of Physics, University of Somewhere']),
        text([100, 220, 900, 500], ABSTRACT),
    ])]);
    for (const entry of sourceMap) {
        assert.doesNotMatch(markdown.slice(entry.markdownFrom, entry.markdownTo), /mktero-section/u);
    }
    const affiliation = sourceMap.find(entry => markdown.slice(entry.markdownFrom, entry.markdownTo).includes('Department of Physics'));
    assert.deepEqual(affiliation.locations, [{ pageIndex: 0, bbox: [200, 155, 800, 170] }]);
});

test('a sidebar label takes the line printed below it as its value, but not prose', () => {
    const { markdown } = prepare([page(0, [
        title([100, 60, 900, 120], 'A Study of Things', 1),
        text([200, 130, 800, 150], 'Ann Author'),
        title([40, 200, 90, 215], 'COPYRIGHT'),
        text([40, 218, 90, 400], ABSTRACT),
        title([40, 420, 90, 435], 'CITATION'),
        text([40, 438, 90, 480], 'Author A (2026) A study of things. J. Things 4:12. doi: 10.1000/things.4'),
        title([100, 520, 900, 540], '1. Introduction'),
    ])]);
    const head = markdown.split('\n\n');
    const open = head.indexOf('<!-- mktero-section: article-info -->');
    const close = head.indexOf('<!-- /mktero-section -->');
    const section = head.slice(open + 1, close);
    assert.ok(section.includes('Author A (2026) A study of things. J. Things 4:12. doi: 10.1000/things.4'));
    assert.ok(!section.includes(ABSTRACT));
    assert.ok(head.slice(close).includes(ABSTRACT));
});

test('reads a long run of address-like text in linear time', () => {
    const started = performance.now();
    const { markdown } = prepare([page(0, [
        title([100, 60, 900, 120], 'A Study of Things', 1),
        text([200, 130, 800, 150], `+@-.${'--+@-.'.repeat(2000)}!`),
    ])]);
    assert.ok(performance.now() - started < 2000);
    assert.match(markdown, /^# A Study of Things/u);
});
