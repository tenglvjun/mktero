import test from 'node:test';
import assert from 'node:assert/strict';
import { MinerUConversion } from '../src/mineru/mineru-conversion.js';
import { MistralConversion } from '../src/mistral/mistral-conversion.js';
import { MinerUDocumentExtractor } from '../src/extractors/mineru-extractor.js';
import { MistralDocumentExtractor } from '../src/extractors/mistral-extractor.js';
import { MINERU_PARSER_PROFILE_ID, MINERU_PREVIOUS_PARSER_PROFILE_ID } from '../src/mineru/parser-profile.js';
import { MISTRAL_PARSER_PROFILE_ID, MISTRAL_PREVIOUS_PARSER_PROFILE_ID } from '../src/mistral/parser-profile.js';

for (const Conversion of [MinerUConversion, MistralConversion]) {
    for (const failure of [null, 'recover', 'write']) {
        test(`${Conversion.name} upgrades previous cached figures locally despite ${failure || 'no'} failure`, async () => {
            const original = { markdown: 'Original figures', assets: [] };
            const recovered = { markdown: 'Recovered figures', assets: [] };
            const reads = [];
            const writes = [];
            const conversion = new Conversion({
                client: { submit: () => assert.fail('No upload'), collect: () => assert.fail('No collection'),
                    ocr: () => assert.fail('No OCR') },
                pendingTasks: { get: async () => null, put() {}, delete() {} },
                cache: { get: async key => { reads.push(key); return key === 'previous' ? original : null; },
                    put: async (key, result) => {
                        if (failure === 'write') throw new Error('Disk unavailable');
                        writes.push({ key, result });
                    } },
                createPreviousCacheKey: async () => 'previous',
                recoverFigures: async (result, context) => {
                    assert.equal(result, original);
                    assert.deepEqual(context.fileData, Uint8Array.of(1));
                    if (failure === 'recover') throw new Error('No canvas');
                    return recovered;
                },
            });
            const result = await conversion.convert({ key: 'current', fileData: Uint8Array.of(1),
                apiKey: '', cacheEnabled: true });
            assert.equal(result.origin, 'cache');
            assert.equal(result.result.markdown, failure === 'recover' ? original.markdown : recovered.markdown);
            assert.deepEqual(reads, ['current', 'previous']);
            assert.equal(writes.length, failure === 'write' ? 0 : 1);
            if (writes.length) assert.equal(writes[0].key, 'current');
        });
    }

    test(`${Conversion.name} preserves edited results and aborts cache recovery without writing`, async () => {
        let recoveryCalls = 0;
        const controller = new AbortController();
        let edited = true;
        const conversion = new Conversion({
            client: { submit: () => assert.fail('No upload'), collect() {}, ocr: () => assert.fail('No OCR') },
            pendingTasks: { get: async () => null, put() {}, delete() {} },
            cache: { get: async () => ({ markdown: 'Edited', userEdited: edited }),
                put: () => assert.fail('Must not write') },
            recoverFigures: async value => { recoveryCalls++; controller.abort(); return value; },
        });
        const options = { key: 'current', fileData: Uint8Array.of(1), cacheEnabled: true, signal: controller.signal };
        assert.equal((await conversion.convert(options)).result.markdown, 'Edited');
        assert.equal(recoveryCalls, 0);
        edited = false;
        await assert.rejects(conversion.convert(options), { name: 'AbortError' });
        assert.equal(recoveryCalls, 1);
    });
}

for (const [Extractor, currentProfile, previousProfile] of [
    [MinerUDocumentExtractor, MINERU_PARSER_PROFILE_ID, MINERU_PREVIOUS_PARSER_PROFILE_ID],
    [MistralDocumentExtractor, MISTRAL_PARSER_PROFILE_ID, MISTRAL_PREVIOUS_PARSER_PROFILE_ID],
]) {
    test(`${Extractor.name} finds corrected revisions under the previous parser profile`, async () => {
        const profiles = [];
        const extractor = new Extractor({
            zotero: { Items: { getAsync: async () => ({ isPDFAttachment: () => true,
                getFilePathAsync: async () => '/fixture.pdf', getDisplayTitle: () => 'Fixture' }) } },
            conversion: { convert: () => assert.fail('No conversion for a correction') },
            getApiKey: () => '', readFile: async () => Uint8Array.of(1),
            createCacheKey: async (_data, { parserProfile }) => {
                profiles.push(parserProfile);
                return parserProfile === currentProfile ? 'current' : 'previous';
            },
            readRevision: async ({ cacheKey }) => cacheKey === 'previous'
                ? { markdown: 'Corrected (A)', assets: [] } : null,
        });
        const result = await extractor.extract(42);
        assert.equal(result.markdown, 'Corrected (A)');
        assert.equal(result.cacheKey, 'previous');
        assert.equal(result.parserProfile, previousProfile);
        assert.deepEqual(profiles, [currentProfile, previousProfile]);
    });
}
