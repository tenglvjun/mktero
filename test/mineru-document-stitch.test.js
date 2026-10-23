import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyBlocks } from '../src/mineru/document/classify.js';
import { attachFloatNotes } from '../src/mineru/document/floats.js';
import { assignHeadingLevels } from '../src/mineru/document/headings.js';
import { orderReadingFlow } from '../src/mineru/document/reading-order.js';
import { stitchParagraphs } from '../src/mineru/document/stitch.js';
import { createHyphenationVocabulary, joinTextParts, keepHyphen } from '../src/mineru/document/text.js';
import { DOCUMENT_IR_SCHEMA, fragmentText } from '../src/mineru/document/ir.js';

let counter = 0;

function text(pageIndex, bbox, content, extra = {}) {
    const fragment = { pageIndex, bbox, lines: [{ bbox, spans: [{ type: 'text', content }] }] };
    return {
        id: extra.id || `b${counter++}`,
        kind: extra.kind || 'text',
        mineruType: extra.kind || 'text',
        role: extra.kind === 'title' ? 'heading' : extra.kind === 'reference' ? 'reference' : 'body',
        pageIndex,
        bbox,
        fragments: [fragment],
        children: [],
        mergedFrom: [],
        absorbed: [],
        ...(extra.mineruLevel ? { mineruLevel: extra.mineruLevel } : {}),
    };
}

function float(pageIndex, bbox, kind = 'image') {
    return {
        id: `b${counter++}`, kind, mineruType: kind, role: 'float', pageIndex, bbox,
        fragments: [{ pageIndex, bbox, lines: [] }],
        children: [{ id: 'c', kind: 'body', pageIndex, bbox, assetPath: 'images/a.jpg' }],
        mergedFrom: [], absorbed: [],
    };
}

function equation(pageIndex, bbox) {
    return {
        id: `b${counter++}`, kind: 'equation', mineruType: 'interline_equation', role: 'body', pageIndex, bbox,
        latex: 'x', fragments: [{ pageIndex, bbox, lines: [] }], children: [], mergedFrom: [], absorbed: [],
    };
}

function stitch(blocks, pageCount = 2) {
    const ir = {
        schema: DOCUMENT_IR_SCHEMA,
        pages: Array.from({ length: pageCount }, (_, pageIndex) => ({ pageIndex })),
        blocks,
        diagnostics: { reorderedBands: [], chromeFallbacks: [], joins: [] },
    };
    return stitchParagraphs(assignHeadingLevels(orderReadingFlow(attachFloatNotes(classifyBlocks(ir)))));
}

const texts = ir => ir.blocks.map(block => block.fragments.map(fragment => fragmentText(fragment)).join(' | '));
const LONG = 'The proposed model learns representations of the signal that';

test('joins a sentence split across a page break', () => {
    const ir = stitch([
        text(0, [100, 700, 900, 940], `${LONG} transfer across`),
        text(1, [100, 60, 900, 200], 'heterogeneous tasks without forgetting.'),
    ]);
    assert.deepEqual(texts(ir), [`${LONG} transfer across | heterogeneous tasks without forgetting.`]);
    assert.equal(ir.diagnostics.joins[0].boundary, 'page');
});

test('joins across a column break and accepts a capitalized continuation', () => {
    const ir = stitch([
        text(0, [100, 100, 480, 400], 'Long paragraph text in the left column filling it to the end.'),
        text(0, [100, 410, 480, 900], `${LONG} is the predominant non-invasive`),
        text(0, [520, 100, 900, 400], 'BCI technique, electroencephalography records activity.'),
        text(0, [520, 410, 900, 900], 'Another right column paragraph that stays separate here.'),
    ], 1);
    assert.equal(ir.blocks.length, 3);
    assert.match(texts(ir)[1], /non-invasive \| BCI technique/);
    assert.equal(ir.diagnostics.joins[0].boundary, 'column');
});

test('joins across a float in one column and keeps the float after the paragraph', () => {
    const figure = float(0, [100, 300, 900, 600]);
    const ir = stitch([
        text(0, [100, 100, 900, 280], `${LONG} is shown in`),
        figure,
        text(0, [100, 620, 900, 800], 'the figure below for all subjects.'),
    ], 1);
    assert.equal(ir.blocks.length, 2);
    assert.equal(ir.blocks[1], figure);
    assert.equal(ir.diagnostics.joins[0].boundary, 'float');
});

test('does not join blocks that sit next to each other in one column', () => {
    const ir = stitch([
        text(0, [100, 100, 900, 140], 'ABPM ambulatory blood pressure monitoring and more words here'),
        text(0, [100, 150, 900, 190], 'ambulatory blood pressure monitoring continues as a glossary entry'),
    ], 1);
    assert.equal(ir.blocks.length, 2);
});

test('does not join after a finished sentence or across a heading', () => {
    const finished = stitch([
        text(0, [100, 700, 900, 940], `${LONG} transfer well.`),
        text(1, [100, 60, 900, 200], 'next page starts a new paragraph.'),
    ]);
    assert.equal(finished.blocks.length, 2);
    const heading = stitch([
        text(0, [100, 700, 900, 900], `${LONG} transfer across`),
        text(0, [100, 920, 400, 940], 'Methods', { kind: 'title' }),
        text(1, [100, 60, 900, 200], 'heterogeneous tasks without forgetting.'),
    ]);
    assert.equal(heading.blocks.length, 3);
});

