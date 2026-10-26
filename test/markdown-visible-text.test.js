import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createVisibleMarkdownTextIndex,
    trimDanglingMarkdownMarkRanges,
    visibleMarkdownTextForRanges,
} from '../src/markdown/markdown-visible-text.js';

test('indexes rendered inline math without its delimiters', () => {
    const markdown = 'Before $n = 22$ after.';
    const index = createVisibleMarkdownTextIndex(markdown);

    assert.equal(index.text, 'Before n = 22 after.');
    assert.deepEqual(index.sourceRange(7, 6), { from: 8, to: 14 });
});

test('keeps dollar signs visible inside inline code', () => {
    const index = createVisibleMarkdownTextIndex('`price $5$` and $x$');

    assert.equal(index.text, 'price $5$ and x');
});

test('unescapes Markdown punctuation only where it renders as punctuation', () => {
    const math = '0.30\\;^{\\circ}C';
    const markdown = `\`HALF\\_LOCS\` and $${math}$ and HALF\\_LOCS`;
    const index = createVisibleMarkdownTextIndex(markdown);
    const mathFrom = index.text.indexOf(math);
    const visibleFrom = index.text.lastIndexOf('HALF_LOCS');
    const mathRange = index.sourceRange(mathFrom, math.length);
    const range = index.sourceRange(visibleFrom, 'HALF_LOCS'.length);

    assert.equal(index.text, `HALF\\_LOCS and ${math} and HALF_LOCS`);
    assert.equal(markdown.slice(mathRange.from, mathRange.to), math);
    assert.equal(markdown.slice(range.from, range.to), 'HALF\\_LOCS');
});

test('handles repeated escapes and a malformed trailing backslash', () => {
    const mathEscapeCount = 4_000;
    const escapeCount = 10_000;
    const math = '\\;'.repeat(mathEscapeCount);
    const markdown = `$${math}$\n${'\\_'.repeat(escapeCount)}\\`;
    const index = createVisibleMarkdownTextIndex(markdown);

    assert.equal(index.text, `${math}\n${'_'.repeat(escapeCount)}\\`);
    assert.deepEqual(index.sourceRange(0, 2), { from: 1, to: 3 });
    assert.deepEqual(
        index.sourceRange(index.text.length - 1, 1),
        { from: markdown.length - 1, to: markdown.length }
    );
});

test('preserves MinerU superscript math for PDF annotation matching', () => {
    const markdown = 'Sentence. $^{11}$ BOSE $^{®}$ headphones';
    const index = createVisibleMarkdownTextIndex(markdown);

    assert.equal(index.text, markdown);
});

test('extracts visible text from a Markdown source range', () => {
    const first = 'First *emphasis*, $x$ and [link](https://example.com).';
    const markdown = `${first}\n\nSecond paragraph.`;
    const index = createVisibleMarkdownTextIndex(markdown);

    assert.equal(
        index.textForSourceRange(0, first.length),
        'First emphasis, x and link.'
    );
    assert.equal(
        index.textForSourceRange(markdown.indexOf('$'), markdown.indexOf('$') + 3),
        'x'
    );
});

test('maps Markdown source offsets to visible text offsets', () => {
    const markdown = '**SUMMARY ANSWER:** [Repeated](https://example.com) result.';
    const index = createVisibleMarkdownTextIndex(markdown);
    const repeatedFrom = markdown.indexOf('Repeated');
    const urlFrom = markdown.indexOf('https://');

    assert.equal(index.visibleOffsetAt(0), 0);
    assert.equal(index.visibleOffsetAt(2), 0);
    assert.equal(index.visibleOffsetAt(repeatedFrom), 'SUMMARY ANSWER: '.length);
    assert.equal(
        index.visibleOffsetAt(urlFrom),
        'SUMMARY ANSWER: Repeated'.length
    );
    assert.equal(index.visibleOffsetAt(markdown.length), index.text.length);
});

test('preserves unresolved bracketed text while hiding resolved link syntax', () => {
    const plain = createVisibleMarkdownTextIndex(
        'Estimate [95% CI 0.17–1.12] and [plain label].'
    );
    const references = createVisibleMarkdownTextIndex([
        '[full label][paper] and [shortcut].',
        '',
        '[paper]: https://example.com/full',
        '[shortcut]: https://example.com/shortcut',
    ].join('\n'));

    assert.equal(
        plain.text,
        'Estimate [95% CI 0.17–1.12] and [plain label].'
    );
    assert.equal(references.text, 'full label and shortcut.\n\n\n');
});

