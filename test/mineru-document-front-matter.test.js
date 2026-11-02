import test from 'node:test';
import assert from 'node:assert/strict';
import { projectMinerULayout } from '../src/mineru/document/result-bundle.js';
import { buildMinerUDocumentIR, createMinerUFigureInput, prepareMinerUDocument } from '../src/mineru/document/prepare.js';
import { findMarkdownDirectives } from '../src/markdown/markdown-directives.js';
import { extractMarkdownOutline } from '../src/markdown/markdown-outline.js';

const TITLE = 'Individually guided training prescription by heart rate variability and self-reported measure of stress tolerance in recreational runners: Effects on endurance performance';
const ABSTRACT = 'We compared three training programmes and measured endurance performance before and after the intervention.';
const BODY = 'The participants completed all experimental procedures and the measurements were analysed using the predefined protocol.';
const CITATION = `To cite this article: Ann Author and Bob Builder (2023) ${TITLE}, Journal of Examples.`;

function text(content, bbox, type = 'text', level) {
    return { type, level, bbox, lines: [{ bbox, spans: [{ type: 'text', content, bbox }] }] };
}

function image(name, bbox, caption = '') {
    return { type: 'image', bbox, blocks: [
        { type: 'image_body', bbox, lines: [{ bbox, spans: [{ type: 'image', image_path: name, bbox }] }] },
        ...(caption ? [{ ...text(caption, bbox, 'image_caption') }] : []),
    ] };
}

function page(pageIndex, blocks, discarded = []) {
    return { page_idx: pageIndex, page_size: [1000, 1000], para_blocks: blocks, discarded_blocks: discarded };
}

function fixture() {
    return [
        page(0, [
            text(TITLE, [100, 180, 900, 280], 'title', 1),
            text('Ann Author & Bob Builder', [100, 300, 800, 330]),
            text(CITATION, [100, 340, 900, 390]),
            text('To link to this article: https://doi.org/10.1000/example', [100, 400, 900, 425]),
            image('date.jpg', [100, 440, 130, 465]),
            text('Published online: 20 Mar 2023.', [140, 440, 600, 465]),
            image('submit.jpg', [105, 490, 135, 515]),
            text('Submit your article to this journal ↗', [100, 490, 600, 515]),
            image('views.jpg', [105, 540, 135, 565]),
            text('Article views: 1057', [100, 540, 600, 565]),
            image('related.jpg', [100, 590, 130, 615]),
            text('View related articles ↗', [140, 590, 600, 615]),
        ]),
        page(1, [
            text('RESEARCH ARTICLE', [100, 60, 300, 80]),
            text('Check for updates', [800, 60, 950, 80]),
            text(TITLE, [100, 100, 900, 180], 'title', 1),
            { type: 'text', bbox: [100, 190, 900, 220], lines: [{ spans: [
                { type: 'text', content: 'Ann Author' }, { type: 'inline_equation', content: '^{a}' },
                { type: 'text', content: 'and Bob Builder' }, { type: 'inline_equation', content: '^{b}' },
            ] }] },
            { type: 'text', bbox: [100, 230, 900, 255], lines: [{ spans: [
                { type: 'inline_equation', content: '^{a}' }, { type: 'text', content: 'Department of Training, University of Somewhere' },
            ] }] },
            text('ABSTRACT', [100, 300, 400, 320], 'title', 2),
            text(ABSTRACT, [100, 330, 900, 390]),
            text('ARTICLE HISTORY Received 10 September 2022 Accepted 9 March 2023', [100, 400, 900, 430]),
            text('KEYWORDS training; performance', [100, 440, 900, 465]),
            text('Introduction', [100, 500, 400, 525], 'title', 2),
            text(BODY, [100, 540, 900, 610]),
            image('study.jpg', [100, 650, 700, 850], 'Figure 1. Experimental study design.'),
        ]),
    ];
}

function bundle(pages) {
    return {
        layout: projectMinerULayout({ pdf_info: pages }), markdown: '',
        assets: ['date.jpg', 'submit.jpg', 'views.jpg', 'related.jpg', 'study.jpg', 'small.jpg']
            .map(name => ({ path: `images/${name}`, mimeType: 'image/jpeg', data: new Uint8Array([1]) })),
    };
}

