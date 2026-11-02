import test from 'node:test';
import assert from 'node:assert/strict';
import { createImportedMinerUReadiness } from '../src/cache/imported-mineru-readiness.js';
import { createLLMCacheParserProfile } from '../src/mineru/llm-cache-profile.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const item = { id: 42, libraryID: 1, key: 'PDFKEY42' };

function fixture() {
    let record = { sourceHash: A, snapshotHash: A, importedAt: 10 };
    let current = record;
    let fileStamp = 'paper.pdf:100:1';
    let calls = 0;
    let changes = 0;
    const live = new Map([[createLLMCacheParserProfile(A), A]]);
    const model = createImportedMinerUReadiness({
        index: { peekForAttachment: () => record },
        extractor: { lookup: async () => { calls++; return current; } },
        readiness: { cacheKeyFor: (_item, profile) => live.get(profile) || null },
        getFileStamp: () => fileStamp,
        onChange: () => changes++,
    });
    return { model, live, get calls() { return calls; }, get changes() { return changes; },
        set record(value) { record = value; }, set current(value) { current = value; },
        set fileStamp(value) { fileStamp = value; } };
}

const drain = () => new Promise(resolve => setImmediate(resolve));

test('ordinary attachments keep their provider readiness without hashing a PDF', () => {
    const f = fixture();
    f.record = null;
    assert.equal(f.model.cacheKeyFor(item), undefined);
    assert.equal(f.calls, 0);
});

test('context-menu readiness never starts a PDF read', async () => {
    const f = fixture();
    assert.equal(f.model.cacheKeyFor(item, { verify: false }), null);
    await drain();
    assert.equal(f.calls, 0);
    await f.model.validate(item);
    assert.equal(f.model.cacheKeyFor(item, { verify: false }), A);
});

test('a selected import waits for PDF identity verification before showing ready', async () => {
    const f = fixture();
    assert.equal(f.model.cacheKeyFor(item), null);
    assert.equal(f.model.cacheKeyFor(item), null);
    await drain();
    assert.equal(f.calls, 1);
    assert.equal(f.model.cacheKeyFor(item), A);
    assert.equal(f.changes, 1);
});

test('replacing PDF bytes invalidates the old marker before a new hash is available', async () => {
    const f = fixture();
    await f.model.validate(item);
    assert.equal(f.model.cacheKeyFor(item), A);
    f.fileStamp = 'paper.pdf:101:2';
    f.current = null;
    assert.equal(f.model.cacheKeyFor(item), null);
    await drain();
    assert.equal(f.model.cacheKeyFor(item), null);
    assert.deepEqual(await f.model.validate(item), { selected: true, cacheKey: null });
});

test('readiness follows the exact PDF selection even when another PDF was imported more recently', async () => {
    const f = fixture();
    f.record = { sourceHash: B, snapshotHash: B, importedAt: 20 };
    assert.equal(f.model.cacheKeyFor(item), null);
    await drain();
    assert.equal(f.model.cacheKeyFor(item), A);
});

test('a newly selected snapshot cannot use an older snapshot readiness marker', async () => {
    const f = fixture();
    await f.model.validate(item);
    f.record = { sourceHash: A, snapshotHash: B, importedAt: 20 };
    f.current = { sourceHash: A, snapshotHash: B, importedAt: 20 };
    assert.equal(f.model.cacheKeyFor(item), null);
    await drain();
    assert.equal(f.model.cacheKeyFor(item), null);
    f.live.set(createLLMCacheParserProfile(B), B);
    assert.equal(f.model.cacheKeyFor(item), B);
});

test('a changed PDF during verification never becomes ready for the previous bytes', async () => {
    let fileStamp = 'before';
    const model = createImportedMinerUReadiness({
        index: { peekForAttachment: () => ({ sourceHash: A, snapshotHash: A, importedAt: 10 }) },
        extractor: { lookup: async () => { fileStamp = 'after'; return { sourceHash: A, snapshotHash: A }; } },
        readiness: { cacheKeyFor: () => A }, getFileStamp: () => fileStamp,
    });
    assert.deepEqual(await model.validate(item), { selected: true, cacheKey: null });
    assert.equal(model.cacheKeyFor(item), null);
    model.dispose();
});

test('authoritative async reads verify the PDF even without a synchronous filesystem stamp', async () => {
    const f = fixture();
    f.fileStamp = null;
    assert.equal(f.model.cacheKeyFor(item), null);
    assert.equal((await f.model.validate(item)).cacheKey, A);
    f.current = null;
    assert.equal((await f.model.validate(item)).cacheKey, null);
    f.model.dispose();
    assert.equal(f.model.cacheKeyFor(item), null);
});