test('rejects invalid visible-text source ranges', () => {
    const markdown = '[label](https://example.com)';
    const index = createVisibleMarkdownTextIndex(markdown);
    const urlFrom = markdown.indexOf('https://');

    assert.equal(index.textForSourceRange(urlFrom, markdown.length - 1), '');
    assert.equal(index.textForSourceRange(-1, 1), '');
    assert.equal(index.textForSourceRange(1, 1), '');
    assert.equal(index.textForSourceRange(0, markdown.length + 1), '');
});

test('hides extra ranges in the visible Markdown index', () => {
    const markdown = 'Hello **x** World';
    const index = createVisibleMarkdownTextIndex(markdown, [{ from: 6, to: 11 }]);
    assert.equal(index.text, 'Hello  World');
});

test('strips heading marks from visible Markdown range text', () => {
    const markdown = '### 3.1 Execution State and Schema Authoring\n\nBody.';
    assert.equal(
        visibleMarkdownTextForRanges(markdown, [{
            from: 0,
            to: markdown.indexOf('\n'),
        }]).trim(),
        '3.1 Execution State and Schema Authoring'
    );
});

test('strips display math delimiters from visible Markdown range text', () => {
    const formula = '(R_t, \\Delta\\Sigma_t, a_t)';
    const markdown = `Intro.\n\n$$\n${formula}\n$$\n\nBody.`;
    const from = markdown.indexOf('$$');
    const to = markdown.lastIndexOf('$$') + 2;
    assert.equal(
        visibleMarkdownTextForRanges(markdown, [{ from, to }]).trim(),
        formula
    );
});

test('reads a partial inline-markup range from the whole document', () => {
    const bold = 'We report **strong results** today.';
    const boldTo = bold.indexOf('strong results') + 'strong results'.length;
    const conclusions = '**Conclusions** we found more.';
    const link = 'See [paper](https://x.org/a) now.';
    assert.equal(
        visibleMarkdownTextForRanges(bold, [{ from: 0, to: boldTo }]),
        'We report strong results'
    );
    assert.equal(
        visibleMarkdownTextForRanges(conclusions, [{
            from: conclusions.indexOf('Conclusions'),
            to: conclusions.indexOf('found') + 'found'.length,
        }]),
        'Conclusions we found'
    );
    assert.equal(
        visibleMarkdownTextForRanges(link, [{
            from: link.indexOf('per'),
            to: link.indexOf('now.') + 'now.'.length,
        }]),
        'per now.'
    );
});

test('decodes HTML table cell text and skips tags', () => {
    const markdown = '<table><tr><td>A &amp; B</td><td colspan="2">td</td></tr></table>';
    const entityFrom = markdown.indexOf('A &amp; B');
    const cellFrom = markdown.lastIndexOf('>td<') + 1;
    assert.equal(
        visibleMarkdownTextForRanges(markdown, [{
            from: entityFrom,
            to: entityFrom + 'A &amp; B'.length,
        }]),
        'A & B'
    );
    assert.equal(
        visibleMarkdownTextForRanges(markdown, [{
            from: cellFrom,
            to: cellFrom + 2,
        }]),
        'td'
    );
    assert.equal(
        visibleMarkdownTextForRanges(markdown, [{
            from: markdown.indexOf('<td'),
            to: markdown.indexOf('<td') + 4,
        }]),
        ''
    );
});

test('range text hides the superscript wrappers the reader hides', () => {
    const cited = 'The Value<sup>2</sup> grows.\n\n<sup>2</sup> A note.';
    const plain = 'Prior work<sup>2</sup> and H<sub>2</sub>O.';
    const dagger = 'Alice Smith$^{\\dagger}$ wrote. Bob${}^{\\ddagger}$ too.';
    const numeric = 'Alice Smith$^{1}$ wrote.';
    assert.equal(
        visibleMarkdownTextForRanges(cited, [{
            from: cited.indexOf('Value'),
            to: cited.indexOf(' grows'),
        }]),
        'Value2'
    );
    // An unrecognized <sup> and every <sub> stay raw in the reader too.
    assert.equal(
        visibleMarkdownTextForRanges(plain, [{ from: 0, to: plain.length }]),
        plain
    );
    assert.equal(
        visibleMarkdownTextForRanges(dagger, [{ from: 0, to: dagger.length }]),
        'Alice Smith† wrote. Bob‡ too.'
    );
    const markFrom = dagger.indexOf('$^');
    assert.equal(
        visibleMarkdownTextForRanges(dagger, [{
            from: markFrom,
            to: dagger.indexOf(' wrote'),
        }]),
        '†'
    );
    // A numeric mark keeps the form normalizePdfAnnotationText flattens.
    assert.equal(
        visibleMarkdownTextForRanges(numeric, [{ from: 0, to: numeric.length }]),
        numeric
    );
    // The shared index keeps its source text for search and PDF matching.
    assert.equal(
        createVisibleMarkdownTextIndex(dagger).text,
        'Alice Smith$^{\\dagger}$ wrote. Bob{}^{\\ddagger} too.'
    );
});

