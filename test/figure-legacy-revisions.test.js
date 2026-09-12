import test from 'node:test';
import assert from 'node:assert/strict';
import { LEGACY_FIGURE_PROFILES } from '../src/figures/legacy-figure-profiles.js';
import { MinerUDocumentExtractor } from '../src/extractors/mineru-extractor.js';
import { MistralDocumentExtractor } from '../src/extractors/mistral-extractor.js';
import { MINERU_PARSER_PROFILE_ID } from '../src/mineru/parser-profile.js';
import { MISTRAL_PARSER_PROFILE_ID } from '../src/mistral/parser-profile.js';

for (const [provider, Extractor, currentProfile] of [
    ['mineru', MinerUDocumentExtractor, MINERU_PARSER_PROFILE_ID],
    ['mistral', MistralDocumentExtractor, MISTRAL_PARSER_PROFILE_ID],
]) {
    test(`${provider} opens the previous revision under its actual identity without OCR`, async () => {
        let converted = 0;
        const readKeys = [];
        const currentKey = 'a'.repeat(64);
        const oldKey = 'b'.repeat(64);
        const extractor = new Extractor({
            zotero: { Items: { getAsync: async () => ({
                isPDFAttachment: () => true, getFilePathAsync: async () => '/paper.pdf',
            }) } },
            readFile: async () => Uint8Array.of(1), getApiKey: () => '',
            createCacheKey: async (data, { parserProfile }) => parserProfile === currentProfile ? currentKey : oldKey,
            readRevision: async ({ cacheKey }) => {
                readKeys.push(cacheKey);
                return cacheKey === oldKey ? { markdown: 'Corrected legacy text.', assets: [] } : null;
            },
            conversion: { convert: async () => { converted++; return { result: { markdown: 'Fresh.' } }; } },
        });
        const result = await extractor.extract(42);
        assert.equal(result.parserProfile, LEGACY_FIGURE_PROFILES[provider]);
        assert.equal(result.cacheKey, oldKey);
        assert.equal(result.markdown, 'Corrected legacy text.');
        assert.deepEqual(readKeys, [currentKey, oldKey]);
        assert.equal(converted, 0);
        readKeys.length = 0;
        await extractor.extract(42, { forceRefresh: true });
        assert.equal(converted, 1);
        assert.deepEqual(readKeys, []);
        assert.notEqual(currentProfile, LEGACY_FIGURE_PROFILES[provider]);
    });
}
