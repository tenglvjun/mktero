import test from 'node:test';
import assert from 'node:assert/strict';
import {
    insertedTopLevelRange,
    noteCaretAfterInsert,
} from '../src/core/zotero-note-caret.js';

// ProseMirror nodes as far as the caret reads them: sizes, children, and the
// flags of the note editor's schema.
const TYPES = {
    doc: {},
    paragraph: { textblock: true },
    heading: { textblock: true },
    math_display: { textblock: true, spec: { atom: true, code: true } },
    codeBlock: { textblock: true, spec: { code: true } },
    blockquote: {},
    bulletList: {},
    listItem: {},
    table: { spec: { tableRole: 'table' } },
    table_row: { spec: { tableRole: 'row' } },
    table_cell: { spec: { tableRole: 'cell' } },
    horizontalRule: { leaf: true },
    highlight: { inline: true },
    citation: { inline: true, leaf: true, atom: true },
};

function text(value) {
    return { isText: true, isLeaf: true, nodeSize: value.length, type: { name: 'text', spec: {} } };
}

function node(name, children = []) {
    const kind = TYPES[name];
    const content = { size: children.reduce((sum, child) => sum + child.nodeSize, 0) };
    const leaf = Boolean(kind.leaf);
    return {
        type: { name, spec: kind.spec || {} },
        isTextblock: Boolean(kind.textblock),
        isLeaf: leaf,
        isAtom: leaf || Boolean(kind.spec?.atom),
        childCount: children.length,
        child: index => children[index],
        content,
        nodeSize: leaf ? 1 : content.size + 2,
    };
}

function doc(children) {
    const root = node('doc', children);
    return { ...root, nodeSize: root.content.size };
}

// Zotero's default annotation template: “quote” (citation).
function annotationParagraph(quote = '“genetic anchor is”') {
    return node('paragraph', [
        node('highlight', [text(quote)]),
        text(' '),
        node('citation'),
    ]);
}

test('an annotation inserted into an empty line puts the caret after its citation', () => {
    const paragraph = annotationParagraph();
    const caret = noteCaretAfterInsert(
        doc([node('paragraph')]),
        doc([paragraph])
    );

    // Zotero put it four positions earlier, before the closing quotation mark.
    assert.deepEqual(caret, { type: 'text', pos: paragraph.nodeSize - 1 });
});

test('an annotation inserted after a line puts the caret at the end of it', () => {
    const first = node('paragraph', [text('My notes')]);
    const tail = node('paragraph', [text('Later')]);
    const inserted = annotationParagraph();
    const caret = noteCaretAfterInsert(
        doc([first, tail]),
        doc([first, inserted, tail])
    );

    assert.deepEqual(caret, {
        type: 'text',
        pos: first.nodeSize + inserted.nodeSize - 1,
    });
});

test('several annotations put the caret after the last one', () => {
    const empty = node('paragraph');
    const first = annotationParagraph('“one”');
    const second = annotationParagraph('“two”');
    const caret = noteCaretAfterInsert(doc([empty]), doc([first, second]));

    assert.deepEqual(caret, {
        type: 'text',
        pos: first.nodeSize + second.nodeSize - 1,
    });
});

test('a display formula at the end puts the caret on a new line below it', () => {
    const formula = node('math_display', [text('E = mc^2')]);
    const before = doc([node('paragraph')]);
    const caret = noteCaretAfterInsert(before, doc([formula]));

    assert.deepEqual(caret, { type: 'line', pos: formula.nodeSize, insert: true });
});

test('a block at the end uses an empty line that already follows it', () => {
    const intro = node('paragraph', [text('Intro')]);
    const empty = node('paragraph');
    const formula = node('math_display', [text('x')]);
    const caret = noteCaretAfterInsert(
        doc([intro, empty]),
        doc([intro, formula, empty])
    );

    assert.deepEqual(caret, {
        type: 'line',
        pos: intro.nodeSize + formula.nodeSize + 1,
        insert: false,
    });
});

test('a code block, a table, and a rule each get a line after them', () => {
    for (const block of [
        node('codeBlock', [text('let x = 1;')]),
        node('table', [node('table_row', [node('table_cell', [node('paragraph', [text('a')])])])]),
        node('horizontalRule'),
    ]) {
        const caret = noteCaretAfterInsert(doc([node('paragraph')]), doc([block]));
        assert.deepEqual(caret, { type: 'line', pos: block.nodeSize, insert: true }, block.type.name);
    }
});

test('a quote or a list puts the caret at the end of its last line', () => {
    const inner = node('paragraph', [text('Quoted')]);
    const quote = node('blockquote', [node('paragraph', [text('First')]), inner]);
    const quoteCaret = noteCaretAfterInsert(doc([node('paragraph')]), doc([quote]));
    assert.deepEqual(quoteCaret, { type: 'text', pos: quote.nodeSize - 2 });

    const item = node('listItem', [node('paragraph', [text('Item')])]);
    const list = node('bulletList', [item]);
    const listCaret = noteCaretAfterInsert(doc([node('paragraph')]), doc([list]));
    assert.deepEqual(listCaret, { type: 'text', pos: list.nodeSize - 3 });
});

test('a quote that ends in a display formula gets a line after the quote', () => {
    const quote = node('blockquote', [
        node('paragraph', [text('Before')]),
        node('math_display', [text('x')]),
    ]);
    const caret = noteCaretAfterInsert(doc([node('paragraph')]), doc([quote]));

    assert.deepEqual(caret, { type: 'line', pos: quote.nodeSize, insert: true });
});

test('documents that show no insert give no caret', () => {
    const paragraph = node('paragraph', [text('Same')]);
    const same = doc([paragraph]);
    assert.equal(noteCaretAfterInsert(same, same), null);
    // Only a block removed: nothing was inserted.
    assert.equal(
        noteCaretAfterInsert(doc([paragraph, node('paragraph')]), doc([paragraph])),
        null
    );
    assert.equal(noteCaretAfterInsert(null, same), null);
    assert.equal(insertedTopLevelRange(same, {}), null);
});

test('the inserted range keeps the blocks on either side the insert left', () => {
    const first = node('paragraph', [text('a')]);
    const last = node('paragraph', [text('z')]);
    const added = [annotationParagraph('“b”'), annotationParagraph('“c”')];

    assert.deepEqual(
        insertedTopLevelRange(doc([first, last]), doc([first, ...added, last])),
        { startIndex: 1, endIndex: 3 }
    );
});
