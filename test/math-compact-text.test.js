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
