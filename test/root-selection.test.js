import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { rootSelection, rootSelectionFor } from '../src/editor/root-selection.js';

function createReader() {
    const dom = new JSDOM('<!doctype html><p id="outside">Outside text</p><div id="host"></div>');
    const { document } = dom.window;
    const host = document.getElementById('host');
    const root = host.attachShadow({ mode: 'open' });
    const line = document.createElement('div');
    line.textContent = 'Reader selection text';
    root.appendChild(line);
    return { dom, document, host, root, text: line.firstChild };
}

function fakeSelection({ anchorNode, anchorOffset = 0, focusNode = anchorNode, focusOffset = 4, text = 'Read', extra = {} }) {
    return {
        anchorNode,
        anchorOffset,
        focusNode,
        focusOffset,
        isCollapsed: false,
        rangeCount: 1,
        getRangeAt: () => ({ startContainer: anchorNode, endContainer: focusNode }),
        toString: () => text,
        removeAllRanges() {
            this.removed = true;
        },
        setBaseAndExtent(...args) {
            this.extent = args;
        },
        ...extra,
    };
}

test('keeps a Gecko selection that already reports shadow-tree nodes', () => {
    const { document, root, text } = createReader();
    const selection = fakeSelection({ anchorNode: text });
    document.getSelection = () => selection;
    root.getSelection = () => assert.fail('the shadow root must not be asked');
    assert.equal(rootSelection(root), selection);
    assert.equal(rootSelectionFor(text), selection);
});

test('uses the shadow root selection when Blink retargets to the host', () => {
    const { document, host, root, text } = createReader();
    document.getSelection = () => fakeSelection({ anchorNode: host, focusNode: host });
    const inner = fakeSelection({ anchorNode: text });
    root.getSelection = () => inner;
    assert.equal(rootSelectionFor(text), inner);
});

test('rebuilds the selection from composed ranges when WebKit retargets to the host', () => {
    const { document, host, root, text } = createReader();
    let requestedRoots = null;
    const outer = fakeSelection({
        anchorNode: host,
        focusNode: host,
        text: 'Reader',
        extra: {
            // WebKit maps both ends to the host and calls the selection collapsed.
            isCollapsed: true,
            getComposedRanges(options) {
                requestedRoots = options.shadowRoots;
                return [{ startContainer: text, startOffset: 0, endContainer: text, endOffset: 6 }];
            },
        },
    });
    document.getSelection = () => outer;
    const selection = rootSelectionFor(text);
    assert.notEqual(selection, outer);
    assert.deepEqual(requestedRoots, [root]);
    assert.equal(selection.anchorNode, text);
    assert.equal(selection.isCollapsed, false);
    assert.equal(selection.focusOffset, 6);
    assert.equal(selection.rangeCount, 1);
    assert.equal(selection.getRangeAt(0).startContainer, text);
    assert.equal(selection.getRangeAt(0).toString(), 'Reader');
    assert.equal(selection.toString(), 'Reader');
    assert.throws(() => selection.getRangeAt(1), RangeError);
    selection.removeAllRanges();
    assert.equal(outer.removed, true);
    selection.setBaseAndExtent(text, 0, text, 3);
    assert.deepEqual(outer.extent, [text, 0, text, 3]);
});

test('accepts the positional composed-ranges form from Safari 17', () => {
    const { document, host, root, text } = createReader();
    document.getSelection = () => fakeSelection({
        anchorNode: host,
        extra: {
            getComposedRanges(argument) {
                if (argument !== root) throw new TypeError('expected a shadow root');
                return [{ startContainer: text, startOffset: 7, endContainer: text, endOffset: 16 }];
            },
        },
    });
    assert.equal(rootSelectionFor(text).getRangeAt(0).toString(), 'selection');
});

test('falls back to the document selection when the selection is outside the reader', () => {
    const { document, host, root, text } = createReader();
    const outsideText = document.getElementById('outside').firstChild;
    const outer = fakeSelection({
        anchorNode: outsideText,
        extra: {
            getComposedRanges: () => [{
                startContainer: outsideText,
                startOffset: 0,
                endContainer: outsideText,
                endOffset: 7,
            }],
        },
    });
    document.getSelection = () => outer;
    root.getSelection = () => fakeSelection({ anchorNode: host });
    assert.equal(rootSelectionFor(text), outer);
});

test('returns the document selection for nodes outside any shadow root', () => {
    const { document } = createReader();
    const outsideText = document.getElementById('outside').firstChild;
    const outer = fakeSelection({ anchorNode: outsideText });
    document.getSelection = () => outer;
    assert.equal(rootSelectionFor(outsideText), outer);
    assert.equal(rootSelection(null), null);
});