function prepare(pages) {
    const raw = bundle(pages);
    const ir = buildMinerUDocumentIR(raw);
    return { ir, raw, ...prepareMinerUDocument(raw, { ir }) };
}

test('reads the article after a confirmed publisher cover with one long title and no publisher controls', () => {
    const { markdown, sourceMap, ir, raw } = prepare(fixture());
    assert.equal(ir.articleStartPage, 1);
    assert.ok(markdown.startsWith(`# ${TITLE}\n\nAnn Author`), markdown);
    assert.equal(markdown.split('\n').filter(line => line === `# ${TITLE}`).length, 1);
    assert.doesNotMatch(markdown, /Submit your article|Article views:|View related articles/u);
    assert.doesNotMatch(markdown, /images\/(?:date|submit|views|related)\.jpg/u);
    const { sections } = findMarkdownDirectives(markdown);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].kind, 'article-info');
    const info = markdown.slice(sections[0].content.from, sections[0].content.to);
    for (const value of [CITATION, 'https://doi.org/10.1000/example', 'Published online:',
        'Department of Training', 'Check for updates', 'RESEARCH ARTICLE', 'ARTICLE HISTORY']) {
        assert.ok(info.includes(value), value);
    }
    const outside = markdown.slice(0, sections[0].from) + markdown.slice(sections[0].to);
    assert.ok(outside.includes(ABSTRACT));
    assert.ok(outside.includes(BODY));
    assert.ok(outside.includes('KEYWORDS training; performance'));
    assert.ok(outside.includes('study.jpg'));
    const outline = extractMarkdownOutline(markdown, [], '', { headingLevels: 'structural' });
    assert.equal(outline[0].text, TITLE);
    assert.equal(outline[0].level, 1);
    const titleMap = sourceMap.find(entry => markdown.slice(entry.markdownFrom, entry.markdownTo) === `# ${TITLE}`);
    assert.deepEqual(titleMap.locations, [{ pageIndex: 1, bbox: [100, 100, 900, 180] }]);
    const citationMap = sourceMap.find(entry => markdown.slice(entry.markdownFrom, entry.markdownTo) === CITATION);
    assert.equal(citationMap.locations[0].pageIndex, 0);
    for (const entry of sourceMap) {
        assert.ok(entry.markdownFrom >= 0 && entry.markdownTo <= markdown.length);
        assert.doesNotMatch(markdown.slice(entry.markdownFrom, entry.markdownTo), /mktero-section/u);
    }
    const figureInput = createMinerUFigureInput(raw);
    assert.ok(figureInput.blocks.some(block => block.assetPath === 'images/study.jpg'));
    assert.ok(!figureInput.blocks.some(block => /(?:date|submit|views|related)\.jpg/u.test(block.assetPath || '')));
});

test('recognizes a cover whose repeated article title begins with Introduction', () => {
    const pages = fixture();
    const title = `Introduction to ${TITLE}`;
    pages[0].para_blocks[0].lines[0].spans[0].content = title;
    pages[1].para_blocks[2].lines[0].spans[0].content = title;
    const { markdown, ir } = prepare(pages);
    assert.equal(ir.articleStartPage, 1);
    assert.ok(markdown.startsWith(`# ${title}`));
    assert.doesNotMatch(markdown, /Submit your article|Article views:/u);
});

test('applies the same cover and long-title rules to a content-list-only result', () => {
    const raw = bundle(fixture());
    delete raw.layout;
    raw.contentList = fixture().flatMap(page => page.para_blocks.map(block => {
        const spans = block.lines?.flatMap(line => line.spans) || [];
        const value = spans.map(span => span.type === 'inline_equation' ? `$${span.content}$` : span.content).join(' ');
        return block.type === 'image' ? {
            type: 'image', pageIndex: page.page_idx, bbox: block.bbox,
            assetPath: `images/${block.blocks[0].lines[0].spans[0].image_path}`,
            captions: block.blocks.filter(child => child.type === 'image_caption')
                .map(child => child.lines[0].spans[0].content),
        } : { type: 'text', pageIndex: page.page_idx, bbox: block.bbox, text: value, textLevel: block.level };
    }));
    const { markdown, sourceMap } = prepareMinerUDocument(raw);
    assert.ok(markdown.startsWith(`# ${TITLE}`));
    assert.doesNotMatch(markdown, /Submit your article|Article views:|View related articles|images\/(?:submit|views|related|date)\.jpg/u);
    assert.ok(markdown.includes('images/study.jpg'));
    assert.ok(sourceMap.some(entry => entry.locations.some(location => location.pageIndex === 1)));
});

