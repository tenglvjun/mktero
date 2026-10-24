import test from 'node:test';
import assert from 'node:assert/strict';
import {
    findMarkdownDirectives,
    markdownSectionRanges,
    noteDirective,
    parseMarkdownDirective,
    SECTION_CLOSE_DIRECTIVE,
    sectionOpenDirective,
} from '../src/markdown/markdown-directives.js';

test('parses only allowlisted directive comments', () => {
    assert.deepEqual(parseMarkdownDirective('<!-- mktero-note: footnote -->'), { type: 'note', kind: 'footnote' });
    assert.deepEqual(parseMarkdownDirective('<!--mktero-section:article-info-->'), { type: 'section-open', kind: 'article-info' });
    assert.deepEqual(parseMarkdownDirective('<!-- /mktero-section -->'), { type: 'section-close' });
    assert.equal(parseMarkdownDirective('<!-- mktero-note: script -->'), null);
    assert.equal(parseMarkdownDirective('<!-- mktero-section: anything -->'), null);
    assert.equal(parseMarkdownDirective('<!-- mktero-figure-layout: columns=2 rows=2 -->'), null);
    assert.throws(() => noteDirective('evil'), TypeError);
    assert.throws(() => sectionOpenDirective('evil'), TypeError);
});

test('finds notes before blockquotes and paired sections', () => {
    const markdown = [
        '# Title',
        sectionOpenDirective('article-info'),
        'Affiliation one.',
        '## Inner heading',
        SECTION_CLOSE_DIRECTIVE,
        'Body text.',
        `${noteDirective('footnote')}\n> ¹ A note.`,
        noteDirective('table'),
        'Not a quote.',
    ].join('\n\n');
    const { notes, sections } = findMarkdownDirectives(markdown);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].kind, 'footnote');
    assert.equal(markdown.slice(notes[0].quote.from, notes[0].quote.to), '> ¹ A note.');
    assert.equal(sections.length, 1);
    assert.equal(sections[0].kind, 'article-info');
    assert.match(markdown.slice(sections[0].content.from, sections[0].content.to), /Affiliation one\.[\s\S]*Inner heading/u);
    assert.deepEqual(markdownSectionRanges(markdown), [{ from: sections[0].from, to: sections[0].to }]);
});

test('ignores directive text inside code, paragraphs, and unpaired or nested sections', () => {
    const markdown = [
        '```\n<!-- mktero-section: article-info -->\n```',
        'Text <!-- mktero-note: footnote --> inline.',
        sectionOpenDirective('article-info'),
        sectionOpenDirective('reporting-summary'),
        'Content.',
        SECTION_CLOSE_DIRECTIVE,
        sectionOpenDirective('author-biographies'),
        'Never closed.',
    ].join('\n\n');
    const { notes, sections } = findMarkdownDirectives(markdown);
    assert.equal(notes.length, 0);
    assert.equal(sections.length, 0);
});