test('does not join list items, captions, labels, or author lists', () => {
    for (const next of ['• a bullet item', 'Fig. 2. A caption.', 'Funding: none was received.']) {
        const ir = stitch([
            text(0, [100, 700, 900, 940], `${LONG} transfer across`),
            text(1, [100, 60, 900, 200], next),
        ]);
        assert.equal(ir.blocks.length, 2, next);
    }
    const authors = stitch([
        text(0, [100, 700, 900, 940], 'Yue Shi, Chi Chiu Wang, Yongkang Yang, Qin Li, Pui Wah Chung'),
        text(1, [100, 60, 900, 200], 'and colleagues from the same institute report results.'),
    ]);
    assert.equal(authors.blocks.length, 2);
});

test('records a sentence continued after display math without joining it', () => {
    const ir = stitch([
        text(0, [100, 100, 900, 200], `${LONG} is computed as`),
        equation(0, [300, 220, 700, 260]),
        text(0, [100, 280, 900, 400], 'where x denotes the input signal of each task.'),
    ], 1);
    assert.equal(ir.blocks.length, 3);
    assert.equal(ir.blocks[2].continuesFrom, ir.blocks[0].id);
});

test('joins numbered reference continuations but not new author-year entries', () => {
    const numbered = stitch([
        text(0, [100, 100, 400, 120], 'References', { kind: 'title' }),
        text(0, [100, 900, 480, 940], '[67] A. Author, “Spiced: A synaptic framework for un-', { kind: 'reference' }),
        text(1, [100, 60, 480, 100], 'supervised continual decoding,” in NeurIPS, 2024.', { kind: 'reference' }),
    ]);
    assert.equal(numbered.blocks.length, 2);
    const authorYear = stitch([
        text(0, [100, 100, 400, 120], 'References', { kind: 'title' }),
        text(0, [100, 900, 480, 940], 'Smith, J. (2020). A title. https://doi.org/10.1/abc'),
        text(1, [100, 60, 480, 100], 'Wan, L., Pei, P. (2021). Another title.'),
    ]);
    assert.equal(authorYear.blocks.length, 3);
});

test('joins past a sidebar that opens the next page', () => {
    const ir = stitch([
        text(0, [320, 455, 944, 896], `${LONG} is feasible and`),
        text(1, [54, 95, 297, 135], 'Data Availability Statement: All data are in the paper.'),
        text(1, [54, 144, 271, 172], 'Funding: The authors received no funding.'),
        text(1, [320, 93, 918, 128], 'had a trend in reducing anxiety.'),
    ]);
    assert.equal(ir.blocks.length, 3);
    assert.match(texts(ir)[0], /feasible and \| had a trend/);
    assert.match(texts(ir)[1], /^Data Availability/);
});

test('promotes a missed numbered heading before stitching', () => {
    const ir = stitch([
        text(0, [100, 100, 480, 120], 'VII. CONCLUSION', { kind: 'title' }),
        text(0, [100, 130, 480, 600], 'The conclusion paragraph is long enough to read as prose text.'),
        text(0, [100, 900, 300, 920], 'VIII. BIOGRAPHY SECTION'),
        text(0, [520, 100, 900, 300], 'Sha Zhao received the Ph.D. degree from the university.'),
    ], 1);
    assert.equal(ir.blocks[2].role, 'heading');
    assert.equal(ir.blocks[2].level, 2);
    assert.equal(ir.blocks.length, 4);
});

test('attaches a note under a table instead of joining it into prose', () => {
    const ir = stitch([
        text(0, [59, 600, 497, 944], `${LONG} lower 95% confidence`),
        float(0, [511, 95, 943, 695], 'table'),
        text(0, [508, 699, 943, 768], 'Numbers are fractions with standard errors unless noted.'),
        text(0, [509, 766, 901, 801], '^{b} Diagnoses come from codes.'),
        text(0, [508, 861, 945, 903], 'bound exceeds the median control group rate.'),
    ], 1);
    assert.equal(ir.blocks[2].role, 'float-note');
    assert.equal(ir.blocks[3].role, 'float-note');
    assert.match(texts(ir)[0], /confidence \| bound exceeds/);
});

test('decides line-final hyphens from the document vocabulary', () => {
    const ir = { blocks: [text(0, [0, 0, 10, 10], 'post-training post-training sleep wake sleep wake architectures')] };
    const vocabulary = createHyphenationVocabulary(ir);
    assert.deepEqual(joinTextParts('static post-', 'training paradigm', vocabulary), {
        text: 'static post-training paradigm', hyphen: 'kept',
    });
    assert.deepEqual(joinTextParts('deep archi-', 'tectures work', vocabulary), {
        text: 'deep architectures work', hyphen: 'removed',
    });
    assert.equal(keepHyphen('sleep', 'wake', vocabulary), true);
    assert.equal(keepHyphen('un', 'supervised', vocabulary), false);
    assert.deepEqual(joinTextParts('B-', 'ACC values', vocabulary), { text: 'B-ACC values', hyphen: 'kept' });
    assert.equal(joinTextParts('中文段落', '继续', vocabulary).text, '中文段落继续');
    assert.equal(joinTextParts('ends with', 'next part', vocabulary).text, 'ends with next part');
    assert.equal(joinTextParts('range 80–', '82 items', vocabulary).text, 'range 80–82 items');
});
