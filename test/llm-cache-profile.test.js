import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { sha256Hex } from '../src/core/sha256.js';
import { createMarkdownCacheKey } from '../src/cache/markdown-cache.js';
import {
    LLM_CACHE_ADAPTER_VERSION,
    createLLMCacheIdentity,
    createLLMCacheRawKey,
    createLLMCacheParserProfile,
    getPreviousLLMCacheParserProfiles,
    hashCanonicalLLMEntries,
    readCanonicalLLMArchiveEntries,
} from '../src/mineru/llm-cache-profile.js';

const PDF = strToU8('synthetic PDF bytes');
const SNAPSHOT = 'a'.repeat(64);
const entries = () => [
    { path: 'full.md', data: strToU8('Synthetic paper') },
    { path: 'content_list.json', data: strToU8('[]') },
];

test('keeps imported identities separate from official profiles and snapshots', async () => {
    const identity = await createLLMCacheIdentity({ fileData: PDF, snapshotHash: SNAPSHOT });
    assert.equal(identity.provider, 'llm-for-zotero');
    assert.equal(identity.adapterVersion, LLM_CACHE_ADAPTER_VERSION);
    assert.equal(identity.sourceHash, await sha256Hex(PDF));
    assert.equal(identity.rawKey, await createLLMCacheRawKey(identity));
    assert.equal(identity.cacheKey, await createMarkdownCacheKey(PDF, { parserProfile: identity.parserProfile }));
    assert.notEqual(identity.cacheKey, await createMarkdownCacheKey(PDF));
    const changed = await createLLMCacheIdentity({ fileData: PDF, snapshotHash: 'b'.repeat(64) });
    assert.notEqual(changed.cacheKey, identity.cacheKey);
    assert.notEqual(changed.rawKey, identity.rawKey);
    const otherPDF = await createLLMCacheIdentity({ fileData: strToU8('another PDF'), snapshotHash: SNAPSHOT });
    assert.notEqual(otherPDF.cacheKey, identity.cacheKey);
    assert.notEqual(otherPDF.rawKey, identity.rawKey);
    await assert.rejects(createLLMCacheIdentity({ fileData: PDF, sourceHash: 'c'.repeat(64), snapshotHash: SNAPSHOT }), /source hash/i);
    await assert.rejects(createLLMCacheIdentity({ fileData: PDF, snapshotHash: '../unsafe' }), /snapshot/i);
});

test('keeps raw identity stable when only document or figure processing changes', async () => {
    const identity = await createLLMCacheIdentity({ fileData: PDF, snapshotHash: SNAPSHOT });
    const updated = createLLMCacheParserProfile(SNAPSHOT, { document: 'future-document', figureStructure: 'future-figures' });
    assert.notEqual(updated, identity.parserProfile);
    assert.equal(await createLLMCacheRawKey(identity), identity.rawKey);
    assert.notEqual(await createMarkdownCacheKey(PDF, { parserProfile: updated }), identity.cacheKey);
    assert.ok(getPreviousLLMCacheParserProfiles(SNAPSHOT).every(profile => JSON.parse(profile).snapshotHash === SNAPSHOT));
});

test('hashes canonical file content independently of directory order and object metadata', async () => {
    const first = entries();
    const hash = await hashCanonicalLLMEntries(first);
    assert.equal(hash, await hashCanonicalLLMEntries(first.toReversed().map(entry => ({ ...entry, modified: Date.now() }))));
    assert.notEqual(hash, await hashCanonicalLLMEntries([{ ...first[0], data: strToU8('Changed') }, first[1]]));
    assert.notEqual(hash, await hashCanonicalLLMEntries([{ ...first[0], path: 'other.md' }, first[1]]));
    await assert.rejects(hashCanonicalLLMEntries([...first, first[0]]), /duplicate/i);
    await assert.rejects(hashCanonicalLLMEntries([{ path: '../full.md', data: strToU8('Bad') }]), /path/i);
    await assert.rejects(hashCanonicalLLMEntries([{ path: '%66ull.md', data: strToU8('Bad') }]), /path/i);
});

test('reads the same standard entries from the stored archive with resource limits', async () => {
    const source = entries();
    const archive = zipSync(Object.fromEntries(source.map(entry => [entry.path, entry.data])));
    const restored = readCanonicalLLMArchiveEntries(archive);
    assert.equal(await hashCanonicalLLMEntries(restored), await hashCanonicalLLMEntries(source));
    assert.throws(() => readCanonicalLLMArchiveEntries(zipSync({ 'full.md': strToU8('Body'), 'private.pdf': PDF })), /unsupported/i);
    assert.throws(() => readCanonicalLLMArchiveEntries(archive, { maxBytes: 1 }), /limit/i);
    assert.throws(() => readCanonicalLLMArchiveEntries(zipSync({ '../full.md': strToU8('Bad') })), /path/i);
});

test('honors cancellation while hashing a snapshot', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(hashCanonicalLLMEntries(entries(), { signal: controller.signal }), error => error.name === 'AbortError');
});
