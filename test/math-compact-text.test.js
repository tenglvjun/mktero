import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createMathCompactTextIndex,
    findMathCompactOccurrences,
    hasMathMarkup,
    mathCompactText,
} from '../src/markdown/math-compact-text.js';
import { MarkdownAnnotationOverlay } from '../src/core/markdown-annotation-overlay.js';

// Repo-To-Skill, page 4: MinerU TeX and the PDF text layer for one sentence.
const TEX_SENTENCE = 'so that Eq. (3) becomes a_{t} \\sim \\pi_{\\theta}(a \\mid \\tau, h_{t}, H, \\mathcal{K})';
const PDF_SENTENCE = 'so that Eq. (3)\nbecomes at ∼ πθ (a | τ, ht, H, K).';
// Repo-To-Skill, Eq. (7) as MinerU writes it and as Zotero saved it.
const EQUATION_7 = '\\mathcal {G} = (\\mathcal {S}, \\mathcal {L}), \\quad \\mathcal {S} = \\{S _ {i} \\} _ {i = 1} ^ {n}, n \\geq 1, \\quad \\mathcal {L} \\subseteq \\{(S _ {i}, S _ {j}) \\in \\mathcal {S} \\times \\mathcal {S} | i \\neq j \\}.\\tag{7}';

test('reduces TeX and PDF glyphs of one formula to the same key', () => {
    assert.equal(mathCompactText(TEX_SENTENCE), mathCompactText(PDF_SENTENCE));
});

test('maps a math-compact match back to the PDF source text', () => {
    const page = `explicit operating context, ${PDF_SENTENCE}\nOperational knowledge`;
    const index = createMathCompactTextIndex(page);
    const key = mathCompactText(TEX_SENTENCE);
    const [offset] = findMathCompactOccurrences(index, key);
    const range = index.sourceRange(offset, key.length);

    assert.equal(page.slice(range.from, range.to), PDF_SENTENCE.slice(0, -2));
});

test('only treats text with math markup as math', () => {
    assert.equal(hasMathMarkup(TEX_SENTENCE), true);
    assert.equal(hasMathMarkup(EQUATION_7), true);
    assert.equal(hasMathMarkup('An ordinary sentence about agents.'), false);
    assert.equal(hasMathMarkup('Let \u02C6y denote a parsed prediction'), true);
});

// What a selection or a Zotero highlight over a formula carries once the
// TeX delimiters are gone, or as the PDF text layer prints it.
test('treats bare TeX scripts and primes, and PDF math glyphs, as math', () => {
    for (const text of [
        "For a candidate H' relative to the current harness",
        "the derivative f'' of the loss",
        'Then S^* is updated and x^2 grows',
        'where x_1 is the first input',
        'noise band \u{1D6FF}. Let \u{1D446}\u2605 denote the best score',
        'For a candidate \u{1D43B}\u2032 relative to the current harness',
        'Defu Lian 2\u2217, Zhicheng Dou 3\u2217, Chaozhuo Li1',
        'the Planck constant \u210E and the length \u2113',
        'a relation u \u22A5 v holds',
    ]) {
        assert.equal(hasMathMarkup(text), true, text);
    }
    for (const text of [
        "The students' results and Jones' notes are in the appendix.",
        "It's the authors' choice, isn't it?",
        'p < 0.05 for every run, and 3 + 4 = 7 in the table.',
        'An ordinary sentence with an em dash \u2014 and \u201Cquotes\u201D.',
    ]) {
        assert.equal(hasMathMarkup(text), false, text);
    }
});

