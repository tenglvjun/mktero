import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
    installSelectionPopupGuard,
    pdfSelectionViewRect,
    readPdfSelectionRects,
} from '../src/ui/selection-popup-guard.js';

const view = { left: 220, top: 90, right: 980, bottom: 820, width: 760, height: 730 };
const lines = [
    { left: 240, top: 500, right: 940, bottom: 518, width: 700, height: 18 },
    { left: 240, top: 520, right: 940, bottom: 538, width: 700, height: 18 },
    { left: 240, top: 540, right: 900, bottom: 558, width: 660, height: 18 },
    { left: 240, top: 560, right: 860, bottom: 578, width: 620, height: 18 },
];

function rect(left, top, width, height) {
    return { left, top, right: left + width, bottom: top + height, width, height };
}

function popupBox(transform, width = 198, height = 76) {
    const match = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/.exec(transform || '');
    const left = match ? Number(match[1]) : 0;
    const top = match ? Number(match[2]) : 0;
    return rect(left, top, width, height);
}

function createReader({
    transform = 'translate(700px, 524px)',
    selection = lines,
    iframe = null,
} = {}) {
    const dom = new JSDOM('<!doctype html><html><body><div id="view"></div></body></html>');
    const { document } = dom.window;
    const parent = document.querySelector('#view');
    parent.getBoundingClientRect = () => view;
    const popup = document.createElement('div');
    popup.className = 'selection-popup view-popup page-popup-left-center';
    popup.style.transform = transform;
    popup.getBoundingClientRect = () => popupBox(popup.style.transform);
    parent.append(popup);
    const frame = iframe || {
        clientWidth: view.width,
        clientHeight: view.height,
        getBoundingClientRect: () => view,
    };
    const iframeWindow = {
        frameElement: frame,
        getSelection: () => ({
            isCollapsed: false,
            rangeCount: 1,
            getRangeAt: () => ({ getClientRects: () => selection }),
        }),
        addEventListener() {},
        removeEventListener() {},
    };
    return { dom, document, popup, iframeWindow };
}

function install(fixture, {
    selectionRects = () => lines,
    schedule = callback => callback(),
} = {}) {
    return installSelectionPopupGuard({
        document: fixture.document,
        selectionRects,
        viewRect: popup => pdfSelectionViewRect(popup, fixture.iframeWindow),
        scrollTarget: () => fixture.iframeWindow,
        schedule,
    });
}

test('shifts an overlapping selection popup off the caption and then stays put', () => {
    const fixture = createReader();
    const dispose = install(fixture);

    const box = popupBox(fixture.popup.style.transform);
    assert.equal(box.top >= 578 || box.bottom <= 500, true);
    assert.equal(fixture.popup.classList.contains('page-popup-left-center'), false);
    assert.equal(
        fixture.popup.classList.contains('page-popup-bottom-center')
        || fixture.popup.classList.contains('page-popup-top-center'),
        true
    );
    const settled = fixture.popup.style.transform;
    fixture.document.body.dispatchEvent(new fixture.dom.window.Event('scroll'));
    assert.equal(fixture.popup.style.transform, settled);
    dispose();
});

test('does not move a popup that already clears the selection', () => {
    const fixture = createReader({ transform: 'translate(400px, 620px)' });
    install(fixture);

    assert.equal(fixture.popup.style.transform, 'translate(400px, 620px)');
    assert.equal(fixture.popup.classList.contains('page-popup-left-center'), true);
});

test('ignores a popup whose position is not a translate and a broken selection read', () => {
    const fixture = createReader({ transform: 'none' });
    assert.doesNotThrow(() => install(fixture, {
        selectionRects: () => {
            throw new Error('reader frame gone');
        },
    }));
    assert.equal(fixture.popup.style.transform, 'none');
    assert.equal(fixture.popup.classList.contains('page-popup-left-center'), true);
});

test('stops following the popup after cleanup', () => {
    const fixture = createReader();
    let rects = lines;
    const dispose = install(fixture, { selectionRects: () => rects });
    const settled = fixture.popup.style.transform;
    dispose();
    fixture.popup.style.transform = 'translate(700px, 524px)';
    rects = lines;
    fixture.document.body.dispatchEvent(new fixture.dom.window.Event('scroll'));
    assert.equal(fixture.popup.style.transform, 'translate(700px, 524px)');
    assert.notEqual(settled, 'translate(700px, 524px)');
});

test('opens a reader when the extension sandbox has no queueMicrotask', () => {
    let queued = null;
    const document = {
        defaultView: {
            Promise: {
                resolve() {
                    return {
                        then(callback) {
                            queued = callback;
                            return this;
                        },
                    };
                },
            },
        },
        documentElement: {},
        querySelector: () => null,
        addEventListener() {},
        removeEventListener() {},
    };

    const dispose = installSelectionPopupGuard({
        document,
        selectionRects: () => [],
    });

    assert.equal(typeof queued, 'function');
    assert.doesNotThrow(() => queued());
    dispose();
});

test('reads PDF selection rects in the reader viewport, including a scaled frame', () => {
    const frame = {
        clientWidth: 380,
        clientHeight: 365,
        getBoundingClientRect: () => view,
    };
    const iframeWindow = {
        frameElement: frame,
        getSelection() {
            return {
                isCollapsed: false,
                rangeCount: 1,
                getRangeAt: () => ({
                    getClientRects: () => [rect(10, 20, 70, 16)],
                }),
            };
        },
    };

    assert.deepEqual(readPdfSelectionRects(iframeWindow), [{
        left: view.left + 20,
        top: view.top + 40,
        right: view.left + 160,
        bottom: view.top + 72,
    }]);
    assert.deepEqual(readPdfSelectionRects({
        getSelection: () => ({ isCollapsed: true, rangeCount: 1 }),
    }), []);
    assert.deepEqual(readPdfSelectionRects({
        frameElement: {
            clientWidth: 100,
            clientHeight: 100,
            getBoundingClientRect: () => ({
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
                width: 0,
                height: 0,
            }),
        },
        getSelection: () => ({
            isCollapsed: false,
            rangeCount: 1,
            getRangeAt: () => ({ getClientRects: () => [rect(1, 1, 10, 10)] }),
        }),
    }), []);
    assert.deepEqual(readPdfSelectionRects({
        frameElement: frame,
        getSelection: () => ({
            isCollapsed: false,
            rangeCount: 1,
            getRangeAt() {
                throw new Error('stale range');
            },
        }),
    }), []);
    assert.deepEqual(pdfSelectionViewRect({
        parentElement: { getBoundingClientRect: () => view },
    }, iframeWindow), {
        left: view.left,
        top: view.top,
        right: view.right,
        bottom: view.bottom,
    });
});
