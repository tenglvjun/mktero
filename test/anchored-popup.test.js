import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createAnchoredPopup } from '../src/editor/anchored-popup.js';

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

// jsdom keeps focus on a control that becomes disabled or hidden. Gecko and
// Blink move focus to the body and fire focusout without a relatedTarget.
function blurToBody(window, element) {
    const { disabled, hidden } = element;
    const document = element.ownerDocument;
    const suppress = event => event.stopImmediatePropagation();
    document.addEventListener('blur', suppress, true);
    document.addEventListener('focusout', suppress, true);
    element.disabled = false;
    element.hidden = false;
    element.blur();
    element.disabled = disabled;
    element.hidden = hidden;
    document.removeEventListener('blur', suppress, true);
    document.removeEventListener('focusout', suppress, true);
    element.dispatchEvent(new window.FocusEvent('focusout', {
        bubbles: true,
        relatedTarget: null,
    }));
}

function stubTimers(window) {
    const scheduled = [];
    let nextTimerID = 1;
    window.setTimeout = (callback, delay) => {
        const timer = { callback, delay, id: nextTimerID++ };
        scheduled.push(timer);
        return timer.id;
    };
    window.clearTimeout = timerID => {
        const index = scheduled.findIndex(timer => timer.id === timerID);
        if (index >= 0) scheduled.splice(index, 1);
    };
    return scheduled;
}

function createGeometryFixture({
    stableContentPosition, stableContentWidth, stableContentHeight,
    viewportPadding = 12, repositionBeforeMount = false,
} = {}) {
    const dom = new JSDOM('<!doctype html><div id="host"></div>', {
        pretendToBeVisual: true,
    });
    const { window } = dom;
    const { document } = window;
    window.innerWidth = 1000;
    window.innerHeight = 800;
    const host = document.querySelector('#host');
    const shadow = host.attachShadow({ mode: 'open' });
    const parent = document.createElement('div');
    const anchor = document.createElement('span');
    parent.append(anchor);
    shadow.append(parent);
    const boundary = { left: 100, top: 80, width: 800, height: 640 };
    const anchorBounds = { left: 400, top: 300, width: 60, height: 20 };
    const size = { width: 180, height: 40 };
    const rectangle = ({ left, top, width, height }) => ({
        left, top, width, height, right: left + width, bottom: top + height,
    });
    host.getBoundingClientRect = parent.getBoundingClientRect = () => rectangle(boundary);
    anchor.getBoundingClientRect = () => rectangle(anchorBounds);
    const observers = [];
    window.ResizeObserver = class {
        targets = [];
        disconnected = false;
        constructor(callback) {
            this.callback = callback;
            observers.push(this);
        }
        observe(target) {
            this.targets.push(target);
        }
        disconnect() {
            this.disconnected = true;
        }
    };
    let detachedMeasurements = 0;
    window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
        if (!this.isConnected) {
            detachedMeasurements++;
            return rectangle({ left: 0, top: 0, width: 0, height: 0 });
        }
        const cap = property => {
            const value = Number.parseFloat(this.style.getPropertyValue(property));
            return Number.isNaN(value) ? Infinity : value;
        };
        const width = Math.min(size.width, cap('--anchored-popup-available-width'));
        const height = Math.min(size.height, cap('--anchored-popup-available-height'));
        const top = this.style.top
            ? Number.parseFloat(this.style.top)
            : window.innerHeight - (Number.parseFloat(this.style.bottom) || 0) - height;
        return rectangle({ left: Number.parseFloat(this.style.left) || 0, top, width, height });
    };
    const popup = createAnchoredPopup(parent, {
        className: 'popup',
        idPrefix: 'geometry-popup',
        constrainToParent: true,
        viewportPadding,
        ...(stableContentPosition === undefined ? {} : { stableContentPosition }),
        ...(stableContentWidth === undefined ? {} : { stableContentWidth }),
        ...(stableContentHeight === undefined ? {} : { stableContentHeight }),
    });
    let reposition;
    const open = () => popup.open({
        anchor,
        label: 'Actions',
        renderContent({ document: ownerDocument, reposition: next }) {
            reposition = next;
            if (repositionBeforeMount) reposition();
            return ownerDocument.createElementNS(XHTML_NAMESPACE, 'div');
        },
    });
    return {
        window, host, parent, anchor, boundary, anchorBounds, size, observers, popup, open,
        reposition: () => reposition(),
        element: () => shadow.querySelector('.popup'),
        detachedMeasurements: () => detachedMeasurements,
        dispose() {
            popup.destroy();
            window.close();
        },
    };
}

