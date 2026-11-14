import test from 'node:test';
import assert from 'node:assert/strict';
import { projectMinerULayout } from '../src/mineru/document/result-bundle.js';
import { projectMinerUMiddleJSON } from '../src/mineru/document/ingest-middle-v2.js';
import { buildMinerUDocumentIR } from '../src/mineru/document/prepare.js';
import { serializeDocumentIR } from '../src/mineru/document/serialize.js';
import { isValidSourceMapEntry } from '../src/core/markdown-source-map.js';
import { findDisplayMathMatches, findInlineMathMatches, renderMarkdownHTML } from '../src/markdown/markdown-html.js';

const BOX = [60, 80, 540, 700];
const text = content => ({ type: 'text', content });
const math = content => ({ type: 'inline_equation', content });

function layout(rows, { algorithm = true } = {}) {
    return projectMinerULayout({
        _backend: 'hybrid', _version_name: '3.4.4',
        pdf_info: [{ page_idx: 19, page_size: [600, 800], discarded_blocks: [], para_blocks: [{
            type: 'code', ...(algorithm ? { sub_type: 'algorithm' } : {}), bbox: BOX,
            blocks: [{ type: 'code_body', bbox: BOX, lines: rows.map(spans => ({ bbox: BOX, spans })) }],
        }] }],
    });
}

function prepare(projected) {
    const ir = buildMinerUDocumentIR({ layout: projected });
    const serialized = serializeDocumentIR(ir);
    assert.ok(serialized.sourceMap.length);
    assert.ok(serialized.sourceMap.every(entry => isValidSourceMapEntry(entry, serialized.markdown.length)));
    return { ir, code: ir.blocks[0].children.find(child => child.kind === 'body').code, ...serialized };
}

// The four adjacent equation pairs in the real RRSI MinerU archive, page 20.
// The archive and PDF stay in the local corpus; no image or PDF bytes are used.
const RRSI = [
    {
        name: 'proposal step 2', step: 2,
        formula: String.raw`b_t \leftarrow \left[ b_{\min} + (b_{\max} - b_{\min}) \frac{1}{2} (1 + \cos \frac{\pi t}{T}) \right]`,
        comment: String.raw`\triangleright L_0`, suffix: '-style edit-cardinality control',
    },
    {
        name: 'proposal step 7', step: 7,
        formula: String.raw`\mathcal{B}_t \leftarrow \{\ell \in \mathcal{T}_t : g_t(\ell) \leq 0\}`,
        comment: String.raw`\triangleright \text{Lasso}/L_1`, suffix: '-style pruning targets',
    },
    {
        name: 'selection step 7', step: 7,
        formula: String.raw`c \leftarrow [\Delta C \leq \beta_0 + \beta_1\Delta S]`,
        comment: String.raw`\triangleright`, suffix: ' gain-dependent cost rule, Eq. (7)',
    },
    {
        name: 'selection step 9', step: 9,
        formula: String.raw`c \leftarrow [w_s\Delta S - w_c\Delta C + w_n\nu > 0]`,
        comment: String.raw`\triangleright`, suffix: ' within-band rule, Eq. (17)',
    },
];

for (const example of RRSI) {
    test(`RRSI ${example.name} renders its formula and comment independently`, () => {
        const result = prepare(layout([[
            text(`${example.step}: `), math(example.formula), math(example.comment), text(example.suffix),
        ]]));
        assert.equal(result.code, `${example.step}: $${example.formula}$ $${example.comment}$${example.suffix}`);
        assert.deepEqual(findInlineMathMatches(result.code).map(match => match.text), [example.formula, example.comment]);
        const html = renderMarkdownHTML(result.markdown);
        assert.match(html, /class="math-inline"/u);
        assert.doesNotMatch(html, /katex-error|math-fallback/u);
        assert.ok(html.includes(example.suffix));
    });
}

test('separates runs of adjacent algorithm math without changing existing whitespace', () => {
    const result = prepare(layout([
        [text('  1:\t'), math('a'), math('b'), math('c'), text(';')],
        [text('\t2: '), math('d'), text('  \t'), math('e'), text(' end')],
    ]));
    assert.equal(result.code, '  1:\t$a$ $b$ $c$;\n\t2: $d$  \t$e$ end');
    assert.equal(findInlineMathMatches(result.code).length, 5);
    assert.doesNotMatch(renderMarkdownHTML(result.markdown), /katex-error/u);
});

test('ignores empty algorithm spans while keeping adjacent equations separate', () => {
    const result = prepare(layout([[
        math('a'), text(''), { type: 'text' }, math('   '), math('b'),
    ]]));
    assert.equal(result.code, '$a$ $b$');
    assert.doesNotMatch(renderMarkdownHTML(result.markdown), /katex-error/u);
});

test('preserves literal dollars, display equations, and escaped dollars in text', () => {
    const literal = String.raw`  cost = "$5"; literal = "\$x";`;
    const display = '$$\nx + y\n$$';
    const result = prepare(layout([[text(literal)], [text('')], [text(display)]]));
    assert.equal(result.code, `${literal}\n\n${display}`);
    assert.equal(findDisplayMathMatches(result.code).length, 1);
    assert.doesNotMatch(renderMarkdownHTML(result.markdown), /katex-error/u);
});

test('leaves ordinary code spacing and literal adjacent dollar markers unchanged', () => {
    const result = prepare(layout([
        [text('  const value = '), math('a'), math('b'), text(';')],
        [text('  const literal = "$$x$$";')],
    ], { algorithm: false }));
    assert.equal(result.code, '  const value = $a$$b$;\n  const literal = "$$x$$";');
    assert.match(result.markdown, /^```/u);
    assert.doesNotMatch(renderMarkdownHTML(result.markdown), /katex-error|class="math-inline"/u);
});

test('keeps HTML inside algorithm content inert after separating math', () => {
    const result = prepare(layout([[
        math('a'), math('b'), text('<img src=x onerror="alert(1)"><script>alert(2)</script>'),
    ]]));
    const html = renderMarkdownHTML(result.markdown);
    assert.doesNotMatch(html, /<script\b|<img\b|katex-error/iu);
    assert.match(html, /&lt;script&gt;/u);
});

test('also separates adjacent formulas projected from MinerU 4.0 middle JSON', () => {
    const projected = projectMinerUMiddleJSON({
        schema: 'docvortex.middle', schema_version: '2.0',
        pages: [{ page_idx: 0, blocks: [{ type: 'code', sub_type: 'algorithm', bbox: [0.1, 0.1, 0.9, 0.8], content: [{
            type: 'algorithm_body', bbox: [0.1, 0.1, 0.9, 0.8], content: [
                text('  1: '), { type: 'equation_inline', content: 'a' },
                { type: 'equation_inline', content: String.raw`\triangleright` }, text(' comment'),
            ],
        }] }] }],
    });
    const result = prepare(projected);
    assert.equal(result.code, String.raw`  1: $a$ $\triangleright$ comment`);
    assert.doesNotMatch(renderMarkdownHTML(result.markdown), /katex-error/u);
});