// BRS paper, Appendix C and the author line: Zotero saves the PDF glyphs,
// MinerU wrote TeX. Without math in the check, these never reached the
// math-compact comparison.
test('matches PDF highlights whose only math is glyphs to Markdown TeX', async () => {
    const markdown = [
        'Defu Lian $^{2*}$, Zhicheng Dou $^{3*}$, Chaozhuo Li $^{1}$, Qiwei Ye $^{1}$, Zheng Liu $^{1,4*}$',
        '',
        'We first evaluate the unchanged base harness and estimate an empirical noise band $\\delta$. Let $S^{\\star}$ denote the best evolve-set score observed so far.',
    ].join('\n');
    const annotations = [
        'Defu Lian 2\u2217, Zhicheng Dou 3\u2217, Chaozhuo Li1, Qiwei Ye1, Zheng Liu 1,4\u2217',
        'harness and estimate an empirical noise band \u{1D6FF}. Let \u{1D446}\u2605 denote the best evolve-set score observed so',
    ].map((text, index) => ({
        id: `GLYPHONLY${index}`,
        type: 'highlight',
        text,
        comment: '',
        color: '#ffd400',
        pageLabel: '1',
        pageIndex: 0,
        sortIndex: `00000|00010${index}|00160`,
    }));
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => annotations },
    });

    const result = await overlay.resolve(42, markdown);

    assert.deepEqual(result.unmatched, []);
    const [authors, band] = result.matched.map(annotation => markdown.slice(
        annotation.ranges[0].from,
        annotation.ranges.at(-1).to
    ));
    assert.match(authors, /^Defu Lian \$\^\{2\*\}\$/u);
    assert.match(authors, /Zheng Liu \$\^\{1,4\*\}\$$/u);
    assert.match(band, /^harness and estimate/u);
    assert.match(band, /observed so$/u);
});

// KaTeX prints these commands as one glyph, and the PDF text layer keeps it.
test('reads TeX symbol commands as the glyphs they print', () => {
    for (const [tex, glyphs] of [
        ['u \\perp v, a \\prec b \\preceq c', 'u \u22A5 v, a \u227A b \u2AAF c'],
        ['p \\wedge q \\vee r, x \\ni y', 'p \u2227 q \u2228 r, x \u220B y'],
        ['A \\vdash B \\dashv C, f \\asymp g', 'A \u22A2 B \u22A3 C, f \u224D g'],
        ['\\hbar \\ell \\aleph_0 \\wp', '\u210F \u2113 \u2135 0 \u2118'],
        ['a \\leqslant b \\geqslant c \\bullet d', 'a \u2264 b \u2265 c \u2022 d'],
    ]) {
        assert.equal(mathCompactText(tex), mathCompactText(glyphs), tex);
    }
});

// BRS paper, Algorithm 2 line 5: MinerU wrote \triangleright, which KaTeX
// prints as ▹, while the PDF text layer of this font keeps ⊲.
test('drops the triangle glyphs the two spellings print differently', () => {
    assert.equal(
        mathCompactText('5: \\nu \\leftarrow \\nu_t(H\') \\quad \\triangleright new structural component types'),
        mathCompactText('5: \u{1D708} \u2190 \u{1D708}\u{1D461} (\u{1D43B}\u2032) \u22B2 new structural component types')
    );
    for (const glyph of ['\u22B2', '\u22B3', '\u25C1', '\u25B7', '\u25C3', '\u25B9', '\u25C0', '\u25B6']) {
        assert.equal(mathCompactText(`a ${glyph} b`), 'ab', glyph);
    }
});

test('refuses keys too short to identify a passage', () => {
    const index = createMathCompactTextIndex('$x$ and $y$');
    assert.equal(findMathCompactOccurrences(index, mathCompactText('$x$')), null);
});

test('matches a saved TeX display equation to its Markdown block', async () => {
    const markdown = [
        'A single source organizes skills as a skill graph',
        '',
        '$$',
        EQUATION_7,
        '$$',
        '',
        'The graph contains an entry skill.',
    ].join('\n');
    const annotation = {
        id: '7RVC9KL5',
        type: 'highlight',
        text: EQUATION_7,
        comment: '',
        color: '#ffd400',
        pageLabel: '5',
        pageIndex: 4,
        sortIndex: '00004|000100|00160',
    };
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
    });

    const result = await overlay.resolve(42, markdown);

    assert.equal(result.unmatched.length, 0);
    const [range] = result.matched[0].ranges;
    assert.equal(
        markdown.slice(range.from, range.to),
        `$$\n${EQUATION_7}\n$$\n`
    );
});

