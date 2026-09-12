import test from 'node:test';
import assert from 'node:assert/strict';
import { MinerUConversion } from '../src/mineru/mineru-conversion.js';
import { MistralConversion } from '../src/mistral/mistral-conversion.js';
import { MinerUDocumentExtractor } from '../src/extractors/mineru-extractor.js';
import { MistralDocumentExtractor } from '../src/extractors/mistral-extractor.js';
import { MINERU_PARSER_PROFILE_ID, MINERU_PREVIOUS_PARSER_PROFILE_IDS } from '../src/mineru/parser-profile.js';
import { MISTRAL_PARSER_PROFILE_ID, MISTRAL_PREVIOUS_PARSER_PROFILE_IDS } from '../src/mistral/parser-profile.js';

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
                createPreviousCacheKeys: async () => ['previous', 'older'],
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

    test(`${Conversion.name} tries both compatible profiles once and migrates the older cache without uploading`, async () => {
        const reads = [];
        const original = { markdown: 'Figure with its misplaced title', assets: [] };
        const converted = new Conversion({
            client: { submit: () => assert.fail('No upload'), collect() {}, ocr: () => assert.fail('No OCR') },
            pendingTasks: { get: async () => null, put() {}, delete() {} },
            cache: { get: async key => { reads.push(key); return key === 'older' ? original : null; },
                put: async (key, value) => { assert.equal(key, 'current'); assert.equal(value, original); } },
            createPreviousCacheKeys: async () => ['current', 'previous', 'previous', 'older'],
        });
        const result = await converted.convert({ key: 'current', fileData: Uint8Array.of(1), cacheEnabled: true });
        assert.equal(result.origin, 'cache');
        assert.deepEqual(reads, ['current', 'previous', 'older']);
    });

    test(`${Conversion.name} stops previous-cache lookup immediately after cancellation`, async () => {
        const controller = new AbortController();
        const reads = [];
        const conversion = new Conversion({
            client: { submit: () => assert.fail('No upload'), collect() {}, ocr: () => assert.fail('No OCR') },
            pendingTasks: { get: async () => null, put() {}, delete() {} },
            cache: { get: async key => { reads.push(key); if (key === 'previous') controller.abort(); return null; },
                put: () => assert.fail('No write') },
            createPreviousCacheKeys: async () => ['previous', 'older'],
        });
        await assert.rejects(conversion.convert({ key: 'current', cacheEnabled: true, signal: controller.signal }),
            { name: 'AbortError' });
        assert.deepEqual(reads, ['current', 'previous']);
    });
}

for (const [Extractor, currentProfile, previousProfiles] of [
    [MinerUDocumentExtractor, MINERU_PARSER_PROFILE_ID, MINERU_PREVIOUS_PARSER_PROFILE_IDS],
    [MistralDocumentExtractor, MISTRAL_PARSER_PROFILE_ID, MISTRAL_PREVIOUS_PARSER_PROFILE_IDS],
]) {
    for (const [index, previousProfile] of previousProfiles.entries()) {
        test(`${Extractor.name} finds corrected revisions under compatible profile ${index + 1}`, async () => {
            const profiles = [];
            const extractor = new Extractor({
                zotero: { Items: { getAsync: async () => ({ isPDFAttachment: () => true,
                    getFilePathAsync: async () => '/fixture.pdf', getDisplayTitle: () => 'Fixture' }) } },
                conversion: { convert: () => assert.fail('No conversion for a correction') },
                getApiKey: () => '', readFile: async () => Uint8Array.of(1),
                createCacheKey: async (_data, { parserProfile }) => {
                    profiles.push(parserProfile);
                    return parserProfile === previousProfile ? 'previous' : 'unmatched-' + profiles.length;
                },
                readRevision: async ({ cacheKey }) => cacheKey === 'previous'
                    ? { markdown: 'Corrected (A)', assets: [] } : null,
            });
            const result = await extractor.extract(42);
            assert.equal(result.markdown, 'Corrected (A)');
            assert.equal(result.cacheKey, 'previous');
            assert.equal(result.parserProfile, previousProfile);
            assert.deepEqual(profiles, [currentProfile, ...previousProfiles.slice(0, index + 1)]);
        });
    }
}