test('reserves the requested source-panel height before a large selection expands', () => {
    const f = createGeometryFixture({
        stableContentPosition: true, stableContentHeight: 200, viewportPadding: 16,
    });
    Object.assign(f.boundary, { left: 200, top: 25, width: 704, height: 592 });
    Object.assign(f.anchorBounds, { left: 224, top: 73.5, width: 656, height: 539.5 });
    f.open();
    const popup = f.element();
    const compactBottom = popup.getBoundingClientRect().bottom;
    assert.equal(Number.parseFloat(popup.style.getPropertyValue('--anchored-popup-available-height')), 200);
    f.size.height = 300;
    f.reposition();
    assert.equal(popup.getBoundingClientRect().bottom, compactBottom);
    assert.equal(popup.getBoundingClientRect().height, 200);
    assert.equal(popup.getBoundingClientRect().top, 41);
    f.dispose();
});

test('closes the prior anchor, invokes cleanup once, and renders XHTML', () => {
    const dom = new JSDOM(
        '<!doctype html><div id="parent"><button id="one"></button>'
            + '<button id="two"></button></div>',
        { pretendToBeVisual: true }
    );
    const { document } = dom.window;
    const parent = document.querySelector('#parent');
    const one = document.querySelector('#one');
    const two = document.querySelector('#two');
    one.getBoundingClientRect = two.getBoundingClientRect = () => ({
        left: 10,
        right: 30,
        top: 20,
        bottom: 40,
        width: 20,
        height: 20,
    });
    const popup = createAnchoredPopup(parent, {
        className: 'popup',
        idPrefix: 'test-popup',
    });
    let closed = 0;
    const renderContent = ({ document: ownerDocument }) => {
        const content = ownerDocument.createElementNS(
            'http://www.w3.org/1999/xhtml',
            'button'
        );
        content.textContent = 'close';
        return content;
    };

    popup.open({ anchor: one, label: 'One', renderContent, onClose: () => closed++ });
    const first = document.querySelector('.popup');
    assert.equal(first.namespaceURI, 'http://www.w3.org/1999/xhtml');
    popup.open({ anchor: two, label: 'Two', renderContent, onClose: () => closed++ });
    assert.equal(closed, 1);
    assert.equal(one.hasAttribute('aria-describedby'), false);

    document.querySelector('.popup').dispatchEvent(new dom.window.KeyboardEvent(
        'keydown',
        { key: 'Escape', bubbles: true, cancelable: true }
    ));
    assert.equal(closed, 2);
    assert.equal(popup.isOpen(), false);
    dom.window.close();
});

test('stays open when its own focused control becomes disabled or hidden', () => {
    const dom = new JSDOM(
        '<!doctype html><div id="parent"><span id="anchor"></span></div>',
        { pretendToBeVisual: true }
    );
    const { document } = dom.window;
    const parent = document.querySelector('#parent');
    const anchor = document.querySelector('#anchor');
    const popup = createAnchoredPopup(parent, {
        className: 'popup',
        idPrefix: 'test-popup',
    });
    const scheduled = stubTimers(dom.window);
    let closed = 0;
    let busyButton;
    let sectionButton;
    let section;
    let plainButton;
    popup.open({
        anchor,
        label: 'Actions',
        dismissOnMouseLeave: false,
        onClose: () => closed++,
        renderContent({ document: ownerDocument }) {
            const content = ownerDocument.createElementNS(
                XHTML_NAMESPACE,
                'div'
            );
            busyButton = ownerDocument.createElementNS(
                XHTML_NAMESPACE,
                'button'
            );
            section = ownerDocument.createElementNS(XHTML_NAMESPACE, 'div');
            sectionButton = ownerDocument.createElementNS(
                XHTML_NAMESPACE,
                'button'
            );
            plainButton = ownerDocument.createElementNS(
                XHTML_NAMESPACE,
                'button'
            );
            section.appendChild(sectionButton);
            content.append(busyButton, section, plainButton);
            return content;
        },
    });

    busyButton.focus();
    busyButton.disabled = true;
    blurToBody(dom.window, busyButton);
    assert.deepEqual(scheduled, []);

    sectionButton.focus();
    section.hidden = true;
    blurToBody(dom.window, sectionButton);
    assert.deepEqual(scheduled, []);
    assert.equal(popup.isOpen(), true);

    plainButton.focus();
    blurToBody(dom.window, plainButton);
    assert.deepEqual(scheduled.map(timer => timer.delay), [120]);
    scheduled.shift().callback();
    assert.equal(popup.isOpen(), false);
    assert.equal(closed, 1);
    dom.window.close();
});

