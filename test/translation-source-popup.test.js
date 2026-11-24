import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createTranslationSourcePopup } from '../src/editor/translation-source-popup.js';
import { createLocalization } from '../src/i18n/localization.js';

const localization = createLocalization({ zoteroLocale: 'zh-CN' });

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

function fixture(t, options = {}) {
    const dom = new JSDOM('<!doctype html><main><span></span></main>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const parent = document.querySelector('main');
    const anchor = parent.querySelector('span');
    const popup = createTranslationSourcePopup(parent, { localization, ...options });
    t.after(() => {
        popup.destroy();
        dom.window.close();
    });
    return {
        dom, document, parent, anchor, popup,
        open: (args = {}) => popup.open({ anchor, ...args }),
        action: name => parent.querySelector(`[data-action="${name}"]`),
        dialog: () => parent.querySelector('[role="dialog"]'),
        query: selector => parent.querySelector(selector),
    };
}

function visibleActions(parent) {
    return [...parent.querySelectorAll('button[data-action]')]
        .filter(button => !button.closest('[hidden]'))
        .map(button => button.dataset.action);
}

const source = { text: 'Matched original sentence.' };
const annotation = {
    text: 'Entire first original block.\n\nEntire second original block.',
    ranges: [{ from: 0, to: 28 }, { from: 30, to: 59 }],
};
const selectionContext = { side: 'source', rangesAreSource: true };

test('reviews the exact annotation text before saving once from the compact toolbar', async t => {
    const saved = [];
    const f = fixture(t, { createMarkdownAnnotation: draft => saved.push(draft), copyTranslation() {} });
    f.open({ source, annotation, selectionContext, translatedText: '译文', hasMappedSentences: true });
    assert.deepEqual(visibleActions(f.parent), ['review-source-annotation', 'preview-source', 'copy-translation']);
    const review = f.action('review-source-annotation');
    assert.equal(review.textContent, '标注对应原句');
    review.click();
    review.click();
    assert.deepEqual(saved, []);
    assert.equal(f.query('.mktero-translation-annotation-details').open, true);
    assert.equal(f.query('.mktero-translation-annotation-text').textContent, annotation.text);
    assert.equal(f.query('.mktero-translation-source-text'), null);
    const confirm = f.action('annotate-source');
    confirm.click();
    confirm.click();
    await flush();
    assert.deepEqual(saved, [annotation]);
});

test('opens only the compact toolbar without source text, scope or save controls', t => {
    const f = fixture(t, {
        copyTranslation: () => assert.fail('copy needs a click'),
        createMarkdownAnnotation: () => assert.fail('save needs a click'),
    });
    f.open({ source, annotation, translatedText: '译文' });

    assert.deepEqual(visibleActions(f.parent), ['preview-source', 'copy-translation']);
    assert.deepEqual([...f.query('.mktero-translation-source-toolbar').children]
        .map(button => button.textContent), ['查看原文', '复制译文']);
    assert.equal(f.query('.mktero-translation-source-text'), null);
    assert.equal(f.query('.mktero-translation-annotation-text'), null);
    assert.equal(f.query('.mktero-related-source-scope'), null);
    assert.equal(f.action('annotate-source'), null);
    assert.equal(f.query('.mktero-translation-source-preview'), null);
    assert.equal(f.query('.mktero-translation-source-more'), null);
    assert.equal(f.action('preview-source').getAttribute('aria-expanded'), 'false');
    assert.equal(f.action('source-more'), null);
});

for (const [locale, label] of [['zh-CN', '查看原文'], ['en-US', 'View original']]) {
    test(`${locale}: keeps the original preview label and icon stable while toggling`, t => {
        const f = fixture(t, { localization: createLocalization({ zoteroLocale: locale }) });
        f.open({ source, annotation });
        const button = f.action('preview-source');
        const icon = button.querySelector('svg');
        assert.equal(button.textContent, label);
        assert.equal(button.getAttribute('aria-expanded'), 'false');
        assert.equal(icon.getAttribute('aria-hidden'), 'true');
        button.click();
        assert.equal(button.textContent, label);
        assert.equal(button.getAttribute('aria-expanded'), 'true');
        assert.equal(button.querySelector('svg'), icon);
        button.click();
        assert.equal(button.textContent, label);
        assert.equal(button.getAttribute('aria-expanded'), 'false');
        assert.equal(f.query('.mktero-translation-source-preview').hidden, true);
        assert.equal(f.query('.mktero-translation-source-more'), null);
    });
}

test('omits unavailable copy and save capabilities', t => {
    const f = fixture(t);
    f.open({ source, translatedText: '译文' });
    assert.deepEqual(visibleActions(f.parent), ['preview-source']);
    f.action('preview-source').click();
    assert.equal(f.query('.mktero-translation-source-text').textContent, source.text);
    assert.equal(f.action('locate-source'), null);
    assert.equal(f.action('annotate-source'), null);
    assert.equal(f.action('source-more'), null);
    assert.equal(f.action('copy-translation'), null);
});

test('does not show copy without a nonempty current translation', t => {
    const f = fixture(t, { copyTranslation() {} });
    for (const translatedText of [undefined, '', '  \n ', null]) {
        f.open({ source, translatedText });
        assert.equal(f.action('copy-translation'), null);
    }
});

test('reveals the matched source on demand and closes before its selection locator runs', t => {
    const calls = [];
    const f = fixture(t, {
        revealSource: () => assert.fail('the current locator takes precedence'),
    });
    f.open({
        source,
        annotation,
        locateSource: (...args) => calls.push({ args, closed: !f.popup.isOpen() }),
    });
    const id = f.dialog().id;
    f.action('preview-source').click();
    assert.equal(f.dialog().id, id);
    assert.equal(f.action('preview-source').textContent, '查看原文');
    assert.equal(f.action('preview-source').getAttribute('aria-expanded'), 'true');
    assert.equal(f.query('.mktero-translation-source-label').textContent,
        localization.t('ai.translationSourceLabel'));
    assert.equal(f.query('.mktero-translation-source-text').textContent, source.text);
    assert.equal(f.action('annotate-source').disabled, true);
    assert.deepEqual(calls, []);
    f.action('locate-source').click();
    assert.deepEqual(calls, [{ args: [], closed: true }]);
});

for (const [locale, groupLabel, sentenceLabel] of [
    ['zh-CN', '原文（含句子组）', '本段对应的原文'],
    ['en-US', 'Original text (includes a sentence group)', 'Original for this passage'],
]) {
    test(`${locale}: identifies conservative sentence groups and clears the label on a new selection`, t => {
        const f = fixture(t, { localization: createLocalization({ zoteroLocale: locale }) });
        f.open({ source: { ...source, hasSentenceGroup: true }, previewExpanded: true });
        assert.equal(f.query('.mktero-translation-source-label').textContent, groupLabel);
        assert.equal(f.query('.mktero-translation-source-text').textContent, source.text);
        f.open({ source });
        assert.equal(f.query('.mktero-translation-source-label').textContent, sentenceLabel);
    });
}

test('keeps the constructor revealSource fallback and passes the current source after closing', t => {
    const calls = [];
    const f = fixture(t, {
        revealSource: original => calls.push({ original, closed: !f.popup.isOpen() }),
    });
    f.open({ source, previewExpanded: true });
    f.action('locate-source').click();
    assert.deepEqual(calls, [{ original: source, closed: true }]);
});

test('collapsing and reopening preview preserves its reviewed scope and popup', t => {
    const f = fixture(t);
    f.open({ source, annotation });
    const dialog = f.dialog();
    f.action('preview-source').click();
    const preview = f.query('.mktero-translation-source-preview');
    const details = f.query('details');
    assert.equal(preview.hidden, false);
    assert.equal(details.open, false);
    assert.equal(f.query('.mktero-translation-source-text').textContent, source.text);
    assert.equal(f.query('.mktero-translation-annotation-text').textContent, annotation.text);
    details.open = true;
    f.action('preview-source').click();
    assert.equal(preview.hidden, true);
    assert.equal(f.query('.mktero-translation-source').dataset.panel, 'collapsed');
    assert.equal(f.dialog(), dialog);
    assert.deepEqual(visibleActions(f.parent), ['preview-source']);
    f.action('preview-source').click();
    assert.equal(preview.hidden, false);
    assert.equal(f.query('details'), details);
    assert.equal(details.open, true);
    assert.equal(f.dialog(), dialog);
});

test('can open annotation-only actions without inventing a matched passage', t => {
    const f = fixture(t);
    f.open({ annotation });
    assert.deepEqual(visibleActions(f.parent), ['preview-source']);
    f.action('preview-source').click();
    assert.equal(f.query('.mktero-translation-annotation-text').textContent, annotation.text);
    assert.equal(f.query('details').open, false);
    assert.equal(f.query('.mktero-translation-source-text'), null);
    assert.equal(f.action('locate-source'), null);
    assert.equal(f.action('annotate-source').disabled, true);
});

test('allows copy-only selection actions and preserves the literal translated text', async t => {
    const copied = [];
    const f = fixture(t, { copyTranslation: text => copied.push(text) });
    const translatedText = '  译文 <img src=x onerror=alert(1)>\n$x$ &amp;  ';
    f.open({ translatedText });
    assert.deepEqual(visibleActions(f.parent), ['copy-translation']);
    f.action('copy-translation').click();
    await flush();
    assert.deepEqual(copied, [translatedText]);
    assert.equal(f.popup.isOpen(), true);
    assert.equal(f.query('.mktero-translation-source-status').textContent, '');
});

for (const sync of [true, false]) {
    test(`reports a ${sync ? 'synchronous' : 'rejected'} copy failure as status and permits retry`, async t => {
        let calls = 0;
        const f = fixture(t, {
            copyTranslation: () => {
                if (++calls > 1) return;
                const error = new Error('private clipboard detail');
                if (sync) throw error;
                return Promise.reject(error);
            },
        });
        f.open({ source, translatedText: '当前译文' });
        const dialog = f.dialog();
        f.action('copy-translation').click();
        await flush();
        const status = f.query('.mktero-translation-source-status');
        assert.equal(status.getAttribute('role'), 'status');
        assert.equal(status.getAttribute('aria-live'), 'polite');
        assert.equal(status.hidden, false);
        assert.equal(status.textContent, '复制译文失败，请重试。');
        assert.equal(f.action('copy-translation').disabled, false);
        assert.equal(f.dialog(), dialog);
        f.action('copy-translation').click();
        await flush();
        assert.equal(calls, 2);
        assert.equal(status.hidden, true);
        assert.equal(f.dialog(), dialog);
    });
}

test('prevents duplicate copy requests and ignores late failures after an anchor change', async t => {
    const request = deferred();
    const copies = [];
    const f = fixture(t, {
        copyTranslation: text => {
            copies.push(text);
            return request.promise;
        },
    });
    f.open({ source, translatedText: '旧译文' });
    const old = f.action('copy-translation');
    old.click();
    old.click();
    assert.equal(old.disabled, true);
    assert.deepEqual(copies, ['旧译文']);
    const nextAnchor = f.document.createElement('span');
    f.parent.appendChild(nextAnchor);
    f.open({ anchor: nextAnchor, source, translatedText: '新译文' });
    const dialog = f.dialog();
    request.reject(new Error('late failure'));
    await flush();
    old.click();
    assert.deepEqual(copies, ['旧译文']);
    assert.equal(f.query('.mktero-translation-source-status').hidden, true);
    assert.equal(f.action('copy-translation').disabled, false);
    assert.equal(f.dialog(), dialog);
});

test('opens legacy-only source controls inside Preview and never guesses sentence mappings', t => {
    const shown = [];
    const first = {
        id: 'first',
        onShowBlock: () => {
            shown.push('first');
            return 'Original <first> block.';
        },
    };
    const f = fixture(t, { revealSource: () => assert.fail('legacy has no matched source') });
    f.open({ wholeBlockActions: [first, first, { id: 'second', onShowBlock: () => shown.push('second') }] });
    assert.deepEqual(visibleActions(f.parent), ['preview-source']);
    assert.equal(f.action('show-source-block'), null);
    assert.deepEqual(shown, []);
    f.action('preview-source').click();
    assert.equal(f.query('.mktero-translation-source-text'), null);
    assert.equal(f.action('locate-source'), null);
    assert.deepEqual([...f.parent.querySelectorAll('[data-translation-block-id]')]
        .map(row => row.dataset.translationBlockId), ['first', 'second']);
    f.action('show-source-block').click();
    assert.deepEqual(shown, ['first']);
    assert.equal(f.query('.mktero-translation-source-text').textContent, 'Original <first> block.');
    assert.equal(f.query('first'), null);
    assert.equal(f.action('annotate-source'), null);
});

test('same-anchor refresh keeps preview and legacy row state while replacing stale callbacks and guards', t => {
    const f = fixture(t);
    const calls = [];
    let firstCurrent = true;
    f.open({
        wholeBlockActions: [{ id: 'legacy', onShowBlock: () => 'Already shown original.' }],
        isCurrent: () => firstCurrent,
    });
    f.action('preview-source').click();
    const dialog = f.dialog();
    const show = f.action('show-source-block');
    show.click();
    firstCurrent = false;
    f.open({
        wholeBlockActions: [{ id: 'legacy', onShowBlock: () => {
            calls.push('fresh legacy');
            return 'Fresh original.';
        } }],
        isCurrent: () => true,
    });
    assert.equal(f.dialog(), dialog);
    assert.equal(f.action('show-source-block'), show);
    assert.equal(f.query('.mktero-translation-source-preview').hidden, false);
    assert.equal(f.query('.mktero-translation-source-text').textContent, 'Already shown original.');
    show.click();
    assert.deepEqual(calls, ['fresh legacy']);
    assert.equal(f.query('.mktero-translation-source-text').textContent, 'Fresh original.');
});

test('same-anchor refresh updates current translation and both source navigation callbacks', async t => {
    const calls = [];
    const f = fixture(t, {
        copyTranslation: text => calls.push(['copy', text]),
        revealSource: original => calls.push(['fallback', original]),
    });
    let firstCurrent = true;
    f.open({
        source, translatedText: '旧译文',
        locateSource: () => assert.fail('stale locator'),
        isCurrent: () => firstCurrent,
        previewExpanded: true,
    });
    const locate = f.action('locate-source');
    firstCurrent = false;
    const nextSource = { text: 'Refreshed original.' };
    f.open({
        source: nextSource, translatedText: '新译文', isCurrent: () => true,
        locateSource: () => calls.push(['locate', !f.popup.isOpen()]),
    });
    assert.equal(f.action('locate-source'), locate);
    assert.equal(f.query('.mktero-translation-source-text').textContent, nextSource.text);
    f.action('copy-translation').click();
    await flush();
    locate.click();
    assert.deepEqual(calls, [['copy', '新译文'], ['locate', true]]);

    f.open({ source, previewExpanded: true, locateSource: () => assert.fail('superseded locator') });
    f.open({ source: nextSource });
    f.action('locate-source').click();
    assert.deepEqual(calls.at(-1), ['fallback', nextSource]);
});

test('applies previewExpanded only when first opening a selection anchor', t => {
    const f = fixture(t);
    f.open({ source, annotation });
    const dialog = f.dialog();
    f.open({ source, annotation, previewExpanded: true });
    assert.equal(f.query('.mktero-translation-source-preview'), null);
    f.action('preview-source').click();
    f.open({ source, annotation, previewExpanded: true });
    assert.equal(f.query('.mktero-translation-source-preview').hidden, false);
    f.action('preview-source').click();
    f.open({ source, annotation, previewExpanded: true });
    assert.equal(f.query('.mktero-translation-source-preview').hidden, true);
    assert.equal(f.dialog(), dialog);
    f.popup.close();
    f.open({ source, previewExpanded: true });
    assert.equal(f.query('.mktero-translation-source-preview').hidden, false);
    const nextAnchor = f.document.createElement('span');
    f.parent.appendChild(nextAnchor);
    f.open({ anchor: nextAnchor, source, annotation });
    assert.equal(f.query('.mktero-translation-source-preview'), null);
    assert.equal(f.query('.mktero-translation-source-more'), null);
    assert.notEqual(f.dialog(), dialog);
});

test('a fallback row rebuild keeps the current panel, popup and copy error', async t => {
    const f = fixture(t, { copyTranslation: () => { throw new Error('clipboard'); } });
    f.open({
        translatedText: '译文',
        wholeBlockActions: [{ id: 'old', onShowBlock: () => assert.fail('stale row') }],
    });
    f.action('preview-source').click();
    f.action('copy-translation').click();
    await flush();
    const oldShow = f.action('show-source-block');
    const dialog = f.dialog();
    f.open({
        translatedText: '译文',
        wholeBlockActions: [{ id: 'new', onShowBlock: () => 'Replacement original.' }],
    });
    assert.equal(f.dialog(), dialog);
    assert.equal(f.query('.mktero-translation-source-preview').hidden, false);
    assert.equal(f.query('.mktero-translation-source-status').hidden, false);
    oldShow.click();
    f.action('show-source-block').click();
    assert.equal(f.query('.mktero-translation-source-text').textContent, 'Replacement original.');
});

test('legacy action failures stay localized and can retry after a same-anchor refresh', t => {
    const f = fixture(t);
    f.open({
        previewExpanded: true,
        wholeBlockActions: [{ id: 'legacy', onShowBlock: () => { throw new Error('private detail'); } }],
    });
    const show = f.action('show-source-block');
    show.click();
    const error = f.query('.mktero-selection-translation-error');
    assert.equal(error.textContent, localization.t('ai.translationLegacyShowFailed'));
    f.open({ wholeBlockActions: [{ id: 'legacy', onShowBlock: () => 'Recovered original.' }] });
    assert.equal(f.query('.mktero-selection-translation-error'), error);
    assert.equal(error.textContent, localization.t('ai.translationLegacyShowFailed'));
    show.click();
    assert.equal(error.textContent, '');
    assert.equal(f.query('.mktero-translation-source-text').textContent, 'Recovered original.');
});

test('guards copy, locate, legacy and save with the latest isCurrent callback', async t => {
    const calls = [];
    const f = fixture(t, {
        copyTranslation: () => calls.push('copy'),
        revealSource: () => calls.push('fallback'),
        createMarkdownAnnotation: () => calls.push('save'),
    });
    let current = true;
    const args = {
        source, annotation, translatedText: '译文', isCurrent: () => current,
        locateSource: () => calls.push('locate'),
        wholeBlockActions: [{ id: 'legacy', onShowBlock: () => calls.push('legacy') }],
    };
    f.open({ ...args, previewExpanded: true });
    current = false;
    f.action('copy-translation').click();
    f.action('locate-source').click();
    f.action('show-source-block').click();
    f.action('annotate-source').click();
    f.action('preview-source').click();
    assert.equal(f.query('.mktero-translation-source').dataset.panel, 'preview');
    assert.deepEqual(calls, []);
    assert.equal(f.popup.isOpen(), true);
    await flush();
    assert.deepEqual(calls, []);
    f.open({ ...args, isCurrent: () => true });
    f.action('annotate-source').click();
    await flush();
    assert.deepEqual(calls, ['save']);
});

test('does not execute hidden panel actions', async t => {
    const calls = [];
    const f = fixture(t, {
        createMarkdownAnnotation: () => calls.push('save'),
        revealSource: () => calls.push('locate'),
    });
    f.open({ source, annotation, previewExpanded: true, wholeBlockActions: [{
        id: 'legacy', onShowBlock: () => calls.push('show block'),
    }] });
    const locate = f.action('locate-source');
    const show = f.action('show-source-block');
    const save = f.action('annotate-source');
    f.action('preview-source').click();
    locate.click();
    show.click();
    save.click();
    await flush();
    assert.deepEqual(calls, []);
    assert.equal(f.popup.isOpen(), true);
});

test('retains the pending save across refreshes, avoids duplicates and permits a failed save retry', async t => {
    const request = deferred();
    const calls = [];
    const f = fixture(t, {
        createMarkdownAnnotation: (...args) => {
            calls.push(args);
            return calls.length === 1 ? request.promise : undefined;
        },
        revealSource: () => assert.fail('locate disabled during save'),
    });
    let firstCurrent = true;
    f.open({ source, annotation, selectionContext, isCurrent: () => firstCurrent });
    f.action('preview-source').click();
    const save = f.action('annotate-source');
    const dialog = f.dialog();
    save.click();
    assert.equal(save.disabled, true);
    assert.equal(f.action('locate-source').disabled, true);
    firstCurrent = false;
    f.open({ source, annotation, selectionContext, isCurrent: () => true });
    assert.equal(f.action('annotate-source'), save);
    assert.equal(f.dialog(), dialog);
    assert.equal(f.query('.mktero-translation-source-preview').hidden, false);
    assert.equal(save.disabled, true);
    save.click();
    assert.deepEqual(calls, [[annotation, selectionContext]]);
    request.reject(new Error('private store failure'));
    await flush();
    const error = f.query('.mktero-annotation-action-error');
    assert.equal(error.hidden, false);
    assert.equal(error.textContent, localization.t('annotation.createFailed'));
    assert.equal(save.disabled, false);
    assert.equal(f.action('locate-source').disabled, false);
    f.action('preview-source').click();
    f.action('preview-source').click();
    assert.equal(error.hidden, false);
    save.click();
    await flush();
    assert.deepEqual(calls, [[annotation, selectionContext], [annotation, selectionContext]]);
    assert.equal(f.dialog(), null);
});

for (const succeeds of [true, false]) {
    test(`a late save ${succeeds ? 'success' : 'failure'} leaves a newer anchor untouched`, async t => {
        const request = deferred();
        const f = fixture(t, { createMarkdownAnnotation: () => request.promise });
        f.open({ annotation });
        f.action('preview-source').click();
        const oldSave = f.action('annotate-source');
        oldSave.click();
        const nextAnchor = f.document.createElement('span');
        f.parent.appendChild(nextAnchor);
        f.open({ anchor: nextAnchor, source, annotation });
        f.action('preview-source').click();
        const dialog = f.dialog();
        if (succeeds) request.resolve();
        else request.reject(new Error('late private failure'));
        await flush();
        oldSave.click();
        assert.equal(f.dialog(), dialog);
        assert.equal(f.action('annotate-source').disabled, false);
        assert.equal(f.query('.mktero-annotation-action-error').hidden, true);
    });
}

test('an expired save completion cannot close its popup', async t => {
    const request = deferred();
    const f = fixture(t, { createMarkdownAnnotation: () => request.promise });
    let current = true;
    f.open({ annotation, isCurrent: () => current });
    f.action('preview-source').click();
    f.action('annotate-source').click();
    current = false;
    request.resolve();
    await flush();
    assert.equal(f.popup.isOpen(), true);
});

test('renders untrusted matched and whole-block text literally, with distinct body classes', t => {
    const literal = '<img src=x onerror="alert(1)"><script>bad()</script> &amp;\n**text**';
    const fullText = `${literal}\n\n${'Full original block. '.repeat(200)}`;
    const f = fixture(t);
    f.open({ source: { text: literal }, annotation: { text: fullText }, previewExpanded: true });
    assert.equal(f.query('.mktero-translation-source-text').textContent, literal);
    const body = f.query('.mktero-translation-annotation-text');
    assert.equal(body.textContent, fullText);
    assert.equal(body.classList.contains('mktero-translation-source-text'), false);
    assert.equal(f.parent.querySelectorAll('img, script').length, 0);
});

test('allows eight whole blocks and keeps navigation available when annotation exceeds the cap', async t => {
    const calls = [];
    const f = fixture(t, {
        createMarkdownAnnotation: original => calls.push(original),
        revealSource: original => calls.push(['locate', original]),
    });
    const eightBlocks = { text: 'Eight complete original blocks.', ranges: Array.from({ length: 8 },
        (_, index) => ({ from: index * 10, to: index * 10 + 5 })) };
    f.open({ source, annotation: eightBlocks, blockCount: 8 });
    f.action('preview-source').click();
    assert.equal(f.action('annotate-source').disabled, false);
    f.action('annotate-source').click();
    await flush();
    assert.deepEqual(calls, [eightBlocks]);

    const reason = localization.t('annotation.sourceBlockUnavailable', { count: 8 });
    f.open({ source, annotationUnavailable: reason, blockCount: 9 });
    assert.deepEqual(visibleActions(f.parent), ['preview-source']);
    assert.equal(f.query('.mktero-translation-source-unavailable'), null);
    f.action('preview-source').click();
    assert.equal(f.query('.mktero-translation-source-unavailable').textContent, reason);
    assert.equal(f.query('.mktero-translation-source-unavailable').getAttribute('role'), 'status');
    assert.equal(f.action('annotate-source'), null);
    assert.equal(f.query('details'), null);
    f.action('locate-source').click();
    assert.deepEqual(calls, [eightBlocks, ['locate', source]]);
});

test('cannot save above eight blocks even when a caller provides an annotation', t => {
    const f = fixture(t, { createMarkdownAnnotation: () => assert.fail('over-cap save') });
    f.open({ source, annotation, blockCount: 9 });
    f.action('preview-source').click();
    assert.equal(f.action('annotate-source'), null);
    assert.equal(f.query('.mktero-translation-source-unavailable').textContent,
        localization.t('annotation.sourceBlockUnavailable', { count: 8 }));
});

test('Escape disconnects all actions and removes the anchor description', async t => {
    const f = fixture(t, {
        copyTranslation: () => assert.fail('detached copy'),
        revealSource: () => assert.fail('detached locator'),
        createMarkdownAnnotation: () => assert.fail('detached save'),
    });
    f.open({ source, annotation, translatedText: '译文', previewExpanded: true, wholeBlockActions: [{
        id: 'legacy', onShowBlock: () => assert.fail('detached legacy'),
    }] });
    const buttons = [...f.parent.querySelectorAll('button')];
    assert.equal(f.anchor.getAttribute('aria-describedby'), f.dialog().id);
    f.dialog().dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    for (const button of buttons) button.click();
    await flush();
    assert.equal(f.dialog(), null);
    assert.equal(f.anchor.hasAttribute('aria-describedby'), false);
    assert.equal(f.popup.isOpen(), false);
});

for (const [locale, previewLabel, saveLabel, scopeLabel] of [
    ['zh-CN', '查看原文', '保存到注释', '保存范围：2 个完整原文块'],
    ['en-US', 'View original', 'Save to Annotations', 'Save scope: 2 complete original blocks'],
]) {
    test(`${locale}: saves reviewed whole original blocks beside Locate in preview without a highlight entry`, async t => {
        const calls = [];
        const f = fixture(t, {
            localization: createLocalization({ zoteroLocale: locale }),
            copyTranslation() {},
            revealSource: () => assert.fail('saving must not locate'),
            createMarkdownAnnotation: (...args) => calls.push(args),
        });
        f.open({ source, annotation, selectionContext, blockCount: 2,
            translatedText: 'Translated selection only.' });
        assert.deepEqual(visibleActions(f.parent), ['preview-source', 'copy-translation']);
        assert.equal(f.action('preview-source').textContent, previewLabel);
        assert.equal(f.action('source-more'), null);
        assert.equal(f.action('annotate-source'), null);
        assert.equal(f.query('details'), null);
        f.action('preview-source').click();
        assert.equal(f.query('.mktero-translation-source-text').textContent, source.text);
        const save = f.action('annotate-source');
        const locate = f.action('locate-source');
        assert.equal(save.textContent, saveLabel);
        assert.equal(save.parentNode, locate.parentNode);
        assert.deepEqual([...save.parentNode.children].map(button => button.dataset.action),
            ['locate-source', 'annotate-source']);
        assert.equal(f.parent.querySelectorAll('[data-action="annotate-source"]').length, 1);
        assert.equal(f.query('.mktero-translation-source-more'), null);
        const details = f.query('details.mktero-translation-annotation-details');
        const scope = details.querySelector('summary.mktero-related-source-scope');
        assert.equal(details.open, false);
        assert.equal(scope.textContent, scopeLabel);
        assert.equal(scope.textContent, createLocalization({ zoteroLocale: locale })
            .t('ai.translationSourceSaveScopePlural', { count: 2 }));
        assert.equal(details.querySelector('.mktero-translation-annotation-text').textContent, annotation.text);
        assert.equal(f.query('.mktero-translation-source-preview > .mktero-translation-annotation-text'), null);
        const press = new f.dom.window.MouseEvent('mousedown', {
            button: 0, bubbles: true, cancelable: true,
        });
        scope.dispatchEvent(press);
        assert.equal(press.defaultPrevented, true, 'review must retain the translated selection');
        scope.click();
        assert.equal(details.open, true, 'native click must still expand the review');
        save.click();
        await flush();
        assert.deepEqual(calls, [[annotation, selectionContext]]);
        assert.equal(f.dialog(), null);
    });
}

test('starts a changed original excerpt at the top but preserves scrolling on a same-selection refresh', t => {
    const f = fixture(t);
    f.open({ source, previewExpanded: true });
    const body = f.query('.mktero-translation-source-text');
    body.scrollTop = 120;
    f.open({ source, previewExpanded: true });
    assert.equal(body.scrollTop, 120);
    f.open({ source: { text: 'New original passage.' }, previewExpanded: true });
    assert.equal(f.query('.mktero-translation-source-text'), body);
    assert.equal(body.scrollTop, 0);
    body.scrollTop = 75;
    f.open({ source: { text: 'New original passage.' }, previewExpanded: true });
    assert.equal(body.scrollTop, 75);
});

test('preview save uses a singular scope and details toggles reposition the popup', t => {
    const f = fixture(t, { createMarkdownAnnotation() {} });
    let positions = 0;
    f.anchor.getBoundingClientRect = () => {
        positions++;
        return { top: 300, bottom: 320, left: 200, right: 220, width: 20, height: 20 };
    };
    f.open({ source, annotation, previewExpanded: true });
    const details = f.query('details');
    assert.equal(details.querySelector('summary').textContent,
        localization.t('ai.translationSourceSaveScope'));
    const previous = positions;
    details.open = true;
    details.scrollTop = 5;
    details.dispatchEvent(new f.dom.window.Event('toggle'));
    assert.ok(positions > previous);
    assert.equal(details.scrollTop, 0, 'opening a save scope begins at its complete first line');
    details.scrollTop = 50;
    f.open({ source, annotation });
    assert.equal(details.scrollTop, 50, 'refreshing the same scope preserves reading progress');
    const expanded = positions;
    details.open = false;
    details.dispatchEvent(new f.dom.window.Event('toggle'));
    assert.ok(positions > expanded);
});

for (const sync of [true, false]) {
    test(`preview save handles ${sync ? 'synchronous' : 'asynchronous'} failures and retries canonical source`, async t => {
        const calls = [];
        const f = fixture(t, {
            revealSource: () => assert.fail('busy locate'),
            createMarkdownAnnotation: (...args) => {
                calls.push(args);
                if (calls.length > 1) return;
                const error = new Error('private annotation failure');
                if (sync) throw error;
                return Promise.reject(error);
            },
        });
        f.open({ source, annotation, selectionContext, translatedText: 'Never save this translation.',
            previewExpanded: true });
        const dialog = f.dialog();
        const save = f.action('annotate-source');
        save.click();
        save.click();
        assert.equal(save.disabled, true);
        assert.equal(f.action('locate-source').disabled, true);
        f.action('locate-source').click();
        await flush();
        const error = f.query('.mktero-annotation-action-error');
        assert.equal(error.hidden, false);
        assert.equal(error.textContent, localization.t('annotation.createFailed'));
        assert.equal(save.disabled, false);
        assert.equal(f.action('locate-source').disabled, false);
        assert.equal(f.dialog(), dialog);
        assert.deepEqual(calls, [[annotation, selectionContext]]);
        save.click();
        await flush();
        assert.deepEqual(calls, [[annotation, selectionContext], [annotation, selectionContext]]);
        assert.equal(f.dialog(), null);
    });
}

test('preview save keeps a pending request, review state and fresh guards on a same-selection refresh', async t => {
    const request = deferred();
    const calls = [];
    const f = fixture(t, { createMarkdownAnnotation: (...args) => {
        calls.push(args);
        return request.promise;
    }, revealSource() {} });
    let current = true;
    const args = { source, annotation, selectionContext };
    f.open({ ...args, isCurrent: () => current, previewExpanded: true });
    const save = f.action('annotate-source');
    const details = f.query('details');
    details.open = true;
    save.click();
    current = false;
    f.open({ ...args, isCurrent: () => true });
    assert.equal(f.action('annotate-source'), save);
    assert.equal(f.query('details'), details);
    assert.equal(details.open, true);
    assert.equal(save.disabled, true);
    assert.equal(f.action('locate-source').disabled, true);
    save.click();
    assert.deepEqual(calls, [[annotation, selectionContext]]);
    request.resolve();
    await flush();
    assert.equal(f.dialog(), null);
});

for (const succeeds of [true, false]) {
    test(`preview save ${succeeds ? 'success' : 'failure'} cannot affect a replacement selection at the same anchor`, async t => {
        const oldRequest = deferred();
        const nextRequest = deferred();
        const calls = [];
        const f = fixture(t, { createMarkdownAnnotation: (...args) => {
            calls.push(args);
            return calls.length === 1 ? oldRequest.promise : nextRequest.promise;
        }, revealSource() {} });
        f.open({ source, annotation, selectionContext, previewExpanded: true });
        const oldSave = f.action('annotate-source');
        oldSave.click();
        const nextAnnotation = { text: 'New canonical original block.', ranges: [{ from: 100, to: 134 }] };
        const nextContext = { side: 'source', rangesAreSource: true };
        f.open({ source: { text: 'New exact source sentence.' }, annotation: nextAnnotation,
            selectionContext: nextContext });
        const dialog = f.dialog();
        const save = f.action('annotate-source');
        assert.notEqual(save, oldSave);
        assert.equal(oldSave.isConnected, false);
        oldSave.click();
        save.click();
        assert.equal(save.disabled, true);
        if (succeeds) oldRequest.resolve();
        else oldRequest.reject(new Error('stale private error'));
        await flush();
        assert.equal(f.dialog(), dialog);
        assert.equal(save.disabled, true);
        assert.equal(f.action('locate-source').disabled, true);
        assert.equal(f.query('.mktero-annotation-action-error').hidden, true);
        assert.equal(f.query('.mktero-translation-annotation-text').textContent, nextAnnotation.text);
        assert.deepEqual(calls, [[annotation, selectionContext], [nextAnnotation, nextContext]]);
        nextRequest.reject(new Error('current failure'));
        await flush();
        assert.equal(save.disabled, false);
        assert.equal(f.action('locate-source').disabled, false);
        assert.equal(f.query('.mktero-annotation-action-error').hidden, false);
    });

    test(`preview save ${succeeds ? 'success' : 'failure'} from an earlier panel opening stays isolated`, async t => {
        const request = deferred();
        let calls = 0;
        const f = fixture(t, { createMarkdownAnnotation: () => {
            calls++;
            return request.promise;
        }, revealSource() {} });
        f.open({ source, annotation, previewExpanded: true });
        const save = f.action('annotate-source');
        save.click();
        f.action('preview-source').click();
        save.click();
        f.action('preview-source').click();
        save.click();
        assert.equal(calls, 1);
        const dialog = f.dialog();
        if (succeeds) request.resolve();
        else request.reject(new Error('earlier panel error'));
        await flush();
        assert.equal(f.dialog(), dialog);
        assert.equal(save.disabled, false);
        assert.equal(f.action('locate-source').disabled, false);
        assert.equal(f.query('.mktero-annotation-action-error').hidden, true);
    });
}

for (const succeeds of [true, false]) {
    test(`removing and restoring save at the same anchor isolates a late ${succeeds ? 'success' : 'failure'}`, async t => {
        const oldRequest = deferred();
        const nextRequest = deferred();
        const calls = [];
        const f = fixture(t, { createMarkdownAnnotation: (...args) => {
            calls.push(args);
            return calls.length === 1 ? oldRequest.promise : nextRequest.promise;
        }, revealSource() {} });
        f.open({ source, annotation, selectionContext, previewExpanded: true });
        const oldSave = f.action('annotate-source');
        const oldDetails = f.query('details');
        oldSave.click();
        const dialog = f.dialog();
        f.open({ source, annotation, selectionContext, blockCount: 9 });
        assert.equal(oldSave.isConnected, false);
        assert.equal(oldDetails.isConnected, false);
        assert.equal(f.action('annotate-source'), null);
        assert.equal(f.query('details'), null);
        assert.equal(f.action('locate-source').disabled, false);
        assert.equal(f.query('.mktero-translation-source').dataset.panel, 'preview');
        oldSave.click();
        f.open({ source, annotation, selectionContext });
        const save = f.action('annotate-source');
        assert.notEqual(save, oldSave);
        assert.equal(f.query('details').open, false);
        assert.equal(f.parent.querySelectorAll('[data-action="annotate-source"]').length, 1);
        assert.equal(f.action('source-more'), null);
        assert.equal(f.query('.mktero-translation-source-more'), null);
        save.click();
        if (succeeds) oldRequest.resolve();
        else oldRequest.reject(new Error('previous save failed'));
        await flush();
        assert.equal(f.dialog(), dialog);
        assert.equal(save.disabled, true);
        assert.equal(f.action('locate-source').disabled, true);
        assert.equal(f.query('.mktero-annotation-action-error').hidden, true);
        assert.deepEqual(calls, [[annotation, selectionContext], [annotation, selectionContext]]);
        nextRequest.reject(new Error('current save failed'));
        await flush();
        assert.equal(save.disabled, false);
        assert.equal(f.action('locate-source').disabled, false);
        assert.equal(f.query('.mktero-annotation-action-error').hidden, false);
    });
}

test('preview save honors current-selection guards for clicks and asynchronous errors', async t => {
    const request = deferred();
    let calls = 0;
    let current = true;
    const f = fixture(t, { createMarkdownAnnotation: () => {
        calls++;
        return request.promise;
    }, revealSource: () => assert.fail('expired locator') });
    f.open({ source, annotation, previewExpanded: true, isCurrent: () => current });
    current = false;
    f.action('annotate-source').click();
    f.action('locate-source').click();
    assert.equal(calls, 0);
    current = true;
    f.action('annotate-source').click();
    current = false;
    request.reject(new Error('expired save error'));
    await flush();
    assert.equal(calls, 1);
    assert.equal(f.popup.isOpen(), true);
    assert.equal(f.query('.mktero-annotation-action-error').hidden, true);
});

test('preview save accepts eight blocks and omits save and details above the cap or when unavailable', async t => {
    const calls = [];
    const f = fixture(t, { createMarkdownAnnotation: value => calls.push(value), revealSource: value => {
        calls.push(['locate', value]);
    } });
    f.open({ source, annotation, blockCount: 8, previewExpanded: true });
    assert.equal(f.action('annotate-source').disabled, false);
    assert.equal(f.query('summary').textContent,
        localization.t('ai.translationSourceSaveScopePlural', { count: 8 }));
    f.action('annotate-source').click();
    await flush();
    assert.deepEqual(calls, [annotation]);
    for (const args of [
        { blockCount: 9 },
        { blockCount: 2, annotationUnavailable: 'Explicit annotation unavailability.' },
    ]) {
        f.open({ source, annotation, previewExpanded: true, ...args });
        assert.equal(f.action('source-more'), null);
        assert.equal(f.action('annotate-source'), null);
        assert.equal(f.query('details'), null);
        assert.equal(f.query('.mktero-translation-annotation-text'), null);
        assert.equal(f.query('.mktero-translation-source-text').textContent, source.text);
        const unavailable = f.query('.mktero-translation-source-unavailable');
        assert.equal(unavailable.hidden, false);
        assert.equal(unavailable.getAttribute('role'), 'status');
        assert.equal(unavailable.textContent, args.annotationUnavailable
            || localization.t('annotation.sourceBlockUnavailable', { count: 8 }));
        f.action('locate-source').click();
    }
    assert.deepEqual(calls, [annotation, ['locate', source], ['locate', source]]);
});

test('same-anchor preview becomes unavailable without retaining a hidden save or review scope', t => {
    const f = fixture(t, { createMarkdownAnnotation: () => assert.fail('unavailable save'), revealSource() {} });
    f.open({ source, annotation, previewExpanded: true });
    const oldSave = f.action('annotate-source');
    f.query('details').open = true;
    f.open({ source, annotation, blockCount: 9 });
    oldSave.click();
    assert.equal(oldSave.isConnected, false);
    assert.equal(f.action('annotate-source'), null);
    assert.equal(f.query('details'), null);
    assert.equal(f.action('locate-source').disabled, false);
    f.open({ source, annotation });
    assert.equal(f.action('annotate-source').disabled, false);
    assert.equal(f.query('details').open, false);
    assert.equal(f.query('.mktero-translation-source-unavailable').hidden, true);
});

test('preview fallback requires an explicit Show, then keeps exact source and canonical save scope distinct', async t => {
    const shown = [];
    const saved = [];
    const f = fixture(t, { createMarkdownAnnotation: (...args) => saved.push(args) });
    const fallback = { id: 'unaligned', onShowBlock: () => {
        shown.push('show');
        return 'Fallback full original block.';
    } };
    f.open({ wholeBlockActions: [fallback] });
    assert.deepEqual(shown, []);
    assert.equal(f.action('show-source-block'), null);
    assert.equal(f.query('details'), null);
    f.action('preview-source').click();
    const show = f.action('show-source-block');
    assert.deepEqual(shown, []);
    assert.equal(f.action('annotate-source'), null);
    show.click();
    assert.deepEqual(shown, ['show']);
    assert.equal(f.query('.mktero-translation-source-text').textContent, 'Fallback full original block.');
    f.open({ source, annotation, selectionContext, wholeBlockActions: [fallback] });
    assert.equal(f.action('show-source-block'), show);
    assert.equal(f.query('.mktero-translation-source-preview > .mktero-translation-source-text').textContent, source.text);
    assert.equal(f.query('.mktero-translation-legacy-block .mktero-translation-source-text').textContent,
        'Fallback full original block.');
    assert.equal(f.query('.mktero-translation-annotation-text').textContent, annotation.text);
    assert.equal(f.query('details').open, false);
    f.action('annotate-source').click();
    await flush();
    assert.deepEqual(saved, [[annotation, selectionContext]]);
});

test('preview review renders untrusted annotation text literally inside native details', t => {
    const literal = '<img src=x onerror="alert(1)"><script>bad()</script> &amp;\n**whole original**';
    const f = fixture(t, { createMarkdownAnnotation() {} });
    f.open({ source: { text: '<exact original>' }, annotation: { text: literal },
        previewExpanded: true });
    assert.equal(f.query('.mktero-translation-source-text').textContent, '<exact original>');
    const body = f.query('details .mktero-translation-annotation-text');
    assert.equal(body.textContent, literal);
    assert.equal(body.getAttribute('dir'), 'auto');
    assert.equal(body.tabIndex, 0);
    assert.equal(f.parent.querySelectorAll('img, script').length, 0);
});

test('rebuilding a focused legacy row marks it hidden before the browser blurs its removed control', t => {
    const f = fixture(t, { createMarkdownAnnotation() {} });
    f.open({ source, annotation, previewExpanded: true, wholeBlockActions: [{
        id: 'old', onShowBlock: () => assert.fail('detached legacy action'),
    }] });
    const dialog = f.dialog();
    const show = f.action('show-source-block');
    show.focus();
    assert.equal(f.document.activeElement, show);
    const scheduled = [];
    f.dom.window.setTimeout = callback => {
        scheduled.push(callback);
        return scheduled.length;
    };
    const legacy = f.query('.mktero-translation-legacy-actions');
    const remove = legacy.remove.bind(legacy);
    legacy.remove = () => {
        assert.equal(legacy.hidden, true);
        show.dispatchEvent(new f.dom.window.FocusEvent('focusout', {
            bubbles: true, relatedTarget: null,
        }));
        remove();
    };
    f.open({ source, annotation });
    show.click();
    assert.equal(scheduled.length, 0, 'the browser blur must not schedule popup dismissal');
    assert.equal(f.dialog(), dialog);
    assert.equal(f.query('.mktero-translation-legacy-actions'), null);
    assert.equal(f.query('.mktero-translation-source-preview').hidden, false);
    assert.equal(f.action('annotate-source').disabled, false);
});

for (const [name, anchorTop, anchorHeight, blockCount, expansion, fixedEdge] of [
    ['above', 473, 59, 2, 'up', 463],
    ['below', 100, 20, 2, 'down', 130],
    ['nine-block selection', 73.5, 539.55, 9, 'up', 241],
]) {
    test(`unified preview keeps its toolbar edge and reserved width through expansion ${name}`, t => {
        const f = fixture(t, { createMarkdownAnnotation() {}, revealSource() {} });
        const bounds = (left, top, width, height) => ({
            left, top, width, height, right: left + width, bottom: top + height,
        });
        const originalRect = f.dom.window.HTMLElement.prototype.getBoundingClientRect;
        f.dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
            if (this === f.parent) return bounds(100, 25, 800, 592);
            if (this === f.anchor) return bounds(840, anchorTop, 40, anchorHeight);
            if (!this.classList.contains('mktero-translation-source-popup')) return originalRect.call(this);
            const preview = this.querySelector('.mktero-translation-source-preview');
            const expanded = preview && !preview.hidden;
            const contentHeight = expanded ? (preview.querySelector('details')?.open ? 500 : 240) : 44;
            const height = Math.min(contentHeight,
                Number.parseFloat(this.style.getPropertyValue('--anchored-popup-available-height')) || Infinity);
            const width = expanded ? 420 : 240;
            const left = Number.parseFloat(this.style.left) || 0;
            const top = this.style.bottom
                ? f.dom.window.innerHeight - Number.parseFloat(this.style.bottom) - height
                : Number.parseFloat(this.style.top) || 0;
            return bounds(left, top, width, height);
        };
        f.open({ source, annotation, blockCount });
        const dialog = f.dialog();
        const compact = dialog.getBoundingClientRect();
        assert.equal(dialog.dataset.expansion, expansion);
        assert.equal(expansion === 'up' ? compact.bottom : compact.top, fixedEdge);
        assert.ok(Number.parseFloat(dialog.style.getPropertyValue('--anchored-popup-available-height')) >= 200);
        const assertStable = () => {
            const rect = dialog.getBoundingClientRect();
            assert.equal(dialog.dataset.expansion, expansion);
            assert.equal(expansion === 'up' ? rect.bottom : rect.top, fixedEdge);
            assert.equal(rect.left, compact.left);
            assert.ok(rect.top >= 41);
            assert.ok(rect.bottom <= 601);
            assert.ok(rect.right <= 884);
            if (name === 'above') assert.ok(rect.bottom <= anchorTop - 10);
            if (name === 'below') assert.ok(rect.top >= anchorTop + anchorHeight + 10);
        };
        f.action('preview-source').click();
        assertStable();
        const details = f.query('details');
        if (details) {
            for (const open of [true, false]) {
                details.open = open;
                details.dispatchEvent(new f.dom.window.Event('toggle'));
                assertStable();
            }
        }
        else {
            assert.equal(blockCount, 9);
            assert.equal(f.action('annotate-source'), null);
            assert.equal(f.action('locate-source').disabled, false);
            assert.equal(f.query('.mktero-translation-source-unavailable').hidden, false);
        }
        f.action('preview-source').click();
        assertStable();
        f.action('preview-source').click();
        assertStable();
        f.open({ source, annotation, blockCount });
        assertStable();
    });
}

test('invalid open closes the active popup and an anchor change clears panel and error state', async t => {
    const f = fixture(t, { copyTranslation: () => { throw new Error('copy failed'); } });
    f.open({ source, translatedText: '译文', previewExpanded: true });
    f.action('copy-translation').click();
    await flush();
    assert.equal(f.query('.mktero-translation-source-status').hidden, false);
    const nextAnchor = f.document.createElement('span');
    f.parent.appendChild(nextAnchor);
    f.open({ anchor: nextAnchor, source, translatedText: '另一段译文' });
    assert.equal(f.query('.mktero-translation-source-preview'), null);
    assert.equal(f.query('.mktero-translation-source-status').hidden, true);
    f.open();
    assert.equal(f.dialog(), null);
    f.open({ source });
    assert.equal(f.popup.isOpen(), true);
    f.open({ anchor: null, source });
    assert.equal(f.dialog(), null);
});
