import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createAnnotationPopup } from '../src/editor/annotation-popup.js';
import { createTranslationSourcePopup } from '../src/editor/translation-source-popup.js';
import { createLocalization } from '../src/i18n/localization.js';

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
    return { dom, document, parent, anchor, popup, openSelection };
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
        'Highlights, comments and translation work on the original text only.'
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
        'Highlights, comments and translation work on the original text only.'
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

function addToNoteButton(parent) {
    return parent.querySelector('.mktero-annotation-add-to-note-button');
}

function finishPopup(fixture) {
    fixture.popup.destroy();
    fixture.dom.window.close();
}

test('locates an offscreen original only on request and keeps the annotation action independent', async () => {
    const calls = [];
    const saving = deferred();
    const fixture = createPopupFixture({
        createMarkdownAnnotation: (...args) => {
            calls.push(args);
            return saving.promise;
        },
    });
    const { anchor, parent, popup } = fixture;
    const annotation = { text: 'Original passage', ranges: [{ from: 0, to: 16 }] };
    const selectionContext = { side: 'source', rangesAreSource: true };
    const open = () => popup.openSourceBlockActions({
        anchor, annotation, selectionContext,
        offscreen: 'above',
        revealSource: (...args) => calls.push({
            args,
            closed: !parent.querySelector('[role="dialog"]'),
        }),
    });

    open();
    assert.match(parent.textContent, /above the visible area/);
    const locate = parent.querySelector('[data-action="locate-source"]');
    assert.equal(locate.textContent, 'Locate original text');
    assert.deepEqual(calls, []);
    locate.click();
    assert.deepEqual(calls, [{ args: [], closed: true }]);

    open();
    const nextLocate = parent.querySelector('[data-action="locate-source"]');
    parent.querySelector('.mktero-related-source-create').click();
    assert.equal(nextLocate.disabled, true);
    nextLocate.click();
    saving.resolve();
    await flush();
    assert.deepEqual(calls, [
        { args: [], closed: true }, [annotation, selectionContext],
    ]);
    assert.equal(parent.querySelector('[role="dialog"]'), null);
    finishPopup(fixture);
});

test('keeps localized source navigation available above the eight-block annotation limit', () => {
    const localization = createLocalization({ zoteroLocale: 'zh-CN' });
    const calls = [];
    const fixture = createPopupFixture({
        localization,
        createMarkdownAnnotation: () => calls.push('annotate'),
    });
    const { anchor, parent, popup } = fixture;
    const reason = localization.t('annotation.sourceBlockUnavailable', { count: 8 });
    popup.openSourceBlockActions({
        anchor,
        blockCount: 9,
        annotation: null,
        annotationUnavailable: reason,
        offscreen: 'below',
        revealSource: () => calls.push('locate'),
    });

    const unavailable = parent.querySelector('.mktero-related-source-unavailable');
    assert.equal(unavailable.textContent, reason);
    assert.match(parent.textContent, /\u53ef\u89c1\u533a\u57df\u4e0b\u65b9/u);
    const buttons = [...parent.querySelectorAll('button')];
    assert.deepEqual(buttons.map(button => button.textContent), ['\u5b9a\u4f4d\u539f\u6587']);
    assert.deepEqual(calls, []);
    buttons[0].click();
    assert.deepEqual(calls, ['locate']);
    assert.equal(parent.querySelector('[role="dialog"]'), null);
    finishPopup(fixture);
});

test('omits offscreen controls without both a direction and a locate callback', () => {
    const fixture = createPopupFixture();
    const { anchor, parent, popup } = fixture;
    const revealSource = () => assert.fail('no navigation was requested');
    for (const options of [
        {},
        { revealSource },
        { offscreen: 'above' },
        { offscreen: 'unknown', revealSource },
    ]) {
        popup.openSourceBlockActions({
            anchor, annotation: { text: 'Original' }, ...options,
        });
        assert.doesNotMatch(parent.textContent, /visible area/);
        const buttons = [...parent.querySelectorAll('button')];
        assert.deepEqual(buttons.map(button => button.textContent), [
            'Annotate the whole original block',
        ]);
    }
    finishPopup(fixture);
});

