import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    MarkdownTranslationService,
    TRANSLATION_PROFILE_ID,
    TRANSLATION_PROMPT_VERSION,
} from '../src/ai/markdown-translation-service.js';
import { collectMarkdownTranslationBlocks } from '../src/markdown/markdown-translation-blocks.js';
import { assembleAlignedBlock, createAlignmentPlan } from '../src/markdown/translation-alignment.js';

const settings = {
    enabled: true, streaming: false, provider: 'custom', protocol: 'openai-chat-completions',
    apiBase: 'https://example.invalid/v1', model: 'example', apiKey: 'fixture', targetLanguage: 'zh-CN',
};
const documentKey = 'a'.repeat(64);
const markdown = '# Private heading\n\nAccuracy improved. Latency fell.\n\nKeep this paragraph.';
const options = { markdown, documentKey };
const v7 = 'mktero-translation-v7';
const v8 = 'mktero-translation-v8';
const hash = value => createHash('sha256').update(value).digest('hex');
const words = new Map([['Accuracy improved.', '准确率提高了。'], ['Latency fell.', '延迟下降了。']]);

function response(entries) {
    return entries.map(entry => entry.units ? {
        id: entry.id,
        units: entry.units.map(unit => ({ id: unit.id, translatedMarkdown: words.get(unit.sourceMarkdown) || unit.sourceMarkdown })).reverse(),
    } : { id: entry.id, translatedMarkdown: entry.sourceMarkdown }).reverse();
}

function fixture({ generate = response, unfilteredLanguageLookup = false } = {}) {
    const records = new Map();
    const calls = [];
    const writes = [];
    const service = new MarkdownTranslationService({
        getSettings: () => settings,
        createCacheKey: hash,
        aiGateway: { async generateText(request) {
            const entries = JSON.parse(request.messages[1].content);
            calls.push(entries);
            assert.doesNotMatch(JSON.stringify(request.messages), /translation-\d+-|"(?:sourceRanges|from|to|offset|sectionHeading)"\s*:/);
            return { text: JSON.stringify(await generate(entries, calls.length)) };
        } },
        cache: {
            getTranslation: async (key, translationKey) => (
                key === documentKey ? structuredClone(records.get(translationKey) || null) : null
            ),
            getTranslationByLanguage: async (key, language, identity) => {
                if (key !== documentKey) return null;
                assert.equal(identity.promptVersion, v8);
                assert.equal(identity.translationProfile, TRANSLATION_PROFILE_ID);
                assert.equal(identity.settingsIdentity, JSON.stringify(settingsIdentity(language)));
                const record = [...records.values()].reverse().find(value => value.targetLanguage === language
                    && (unfilteredLanguageLookup || (value.promptVersion === identity.promptVersion
                        && value.translationProfile === identity.translationProfile
                        && value.settingsIdentity === identity.settingsIdentity)));
                return structuredClone(record || null);
            },
            async putTranslation(key, translationKey, value, { signal } = {}) {
                assert.equal(key, documentKey);
                assert.equal(value.partial, value.failedBlocks.length > 0);
                signal?.throwIfAborted();
                writes.push(translationKey);
                records.delete(translationKey);
                records.set(translationKey, structuredClone(value));
            },
        },
    });
    return { service, records, calls, writes };
}

function settingsIdentity(targetLanguage = settings.targetLanguage) {
    return {
        provider: settings.provider, protocol: settings.protocol, apiBase: settings.apiBase,
        model: settings.model, reasoning: 'none', targetLanguage, promptVersion: v8,
        translationProfile: TRANSLATION_PROFILE_ID,
    };
}

function translationKey(source, identity = settingsIdentity()) {
    return hash(JSON.stringify({ documentKey, source, ...identity }));
}

