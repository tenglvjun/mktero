import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { translateEnglish } from '../src/i18n/localization.js';
import {
    closeDiagnosticReportDialogs,
    openDiagnosticReportDialog,
} from '../src/ui/diagnostic-report-dialog.js';

function flush() {
    return new Promise(resolve => setImmediate(resolve));
}

function createFixture({ openIssue = () => {} } = {}) {
    const dom = new JSDOM('<!doctype html><html><body><button id="trigger">Report</button></body></html>', {
        pretendToBeVisual: true,
    });
    const { document } = dom.window;
    const trigger = document.getElementById('trigger');
    trigger.focus();
    const calls = { builds: [], copied: [], saved: [], issues: 0 };
    const dialog = openDiagnosticReportDialog({
        document,
        parent: document.body,
        translate: translateEnglish,
        buildReport: async ({ note }) => {
            calls.builds.push(note);
            return {
                text: JSON.stringify({ note, failure: { code: 'MKTERO_CONVERSION_FAILED' } }),
                fileName: 'mktero-diagnostics-test.json',
                summary: [
                    { label: 'Paper', value: 'ABCD2345' },
                    { label: 'Error', value: 'MKTERO_CONVERSION_FAILED' },
                ],
            };
        },
        copyText: async text => calls.copied.push(text),
        saveText: async (fileName, text) => {
            calls.saved.push({ fileName, text });
            return { status: 'saved' };
        },
        openIssue: openIssue && (() => {
            calls.issues += 1;
            openIssue();
        }),
    });
    const backdrop = document.querySelector('.mktero-diagnostics-backdrop');
    const find = selector => backdrop.querySelector(selector);
    return { dom, document, trigger, dialog, backdrop, find, calls };
}

test('summarizes the report and keeps the full JSON folded', async () => {
    const { dialog, find, backdrop } = createFixture();
    await flush();

    assert.equal(find('[role="dialog"]').getAttribute('aria-modal'), 'true');
    assert.equal(backdrop.querySelectorAll('textarea').length, 1);
    assert.equal(backdrop.querySelector('input[type="checkbox"]'), null);
    assert.deepEqual(
        [...backdrop.querySelectorAll('.mktero-diagnostics-summary-row')]
            .map(row => row.textContent),
        ['PaperABCD2345', 'ErrorMKTERO_CONVERSION_FAILED']
    );
    const preview = find('#mktero-diagnostics-preview');
    const toggle = find('[aria-controls="mktero-diagnostics-preview"]');
    assert.equal(preview.hidden, true);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    toggle.click();
    assert.equal(preview.hidden, false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(toggle.textContent, 'Hide full report');
    assert.match(preview.textContent, /MKTERO_CONVERSION_FAILED/);
    dialog.close();
});

test('explains why Copy and Save wait for a description', async () => {
    const { dom, dialog, find, calls } = createFixture();
    await flush();
    const happened = find('#mktero-diagnostics-happened');
    const copy = find('[data-diagnostic-action="copy"]');
    const save = find('[data-diagnostic-action="save"]');
    const hint = find('#mktero-diagnostics-hint');

    assert.equal(happened.getAttribute('aria-required'), 'true');
    assert.equal(happened.getAttribute('aria-describedby'), 'mktero-diagnostics-hint');
    assert.equal(copy.disabled, true);
    assert.equal(save.disabled, true);
    assert.equal(hint.hidden, false);
    assert.match(hint.textContent, /Describe the problem to enable Copy and Save/);
    assert.ok(copy.classList.contains('mktero-diagnostics-button--primary'));
    assert.equal(copy.parentNode.lastElementChild, copy);

    happened.value = 'The figure is missing';
    happened.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await flush();

    assert.equal(hint.hidden, true);
    assert.equal(copy.disabled, false);
    copy.click();
    await flush();
    assert.deepEqual(calls.copied, [JSON.stringify({
        note: 'The figure is missing',
        failure: { code: 'MKTERO_CONVERSION_FAILED' },
    })]);
    assert.match(find('.mktero-diagnostics-status').textContent, /Paste it where you report/);
    save.click();
    await flush();
    assert.equal(calls.saved[0].fileName, 'mktero-diagnostics-test.json');
    dialog.close();
});

test('says where to send the report and opens the empty GitHub issue form', async () => {
    const { dialog, find, calls } = createFixture();
    await flush();

    assert.match(
        find('.mktero-diagnostics-destination').textContent,
        /GitHub issue.*QQ group or Discord\. GitHub issues are public\./
    );
    find('[data-diagnostic-action="open-issue"]').click();
    assert.equal(calls.issues, 1);
    dialog.close();
});

test('returns focus on close and reuses an open dialog', async () => {
    const { dom, document, trigger, dialog, backdrop } = createFixture();
    await flush();
    assert.equal(document.activeElement.id, 'mktero-diagnostics-happened');

    const again = openDiagnosticReportDialog({
        document,
        parent: document.body,
        buildReport: async () => ({ text: '{}', fileName: 'other.json', summary: [] }),
    });
    assert.equal(again, dialog);
    assert.equal(document.querySelectorAll('.mktero-diagnostics-backdrop').length, 1);

    backdrop.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        bubbles: true,
        key: 'Escape',
    }));
    assert.equal(backdrop.isConnected, false);
    assert.equal(document.activeElement, trigger);
});

test('omits the GitHub action when no opener is available', async () => {
    const { dialog, find } = createFixture({ openIssue: null });
    await flush();
    assert.equal(find('[data-diagnostic-action="open-issue"]'), null);
    dialog.close();
});

function styleDocument(markup = '') {
    return new JSDOM(`<!doctype html><html><head>${markup}</head><body></body></html>`)
        .window.document;
}

function openPlain(document) {
    return openDiagnosticReportDialog({
        document,
        parent: document.body,
        buildReport: async () => ({ text: '{}', fileName: 'x.json', summary: [] }),
    });
}

test('rewrites a stylesheet left by an earlier build instead of reusing it', () => {
    // An earlier build left its rules in the window; the update did not restart Zotero.
    const document = styleDocument(
        '<style id="mktero-diagnostics-style">.mktero-diagnostics-dialog{width:520px}</style>'
    );
    const dialog = openPlain(document);
    const styles = document.querySelectorAll('#mktero-diagnostics-style');

    assert.equal(styles.length, 1);
    assert.doesNotMatch(styles[0].textContent, /width:520px/);
    assert.match(styles[0].textContent, /\.mktero-diagnostics-summary-row/);
    assert.match(styles[0].textContent, /\.mktero-diagnostics-destination/);
    dialog.close();
    openPlain(document).close();
    assert.equal(document.querySelectorAll('#mktero-diagnostics-style').length, 1);
    closeDiagnosticReportDialogs(document);
});

test('removes the stylesheet from one window or from every window on shutdown', () => {
    const first = styleDocument();
    const second = styleDocument();
    openPlain(first);
    openPlain(second);

    closeDiagnosticReportDialogs(first);
    assert.equal(first.getElementById('mktero-diagnostics-style'), null);
    assert.equal(first.querySelector('.mktero-diagnostics-backdrop'), null);
    assert.ok(second.getElementById('mktero-diagnostics-style'));
    assert.ok(second.querySelector('.mktero-diagnostics-backdrop'));

    closeDiagnosticReportDialogs();
    assert.equal(second.getElementById('mktero-diagnostics-style'), null);
    assert.equal(second.querySelector('.mktero-diagnostics-backdrop'), null);
});
