import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorSelection, EditorState } from '@codemirror/state';
import {
    readerPointerSelectionStyle,
    resolvePointerSelectionPoint,
    selectionFromPointer,
} from '../src/editor/reader-selection-style.js';

const WRAPPED = { from: 10, to: 80 };
const NEXT = { from: 82, to: 160 };
const LATER = { from: 162, to: 240 };

function textNode(pos, content = 'for the duration') {
    return {
        nodeType: 3,
        textContent: content,
        pos,
        parentElement: null,
    };
}

function viewWith({ coordinatePos, lines = [WRAPPED, NEXT, LATER] } = {}) {
    return {
        dom: {
            contains(node) {
                return Boolean(node) && node.inEditor !== false;
            },
        },
        state: {
            doc: { length: 400 },
            selection: EditorSelection.single(0),
        },
        posAndSideAtCoords() {
            return { pos: coordinatePos, assoc: -1 };
        },
        lineBlockAt(pos) {
            return lines.find(line => pos >= line.from && pos <= line.to) || null;
        },
        posAtDOM(node) {
            if (!Number.isSafeInteger(node?.pos)) {
                throw new Error('unmapped node');
            }
            return node.pos;
        },
    };
}

function pointerEvent(node, offset, extras = {}) {
    return {
        button: 0,
        detail: 1,
        clientX: 420,
        clientY: 840,
        rangeParent: node,
        rangeOffset: offset,
        ...extras,
    };
}

test('uses the hit text when the height map points at the next paragraph', () => {
    const wrapped = textNode(48);
    const view = viewWith({ coordinatePos: 90 });
    const point = resolvePointerSelectionPoint(view, pointerEvent(wrapped, 4));

    assert.equal(point.pos, 48);
    assert.notEqual(point.pos, 90);
});

test('keeps the coordinate side when it already names the hit line', () => {
    const wrapped = textNode(48);
    const view = viewWith({ coordinatePos: 52 });
    const point = resolvePointerSelectionPoint(view, pointerEvent(wrapped, 4));

    assert.equal(point.pos, 52);
    assert.equal(point.assoc, -1);
});

test('a drag across a wrapped line includes the text under the pointer', () => {
    const startText = textNode(48);
    const endText = textNode(130);
    const view = viewWith({ coordinatePos: 200 });
    const style = readerPointerSelectionStyle(
        view,
        pointerEvent(startText, 4)
    );
    const selection = style.get(pointerEvent(endText, 2), false, false);

    assert.equal(selection.main.anchor, 48);
    assert.equal(selection.main.head, 130);
    assert.equal(selection.main.from, 48);
    assert.equal(selection.main.to, 130);
});

test('a backward drag keeps the press as the anchor', () => {
    const startText = textNode(130);
    const endText = textNode(48);
    const view = viewWith({ coordinatePos: 200 });
    const style = readerPointerSelectionStyle(
        view,
        pointerEvent(startText, 1)
    );
    const selection = style.get(pointerEvent(endText, 4), false, false);

    assert.equal(selection.main.anchor, 130);
    assert.equal(selection.main.head, 48);
});

test('shift-drag extends the existing selection instead of restarting it', () => {
    const view = viewWith({ coordinatePos: 200 });
    view.state.selection = EditorSelection.single(12, 20);
    const style = readerPointerSelectionStyle(
        view,
        pointerEvent(textNode(48), 1)
    );
    const selection = style.get(pointerEvent(textNode(130), 1), true, false);

    assert.equal(selection.main.anchor, 12);
    assert.equal(selection.main.head, 130);
});

test('clamps a blank-line pointer to the line under it when coordinates overshoot', () => {
    const dom = new JSDOM(
        '<div id="editor"><div class="cm-line">For the underlying analysis</div><div class="cm-line"><br></div><div class="cm-line">The wrist-worn medical device</div></div>'
    );
    const editor = dom.window.document.querySelector('#editor');
    const blankLine = editor.querySelectorAll('.cm-line')[1];
    const view = viewWith({ coordinatePos: 200 });
    view.dom = editor;
    view.dom.getRootNode = () => ({
        elementFromPoint() {
            return blankLine;
        },
    });
    const firstLineStart = 40;
    const blankLineStart = 68;
    const thirdLineStart = 70;
    view.posAtDOM = (node, offset) => {
        if (node === blankLine && offset === 0) return blankLineStart;
        if (node === blankLine && offset === blankLine.childNodes.length) return blankLineStart;
        throw new Error('unmapped node');
    };
    view.lineBlockAt = (pos) => {
        if (pos >= firstLineStart && pos < blankLineStart) return { from: firstLineStart, to: blankLineStart - 1 };
        if (pos >= blankLineStart && pos < thirdLineStart) return { from: blankLineStart, to: blankLineStart };
        if (pos >= thirdLineStart && pos <= 200) return { from: thirdLineStart, to: 200 };
        return null;
    };
    const point = resolvePointerSelectionPoint(
        view,
        pointerEvent(null, 0, { clientX: 486, clientY: 582 })
    );

    assert.equal(point.pos, 68);
    assert.notEqual(point.pos, 200);
});

