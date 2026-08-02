import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createZoteroEvidenceReference,
} from '../src/platform/zotero-evidence-reference.js';

test('creates page references for a personal-library PDF attachment', async () => {
    const attachment = {
        key: 'ATTACH01',
        libraryID: 1,
        parentItem: { getDisplayTitle: () => 'Parent paper' },
        isPDFAttachment: () => true,
    };
    const reference = createZoteroEvidenceReference({
        Items: { getAsync: async itemID => itemID === 42 ? attachment : null },
        Libraries: { get: () => ({ libraryType: 'user' }) },
    });

    assert.deepEqual(await reference.resolve(42, [0, 2]), {
        title: 'Parent paper',
        pages: [
            {
                pageIndex: 0,
                pageNumber: 1,
                href: 'zotero://open-pdf/library/items/ATTACH01?page=1',
            },
            {
                pageIndex: 2,
                pageNumber: 3,
                href: 'zotero://open-pdf/library/items/ATTACH01?page=3',
            },
        ],
    });
});

test('creates page references for a group-library PDF attachment', async () => {
    const attachment = {
        key: 'GROUPPDF',
        libraryID: 7,
        parentItem: null,
        getDisplayTitle: () => 'Standalone PDF',
        isPDFAttachment: () => true,
    };
    const reference = createZoteroEvidenceReference({
        Items: { getAsync: async () => attachment },
        Libraries: {
            get: libraryID => libraryID === 7
                ? { libraryType: 'group', groupID: 31415 }
                : null,
        },
    });

    assert.deepEqual(await reference.resolve(7, [4]), {
        title: 'Standalone PDF',
        pages: [{
            pageIndex: 4,
            pageNumber: 5,
            href: 'zotero://open-pdf/groups/31415/items/GROUPPDF?page=5',
        }],
    });
});

test('normalizes group IDs and falls back from blank parent titles', async () => {
    const attachment = {
        key: 'GROUPPDF',
        libraryID: 7,
        parentItem: { getDisplayTitle: () => '   ' },
        getDisplayTitle: () => '  Standalone PDF  ',
        isPDFAttachment: () => true,
    };
    const reference = createZoteroEvidenceReference({
        Items: { getAsync: async () => attachment },
        Libraries: {
            get: () => ({ libraryType: 'group', groupID: ' 31415 ' }),
        },
    });

    assert.deepEqual(await reference.resolve(7, [4]), {
        title: 'Standalone PDF',
        pages: [{
            pageIndex: 4,
            pageNumber: 5,
            href: 'zotero://open-pdf/groups/31415/items/GROUPPDF?page=5',
        }],
    });
});

test('localizes an unavailable attachment title', async () => {
    const reference = createZoteroEvidenceReference({
        Items: {
            getAsync: async () => ({
                key: 'ATTACH01',
                libraryID: 1,
                parentItem: { getDisplayTitle: () => '' },
                getDisplayTitle: () => '   ',
                isPDFAttachment: () => true,
            }),
        },
        Libraries: { get: () => ({ libraryType: 'user' }) },
    }, key => key === 'document.untitled' ? '未命名 PDF' : key);

    assert.equal((await reference.resolve(42, [0])).title, '未命名 PDF');
});

test('rejects unavailable attachments and malformed source pages', async () => {
    const reference = createZoteroEvidenceReference({
        Items: { getAsync: async () => null },
        Libraries: { get: () => null },
    });

    await assert.rejects(() => reference.resolve(42, [0]), /attachment/i);

    const malformedPages = createZoteroEvidenceReference({
        Items: {
            getAsync: async () => ({
                key: 'ATTACH01',
                libraryID: 1,
                isPDFAttachment: () => true,
            }),
        },
        Libraries: { get: () => ({ libraryType: 'user' }) },
    });
    await assert.rejects(() => malformedPages.resolve(42, [-1]), /pages/i);

    const missingLibrary = createZoteroEvidenceReference({
        Items: {
            getAsync: async () => ({
                key: 'ATTACH01',
                libraryID: 1,
                isPDFAttachment: () => true,
            }),
        },
        Libraries: { get: () => null },
    });
    await assert.rejects(() => missingLibrary.resolve(42, [0]), /library/i);
});
