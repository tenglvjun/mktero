import test from 'node:test';
import assert from 'node:assert/strict';
import { attachEquationNumbers } from '../src/mineru/document/equations.js';
import { orderReadingFlow } from '../src/mineru/document/reading-order.js';
import { DOCUMENT_IR_SCHEMA } from '../src/mineru/document/ir.js';

function text(id, bbox, content, pageIndex = 0) {
    return {
        id, kind: 'text', mineruType: 'text', role: 'body', pageIndex, bbox,
        fragments: [{ pageIndex, bbox, lines: [{ bbox, spans: [{ type: 'text', content }] }] }],
        children: [], mergedFrom: [], absorbed: [],
    };
}

function equation(id, bbox, latex, pageIndex = 0) {
    return {
        id, kind: 'equation', mineruType: 'interline_equation', role: 'body', pageIndex, bbox, latex,
        fragments: [{ pageIndex, bbox, lines: [] }], children: [], mergedFrom: [], absorbed: [],
    };
}

function attach(blocks) {
    const ir = orderReadingFlow({
        schema: DOCUMENT_IR_SCHEMA,
        pages: [{ pageIndex: 0 }],
        blocks,
        diagnostics: { reorderedBands: [], chromeFallbacks: [], joins: [], equationNumbers: [] },
    });
    return attachEquationNumbers(ir);
}

test('turns a number beside display math into its tag', () => {
    const ir = attach([
        text('before', [97, 572, 897, 621], 'The acceptance decision is governed by:'),
        equation('eq', [366, 629, 625, 669], 'S_k = S_{k-1}'),
        text('number', [871, 641, 896, 656], '(4)'),
        text('after', [97, 677, 899, 904], 'If accepted, the candidate skills are preserved.'),
    ]);
    assert.deepEqual(ir.blocks.map(block => block.id), ['before', 'eq', 'after']);
    assert.equal(ir.blocks[1].latex, 'S_k = S_{k-1} \\tag{4}');
    assert.deepEqual(ir.blocks[1].absorbed, ['number']);
    assert.deepEqual(ir.diagnostics.equationNumbers, [{ id: 'number', into: 'eq', pageIndex: 0 }]);
});

test('adds a second number to an equation MinerU already tagged', () => {
    const ir = attach([
        equation('eq', [221, 622, 345, 673], '\\begin{array}{c} a \\\\ b \\end{array}\\tag{8}'),
        text('nine', [469, 658, 489, 670], '(9)'),
    ]);
    assert.equal(ir.blocks[0].latex, '\\begin{array}{c} a \\\\ b \\end{array}\\tag{8, 9}');
    assert.deepEqual(ir.blocks.map(block => block.id), ['eq']);
});

test('drops a number that repeats the tag MinerU already wrote', () => {
    const ir = attach([
        equation('eq', [600, 100, 900, 140], 'c \\tag{3}'),
        text('repeat', [905, 110, 930, 130], '(3)'),
    ]);
    assert.equal(ir.blocks[0].latex, 'c \\tag{3}');
    assert.deepEqual(ir.blocks.map(block => block.id), ['eq']);
});

test('keeps a number that is not beside an equation', () => {
    const ir = attach([
        equation('eq', [366, 629, 625, 669], 'x'),
        text('below', [871, 700, 896, 715], '(4)'),
        text('left', [300, 641, 330, 656], '(5)'),
        text('words', [871, 641, 960, 656], '(see 4)'),
    ]);
    assert.deepEqual(ir.blocks.map(block => block.id), ['eq', 'below', 'left', 'words']);
    assert.equal(ir.blocks[0].latex, 'x');
});

test('does not take a number from the other column', () => {
    const ir = attach([
        text('left-top', [100, 100, 480, 300], 'Left column prose that fills a column of the page from top to bottom.'),
        equation('left-eq', [100, 320, 300, 360], 'y'),
        text('left-bottom', [100, 380, 480, 600], 'More left column prose that fills the column below the equation.'),
        text('right-top', [520, 100, 900, 300], 'Right column prose that fills a column of the page from top to bottom.'),
        text('right-number', [860, 330, 890, 350], '(2)'),
        text('right-bottom', [520, 380, 900, 600], 'More right column prose that fills the column below the number.'),
    ]);
    assert.equal(ir.blocks.find(block => block.id === 'left-eq').latex, 'y');
    assert.ok(ir.blocks.some(block => block.id === 'right-number'));
});