function installLegacy(records, { promptVersion, alignedIndices = [], partial = false }) {
    const identity = { ...settingsIdentity(), promptVersion };
    delete identity.translationProfile;
    const key = translationKey(markdown, identity);
    const sourceBlocks = collectMarkdownTranslationBlocks(markdown).filter(block => block.translatable);
    const written = ['# 旧标题', '旧准确率。旧延迟。', '旧保留段落。'];
    const unitsByBlock = [['旧标题'], ['旧准确率。', '旧延迟。'], ['旧保留段落。']];
    const blocks = sourceBlocks.map((block, i) => {
        if (!alignedIndices.includes(i)) return { id: block.id, markdown: written[i] };
        const plan = createAlignmentPlan(block);
        return assembleAlignedBlock(block, plan.units.map(({ id }, j) => ({ id, translatedMarkdown: unitsByBlock[i][j] })), settings.targetLanguage);
    });
    const failedBlocks = partial ? [{ id: blocks[2].id, message: 'Interrupted' }] : [];
    if (partial) blocks[2].markdown = sourceBlocks[2].markdown;
    const record = {
        blocks,
        sourceBlocks: sourceBlocks.map(({ id, markdown }) => ({ id, markdown })),
        translatedMarkdown: blocks.map(block => block.markdown).join('\n\n'), comparisonMarkdown: '',
        settingsIdentity: JSON.stringify(identity), targetLanguage: settings.targetLanguage, model: settings.model,
        promptVersion, partial, failedBlocks,
    };
    records.set(key, record);
    return { key, record };
}

function visibleResult(record, key) {
    const { promptVersion, partial, ...value } = record;
    return { ...value, sourceMarkdown: markdown, translationKey: key, documentKey };
}

for (const [name, legacy] of [
    ['v7', { promptVersion: v7 }],
    ['original fully aligned v8', { promptVersion: v8, alignedIndices: [0, 1, 2] }],
    ['original mixed partial v8', { promptVersion: v8, alignedIndices: [1], partial: true }],
]) {
    test(`${name} is skipped for exact reads, correction reuse and visible block retries`, async () => {
        const { service, records, calls, writes } = fixture();
        const { key, record } = installLegacy(records, legacy);
        const old = structuredClone(record);
        const existingTranslation = visibleResult(record, key);
        const corrected = { ...options, markdown: `Added.\n\n${markdown}` };
        for (const source of [options, corrected]) {
            assert.equal(await service.getCachedDocumentTranslation(source), null);
            assert.deepEqual(await service.listCachedDocumentTranslationVariants(source), []);
            assert.equal(await service.reconcileDocumentTranslation({ ...source, existingTranslation }), null);
        }
        assert.deepEqual([calls, writes], [[], []]);
        const result = await service.translateDocument({ ...options, existingTranslation, retryBlockIDs: [record.blocks[2].id] });
        assert.equal(result.cacheHit, false);
        assert.equal(result.partial, false);
        assert.equal(result.promptVersion, TRANSLATION_PROMPT_VERSION);
        assert.equal(result.translationProfile, TRANSLATION_PROFILE_ID);
        assert.equal(result.translationKey, translationKey(markdown));
        assert.notEqual(result.translationKey, key);
        assert.deepEqual(writes, [result.translationKey]);
        assert.deepEqual(records.get(key), old);
        assert.deepEqual(calls.map(entries => entries.length), [3]);
        assert.ok(result.blocks.every(block => block.alignment));
        assert.doesNotMatch(result.translatedMarkdown, /旧/);
        const reopened = await service.getCachedDocumentTranslation(options);
        assert.deepEqual(reopened.blocks, result.blocks);
        assert.equal(reopened.translationProfile, TRANSLATION_PROFILE_ID);
    });
}

for (const [name, changes] of [
    ['missing explicit profile', { translationProfile: undefined }],
    ['different explicit profile', { translationProfile: 'mktero-translation-profile-v2' }],
    ['non-exact profile', { translationProfile: `${TRANSLATION_PROFILE_ID} ` }],
    ['different prompt', { promptVersion: v7 }],
    ['different settings identity', { settingsIdentity: JSON.stringify({ ...settingsIdentity(), model: 'previous-model' }) }],
]) {
    test(`rejects a record under the current key or visible state with ${name}`, async () => {
        const { service, records, calls, writes } = fixture({ unfilteredLanguageLookup: true });
        const { record } = installLegacy(records, { promptVersion: v8, alignedIndices: [1], partial: true });
        const key = translationKey(markdown);
        const mismatched = { ...record, settingsIdentity: JSON.stringify(settingsIdentity()),
            translationProfile: TRANSLATION_PROFILE_ID, ...changes };
        records.set(key, mismatched);
        const existingTranslation = { ...visibleResult(mismatched, key), promptVersion: mismatched.promptVersion };
        assert.equal(await service.getCachedDocumentTranslation(options), null);
        assert.deepEqual(await service.listCachedDocumentTranslationVariants(options), []);
        assert.equal(await service.reconcileDocumentTranslation({ ...options, existingTranslation }), null);
        const corrected = { ...options, markdown: `Added.\n\n${markdown}` };
        assert.equal(await service.getCachedDocumentTranslation(corrected), null);
        assert.equal(await service.reconcileDocumentTranslation({ ...corrected, existingTranslation }), null);
        assert.deepEqual([calls, writes], [[], []]);
        const result = await service.translateDocument({ ...options, existingTranslation, retryBlockIDs: [record.blocks[2].id] });
        assert.deepEqual(calls.map(entries => entries.length), [3]);
        assert.equal(result.translationProfile, TRANSLATION_PROFILE_ID);
        assert.doesNotMatch(result.translatedMarkdown, /旧/);
    });
}

