import test from 'node:test';
import assert from 'node:assert/strict';
import { attachPDFGeometry, indentsParagraphs } from '../src/mineru/document/pdf-geometry.js';
import { stitchParagraphs } from '../src/mineru/document/stitch.js';
import { levelHeadingsByStyle } from '../src/mineru/document/headings.js';
import { projectMinerULayout } from '../src/mineru/document/result-bundle.js';
import { prepareMinerUDocument } from '../src/mineru/document/prepare.js';
import { DOCUMENT_IR_SCHEMA, fragmentText } from '../src/mineru/document/ir.js';

// A PDF.js text item on a 1000 x 1000 page, placed by its top edge.
function item(text, x, top, width, size = 10, fontName = 'F1') {
    return { text, width, height: size, fontName, direction: 'ltr', transform: [size, 0, 0, size, x, 1000 - top - size] };
}

function pdfPage(pageIndex, items, { width = 1000, height = 1000 } = {}) {
    return { pageIndex, viewport: { transform: [1, 0, 0, -1, 0, height], width, height }, items };
}

let counter = 0;
function block(pageIndex, bbox, content, { role = 'body', kind = role === 'heading' ? 'title' : 'text', pdf } = {}) {
    const fragment = { pageIndex, bbox, lines: [{ bbox, spans: [{ type: 'text', content }] }], ...(pdf ? { pdf } : {}) };
    return { id: `g${counter++}`, kind, mineruType: kind, role, pageIndex, bbox, fragments: [fragment], children: [], mergedFrom: [], absorbed: [] };
}

function ir(blocks, pageCount = 3) {
    return {
        schema: DOCUMENT_IR_SCHEMA,
        pages: Array.from({ length: pageCount }, (_, pageIndex) => ({ pageIndex, width: 1000, height: 1000, geometry: 'block' })),
        blocks,
        diagnostics: { joins: [] },
    };
}

test('measures the lines of a fragment from the PDF text layer', () => {
    const paragraph = block(1, [100, 100, 500, 150], 'A paragraph of three lines.');
    const doc = ir([paragraph]);
    attachPDFGeometry(doc, { pages: [pdfPage(1, [
        item('An indented first line', 120, 102, 380),
        item('a full second line of text', 100, 115, 300),
        item('continued', 400, 115, 100),
        item('a short last line.', 100, 128, 150),
        item('Outside the block', 600, 102, 200),
    ])] });
    assert.deepEqual(paragraph.fragments[0].pdf, { lines: 3, lastFill: 0.38, firstIndent: 2, fontSize: 10, font: 'F1' });
    assert.equal(doc.pages[1].geometry, 'line');
    assert.equal(doc.pages[0].geometry, 'block');
    assert.deepEqual(doc.diagnostics.pdfGeometry, { pages: 1, mismatched: 0, fragments: 1, measured: 1 });
});

test('ignores a page of another shape, broken items, and a missing index', () => {
    const paragraph = block(0, [100, 100, 500, 150], 'Text.');
    const doc = ir([paragraph], 1);
    attachPDFGeometry(doc, { pages: [pdfPage(0, [item('Text.', 100, 102, 300)], { width: 1000, height: 1400 })] });
    assert.equal(paragraph.fragments[0].pdf, undefined);
    assert.equal(doc.diagnostics.pdfGeometry.mismatched, 1);
    attachPDFGeometry(doc, { pages: [pdfPage(0, [
        { text: 'bad', width: 10, transform: [NaN, 0, 0, 10, 0, 0], fontName: 'F1' },
        { text: '', width: 10, transform: [10, 0, 0, 10, 100, 890], fontName: 'F1' },
        { text: 'x', width: -1, transform: [10, 0, 0, 10, 100, 890], fontName: 'F1' },
    ])] });
    assert.equal(paragraph.fragments[0].pdf, undefined);
    attachPDFGeometry(doc, null);
    assert.deepEqual(doc.diagnostics.pdfGeometry, { pages: 0, mismatched: 0, fragments: 0, measured: 0 });
    assert.doesNotThrow(() => attachPDFGeometry(doc, { pages: 'nope' }));
});

