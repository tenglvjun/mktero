import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { EditorView } from '@codemirror/view';
import { createInlineMarkdownEditor } from '../src/editor/inline-markdown-editor.js';

const MARKDOWN = [
    'Select this text around Figure 1, Table 1, and prior work [1] or [2].',
    '',
    '![Figure 1. Results](images/results.png)',
    '',
    'Table 1. Measurements',
    '',
    '| Model | Score |',
    '| --- | --- |',
    '| Baseline [1] | 1 |',
    '',
    '## References',
    '',
    '[1] First author. First paper. 2024.',
    '[2] Second author. Second paper. 2025.',
].join('\n');
const TYPES = [
    ['figure', '.cm-mktero-figure-reference', '.mktero-figure-preview-popup'],
    ['table', '.cm-mktero-table-reference', '.mktero-table-preview-popup'],
    ['citation', '.cm-line .cm-mktero-citation', '.mktero-citation-popup'],
];

function clockFor(window) {
    const originalSet = window.setTimeout;
    const originalClear = window.clearTimeout;
    const timers = new Map();
    let now = 0;
    let id = -1;
    window.setTimeout = (callback, delay, ...args) => {
        if (delay !== 450 && delay !== 200) {
            return originalSet.call(window, callback, delay, ...args);
        }
        const key = id--;
        timers.set(key, { callback, at: now + delay });
        return key;
    };
    window.clearTimeout = key => {
        if (!timers.delete(key)) originalClear.call(window, key);
    };
    return {
        timers,
        advance(duration) {
            const until = now + duration;
            for (;;) {
                const next = [...timers.entries()]
                    .filter(([, timer]) => timer.at <= until)
                    .sort((a, b) => a[1].at - b[1].at)[0];
                if (!next) break;
                timers.delete(next[0]);
                now = next[1].at;
                next[1].callback();
            }
            now = until;
        },
        restore() {
            window.setTimeout = originalSet;
            window.clearTimeout = originalClear;
        },
    };
}

function mount(t, { shadow = false } = {}) {
    const dom = new JSDOM('<!doctype html><div id="host"></div>', {
        pretendToBeVisual: true,
    });
    const { window } = dom;
    const { document } = window;
    window.Range.prototype.getClientRects = () => [];
    window.Range.prototype.getBoundingClientRect = () => ({
        top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0,
    });
    const root = shadow
        ? document.querySelector('#host').attachShadow({ mode: 'open' })
        : document;
    const parent = document.createElement('div');
    (shadow ? root : document.body).appendChild(parent);
    const editor = createInlineMarkdownEditor({
        parent,
        initialMarkdown: MARKDOWN,
        resolveImageURL: path => `blob:${path}`,
    });
    const view = EditorView.findFromDOM(parent.querySelector('.cm-editor'));
    const extraEditors = [];
    const clock = clockFor(window);
    t.after(() => {
        for (const extra of extraEditors) extra.destroy();
        editor.destroy();
        clock.restore();
        window.close();
    });
    const mouse = (element, type, init = {}) => {
        const event = new window.MouseEvent(type, {
            bubbles: true,
            composed: true,
            cancelable: true,
            clientX: 20,
            clientY: 20,
            ...init,
        });
        element.dispatchEvent(event);
        return event;
    };
    const key = (element, value) => {
        const event = new window.KeyboardEvent('keydown', {
            key: value, bubbles: true, composed: true, cancelable: true,
        });
        element.dispatchEvent(event);
        return event;
    };
    return { window, document, root, parent, editor, view, clock, mouse, key, extraEditors };
}