// A pointer on an element of a non-empty line whose coordinate maps into
// another line, with no caret hit.
function elementOnLineFixture() {
    const dom = new JSDOM(
        '<div id="content"><div class="cm-line">before '
        + '<span class="mark"><b>inline</b></span>'
        + ' after</div><div class="cm-line">Next line</div></div>'
    );
    const content = dom.window.document.querySelector('#content');
    const line = content.firstChild;
    const mark = line.childNodes[1];
    const inner = mark.firstChild;
    mark.getBoundingClientRect = () => ({
        top: 0, bottom: 20, left: 100, right: 200, width: 100, height: 20,
    });
    line.getBoundingClientRect = () => ({
        top: 0, bottom: 20, left: 0, right: 600, width: 600, height: 20,
    });
    const view = viewWith({ coordinatePos: 200 });
    view.dom = content;
    view.contentDOM = content;
    let hitElement = inner;
    content.getRootNode = () => ({ elementFromPoint: () => hitElement });
    view.posAtDOM = (node, offset) => {
        if (node === line && offset === 0) return 10;
        if (node === line && offset === 1) return 17;
        if (node === line && offset === 2) return 23;
        if (node === line && offset === line.childNodes.length) return 29;
        throw new Error('unmapped node');
    };
    view.lineBlockAt = pos => (
        pos >= 10 && pos <= 29 ? { from: 10, to: 29 } : { from: 30, to: 200 }
    );
    return {
        view,
        line,
        setHit(element) {
            hitElement = element;
        },
    };
}

test('a pointer on the left half of an element on another line maps before it', () => {
    const { view } = elementOnLineFixture();
    const point = resolvePointerSelectionPoint(
        view,
        pointerEvent(null, 0, { clientX: 120, clientY: 10 })
    );

    assert.equal(point.pos, 17);
});

test('a pointer on the right half of an element on another line maps after it', () => {
    const { view } = elementOnLineFixture();
    const point = resolvePointerSelectionPoint(
        view,
        pointerEvent(null, 0, { clientX: 180, clientY: 10 })
    );

    assert.equal(point.pos, 23);
});

test('a pointer on line padding falls back to the nearer line end', () => {
    const { view, line, setHit } = elementOnLineFixture();
    setHit(line);
    const left = resolvePointerSelectionPoint(
        view,
        pointerEvent(null, 0, { clientX: 5, clientY: 10 })
    );
    const right = resolvePointerSelectionPoint(
        view,
        pointerEvent(null, 0, { clientX: 590, clientY: 10 })
    );

    assert.equal(left.pos, 10);
    assert.equal(right.pos, 29);
});

function blockWidgetFixture() {
    const dom = new JSDOM(
        '<div id="content"><div class="cm-line">Before</div>'
        + '<div class="cm-mktero-rendered cm-mktero-image" contenteditable="false">'
        + '<figure><figcaption>Figure 1. Caption text</figcaption></figure></div>'
        + '<div class="cm-line">After</div></div>'
    );
    const content = dom.window.document.querySelector('#content');
    const widget = content.children[1];
    const captionText = widget.querySelector('figcaption').firstChild;
    widget.getBoundingClientRect = () => ({
        top: 100, bottom: 160, left: 0, right: 600, width: 600, height: 60,
    });
    const view = viewWith({ coordinatePos: 400 });
    view.dom = content;
    view.contentDOM = content;
    view.posAtDOM = node => {
        if (node === widget) return 100;
        throw new Error('unmapped node');
    };
    view.lineBlockAt = pos => (
        pos >= 100 && pos <= 140 ? { from: 100, to: 140 } : { from: 141, to: 400 }
    );
    content.getRootNode = () => ({
        caretPositionFromPoint: () => ({ offsetNode: captionText, offset: 3 }),
    });
    return { view };
}

test('snaps a pointer in the upper half of a block widget to its start', () => {
    const { view } = blockWidgetFixture();
    const point = resolvePointerSelectionPoint(
        view,
        pointerEvent(null, 0, { clientX: 200, clientY: 120 })
    );

    assert.equal(point.pos, 100);
});

test('snaps a pointer in the lower half of a block widget to its end', () => {
    const { view } = blockWidgetFixture();
    const point = resolvePointerSelectionPoint(
        view,
        pointerEvent(null, 0, { clientX: 200, clientY: 150 })
    );

    assert.equal(point.pos, 140);
    assert.notEqual(point.pos, 400);
});

