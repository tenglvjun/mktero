import test from 'node:test';
import assert from 'node:assert/strict';
import { restorePDFFigureCaptions } from '../src/mineru/document/figure-captions.js';
import { DOCUMENT_IR_SCHEMA, fragmentText } from '../src/mineru/document/ir.js';

const WIDTH = 595;
const HEIGHT = 841;

function caption(id, bbox, text, pageIndex = 0) {
    return {
        id, kind: 'caption', pageIndex, bbox,
        fragments: [{ pageIndex, bbox, lines: [{ bbox, spans: [{ type: 'text', content: text }] }] }],
    };
}

function float(kind, id, bbox, captions = [], pageIndex = 0) {
    return {
        id, kind, mineruType: kind, role: 'float', pageIndex, bbox,
        fragments: [{ pageIndex, bbox, lines: [] }],
        children: [
            { id: `${id}:body0`, kind: 'body', pageIndex, bbox, assetPath: `images/${id}.jpg` },
            ...captions,
        ],
        absorbed: [],
    };
}

function body(id, bbox, text, pageIndex = 0) {
    return {
        id, kind: 'text', mineruType: 'text', role: 'body', pageIndex, bbox,
        fragments: [{ pageIndex, bbox, lines: [{ bbox, spans: [{ type: 'text', content: text }] }] }],
        children: [],
    };
}

function document(blocks) {
    return {
        schema: DOCUMENT_IR_SCHEMA,
        pages: [{ pageIndex: 0, width: WIDTH, height: HEIGHT }],
        blocks,
        diagnostics: {},
    };
}

// One PDF text line, located in the 0-1000 page units the IR uses. `top` is
// the line's distance from the top of the page, `width` its printed width.
function line(text, { top, left = 96, width = 380, size = 7 } = {}) {
    return { text, width: width * WIDTH / 1000, height: size,
        transform: [size, 0, 0, size, left * WIDTH / 1000, HEIGHT - top * HEIGHT / 1000],
        fontName: 'F1' };
}

function pdf(items) {
    return { pages: [{ pageIndex: 0,
        viewport: { width: WIDTH, height: HEIGHT, transform: [1, 0, 0, -1, 0, HEIGHT] },
        items }] };
}

function captions(block) {
    return (block.children || []).filter(child => child.kind === 'caption')
        .map(child => child.fragments.map(fragment => fragmentText(fragment)).join(' '));
}

// A flowchart figure whose number MinerU dropped. The caption is left-aligned
// with the page frame, under a picture that does not reach that margin.
function flowchart({ number = true, ocrCopy = false } = {}) {
    const chart = float('image', 'chart', [233, 547, 764, 873]);
    const blocks = [chart];
    if (ocrCopy) blocks.push(body('copy', [96, 882, 270, 891], 'Flowchart of the study selection.'));
    return { chart, blocks };
}

const FLOWCHART_PDF = () => pdf([
    line('FIGURE 1', { top: 883, left: 96, width: 40, size: 5.5 }),
    line('Flowchart of the study selection.', { top: 891, left: 96, width: 174 }),
]);

test('restores a figure number the OCR layout lost', () => {
    const { chart, blocks } = flowchart();
    const ir = document(blocks);
    restorePDFFigureCaptions(ir, FLOWCHART_PDF());
    assert.deepEqual(captions(chart), ['FIGURE 1 Flowchart of the study selection.']);
    assert.equal(ir.diagnostics.pdfCaptions.restored, 1);
});

test('joins a caption whose number and description are separate PDF lines', () => {
    const table = float('table', 'table', [240, 102, 508, 231]);
    const ir = document([table]);
    restorePDFFigureCaptions(ir, pdf([
        line('FIGURE 4', { top: 245, left: 96, width: 40, size: 5.5 }),
        line('Sensitivity test in adults.', { top: 254, left: 96, width: 126 }),
    ]));
    assert.deepEqual(captions(table), ['FIGURE 4 Sensitivity test in adults.']);
});