test('skips newer legacy records while reusing a partial current profile on correction and retry', async () => {
    let failLastBlock = true;
    const { service, records, calls, writes } = fixture({ generate(entries) {
        return response(entries).filter(block => !failLastBlock
            || !block.units?.some(unit => unit.translatedMarkdown === 'Keep this paragraph.'));
    } });
    const partial = await service.translateDocument(options);
    assert.equal(partial.partial, true);
    assert.equal(partial.translationProfile, TRANSLATION_PROFILE_ID);
    const completedCalls = calls.length;
    failLastBlock = false;
    installLegacy(records, { promptVersion: v8, alignedIndices: [1], partial: true });
    const corrected = { ...options, markdown: `Added.\n\n${markdown}` };
    const [cached] = await service.listCachedDocumentTranslationVariants(corrected);
    assert.equal(cached.translationProfile, TRANSLATION_PROFILE_ID);
    assert.equal(cached.partial, true);
    assert.equal(cached.blocks[2].markdown, partial.blocks[1].markdown);
    assert.equal(cached.blocks[2].alignment.units.length, 2);
    records.delete(partial.translationKey);
    const visible = await service.reconcileDocumentTranslation({
        ...corrected,
        existingTranslation: visibleResult(partial, partial.translationKey),
    });
    assert.deepEqual(visible.failedBlocks, cached.failedBlocks);
    assert.equal(records.get(partial.translationKey).partial, true);
    assert.equal(records.get(partial.translationKey).translationProfile, TRANSLATION_PROFILE_ID);
    const retried = await service.translateDocument(corrected);
    assert.equal(retried.partial, false);
    assert.equal(retried.translationProfile, TRANSLATION_PROFILE_ID);
    const retriedSources = calls.slice(completedCalls).flatMap(entries => (
        entries.flatMap(entry => entry.units.map(unit => unit.sourceMarkdown))
    ));
    assert.deepEqual(retriedSources.sort(), ['Added.', 'Keep this paragraph.']);
    assert.deepEqual(writes, [partial.translationKey, partial.translationKey, retried.translationKey]);
    assert.doesNotMatch(retried.translatedMarkdown + retried.comparisonMarkdown, /旧|translation-|alignment|\.s1/);
});

test('rejects a removed per-block alignment upgrade before sending source text', async () => {
    const { service, records, calls, writes } = fixture();
    const { record, key } = installLegacy(records, { promptVersion: v7 });
    await assert.rejects(service.translateDocument({
        ...options, alignmentBlockID: record.blocks[1].id, existingTranslation: visibleResult(record, key),
    }), { code: 'AI_INVALID_REQUEST' });
    assert.deepEqual([calls, writes], [[], []]);
});

for (const invalid of ['missing', 'duplicate', 'foreign']) {
    test(`reordered blocks and units are accepted; a ${invalid} unit retries only its own block`, async () => {
        const { service, calls } = fixture({ generate(entries, n) {
            const result = response(entries);
            if (n === 1) {
                const units = result.find(block => block.units.length === 2).units;
                if (invalid === 'missing') units.pop();
                if (invalid === 'duplicate') units[1].id = units[0].id;
                if (invalid === 'foreign') units[1].id = result.find(block => block.units.length === 1).units[0].id;
            }
            return result;
        } });
        const result = await service.translateDocument(options);
        assert.equal(result.partial, false);
        assert.deepEqual(calls.map(entries => entries.length), [3, 1]);
        assert.ok(calls[1][0].units.every(unit => words.has(unit.sourceMarkdown)));
        assert.ok(result.blocks.every(block => block.alignment?.version === 1));
        assert.deepEqual(result.blocks[1].alignment.units.map(unit => unit.translatedMarkdown), [...words.values()]);
    });
}

