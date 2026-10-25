import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
    applyCaptionSelectionClamp,
    captionGestureShouldRelease,
    captionPointerPoint,
    captionSelectionClamp,
    figureCaptionOf,
} from '../src/editor/caption-selection-clamp.js';

function fixture() {
    const dom = new JSDOM(`<!doctype html>
        <p id="before">Before the figure, this paragraph must not be selected.</p>
        <figure class="mktero-figure">
            <img alt="diagram">
            <figcaption>
                <span class="mktero-figure-label">Figure 1.</span>
                Consolidated Standards of Reporting Trial.
            </figcaption>
        </figure>
        <p id="after">After the figure, this paragraph stays outside.</p>`);
    const { document } = dom.window;
    const before = document.querySelector('#before').firstChild;
    const after = document.querySelector('#after').firstChild;
    const caption = document.querySelector('figcaption');
    const captionText = [...caption.childNodes].find(node => (
        node.nodeType === 3 && node.textContent.includes('Reporting')
    ));
    const image = document.querySelector('img');
    return { document, before, after, caption, captionText, image };
}

function gesture(caption, captionText, startOffset, extras = {}) {
    return {
        caption,
        startNode: captionText,
        startOffset,
        detail: 1,
        released: false,
        pointerNode: captionText,
        pointerOffset: startOffset,
        ...extras,
    };
}

function leakedSelection(before, captionText, focusOffset) {
    return {
        isCollapsed: false,
        rangeCount: 1,
        anchorNode: before,
        anchorOffset: 0,
        focusNode: captionText,
        focusOffset,
        setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset) {
            this.anchorNode = anchorNode;
            this.anchorOffset = anchorOffset;
            this.focusNode = focusNode;
            this.focusOffset = focusOffset;
        },
    };
}

function rect(top, right, bottom, left) {
    return {
        top,
        right,
        bottom,
        left,
        width: right - left,
        height: bottom - top,
    };
}

test('reads the Firefox hit point from rangeParent', () => {
    const { captionText } = fixture();
    const point = captionPointerPoint({
        rangeParent: captionText,
        rangeOffset: 4,
    });
    assert.equal(point.node, captionText);
    assert.equal(point.offset, 4);
});

test('ignores a figcaption that is not in a figure', () => {
    const dom = new JSDOM('<figcaption id="loose">Loose caption</figcaption>');
    assert.equal(figureCaptionOf(dom.window.document.querySelector('#loose')), null);
});

test('clamps a leaked caption drag back to the press and the in-caption focus', () => {
    const { before, caption, captionText } = fixture();
    const start = captionText.textContent.indexOf('Reporting');
    const focus = captionText.textContent.indexOf('Trial') + 'Trial'.length;
    const selection = leakedSelection(before, captionText, focus);
    const next = captionSelectionClamp(
        selection,
        gesture(caption, captionText, start)
    );
    assert.deepEqual(next, {
        anchorNode: captionText,
        anchorOffset: start,
        focusNode: captionText,
        focusOffset: focus,
    });
    applyCaptionSelectionClamp(selection, gesture(caption, captionText, start));
    assert.equal(selection.anchorNode, captionText);
    assert.equal(selection.anchorOffset, start);
    assert.equal(selection.focusOffset, focus);
    assert.equal(
        captionText.textContent.slice(selection.anchorOffset, selection.focusOffset),
        'Reporting Trial'
    );
});

test('does not clamp a selection that started outside the caption', () => {
    const { before, caption, captionText } = fixture();
    const selection = leakedSelection(before, captionText, 8);
    assert.equal(captionSelectionClamp(selection, null), null);
    assert.equal(captionSelectionClamp(selection, {
        ...gesture(caption, captionText, 4),
        released: true,
    }), null);
});

test('does not clamp a selection that already stays in the caption', () => {
    const { caption, captionText } = fixture();
    const start = captionText.textContent.indexOf('Reporting');
    const selection = {
        isCollapsed: false,
        rangeCount: 1,
        anchorNode: captionText,
        anchorOffset: start,
        focusNode: captionText,
        focusOffset: start + 'Reporting'.length,
    };
    assert.equal(
        captionSelectionClamp(selection, gesture(caption, captionText, start)),
        null
    );
});

test('releases the gesture when the pointer enters another paragraph', () => {
    const { before, caption } = fixture();
    caption.getBoundingClientRect = () => rect(400, 500, 440, 100);
    const active = gesture(caption, caption.firstChild, 0);
    assert.equal(captionGestureShouldRelease(active, {
        type: 'mousemove',
        buttons: 1,
        clientX: 20,
        clientY: 20,
        target: before,
        rangeParent: before,
        rangeOffset: 0,
    }), true);
});

test('keeps the gesture while the pointer is over the image even if hit testing lies', () => {
    const { before, caption, image } = fixture();
    caption.getBoundingClientRect = () => rect(500, 500, 540, 100);
    image.getBoundingClientRect = () => rect(100, 500, 500, 100);
    const active = gesture(caption, caption.firstChild, 0);
    assert.equal(captionGestureShouldRelease(active, {
        type: 'mousemove',
        buttons: 1,
        clientX: 200,
        clientY: 300,
        target: image,
        rangeParent: before,
        rangeOffset: 0,
    }), false);
    assert.equal(captionGestureShouldRelease(active, {
        type: 'mousemove',
        buttons: 1,
        clientX: 200,
        clientY: 520,
        target: before,
        rangeParent: before,
        rangeOffset: 0,
    }), false);
});

test('clamps a double-click leak to the word around the press', () => {
    const { before, caption, captionText } = fixture();
    const start = captionText.textContent.indexOf('Reporting') + 2;
    const selection = leakedSelection(before, captionText, start + 4);
    const next = captionSelectionClamp(selection, gesture(
        caption,
        captionText,
        start,
        { detail: 2 }
    ));
    assert.equal(next.anchorNode, captionText);
    assert.equal(
        captionText.textContent.slice(next.anchorOffset, next.focusOffset),
        'Reporting'
    );
});

test('retries a clamp once when the browser puts the leak back', () => {
    const { before, caption, captionText } = fixture();
    const start = captionText.textContent.indexOf('Reporting');
    const focus = start + 'Reporting'.length;
    const active = gesture(caption, captionText, start);
    let writes = 0;
    const selection = {
        isCollapsed: false,
        rangeCount: 1,
        anchorNode: before,
        anchorOffset: 0,
        focusNode: captionText,
        focusOffset: focus,
        setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset) {
            writes += 1;
            if (writes === 1) return;
            this.anchorNode = anchorNode;
            this.anchorOffset = anchorOffset;
            this.focusNode = focusNode;
            this.focusOffset = focusOffset;
        },
    };
    assert.equal(applyCaptionSelectionClamp(selection, active), true);
    assert.equal(writes, 2);
    assert.equal(selection.anchorNode, captionText);
    assert.equal(selection.anchorOffset, start);
    assert.equal(applyCaptionSelectionClamp(selection, active), false);
});
