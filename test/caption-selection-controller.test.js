import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createCaptionSelectionController } from '../src/editor/caption-selection-controller.js';

function fixture() {
    const dom = new JSDOM(`<!doctype html>
        <div id="reader"><p>Before the figure</p>
            <figure><img alt="diagram"><figcaption>Measurements from repeated trials</figcaption></figure>
            <table><tr><td>Ordinary table selection</td></tr></table>
        </div><input id="note"><div id="other"><figure><figcaption>Another paper caption</figcaption></figure></div>`);
    const { document } = dom.window;
    const parent = document.querySelector('#reader');
    const caption = parent.querySelector('figcaption');
    const text = caption.firstChild;
    const before = parent.querySelector('p').firstChild;
    const selection = document.getSelection();
    const mouse = (target, type, node, offset, extras = {}) => {
        const event = new dom.window.MouseEvent(type, {
            bubbles: true, button: 0, buttons: type === 'mouseup' ? 0 : 1, ...extras,
        });
        Object.defineProperties(event, {
            rangeParent: { value: node }, rangeOffset: { value: offset },
        });
        target.dispatchEvent(event);
    };
    const controller = createCaptionSelectionController({ parent, editorDOM: parent });
    let observed = 0;
    document.addEventListener('selectionchange', () => { observed++; });
    const changed = () => {
        const was = observed;
        document.dispatchEvent(new dom.window.Event('selectionchange'));
        return observed - was;
    };
    const begin = () => {
        mouse(caption, 'mousedown', text, 0);
        selection.setBaseAndExtent(before, 0, text, 12);
        assert.equal(changed(), 0);
        assert.equal(selection.toString(), 'Measurements');
    };
    return { dom, document, parent, caption, text, before, selection, mouse, controller, changed, begin };
}

for (const cancellation of ['escape', 'blur', 'outside press', 'leave for table']) {
    test(`releases caption ownership after ${cancellation}`, () => {
        const f = fixture();
        try {
            f.begin();
            assert.equal(f.caption.getAttribute('tabindex'), '-1');
            if (cancellation === 'escape') {
                f.document.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
            }
            else if (cancellation === 'blur') {
                f.dom.window.dispatchEvent(new f.dom.window.Event('blur'));
            }
            else if (cancellation === 'outside press') {
                f.mouse(f.document.querySelector('#note'), 'mousedown', null, 0);
            }
            else {
                const cell = f.parent.querySelector('td');
                f.mouse(cell, 'mousemove', cell.firstChild, 6);
            }
            assert.equal(f.caption.hasAttribute('tabindex'), false, 'temporary caption focus is released');
            f.selection.setBaseAndExtent(f.before, 0, f.before, 6);
            assert.equal(f.changed(), 1);
            assert.equal(f.selection.toString(), 'Before');
            f.begin();
        }
        finally {
            f.controller.destroy();
            f.dom.window.close();
        }
    });
}

for (const type of ['focus', 'blur']) {
    test(`keeps a caption drag intact during ${type} and restores editor notifications afterwards`, () => {
        const f = fixture();
        const target = f.before.parentElement;
        let notifications = 0;
        target.addEventListener(type, () => {
            notifications++;
            // CodeMirror's delayed focus update restores its old cursor.
            f.selection.collapse(f.before, 0);
        });
        const notify = () => target.dispatchEvent(new f.dom.window.FocusEvent(type));
        try {
            notify();
            assert.equal(notifications, 1, 'ordinary editor focus is observed');
            f.begin();
            notify();
            assert.equal(notifications, 1, 'focus updates do not replace a caption gesture');
            assert.equal(f.selection.toString(), 'Measurements');
            f.mouse(f.caption, 'mouseup', f.text, 12);
            notify();
            assert.equal(notifications, 2, 'releasing the gesture restores focus updates');

            f.begin();
            f.document.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
            notify();
            assert.equal(notifications, 3, 'canceling restores focus updates');

            f.begin();
            const other = f.document.querySelector('#other');
            let otherNotifications = 0;
            other.addEventListener(type, () => { otherNotifications++; });
            other.dispatchEvent(new f.dom.window.FocusEvent(type));
            assert.equal(otherNotifications, 1, 'another editor keeps its focus notifications');
            f.controller.destroy();
            notify();
            assert.equal(notifications, 4, 'destroy removes the focus capture listener');
        }
        finally {
            f.controller.destroy();
            f.dom.window.close();
        }
    });
}