test('snaps a pointer over inline math to the nearer side', () => {
    const dom = new JSDOM(
        '<div id="content"><div class="cm-line">first '
        + '<span class="cm-mktero-rendered cm-mktero-math" contenteditable="false">x2</span>'
        + ' last</div></div>'
    );
    const content = dom.window.document.querySelector('#content');
    const line = content.firstChild;
    const math = line.querySelector('span');
    math.getBoundingClientRect = () => ({
        top: 0, bottom: 20, left: 300, right: 340, width: 40, height: 20,
    });
    const view = viewWith({ coordinatePos: 52 });
    view.dom = content;
    view.contentDOM = content;
    view.posAtDOM = (node, offset) => {
        if (node === math) return 50;
        if (node === line && offset === 2) return 57;
        throw new Error('unmapped node');
    };
    content.getRootNode = () => ({
        caretPositionFromPoint: () => ({ offsetNode: math.firstChild, offset: 1 }),
    });

    const before = resolvePointerSelectionPoint(
        view,
        pointerEvent(null, 0, { clientX: 310, clientY: 10 })
    );
    const after = resolvePointerSelectionPoint(
        view,
        pointerEvent(null, 0, { clientX: 335, clientY: 10 })
    );

    assert.equal(before.pos, 50);
    assert.equal(after.pos, 57);
});

test('tries the next root when one answers with a node outside the content', () => {
    const outside = textNode(999);
    outside.inEditor = false;
    const inside = textNode(130);
    const view = viewWith({ coordinatePos: 200 });
    const shadowRoot = {
        caretPositionFromPoint: () => ({ offsetNode: outside, offset: 0 }),
    };
    const documentRoot = {
        caretPositionFromPoint: () => ({ offsetNode: inside, offset: 2 }),
    };
    view.dom.getRootNode = () => shadowRoot;
    view.dom.ownerDocument = documentRoot;

    const point = resolvePointerSelectionPoint(
        view,
        pointerEvent(null, 0)
    );

    assert.equal(point.pos, 130);
});

test('ignores a rangeParent that is no longer under the pointer', () => {
    const stale = textNode(48);
    stale.ownerDocument = {
        createRange: () => ({
            selectNodeContents() {},
            getClientRects: () => [{ top: 0, bottom: 20, left: 0, right: 400 }],
        }),
    };
    const view = viewWith({ coordinatePos: 200 });

    const point = resolvePointerSelectionPoint(
        view,
        pointerEvent(stale, 4, { clientY: 840 })
    );

    assert.equal(point.pos, 200);
});

test('maps a caret on a blank line element to that line', () => {
    const dom = new JSDOM(
        '<div id="content"><div class="cm-line">Above</div>'
        + '<div class="cm-line"><br></div><div class="cm-line">Below</div></div>'
    );
    const content = dom.window.document.querySelector('#content');
    const blank = content.children[1];
    const view = viewWith({ coordinatePos: 200 });
    view.dom = content;
    view.contentDOM = content;
    view.posAtDOM = node => {
        if (node === blank) return 68;
        throw new Error('unmapped node');
    };
    view.lineBlockAt = pos => (
        pos === 68 ? { from: 68, to: 68 } : { from: 70, to: 200 }
    );
    content.getRootNode = () => ({
        caretPositionFromPoint: () => ({ offsetNode: blank, offset: 0 }),
    });

    const point = resolvePointerSelectionPoint(view, pointerEvent(null, 0));

    assert.equal(point.pos, 68);
});

test('a moved pointer follows caretPositionFromPoint, not a stale rangeParent', () => {
    const stale = textNode(48);
    const current = textNode(130);
    const view = viewWith({ coordinatePos: 200 });
    view.dom.getRootNode = () => ({
        caretPositionFromPoint() {
            return { offsetNode: current, offset: 2 };
        },
    });
    const point = resolvePointerSelectionPoint(view, pointerEvent(stale, 4));

    assert.equal(point.pos, 130);
});

// A real document under a view whose height map is wrong: every coordinate
// lands at the end of the document, while the hit text names `pos`.
function documentView(text) {
    const state = EditorState.create({ doc: text });
    return {
        dom: { contains: node => Boolean(node) && node.inEditor !== false },
        state,
        posAndSideAtCoords: () => ({ pos: state.doc.length, assoc: -1 }),
        lineBlockAt(pos) {
            const line = state.doc.lineAt(pos);
            return { from: line.from, to: line.to };
        },
        posAtDOM(node) {
            if (!Number.isSafeInteger(node?.pos)) throw new Error('unmapped node');
            return node.pos;
        },
    };
}

