import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MinerUConfigurationError,
    MinerUDocumentExtractor,
} from '../src/extractors/mineru-extractor.js';

function createPDFItem(overrides = {}) {
    return {
        id: 42,
        parentItem: { getDisplayTitle: () => 'Parent Paper' },
        attachmentFilename: 'paper.pdf',
        isPDFAttachment: () => true,
        getDisplayTitle: () => 'Attachment Title',
        getFilePathAsync: async () => '/tmp/paper.pdf',
        ...overrides,
    };
}

test('reads the current Zotero PDF and sends it to MinerU', async () => {
    const calls = [];
    const extractor = new MinerUDocumentExtractor({
        zotero: { Items: { getAsync: async () => createPDFItem() } },
        client: {
            parse: async options => {
                calls.push(options);
                return {
                    markdown: '# MinerU result',
                    extractedPages: 3,
                    totalPages: 3,
                };
            },
        },
        getApiKey: () => 'configured-token',
        readFile: async path => {
            assert.equal(path, '/tmp/paper.pdf');
            return new Uint8Array([1, 2, 3]);
        },
    });
    const progress = [];
    const controller = new AbortController();

    const result = await extractor.extract(42, {
        onProgress: value => progress.push(value),
        signal: controller.signal,
    });

    assert.equal(result.kind, 'markdown');
    assert.equal(result.title, 'Parent Paper');
    assert.equal(result.markdown, '# MinerU result');
    assert.equal(calls[0].apiKey, 'configured-token');
    assert.equal(calls[0].fileName, 'paper.pdf');
    assert.equal(calls[0].dataID, 'zotero-42');
    assert.equal(calls[0].signal, controller.signal);
    assert.deepEqual([...calls[0].fileData], [1, 2, 3]);
    calls[0].onProgress(50);
    assert.deepEqual(progress, [50]);
});

test('requires a configured MinerU API token', async () => {
    const extractor = new MinerUDocumentExtractor({
        zotero: { Items: { getAsync: async () => createPDFItem() } },
        client: { parse: async () => assert.fail('MinerU should not be called') },
        getApiKey: () => '  ',
        readFile: async () => new Uint8Array(),
    });

    await assert.rejects(
        () => extractor.extract(42),
        error => error instanceof MinerUConfigurationError
    );
});

test('reports a missing local attachment file', async () => {
    const extractor = new MinerUDocumentExtractor({
        zotero: {
            Items: {
                getAsync: async () => createPDFItem({ getFilePathAsync: async () => false }),
            },
        },
        client: { parse: async () => assert.fail('MinerU should not be called') },
        getApiKey: () => 'configured-token',
        readFile: async () => new Uint8Array(),
    });

    await assert.rejects(
        () => extractor.extract(42),
        /local PDF file is unavailable/i
    );
});