test('matches a PDF glyph highlight to Markdown inline TeX', async () => {
    const markdown = `where $\\mathcal{K}$ is the operational knowledge, ${TEX_SENTENCE.replace('a_{t}', '$a_{t}')}$.\n\nNext paragraph.`;
    const annotation = {
        id: 'GLYPHS01',
        type: 'highlight',
        text: PDF_SENTENCE,
        comment: '',
        color: '#ffd400',
        pageLabel: '4',
        pageIndex: 3,
        sortIndex: '00003|000100|00160',
    };
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
    });

    const result = await overlay.resolve(42, markdown);

    assert.equal(result.unmatched.length, 0);
    const [range] = result.matched[0].ranges;
    const source = markdown.slice(range.from, range.to);
    assert.match(source, /^so that Eq\. \(3\) becomes \$a_\{t\}/u);
    assert.match(source, /\\mathcal\{K\}\)\$$/u);
});

// BRS paper, Algorithm 2: the PDF text layer keeps each hat as its own
// spacing glyph (U+02C6) before the math-italic letter it sits on.
const HAT_TEX = 'Require: screened \\mathcal{H}_t, (H_t, \\hat{S}_t, \\hat{C}_t), S^*, \\delta, k';
const HAT_PDF = 'Require: screened H\u{1D461} , (\u{1D43B}\u{1D461} , \u02C6\u{1D446}\u{1D461} , \u02C6\u{1D436}\u{1D461} ), \u{1D446}\u2605, \u{1D6FF}, \u{1D458}';

test('drops a spacing accent glyph the PDF keeps for a TeX accent', () => {
    assert.equal(mathCompactText(HAT_TEX), mathCompactText(HAT_PDF));
    assert.equal(
        mathCompactText('(\\check{C}_t, \\bar{x}, \\acute{a}, \\grave{e})'),
        mathCompactText('(\u02C7\u{1D436}\u{1D461} , \u02C9x, \u02CAa, \u02CBe)')
    );
});

test('keeps a letter that carries its accent', () => {
    assert.equal(mathCompactText('na\u00EFve caf\u00E9'), 'na\u00EFvecaf\u00E9');
    assert.equal(mathCompactText('\u02C6y'), 'y');
});

test('matches a PDF highlight over a hat glyph to Markdown TeX', async () => {
    const markdown = `Algorithm 2 RRSI, selection side.\n\n${HAT_TEX.replace('\\mathcal', '$\\mathcal')}$\n\nRequire: weights.\n`;
    const annotation = {
        id: 'HATGLYPH',
        type: 'highlight',
        text: HAT_PDF,
        comment: '',
        color: '#ffd400',
        pageLabel: '20',
        pageIndex: 19,
        sortIndex: '00019|000100|00160',
    };
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => [annotation] },
    });

    const result = await overlay.resolve(42, markdown);

    assert.equal(result.unmatched.length, 0);
    const [range] = result.matched[0].ranges;
    const source = markdown.slice(range.from, range.to);
    assert.match(source, /^Require: screened \$\\mathcal/u);
    assert.match(source, /\\delta, k\$?$/u);
});

// BRS paper, Algorithm 2 and Appendix C: MinerU writes a prime as ' or
// \prime and a star as \star or *, the PDF text layer keeps ′ and ★, and
// \max is the word the PDF prints.
const PRIME_TEX = "12: if \\hat{S}' ≥ S^* - \\delta and c and g then";
const PRIME_PDF = '12: if \u02C6\u{1D446}\u2032 \u2265 \u{1D446}\u2605 \u2212 \u{1D6FF} and \u{1D450} and \u{1D454} then';
const STAR_TEX = 'The running best score is then updated as S^{\\star} \\leftarrow \\max(S^{\\star}, \\hat{S}(H_{t+1})).';
const STAR_PDF = 'The running best score is then updated as \u{1D446}\u2605 \u2190 max(\u{1D446}\u2605, \u02C6\u{1D446}(\u{1D43B}\u{1D461}+1)).';

