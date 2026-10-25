import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createAnnotationPopup } from '../src/editor/annotation-popup.js';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function flush() {
    return new Promise(resolve => setImmediate(resolve));
}

function createPopupFixture(options = {}) {
    const dom = new JSDOM('<!doctype html><div id="popup-parent"></div>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const parent = document.querySelector('#popup-parent');
    const anchor = document.createElement('span');
    parent.appendChild(anchor);
    const popup = createAnnotationPopup(parent, options);
    const openSelection = () => popup.openSelection({
        anchor,
        selection: {
            text: 'Selected text',
            ranges: [{ from: 0, to: 13 }],
        },
        selectionContext: { side: 'source' },
    });
    return { dom, document, parent, popup, openSelection };
}

const colorButtons = parent => [
    ...parent.querySelectorAll('.mktero-annotation-color-button'),
];

test('keeps highlight colors disabled when an automatic translation finishes during a create', async () => {
    const creates = [];
    const translation = deferred();
    const fixture = createPopupFixture({
        createMarkdownAnnotation: () => {
            const pending = deferred();
            creates.push(pending);
            return pending.promise;
        },
        translateSelection: () => translation.promise,
        shouldAutoTranslateSelection: () => true,
    });
    const { dom, parent, popup } = fixture;
    const timers = [];
    dom.window.setTimeout = callback => {
        timers.push(callback);
        return timers.length;
    };
    dom.window.clearTimeout = () => {};
    fixture.openSelection();

    colorButtons(parent)[0].click();
    assert.equal(creates.length, 1);
    // The automatic translation was scheduled when the popup opened.
    for (const callback of timers.splice(0)) callback();
    translation.resolve({ text: 'Translated' });
    await flush();

    assert.ok(colorButtons(parent).every(button => button.disabled));
    colorButtons(parent)[2].click();
    assert.equal(creates.length, 1);

    creates[0].reject(new Error('store failed'));
    await flush();
    assert.ok(colorButtons(parent).every(button => !button.disabled));
    assert.equal(
        parent.querySelector('.mktero-annotation-action-error').hidden,
        false
    );

    popup.destroy();
    dom.window.close();
});

test('reports a highlight create failure after its popup was closed', async () => {
    const pending = deferred();
    const reported = [];
    const fixture = createPopupFixture({
        createMarkdownAnnotation: () => pending.promise,
        onDetachedActionError: (messageKey, error) => {
            reported.push({ messageKey, error });
        },
    });
    const { dom, parent, popup, openSelection } = fixture;
    openSelection();
    colorButtons(parent)[0].click();

    // An annotation refresh or an outside click closed the popup.
    popup.close();
    const failure = new Error('store failed');
    pending.reject(failure);
    await flush();

    assert.deepEqual(reported, [{
        messageKey: 'annotation.createFailed',
        error: failure,
    }]);
    assert.equal(parent.querySelector('.mktero-annotation-popup'), null);

    popup.destroy();
    dom.window.close();
});

test('keeps a newer popup open when an older highlight create finishes', async () => {
    const pending = deferred();
    const fixture = createPopupFixture({
        createMarkdownAnnotation: () => pending.promise,
        onDetachedActionError: () => assert.fail('nothing failed'),
    });
    const { dom, parent, popup, openSelection } = fixture;
    openSelection();
    colorButtons(parent)[0].click();

    const nextAnchor = dom.window.document.createElement('span');
    parent.appendChild(nextAnchor);
    popup.openSelection({
        anchor: nextAnchor,
        selection: { text: 'Next', ranges: [{ from: 20, to: 24 }] },
        selectionContext: { side: 'source' },
    });
    pending.resolve({ id: 'mktero-local-1' });
    await flush();

    assert.equal(popup.isSelectionOpen(), true);

    popup.destroy();
    dom.window.close();
});

test('shows a localized hint when a selection has no original text', () => {
    const fixture = createPopupFixture();
    const { dom, parent, popup } = fixture;
    const anchor = parent.querySelector('span');

    popup.openSelectionHint({ anchor });

    const hint = parent.querySelector('.mktero-annotation-selection-hint');
    assert.ok(hint);
    assert.equal(
        hint.textContent,
        'Highlights, notes and translation work on the original text only.'
    );
    assert.equal(
        parent.querySelector('.mktero-markdown-selection-actions'),
        null
    );
    assert.equal(popup.isSelectionOpen(), false);
    popup.close();
    assert.equal(parent.querySelector('.mktero-annotation-selection-hint'), null);

    popup.destroy();
    dom.window.close();
});

test('announces the original-text hint through a status region that already exists', () => {
    const fixture = createPopupFixture();
    const { dom, parent, popup } = fixture;
    const anchor = parent.querySelector('span');
    const status = parent.querySelector('.mktero-annotation-popup-status');
    assert.ok(status, 'the live region exists before any hint opens');
    assert.equal(status.getAttribute('role'), 'status');
    assert.equal(status.getAttribute('aria-live'), 'polite');
    assert.equal(status.textContent, '');

    popup.openSelectionHint({ anchor });

    const dialog = parent.querySelector('.mktero-annotation-popup--hint');
    assert.equal(dialog.getAttribute('aria-label'), 'Original text only');
    assert.equal(
        parent.querySelector('.mktero-annotation-popup-status'),
        status,
        'the same live region announces the hint'
    );
    assert.equal(
        status.textContent,
        'Highlights, notes and translation work on the original text only.'
    );
    assert.equal(
        parent.querySelector('.mktero-annotation-selection-hint')
            .getAttribute('aria-live'),
        null,
        'the visible hint is not a second live region'
    );
    assert.equal(popup.isSelectionHintOpen(), true);

    popup.close();
    assert.equal(popup.isSelectionHintOpen(), false);
    assert.equal(status.textContent, '');

    popup.destroy();
    dom.window.close();
});

test('keeps a newer popup open when an older draft note save finishes', async () => {
    const pending = deferred();
    const fixture = createPopupFixture({
        createMarkdownAnnotation: () => pending.promise,
    });
    const { dom, document, parent, popup, openSelection } = fixture;
    openSelection();
    parent.querySelector('.mktero-annotation-note-button').click();
    const input = parent.querySelector('.mktero-annotation-note-input');
    input.value = 'Draft';
    parent.querySelector('.mktero-annotation-note-save').click();

    const nextAnchor = document.createElement('span');
    parent.appendChild(nextAnchor);
    popup.openSelection({
        anchor: nextAnchor,
        selection: { text: 'Next', ranges: [{ from: 20, to: 24 }] },
        selectionContext: { side: 'source' },
    });
    assert.equal(popup.isSelectionOpen(), true);
    pending.resolve({ id: 'mktero-local-1' });
    await flush();

    assert.equal(popup.isSelectionOpen(), true);
    assert.ok(parent.querySelector('.mktero-markdown-selection-actions'));

    popup.destroy();
    dom.window.close();
});

test('logs a PDF source failure once after its popup was closed', async () => {
    const pending = deferred();
    const logged = [];
    const reported = [];
    const fixture = createPopupFixture({
        openSourceLocation: () => pending.promise,
        onSourceNavigationError: error => logged.push(error),
        onDetachedActionError: (messageKey, error) => {
            reported.push({ messageKey, error });
            if (error) logged.push(error);
        },
    });
    const { dom, parent, popup } = fixture;
    popup.openSelection({
        anchor: parent.querySelector('span'),
        selection: { text: 'Selected text', ranges: [{ from: 0, to: 13 }] },
        selectionContext: { side: 'source' },
        sourceLocation: { pageIndex: 0 },
    });
    parent.querySelector('.mktero-annotation-source-button').click();

    popup.close();
    const failure = new Error('reader unavailable');
    pending.reject(failure);
    await flush();

    assert.deepEqual(logged, [failure]);
    assert.equal(reported.length, 1);
    assert.equal(reported[0].messageKey, 'source.navigationFailed');

    popup.destroy();
    dom.window.close();
});

test('shows a localized message for a selection with too many segments', async () => {
    const fixture = createPopupFixture({
        createMarkdownAnnotation: async () => {
            const error = new Error('too many segments');
            error.code = 'MKTERO_ANNOTATION_TOO_MANY_SEGMENTS';
            throw error;
        },
    });
    const { dom, parent, popup, openSelection } = fixture;
    openSelection();
    colorButtons(parent)[0].click();
    await flush();

    const error = parent.querySelector('.mktero-annotation-action-error');
    assert.equal(error.hidden, false);
    assert.equal(
        error.textContent,
        'This selection has too many separate parts to highlight. Select a shorter passage.'
    );

    popup.destroy();
    dom.window.close();
});