test('full translation shows the original and locates it in Bilingual without a direction', async () => {
    const dom = new JSDOM('<!doctype html><main><span></span></main>');
    const parent = dom.window.document.querySelector('main');
    const calls = [];
    const popup = createTranslationSourcePopup(parent, {
        createMarkdownAnnotation: annotation => calls.push(['annotate', annotation]),
        revealSource: source => calls.push(['locate', source]),
    });
    const source = { text: 'Original sentence.' };
    const annotation = { text: 'Whole original block.' };
    const open = () => popup.open({
        anchor: parent.querySelector('span'),
        source,
        offscreen: 'above',
        annotation,
    });
    open();

    const original = parent.querySelector('.mktero-translation-source-text');
    assert.equal(original.textContent, source.text);
    assert.doesNotMatch(parent.textContent, /visible area/);
    const buttons = [...parent.querySelectorAll('button')];
    assert.deepEqual(buttons.map(button => button.textContent), [
        'Annotate the whole original block', 'Locate in Bilingual',
    ]);
    buttons[0].click();
    await flush();
    assert.equal(parent.querySelector('[role="dialog"]'), null);
    open();
    parent.querySelector('[data-action="locate-source"]').click();
    assert.deepEqual(calls, [['annotate', annotation], ['locate', source]]);
    assert.equal(parent.querySelector('[role="dialog"]'), null);
    popup.destroy();
    dom.window.close();
});

function createLegacyPopupFixture(mode, options = {}) {
    const fixture = createPopupFixture(options);
    const { parent, anchor, popup } = fixture;
    const sourcePopup = createTranslationSourcePopup(parent, options);
    const open = args => (mode === 'bilingual'
        ? popup.openSourceBlockActions({ anchor, ...args })
        : sourcePopup.open({ anchor, ...args }));
    const action = (name, within = parent) => within.querySelector(`[data-action="${name}"]`);
    const dialog = () => parent.querySelector('[role="dialog"]');
    return {
        ...fixture, open, action, dialog, sourcePopup,
        finish() {
            sourcePopup.destroy();
            finishPopup(fixture);
        },
    };
}