for (const [name, selector, popupSelector] of TYPES) {
    test(`${name} previews require a stable 450ms hover`, t => {
        const { parent, clock, mouse } = mount(t);
        const reference = parent.querySelector(selector);
        assert.ok(reference);
        mouse(reference, 'mouseover');
        assert.equal(parent.querySelector(popupSelector), null);
        clock.advance(449);
        assert.equal(parent.querySelector(popupSelector), null);
        // Small hand movements do not restart the wait.
        mouse(reference, 'mousemove', { clientX: 23, clientY: 22 });
        clock.advance(1);
        assert.ok(parent.querySelector(popupSelector));
    });

    test(`${name} previews cancel when passing over or pressing to select`, t => {
        const { parent, view, clock, mouse } = mount(t);
        const reference = parent.querySelector(selector);
        mouse(reference, 'mouseover');
        const queued = [...clock.timers.values()][0];
        mouse(reference, 'mouseout', { relatedTarget: parent });
        clock.advance(500);
        queued.callback();
        assert.equal(parent.querySelector(popupSelector), null);
        mouse(reference, 'mouseover');
        mouse(reference, 'mousedown', { buttons: 1, clientX: 0, clientY: 0 });
        assert.ok(view.inputState.mouseSelection, 'CodeMirror owns the text drag');
        mouse(reference, 'mouseover', { buttons: 1 });
        clock.advance(500);
        assert.equal(parent.querySelector(popupSelector), null);
        mouse(reference, 'mouseup');
        clock.advance(500);
        assert.equal(parent.querySelector(popupSelector), null);
    });

    test(`${name} previews stay open across the gap into the popup`, t => {
        const { parent, clock, mouse } = mount(t);
        const reference = parent.querySelector(selector);
        mouse(reference, 'mouseover');
        clock.advance(450);
        const popup = parent.querySelector(popupSelector);
        assert.ok(popup);
        mouse(reference, 'mouseout', { relatedTarget: parent });
        clock.advance(180);
        mouse(popup, 'mouseenter');
        clock.advance(100);
        assert.equal(parent.querySelector(popupSelector), popup);
        mouse(popup, 'mouseleave', { relatedTarget: parent });
        clock.advance(199);
        assert.equal(parent.querySelector(popupSelector), popup);
        clock.advance(1);
        assert.equal(parent.querySelector(popupSelector), null);
    });
}

test('moving within a long reference restarts the stable hover wait', t => {
    const { parent, clock, mouse } = mount(t);
    const citation = parent.querySelector('.cm-mktero-citation');
    mouse(citation, 'mouseover');
    clock.advance(400);
    mouse(citation, 'mousemove', { clientX: 40 });
    clock.advance(449);
    assert.equal(parent.querySelector('.mktero-citation-popup'), null);
    clock.advance(1);
    assert.ok(parent.querySelector('.mktero-citation-popup'));
});

test('switching references starts a new full wait and ignores stale callbacks', t => {
    const { parent, clock, mouse } = mount(t);
    const [first, second] = parent.querySelectorAll('.cm-line .cm-mktero-citation');
    mouse(first, 'mouseover');
    const queued = [...clock.timers.values()][0];
    clock.advance(400);
    mouse(first, 'mouseout', { relatedTarget: second });
    mouse(second, 'mouseover', { relatedTarget: first });
    queued.callback();
    clock.advance(449);
    assert.equal(parent.querySelector('.mktero-citation-popup'), null);
    clock.advance(1);
    assert.match(parent.querySelector('.mktero-citation-popup').textContent, /Second paper/);
});

for (const shadow of [false, true]) {
    test(`DOM and editor selections block preview${shadow ? ' inside a shadow root' : ''}`, t => {
        const { parent, document, root, view, clock, mouse } = mount(t, { shadow });
        const reference = parent.querySelector('.cm-mktero-figure-reference');
        const text = parent.querySelector('.cm-line').firstChild;
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, 6);
        if (shadow) {
            // jsdom cannot retain a native shadow selection; model Gecko's
            // real shadow-tree endpoints through the existing root adapter.
            root.getSelection = () => ({
                anchorNode: text, anchorOffset: 0,
                focusNode: text, focusOffset: 6, isCollapsed: false,
                rangeCount: 1, getRangeAt: () => range,
            });
        }
        else {
            document.getSelection().removeAllRanges();
            document.getSelection().addRange(range);
        }
        document.dispatchEvent(new document.defaultView.Event('selectionchange'));
        mouse(reference, 'mouseover');
        mouse(reference, 'mousemove');
        clock.advance(500);
        assert.equal(parent.querySelector('.mktero-figure-preview-popup'), null);
        document.getSelection().removeAllRanges();
        if (shadow) root.getSelection = () => document.getSelection();
        view.dispatch({ selection: { anchor: 0, head: 6 } });
        mouse(reference, 'mousemove');
        clock.advance(500);
        assert.equal(parent.querySelector('.mktero-figure-preview-popup'), null);
        view.dispatch({ selection: { anchor: 0 } });
        mouse(reference, 'mousemove');
        clock.advance(450);
        assert.ok(parent.querySelector('.mktero-figure-preview-popup'));
    });
}

