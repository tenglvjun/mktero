import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { translateEnglish } from '../src/i18n/localization.js';
import { openDiagnosticReportDialog } from '../src/ui/diagnostic-report-dialog.js';

function flush() {
    return new Promise(resolve => setImmediate(resolve));
}

function createFixture() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        pretendToBeVisual: true,
    });
    const copied = [];
    const saved = [];
    const dialog = openDiagnosticReportDialog({
        document: dom.window.document,
        parent: dom.window.document.body,
        translate: translateEnglish,
        buildReport: async ({ note, expected, includeAccountEmail }) => ({
            text: JSON.stringify({ note, expected, includeAccountEmail }),
            fileName: 'mktero-diagnostics-test.json',
        }),
        copyText: async text => copied.push(text),
        saveText: async (fileName, text) => {
            saved.push({ fileName, text });
            return { status: 'saved' };
        },
    });
    return { dom, dialog, copied, saved };
}

test('shows the redacted preview and does not copy until a description is entered', async () => {
    const fixture = createFixture();
    await flush();

    const backdrop = fixture.dom.window.document.querySelector(
        '.mktero-diagnostics-backdrop'
    );
    const modal = backdrop.querySelector('[role="dialog"]');
    const copy = backdrop.querySelector('[data-diagnostic-action="copy"]');
    const save = backdrop.querySelector('[data-diagnostic-action="save"]');
    const happened = backdrop.querySelector('#mktero-diagnostics-happened');

    assert.equal(modal.getAttribute('aria-modal'), 'true');
    assert.equal(copy.disabled, true);
    assert.equal(save.disabled, true);
    assert.match(backdrop.querySelector('.mktero-diagnostics-note').textContent,
        /do not upload/);

    happened.value = 'The figure is missing';
    happened.dispatchEvent(new fixture.dom.window.Event('input', { bubbles: true }));
    await flush();

    assert.equal(copy.disabled, false);
    assert.match(backdrop.querySelector('#mktero-diagnostics-preview').textContent,
        /The figure is missing/);
    copy.click();
    await flush();
    assert.deepEqual(fixture.copied, [
        JSON.stringify({
            note: 'The figure is missing',
            expected: '',
            includeAccountEmail: false,
        }),
    ]);
    assert.match(backdrop.querySelector('.mktero-diagnostics-status').textContent,
        /Copied/);

    save.click();
    await flush();
    assert.equal(fixture.saved[0].fileName, 'mktero-diagnostics-test.json');
    fixture.dialog.close();
    assert.equal(backdrop.isConnected, false);
});

test('reuses the open dialog instead of stacking another one', () => {
    const fixture = createFixture();
    const again = openDiagnosticReportDialog({
        document: fixture.dom.window.document,
        parent: fixture.dom.window.document.body,
        buildReport: async () => ({ text: '{}', fileName: 'other.json' }),
    });

    assert.equal(again, fixture.dialog);
    assert.equal(
        fixture.dom.window.document.querySelectorAll('.mktero-diagnostics-backdrop').length,
        1
    );
    fixture.dialog.close();
});
