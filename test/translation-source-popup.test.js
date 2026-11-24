import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createAnnotationPopup } from '../src/editor/annotation-popup.js';
import { createTranslationSourcePopup } from '../src/editor/translation-source-popup.js';
import { createLocalization } from '../src/i18n/localization.js';

const localization = createLocalization({ zoteroLocale: 'zh-CN' });
const flush = () => new Promise(resolve => setImmediate(resolve));
const original = 'An original <example> & its result.';
const ranges = [{ from: 43, to: 43 + original.length }];
const selectionContext = { side: 'source', rangesAreSource: true };

function fixture(t, services = {}) {
    const dom = new JSDOM('<main><span></span></main>', { pretendToBeVisual: true });
    const { document } = dom.window;
    const parent = document.querySelector('main');
    const shared = createAnnotationPopup(parent, {
        localization,
        shouldAutoTranslateSelection: () => true,
        translateSelection: () => assert.fail('Looking up an original must stay offline'),
        ...services,
    });
    const popup = createTranslationSourcePopup(parent, {
        localization, renderSelectionActions: shared.renderSelectionActions, copySource: services.copySource,
    });
    const open = (overrides = {}) => popup.open({
        anchor: parent.querySelector('span'),
        excerpts: [{ id: 'p', text: original }],
        selection: { text: original, ranges },
        selectionContext,
        ...overrides,
    });
    t.after(() => { popup.destroy(); shared.destroy(); dom.window.close(); });
    return { parent, document, shared, popup, open, query: selector => parent.querySelector(selector) };
}

test('shows the original as text and uses the original selection toolbar minus translation', async t => {
    const saved = [];
    const copied = [];
    const f = fixture(t, {
        createMarkdownAnnotation: (draft, context) => saved.push({ draft, context }),
        addSelectionToNote() {},
        openSourceLocation() {},
        copySourcedMarkdown() {},
        copySource: text => copied.push(text),
    });
    const options = { sourceLocation: { pageIndex: 2 }, canCopySource: true };
    f.shared.openSelection({ anchor: f.parent.querySelector('span'), selection: { text: 'Sample' }, ...options });
    const signature = () => [...f.query('.mktero-markdown-selection-toolbar').querySelectorAll('button')]
        .map(button => button.dataset.color || button.dataset.action);
    const originalToolbar = signature();
    f.shared.close();
    f.open(options);
    assert.deepEqual(signature(), originalToolbar.filter(action => action !== 'translate-selection'));
    assert.equal(f.query('[data-action="translate-selection"], [data-action="retranslate-selection"], example'), null);
    assert.equal(f.query('.mktero-translation-source-text').textContent, original);
    assert.deepEqual(saved, []);
    f.query('[data-action="copy-original"]').click();
    await flush();
    assert.deepEqual(copied, [original]);
    assert.equal(f.query('.mktero-source-copy-status').textContent, '已复制');
    f.query('[data-color="#5fb236"]').click();
    await flush();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].draft.color, '#5fb236');
    assert.equal(saved[0].draft.text, original);
    assert.deepEqual(saved[0].draft.ranges, ranges);
    assert.deepEqual(saved[0].context, selectionContext);
});

test('a deferred refresh keeps the pending save exclusive, shows its error and permits retry', async t => {
    const save = Promise.withResolvers();
    let calls = 0;
    const f = fixture(t, { createMarkdownAnnotation() { if (++calls === 1) return save.promise; } });
    f.open();
    const color = f.query('[data-color="#2ea8e5"]');
    color.click();
    f.open({ canAnnotate: false });
    f.open();
    for (const button of f.parent.querySelectorAll('.mktero-markdown-selection-toolbar button')) {
        assert.equal(button.disabled, true);
        button.click();
    }
    assert.equal(calls, 1);
    save.reject(new Error('private storage detail'));
    await flush();
    assert.equal(f.query('.mktero-annotation-action-error').hidden, false);
    assert.equal(f.query('.mktero-annotation-action-error').textContent, localization.t('annotation.createFailed'));
    color.click();
    assert.equal(calls, 1, 'detached toolbar cannot save');
    f.query('[data-color="#2ea8e5"]').click();
    await flush();
    assert.equal(calls, 2);
    assert.equal(f.popup.isOpen(), false);
});

test('retains scroll and keyboard focus on refresh and ignores stale copy completions', async t => {
    const request = Promise.withResolvers();
    const f = fixture(t, { copySource: () => request.promise });
    f.open();
    f.query('.mktero-translation-source-scroll').scrollTop = 70;
    const copy = f.query('[data-action="copy-original"]');
    copy.focus();
    copy.click();
    f.open();
    assert.equal(f.document.activeElement, f.query('[data-action="copy-original"]'));
    assert.equal(f.query('.mktero-translation-source-scroll').scrollTop, 70);
    request.reject(new Error('old clipboard error'));
    await flush();
    assert.equal(f.query('.mktero-source-copy-status').textContent, '');
});

test('an older comment autosave cannot reopen its editor over another translated selection', async t => {
    const request = Promise.withResolvers();
    const errors = [];
    const f = fixture(t, {
        createMarkdownAnnotation: () => request.promise,
        onDetachedActionError: key => errors.push(key),
    });
    f.open();
    f.query('[data-action="add-note"]').click();
    f.query('textarea').value = 'First comment';
    f.shared.close({ saveNote: true });
    const anchor = f.document.createElement('span');
    f.parent.appendChild(anchor);
    f.open({ anchor, excerpts: [{ id: 'q', text: 'New original.' }] });
    request.reject(new Error('failed write'));
    await flush();
    assert.deepEqual(errors, ['annotation.noteSaveFailed']);
    assert.equal(f.parent.querySelectorAll('[role="dialog"]').length, 1);
    assert.equal(f.query('textarea'), null);
    assert.equal(f.query('.mktero-translation-source-text').textContent, 'New original.');
});

test('reports a clipboard failure locally and a later copy succeeds', async t => {
    let calls = 0;
    const f = fixture(t, { copySource() { if (++calls === 1) throw new Error('private detail'); } });
    f.open();
    f.query('[data-action="copy-original"]').click();
    await flush();
    assert.equal(f.query('[role="status"].mktero-source-copy-status').textContent, '复制原文失败，请重试。');
    f.query('[data-action="copy-original"]').click();
    await flush();
    assert.equal(f.query('.mktero-source-copy-status').textContent, '已复制');
});