test('destroy removes caption ownership and is idempotent', () => {
    const f = fixture();
    try {
        f.begin();
        f.mouse(f.caption, 'mouseup', f.text, 12);
        assert.equal(f.changed(), 0);
        f.controller.destroy();
        f.controller.destroy();
        assert.equal(f.caption.hasAttribute('tabindex'), false);
        assert.equal(f.changed(), 1, 'the retained selection no longer blocks editor observers');
        f.selection.setBaseAndExtent(f.before, 0, f.text, 12);
        assert.equal(f.changed(), 1);
        assert.equal(f.selection.anchorNode, f.before);
    }
    finally {
        f.controller.destroy();
        f.dom.window.close();
    }
});

test('releases a retained caption on programmatic focus outside the widget', () => {
    const f = fixture();
    try {
        f.mouse(f.caption, 'mousedown', f.text, 0);
        f.caption.focus();
        f.selection.setBaseAndExtent(f.text, 0, f.text, 12);
        f.mouse(f.caption, 'mouseup', f.text, 12);
        assert.equal(f.document.activeElement, f.caption);
        assert.equal(f.changed(), 0);
        const note = f.document.querySelector('#note');
        note.focus();
        assert.equal(f.document.activeElement, note);
        assert.equal(f.caption.hasAttribute('tabindex'), false);
        assert.equal(f.changed(), 1, 'external focus restores ordinary selection observers');
    }
    finally {
        f.controller.destroy();
        f.dom.window.close();
    }
});

test('restores caption focus attributes when a click or native selection ends ownership', () => {
    const f = fixture();
    try {
        f.mouse(f.caption, 'mousedown', f.text, 0);
        assert.equal(f.caption.getAttribute('tabindex'), '-1');
        f.selection.collapse(f.text, 0);
        f.mouse(f.caption, 'mouseup', f.text, 0);
        assert.equal(f.caption.hasAttribute('tabindex'), false, 'a click retains no focus attribute');

        f.begin();
        f.mouse(f.caption, 'mouseup', f.text, 12);
        assert.equal(f.caption.getAttribute('tabindex'), '-1', 'a native selection keeps its focus target');
        f.selection.collapse(f.before, 0);
        assert.equal(f.changed(), 1);
        assert.equal(f.caption.hasAttribute('tabindex'), false, 'an ended native selection releases focus');

        for (const value of ['0', '-1']) {
            f.caption.setAttribute('tabindex', value);
            f.begin();
            f.controller.clear();
            assert.equal(f.caption.getAttribute('tabindex'), value, 'an existing focus target is preserved');
        }

        f.caption.removeAttribute('tabindex');
        f.begin();
        f.caption.setAttribute('tabindex', '0');
        f.controller.clear();
        assert.equal(f.caption.getAttribute('tabindex'), '0', 'a later focus attribute update is preserved');
    }
    finally {
        f.controller.destroy();
        f.dom.window.close();
    }
});

test('another editor can own its caption after leaving the first reader', () => {
    const f = fixture();
    const other = f.document.querySelector('#other');
    const second = createCaptionSelectionController({ parent: other, editorDOM: other });
    try {
        f.begin();
        const caption = other.querySelector('figcaption');
        f.mouse(caption, 'mousedown', caption.firstChild, 0);
        f.selection.setBaseAndExtent(f.before, 0, caption.firstChild, 7);
        assert.equal(f.changed(), 0);
        assert.equal(f.selection.toString(), 'Another');
        f.mouse(caption, 'mouseup', caption.firstChild, 7);
        second.destroy();
        assert.equal(f.changed(), 1);
    }
    finally {
        second.destroy();
        f.controller.destroy();
        f.dom.window.close();
    }
});