test('does not hide an image with its own scientific footnote beside a publisher control', () => {
    const pages = fixture();
    pages[0].para_blocks[6].blocks.push(text('Values are means with confidence intervals.', [105, 490, 135, 515], 'image_footnote'));
    const { markdown } = prepare(pages);
    assert.ok(markdown.includes('submit.jpg'));
    assert.ok(markdown.includes('Values are means'));
});

test('preserves an unassociated small image and a captioned image beside a publisher control', () => {
    const pages = fixture();
    pages[0].para_blocks.push(image('small.jpg', [750, 600, 780, 630]));
    pages[0].para_blocks[6] = image('submit.jpg', [100, 490, 130, 515], 'Figure 2. A small experimental symbol.');
    const { markdown } = prepare(pages);
    assert.ok(markdown.includes('small.jpg'));
    assert.ok(markdown.includes('submit.jpg'));
});

for (const condition of ['different-title', 'no-citation', 'one-control', 'article-on-first-page', 'research-prose']) {
    test(`keeps a possible cover when evidence is insufficient: ${condition}`, () => {
        const pages = fixture();
        if (condition === 'different-title') pages[1].para_blocks[2].lines[0].spans[0].content = 'A different research article';
        if (condition === 'no-citation') pages[0].para_blocks = pages[0].para_blocks.filter(block => !block.lines?.[0]?.spans[0]?.content.startsWith('To '));
        if (condition === 'one-control') pages[0].para_blocks = pages[0].para_blocks.filter(block => !/Article views|View related/u.test(block.lines?.[0]?.spans[0]?.content || ''));
        if (condition === 'article-on-first-page') pages[0].para_blocks.push(text('Abstract', [100, 800, 600, 830], 'title', 2));
        if (condition === 'research-prose') pages[0].para_blocks.push(text(`${BODY} ${BODY} ${BODY}`, [100, 700, 900, 850]));
        const { markdown, ir } = prepare(pages);
        assert.equal(ir.articleStartPage, undefined);
        assert.ok(markdown.includes('Submit your article to this journal'));
        assert.ok(markdown.includes('submit.jpg'));
    });
}

test('keeps publisher words quoted in article prose and small scientific images', () => {
    const pages = fixture();
    pages[1].para_blocks.push(
        text('The website displayed Article views: 1057 and View related articles during the experiment.', [100, 870, 900, 895]),
        image('small.jpg', [800, 800, 820, 820], 'Figure 2. A small stimulus.'),
    );
    const { markdown } = prepare(pages);
    assert.ok(markdown.includes('The website displayed Article views: 1057 and View related articles during the experiment.'));
    assert.ok(markdown.includes('small.jpg'));
});

test('groups marked author notes on the logical article page without renumbering their PDF locations', () => {
    const pages = fixture();
    pages[1].discarded_blocks.push({
        type: 'page_footnote', bbox: [100, 920, 900, 945], lines: [{ spans: [
            { type: 'inline_equation', content: '^{a}' },
            { type: 'text', content: 'Institute of Exercise, University of Elsewhere' },
        ] }],
    });
    const { markdown, sourceMap } = prepare(pages);
    const { sections } = findMarkdownDirectives(markdown);
    const info = markdown.slice(sections[0].content.from, sections[0].content.to);
    assert.ok(info.includes('Institute of Exercise'));
    const entry = sourceMap.find(item => markdown.slice(item.markdownFrom, item.markdownTo).includes('Institute of Exercise'));
    assert.equal(entry.locations[0].pageIndex, 1);
});