test('range text separates segments split around hidden page chrome', () => {
    const markdown = 'Hello\n\n12\n\nWorld';
    assert.equal(
        visibleMarkdownTextForRanges(markdown, [
            { from: 0, to: 5 },
            { from: 11, to: 16 },
        ]),
        'Hello World'
    );
    assert.equal(
        visibleMarkdownTextForRanges('Hello \n\nWorld', [
            { from: 0, to: 6 },
            { from: 8, to: 13 },
        ]),
        'Hello World'
    );
    // Hidden marks inside a word do not add a space.
    const bold = 'We report **strong results** today.';
    assert.equal(
        visibleMarkdownTextForRanges(bold, [
            { from: 0, to: bold.indexOf('**') },
            { from: bold.indexOf('strong'), to: bold.indexOf('strong') + 6 },
        ]),
        'We report strong'
    );
    const word = 'foo**bar** baz';
    assert.equal(
        visibleMarkdownTextForRanges(word, [
            { from: 0, to: 3 },
            { from: 5, to: 8 },
        ]),
        'foobar'
    );
});

test('selection text reuses supplied citation analyses instead of reparsing', async () => {
    const { visibleMarkdownTextForRanges } = await import('../src/markdown/markdown-visible-text.js');
    const { analyzeMarkdownCitations } = await import('../src/markdown/markdown-citations.js');
    const { analyzeMarkdownFootnotes } = await import('../src/markdown/markdown-footnotes.js');
    // A unique document, so the module's own index cache cannot answer first.
    const markdown = [
        `Reuse probe ${Date.now()} reduces anxiety<sup>2</sup> in trials.`,
        '',
        '## References',
        '',
        '[2] Beta B. Second paper. 2020.',
    ].join('\n');
    const calls = { citations: 0, footnotes: 0 };
    const analyses = {
        citations() {
            calls.citations++;
            return analyzeMarkdownCitations(markdown);
        },
        footnotes() {
            calls.footnotes++;
            return analyzeMarkdownFootnotes(markdown);
        },
    };
    const to = markdown.indexOf(' in trials');

    const text = visibleMarkdownTextForRanges(markdown, [{ from: 0, to }], { analyses });

    assert.match(text, /anxiety2$/);
    assert.equal(calls.citations, 1);
    assert.equal(calls.footnotes, 1);
});

test('range text shows the glyphs the reader draws for a superscript mark', async () => {
    const { legacyVisibleMarkdownTextForRanges } = await import('../src/markdown/markdown-visible-text.js');
    for (const [markdown, expected] of [
        ['Alice Smith $^{*}$ wrote.', 'Alice Smith∗ wrote.'],
        ['Alice Smith$^{\\ast}$ wrote.', 'Alice Smith∗ wrote.'],
        ['Alice Smith $^{\\star}$ wrote.', 'Alice Smith⋆ wrote.'],
        ['Alice Smith$^{1,\\dagger}$ wrote.', 'Alice Smith1,† wrote.'],
    ]) {
        const whole = [{ from: 0, to: markdown.length }];
        assert.equal(visibleMarkdownTextForRanges(markdown, whole), expected, markdown);
        const markFrom = markdown.indexOf('$');
        assert.equal(
            visibleMarkdownTextForRanges(markdown, [{
                from: markFrom,
                to: markdown.lastIndexOf('$') + 1,
            }]),
            expected.replace(/^Alice Smith/u, '').replace(/ wrote\.$/u, ''),
            markdown
        );
        // Stored raw text still has its legacy form to match.
        assert.equal(legacyVisibleMarkdownTextForRanges(markdown, whole), markdown);
    }
    // A footnote link draws `*`, `\ast` and `\star` as "*".
    const note = [
        'Alice Smith$^{\\star}$ wrote.',
        '',
        '<!-- mktero-note: footnote -->',
        '> $^{\\star}$ Corresponding author.',
    ].join('\n');
    assert.equal(
        visibleMarkdownTextForRanges(note, [{ from: 0, to: note.indexOf('\n') }]),
        'Alice Smith* wrote.'
    );
    // A numeric superscript keeps its source form.
    const numeric = 'Alice Smith$^{1,2}$ wrote.';
    assert.equal(
        visibleMarkdownTextForRanges(numeric, [{ from: 0, to: numeric.length }]),
        numeric
    );
});

