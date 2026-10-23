import test from 'node:test';
import assert from 'node:assert/strict';
import { assignHeadingLevels } from '../src/mineru/document/headings.js';
import {
    followsHeadingNumber,
    numberedHeadingDepth,
    outlineNumberingScheme,
    parseHeadingNumber,
} from '../src/markdown/heading-numbering.js';
import { extractMarkdownOutline } from '../src/markdown/markdown-outline.js';
import { DOCUMENT_IR_SCHEMA } from '../src/mineru/document/ir.js';

let counter = 0;

function heading(content, { pageIndex = 0, bbox = [100, 100, 900, 130], mineruLevel = 2, kind = 'title', role } = {}) {
    return {
        id: `h${counter++}`, kind, mineruType: kind, role: role || (kind === 'title' ? 'heading' : 'body'),
        pageIndex, bbox, mineruLevel,
        fragments: [{ pageIndex, bbox, lines: [{ bbox, spans: [{ type: 'text', content }] }] }],
        children: [], mergedFrom: [], absorbed: [],
    };
}

function levels(blocks) {
    const ir = assignHeadingLevels({
        schema: DOCUMENT_IR_SCHEMA, pages: [{ pageIndex: 0 }], blocks,
        diagnostics: { reorderedBands: [], chromeFallbacks: [], joins: [] },
    });
    return ir.blocks.filter(block => block.role === 'heading').map(block => block.level);
}

test('nests IEEE Roman sections and lettered subsections under the paper title', () => {
    assert.deepEqual(levels([
        heading('EvoBrain: Continual Learning', { mineruLevel: 1, bbox: [56, 56, 554, 109] }),
        heading('I. INTRODUCTION'),
        heading('II. RELATED WORK'),
        heading('A. EEG Foundation Models'),
        heading('B. Continual Learning'),
        heading('REFERENCES'),
    ]), [1, 2, 2, 3, 3, 2]);
});

test('nests decimal numbering by depth', () => {
    assert.deepEqual(levels([
        heading('Paper', { mineruLevel: 1 }),
        heading('1 Introduction'),
        heading('3.2 Methods'),
        heading('3.2.1 Point-in-time Actions'),
        heading('Appendix'),
    ]), [1, 2, 3, 4, 2]);
});

test('keeps unnumbered sections at one level and picks the tallest first-page title', () => {
    const blocks = [
        heading('Article', { mineruLevel: 1, bbox: [62, 32, 148, 51] }),
        heading('An ECG biomarker discovered with deep learning', { mineruLevel: 1, bbox: [61, 57, 919, 130] }),
        heading('Main'),
        heading('Methods'),
        heading('Late level-one title', { mineruLevel: 1, pageIndex: 5 }),
    ];
    assert.deepEqual(levels(blocks), [2, 1, 2, 2, 2]);
    assert.equal(blocks[1].documentTitle, true);
});

test('demotes captions and sentences that MinerU marked as titles', () => {
    const blocks = [
        heading('Paper', { mineruLevel: 1 }),
        heading('Fig. 3. Retained performance on each task.'),
        heading('This is a long sentence that MinerU mistook for a heading because it was set in bold type and was still short enough to fit'),
    ];
    assert.deepEqual(levels(blocks), [1]);
    assert.equal(blocks[1].role, 'body');
    assert.equal(blocks[2].demotedHeading, true);
});

test('promotes only capitalized lines that continue the section numbering', () => {
    const blocks = [
        heading('Paper', { mineruLevel: 1 }),
        heading('VII. CONCLUSION'),
        heading('VIII. BIOGRAPHY SECTION', { kind: 'text', role: 'reference' }),
        heading('IX. Not capitalized line', { kind: 'text' }),
        heading('X. SKIPS A NUMBER', { kind: 'text' }),
    ];
    assert.deepEqual(levels(blocks), [1, 2, 2]);
    assert.equal(blocks[2].promotedHeading, true);
    assert.equal(blocks[3].role, 'body');
    assert.equal(blocks[4].role, 'body');
});

test('parses and sequences heading numbers', () => {
    assert.deepEqual(parseHeadingNumber('VIII. BIOGRAPHY'), { kind: 'roman', parts: [8] });
    assert.deepEqual(parseHeadingNumber('A.2 Setup'), { kind: 'letter', parts: [1, 2] });
    assert.deepEqual(parseHeadingNumber('3.1.4 Detail'), { kind: 'arabic', parts: [3, 1, 4] });
    assert.equal(parseHeadingNumber('Introduction'), null);
    assert.equal(followsHeadingNumber(parseHeadingNumber('2.3 A'), parseHeadingNumber('2.4 B')), true);
    assert.equal(followsHeadingNumber(parseHeadingNumber('2 A'), parseHeadingNumber('2.1 B')), true);
    assert.equal(followsHeadingNumber(parseHeadingNumber('2.3 A'), parseHeadingNumber('2.5 B')), false);
    assert.equal(outlineNumberingScheme(['I. Intro', 'A. Sub']), 'ieee');
    assert.equal(numberedHeadingDepth('A. Sub', 'ieee'), 2);
    assert.equal(numberedHeadingDepth('A. Appendix', 'standard'), 1);
});

test('trusts structural ATX levels when asked', () => {
    const markdown = '# Paper\n\n## I. INTRODUCTION\n\nText.\n\n### A. Background\n\nText.\n\n## REFERENCES\n\n[1] A.';
    const inferred = extractMarkdownOutline(markdown);
    const structural = extractMarkdownOutline(markdown, [], '', { headingLevels: 'structural' });
    assert.deepEqual(structural.map(entry => entry.level), [1, 2, 3, 2]);
    assert.notDeepEqual(inferred.map(entry => entry.level), structural.map(entry => entry.level));
});