for (const mode of ['bilingual', 'translated']) {
    test(`${mode}: unaligned blocks have independent controls without automatically showing source or requesting AI`, () => {
        const calls = [];
        const fixture = createLegacyPopupFixture(mode, {
            revealSource: () => assert.fail('no exact source to locate'),
            createMarkdownAnnotation: () => assert.fail('no annotation requested'),
        });
        const { open, action, dialog } = fixture;
        const first = {
            id: 'first',
            onShowBlock: () => {
                calls.push('show first');
                return 'Original <first> block.';
            },
            onEnableAlignment: () => assert.fail('do not request alignment'),
        };
        const second = {
            id: 'second',
            onShowBlock: () => calls.push('show second'),
        };
        open({ legacyActions: [first, second, first] });

        assert.deepEqual(calls, []);
        const rows = [...dialog().querySelectorAll('[data-translation-block-id]')];
        assert.deepEqual(rows.map(row => row.dataset.translationBlockId), ['first', 'second']);
        assert.ok(action('enable-alignment', rows[0]));
        assert.equal(action('enable-alignment', rows[1]), null);
        assert.equal(action('locate-source'), null);
        assert.equal(dialog().querySelector('.mktero-related-source-scope'), null);
        assert.equal(dialog().querySelector('.mktero-translation-source-text'), null);
        assert.match(rows[0].textContent, /only this original block to your configured AI provider/);
        assert.match(rows[0].textContent, /may incur charges.*replaces this block/);

        action('show-source-block', rows[0]).click();
        assert.equal(rows[0].querySelector('.mktero-translation-source-text').textContent,
            'Original <first> block.');
        assert.equal(rows[0].querySelector('first'), null);
        assert.equal(rows[1].querySelector('.mktero-translation-source-text'), null);
        action('show-source-block', rows[1]).click();
        assert.deepEqual(calls, ['show first', 'show second']);
        assert.equal(fixture.parent.querySelectorAll('[role="dialog"]').length, 1);
        fixture.finish();
    });

    test(`${mode}: cancellation ignores a late request and failures can be retried`, async () => {
        const requests = [];
        const fixture = createLegacyPopupFixture(mode);
        const { open, action, dialog } = fixture;
        open({ legacyActions: [{
            id: 'first',
            onShowBlock: () => assert.fail('not viewing source'),
            onEnableAlignment: ({ signal }) => {
                const request = deferred();
                requests.push({ signal, ...request });
                return request.promise;
            },
        }] });
        const enable = action('enable-alignment');
        const cancel = action('cancel-alignment');
        enable.focus();
        enable.click();
        enable.click();
        assert.equal(requests.length, 1);
        assert.equal(enable.disabled, true);
        assert.equal(cancel.hidden, false);
        assert.equal(fixture.document.activeElement, cancel);
        cancel.click();
        assert.equal(requests[0].signal.aborted, true);
        assert.match(dialog().textContent, /Cancelled.*existing translation was kept/);
        assert.equal(fixture.document.activeElement, enable);
        enable.click();
        requests[0].resolve(true);
        await flush();
        assert.match(dialog().textContent, /Retranslating this block/);
        requests[1].reject(new Error('private provider details'));
        await flush();
        assert.match(dialog().textContent, /Could not align this block.*existing translation was kept/);
        assert.doesNotMatch(dialog().textContent, /private provider details/);
        assert.equal(enable.textContent, 'Retry sentence alignment');
        assert.equal(enable.disabled, false);
        assert.equal(cancel.hidden, true);
        enable.click();
        requests[2].resolve(true);
        await flush();
        assert.match(dialog().textContent, /Sentence alignment enabled for this block/);
        assert.equal(enable.disabled, true);
        enable.click();
        assert.equal(requests.length, 3);
        fixture.finish();
    });

    test(`${mode}: Escape aborts a pending block and the next popup ignores its failure`, async () => {
        const request = deferred();
        let signal;
        const fixture = createLegacyPopupFixture(mode);
        const { dom, open, action, dialog } = fixture;
        open({ legacyActions: [{
            id: 'old',
            onShowBlock: () => {},
            onEnableAlignment: options => {
                signal = options.signal;
                return request.promise;
            },
        }] });
        action('enable-alignment').click();
        dialog().dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'Escape', bubbles: true,
        }));
        assert.equal(signal.aborted, true);
        assert.equal(dialog(), null);
        const nextAnchor = fixture.document.createElement('span');
        fixture.parent.append(nextAnchor);
        open({ anchor: nextAnchor, legacyActions: [{ id: 'new', onShowBlock() {} }] });
        request.reject(new Error('request aborted'));
        await flush();
        assert.equal(dialog().querySelector('[data-translation-block-id]').dataset.translationBlockId, 'new');
        assert.doesNotMatch(dialog().textContent, /Could not align/);
        fixture.finish();
    });
}

test('refreshing a bilingual selection updates source actions without interrupting its pending alignment', async () => {
    const fixture = createLegacyPopupFixture('bilingual');
    const { open, action, dialog } = fixture;
    const request = deferred();
    const calls = [];
    let signal;
    const legacyActions = [{
        id: 'legacy',
        onShowBlock: () => assert.fail('stale original callback'),
        onEnableAlignment: options => {
            signal = options.signal;
            return request.promise;
        },
    }];
    open({ legacyActions });
    const initialDialog = dialog();
    action('enable-alignment').click();
    open({
        legacyActions: [{ ...legacyActions[0], onShowBlock: () => calls.push('show source') }],
        offscreen: 'above',
        revealSource: () => calls.push('locate'),
    });
    assert.equal(dialog(), initialDialog);
    assert.equal(signal.aborted, false);
    assert.equal(action('enable-alignment').disabled, true);
    assert.match(dialog().textContent, /above the visible area/);
    action('show-source-block').click();
    request.resolve(true);
    await flush();
    assert.match(dialog().textContent, /Sentence alignment enabled/);
    assert.deepEqual(calls, ['show source']);
    fixture.finish();
});