const WORDS = 'alpha beta gamma\ndelta epsilon\nzeta';

test('a double-click selects the word under the hit text, not the height-map word', () => {
    const view = documentView(WORDS);
    const style = readerPointerSelectionStyle(view, pointerEvent(
        textNode(8),
        0,
        { detail: 2 }
    ));
    const selection = style.get(pointerEvent(textNode(8), 0, { detail: 2 }), false, false);

    assert.equal(selection.main.from, 6);
    assert.equal(selection.main.to, 10);
});

test('a double-click on the space between words selects that run', () => {
    const view = documentView('alpha  beta\nlast');
    const style = readerPointerSelectionStyle(view, pointerEvent(
        textNode(6),
        0,
        { detail: 2 }
    ));
    const selection = style.get(pointerEvent(textNode(6), 0, { detail: 2 }), false, false);

    assert.equal(selection.main.from, 5);
    assert.equal(selection.main.to, 7);
});

test('a triple-click selects the hit line and its line break', () => {
    const view = documentView(WORDS);
    const style = readerPointerSelectionStyle(view, pointerEvent(
        textNode(20),
        0,
        { detail: 3 }
    ));
    const middle = style.get(pointerEvent(textNode(20), 0, { detail: 3 }), false, false);
    const lastStyle = readerPointerSelectionStyle(view, pointerEvent(
        textNode(33),
        0,
        { detail: 3 }
    ));
    const last = lastStyle.get(pointerEvent(textNode(33), 0, { detail: 3 }), false, false);

    assert.equal(middle.main.from, 17);
    assert.equal(middle.main.to, 31);
    assert.equal(last.main.from, 31);
    assert.equal(last.main.to, 35);
});

test('dragging after a double-click extends by whole words both ways', () => {
    const view = documentView(WORDS);
    const style = readerPointerSelectionStyle(view, pointerEvent(
        textNode(8),
        0,
        { detail: 2 }
    ));
    const forward = style.get(pointerEvent(textNode(20), 0, { detail: 2 }), false, false);
    const backward = style.get(pointerEvent(textNode(2), 0, { detail: 2 }), false, false);

    assert.equal(forward.main.from, 6);
    assert.equal(forward.main.to, 22);
    assert.equal(forward.main.head, 22);
    assert.equal(backward.main.from, 0);
    assert.equal(backward.main.to, 10);
    assert.equal(backward.main.head, 0);
});

test('dragging after a triple-click extends by whole lines', () => {
    const view = documentView(WORDS);
    const style = readerPointerSelectionStyle(view, pointerEvent(
        textNode(2),
        0,
        { detail: 3 }
    ));
    const selection = style.get(pointerEvent(textNode(20), 0, { detail: 3 }), false, false);

    assert.equal(selection.main.from, 0);
    assert.equal(selection.main.to, 31);
});

test('shift with a double-click extends the selection to the hit word', () => {
    const view = documentView(WORDS);
    view.state = view.state.update({ selection: { anchor: 1 } }).state;
    const style = readerPointerSelectionStyle(view, pointerEvent(
        textNode(20),
        0,
        { detail: 2, shiftKey: true }
    ));
    const selection = style.get(pointerEvent(textNode(20), 0, { detail: 2 }), true, false);

    assert.equal(selection.main.anchor, 1);
    assert.equal(selection.main.head, 22);
});

test('a double-click keeps its word through a document change', () => {
    const view = documentView(WORDS);
    const style = readerPointerSelectionStyle(view, pointerEvent(
        textNode(8),
        0,
        { detail: 2 }
    ));
    const changed = view.state.update({ changes: { from: 0, insert: 'xx ' } });
    view.state = changed.state;
    style.update({ docChanged: true, changes: changed.changes });
    const selection = style.get(pointerEvent(textNode(11), 0, { detail: 2 }), false, false);

    assert.equal(selection.main.from, 9);
    assert.equal(selection.main.to, 13);
});

test('maps the press through a document change before the next move', () => {
    const view = viewWith({ coordinatePos: 200 });
    const style = readerPointerSelectionStyle(
        view,
        pointerEvent(textNode(48), 1)
    );
    style.update({
        docChanged: true,
        changes: { mapPos: pos => pos + 5 },
    });
    view.state.selection = EditorSelection.single(0);
    const selection = style.get(pointerEvent(textNode(130), 1), false, false);

    assert.equal(selection.main.anchor, 53);
    assert.equal(selection.main.head, 130);
});

test('extends a selection without requiring an EditorSelection instance', () => {
    const selection = selectionFromPointer({
        startPos: 4,
        startSel: null,
        head: 9,
    });

    assert.equal(selection.main.from, 4);
    assert.equal(selection.main.to, 9);
});
