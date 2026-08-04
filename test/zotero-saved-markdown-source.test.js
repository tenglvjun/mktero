import test from 'node:test';
import assert from 'node:assert/strict';
import {
    resolveZoteroSavedMarkdownSourceItem,
} from '../src/platform/zotero-saved-markdown-source.js';

test('resolves a saved source PDF through the async Zotero item fallback', async () => {
    const source = {
        key: 'PDF00001',
        isPDFAttachment: () => true,
    };
    const calls = [];
    const zotero = {
        Libraries: { userLibraryID: 1 },
        Items: {
            async getAll(...args) {
                calls.push(args);
                return [source];
            },
        },
    };

    assert.equal(
        await resolveZoteroSavedMarkdownSourceItem(zotero, {
            sourcePDFKey: 'PDF00001',
            sourceLibraryKey: null,
        }),
        source
    );
    assert.deepEqual(calls, [[1, false, false, false]]);
});

test('does not coerce a missing source library into library zero', async () => {
    const calls = [];
    const zotero = {
        Libraries: { userLibraryID: 7 },
        Items: {
            getByLibraryAndKey(libraryID) {
                calls.push(libraryID);
                return null;
            },
        },
    };

    assert.equal(
        await resolveZoteroSavedMarkdownSourceItem(zotero, {
            sourcePDFKey: 'PDF00001',
        }),
        null
    );
    assert.deepEqual(calls, [7]);
});

test('resolves item IDs returned by Zotero item lookup APIs', async () => {
    const source = {
        id: 42,
        key: 'PDF00001',
        isPDFAttachment: () => true,
    };
    const zotero = {
        Libraries: { userLibraryID: 1 },
        Items: {
            getByLibraryAndKey: () => 42,
            getAsync: async id => id === 42 ? source : null,
        },
    };

    assert.equal(
        await resolveZoteroSavedMarkdownSourceItem(zotero, {
            sourcePDFKey: 'PDF00001',
            sourceLibraryKey: '1',
        }),
        source
    );
});