test('moves one misassigned figure caption off another float', () => {
    const chart = float('chart', 'chart', [211, 100, 787, 374]);
    const table = float('table', 'table', [213, 477, 783, 881], [
        caption('table:wrong', [97, 379, 145, 389], 'FIGURE 2'),
    ]);
    const ir = document([
        chart,
        table,
        body('description', [97, 389, 289, 400], 'Risk of bias of the included studies.'),
    ]);
    restorePDFFigureCaptions(ir, pdf([
        line('FIGURE 2', { top: 379, left: 96, width: 40, size: 5.5 }),
        line('Risk of bias of the included studies.', { top: 389, left: 96, width: 188 }),
    ]));
    assert.deepEqual(captions(chart), ['FIGURE 2 Risk of bias of the included studies.']);
    assert.deepEqual(captions(table), []);
    const released = ir.releasedCaptions.find(record => record.id === 'table:wrong');
    assert.equal(released.from, 'table');
    assert.equal(released.into, 'chart');
    assert.equal(released.originalCaption.fragments[0].lines[0].spans[0].content, 'FIGURE 2');
    assert.equal(ir.diagnostics.pdfCaptions.restored, 1);
    const copy = ir.blocks.find(block => block.id === 'description');
    assert.equal(copy.captionConsumed, true);
    assert.equal(copy.role, 'caption');
});

test('keeps a caption beside a centred picture that it does not overlap horizontally', () => {
    const { chart, blocks } = flowchart();
    const ir = document(blocks);
    restorePDFFigureCaptions(ir, FLOWCHART_PDF());
    // The caption starts at the page frame, left of the centred picture.
    assert.equal(chart.bbox[0], 233);
    assert.ok(chart.children[1].bbox[0] < chart.bbox[0]);
});

test('marks a table and the plot beside it as one captioned picture', () => {
    const table = float('table', 'table', [240, 102, 508, 231]);
    const chart = float('chart', 'chart', [576, 98, 762, 240]);
    const ir = document([table, chart]);
    restorePDFFigureCaptions(ir, pdf([
        line('FIGURE 4', { top: 245, left: 96, width: 40, size: 5.5 }),
        line('Sensitivity test in adults.', { top: 254, left: 96, width: 126 }),
    ]));
    assert.deepEqual(captions(table), ['FIGURE 4 Sensitivity test in adults.']);
    assert.deepEqual(captions(chart), []);
    assert.equal(table.pdfFigure.group, true);
    assert.equal(chart.pdfFigure.group, true);
    assert.equal(ir.diagnostics.pdfCaptions.groups, 1);
});

test('does not touch a real table caption', () => {
    const table = float('table', 'table', [240, 102, 508, 231], [
        caption('table:own', [96, 245, 300, 265], 'Table 2 | Baseline results.'),
    ]);
    const ir = document([table]);
    restorePDFFigureCaptions(ir, pdf([
        line('Table 2 | Baseline results.', { top: 245, left: 96, width: 170 }),
    ]));
    assert.deepEqual(captions(table), ['Table 2 | Baseline results.']);
    assert.equal(ir.diagnostics.pdfCaptions.restored, 0);
});

test('leaves a prose figure reference alone', () => {
    const chart = float('image', 'chart', [233, 547, 764, 873]);
    const ir = document([
        body('prose', [45, 74, 292, 161], 'The graph in Figure 6 shows low asymmetry in the funnel plot.'),
        chart,
    ]);
    restorePDFFigureCaptions(ir, pdf([
        line('The graph in Figure 6 shows low asymmetry', { top: 100, left: 96, width: 250 }),
        line('in the funnel plot.', { top: 110, left: 96, width: 90 }),
    ]));
    assert.deepEqual(captions(chart), []);
    assert.equal(ir.diagnostics.pdfCaptions.restored, 0);
});

test('does not attach a caption across intervening body text', () => {
    const chart = float('image', 'chart', [233, 100, 764, 300]);
    const ir = document([
        chart,
        body('prose', [45, 400, 292, 470], 'A paragraph that ends before the caption is printed.'),
    ]);
    restorePDFFigureCaptions(ir, FLOWCHART_PDF());
    assert.deepEqual(captions(chart), []);
});

test('leaves a caption equally close to two pictures unattached', () => {
    // The two-line caption is printed between two pictures, about as far from
    // the one above as from the one below, so neither one is the better read.
    const upper = float('image', 'upper', [233, 100, 764, 320]);
    const lower = float('image', 'lower', [233, 363, 764, 593]);
    const ir = document([upper, lower]);
    restorePDFFigureCaptions(ir, pdf([
        line('FIGURE 1', { top: 340, left: 96, width: 40, size: 5.5 }),
        line('Flowchart of the study selection.', { top: 349, left: 96, width: 174 }),
    ]));
    assert.deepEqual([...captions(upper), ...captions(lower)], []);
});

