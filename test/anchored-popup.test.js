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