test('interacting inside the popup cancels a pending focus-loss dismissal', () => {
    const dom = new JSDOM('<!doctype html><div id=parent><span id=anchor></span></div>', {
        pretendToBeVisual: true,
    });
    const parent = dom.window.document.querySelector('#parent');
    const popup = createAnchoredPopup(parent, { className: 'popup', idPrefix: 'test-popup' });
    const scheduled = stubTimers(dom.window);
    let button;
    popup.open({
        anchor: parent.querySelector('#anchor'),
        label: 'Actions',
        dismissOnMouseLeave: false,
        renderContent({ document }) {
            button = document.createElementNS(XHTML_NAMESPACE, 'button');
            return button;
        },
    });
    button.focus();
    blurToBody(dom.window, button);
    assert.deepEqual(scheduled.map(timer => timer.delay), [120]);
    button.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
    assert.deepEqual(scheduled, []);
    assert.equal(popup.isOpen(), true);
    popup.destroy();
    dom.window.close();
});

test('tells its close handler whether Escape, focus loss, or the caller closed it', () => {
    const dom = new JSDOM(
        '<!doctype html><div id="parent"><span id="anchor"></span></div>',
        { pretendToBeVisual: true }
    );
    const { document } = dom.window;
    const parent = document.querySelector('#parent');
    const anchor = document.querySelector('#anchor');
    const popup = createAnchoredPopup(parent, {
        className: 'popup',
        idPrefix: 'test-popup',
    });
    const scheduled = stubTimers(dom.window);
    const reasons = [];
    let button;
    const openPopup = () => popup.open({
        anchor,
        label: 'Actions',
        forceOpen: true,
        onClose: reason => reasons.push(reason),
        renderContent({ document: ownerDocument }) {
            button = ownerDocument.createElementNS(XHTML_NAMESPACE, 'button');
            return button;
        },
    });

    openPopup();
    document.querySelector('.popup').dispatchEvent(new dom.window.KeyboardEvent(
        'keydown',
        { key: 'Escape', bubbles: true, cancelable: true }
    ));

    openPopup();
    button.focus();
    blurToBody(dom.window, button);
    const dismissal = scheduled.find(timer => timer.delay === 120);
    scheduled.splice(scheduled.indexOf(dismissal), 1);
    dismissal.callback();

    openPopup();
    popup.close();

    assert.deepEqual(reasons, ['escape', 'dismiss', undefined]);
    dom.window.close();
});

test('keeps its place when the anchor it points at is replaced', () => {
    const dom = new JSDOM(
        '<!doctype html><div id="parent"><span id="anchor"></span></div>',
        { pretendToBeVisual: true }
    );
    const { document } = dom.window;
    const parent = document.querySelector('#parent');
    const anchor = document.querySelector('#anchor');
    // A detached element reports an empty rect at the window origin.
    anchor.getBoundingClientRect = () => (anchor.isConnected ? {
        top: 300,
        right: 460,
        bottom: 320,
        left: 400,
        width: 60,
        height: 20,
    } : {
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        width: 0,
        height: 0,
    });
    const popup = createAnchoredPopup(parent, {
        className: 'popup',
        idPrefix: 'test-popup',
    });
    let reposition;
    const render = ({ document: ownerDocument, reposition: next }) => {
        reposition = next;
        return ownerDocument.createElementNS(XHTML_NAMESPACE, 'div');
    };
    popup.open({ anchor, label: 'Note', renderContent: render });
    const element = document.querySelector('.popup');
    const placed = [element.style.left, element.style.top];
    assert.notDeepEqual(placed, ['12px', '12px']);

    // An editor rebuild replaces the rendered highlight the popup points at.
    anchor.remove();
    reposition();
    assert.deepEqual([element.style.left, element.style.top], placed);

    // Reopening against that detached anchor, such as after a failed save,
    // reuses where it last was instead of the window's top-left corner.
    popup.open({ anchor, label: 'Note', renderContent: render, forceOpen: true });
    const reopened = document.querySelector('.popup');
    assert.deepEqual([reopened.style.left, reopened.style.top], placed);

    popup.close();
    dom.window.close();
});