test('releases the OCR copy of a native caption once', () => {
    const { chart, blocks } = flowchart({ ocrCopy: true });
    const ir = document(blocks);
    restorePDFFigureCaptions(ir, FLOWCHART_PDF());
    const copy = ir.blocks.find(block => block.id === 'copy');
    assert.equal(copy.captionConsumed, true);
    assert.equal(copy.captionConsumedFor, 'chart');
    assert.equal(ir.diagnostics.pdfCaptions.released, 1);
});

test('keeps an identical sentence in the other column at the same height', () => {
    const { chart, blocks } = flowchart();
    const other = body('other-column', [560, 882, 880, 891], 'Flowchart of the study selection.');
    const ir = document([...blocks, other]);
    restorePDFFigureCaptions(ir, FLOWCHART_PDF());
    assert.deepEqual(captions(chart), ['FIGURE 1 Flowchart of the study selection.']);
    assert.equal(other.captionConsumed, undefined);
    assert.equal(other.role, 'body');
});

test('is idempotent', () => {
    const { blocks } = flowchart();
    const ir = document(blocks);
    const input = FLOWCHART_PDF();
    restorePDFFigureCaptions(ir, input);
    const before = JSON.stringify(ir.blocks);
    restorePDFFigureCaptions(ir, input);
    assert.equal(JSON.stringify(ir.blocks), before);
});

test('ignores pages whose shape does not match the PDF', () => {
    const { chart, blocks } = flowchart();
    const ir = document(blocks);
    ir.pages[0].width = 400;
    ir.pages[0].height = 400;
    restorePDFFigureCaptions(ir, FLOWCHART_PDF());
    assert.deepEqual(captions(chart), []);
});

test('bounds long and hostile captions', () => {
    const { chart, blocks } = flowchart();
    const ir = document(blocks);
    restorePDFFigureCaptions(ir, pdf([
        line('FIGURE 1', { top: 883, left: 96, width: 40, size: 5.5 }),
        line(`${'long '.repeat(80)}caption`, { top: 891, left: 96, width: 500 }),
    ]));
    assert.deepEqual(captions(chart), []);
});

// A whole caption printed on one line: the number and the description are
// never split, and the caption is attached without reading the next line.
test('attaches a complete one-line caption', () => {
    const chart = float('image', 'chart', [233, 547, 764, 873]);
    const ir = document([chart]);
    restorePDFFigureCaptions(ir, pdf([
        line('Figure 4. Sensitivity test in adults.', { top: 883, left: 96, width: 174, size: 7 }),
        line('The next paragraph of running text starts here.', { top: 897, left: 96, width: 260, size: 9 }),
    ]));
    assert.deepEqual(captions(chart), ['Figure 4. Sensitivity test in adults.']);
    assert.equal(ir.diagnostics.pdfCaptions.restored, 1);
});

// A caption printed over three lines keeps all three, not just the first.
test('keeps every line of a three-line caption', () => {
    const chart = float('image', 'chart', [233, 547, 764, 860]);
    const ir = document([chart]);
    restorePDFFigureCaptions(ir, pdf([
        line('FIGURE 2', { top: 872, left: 96, width: 40, size: 5.5 }),
        line('Risk of bias of the included studies, judged with the', { top: 881, left: 96, width: 250, size: 7 }),
        line('Cochrane tool and shown as a traffic-light plot for', { top: 891, left: 96, width: 245, size: 7 }),
        line('every included study and every domain.', { top: 901, left: 96, width: 160, size: 7 }),
    ]));
    assert.deepEqual(captions(chart), ['FIGURE 2 Risk of bias of the included studies, judged with the'
        + ' Cochrane tool and shown as a traffic-light plot for'
        + ' every included study and every domain.']);
});

// A figure citation in the body is prose, not a legend, even when it opens
// with the number and runs over several printed lines.
test('rejects a multi-line prose reference to a figure', () => {
    const chart = float('image', 'chart', [233, 547, 764, 873]);
    const ir = document([chart]);
    restorePDFFigureCaptions(ir, pdf([
        line('Figure 6 shows the funnel plot of the included studies,', { top: 883, left: 96, width: 280, size: 9 }),
        line('whose asymmetry is low.', { top: 893, left: 96, width: 120, size: 9 }),
    ]));
    assert.deepEqual(captions(chart), []);
    assert.equal(ir.diagnostics.pdfCaptions.restored, 0);
});