test('bilingual scroll refresh cannot submit a duplicate while a whole-block save is pending', async () => {
    const request = deferred();
    const calls = [];
    const fixture = createLegacyPopupFixture('bilingual', {
        createMarkdownAnnotation: annotation => {
            calls.push(annotation);
            return request.promise;
        },
    });
    const { open, parent, dialog } = fixture;
    const annotation = { text: 'Original.' };
    open({ annotation });
    const initialDialog = dialog();
    parent.querySelector('.mktero-related-source-create').click();
    open({ annotation, offscreen: 'above', revealSource() {} });
    assert.equal(dialog(), initialDialog);
    const save = parent.querySelector('.mktero-related-source-create');
    assert.equal(save.disabled, true);
    assert.equal(parent.querySelector('[data-action="locate-source"]').disabled, true);
    save.click();
    assert.deepEqual(calls, [annotation]);
    request.resolve();
    await flush();
    assert.equal(dialog(), null);
    fixture.finish();
});

test('translated annotation is disabled without a save handler but source actions are still available', () => {
    const shown = [];
    const fixture = createLegacyPopupFixture('translated');
    const { open, action } = fixture;
    open({
        source: { text: 'Aligned sentence.' },
        annotation: { text: 'Aligned block.' },
        legacyActions: [{ id: 'legacy', onShowBlock: () => shown.push('legacy') }],
    });
    assert.equal(action('annotate-source').disabled, true);
    action('show-source-block').click();
    assert.deepEqual(shown, ['legacy']);
    fixture.finish();
});

test('a late translated annotation failure leaves the next popup alone', async () => {
    const request = deferred();
    const fixture = createLegacyPopupFixture('translated', {
        createMarkdownAnnotation: () => request.promise,
    });
    const { open, action, dialog, sourcePopup } = fixture;
    open({ annotation: { text: 'Previous block.' } });
    action('annotate-source').click();
    sourcePopup.close();
    open({ source: { text: 'New sentence.' }, annotation: { text: 'New block.' } });
    const nextDialog = dialog();
    request.reject(new Error('late save failure'));
    await flush();
    assert.equal(dialog(), nextDialog);
    assert.equal(dialog().querySelector('.mktero-annotation-action-error').hidden, true);
    assert.equal(action('annotate-source').disabled, false);
    fixture.finish();
});

test('mixed translated selection saves whole blocks on the first click without interrupting a pending alignment on failure', async () => {
    const localization = createLocalization({ zoteroLocale: 'zh-CN' });
    const calls = [];
    const failure = deferred();
    const alignment = deferred();
    let signal;
    const fixture = createLegacyPopupFixture('translated', {
        localization,
        createMarkdownAnnotation: (...args) => {
            calls.push(args);
            return calls.length === 1 ? failure.promise : Promise.resolve();
        },
        revealSource: () => assert.fail('no navigation requested'),
    });
    const { open, action, dialog, parent } = fixture;
    const annotation = { text: 'Both whole blocks.' };
    const selectionContext = { side: 'source', rangesAreSource: true };
    const sourceLabel = localization.t('ai.translationSourceCell');
    const blockCount = 2;
    open({
        source: { text: 'Exact source cell.' },
        sourceLabel,
        blockCount,
        annotation,
        selectionContext,
        legacyActions: [{
            id: 'legacy',
            onShowBlock: () => assert.fail('mixed selection must not read the whole block'),
            onEnableAlignment: options => {
                signal = options.signal;
                return alignment.promise;
            },
        }],
    });
    assert.equal(dialog().querySelector('.mktero-translation-source-label').textContent, sourceLabel);
    assert.equal(dialog().querySelector('.mktero-translation-source-text').textContent, 'Exact source cell.');
    assert.match(dialog().textContent, /\u4ec5\u5c06\u672c\u5757\u539f\u6587.*\u53ef\u80fd\u4ea7\u751f\u8d39\u7528/u);
    assert.equal(action('annotate-source').textContent,
        localization.t('annotation.sourceBlockHighlightPlural', { count: blockCount }));
    assert.equal(dialog().querySelector('.mktero-related-source-scope').textContent,
        localization.t('annotation.sourceBlockScopePlural', { count: blockCount }));
    action('enable-alignment').click();
    const originalDialog = dialog();
    const save = action('annotate-source');
    save.click();
    save.click();
    assert.deepEqual(calls, [[annotation, selectionContext]]);
    assert.equal(save.disabled, true);
    assert.equal(action('locate-source').disabled, true);
    assert.equal(dialog(), originalDialog);
    assert.equal(signal.aborted, false);
    failure.reject(new Error('private details'));
    await flush();
    assert.equal(parent.querySelectorAll('[role="dialog"]').length, 1);
    assert.equal(dialog(), originalDialog);
    const error = dialog().querySelector('.mktero-annotation-action-error');
    assert.equal(error.hidden, false);
    assert.equal(error.textContent, localization.t('annotation.createFailed'));
    assert.equal(save.disabled, false);
    assert.equal(action('locate-source').disabled, false);
    assert.equal(signal.aborted, false);
    save.click();
    await flush();
    assert.deepEqual(calls, [[annotation, selectionContext], [annotation, selectionContext]]);
    assert.equal(dialog(), null);
    assert.equal(signal.aborted, true);
    fixture.finish();
});