test('keeps a fixed popup inside the reader when Zotero chrome covers the window', () => {
    const dom = new JSDOM('<!doctype html><div id="host"></div>', {
        pretendToBeVisual: true,
    });
    const { window } = dom;
    const { document } = window;
    window.innerWidth = 1400;
    window.innerHeight = 900;
    const host = document.querySelector('#host');
    const shadow = host.attachShadow({ mode: 'open' });
    const parent = document.createElement('div');
    const anchor = document.createElement('span');
    parent.append(anchor);
    shadow.append(parent);
    const rects = new Map([
        [host, {
            left: 240,
            top: 80,
            right: 900,
            bottom: 860,
            width: 660,
            height: 780,
        }],
        [anchor, {
            left: 820,
            top: 400,
            right: 880,
            bottom: 420,
            width: 60,
            height: 20,
        }],
    ]);
    window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
        return rects.get(this) || {
            left: 0,
            top: 0,
            right: 480,
            bottom: 220,
            width: 480,
            height: 220,
        };
    };
    const popup = createAnchoredPopup(parent, {
        className: 'popup',
        idPrefix: 'test-popup',
        viewportPadding: 12,
    });

    popup.open({
        anchor,
        label: 'Preview',
        renderContent({ document: ownerDocument }) {
            return ownerDocument.createElementNS(XHTML_NAMESPACE, 'div');
        },
    });
    const element = shadow.querySelector('.popup');
    const left = Number.parseFloat(element.style.left);
    const width = 480;

    assert.equal(element.style.maxWidth, '636px');
    assert.equal(left, 408);
    assert.ok(left + width <= 900 - 12);
    popup.close();
    dom.window.close();
});

test('stable content grows and shrinks down without moving its top or changing sides', () => {
    const fixture = createGeometryFixture({ stableContentPosition: true });
    fixture.anchorBounds.top = 200;
    fixture.open();
    const element = fixture.element();
    const compact = element.getBoundingClientRect();
    assert.equal(compact.top, 230);
    assert.equal(element.dataset.expansion, 'down');
    assert.equal(element.dataset.placement, 'bottom');
    assert.equal(element.style.getPropertyValue('--anchored-popup-available-height'), '478px');

    for (const height of [280, 1000, 40, 200, 40]) {
        fixture.size.height = height;
        fixture.reposition();
        const rect = element.getBoundingClientRect();
        assert.equal(rect.top, compact.top);
        assert.equal(rect.left, compact.left);
        assert.ok(rect.top >= fixture.anchorBounds.top + fixture.anchorBounds.height + 10);
        assert.ok(rect.bottom <= 708);
        assert.equal(element.style.bottom, '');
        assert.equal(element.dataset.expansion, 'down');
        assert.equal(element.dataset.placement, 'bottom');
    }
    fixture.dispose();
});

test('stable content grows and shrinks up without moving its bottom or changing sides', () => {
    const fixture = createGeometryFixture({ stableContentPosition: true });
    fixture.anchorBounds.top = 650;
    fixture.open();
    const element = fixture.element();
    const compact = element.getBoundingClientRect();
    assert.equal(compact.top, 600);
    assert.equal(compact.bottom, 640);
    assert.equal(element.dataset.expansion, 'up');
    assert.equal(element.style.bottom, '160px');
    assert.equal(element.style.getPropertyValue('--anchored-popup-available-height'), '548px');

    for (const height of [280, 1000, 40, 180, 40]) {
        fixture.size.height = height;
        fixture.reposition();
        const rect = element.getBoundingClientRect();
        assert.equal(rect.bottom, compact.bottom);
        assert.equal(rect.left, compact.left);
        assert.ok(rect.top >= 92);
        assert.equal(element.style.top, '');
        assert.equal(element.style.bottom, '160px');
        assert.equal(element.dataset.expansion, 'up');
    }
    fixture.dispose();
});

test('stable content chooses a side with 160px of room and prefers above when both fit', () => {
    for (const [anchorTop, expansion, compactTop] of [
        [200, 'down', 230],
        [200.375, 'down', 230.375],
        [261, 'down', 291],
        [262, 'up', 212],
        [262.375, 'up', 212.375],
        [300, 'up', 250],
        [650, 'up', 600],
    ]) {
        const fixture = createGeometryFixture({ stableContentPosition: true });
        fixture.anchorBounds.top = anchorTop;
        fixture.open();
        const element = fixture.element();
        assert.equal(element.dataset.expansion, expansion, `anchor top ${anchorTop}`);
        assert.equal(element.dataset.placement, expansion === 'up' ? 'top' : 'bottom');
        assert.equal(element.getBoundingClientRect().top, compactTop);
        fixture.dispose();
    }
});

