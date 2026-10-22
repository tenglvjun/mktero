import test from 'node:test';
import assert from 'node:assert/strict';
import {
    intersectRects,
    selectionPopupShift,
    translateClientRects,
} from '../src/ui/selection-popup-placement.js';

const captionView = { left: 220, top: 90, right: 980, bottom: 820 };
const captionLines = [
    { left: 240, top: 500, right: 940, bottom: 518 },
    { left: 240, top: 520, right: 940, bottom: 538 },
    { left: 240, top: 540, right: 900, bottom: 558 },
    { left: 240, top: 560, right: 860, bottom: 578 },
];

function moved(popup, shift) {
    return {
        left: popup.left + shift.dx,
        top: popup.top + shift.dy,
        right: popup.right + shift.dx,
        bottom: popup.bottom + shift.dy,
    };
}

function overlaps(rect, lines) {
    return lines.some(line => (
        Math.min(rect.right, line.right) - Math.max(rect.left, line.left) > 1
        && Math.min(rect.bottom, line.bottom) - Math.max(rect.top, line.top) > 1
    ));
}

test('moves a full-width caption popup off the selected lines', () => {
    const popup = { left: 700, top: 524, right: 898, bottom: 600 };
    const shift = selectionPopupShift(popup, captionLines, captionView);

    assert.equal(shift.side, 'bottom');
    const next = moved(popup, shift);
    assert.equal(overlaps(next, captionLines), false);
    assert.ok(next.left >= captionView.left + 8);
    assert.ok(next.right <= captionView.right - 8);
    assert.equal(selectionPopupShift(next, captionLines, captionView), null);
});

test('places the popup above a caption when below does not fit', () => {
    const popup = { left: 700, top: 524, right: 898, bottom: 600 };
    const view = { ...captionView, bottom: 640 };
    const shift = selectionPopupShift(popup, captionLines, view);

    assert.equal(shift.side, 'top');
    const next = moved(popup, shift);
    assert.equal(overlaps(next, captionLines), false);
    assert.ok(next.bottom <= captionLines[0].top);
    assert.ok(next.top >= view.top + 8);
});

test('leaves a popup that does not cover a selected line', () => {
    const betweenLines = { left: 700, top: 538, right: 898, bottom: 540 };
    assert.equal(
        selectionPopupShift(betweenLines, captionLines, captionView),
        null
    );
    const beside = { left: 960, top: 520, right: 970, bottom: 560 };
    assert.equal(selectionPopupShift(beside, captionLines, captionView), null);
});

test('does not chase a popup that already covers as little as any alternative', () => {
    const view = { left: 0, top: 0, right: 200, bottom: 100 };
    const lines = [{ left: 0, top: 0, right: 200, bottom: 100 }];
    const popup = { left: 0, top: 0, right: 80, bottom: 40 };

    assert.equal(selectionPopupShift(popup, lines, view), null);
});

test('parks the popup clear of a selection that fills the vertical room', () => {
    const view = { left: 0, top: 0, right: 500, bottom: 200 };
    const lines = [{ left: 180, top: 10, right: 320, bottom: 190 }];
    const popup = { left: 200, top: 80, right: 280, bottom: 120 };
    const shift = selectionPopupShift(popup, lines, view);
    const next = moved(popup, shift);

    assert.ok(shift);
    assert.equal(overlaps(next, lines), false);
    assert.ok(next.right <= lines[0].left || next.left >= lines[0].right);
});

test('ignores empty, inverted, and non-finite geometry', () => {
    const popup = { left: 10, top: 10, right: 40, bottom: 30 };
    const line = { left: 0, top: 0, right: 80, bottom: 40 };
    const view = { left: 0, top: 0, right: 200, bottom: 200 };

    assert.equal(selectionPopupShift(popup, [], view), null);
    assert.equal(selectionPopupShift(popup, null, view), null);
    assert.equal(selectionPopupShift(null, [line], view), null);
    assert.equal(selectionPopupShift(popup, [line], { left: 0, top: 0, right: 10, bottom: 10 }), null);
    assert.equal(selectionPopupShift(popup, [{
        left: Number.NaN,
        top: 0,
        right: 10,
        bottom: 10,
    }], view), null);
    assert.equal(selectionPopupShift(popup, [{
        left: 12,
        top: 12,
        right: 8,
        bottom: 20,
    }], view), null);
});

test('translates iframe client rects into the reader viewport', () => {
    assert.deepEqual(translateClientRects([
        { left: 10, top: 20, right: 80, bottom: 36 },
        { left: 0, top: 0, right: 0, bottom: 4 },
        { left: Number.NaN, top: 1, right: 2, bottom: 3 },
    ], { left: 100, top: 40 }), [
        { left: 110, top: 60, right: 180, bottom: 76 },
    ]);
    assert.deepEqual(translateClientRects([
        { left: 10, top: 4, right: 20, bottom: 8 },
    ], { left: 50, top: 10, scaleX: 2, scaleY: 3 }), [
        { left: 70, top: 22, right: 90, bottom: 34 },
    ]);
    assert.deepEqual(translateClientRects([{ left: 0, top: 0, right: 1, bottom: 1 }], null), []);
});

test('intersects the popup parent with the PDF frame and keeps a usable rect', () => {
    assert.deepEqual(intersectRects(
        { left: 0, top: 0, right: 800, bottom: 600 },
        { left: 200, top: 40, right: 700, bottom: 500 }
    ), { left: 200, top: 40, right: 700, bottom: 500 });
    assert.deepEqual(intersectRects(
        { left: 0, top: 0, right: 100, bottom: 80 },
        null
    ), { left: 0, top: 0, right: 100, bottom: 80 });
    assert.deepEqual(intersectRects(
        { left: 0, top: 0, right: 40, bottom: 40 },
        { left: 100, top: 100, right: 140, bottom: 140 }
    ), { left: 0, top: 0, right: 40, bottom: 40 });
});