test('range text hides a link title and the autolink marks', async () => {
    const { legacyVisibleMarkdownTextForRanges, trimDanglingMarkdownMarkRanges } = await import('../src/markdown/markdown-visible-text.js');
    const titled = 'See [the text](https://x.org "Title") now.';
    const whole = [{ from: 0, to: titled.length }];
    assert.equal(visibleMarkdownTextForRanges(titled, whole), 'See the text now.');
    assert.equal(createVisibleMarkdownTextIndex(titled).text, 'See the text now.');
    // Saved before the title was hidden.
    assert.equal(
        legacyVisibleMarkdownTextForRanges(titled, whole),
        'See the text "Title" now.'
    );
    // A selection that ends inside the link drops the hidden title with it.
    const textEnd = titled.indexOf('](');
    assert.deepEqual(
        trimDanglingMarkdownMarkRanges(titled, [{ from: 0, to: titled.indexOf('Title') + 2 }]),
        [{ from: 0, to: titled.indexOf('[') }, { from: titled.indexOf('the'), to: textEnd }]
    );

    const autolink = 'Visit <https://x.org/a> today.';
    const url = 'https://x.org/a';
    const urlFrom = autolink.indexOf(url);
    for (const range of [
        { from: urlFrom, to: urlFrom + url.length + 1 },
        { from: urlFrom - 1, to: urlFrom + url.length },
    ]) {
        assert.deepEqual(
            trimDanglingMarkdownMarkRanges(autolink, [range]),
            [{ from: urlFrom, to: urlFrom + url.length }]
        );
    }
    assert.deepEqual(
        trimDanglingMarkdownMarkRanges(autolink, [{ from: 0, to: autolink.lastIndexOf('.') }]),
        [
            { from: 0, to: urlFrom - 1 },
            { from: urlFrom, to: urlFrom + url.length },
            { from: urlFrom + url.length + 1, to: autolink.lastIndexOf('.') },
        ]
    );
});

test('range text separates HTML table cells but not tags inside one cell', async () => {
    const { legacyVisibleMarkdownTextForRanges } = await import('../src/markdown/markdown-visible-text.js');
    const markdown = '<table><tr><td>Alpha</td><td>Beta <b>bold</b>x</td></tr><tr><td>Gamma</td></tr></table>\n\nAfter.';
    const at = (text, length = text.length) => ({
        from: markdown.indexOf(text),
        to: markdown.indexOf(text) + length,
    });
    const cells = [at('Alpha'), at('Beta')];
    assert.equal(visibleMarkdownTextForRanges(markdown, cells), 'Alpha Beta');
    assert.equal(legacyVisibleMarkdownTextForRanges(markdown, cells), 'AlphaBeta');
    assert.equal(
        visibleMarkdownTextForRanges(markdown, [at('bold'), at('x</td', 1)]),
        'boldx'
    );
    assert.equal(
        visibleMarkdownTextForRanges(markdown, [at('x</td', 1), at('Gamma')]),
        'x Gamma'
    );
});

test('a line break inside one HTML table cell separates its words', () => {
    const markdown = '<table><tr><td>Alpha<br>Beta</td></tr></table>';
    const alpha = markdown.indexOf('Alpha');
    const beta = markdown.indexOf('Beta');

    assert.equal(
        visibleMarkdownTextForRanges(markdown, [
            { from: alpha, to: alpha + 5 },
            { from: beta, to: beta + 4 },
        ]),
        'Alpha Beta'
    );
});

// Dream-RSI: the Markdown parser pairs `_` of two formulas as emphasis.
test('keeps the subscripts of formulas the parser pairs as emphasis', () => {
    const markdown = 'Let $\\mathcal{T}_{t}$ and $C_{t}$ end, $x$ ~~a $y~z$ b~~ *real*.';
    const index = createVisibleMarkdownTextIndex(markdown);

    assert.equal(index.text, 'Let \\mathcal{T}_{t} and C_{t} end, x a y~z b real.');
    assert.equal(
        visibleMarkdownTextForRanges(markdown, [{ from: 0, to: markdown.length }]),
        index.text
    );
    assert.equal(
        createVisibleMarkdownTextIndex('An _emphasised_ and $a_{1}$ word.').text,
        'An emphasised and a_{1} word.'
    );
});

test('keeps a selected subscript whose emphasis pair lies outside the selection', () => {
    const markdown = 'Let $\\mathcal{T}_{t}$ and $C_{t}$ end.';
    const to = markdown.indexOf(' and');

    assert.deepEqual(
        trimDanglingMarkdownMarkRanges(markdown, [{ from: 0, to }]),
        [{ from: 0, to }]
    );
    assert.deepEqual(
        trimDanglingMarkdownMarkRanges('A *bold* word', [{ from: 0, to: 4 }]),
        [{ from: 0, to: 2 }, { from: 3, to: 4 }]
    );
});