// A real table heading stays a table heading: it is never a figure caption,
// and the table keeps the caption it printed.
test('leaves a numbered table heading as the table caption', () => {
    const table = float('table', 'table', [240, 102, 508, 231], [
        caption('table:own', [96, 245, 300, 265], 'Table 4. Sensitivity test in adults.'),
    ]);
    const ir = document([table]);
    restorePDFFigureCaptions(ir, pdf([
        line('Table 4. Sensitivity test in adults.', { top: 245, left: 96, width: 170, size: 7 }),
    ]));
    assert.deepEqual(captions(table), ['Table 4. Sensitivity test in adults.']);
    assert.equal(table.pdfFigure, undefined);
    assert.equal(ir.diagnostics.pdfCaptions.restored, 0);
    assert.equal(ir.diagnostics.pdfCaptions.completed, 0);
});

// A caption that names no single owner is not evidence for any picture: the
// bare OCR label MinerU filed under a picture stays where it was written, and
// the picture keeps the caption it had.
test('keeps a misfiled bare label when the caption has no single owner', () => {
    const upper = float('image', 'upper', [233, 100, 764, 320], [
        caption('upper:own', [97, 340, 145, 350], 'FIGURE 1'),
    ]);
    const lower = float('image', 'lower', [233, 363, 764, 593]);
    const ir = document([upper, lower]);
    restorePDFFigureCaptions(ir, pdf([
        line('FIGURE 1', { top: 340, left: 96, width: 40, size: 5.5 }),
        line('Flowchart of the study selection.', { top: 349, left: 96, width: 174, size: 7 }),
    ]));
    assert.deepEqual(captions(upper), ['FIGURE 1']);
    assert.deepEqual(captions(lower), []);
    assert.equal(ir.diagnostics.pdfCaptions.reassigned, 0);
    assert.equal(ir.diagnostics.pdfCaptions.completed, 0);
});

// Two pictures printed side by side, each with its own legend, are two
// figures. One caption never marks both, and neither picture absorbs the
// other's legend.
test('keeps side-by-side pictures with their own captions apart', () => {
    const left = float('chart', 'left', [96, 100, 460, 300], [
        caption('left:own', [96, 305, 300, 320], 'FIGURE 1 Risk of bias of the included studies.'),
    ]);
    const right = float('chart', 'right', [520, 100, 900, 300], [
        caption('right:own', [520, 305, 720, 320], 'FIGURE 2 Sensitivity test in adults.'),
    ]);
    const ir = document([left, right]);
    restorePDFFigureCaptions(ir, pdf([
        line('FIGURE 1 Risk of bias of the included studies.', { top: 305, left: 96, width: 204, size: 7 }),
        line('FIGURE 2 Sensitivity test in adults.', { top: 305, left: 520, width: 200, size: 7 }),
    ]));
    assert.deepEqual(captions(left), ['FIGURE 1 Risk of bias of the included studies.']);
    assert.deepEqual(captions(right), ['FIGURE 2 Sensitivity test in adults.']);
    assert.equal(left.pdfFigure, undefined);
    assert.equal(right.pdfFigure, undefined);
});

// Two pictures side by side with no OCR caption at all: only the legend of
// one of them is printed, so that one is restored and the other is left
// alone rather than being marked with the same figure.
test('does not mark an uncaptioned neighbour with another picture caption', () => {
    const left = float('chart', 'left', [96, 100, 460, 300]);
    const right = float('chart', 'right', [520, 100, 900, 300]);
    const ir = document([left, right]);
    restorePDFFigureCaptions(ir, pdf([
        line('FIGURE 1 Risk of bias of the included studies.', { top: 305, left: 96, width: 204, size: 7 }),
        line('FIGURE 2 Sensitivity test in adults.', { top: 305, left: 520, width: 200, size: 7 }),
    ]));
    assert.deepEqual(captions(left), ['FIGURE 1 Risk of bias of the included studies.']);
    assert.deepEqual(captions(right), ['FIGURE 2 Sensitivity test in adults.']);
    assert.equal(left.pdfFigure.label, 'FIGURE 1');
    assert.equal(right.pdfFigure.label, 'FIGURE 2');
    assert.equal(left.pdfFigure.group, undefined);
    assert.equal(right.pdfFigure.group, undefined);
});

