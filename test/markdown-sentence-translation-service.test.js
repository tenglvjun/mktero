import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MarkdownTranslationService } from '../src/ai/markdown-translation-service.js';
import { collectMarkdownTranslationBlocks } from '../src/markdown/markdown-translation-blocks.js';

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

function fixture({ generate = response, put, getSettings = () => settings } = {}) {
    const records = new Map();
    const calls = [];
    const writes = [];
    const service = new MarkdownTranslationService({
        getSettings,
        createCacheKey: hash,
        aiGateway: { async generateText(request) {
            const entries = JSON.parse(request.messages[1].content);
            calls.push(entries);
            assert.doesNotMatch(JSON.stringify(request.messages), /translation-\d+-|"(?:sourceRanges|from|to|offset|sectionHeading)"\s*:/);
            return { text: JSON.stringify(await generate(entries, calls.length)) };
        } },
        cache: {
            getTranslation: async (_, key) => records.has(key) ? structuredClone(records.get(key)) : null,
            getTranslationByLanguage: async (_, language, identity) => [...records.values()].reverse().find(value =>
                value.targetLanguage === language && value.settingsIdentity === identity.settingsIdentity),
            async putTranslation(_, key, value, { signal } = {}) {
                if (put) await put(signal);
                signal?.throwIfAborted();
                writes.push(key);
                records.set(key, structuredClone(value));
            },
        },
    });
    return { service, records, calls, writes };
}

function installLegacy(records, source = markdown) {
    const identity = {
        provider: 'custom', protocol: 'openai-chat-completions', apiBase: 'https://example.invalid/v1',
        model: 'example', reasoning: 'none', targetLanguage: 'zh-CN', promptVersion: v7,
    };
    const key = hash(JSON.stringify({ documentKey, source, ...identity }));
    const blocks = collectMarkdownTranslationBlocks(source).filter(block => block.translatable);
    records.set(key, {
        blocks: blocks.map(({ id }, i) => ({ id, markdown: ['# 旧标题', '旧段落。', '保留的译文。'][i] })),
        sourceBlocks: blocks.map(({ id, markdown }) => ({ id, markdown })),
        translatedMarkdown: '# 旧标题\n\n旧段落。\n\n保留的译文。', comparisonMarkdown: '',
        settingsIdentity: JSON.stringify(identity), targetLanguage: 'zh-CN', model: 'example',
        promptVersion: v7, partial: false, failedBlocks: [],
    });
    return key;
}

test('v7 exact, language variants, reconciliation and export Markdown remain offline and v7', async () => {
    const { service, records, calls, writes } = fixture();
    const key = installLegacy(records);
    const cached = await service.getCachedDocumentTranslation(options);
    const [variant] = await service.listCachedDocumentTranslationVariants(options);
    const translated = await service.translateDocument(options);
    const revised = await service.reconcileDocumentTranslation({ ...options, markdown: markdown.replace('Keep this paragraph.', 'Edited.') });
    for (const result of [cached, variant, translated, revised]) {
        assert.equal(result.promptVersion, v7);
        assert.equal(JSON.parse(result.settingsIdentity).promptVersion, v7);
        assert.ok(result.blocks.every(block => !block.alignment));
        assert.match(result.translatedMarkdown, /旧标题\n\n旧段落。/);
        assert.doesNotMatch(result.translatedMarkdown + result.comparisonMarkdown, /translation-|alignment|\.s1/);
    }
    assert.equal(translated.translationKey, key);
    assert.equal(revised.partial, true);
    assert.deepEqual([calls, writes], [[], []]);
});

test('upgrade replaces only the explicitly requested paragraph, keeps v7 immutable, and reopens v8 units', async () => {
    const { service, records, calls, writes } = fixture();
    const oldKey = installLegacy(records);
    const old = structuredClone(records.get(oldKey));
    const baseline = await service.getCachedDocumentTranslation(options);
    delete baseline.promptVersion; // The tab carries the version in settingsIdentity.
    const upgraded = await service.translateDocument({ ...options, alignmentBlockID: old.blocks[1].id, existingTranslation: baseline });
    assert.deepEqual(calls, [[{ id: 'b1', units: [
        { id: 'b1.s1', sourceMarkdown: 'Accuracy improved.' }, { id: 'b1.s2', sourceMarkdown: 'Latency fell.' },
    ] }]]);
    assert.deepEqual(writes, [upgraded.translationKey]);
    assert.notEqual(writes[0], oldKey);
    assert.deepEqual(records.get(oldKey), old);
    assert.equal(upgraded.promptVersion, v8);
    assert.equal(upgraded.translatedMarkdown, '# 旧标题\n\n准确率提高了。延迟下降了。\n\n保留的译文。');
    assert.deepEqual(upgraded.blocks[0], old.blocks[0]);
    assert.deepEqual(upgraded.blocks[2], old.blocks[2]);
    const reopened = await service.getCachedDocumentTranslation(options);
    assert.deepEqual(reopened.blocks, upgraded.blocks);
    assert.equal(reopened.blocks[1].alignment.units[1].translatedMarkdown, '延迟下降了。');
    assert.equal(calls.length, 1);
});

