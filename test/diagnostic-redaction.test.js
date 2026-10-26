import test from 'node:test';
import assert from 'node:assert/strict';
import { redactDiagnosticText } from '../src/diagnostics/redact-diagnostics.js';

test('redacts credentials, presigned URLs, emails, and home directories', () => {
    const redacted = redactDiagnosticText([
        'Bearer secret-token',
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturevalue',
        'sk-live-secretvalue',
        'apiKey: "mineru-secret"',
        'https://user:pass@files.example/object',
        'https://r2.example/upload?X-Amz-Signature=abc&X-Amz-Credential=role',
        'reader@example.com',
        '/Users/tenglvjun/Zotero/paper.pdf',
        'C:\\Users\\tenglvjun\\Zotero\\paper.pdf',
        'file:///Users/tenglvjun/Zotero/paper.pdf',
        'job 6f1c0b5e-2a4d-4c8e-9b1a-0d3e5f7a9c2b',
    ].join('\n'));

    assert.equal(redacted.includes('secret-token'), false);
    assert.equal(redacted.includes('eyJhbGci'), false);
    assert.equal(redacted.includes('sk-live-secretvalue'), false);
    assert.equal(redacted.includes('mineru-secret'), false);
    assert.equal(redacted.includes('user:pass'), false);
    assert.equal(redacted.includes('X-Amz-Signature'), false);
    assert.equal(redacted.includes('reader@example.com'), false);
    assert.equal(redacted.includes('tenglvjun'), false);
    assert.equal(redacted.includes('file://'), false);
    assert.match(redacted, /Bearer \[redacted\]/);
    assert.match(redacted, /\[redacted-url\]/);
    assert.match(redacted, /\[redacted-email\]/);
    assert.match(redacted, /\/Users\/\[user\]\/Zotero\/paper\.pdf/);
    assert.match(redacted, /C:\\Users\\\[user\]\\Zotero\\paper\.pdf/);
    assert.match(redacted, /6f1c0b5e-2a4d-4c8e-9b1a-0d3e5f7a9c2b/);
});