test('a selection made during the wait is rechecked before opening', t => {
    const { parent, document, clock, mouse } = mount(t);
    const reference = parent.querySelector('.cm-mktero-figure-reference');
    mouse(reference, 'mouseover');
    const text = parent.querySelector('.cm-line').firstChild;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 6);
    document.getSelection().addRange(range);
    // No selectionchange is dispatched: the delayed callback must check too.
    clock.advance(450);
    assert.equal(parent.querySelector('.mktero-figure-preview-popup'), null);
});

for (const type of ['wheel', 'scroll']) {
    test(`${type} cancels pending and visible previews until the mouse moves again`, t => {
        const { parent, view, window, clock, mouse } = mount(t);
        const citation = parent.querySelector('.cm-mktero-citation');
        mouse(citation, 'mouseover');
        const queued = [...clock.timers.values()][0];
        view.scrollDOM.dispatchEvent(new window.Event(type, { bubbles: true }));
        queued.callback();
        clock.advance(500);
        mouse(citation, 'mouseover');
        clock.advance(500);
        assert.equal(parent.querySelector('.mktero-citation-popup'), null);
        mouse(citation, 'mousemove', { clientX: 21 });
        clock.advance(450);
        assert.ok(parent.querySelector('.mktero-citation-popup'));
        view.scrollDOM.dispatchEvent(new window.Event(type, { bubbles: true }));
        assert.equal(parent.querySelector('.mktero-citation-popup'), null);
    });
}

test('scrolling or selecting inside a preview preserves it', t => {
    const { parent, document, window, clock, mouse } = mount(t);
    mouse(parent.querySelector('.cm-mktero-citation'), 'mouseover');
    clock.advance(450);
    const popup = parent.querySelector('.mktero-citation-popup');
    popup.dispatchEvent(new window.Event('wheel', { bubbles: true }));
    popup.dispatchEvent(new window.Event('scroll', { bubbles: true }));
    mouse(popup, 'mousedown', { buttons: 1 });
    const text = popup.querySelector('.mktero-citation-popup-text')?.firstChild;
    assert.ok(text);
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 3);
    document.getSelection().addRange(range);
    document.dispatchEvent(new window.Event('selectionchange'));
    clock.advance(500);
    assert.equal(parent.querySelector('.mktero-citation-popup'), popup);
});

for (const pending of [false, true]) {
    test(`Escape dismisses a ${pending ? 'pending' : 'visible'} preview until leaving the reference`, t => {
        const { parent, document, key, clock, mouse } = mount(t);
        const citation = parent.querySelector('.cm-mktero-citation');
        mouse(citation, 'mouseover');
        if (!pending) clock.advance(450);
        assert.equal(key(document.body, 'Escape').defaultPrevented, true);
        mouse(citation, 'mouseover');
        mouse(citation, 'mousemove');
        clock.advance(500);
        assert.equal(parent.querySelector('.mktero-citation-popup'), null);
        mouse(citation, 'mouseout', { relatedTarget: parent });
        mouse(citation, 'mouseover');
        clock.advance(450);
        assert.ok(parent.querySelector('.mktero-citation-popup'));
    });
}