test('resuming a partial v7 result writes a mixed v8 record, not a rewrite of the previous key', async () => {
    const { service, records, calls, writes } = fixture();
    const key = installLegacy(records);
    const legacy = records.get(key);
    legacy.partial = true;
    legacy.failedBlocks = [{ id: legacy.blocks[1].id, message: 'Interrupted' }];
    const old = structuredClone(legacy);
    const [variant] = await service.listCachedDocumentTranslationVariants(options);
    assert.equal(variant.partial, true);
    assert.equal(calls.length, 0);
    const result = await service.translateDocument(options);
    assert.deepEqual(records.get(key), old);
    assert.deepEqual(writes, [result.translationKey]);
    assert.deepEqual(calls.map(entries => entries.length), [1]);
    assert.equal(result.partial, false);
    assert.equal(result.promptVersion, v8);
    assert.deepEqual(result.blocks.map(block => Boolean(block.alignment)), [false, true, false]);
    assert.deepEqual(result.blocks[2], old.blocks[2]);
});

test('a changed provider model cannot use v7 exact or compatible cache or an old visible upgrade baseline', async () => {
    let model = settings.model;
    const { service, records, calls, writes } = fixture({ getSettings: () => ({ ...settings, model }) });
    installLegacy(records);
    const old = await service.getCachedDocumentTranslation(options);
    model = 'different-model';
    assert.equal(await service.getCachedDocumentTranslation(options), null);
    assert.deepEqual(await service.listCachedDocumentTranslationVariants({ ...options, markdown: markdown.replace(' fell', ' rose') }), []);
    assert.equal(await service.reconcileDocumentTranslation({ ...options, existingTranslation: old }), null);
    await assert.rejects(service.translateDocument({ ...options, existingTranslation: old, alignmentBlockID: old.blocks[1].id }),
        { code: 'AI_INVALID_REQUEST' });
    assert.deepEqual([calls, writes], [[], []]);
});

test('explicit upgrade stops before sending if source, settings, target, ID, or visible baseline no longer match', async () => {
    const { service, records, calls, writes } = fixture();
    installLegacy(records);
    const baseline = await service.getCachedDocumentTranslation(options);
    const valid = { ...options, existingTranslation: baseline, alignmentBlockID: baseline.blocks[1].id };
    for (const change of [
        { alignmentBlockID: 'missing' }, { alignmentBlockID: '' }, { alignmentBlockID: null }, { forceRetranslate: true },
        { retryBlockIDs: [] }, { targetLanguage: 'fr-FR' }, { markdown: markdown.replace('fell', 'rose') },
        { existingTranslation: { ...baseline, settingsIdentity: baseline.settingsIdentity.replace('example.invalid', 'other.invalid') } },
        { existingTranslation: { ...baseline, translationKey: 'b'.repeat(64) } },
        { existingTranslation: { ...baseline, sourceMarkdown: 'stale source' } },
        { existingTranslation: { ...baseline, translatedMarkdown: 'stale translation' } },
    ]) {
        await assert.rejects(service.translateDocument({ ...valid, ...change }), { code: 'AI_INVALID_REQUEST' });
    }
    records.clear();
    await assert.rejects(service.translateDocument({ ...valid, existingTranslation: null }), { code: 'AI_INVALID_REQUEST' });
    assert.deepEqual([calls, writes], [[], []]);
});

for (const failure of ['provider', 'save', 'queued abort']) {
    test(`explicit upgrade leaves the old translation intact after ${failure} failure`, async () => {
        const controller = new AbortController();
        const { service, records, calls, writes } = fixture({
            generate: entries => failure === 'provider' ? [] : response(entries),
            put(signal) {
                assert.equal(signal, controller.signal);
                if (failure === 'save') throw new Error('disk unavailable');
                if (failure === 'queued abort') controller.abort();
            },
        });
        const key = installLegacy(records);
        const old = structuredClone(records.get(key));
        const baseline = await service.getCachedDocumentTranslation(options);
        await assert.rejects(service.translateDocument({ ...options, existingTranslation: baseline,
            alignmentBlockID: baseline.blocks[1].id, signal: controller.signal }));
        assert.equal(calls.length, failure === 'provider' ? 3 : 1);
        assert.ok(calls.every(entries => entries.length === 1 && entries[0].units.length === 2));
        assert.deepEqual(writes, []);
        assert.deepEqual([...records], [[key, old]]);
        assert.deepEqual((await service.getCachedDocumentTranslation(options)).blocks, baseline.blocks);
    });
}

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
