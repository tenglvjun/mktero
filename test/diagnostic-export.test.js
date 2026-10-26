import test from 'node:test';
import assert from 'node:assert/strict';
import { saveDiagnosticText } from '../src/platform/zotero-diagnostic-export.js';

test('saves the diagnostic package through the file picker and can be cancelled', async () => {
    const written = [];
    const saved = await saveDiagnosticText({
        createFilePicker: () => ({
            modeSave: 1,
            returnCancel: 1,
            returnOK: 0,
            init() {},
            appendFilter() {},
            async show() { return 0; },
            file: '/tmp/mktero-diagnostics.json',
        }),
        ioUtils: {
            async writeUTF8(path, text) { written.push({ path, text }); },
        },
        ownerWindow: {},
        fileName: 'mktero-diagnostics.json',
        text: '{"schemaVersion":1}\n',
        translate: key => key,
    });
    assert.deepEqual(saved, { status: 'saved' });
    assert.deepEqual(written, [{
        path: '/tmp/mktero-diagnostics.json',
        text: '{"schemaVersion":1}\n',
    }]);

    const cancelled = await saveDiagnosticText({
        createFilePicker: () => ({
            modeSave: 1,
            returnCancel: 1,
            init() {},
            async show() { return 1; },
            file: '/tmp/ignored.json',
        }),
        ioUtils: { async writeUTF8() { throw new Error('must not write'); } },
        ownerWindow: {},
        fileName: 'mktero-diagnostics.json',
        text: '{}\n',
        translate: key => key,
    });
    assert.deepEqual(cancelled, { status: 'cancelled' });
});