test('stable content expands above the Firefox wrapped selection without covering it', () => {
    const fixture = createGeometryFixture({ stableContentPosition: true, stableContentWidth: 420 });
    Object.assign(fixture.boundary, { top: 25, height: 592 });
    Object.assign(fixture.anchorBounds, { top: 473, height: 59 });
    Object.assign(fixture.size, { width: 330, height: 44 });
    fixture.open();
    const element = fixture.element();
    const compact = element.getBoundingClientRect();
    assert.equal(compact.top, 419);
    assert.equal(compact.bottom, 463);
    assert.equal(element.dataset.expansion, 'up');
    assert.equal(element.dataset.placement, 'top');
    assert.equal(element.style.getPropertyValue('--anchored-popup-available-height'), '426px');

    for (const [width, height] of [[420, 181], [420, 300], [420, 1000], [330, 44]]) {
        Object.assign(fixture.size, { width, height });
        fixture.reposition();
        const rect = element.getBoundingClientRect();
        assert.equal(rect.bottom, 463);
        assert.equal(rect.left, compact.left);
        assert.equal(element.dataset.expansion, 'up');
        assert.ok(rect.top >= 37);
        assert.ok(rect.bottom <= fixture.anchorBounds.top - 10);
        if (height === 300) assert.equal(rect.top, 163);
    }
    fixture.dispose();
});

test('stable content reserves 160px in compact mode for a nine-block selection', () => {
    for (const [top, height, expansion, edge] of [
        [73.5, 539.55, 'up', 201],
        [28, 537.5, 'down', 441],
    ]) {
        const fixture = createGeometryFixture({
            stableContentPosition: true,
            stableContentWidth: 420,
            viewportPadding: 16,
        });
        try {
            Object.assign(fixture.boundary, { left: 200, top: 25, width: 704, height: 592 });
            Object.assign(fixture.anchorBounds, { left: 224, top, width: 656, height });
            Object.assign(fixture.size, { width: 330, height: 43.6 });
            fixture.open();
            const element = fixture.element();
            const compact = element.getBoundingClientRect();
            assert.equal(element.dataset.expansion, expansion);
            assert.equal(element.style.getPropertyValue('--anchored-popup-available-height'), '160px');
            assert.equal(expansion === 'up' ? compact.bottom : compact.top, edge);
            assert.ok(Math.abs(compact.height - 43.6) < 0.001);

            for (const [width, contentHeight] of [[420, 300], [420, 1000], [330, 43.6], [420, 181]]) {
                Object.assign(fixture.size, { width, height: contentHeight });
                fixture.reposition();
                const rect = element.getBoundingClientRect();
                assert.equal(element.dataset.expansion, expansion);
                assert.equal(expansion === 'up' ? rect.bottom : rect.top, edge);
                assert.equal(rect.left, compact.left);
                assert.ok(Math.abs(rect.height - Math.min(contentHeight, 160)) < 0.001);
                assert.ok(rect.top >= 41);
                assert.ok(rect.bottom <= 601);
                assert.ok(rect.right <= 888);
            }
        }
        finally {
            fixture.dispose();
        }
    }
});

test('stable content uses the full small window before expanding a nearly full selection', () => {
    for (const [boundaryHeight, top, height, expansion, availableHeight, edge] of [
        [160, 40, 142, 'up', 136, 173],
        [160, 26, 142, 'down', 136, 37],
        [105.75, 39, 90.75, 'up', 81, 118.75],
    ]) {
        const fixture = createGeometryFixture({ stableContentPosition: true, stableContentWidth: 420 });
        try {
            fixture.window.innerHeight = 25 + boundaryHeight;
            Object.assign(fixture.boundary, { top: 25, height: boundaryHeight + 100 });
            Object.assign(fixture.anchorBounds, { top, height });
            Object.assign(fixture.size, { width: 330, height: 44 });
            fixture.open();
            const element = fixture.element();
            const compact = element.getBoundingClientRect();
            assert.equal(element.dataset.expansion, expansion);
            assert.equal(element.style.getPropertyValue('--anchored-popup-available-height'), `${availableHeight}px`);
            assert.equal(expansion === 'up' ? compact.bottom : compact.top, edge);
            assert.equal(compact.height, 44);

            for (const contentHeight of [300, 44, 1000]) {
                fixture.size.width = contentHeight === 44 ? 330 : 420;
                fixture.size.height = contentHeight;
                fixture.reposition();
                const rect = element.getBoundingClientRect();
                assert.equal(expansion === 'up' ? rect.bottom : rect.top, edge);
                assert.equal(rect.left, compact.left);
                assert.equal(element.dataset.expansion, expansion);
                assert.equal(rect.height, Math.min(contentHeight, availableHeight));
                assert.ok(rect.top >= 37);
                assert.ok(rect.bottom <= fixture.window.innerHeight - 12);
            }
        }
        finally {
            fixture.dispose();
        }
    }
});