test('reads primes, stars and operator names the same in TeX and PDF glyphs', () => {
    assert.equal(mathCompactText(PRIME_TEX), mathCompactText(PRIME_PDF));
    assert.equal(mathCompactText(STAR_TEX), mathCompactText(STAR_PDF));
    for (const spelling of ["H'", 'H^{\\prime}', 'H^\\prime', '\u{1D43B}\u2032', '\u{1D43B}\u2033']) {
        assert.equal(mathCompactText(spelling), 'h', spelling);
    }
    for (const spelling of ['S^*', 'S^{\\ast}', 'S^{\\star}', 'S\u2217', 'S\u22C6', '\u{1D446}\u2605']) {
        assert.equal(mathCompactText(spelling), 's', spelling);
    }
    assert.equal(
        mathCompactText('O(\\log N), \\arg\\max_{x} f, \\lim_{n} a_n'),
        mathCompactText('O(log N), arg max\u{1D465} \u{1D453}, lim\u{1D45B} \u{1D44E}\u{1D45B}')
    );
});

test('matches PDF highlights over primes and stars to Markdown TeX', async () => {
    const markdown = [
        `11: $g \\leftarrow DomainGuard(H_t, H')$`,
        '',
        `${PRIME_TEX.replace('\\hat', '$\\hat').replace(' and c and g', '$ and $c$ and $g$')}`,
        '',
        'If no candidate is admissible, the incumbent is retained.',
        STAR_TEX.replace('S^{\\star} \\leftarrow', '$S^{\\star} \\leftarrow').replace(')).', '))$.'),
    ].join('\n');
    const annotations = [PRIME_PDF, STAR_PDF].map((text, index) => ({
        id: `PRIMESTAR${index}`,
        type: 'highlight',
        text,
        comment: '',
        color: '#ffd400',
        pageLabel: '20',
        pageIndex: 19,
        sortIndex: `00019|00010${index}|00160`,
    }));
    const overlay = new MarkdownAnnotationOverlay({
        extractor: { extract: async () => annotations },
    });

    const result = await overlay.resolve(42, markdown);

    assert.deepEqual(result.unmatched, []);
    const [prime, star] = result.matched.map(annotation => markdown.slice(
        annotation.ranges[0].from,
        annotation.ranges.at(-1).to
    ));
    assert.match(prime, /^12: if \$\\hat\{S\}' ≥ S\^\*/u);
    assert.match(prime, /then$/u);
    assert.match(star, /^The running best score is then updated as \$S\^\{\\star\}/u);
});

// Dream-RSI, page 5: the PDF text layer prints a superscript before the
// subscript of the same base ("T 𝑘\n𝑡" for T_{t}^{k}).
const DREAM_TEX = 'Let T_{t}^{k} denote the new discovery tree after k completed decision rounds, with T_{t}^{0} = \\{r\\}. A node batch C_{t}^{k} \\in A(\\mathcal{T}_{t}^{k}; W) and each node v \\in C_{t}^{k} is assigned';
const DREAM_PDF = 'Let T 𝑘\n𝑡 denote the new discovery tree after 𝑘 completed decision rounds, with T 0\n𝑡 = {𝑟}. A node batch 𝐶𝑘\n𝑡 ∈ 𝐴(T 𝑘\n𝑡 ; 𝑊)\nand each node 𝑣 ∈ 𝐶𝑘\n𝑡 is assigned';

test('reads a base with both scripts superscript first, as the PDF prints it', () => {
    assert.equal(mathCompactText('x_{i}^{2}'), mathCompactText('𝑥2\n𝑖'));
    assert.equal(mathCompactText('S _ {i} ^ {n}'), mathCompactText('S^{n}_{i}'));
    assert.equal(mathCompactText('x_\\alpha^2'), 'x2α');
    assert.equal(mathCompactText('x_{i}'), 'xi');
    assert.equal(mathCompactText(DREAM_TEX), mathCompactText(DREAM_PDF));
});

test('maps a reordered match back to the whole formula source', () => {
    const tex = `before ${DREAM_TEX} after`;
    const index = createMathCompactTextIndex(tex);
    const key = mathCompactText(DREAM_PDF);
    const [offset] = findMathCompactOccurrences(index, key);
    const range = index.sourceRange(offset, key.length);

    assert.equal(tex.slice(range.from, range.to), DREAM_TEX);
    const short = createMathCompactTextIndex('T_{t}^{k}');
    assert.deepEqual(short.sourceRange(0, 3), { from: 0, to: 8 });
});
