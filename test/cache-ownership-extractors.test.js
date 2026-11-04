import test from 'node:test';
import assert from 'node:assert/strict';
import { MinerUDocumentExtractor } from '../src/extractors/mineru-extractor.js';
import { MistralDocumentExtractor } from '../src/extractors/mistral-extractor.js';
import { MkteroDocumentExtractor } from '../src/extractors/mktero-extractor.js';

for (const Extractor of [MinerUDocumentExtractor, MistralDocumentExtractor, MkteroDocumentExtractor]) {
    test(`${Extractor.name} registers the actual PDF before cache reads, conversions or index writes`, async () => {
        const item = { id: 42, libraryID: 1, key: 'PDF42', isPDFAttachment: () => true,
            getFilePathAsync: async () => '/test.pdf', getDisplayTitle: () => 'Test' };
        const data = Uint8Array.of(1, 2, 3);
        let registered = false;
        let registrations = 0;
        const check = () => assert.equal(registered, true);
        const extractor = new Extractor({
            zotero: { Items: { getAsync: async () => item } },
            conversion: {
                async convert() { check(); return { result: { markdown: 'Text', assets: [] }, origin: 'network' }; },
                async readCached() { check(); return null; },
            },
            getApiKey: () => 'test', getApiBase: () => 'https://example.invalid', getAccessToken: () => 'test',
            readFile: async () => data,
            onPDFRead: async (value, bytes) => {
                assert.equal(value, item); assert.equal(bytes, data);
                await Promise.resolve();
                registered = true;
                registrations++;
            },
            preparePDFIndex: async () => check(),
            createCacheKey: async () => { check(); return 'a'.repeat(64); },
            createSourceHash: async () => 'b'.repeat(64), isCacheEnabled: () => true,
            cache: { get: async () => { check(); return null; }, put: async () => check() },
        });
        await extractor.readCached(42);
        registered = false;
        await extractor.extract(42);
        assert.equal(registrations, 2);
    });
}