test('stable content rebases the reserved edge after a large selection moves or the window shrinks', () => {
    const fixture = createGeometryFixture({
        stableContentPosition: true,
        stableContentWidth: 420,
        viewportPadding: 16,
    });
    try {
        Object.assign(fixture.boundary, { left: 200, top: 25, width: 704, height: 592 });
        Object.assign(fixture.anchorBounds, { left: 224, top: 73.5, width: 656, height: 539.55 });
        Object.assign(fixture.size, { width: 330, height: 44 });
        fixture.open();
        const element = fixture.element();
        assert.equal(element.getBoundingClientRect().bottom, 201);
        fixture.size.height = 300;
        fixture.reposition();

        Object.assign(fixture.anchorBounds, { top: 473, height: 59 });
        fixture.reposition();
        assert.equal(element.dataset.expansion, 'up');
        assert.equal(element.getBoundingClientRect().bottom, 463);
        assert.equal(element.getBoundingClientRect().height, 300);
        fixture.size.height = 44;
        fixture.reposition();
        assert.equal(element.getBoundingClientRect().top, 419);

        fixture.size.height = 300;
        Object.assign(fixture.boundary, { top: 450, height: 167 });
        fixture.observers[0].callback();
        assert.equal(element.dataset.expansion, 'down');
        assert.equal(element.getBoundingClientRect().top, 466);
        assert.equal(element.style.getPropertyValue('--anchored-popup-available-height'), '135px');

        fixture.window.innerHeight = 550;
        fixture.window.dispatchEvent(new fixture.window.Event('resize'));
        assert.equal(element.dataset.expansion, 'up');
        assert.equal(element.getBoundingClientRect().bottom, 534);
        assert.equal(element.getBoundingClientRect().top, 466);
        assert.equal(element.style.getPropertyValue('--anchored-popup-available-height'), '68px');
        fixture.size.height = 44;
        fixture.reposition();
        assert.equal(element.getBoundingClientRect().bottom, 534);
        assert.equal(element.getBoundingClientRect().height, 44);
    }
    finally {
        fixture.dispose();
    }
});

test('stable content chooses the roomier side when neither side has 160px', () => {
    for (const [anchorTop, expansion, compactTop] of [
        [218, 'down', 208],
        [220, 'up', 212],
        [222, 'up', 212],
    ]) {
        const fixture = createGeometryFixture({ stableContentPosition: true });
        fixture.boundary.height = 300;
        fixture.anchorBounds.top = anchorTop;
        fixture.open();
        const element = fixture.element();
        const compact = element.getBoundingClientRect();
        assert.equal(element.dataset.expansion, expansion);
        assert.equal(compact.top, compactTop);
        assert.equal(element.style.getPropertyValue('--anchored-popup-available-height'), '160px');
        fixture.size.height = 1000;
        fixture.reposition();
        const expanded = element.getBoundingClientRect();
        assert.ok(expanded.top >= 92);
        assert.ok(expanded.bottom <= 368);
        assert.equal(expanded.height, 160);
        if (expansion === 'up') assert.equal(expanded.bottom, compact.bottom);
        else assert.equal(expanded.top, compact.top);
        fixture.dispose();
    }
});

test('stable content clamps the compact toolbar into very short boundaries', () => {
    for (const [boundaryHeight, anchorTop, expansion, compactTop, compactBottom] of [
        [80, 100, 'down', 92, 132],
        [80, 116, 'up', 108, 148],
        [40, 100, 'up', 92, 108],
    ]) {
        const fixture = createGeometryFixture({ stableContentPosition: true });
        fixture.boundary.height = boundaryHeight;
        fixture.anchorBounds.top = anchorTop;
        fixture.open();
        const element = fixture.element();
        const compact = element.getBoundingClientRect();
        assert.equal(element.dataset.expansion, expansion);
        assert.equal(compact.top, compactTop);
        assert.equal(compact.bottom, compactBottom);
        fixture.size.height = 1000;
        fixture.reposition();
        const expanded = element.getBoundingClientRect();
        assert.ok(expanded.top >= 92);
        assert.ok(expanded.bottom <= 80 + boundaryHeight - 12);
        assert.equal(expanded.height, boundaryHeight - 24);
        if (expansion === 'up') assert.equal(expanded.bottom, compact.bottom);
        else assert.equal(expanded.top, compact.top);
        fixture.dispose();
    }
});

