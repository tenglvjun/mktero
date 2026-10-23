import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPageNote, markerKeys, NOTE_KIND, noteMarker, placePageNotes, restoreDiscardedReferences } from '../src/mineru/document/notes.js';
import { DOCUMENT_IR_SCHEMA } from '../src/mineru/document/ir.js';

function note(pageIndex, spans, id = `n${pageIndex}`) {
    const bbox = [100, 900, 900, 930];
    return {
        id, kind: 'discarded', mineruType: 'page_footnote', role: 'page-note', pageIndex, bbox,
        fragments: [{ pageIndex, bbox, lines: [{ bbox, spans: [].concat(spans).map(span => (
            typeof span === 'string' ? { type: 'text', content: span } : span
        )) }] }],
        children: [], mergedFrom: [], absorbed: [],
    };
}

function body(id, pageIndex, spans, { kind = 'text', role = 'body', pages = [pageIndex] } = {}) {
    const bbox = [100, 100, 900, 300];
    return {
        id, kind, mineruType: kind, role, pageIndex, bbox,
        fragments: pages.map(page => ({ pageIndex: page, bbox, lines: [{ bbox, spans: [].concat(spans).map(span => (
            typeof span === 'string' ? { type: 'text', content: span } : span
        )) }] })),
        children: [], mergedFrom: [], absorbed: [],
    };
}

const math = content => ({ type: 'math', content });
const kindOf = (pageIndex, spans) => {
    const block = note(pageIndex, spans);
    classifyPageNote(block);
    return block.noteKind;
};

test('sorts page footnotes into metadata, notes, and decoration', () => {
    assert.equal(kindOf(0, [math('^{1}'), 'Department of Medicine, University of Somewhere, City']), NOTE_KIND.FRONT_MATTER);
    assert.equal(kindOf(0, '* These authors contributed equally to this work.'), NOTE_KIND.FRONT_MATTER);
    assert.equal(kindOf(0, 'This work was supported by the National Science Foundation.'), NOTE_KIND.FRONT_MATTER);
    assert.equal(kindOf(0, 'Corresponding author(s): someone@example.org © 2026 Company.'), NOTE_KIND.FRONT_MATTER);
    assert.equal(kindOf(0, 'Version of Record published: 14 June 2023'), NOTE_KIND.FRONT_MATTER);
    assert.equal(kindOf(0, '© 2024 The Author(s). Published by Elsevier Ltd. Licensed under CC BY.'), NOTE_KIND.CHROME);
    assert.equal(kindOf(1, 'Journal VOLUME 29, ISSUE 4. ISSN 0730-7829. © 2012 BY THE REGENTS'), NOTE_KIND.CHROME);
    assert.equal(kindOf(0, [math('^{1}'), 'Quoted in a newsletter, https://example.org/loop.']), NOTE_KIND.CONTENT);
    assert.equal(kindOf(1, [math('^{1}'), 'Versions are available from the authors: a@example.edu']), NOTE_KIND.CONTENT);
    assert.equal(kindOf(6, '"I feel more relaxed, and my mind is more relaxed (P2)".'), NOTE_KIND.CONTENT);
    assert.equal(kindOf(3, ''), NOTE_KIND.CHROME);
});

test('reads the mark a footnote opens with', () => {
    assert.equal(noteMarker(note(1, [math('^{\\dagger\\dagger}'), 'Source: a table.'])), '††');
    assert.equal(noteMarker(note(1, [math('^{12}'), 'A note.'])), '12');
    assert.equal(noteMarker(note(1, '* Work done elsewhere.')), '*');
    assert.equal(noteMarker(note(1, '² A note.')), '2');
    assert.equal(noteMarker(note(1, 'A note without a mark.')), null);
    assert.equal(noteMarker(note(1, [math('^{1,3}'), 'Two marks.'])), null);
    assert.deepEqual(markerKeys('1, 3'), ['1', '3']);
    assert.deepEqual(markerKeys('\\ddagger'), ['‡']);
});

function place(blocks) {
    for (const block of blocks) if (block.role === 'page-note') classifyPageNote(block);
    return placePageNotes({ schema: DOCUMENT_IR_SCHEMA, pages: [], blocks, diagnostics: {} });
}

test('places a note after the first paragraph of its page that cites it', () => {
    const ir = place([
        body('a', 2, 'An earlier paragraph.'),
        body('b', 2, ['A claim', math('^{2}'), 'that needs a note.']),
        body('c', 2, 'A later paragraph.'),
        note(2, [math('^{2}'), 'The note text.']),
    ]);
    assert.deepEqual(ir.blocks.map(block => block.id), ['a', 'b', 'n2', 'c']);
    assert.deepEqual(ir.diagnostics.notePlacements, [{ id: 'n2', pageIndex: 2, rule: 'marker', anchor: 'b' }]);
});

test('finds the citing paragraph continued from the previous page', () => {
    const ir = place([
        body('a', 7, ['A claim', math('^{2}'), 'that runs on'], { pages: [7, 8] }),
        body('b', 8, 'Text of the next page.'),
        note(8, [math('^{2}'), 'The note text.']),
    ]);
    assert.deepEqual(ir.blocks.map(block => block.id), ['a', 'n8', 'b']);
});

test('closes the page section when the mark is not found, never past a heading or the page', () => {
    const ir = place([
        body('a', 4, 'First paragraph.'),
        body('b', 4, 'Last paragraph of the page.'),
        { ...body('h', 5, 'Next Section'), kind: 'title', role: 'heading' },
        body('c', 5, 'Next page.'),
        note(4, '"A quoted remark without a mark".'),
    ]);
    assert.deepEqual(ir.blocks.map(block => block.id), ['a', 'b', 'n4', 'h', 'c']);
    assert.equal(ir.diagnostics.notePlacements[0].rule, 'section-end');
});

test('follows the last float of a page without paragraphs', () => {
    const table = { ...body('t', 28, ''), kind: 'table', role: 'float' };
    const ir = place([body('a', 27, 'A paragraph', { pages: [27] }), table, body('b', 29, 'Later.'), note(28, [math('^{\\dagger}'), 'Source.'])]);
    assert.deepEqual(ir.blocks.map(block => block.id), ['a', 't', 'n28', 'b']);
    assert.equal(ir.diagnostics.notePlacements[0].rule, 'float');
});

test('restores a discarded author-year reference inside the references section', () => {
    const entry = note(16, 'Bolocon, H., Cabili, J., and Yee, C. G. (2025). The effects of music. Journal 3, 1-9.');
    classifyPageNote(entry);
    assert.equal(entry.referenceCandidate, true);
    const ir = restoreDiscardedReferences({
        blocks: [
            { ...body('h', 16, 'References'), kind: 'title', role: 'heading', referenceHeading: true },
            body('r', 16, 'Bleibel, M. (2023). A title.', { kind: 'text', role: 'reference' }),
            entry,
        ],
        diagnostics: {},
    });
    assert.equal(ir.blocks[2].kind, 'reference');
    assert.equal(ir.blocks[2].role, 'reference');
});

test('keeps an author-year footnote outside any references section a note', () => {
    const entry = note(3, 'Smith, J., and Doe, A. (2020). Cited in a footnote.');
    classifyPageNote(entry);
    const ir = restoreDiscardedReferences({ blocks: [body('a', 3, 'Text.'), entry], diagnostics: {} });
    assert.equal(ir.blocks[1].role, 'page-note');
});