// A caption printed under a body paragraph that shares its margin and size is
// not extended by that paragraph, and the body line is not consumed.
test('does not swallow the body line printed after a caption', () => {
    const chart = float('image', 'chart', [233, 100, 764, 300]);
    const paragraph = body('prose', [96, 310, 480, 420],
        'Running text of the article that continues under the legend for two more lines and then ends here.');
    const ir = document([chart, paragraph]);
    restorePDFFigureCaptions(ir, pdf([
        line('FIGURE 1', { top: 305, left: 96, width: 40, size: 5.5 }),
        line('Flowchart of the study selection.', { top: 314, left: 96, width: 174, size: 7 }),
        line('Running text of the article that continues under the', { top: 330, left: 96, width: 380, size: 9 }),
        line('legend for two more lines and then ends here.', { top: 340, left: 96, width: 300, size: 9 }),
    ]));
    assert.deepEqual(captions(chart), ['FIGURE 1 Flowchart of the study selection.']);
    assert.equal(paragraph.captionConsumed, undefined);
    assert.equal(paragraph.role, 'body');
});

// A page whose matching would cost more than the pipeline allows is skipped
// whole, not partially repaired: the same page repeated many times is bounded
// by the page budget, and nothing is changed.
test('skips a page whose matching exceeds the comparison budget', () => {
    const floats = [];
    const captions = [];
    for (let index = 0; index < 60; index++) {
        const top = 60 + index * 12;
        floats.push(float('image', `f${index}`, [233, top, 764, top + 8]));
        captions.push(line(`FIGURE ${index + 1}`, { top, left: 96, width: 40, size: 5.5 }));
        captions.push(line('Flowchart of the study selection.', { top: top + 9, left: 96, width: 174, size: 7 }));
    }
    const ir = document(floats);
    const before = JSON.stringify(ir.blocks);
    restorePDFFigureCaptions(ir, pdf(captions));
    assert.equal(JSON.stringify(ir.blocks), before);
    assert.equal(ir.diagnostics.pdfCaptions.skipped, 1);
    assert.equal(ir.diagnostics.pdfCaptions.restored, 0);
});

// The budget counts the page's own size, so a page with a few captions and a
// few pictures is never skipped.
test('repairs an ordinary page within the comparison budget', () => {
    const { chart, blocks } = flowchart({ ocrCopy: true });
    const ir = document(blocks);
    restorePDFFigureCaptions(ir, FLOWCHART_PDF());
    assert.equal(ir.diagnostics.pdfCaptions.skipped, 0);
    assert.deepEqual(captions(chart), ['FIGURE 1 Flowchart of the study selection.']);
});

// The OCR copy of a caption that lost its number is completed from the PDF:
// the caption the figure pipeline reads is the printed one, even when native
// image recovery never runs.
test('completes an OCR caption that lost its number', () => {
    const chart = float('image', 'chart', [233, 547, 764, 873], [
        caption('chart:partial', [96, 891, 270, 900], 'Flowchart of the study selection.'),
    ]);
    const ir = document([chart]);
    restorePDFFigureCaptions(ir, FLOWCHART_PDF());
    assert.deepEqual(captions(chart), ['FIGURE 1 Flowchart of the study selection.']);
    const child = chart.children.find(item => item.kind === 'caption');
    assert.equal(child.id, 'chart:partial');
    assert.equal(child.pdfNativeCaption, true);
    assert.equal(child.nativeText, 'FIGURE 1 Flowchart of the study selection.');
    // The OCR reading stays as evidence.
    assert.equal(child.ocrFragments.length, 1);
    assert.equal(ir.diagnostics.pdfCaptions.completed, 1);
    assert.equal(chart.pdfFigure.text, 'FIGURE 1 Flowchart of the study selection.');
});

// Two neighbouring legends that share most of their words are not one caption:
// the printed number is part of the match. A picture that already prints
// Figure 1 keeps it, and the Figure 2 legend printed beside it never replaces
// that picture's caption.
test('never merges two captions that share their wording', () => {
    const chart = float('chart', 'chart', [233, 100, 764, 300], [
        caption('chart:own', [96, 305, 300, 318], 'FIGURE 1 Risk of bias of the included studies.'),
    ]);
    const ir = document([chart]);
    restorePDFFigureCaptions(ir, pdf([
        line('FIGURE 2', { top: 305, left: 96, width: 40, size: 5.5 }),
        line('Risk of bias of the included studies.', { top: 314, left: 96, width: 188, size: 7 }),
    ]));
    assert.deepEqual(captions(chart), ['FIGURE 1 Risk of bias of the included studies.']);
    assert.equal(ir.diagnostics.pdfCaptions.completed, 0);
    assert.equal(ir.diagnostics.pdfCaptions.restored, 0);
    assert.equal(chart.pdfFigure, undefined);
});
