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
