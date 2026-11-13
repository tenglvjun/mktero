import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createEmptyAnnotationOverlay } from '../src/core/markdown-annotation-overlay.js';
import {
    SavedMarkdownOpenResolver,
} from '../src/core/saved-markdown-open-resolver.js';
import { sha256Hex } from '../src/core/sha256.js';

import { MINERU_CLOUD_CACHE_PROFILE_IDS } from '../src/mineru/parser-profile.js';

const hash = value => sha256Hex(value, { crypto: webcrypto });

async function manifestFor(markdown, overrides = {}) {
    return {
        cacheKey: 'a'.repeat(64),
        markdownHash: await hash(new TextEncoder().encode(markdown)),
        parserProfile: 'profile-v1',
        assetBasePath: '',
        assets: [],
        ...overrides,
    };
}

function savedNote(markdown, overrides = {}) {
    return {
        note: {
            id: 900,
            getDisplayTitle: () => 'Saved note',
        },
        noteID: 900,
        manifest: overrides.manifest,
        bodyHTML: '<h1>Snapshot</h1>',
        markdown,
        sourceMap: [],
        sourceAvailable: true,
        snapshotAvailable: true,
        snapshotModified: false,
        assets: [],
        assetsComplete: true,
        ...overrides,
    };
}

test('prefers a matching local cache over synced source attachments', async () => {
    const markdown = '# Local';
    const sourceItem = {
        id: 42,
        isPDFAttachment: () => true,
        parentItem: { getDisplayTitle: () => 'Paper' },
    };
    const manifest = await manifestFor(markdown);
    const resolver = new SavedMarkdownOpenResolver({
        store: { read: async () => savedNote('# Synced', {
            manifest,
            sourceAvailable: true,
            markdown: '# Synced',
        }) },
        cache: {
            get: async () => ({
                markdown,
                assets: [],
                assetBasePath: '',
                sourceMap: [],
            }),
        },
        resolveSourceItem: async () => sourceItem,
        hash,
    });

    const result = await resolver.resolve(900);

    assert.equal(result.documentID, 900);
    assert.equal(result.sourceItemID, 42);
    assert.equal(result.markdown, markdown);
    assert.equal(result.cacheHit, true);
    assert.equal(result.renderMode, 'markdown');
    assert.equal(result.parserProfile, manifest.parserProfile);
});

test('accepts any supported parser profile when resolving a saved note', async () => {
    const markdown = '# Mistral';
    const manifest = await manifestFor(markdown, {
        parserProfile: 'mistral-profile-v1',
    });
    const resolver = new SavedMarkdownOpenResolver({
        store: { read: async () => savedNote(markdown, { manifest }) },
        cache: {
            get: async () => ({
                markdown,
                assets: [],
                sourceMap: [],
            }),
        },
        parserProfiles: ['mineru-profile-v1', 'mistral-profile-v1'],
        resolveSourceItem: async () => ({
            id: 42,
            isPDFAttachment: () => true,
        }),
        hash,
    });

    const result = await resolver.resolve(900);

    assert.equal(result.cacheHit, true);
    assert.equal(result.parserProfile, 'mistral-profile-v1');
});

for (const parserProfile of MINERU_CLOUD_CACHE_PROFILE_IDS) {
    test(`opens the retained ${JSON.parse(parserProfile).batch.model_version} snapshot with its original parser identity`, async () => {
        const markdown = '# Retained model snapshot';
        const manifest = await manifestFor(markdown, { parserProfile });
        const resolver = new SavedMarkdownOpenResolver({
            store: { read: async () => savedNote(markdown, { manifest }) },
            cache: { get: async key => {
                assert.equal(key, manifest.cacheKey);
                return { markdown, assets: [], sourceMap: [] };
            } },
            parserProfiles: MINERU_CLOUD_CACHE_PROFILE_IDS,
            resolveSourceItem: async () => ({ id: 42, isPDFAttachment: () => true }),
            hash,
        });
        const result = await resolver.resolve(900);
        assert.equal(result.cacheHit, true);
        assert.equal(result.parserProfile, parserProfile);
        assert.equal(result.markdown, markdown);
    });
}

test('rejects an unsupported parser profile when a whitelist is supplied', async () => {
    const markdown = '# Unknown';
    const manifest = await manifestFor(markdown, {
        parserProfile: 'unknown-profile-v1',
    });
    const resolver = new SavedMarkdownOpenResolver({
        store: { read: async () => savedNote(markdown, { manifest }) },
        cache: {
            get: async () => assert.fail('unsupported profile must miss cache'),
        },
        parserProfiles: ['mineru-profile-v1', 'mistral-profile-v1'],
        resolveSourceItem: async () => ({
            id: 42,
            isPDFAttachment: () => true,
        }),
        hash,
    });

    const result = await resolver.resolve(900);

    assert.equal(result.cacheHit, false);
    assert.equal(result.parserProfile, 'unknown-profile-v1');
});

test('rejects a different cached hash and then uses synchronized source', async () => {
    const markdown = '# Synced';
    const manifest = await manifestFor(markdown);
    const resolver = new SavedMarkdownOpenResolver({
        store: {
            read: async () => savedNote(markdown, { manifest }),
        },
        cache: {
            get: async () => ({
                markdown: '# Other',
                assets: [],
                sourceMap: [],
            }),
        },
        resolveSourceItem: async () => ({
            id: 42,
            isPDFAttachment: () => true,
        }),
        hash,
    });

    const result = await resolver.resolve(900);

    assert.equal(result.markdown, markdown);
    assert.equal(result.cacheHit, false);
    assert.equal(result.sourceItemID, 42);
});

test('uses synchronized source without reading cache for a recovered snapshot', async () => {
    const markdown = '# Recovered';
    const manifest = await manifestFor(markdown, { cacheKey: null });
    const resolver = new SavedMarkdownOpenResolver({
        store: {
            read: async () => savedNote(markdown, { manifest }),
        },
        cache: {
            get: async () => assert.fail(
                'a recovered snapshot has no cache key to read'
            ),
        },
        resolveSourceItem: async () => ({
            id: 42,
            isPDFAttachment: () => true,
        }),
        hash,
    });

    const result = await resolver.resolve(900);

    assert.equal(result.markdown, markdown);
    assert.equal(result.cacheHit, false);
    assert.equal(result.cacheKey, null);
    assert.equal(result.sourceItemID, 42);
});

test('falls back to the synced HTML snapshot when source attachments are missing', async () => {
    const markdown = '# Source';
    const manifest = await manifestFor(markdown, {
        assets: [{
            path: 'figure.png',
            attachmentKey: 'IMAGE01',
            mimeType: 'image/png',
        }],
    });
    const resolver = new SavedMarkdownOpenResolver({
        store: {
            read: async () => savedNote(markdown, {
                manifest,
                sourceAvailable: false,
                assetsComplete: false,
                bodyHTML: '<h1>Portable snapshot</h1>',
                assets: [{
                    path: 'figure.png',
                    attachmentKey: 'IMAGE01',
                    mimeType: 'image/png',
                    data: new Uint8Array([1]),
                }],
            }),
        },
        resolveSourceItem: async () => null,
        hash,
    });

    const result = await resolver.resolve(900);

    assert.equal(result.documentID, 900);
    assert.equal(result.sourceItemID, null);
    assert.equal(result.renderMode, 'html');
    assert.equal(result.snapshotHTML, '<h1>Portable snapshot</h1>');
    assert.deepEqual(result.annotationOverlay, createEmptyAnnotationOverlay());
    assert.match(result.warnings[0], /source is unavailable/i);
});