test('v8 corruption drops sentence provenance without marking the readable translation as failed', async () => {
    const { service, records, calls, writes } = fixture();
    const result = await service.translateDocument(options);
    const stored = records.get(result.translationKey);
    stored.blocks[1].alignment.units[0].translatedMarkdown = 'stale sentence';
    stored.blocks[2].alignment.version = 99;
    const reopened = await service.translateDocument(options);
    assert.equal(reopened.translatedMarkdown, result.translatedMarkdown);
    assert.equal(reopened.partial, false);
    assert.deepEqual(reopened.blocks.map(block => Boolean(block.alignment)), [true, false, false]);
    assert.deepEqual([calls.length, writes.length], [1, 1]);
});

test('incorrect stored source ranges are rejected both on exact reopen and when relocating the old block', async () => {
    const { service, records, calls } = fixture();
    const generated = await service.translateDocument(options);
    const stored = records.get(generated.translationKey);
    const unit = stored.blocks[1].alignment.units[1];
    assert.deepEqual(unit.sourceRanges, [{ from: 19, to: 32 }]);
    unit.sourceRanges = [{ from: 0, to: 18 }];
    const exact = await service.getCachedDocumentTranslation(options);
    const corrected = await service.getCachedDocumentTranslation({ ...options, markdown: `Added.\n\n${markdown}` });
    for (const block of [exact.blocks[1], corrected.blocks[2]]) {
        assert.equal(block.markdown, '准确率提高了。延迟下降了。');
        assert.equal(block.alignment, undefined);
    }
    assert.equal(calls.length, 1);
});

test('a misplaced protected fragment is repaired only through segments scoped to their original unit', async () => {
    const { service, calls } = fixture({ generate(entries) {
        if ('sourceText' in entries[0]) return entries.map(({ id, sourceText }) => ({ id, translatedText: `译${sourceText}` }));
        const result = response(entries);
        const [second, first] = result[0].units;
        const placeholder = first.translatedMarkdown.match(/MKTEROPROTECTED\d+PLACEHOLDER/)[0];
        first.translatedMarkdown = first.translatedMarkdown.replace(placeholder, '');
        second.translatedMarkdown += placeholder;
        return result;
    } });
    const result = await service.translateDocument({ ...options, markdown: 'Compare $x$. Measure latency.' });
    assert.equal(calls.length, 4);
    assert.equal(result.partial, false);
    assert.equal(result.blocks[0].alignment.units.length, 2);
    assert.match(result.blocks[0].alignment.units[0].translatedMarkdown, /MKTEROPROTECTED/);
    assert.doesNotMatch(result.blocks[0].alignment.units[1].translatedMarkdown, /MKTEROPROTECTED/);
    assert.doesNotMatch(JSON.stringify(calls[3]), /MKTEROPROTECTED|\$x\$/);
});

test('revision retains alignment only on a uniquely relocatable, unchanged block', async () => {
    const { service, calls } = fixture();
    const source = 'Accuracy improved. Latency fell.\n\nRepeated.\n\nRepeated.\n\nMarker (1).';
    const baseline = await service.translateDocument({ documentKey, markdown: source });
    const revised = await service.getCachedDocumentTranslation({ documentKey,
        markdown: `Added.\n\n${source.replace('Marker (1).', 'Marker.')}` });
    assert.deepEqual(revised.blocks.map(block => Boolean(block.alignment)), [false, true, false, false, false]);
    assert.notEqual(revised.blocks[1].alignment.units[0].id, baseline.blocks[0].alignment.units[0].id);
    assert.equal(revised.blocks[1].markdown, baseline.blocks[0].markdown);
    assert.deepEqual(revised.failedBlocks.map(block => block.id), [revised.blocks[0].id]);
    assert.equal(calls.length, 1);
});

test('continued equation paragraphs share wire context but do not claim sentence alignment', async () => {
    const { service, calls } = fixture();
    const source = 'The response is given by\n\n$$x$$\n\nwhere latency matters.';
    const result = await service.translateDocument({ documentKey, markdown: source });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [
        { id: 'b1', sourceMarkdown: 'The response is given by' },
        { id: 'b2', sourceMarkdown: 'where latency matters.', continuesFrom: 'b1' },
    ]);
    assert.ok(result.blocks.every(block => !block.alignment));
});

test('batch source budget accounts for per-unit wire overhead without issuing one call per sentence', async () => {
    const { service, calls } = fixture();
    const source = Array.from({ length: 6 }, () => 'Long enough. '.repeat(70).trim()).join('\n\n');
    const result = await service.translateDocument({ documentKey, markdown: source });
    assert.equal(result.partial, false);
    assert.ok(calls.length > 1 && calls.length < 6);
    assert.ok(calls.every(entries => entries.every(entry => entry.units.length === 70)));
});