test('stable content keeps its left edge unless a wider panel requires a bounds clamp', () => {
    const fixture = createGeometryFixture({ stableContentPosition: true });
    fixture.open();
    const element = fixture.element();
    assert.equal(element.style.left, '340px');

    fixture.size.width = 500;
    fixture.reposition();
    assert.equal(element.style.left, '340px');
    fixture.size.width = 600;
    fixture.reposition();
    assert.equal(element.style.left, '288px');
    assert.equal(element.getBoundingClientRect().right, 888);
    assert.equal(element.style.getPropertyValue('--anchored-popup-arrow-left'), '142px');
    fixture.size.width = 1000;
    fixture.reposition();
    assert.equal(element.getBoundingClientRect().left, 112);
    assert.equal(element.getBoundingClientRect().right, 888);
    fixture.size.width = 180;
    fixture.reposition();
    assert.equal(element.style.left, '340px');
    fixture.dispose();
});

test('stable content reserves expansion width near the right boundary before a panel opens', () => {
    const fixture = createGeometryFixture({ stableContentPosition: true, stableContentWidth: 420 });
    fixture.anchorBounds.left = 820;
    fixture.size.width = 330;
    fixture.open();
    const element = fixture.element();
    const compact = element.getBoundingClientRect();
    assert.equal(compact.left, 468);
    for (const width of [420, 330, 380, 420, 330]) {
        fixture.size.width = width;
        fixture.size.height = width === 330 ? 40 : 280;
        fixture.reposition();
        const rect = element.getBoundingClientRect();
        assert.equal(rect.left, compact.left);
        assert.equal(rect.bottom, compact.bottom);
        assert.equal(element.dataset.expansion, 'up');
        assert.ok(rect.right <= 888);
    }
    fixture.dispose();
});

test('stable content does not round a fractional right-edge clamp out of bounds', () => {
    const fixture = createGeometryFixture({ stableContentPosition: true, stableContentWidth: 420 });
    fixture.boundary.left = 100.25;
    fixture.boundary.width = 799.5;
    fixture.anchorBounds.left = 820;
    fixture.size.width = 330;
    fixture.open();
    const element = fixture.element();
    assert.equal(element.getBoundingClientRect().left, 467.75);
    fixture.size.width = 420;
    fixture.reposition();
    assert.equal(element.getBoundingClientRect().left, 467.75);
    assert.equal(element.getBoundingClientRect().right, 887.75);
    fixture.dispose();
});

test('stable content reserves only the width that fits inside a narrow reader', () => {
    const fixture = createGeometryFixture({ stableContentPosition: true, stableContentWidth: 420 });
    fixture.boundary.width = 300;
    fixture.size.width = 180;
    fixture.open();
    const element = fixture.element();
    const compactLeft = element.getBoundingClientRect().left;
    fixture.size.width = 420;
    fixture.reposition();
    const expanded = element.getBoundingClientRect();
    assert.equal(expanded.left, compactLeft);
    assert.equal(expanded.left, 112);
    assert.equal(expanded.right, 388);
    fixture.dispose();
});

test('stable content follows anchor movement using the original compact dimensions', () => {
    const fixture = createGeometryFixture({ stableContentPosition: true });
    fixture.open();
    fixture.size.width = 400;
    fixture.size.height = 300;
    fixture.reposition();
    fixture.anchorBounds.left += 60;
    fixture.anchorBounds.top += 60;
    fixture.reposition();
    const element = fixture.element();
    assert.equal(element.style.left, '400px');
    assert.equal(element.getBoundingClientRect().bottom, 350);
    assert.equal(element.dataset.expansion, 'up');

    fixture.size.width = 180;
    fixture.size.height = 40;
    fixture.reposition();
    assert.equal(element.style.left, '400px');
    assert.equal(element.getBoundingClientRect().top, 310);

    fixture.size.height = 300;
    fixture.anchorBounds.top = 200;
    fixture.reposition();
    assert.equal(element.dataset.expansion, 'down');
    assert.equal(element.getBoundingClientRect().top, 230);
    assert.equal(element.style.bottom, '');
    fixture.size.height = 40;
    fixture.reposition();
    assert.equal(element.getBoundingClientRect().top, 230);
    fixture.dispose();
});

test('stable content rebases on reader resize and disconnects boundary observers on close', () => {
    const fixture = createGeometryFixture({ stableContentPosition: true });
    fixture.open();
    fixture.size.height = 300;
    fixture.reposition();
    const observer = fixture.observers[0];
    assert.deepEqual(observer.targets, [fixture.parent, fixture.host]);
    Object.assign(fixture.boundary, { top: 220, height: 500 });
    observer.callback();
    const element = fixture.element();
    assert.equal(element.dataset.expansion, 'down');
    assert.equal(element.getBoundingClientRect().top, 330);
    assert.equal(element.style.getPropertyValue('--anchored-popup-available-height'), '378px');

    Object.assign(fixture.boundary, { top: 80, height: 290, width: 400 });
    observer.callback();
    const rect = element.getBoundingClientRect();
    assert.equal(element.dataset.expansion, 'up');
    assert.equal(rect.bottom, 290);
    assert.equal(element.style.getPropertyValue('--anchored-popup-available-height'), '198px');
    assert.equal(element.style.left, '308px');
    assert.ok(rect.top >= 92);
    assert.ok(rect.right <= 488);

    fixture.popup.close();
    assert.equal(observer.disconnected, true);
    fixture.dispose();
});