function openAddToNotePopup(kind, options) {
    const fixture = createPopupFixture(options);
    if (kind === 'selection') fixture.openSelection();
    else {
        fixture.popup.openActions({
            anchor: fixture.parent.querySelector('span'),
            annotation: {
                id: 'HIGH0001',
                type: 'highlight',
                text: 'Cited passage',
                color: '#ffd400',
                pageLabel: '2',
            },
        });
    }
    return fixture;
}

const ADD_TO_NOTE_ERROR_MESSAGES = [
    [
        'MKTERO_NOTE_EDITOR_UNAVAILABLE',
        'Open or create a note in the Notes column first.',
    ],
    [
        'MKTERO_NOTE_ANNOTATION_NOT_IN_PDF',
        'This annotation has not reached the PDF yet. Retry its sync first.',
    ],
    [
        'MKTERO_NOTE_SELECTION_NOT_LOCATED',
        'This passage could not be located in the PDF, so it cannot be cited in a note.',
    ],
];

for (const kind of ['selection', 'actions']) {
    const label = kind === 'selection' ? 'selection popup' : 'annotation popup';

    test(`hides Add to Note in the ${label} when notes are unavailable`, () => {
        const called = [];
        const fixture = openAddToNotePopup(kind, {
            addToNoteState: () => ({ status: 'hidden' }),
            addSelectionToNote: () => called.push('selection'),
            addAnnotationToNote: () => called.push('annotation'),
        });

        assert.equal(addToNoteButton(fixture.parent), null);
        assert.ok(fixture.parent.querySelector('.mktero-annotation-popup'));
        assert.deepEqual(called, []);

        finishPopup(fixture);
    });

    test(`explains a disabled Add to Note in the ${label} without acting`, () => {
        const called = [];
        const fixture = openAddToNotePopup(kind, {
            addToNoteState: () => ({
                status: 'disabled',
                reasonKey: 'notes.addToNoteNeedsNote',
            }),
            addSelectionToNote: () => called.push('selection'),
            addAnnotationToNote: () => called.push('annotation'),
        });
        const button = addToNoteButton(fixture.parent);

        assert.ok(button);
        assert.equal(button.getAttribute('data-action'), 'add-to-note');
        assert.equal(button.getAttribute('aria-disabled'), 'true');
        assert.equal(button.disabled, false);
        assert.equal(
            button.getAttribute('aria-label'),
            'Open or create a note in the Notes column first.'
        );
        button.click();

        const error = fixture.parent.querySelector('.mktero-annotation-action-error');
        assert.equal(error.hidden, false);
        assert.equal(
            error.textContent,
            'Open or create a note in the Notes column first.'
        );
        assert.ok(fixture.parent.querySelector('.mktero-annotation-popup'));
        assert.deepEqual(called, []);

        finishPopup(fixture);
    });

    test(`adds to the open note from the ${label} and closes`, async () => {
        const called = [];
        const fixture = openAddToNotePopup(kind, {
            addToNoteState: () => ({ status: 'enabled' }),
            addSelectionToNote: async (annotation, selectionContext) => {
                called.push({ annotation, selectionContext });
            },
            addAnnotationToNote: async annotationID => {
                called.push(annotationID);
            },
        });
        const button = addToNoteButton(fixture.parent);
        assert.equal(button.getAttribute('aria-disabled'), 'false');
        assert.equal(button.getAttribute('aria-label'), 'Add to Note');

        button.click();
        await flush();

        if (kind === 'selection') {
            assert.equal(called.length, 1);
            assert.equal(called[0].annotation.text, 'Selected text');
            assert.deepEqual(called[0].selectionContext, { side: 'source' });
        }
        else {
            assert.deepEqual(called, ['HIGH0001']);
        }
        assert.equal(fixture.parent.querySelector('.mktero-annotation-popup'), null);

        finishPopup(fixture);
    });
}

