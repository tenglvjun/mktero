import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMarkdownFootnotes } from '../src/markdown/markdown-footnotes.js';
import { footnoteMarkKeys } from '../src/markdown/footnote-marks.js';

const note = text => `<!-- mktero-note: footnote -->\n> ${text}`;

function pairs(markdown) {
    return analyzeMarkdownFootnotes(markdown).notes.map(item => ({
        key: item.key,
        mark: markdown.slice(item.mark.from, item.mark.to),
        cited: item.citation ? markdown.slice(item.citation.wrapperFrom, item.citation.wrapperTo) : null,
        citedAt: item.citation?.wrapperFrom ?? null,
    }));
}

test('normalizes footnote marks', () => {
    assert.deepEqual(footnoteMarkKeys('1, 3'), ['1', '3']);
    assert.deepEqual(footnoteMarkKeys('\\dagger\\dagger'), ['††']);
    assert.deepEqual(footnoteMarkKeys('¹²'), ['12']);
    assert.deepEqual(footnoteMarkKeys('x+y'), []);
});

test('pairs a note with the mark of the paragraph before it', () => {
    const markdown = [
        'A claim that needs a source $^{1}$ and more text.',
        note('$^{1}$ The source of the claim.'),
        'Another paragraph.',
    ].join('\n\n');
    assert.deepEqual(pairs(markdown), [{
        key: '1', mark: '$^{1}$', cited: '$^{1}$', citedAt: markdown.indexOf('$^{1}$'),
    }]);
    const [item] = analyzeMarkdownFootnotes(markdown).notes;
    assert.equal(markdown.slice(item.citation.from, item.citation.to), '1');
    assert.equal(markdown.slice(item.quote.from, item.quote.to), '> $^{1}$ The source of the claim.');
});

test('finds the citing mark several paragraphs back, and symbol marks', () => {
    const markdown = [
        '## Results',
        'The Sharpe Ratio $^{†}$ measures return.',
        'Unrelated paragraph with an exponent $x^{2}$.',
        'Plain results† continue.',
        note('$^{†}$ Calculated over the full period.'),
        note('† A printed dagger note.'),
    ].join('\n\n');
    const result = pairs(markdown);
    // The nearest mark cites the note; a later note with the same mark stops
    // at the earlier note instead of taking a mark it already used.
    assert.equal(result[0].cited, '†');
    assert.equal(result[0].citedAt, markdown.indexOf('results†') + 'results'.length);
    assert.equal(result[1].cited, null);
    const separate = [
        'The Sharpe Ratio $^{†}$ measures return.',
        'Unrelated paragraph with an exponent $x^{2}$.',
        note('$^{†}$ Calculated over the full period.'),
    ].join('\n\n');
    assert.equal(pairs(separate)[0].cited, '$^{†}$');
});

test('does not cross a heading, a section, or a note with the same mark', () => {
    const markdown = [
        'Text with a mark $^{1}$.',
        '## Next section',
        'No mark here.',
        note('$^{1}$ Orphan note.'),
        '<!-- mktero-section: article-info -->',
        '$^{2}$ Department of Things, University of Somewhere.',
        '<!-- /mktero-section -->',
        note('$^{2}$ Not the affiliation.'),
        'Second mark $^{3}$ here.',
        note('$^{3}$ First note three.'),
        note('$^{3}$ A repeated note three.'),
    ].join('\n\n');
    const result = pairs(markdown);
    assert.deepEqual(result.map(item => [item.key, item.cited]), [
        ['1', null],
        ['2', null],
        ['3', '$^{3}$'],
        ['3', null],
    ]);
});

test('ignores notes without a mark, other note kinds, and marks in code', () => {
    const markdown = [
        'Inline `$^{1}$` code and a quote.',
        note('A remark without a mark.'),
        '<!-- mktero-note: table -->\n> $^{1}$ A table note.',
        note('$^{1}$ The footnote.'),
    ].join('\n\n');
    assert.deepEqual(pairs(markdown), [{ key: '1', mark: '$^{1}$', cited: null, citedAt: null }]);
});

test('an escaped asterisk opens a note', () => {
    const markdown = ['Equal contribution marked\\* here, with ⁴ too.', note('\\* Work done elsewhere.')].join('\n\n');
    const [item] = analyzeMarkdownFootnotes(markdown).notes;
    assert.equal(item.key, '*');
    assert.equal(markdown.slice(item.mark.from, item.mark.to), '\\*');
    // A plain asterisk is not a citing mark.
    assert.equal(item.citation, null);
});

test('a footnote link shows every mark of a TeX superscript', async () => {
    const { footnoteMarkDisplayText } = await import('../src/markdown/footnote-marks.js');

    assert.equal(footnoteMarkDisplayText('1,\\dagger'), '1,†');
    assert.equal(footnoteMarkDisplayText('a,\\ast'), 'a,*');
    assert.equal(footnoteMarkDisplayText('\\S, \\P'), '§,¶');
    assert.equal(footnoteMarkDisplayText('\\dagger'), '†');
    // A part the link does not know keeps the first mark alone.
    assert.equal(footnoteMarkDisplayText('\\dagger,\\unknown'), '†');
    assert.equal(footnoteMarkDisplayText(''), '');
});