const INDENTED = { lines: 4, lastFill: 0.5, firstIndent: 2, fontSize: 10, font: 'F1' };
function indentedParagraphs(pageIndex) {
    return Array.from({ length: 5 }, (_, index) => block(pageIndex, [100, 100 + index * 60, 480, 150 + index * 60],
        `Paragraph ${index} of the body text ends here with a period.`, { pdf: INDENTED }));
}
const texts = doc => doc.blocks.map(item => item.fragments.map(fragment => fragmentText(fragment)).join(' | '));

test('knows whether a document indents its paragraphs', () => {
    assert.equal(indentsParagraphs(indentedParagraphs(1)), true);
    assert.equal(indentsParagraphs(indentedParagraphs(1).slice(0, 4)), false);
    assert.equal(indentsParagraphs(indentedParagraphs(1).map(item => {
        item.fragments[0].pdf = { ...INDENTED, firstIndent: 0 };
        return item;
    })), false);
});

test('joins a paragraph a page breaks at the end of a sentence when the PDF shows it runs on', () => {
    const head = block(1, [100, 900, 480, 980], 'The first part of the paragraph closes a sentence here.',
        { pdf: { lines: 3, lastFill: 0.97, firstIndent: 2, fontSize: 10, font: 'F1' } });
    const tail = block(2, [100, 60, 480, 120], 'Then the paragraph carries on in a new sentence below.',
        { pdf: { lines: 3, lastFill: 0.5, firstIndent: 0, fontSize: 10, font: 'F1' } });
    const doc = stitchParagraphs(ir([...indentedParagraphs(1), head, tail]));
    assert.equal(doc.blocks.length, 6);
    assert.equal(texts(doc).at(-1), 'The first part of the paragraph closes a sentence here. | Then the paragraph carries on in a new sentence below.');
    assert.deepEqual(doc.diagnostics.joins.at(-1), { into: head.id, from: tail.id, boundary: 'page', pageIndex: 1, geometry: true });
});

test('keeps paragraphs apart when the PDF shows an indented start, a short line, or no indentation habit', () => {
    const make = (headPDF, tailPDF, paragraphs = indentedParagraphs(1)) => stitchParagraphs(ir([
        ...paragraphs,
        block(1, [100, 900, 480, 980], 'The first part of the paragraph closes a sentence here.', { pdf: headPDF }),
        block(2, [100, 60, 480, 120], 'Then the paragraph carries on in a new sentence below.', { pdf: tailPDF }),
    ])).blocks.length;
    const full = { lines: 3, lastFill: 0.97, firstIndent: 2, fontSize: 10, font: 'F1' };
    assert.equal(make(full, { ...full, firstIndent: 2 }), 7);
    assert.equal(make({ ...full, lastFill: 0.8 }, { ...full, firstIndent: 0 }), 7);
    assert.equal(make(full, { ...full, firstIndent: 0 }, indentedParagraphs(1).map(item => {
        item.fragments[0].pdf = { ...INDENTED, firstIndent: 0 };
        return item;
    })), 7);
    // The first page carries the article's metadata and is left alone.
    const first = stitchParagraphs(ir([
        ...indentedParagraphs(0),
        block(0, [100, 900, 480, 980], 'The first part of the paragraph closes a sentence here.', { pdf: full }),
        block(1, [100, 60, 480, 120], 'Then the paragraph carries on in a new sentence below.', { pdf: { ...full, firstIndent: 0 } }),
    ]));
    assert.equal(first.blocks.length, 7);
});

test('a short last line ends a paragraph the text alone would join', () => {
    const make = lastFill => stitchParagraphs(ir([
        block(1, [100, 900, 480, 980], 'The proposed model learns representations of the signal that',
            { pdf: { lines: 3, lastFill, firstIndent: 2, fontSize: 10, font: 'F1' } }),
        block(2, [100, 60, 480, 120], 'generalize across tasks without retraining the whole model.'),
    ])).blocks.length;
    assert.equal(make(0.98), 1);
    assert.equal(make(0.4), 2);
});

function heading(content, fontSize, font) {
    return block(1, [100, 100, 480, 115], content, { role: 'heading', pdf: { lines: 1, lastFill: 1, firstIndent: 0, fontSize, font } });
}

