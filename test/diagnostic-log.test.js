import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createDiagnosticLog,
    notifyDiagnosticJob,
} from '../src/diagnostics/diagnostic-log.js';

test('keeps a bounded redacted log and updates a job in place', () => {
    let clock = 0;
    const log = createDiagnosticLog({
        capacity: 2,
        jobCapacity: 2,
        now: () => `2026-10-26T00:00:0${clock++}.000Z`,
    });

    assert.equal(log.record('debug', 'Mktero: started'), true);
    assert.equal(log.record('debug', 'token=super-secret'), true);
    assert.equal(log.recordError(Object.assign(new Error('Bearer abc.def'), {
        code: 'MKTERO_UPLOAD_FAILED',
        stack: 'Error: Bearer abc.def\n    at /Users/ada/mktero.js:1:1',
    })), true);
    assert.equal(log.recordJob({
        provider: 'mktero',
        id: 'https://r2.example/upload?token=secret',
        status: 'created',
    }), false);
    assert.equal(log.recordJob({
        provider: 'mktero',
        id: 'job-1',
        status: 'awaiting_upload',
    }), true);
    assert.equal(log.recordJob({
        provider: 'mktero',
        id: 'job-1',
        status: 'succeeded',
    }), true);

    const entries = log.entries();
    assert.equal(entries.length, 2);
    assert.equal(entries[0].message.includes('super-secret'), false);
    assert.match(entries[0].message, /token=\[redacted\]|\[redacted-url\]|\?\[redacted-url\]/);
    assert.equal(entries[1].level, 'error');
    assert.equal(entries[1].message.includes('abc.def'), false);
    assert.equal(entries[1].message.includes('/Users/ada'), false);
    assert.match(entries[1].message, /MKTERO_UPLOAD_FAILED/);
    assert.equal(log.jobs()[0].id, 'job-1');
    assert.equal(log.jobs()[0].status, 'succeeded');
});

test('ignores a diagnostic job listener that throws', () => {
    assert.doesNotThrow(() => notifyDiagnosticJob(() => {
        throw new Error('listener failed');
    }, { provider: 'mineru', id: 'batch-1' }));
    notifyDiagnosticJob(null, { provider: 'mineru', id: 'batch-1' });
});