test('maps an Add to Note failure in both popups', async () => {
    for (const kind of ['selection', 'actions']) {
        for (const [code, message] of ADD_TO_NOTE_ERROR_MESSAGES) {
            const fixture = openAddToNotePopup(kind, {
                addToNoteState: () => ({ status: 'enabled' }),
                addSelectionToNote: async () => {
                    const error = new Error(code);
                    error.code = code;
                    throw error;
                },
                addAnnotationToNote: async () => {
                    const error = new Error(code);
                    error.code = code;
                    throw error;
                },
            });
            addToNoteButton(fixture.parent).click();
            await flush();

            const error = fixture.parent.querySelector(
                '.mktero-annotation-action-error'
            );
            assert.equal(error.hidden, false, `${kind} ${code}`);
            assert.equal(error.textContent, message, `${kind} ${code}`);
            assert.ok(
                fixture.parent.querySelector('.mktero-annotation-popup'),
                `${kind} ${code} keeps the popup open`
            );
            finishPopup(fixture);
        }
    }
});

function dispatchClipboardCopy(window, target) {
    const data = new Map();
    const event = new window.Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
        value: {
            setData: (type, value) => data.set(type, String(value)),
            getData: type => data.get(type) || '',
        },
    });
    target.dispatchEvent(event);
    return { event, data };
}

test('an empty note input copies the quote as a keyboard copy of it would', () => {
    const quotes = [];
    const fixture = createPopupFixture({
        createMarkdownAnnotation: async annotation => annotation,
        copyQuote: annotation => {
            quotes.push(annotation.text);
            return { text: 'Selected $x$ text', html: '<p>Selected <span class="math">$x$</span></p>' };
        },
    });
    const { dom, parent, popup, openSelection } = fixture;
    openSelection();
    parent.querySelector('.mktero-annotation-note-button').click();
    const input = parent.querySelector('.mktero-annotation-note-input');
    const { event, data } = dispatchClipboardCopy(dom.window, input);

    assert.equal(event.defaultPrevented, true);
    assert.deepEqual(quotes, ['Selected text']);
    assert.equal(data.get('text/plain'), 'Selected $x$ text');
    assert.match(data.get('text/html'), /class="math"/u);

    popup.destroy();
    dom.window.close();
});

test('an empty note input copies the plain quote when no copy is available', () => {
    for (const copyQuote of [() => null, () => { throw new Error('stale'); }, undefined]) {
        const fixture = createPopupFixture({
            createMarkdownAnnotation: async annotation => annotation,
            copyQuote,
        });
        const { dom, parent, popup, openSelection } = fixture;
        openSelection();
        parent.querySelector('.mktero-annotation-note-button').click();
        const input = parent.querySelector('.mktero-annotation-note-input');
        const { event, data } = dispatchClipboardCopy(dom.window, input);

        assert.equal(event.defaultPrevented, true);
        assert.equal(data.get('text/plain'), 'Selected text');
        assert.equal(data.has('text/html'), false);

        popup.destroy();
        dom.window.close();
    }
});
