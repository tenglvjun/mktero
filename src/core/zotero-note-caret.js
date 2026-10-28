// Where the caret goes after Mktero inserts HTML into a Zotero note.
//
// The note editor's `insertHTML` with `pos: null` places the caret at fixed
// offsets from the block it inserted into. Zotero's default annotation
// template, `<p><span class="highlight">“…”</span> <span class="citation">…
// </span></p>`, does not fit those offsets: inserted into an empty line, the
// caret lands inside the highlight, before its closing quotation mark. Mktero
// reads the note's document before and after the insert and puts the caret
// where the inserted content ends:
//
// - after the last character of the last line it inserted, after the
//   citation for a highlight;
// - on a new line below a block that holds no caret line of its own, such as
//   a display formula, a code block, a table, or a rule. An empty line that
//   already follows the block is used; otherwise one is added.
//
// The documents are ProseMirror nodes of the note editor's schema. Only
// their structure is read here; `zotero-notes.js` applies the result.

/**
 * The caret after an insert that turned `before` into `after`: `{ type:
 * 'text', pos }` for a caret at `pos`, `{ type: 'line', pos, insert }` for a
 * caret on a line after a block, which is an empty line at `pos` when
 * `insert` is false and a new one inserted at `pos` otherwise, or null when
 * the two documents show no insert.
 */
export function noteCaretAfterInsert(before, after) {
    const inserted = insertedTopLevelRange(before, after);
    if (!inserted) return null;
    const last = inserted.endIndex - 1;
    const node = after.child(last);
    const from = topLevelOffset(after, last);
    const text = lastCaretLineEnd(node, from);
    if (text !== null) return { type: 'text', pos: text };
    const end = from + node.nodeSize;
    const next = inserted.endIndex < after.childCount
        ? after.child(inserted.endIndex)
        : null;
    if (next && isEmptyCaretLine(next)) {
        return { type: 'line', pos: end + 1, insert: false };
    }
    return { type: 'line', pos: end, insert: true };
}

/**
 * The top-level children of `after` the insert added or replaced, as `{
 * startIndex, endIndex }`, or null when nothing changed. The children the
 * insert kept are the same nodes in both documents, so they are matched by
 * identity from either end.
 */
export function insertedTopLevelRange(before, after) {
    if (!isDocument(before) || !isDocument(after) || before === after) return null;
    const beforeCount = before.childCount;
    const afterCount = after.childCount;
    let prefix = 0;
    while (prefix < beforeCount
        && prefix < afterCount
        && before.child(prefix) === after.child(prefix)) {
        prefix++;
    }
    let suffix = 0;
    while (suffix < beforeCount - prefix
        && suffix < afterCount - prefix
        && before.child(beforeCount - 1 - suffix)
            === after.child(afterCount - 1 - suffix)) {
        suffix++;
    }
    const endIndex = afterCount - suffix;
    return endIndex > prefix ? { startIndex: prefix, endIndex } : null;
}

// The position at the end of the last line in `node` a caret can stand on,
// when `node` starts at `from`, or null when its last block holds none.
function lastCaretLineEnd(node, from) {
    if (isCaretLine(node)) return from + node.nodeSize - 1;
    if (!isCaretContainer(node) || !node.childCount) return null;
    const last = node.childCount - 1;
    return lastCaretLineEnd(node.child(last), from + 1 + childOffset(node, last));
}

// A line the caret is typed on: a paragraph or a heading. A display formula
// and a code block hold text, but as one block the caret leaves.
function isCaretLine(node) {
    return Boolean(node?.isTextblock
        && !node.type?.spec?.code
        && !node.type?.spec?.atom);
}

// A block whose last line is the caret's: a quote or a list. A table keeps
// its caret in its cells, so the caret goes on a line after it.
function isCaretContainer(node) {
    return Boolean(node
        && !node.isLeaf
        && !node.isTextblock
        && !node.isAtom
        && !node.type?.spec?.tableRole);
}

function isEmptyCaretLine(node) {
    return isCaretLine(node) && node.content?.size === 0;
}

function topLevelOffset(doc, index) {
    return childOffset(doc, index);
}

function childOffset(node, index) {
    let offset = 0;
    for (let child = 0; child < index; child++) {
        offset += node.child(child).nodeSize;
    }
    return offset;
}

function isDocument(node) {
    return Boolean(node
        && Number.isInteger(node.childCount)
        && typeof node.child === 'function');
}
