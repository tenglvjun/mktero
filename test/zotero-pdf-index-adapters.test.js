import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createZoteroPDFFileLoader,
    createZoteroTextMeasurer,
} from '../src/platform/zotero-pdf-index-adapters.js';

test('loads the current local Zotero PDF attachment', async () => {
    const fileData = new Uint8Array([1, 2, 3]);
    const loader = createZoteroPDFFileLoader({
        Items: {
            async getAsync(itemID) {
                assert.equal(itemID, 42);
                return {
                    isPDFAttachment: () => true,
                    getFilePathAsync: async () => '/profile/paper.pdf',
                };
            },
        },
    }, async filePath => {
        assert.equal(filePath, '/profile/paper.pdf');
        return fileData;
    });

    assert.equal(await loader(42), fileData);
});

test('measures text through the current Zotero window after windows change', () => {
    let activeWindow = createWindow(1);
    const measurer = createZoteroTextMeasurer({
        getMainWindow: () => activeWindow,
    });

    assert.equal(measurer({ text: 'abcd', fontFamily: 'serif' }), 4);
    activeWindow = createWindow(2);
    assert.equal(measurer({ text: 'abcd', fontFamily: 'serif' }), 8);
});

function createWindow(multiplier) {
    return {
        document: {
            createElementNS(namespace, tagName) {
                assert.equal(namespace, 'http://www.w3.org/1999/xhtml');
                assert.equal(tagName, 'canvas');
                return {
                    getContext(type) {
                        assert.equal(type, '2d');
                        return {
                            font: '',
                            measureText(text) {
                                return { width: [...text].length * multiplier };
                            },
                        };
                    },
                };
            },
        },
    };
}