test('levels unnumbered headings by their type', () => {
    const blocks = [
        heading('Introduction', 14, 'Bold'),
        heading('Methods', 14, 'Bold'),
        heading('Participants', 11, 'Bold'),
        heading('Measures', 11, 'Bold'),
        heading('User ratings', 11, 'Italic'),
        heading('Retention', 11, 'Italic'),
        heading('Results', 14, 'Bold'),
        heading('References', 10, 'Regular'),
    ];
    const doc = levelHeadingsByStyle(ir(blocks));
    assert.deepEqual(blocks.map(item => item.level), [2, 2, 3, 3, 4, 4, 2, 2]);
    assert.equal(doc.diagnostics.headingStyles, true);
});

test('keeps headings flat when their type does not nest or the paper is numbered', () => {
    const nesting = [heading('Results', 11, 'Bold'), heading('Methods', 14, 'Bold'), heading('Data', 11, 'Bold'), heading('Discussion', 14, 'Bold')];
    for (const item of nesting) item.level = 2;
    levelHeadingsByStyle(ir(nesting));
    assert.deepEqual(nesting.map(item => item.level), [2, 2, 2, 2]);
    const numbered = [heading('1. Introduction', 14, 'Bold'), heading('Background', 11, 'Bold'), heading('Scope', 11, 'Bold'), heading('2. Methods', 14, 'Bold')];
    for (const item of numbered) item.level = 2;
    levelHeadingsByStyle(ir(numbered));
    assert.deepEqual(numbered.map(item => item.level), [2, 2, 2, 2]);
    const unmeasured = [block(1, [0, 0, 10, 10], 'A', { role: 'heading' }), block(1, [0, 0, 10, 10], 'B', { role: 'heading' }), block(1, [0, 0, 10, 10], 'C', { role: 'heading' })];
    for (const item of unmeasured) item.level = 2;
    levelHeadingsByStyle(ir(unmeasured));
    assert.deepEqual(unmeasured.map(item => item.level), [2, 2, 2]);
});

test('a MinerU document reads its outline levels from the PDF text layer', () => {
    const line = (bbox, content) => ({ bbox, spans: [{ bbox, type: 'text', content }] });
    const title = (bbox, content, level) => ({ type: 'title', bbox, ...(level ? { level } : {}), lines: [line(bbox, content)] });
    const text = (bbox, content) => ({ type: 'text', bbox, lines: [line(bbox, content)] });
    const layout = projectMinerULayout({ _backend: 'hybrid', pdf_info: [{ page_idx: 0, page_size: [1000, 1000], para_blocks: [
        title([100, 50, 900, 80], 'A Study of Things', 1),
        title([100, 100, 400, 120], 'Methods'),
        title([100, 130, 400, 145], 'Participants'),
        text([100, 150, 900, 200], 'We recruited people.'),
        title([100, 210, 400, 225], 'Measures'),
        text([100, 230, 900, 280], 'We measured things.'),
        title([100, 300, 400, 320], 'Results'),
        text([100, 330, 900, 380], 'Things happened.'),
    ], discarded_blocks: [] }] });
    const pdfText = { pages: [pdfPage(0, [
        item('A Study of Things', 100, 52, 600, 24, 'Title'),
        item('Methods', 100, 102, 120, 14, 'Bold'),
        item('Participants', 100, 131, 120, 11, 'Bold'),
        item('We recruited people.', 100, 152, 300, 10, 'Body'),
        item('Measures', 100, 211, 120, 11, 'Bold'),
        item('We measured things.', 100, 232, 300, 10, 'Body'),
        item('Results', 100, 302, 120, 14, 'Bold'),
        item('Things happened.', 100, 332, 300, 10, 'Body'),
    ])] };
    const bundle = { markdown: '', assets: [], assetBasePath: '', contentList: [], layout };
    assert.match(prepareMinerUDocument(bundle, { pdfText }).markdown, /^# A Study of Things\n\n## Methods\n\n### Participants\n\nWe recruited people\.\n\n### Measures\n\nWe measured things\.\n\n## Results/u);
    assert.match(prepareMinerUDocument(bundle).markdown, /## Methods\n\n## Participants/u);
});