test('keyboard focus bypasses the hover wait and Escape returns focus without reopening', t => {
    const { parent, key, clock } = mount(t);
    const citation = parent.querySelector('.cm-mktero-citation');
    citation.focus();
    assert.ok(parent.querySelector('.mktero-citation-popup'));
    key(citation, 'ArrowDown');
    const popup = parent.querySelector('.mktero-citation-popup');
    const control = popup.querySelector('[tabindex], button');
    assert.ok(control);
    control.focus();
    key(control, 'Escape');
    clock.advance(500);
    assert.equal(parent.querySelector('.mktero-citation-popup'), null);
    assert.equal(citation.getRootNode().activeElement, citation);
});

test('Escape follows the keyboard preview when the pointer remains over a different reference', t => {
    const { parent, key, clock, mouse } = mount(t);
    const [first, second] = parent.querySelectorAll('.cm-line .cm-mktero-citation');
    mouse(first, 'mouseover');
    clock.advance(450);
    second.focus();
    assert.match(parent.querySelector('.mktero-citation-popup').textContent, /Second paper/);
    key(second, 'ArrowDown');
    const control = parent.querySelector('.mktero-citation-popup [tabindex], .mktero-citation-popup button');
    control.focus();
    key(control, 'Escape');
    mouse(second, 'mousemove');
    clock.advance(500);
    assert.equal(parent.querySelector('.mktero-citation-popup'), null);
});

test('Escape inside another reader popup reaches its own handler and restores focus', t => {
    const { parent, document, window, clock, mouse, key, extraEditors } = mount(t, { shadow: true });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const otherParent = document.createElement('div');
    root.appendChild(otherParent);
    const otherEditor = createInlineMarkdownEditor({
        parent: otherParent, initialMarkdown: MARKDOWN,
    });
    extraEditors.push(otherEditor);
    const otherCitation = otherParent.querySelector('.cm-mktero-citation');
    otherCitation.focus();
    key(otherCitation, 'ArrowDown');
    const control = otherParent.querySelector('.mktero-citation-popup [tabindex], .mktero-citation-popup button');
    control.focus();
    // Hovering in the first reader can leave two previews open while keyboard
    // focus stays inside the second. Its document listener must let Escape pass.
    mouse(parent.querySelector('.cm-mktero-citation'), 'mouseover');
    mouse(parent.querySelector('.cm-mktero-citation'), 'mousemove');
    clock.advance(450);
    assert.ok(parent.querySelector('.mktero-citation-popup'));
    assert.ok(otherParent.querySelector('.mktero-citation-popup'));
    key(control, 'Escape');
    clock.advance(500);
    assert.equal(otherParent.querySelector('.mktero-citation-popup'), null);
    assert.equal(root.activeElement, otherCitation);
    // An unrelated control's Escape must not be consumed by the first reader.
    mouse(parent.querySelector('.cm-mktero-citation'), 'mousemove');
    clock.advance(450);
    assert.ok(parent.querySelector('.mktero-citation-popup'));
    const input = document.createElement('input');
    document.body.appendChild(input);
    const escape = new window.KeyboardEvent('keydown', {
        key: 'Escape', bubbles: true, cancelable: true,
    });
    input.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, false);
    input.focus();
    assert.equal(parent.querySelector('.mktero-citation-popup'), null);
});

test('document replacement and destruction invalidate queued preview callbacks', t => {
    const { parent, editor, clock, mouse } = mount(t);
    mouse(parent.querySelector('.cm-mktero-citation'), 'mouseover');
    const queued = [...clock.timers.values()][0];
    editor.setDocument({ markdown: 'A different paper.' });
    queued.callback();
    clock.advance(500);
    assert.equal(parent.querySelector('.mktero-citation-popup'), null);
    editor.setDocument({ markdown: MARKDOWN });
    mouse(parent.querySelector('.cm-mktero-citation'), 'mousemove');
    const last = [...clock.timers.values()].find(timer => timer.at >= 900);
    assert.ok(last);
    editor.destroy();
    last.callback();
    assert.equal(parent.querySelector('.mktero-citation-popup'), null);
    assert.equal(clock.timers.size, 0);
});