test('stable content tracks viewport resize and removes its resize listener when closed', () => {
    const fixture = createGeometryFixture({ stableContentPosition: true });
    fixture.anchorBounds.top = 650;
    const removed = [];
    const removeEventListener = fixture.window.removeEventListener.bind(fixture.window);
    fixture.window.removeEventListener = (type, listener) => {
        removed.push(type);
        removeEventListener(type, listener);
    };
    fixture.open();
    const element = fixture.element();
    const compactBottom = element.getBoundingClientRect().bottom;
    fixture.size.height = 300;
    fixture.window.innerHeight = 850;
    fixture.window.dispatchEvent(new fixture.window.Event('resize'));
    assert.equal(element.style.bottom, '210px');
    assert.equal(element.getBoundingClientRect().bottom, compactBottom);

    fixture.window.innerHeight = 400;
    fixture.window.dispatchEvent(new fixture.window.Event('resize'));
    assert.equal(element.dataset.expansion, 'up');
    assert.equal(element.getBoundingClientRect().bottom, 388);
    assert.equal(element.style.getPropertyValue('--anchored-popup-available-height'), '296px');
    fixture.popup.close();
    assert.ok(removed.includes('resize'));
    fixture.dispose();
});

test('stable content waits until mounted before recording its geometry', () => {
    const fixture = createGeometryFixture({
        stableContentPosition: true,
        repositionBeforeMount: true,
    });
    fixture.open();
    assert.equal(fixture.detachedMeasurements(), 0);
    assert.equal(fixture.element().getBoundingClientRect().top, 250);
    assert.equal(fixture.element().dataset.expansion, 'up');
    assert.equal(fixture.element().style.left, '340px');
    fixture.dispose();
});

test('stable content clears its compact size and fixed edge when reopened', () => {
    const fixture = createGeometryFixture({ stableContentPosition: true });
    fixture.anchorBounds.top = 650;
    fixture.open();
    assert.equal(fixture.element().dataset.expansion, 'up');
    fixture.popup.close();
    fixture.anchorBounds.top = 300;
    fixture.size.width = 300;
    fixture.size.height = 60;
    fixture.open();
    const element = fixture.element();
    assert.equal(element.dataset.expansion, 'up');
    assert.equal(element.getBoundingClientRect().top, 230);
    assert.equal(element.getBoundingClientRect().bottom, 290);
    assert.equal(element.style.left, '280px');
    assert.equal(element.style.bottom, '510px');
    fixture.dispose();
});

test('stable content stays inside the reader for anchors beyond either boundary edge', () => {
    for (const [left, top, expansion] of [[-200, -100, 'down'], [1000, 1000, 'up']]) {
        const fixture = createGeometryFixture({ stableContentPosition: true });
        Object.assign(fixture.anchorBounds, { left, top });
        fixture.open();
        fixture.size.width = 1200;
        fixture.size.height = 1200;
        fixture.reposition();
        const rect = fixture.element().getBoundingClientRect();
        assert.equal(fixture.element().dataset.expansion, expansion);
        assert.ok(rect.left >= 112);
        assert.ok(rect.top >= 92);
        assert.ok(rect.right <= 888);
        assert.ok(rect.bottom <= 708);
        fixture.dispose();
    }
});

test('other popups retain their default content-dependent position and placement', () => {
    for (const stableContentPosition of [undefined, false]) {
        const fixture = createGeometryFixture({ stableContentPosition });
        fixture.open();
        const element = fixture.element();
        assert.equal(element.style.top, '250px');
        assert.equal(element.style.left, '340px');
        assert.equal(element.dataset.placement, 'top');
        assert.equal(element.dataset.expansion, undefined);

        fixture.size.width = 400;
        fixture.size.height = 280;
        fixture.reposition();
        assert.equal(element.style.top, '330px');
        assert.equal(element.style.left, '230px');
        assert.equal(element.dataset.placement, 'bottom');
        fixture.size.width = 180;
        fixture.size.height = 40;
        fixture.reposition();
        assert.equal(element.style.top, '250px');
        assert.equal(element.style.left, '340px');
        assert.equal(element.dataset.placement, 'top');
        fixture.dispose();
    }
});
