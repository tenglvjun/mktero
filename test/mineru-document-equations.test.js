import test from 'node:test';
import assert from 'node:assert/strict';
import { attachEquationNumbers } from '../src/mineru/document/equations.js';
import { orderReadingFlow } from '../src/mineru/document/reading-order.js';
import { DOCUMENT_IR_SCHEMA } from '../src/mineru/document/ir.js';
import { projectMinerULayout } from '../src/mineru/document/result-bundle.js';
import { buildMinerUDocumentIR, prepareMinerUDocument } from '../src/mineru/document/prepare.js';
import { isValidSourceMapEntry } from '../src/core/markdown-source-map.js';
import { renderMarkdownHTML, portableMathSource } from '../src/markdown/markdown-html.js';
import { portableMathMarkdown, portableMarkdownForRange } from '../src/markdown/portable-markdown.js';
import { parseHTML } from 'linkedom';

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

function attach(blocks, pdfText = null) {
    const ir = orderReadingFlow({
        schema: DOCUMENT_IR_SCHEMA,
        pages: [{ pageIndex: 0, width: 1000, height: 1000 }],
        blocks,
        diagnostics: { reorderedBands: [], chromeFallbacks: [], joins: [], equationNumbers: [] },
    });
    return attachEquationNumbers(ir, pdfText);
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

function pdfItem(content, x, top, width, size = 10) {
    return { text: content, width, height: size, fontName: 'F1', direction: 'ltr',
        transform: [size, 0, 0, size, x, 1000 - top - size] };
}

function nativeText(items) {
    return { pages: [{ pageIndex: 0, viewport: {
        transform: [1, 0, 0, -1, 0, 1000], width: 1000, height: 1000,
    }, items }] };
}

test('attaches a unique equation number immediately below the right edge', () => {
    const ir = attach([
        equation('eq', [80, 300, 440, 350], 'x + y'),
        text('number', [452, 350, 473, 364], '(7)'),
    ]);
    assert.deepEqual(ir.blocks.map(block => block.id), ['eq']);
    assert.equal(ir.blocks[0].latex, 'x + y \\tag{7}');
});

test('does not guess below-right numbers across gaps, prose, pages, or competing equations', () => {
    const cases = [
        [equation('eq', [80, 300, 440, 350], 'x'), text('n', [452, 365, 473, 379], '(7)')],
        [equation('eq', [80, 300, 440, 350], 'x'), text('n', [500, 350, 521, 364], '(7)')],
        [equation('eq', [80, 300, 440, 350], 'x'), text('prose', [80, 352, 440, 356], 'Body text.'),
            text('n', [452, 357, 473, 371], '(7)')],
        [equation('eq', [80, 300, 440, 350], 'x'), text('n', [452, 350, 473, 364], '(7)', 1)],
        [equation('a', [80, 300, 440, 350], 'x'), equation('b', [80, 300, 440, 350], 'y'),
            text('n', [452, 350, 473, 364], '(7)')],
        [equation('eq', [80, 300, 440, 350], 'x'), text('a', [452, 350, 473, 364], '(7)'),
            text('b', [452, 352, 473, 366], '(8)')],
    ];
    for (const blocks of cases) {
        const before = structuredClone(blocks);
        const ir = attach(blocks);
        assert.equal(ir.blocks.length, before.length);
        assert.ok(ir.blocks.filter(block => block.kind === 'equation').every(block => !block.latex.includes('\\tag')));
    }
});

const LTC_BODY = String.raw`\mathbb {E} \left[ l (z ^ {(d)} (t)) \right] \geq O \left(\frac {NUMERATOR \sqrt {k}}{\sqrt {\sigma_ {w} ^ {2} + \sigma_ {b} ^ {2} + k \sqrt {\sigma_ {w} ^ {2} + \sigma_ {b} ^ {2}}}}\right) ^ {d \times L}`;

for (const [number, numerator, tag, punctuation] of [
    [7, String.raw`\sigma_ {w}`, String.raw`\tag{\(l(I(t))\),}`, ','],
    [8, String.raw`\left(\sigma_ {w} - \sigma_ {b}\right)`, String.raw`\tag{\(l(I(t))\}`, '.'],
]) {
    test(`restores the Liquid Time-constant Networks equation ${number} tail with native PDF evidence`, () => {
        const body = LTC_BODY.replace('NUMERATOR', numerator);
        const rawEquation = body + tag;
        const bbox = [80, 300, 440, 350];
        const numberBox = [452, 350, 473, 364];
        const layout = projectMinerULayout({
            _backend: 'hybrid', _version_name: '3.4.4', pdf_info: [{
                page_idx: 0, page_size: [1000, 1000], discarded_blocks: [], para_blocks: [
                    { type: 'interline_equation', bbox, lines: [{ bbox, spans: [
                        { type: 'interline_equation', content: rawEquation, bbox },
                    ] }] },
                    { type: 'text', bbox: numberBox, lines: [{ bbox: numberBox, spans: [
                        { type: 'text', content: `(${number})`, bbox: numberBox },
                    ] }] },
                ],
            }],
        });
        const pdfText = nativeText([
            pdfItem(')', 360, 325, 15), pdfItem(`l(I(t))${punctuation}`, 380, 325, 58),
            pdfItem(`(${number})`, 452, 350, 21),
        ]);
        const bundle = { layout };
        const ir = buildMinerUDocumentIR(bundle, { pdfText });
        assert.equal(ir.blocks.length, 1);
        const expected = `${body} l(I(t))${punctuation} \\tag{${number}}`;
        assert.equal(ir.blocks[0].latex, expected);
        assert.deepEqual(ir.blocks[0].absorbed, ['p0-1']);
        const prepared = prepareMinerUDocument(bundle, { ir });
        assert.equal(prepared.markdown.trim(), `$$\n${expected}\n$$`);
        assert.ok(prepared.sourceMap.every(entry => isValidSourceMapEntry(entry, prepared.markdown.length)));
        const copied = portableMathMarkdown(ir.blocks[0].latex, true);
        assert.ok(copied.includes(`l(I(t))${punctuation} \\tag{${number}}`));
        assert.equal(portableMarkdownForRange(copied, { from: 0, to: copied.length }),
            `$$\n${portableMathSource(expected)}\n$$`);
        for (const target of ['mktero', 'epub', 'zotero-note']) {
            const html = renderMarkdownHTML(prepared.markdown, { target });
            assert.doesNotMatch(html, /katex-error|math-fallback/u);
            if (target === 'zotero-note') {
                assert.ok(html.includes(`l(I(t))${punctuation} \\tag{${number}}`));
            }
            else {
                const { document } = parseHTML(html);
                assert.equal(document.querySelector('.math-display-equation-number')?.textContent, `(${number})`);
                assert.ok([...document.querySelectorAll('mtd')].some(cell => cell.querySelector('mi')
                    && cell.textContent.includes(`l(I(t))${punctuation}`)));
            }
        }
    });
}

test('restores a tail cropped out of the OCR box and includes it in the PDF source region', () => {
    const ir = attach([
        equation('eq', [80, 300, 440, 350], String.raw`x^{d \times L}\tag{\(l(I(t))\}`),
        text('n', [452, 350, 473, 364], '(8)'),
    ], nativeText([
        pdfItem('l', 442, 325, 5), pdfItem('(', 447, 325, 6),
        pdfItem('I', 453, 325, 7), pdfItem('(', 460, 325, 6),
        pdfItem('t', 466, 325, 5), pdfItem('))', 471, 325, 12), pdfItem('.', 483, 325, 4),
        pdfItem('(8)', 452, 350, 21),
    ]));
    assert.equal(ir.blocks.length, 1);
    assert.equal(ir.blocks[0].latex, String.raw`x^{d \times L} l(I(t)). \tag{8}`);
    assert.deepEqual(ir.blocks[0].bbox, [80, 300, 487, 350]);
    assert.deepEqual(ir.blocks[0].fragments[0].bbox, [80, 300, 487, 350]);
    const prepared = prepareMinerUDocument({}, { ir });
    assert.deepEqual(prepared.sourceMap[0].locations[0].bbox, [80, 300, 487, 350]);
});

test('does not duplicate a mathematical tail already present in the equation body', () => {
    const source = String.raw`x l(I(t))\tag{\(l(I(t))\),}`;
    const ir = attach([
        equation('eq', [80, 300, 440, 350], source), text('n', [452, 350, 473, 364], '(7)'),
    ], nativeText([pdfItem(')l(I(t)),', 360, 325, 78)]));
    assert.equal(ir.blocks[0].latex, source);
    assert.equal(ir.blocks.length, 2);
});

test('keeps mathematical tags when native text, an independent number, or body adjacency is missing', () => {
    const tag = String.raw`\tag{\(l(I(t))\),}`;
    const source = 'x' + tag;
    const make = () => [equation('eq', [80, 300, 440, 350], source), text('n', [452, 350, 473, 364], '(7)')];
    for (const pdfText of [
        null,
        nativeText([pdfItem(')g(I(t)),', 360, 325, 78)]),
        nativeText([pdfItem('l(I(t)),', 380, 325, 58)]),
        nativeText([pdfItem(')', 100, 325, 15), pdfItem('l(I(t)),', 380, 325, 58)]),
        nativeText([pdfItem(')l(I(t)).', 360, 325, 78)]),
        nativeText([pdfItem(')l(I(t', 360, 325, 78)]),
        { pages: [{ ...nativeText([]).pages[0], viewport: { width: 10, height: 20, transform: [1, 0, 0, -1, 0, 20] } }] },
    ]) {
        const ir = attach(make(), pdfText);
        assert.equal(ir.blocks.find(block => block.id === 'eq').latex, source);
        assert.ok(ir.blocks.some(block => block.id === 'n'));
    }
    const ir = attach(make().slice(0, 1), nativeText([pdfItem(')l(I(t)),', 360, 325, 78)]));
    assert.equal(ir.blocks[0].latex, source);
});

test('retains starred, nested, escaped, nonterminal, and ambiguous tags without appending another tag', () => {
    for (const source of [
        String.raw`x \tag*{\(l(I(t))\),}`,
        String.raw`x \tag{\text{case {A}}}`,
        String.raw`x \tag{\{A\}}`,
        String.raw`x \tag{\(l(I(t))\),} + y`,
        String.raw`x \tag{1}\tag{2}`,
        String.raw`x \tag{\(l(I(t))}`,
        String.raw`x \tag unbraced`,
    ]) {
        const ir = attach([
            equation('eq', [80, 300, 440, 350], source), text('n', [452, 350, 473, 364], '(7)'),
        ], nativeText([pdfItem(')l(I(t)),', 360, 325, 78)]));
        assert.equal(ir.blocks[0].latex, source);
        assert.equal(ir.blocks.length, 2);
    }
});

test('reads actual top-level tags without treating comments, escaped commands, or nested text as tags', () => {
    for (const source of [String.raw`x \\tag{3}`, String.raw`x \text{literal \\tag{3}}`, 'x % \\tag{3}\n+y']) {
        const ir = attach([
            equation('eq', [80, 300, 440, 350], source), text('n', [452, 350, 473, 364], '(7)'),
        ]);
        assert.equal(ir.blocks[0].latex, `${source} \\tag{7}`);
    }
});

test('does not borrow an internal text-item suffix from a neighbouring column or outside the body', () => {
    const source = String.raw`x \tag{\(l(I(t))\),}`;
    for (const [gutters, numberBox, item] of [
        [[{ from: 480, to: 500 }], [467, 350, 489, 364], pdfItem(')l(I(t)),', 500, 325, 40)],
        [[], [452, 350, 473, 364], pdfItem(')l(I(t)),', 450, 325, 40)],
    ]) {
        const ir = {
            schema: DOCUMENT_IR_SCHEMA,
            pages: [{ pageIndex: 0, width: 1000, height: 1000, textWidth: 1000, gutters }],
            blocks: [equation('eq', [80, 300, 444, 350], source), text('n', numberBox, '(7)')],
            diagnostics: {},
        };
        attachEquationNumbers(ir, nativeText([item]));
        assert.equal(ir.blocks.length, 2);
        assert.equal(ir.blocks[0].latex, source);
        assert.deepEqual(ir.blocks[0].bbox, [80, 300, 444, 350]);
    }
});

test('retains a complete native tail inside the formula column half of a gutter', () => {
    const ir = {
        schema: DOCUMENT_IR_SCHEMA,
        pages: [{ pageIndex: 0, width: 1000, height: 1000, textWidth: 835,
            gutters: [{ from: 480, to: 514 }] }],
        blocks: [equation('eq', [80, 300, 444, 350], String.raw`x^{d \times L}\tag{\(l(I(t))\}`),
            text('n', [456, 350, 477, 364], '(8)')],
        diagnostics: {},
    };
    attachEquationNumbers(ir, nativeText([
        pdfItem('l', 447, 325, 5), pdfItem('(', 452, 325, 6),
        pdfItem('I', 458, 325, 7), pdfItem('(', 467, 325, 6),
        pdfItem('t', 473, 325, 5), pdfItem('))', 479, 325, 12), pdfItem('.', 492, 325, 4),
    ]));
    assert.equal(ir.blocks.length, 1);
    assert.equal(ir.blocks[0].latex, String.raw`x^{d \times L} l(I(t)). \tag{8}`);
    assert.deepEqual(ir.blocks[0].bbox, [80, 300, 496, 350]);
});

test('retains and merges numeric tags within ordinary math groups without creating duplicate tags', () => {
    for (const source of [String.raw`{x \tag{3}}`, String.raw`{{x} \tag{3}}`, String.raw`{\frac{x}{y} \tag{3}}`]) {
        for (const number of [3, 4]) {
            const ir = attach([
                equation('eq', [80, 300, 440, 350], source), text('n', [452, 350, 473, 364], `(${number})`),
            ]);
            assert.equal(ir.blocks.length, 1);
            assert.equal(ir.blocks[0].latex, number === 3 ? source : source.replace('\\tag{3}', '\\tag{3, 4}'));
            const html = renderMarkdownHTML(`$$\n${ir.blocks[0].latex}\n$$`);
            assert.doesNotMatch(html, /math-fallback|katex-error/u);
            assert.equal(parseHTML(html).document.querySelector('.math-display-equation-number')?.textContent.replace(/\s/gu, ' '),
                number === 3 ? '(3)' : '(3, 4)');
        }
    }
});

test('keeps oversized and macro-defining sources unchanged during evidence-based repair', () => {
    for (const source of [
        'x'.repeat(10_001) + String.raw`\tag{\(l(I(t))\),}`,
        String.raw`\def\x{1}x\tag{\(l(I(t))\),}`,
        String.raw`\frac{\tag{\(l(I(t))\),}`,
    ]) {
        const ir = attach([
            equation('eq', [80, 300, 440, 350], source), text('n', [452, 350, 473, 364], '(7)'),
        ], nativeText([pdfItem(')l(I(t)),', 360, 325, 78)]));
        assert.equal(ir.blocks[0].latex, source);
        assert.equal(ir.blocks.length, 2);
    }
});
