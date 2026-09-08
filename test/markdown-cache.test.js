import test from 'node:test';
import assert from 'node:assert/strict';
import {
    access,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import {
    createMarkdownCacheKey,
    createMinerUCacheKey,
    createZoteroMarkdownCache,
    MarkdownCache,
    sha256Hex,
} from '../src/cache/markdown-cache.js';
import { MISTRAL_PARSER_PROFILE_ID } from '../src/mistral/parser-profile.js';

const CACHE_KEY = 'a'.repeat(64);
const SECOND_CACHE_KEY = 'b'.repeat(64);

test('restores cached Markdown and images across cache instances', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cache-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const options = {
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, filename: path.basename },
        now: () => 1_700_000_000_000,
    };
    const result = {
        markdown: '# Cached paper',
        sourceMap: [{
            type: 'text',
            markdownFrom: 2,
            markdownTo: 14,
            locations: [{
                pageIndex: 1,
                bbox: [100, 200, 900, 260],
            }],
        }],
        assets: [{
            path: 'result/images/figure.png',
            mimeType: 'image/png',
            data: new Uint8Array([1, 2, 3]),
        }],
        assetBasePath: 'result',
        extractedPages: 2,
        totalPages: 3,
    };

    await new MarkdownCache(options).put(CACHE_KEY, result);
    const restored = await new MarkdownCache(options).get(CACHE_KEY);

    assert.equal(restored.markdown, '# Cached paper');
    assert.equal(restored.assetBasePath, 'result');
    assert.equal(restored.extractedPages, 2);
    assert.equal(restored.totalPages, 3);
    assert.deepEqual(restored.sourceMap, result.sourceMap);
    assert.deepEqual(restored.assets.map(asset => ({
        path: asset.path,
        mimeType: asset.mimeType,
        data: [...asset.data],
    })), [{
        path: 'result/images/figure.png',
        mimeType: 'image/png',
        data: [1, 2, 3],
    }]);
});

test('stores an intentionally empty user-edited Markdown document', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cache-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const cache = new MarkdownCache({
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, filename: path.basename },
    });

    await cache.put(CACHE_KEY, {
        markdown: '',
        userEdited: true,
    }, { allowEmptyMarkdown: true });

    assert.deepEqual(await cache.get(CACHE_KEY), {
        markdown: '',
        assets: [],
        assetBasePath: '',
        extractedPages: null,
        totalPages: null,
        userEdited: true,
    });
});

test('stores a document translation inside its Markdown cache entry', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cache-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const options = {
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, filename: path.basename },
    };
    const cache = new MarkdownCache(options);
    const translationKey = 'c'.repeat(64);
    const translation = {
        translatedMarkdown: '# 论文',
        comparisonMarkdown: '# Paper\n\n> # 论文',
        blocks: [{ id: 'translation-0', markdown: '# 论文' }],
        model: 'example-model',
        targetLanguage: 'zh-CN',
        promptVersion: 'translation-v1',
        partial: false,
        failedBlocks: [],
    };
    await cache.put(CACHE_KEY, { markdown: '# Paper' });

    await cache.putTranslation(CACHE_KEY, translationKey, translation);

    assert.deepEqual(
        await new MarkdownCache(options).getTranslation(CACHE_KEY, translationKey),
        translation
    );
    assert.equal((await cache.getStats()).entries, 1);
    assert.ok((await cache.getStats()).sizeBytes > 7);
});

test('finds the current cached translation by target language', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cache-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const options = {
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, filename: path.basename },
    };
    const cache = new MarkdownCache(options);
    const translationKey = 'c'.repeat(64);
    const translation = {
        translatedMarkdown: '# 论文',
        comparisonMarkdown: '# Paper\n\n# 论文',
        blocks: [{ id: 'translation-0', markdown: '# 论文' }],
        sourceBlocks: [{ id: 'translation-0', markdown: '# Paper' }],
        settingsIdentity: '{"targetLanguage":"zh-CN"}',
        model: 'example-model',
        targetLanguage: 'zh-CN',
        promptVersion: 'translation-v1',
        partial: false,
        failedBlocks: [],
    };
    await cache.put(CACHE_KEY, { markdown: '# Paper' });
    await cache.putTranslation(CACHE_KEY, translationKey, translation);

    const restored = new MarkdownCache(options);

    assert.deepEqual(
        await restored.getTranslationByLanguage(CACHE_KEY, 'zh-CN'),
        { ...translation, comparisonMarkdown: '' }
    );
    assert.equal(
        await restored.getTranslationByLanguage(CACHE_KEY, 'ja-JP'),
        null
    );
});

test('stores independent translations per target language', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cache-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const options = {
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, filename: path.basename },
    };
    const cache = new MarkdownCache(options);
    const chineseKey = 'c'.repeat(64);
    const japaneseKey = 'd'.repeat(64);
    const chinese = {
        translatedMarkdown: '# 论文',
        comparisonMarkdown: '# Paper\n\n# 论文',
        blocks: [{ id: 'translation-0', markdown: '# 论文' }],
        model: 'example-model',
        targetLanguage: 'zh-CN',
        promptVersion: 'translation-v1',
        partial: false,
        failedBlocks: [],
    };
    const japanese = {
        ...chinese,
        translatedMarkdown: '# 論文',
        comparisonMarkdown: '# Paper\n\n# 論文',
        blocks: [{ id: 'translation-0', markdown: '# 論文' }],
        targetLanguage: 'ja-JP',
    };
    await cache.put(CACHE_KEY, { markdown: '# Paper' });

    await cache.putTranslation(CACHE_KEY, chineseKey, chinese);
    await cache.putTranslation(CACHE_KEY, japaneseKey, japanese);

    const restored = new MarkdownCache(options);
    assert.deepEqual(
        await restored.getTranslation(CACHE_KEY, chineseKey),
        chinese
    );
    assert.deepEqual(
        await restored.getTranslation(CACHE_KEY, japaneseKey),
        japanese
    );
});

test('retains prior source translations for the same language', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cache-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const options = {
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, filename: path.basename },
    };
    const cache = new MarkdownCache(options);
    const oldChineseKey = 'c'.repeat(64);
    const newChineseKey = 'd'.repeat(64);
    const japaneseKey = 'e'.repeat(64);
    const base = {
        translatedMarkdown: '# Translation',
        comparisonMarkdown: '# Paper\n\n# Translation',
        blocks: [{ id: 'translation-0', markdown: '# Translation' }],
        model: 'example-model',
        promptVersion: 'translation-v1',
        partial: false,
        failedBlocks: [],
    };
    await cache.put(CACHE_KEY, { markdown: '# Paper' });
    await cache.putTranslation(CACHE_KEY, oldChineseKey, {
        ...base,
        targetLanguage: 'zh-CN',
    });
    await cache.putTranslation(CACHE_KEY, japaneseKey, {
        ...base,
        targetLanguage: 'ja-JP',
    });

    await cache.putTranslation(CACHE_KEY, newChineseKey, {
        ...base,
        model: 'new-model',
        targetLanguage: 'zh-CN',
    });

    assert.equal(
        (await cache.getTranslation(CACHE_KEY, oldChineseKey)).model,
        'example-model'
    );
    assert.equal(
        (await cache.getTranslation(CACHE_KEY, newChineseKey)).model,
        'new-model'
    );
    assert.equal(
        (await cache.getTranslationByLanguage(CACHE_KEY, 'zh-CN')).model,
        'new-model'
    );
    assert.equal(
        (await cache.getTranslation(CACHE_KEY, japaneseKey)).targetLanguage,
        'ja-JP'
    );
});

test('bounds cached translation variants and removes evicted translation files', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cache-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const cache = new MarkdownCache({
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, filename: path.basename },
    });
    await cache.put(CACHE_KEY, { markdown: '# Paper' });
    for (let index = 0; index < 33; index++) {
        await cache.putTranslation(
            CACHE_KEY,
            (index + 1).toString(16).padStart(64, '0'),
            {
                translatedMarkdown: '# Translation',
                comparisonMarkdown: '# Paper\n\n# Translation',
                blocks: [{
                    id: 'translation-0',
                    markdown: '# Translation',
                }],
                model: 'example-model',
                targetLanguage: `language-${index}`,
                promptVersion: 'translation-v1',
                partial: false,
                failedBlocks: [],
            }
        );
    }
    const entryPath = path.join(rootPath, 'entries', CACHE_KEY);
    const metadata = JSON.parse(await readFile(
        path.join(entryPath, 'entry.json'),
        'utf8'
    ));
    const translationFiles = (await readdir(entryPath)).filter(file => (
        /^translation-.*\.json$/.test(file)
    ));

    assert.equal(metadata.translations.length, 32);
    assert.equal(translationFiles.length, 32, JSON.stringify({
        referenced: metadata.translations.map(value => value.translationFile),
        translationFiles,
    }));
    assert.equal(
        await cache.getTranslation(CACHE_KEY, '1'.padStart(64, '0')),
        null
    );
    assert.equal(
        (await cache.getTranslation(CACHE_KEY, '21'.padStart(64, '0')))
            .targetLanguage,
        'language-32'
    );
});

test('repairs excess translation metadata and removes its files', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cache-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const cache = new MarkdownCache({
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, filename: path.basename },
    });
    await cache.put(CACHE_KEY, { markdown: '# Paper' });
    for (let index = 0; index < 32; index++) {
        await cache.putTranslation(
            CACHE_KEY,
            (index + 1).toString(16).padStart(64, '0'),
            {
                translatedMarkdown: '# Translation',
                comparisonMarkdown: '# Paper\n\n# Translation',
                blocks: [{
                    id: 'translation-0',
                    markdown: '# Translation',
                }],
                model: 'example-model',
                targetLanguage: `language-${index}`,
                promptVersion: 'translation-v1',
                partial: false,
                failedBlocks: [],
            }
        );
    }
    const entryPath = path.join(rootPath, 'entries', CACHE_KEY);
    const metadataPath = path.join(entryPath, 'entry.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    const excessFile = 'translation-excess.json';
    await writeFile(path.join(entryPath, excessFile), '{}');
    metadata.translations.push({
        translationFile: excessFile,
        translationKey: 'f'.repeat(64),
        translationBytes: 2,
        targetLanguage: 'excess-language',
    });
    metadata.sizeBytes += 2;
    await writeFile(metadataPath, JSON.stringify(metadata));

    assert.equal((await cache.get(CACHE_KEY)).markdown, '# Paper');
    const repaired = JSON.parse(await readFile(metadataPath, 'utf8'));
    assert.equal(repaired.translations.length, 32);
    await assert.rejects(access(path.join(entryPath, excessFile)));
});

test('stores partial translation failures inside the Markdown cache entry', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cache-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const options = {
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, filename: path.basename },
    };
    const cache = new MarkdownCache(options);
    const translationKey = 'd'.repeat(64);
    const translation = {
        translatedMarkdown: '# Paper',
        comparisonMarkdown: '# Paper\n\n> # Paper',
        blocks: [{ id: 'translation-0', markdown: '# Paper' }],
        model: 'example-model',
        targetLanguage: 'zh-CN',
        promptVersion: 'translation-v2',
        partial: true,
        failedBlocks: [{
            id: 'translation-0',
            message: 'The response was invalid',
        }],
    };
    await cache.put(CACHE_KEY, { markdown: '# Paper' });

    await cache.putTranslation(CACHE_KEY, translationKey, translation);

    assert.deepEqual(
        await new MarkdownCache(options).getTranslation(CACHE_KEY, translationKey),
        translation
    );
});

test('rejects a non-boolean partial translation cache marker', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cache-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const cache = new MarkdownCache({
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, filename: path.basename },
    });
    await cache.put(CACHE_KEY, { markdown: '# Paper' });

    assert.throws(() => cache.putTranslation(
        CACHE_KEY,
        'd'.repeat(64),
        {
            translatedMarkdown: '# Paper',
            comparisonMarkdown: '# Paper\n\n> # Paper',
            blocks: [{ id: 'translation-0', markdown: '# Paper' }],
            model: 'example-model',
            targetLanguage: 'zh-CN',
            promptVersion: 'translation-v2',
            partial: 'false',
            failedBlocks: [{
                id: 'translation-0',
                message: 'The response was invalid',
            }],
        }
    ), /invalid cached document translation/i);
});

test('replacing or clearing Markdown removes its stored translation', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cache-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const cache = new MarkdownCache({
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, filename: path.basename },
    });
    const translationKey = 'c'.repeat(64);
    const translation = {
        translatedMarkdown: '# 论文',
        comparisonMarkdown: '# Paper\n\n> # 论文',
        blocks: [{ id: 'translation-0', markdown: '# 论文' }],
        model: 'example-model',
        targetLanguage: 'zh-CN',
        promptVersion: 'translation-v1',
        partial: false,
        failedBlocks: [],
    };
    await cache.put(CACHE_KEY, { markdown: '# Paper' });
    await cache.putTranslation(CACHE_KEY, translationKey, translation);

    await cache.put(CACHE_KEY, { markdown: '# Reparsed paper' });
    assert.equal(await cache.getTranslation(CACHE_KEY, translationKey), null);

    await cache.putTranslation(CACHE_KEY, translationKey, translation);
    await cache.clear();
    assert.equal(await cache.getTranslation(CACHE_KEY, translationKey), null);
});

test('removes only the corrupted language from a multilingual cache', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cache-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const cache = new MarkdownCache({
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, filename: path.basename },
    });
    const translationKey = 'c'.repeat(64);
    const secondTranslationKey = 'd'.repeat(64);
    await cache.put(CACHE_KEY, { markdown: '# Paper' });
    await cache.putTranslation(CACHE_KEY, translationKey, {
        translatedMarkdown: '# 论文',
        comparisonMarkdown: '# Paper\n\n> # 论文',
        blocks: [{ id: 'translation-0', markdown: '# 论文' }],
        model: 'example-model',
        targetLanguage: 'zh-CN',
        promptVersion: 'translation-v1',
        partial: false,
        failedBlocks: [],
    });
    await cache.putTranslation(CACHE_KEY, secondTranslationKey, {
        translatedMarkdown: '# 論文',
        comparisonMarkdown: '# Paper\n\n> # 論文',
        blocks: [{ id: 'translation-0', markdown: '# 論文' }],
        model: 'example-model',
        targetLanguage: 'ja-JP',
        promptVersion: 'translation-v1',
        partial: false,
        failedBlocks: [],
    });
    const entryPath = path.join(rootPath, 'entries', CACHE_KEY);
    const metadataPath = path.join(entryPath, 'entry.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    await writeFile(
        path.join(
            entryPath,
            metadata.translations.find(candidate => (
                candidate.translationKey === translationKey
            )).translationFile
        ),
        '{not-json'
    );

    assert.equal(
        await cache.getTranslation(CACHE_KEY, translationKey),
        null
    );
    assert.equal(
        (await cache.getTranslation(CACHE_KEY, secondTranslationKey))
            .targetLanguage,
        'ja-JP'
    );
    assert.equal((await cache.get(CACHE_KEY)).markdown, '# Paper');
    const repairedMetadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    assert.deepEqual(
        repairedMetadata.translations.map(candidate => candidate.translationKey),
        [secondTranslationKey]
    );
    assert.equal((await cache.getStats()).entries, 1);
    assert.ok((await cache.getStats()).sizeBytes > '# Paper'.length);
});

test('migrates and reads legacy single-translation metadata', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cache-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const options = {
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, filename: path.basename },
    };
    const cache = new MarkdownCache(options);
    const translationKey = 'c'.repeat(64);
    const translation = {
        translatedMarkdown: '# 论文',
        comparisonMarkdown: '# Paper\n\n# 论文',
        blocks: [{ id: 'translation-0', markdown: '# 论文' }],
        model: 'legacy-model',
        targetLanguage: 'zh-CN',
        promptVersion: 'translation-v1',
        partial: false,
        failedBlocks: [],
    };
    await cache.put(CACHE_KEY, { markdown: '# Paper' });
    await cache.putTranslation(CACHE_KEY, translationKey, translation);
    const metadataPath = path.join(rootPath, 'entries', CACHE_KEY, 'entry.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    const [descriptor] = metadata.translations;
    delete metadata.translations;
    Object.assign(metadata, {
        translationFile: descriptor.translationFile,
        translationKey: descriptor.translationKey,
        translationBytes: descriptor.translationBytes,
    });
    await writeFile(metadataPath, JSON.stringify(metadata));

    assert.deepEqual(
        await new MarkdownCache(options).getTranslation(CACHE_KEY, translationKey),
        translation
    );
    const migrated = JSON.parse(await readFile(metadataPath, 'utf8'));
    assert.equal(migrated.translations[0].targetLanguage, 'zh-CN');
    assert.equal('translationFile' in migrated, false);
});

test('restores cached chromeRanges next to the source map', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cache-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const options = {
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, filename: path.basename },
        now: () => 1_700_000_000_000,
    };
    const result = {
        markdown: 'Hello\n\n12\n\nWorld',
        sourceMap: [{
            type: 'text',
            markdownFrom: 0,
            markdownTo: 5,
            locations: [{ pageIndex: 0, bbox: [100, 200, 900, 260] }],
        }],
        chromeRanges: [{ from: 5, to: 11 }],
    };
    await new MarkdownCache(options).put(CACHE_KEY, result);
    const restored = await new MarkdownCache(options).get(CACHE_KEY);
    assert.deepEqual(restored.chromeRanges, [{ from: 5, to: 11 }]);
    assert.equal(restored.markdown, result.markdown);
});

test('opens a cache entry when the chromeRanges sidecar is missing', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cache-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const options = {
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, filename: path.basename },
    };
    await new MarkdownCache(options).put(CACHE_KEY, { markdown: '# Paper' });
    const restored = await new MarkdownCache(options).get(CACHE_KEY);
    assert.equal(restored.markdown, '# Paper');
    assert.equal('chromeRanges' in restored, false);
});

test('keeps cached Markdown when chromeRanges bytes do not match', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cache-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const options = {
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, filename: path.basename },
    };
    await new MarkdownCache(options).put(CACHE_KEY, {
        markdown: 'Hello\n\n12\n\nWorld',
        chromeRanges: [{ from: 5, to: 11 }],
    });
    const entryPath = path.join(rootPath, 'entries', CACHE_KEY);
    const chromeFile = (await readdir(entryPath)).find(file => (
        file.startsWith('chrome-ranges-')
    ));
    await writeFile(path.join(entryPath, chromeFile), ' '.repeat(1024));
    const restored = await new MarkdownCache(options).get(CACHE_KEY);
    assert.equal(restored.markdown, 'Hello\n\n12\n\nWorld');
    assert.equal('chromeRanges' in restored, false);
});

test('reads a cache entry created before source maps were available', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cache-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const cache = new MarkdownCache({
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, filename: path.basename },
    });

    await cache.put(CACHE_KEY, { markdown: '# Legacy cache' });
    const restored = await cache.get(CACHE_KEY);

    assert.equal(restored.markdown, '# Legacy cache');
    assert.equal('sourceMap' in restored, false);
});

test('rejects an invalid source rectangle before caching it', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cache-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const cache = new MarkdownCache({
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, filename: path.basename },
    });

    await assert.rejects(() => cache.put(CACHE_KEY, {
        markdown: 'Mapped source text.',
        sourceMap: [{
            type: 'text',
            markdownFrom: 0,
            markdownTo: 19,
            locations: [{ pageIndex: 0, bbox: [100, 100, 1001, 200] }],
        }],
    }), /source location/i);
});

test('rejects source maps that exceed byte or aggregate location budgets', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cache-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const options = {
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, filename: path.basename },
    };
    const result = {
        markdown: 'Mapped source text.',
        sourceMap: [{
            type: 'text',
            markdownFrom: 0,
            markdownTo: 19,
            locations: [
                { pageIndex: 0, bbox: [100, 100, 900, 200] },
                { pageIndex: 1, bbox: [100, 100, 900, 200] },
            ],
        }],
    };

    await assert.rejects(
        () => new MarkdownCache({
            ...options,
            maxSourceMapBytes: 2,
        }).put(CACHE_KEY, result),
        /source map size limit/i
    );
    await assert.rejects(
        () => new MarkdownCache({
            ...options,
            maxSourceLocations: 1,
        }).put(CACHE_KEY, result),
        /source map location limit/i
    );
});

test('checks a cached source-map file size before reading it', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cache-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const ioUtils = createNodeIOUtils();
    const cache = new MarkdownCache({
        rootPath,
        ioUtils,
        pathUtils: { join: path.join, filename: path.basename },
    });
    await cache.put(CACHE_KEY, {
        markdown: 'Mapped source text.',
        sourceMap: [{
            type: 'text',
            markdownFrom: 0,
            markdownTo: 19,
            locations: [{ pageIndex: 0, bbox: [100, 100, 900, 200] }],
        }],
    });
    const entryPath = path.join(rootPath, 'entries', CACHE_KEY);
    const sourceMapFile = (await readdir(entryPath)).find(file => (
        file.startsWith('source-map-')
    ));
    await writeFile(path.join(entryPath, sourceMapFile), ' '.repeat(1024));
    const originalReadUTF8 = ioUtils.readUTF8;
    let sourceMapReads = 0;
    ioUtils.readUTF8 = filePath => {
        if (path.basename(filePath).startsWith('source-map-')) sourceMapReads++;
        return originalReadUTF8(filePath);
    };

    assert.equal(await cache.get(CACHE_KEY), null);
    assert.equal(sourceMapReads, 0);
});

test('prunes the oldest entry when the cache exceeds its entry limit', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cache-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    let timestamp = 1_700_000_000_000;
    const cache = new MarkdownCache({
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, filename: path.basename },
        now: () => timestamp,
        maxEntries: 1,
    });

    await cache.put(CACHE_KEY, { markdown: '# First' });
    timestamp++;
    await cache.put(SECOND_CACHE_KEY, { markdown: '# Second' });

    assert.equal(await cache.get(CACHE_KEY), null);
    assert.equal((await cache.get(SECOND_CACHE_KEY)).markdown, '# Second');
});

test('reports cache usage and clears every cached result', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cache-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const cache = new MarkdownCache({
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, filename: path.basename },
    });
    await cache.put(CACHE_KEY, {
        markdown: '# Paper',
        assets: [{
            path: 'result/images/figure.png',
            mimeType: 'image/png',
            data: new Uint8Array([1, 2, 3]),
        }],
    });

    assert.deepEqual(await cache.getStats(), { entries: 1, sizeBytes: 10 });

    await cache.clear();

    assert.deepEqual(await cache.getStats(), { entries: 0, sizeBytes: 0 });
    assert.equal(await cache.get(CACHE_KEY), null);
});

test('keys cache entries by PDF content and MinerU processing profile', async () => {
    const abc = new TextEncoder().encode('abc');
    assert.equal(
        await sha256Hex(abc, { crypto: webcrypto }),
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );

    const first = await createMinerUCacheKey(abc, { crypto: webcrypto });
    const same = await createMinerUCacheKey(abc, { crypto: webcrypto });
    const changedContent = await createMinerUCacheKey(
        new TextEncoder().encode('changed'),
        { crypto: webcrypto }
    );
    const changedProfile = await createMinerUCacheKey(abc, {
        crypto: webcrypto,
        parserProfile: 'mineru-vlm-ocr-formula-table-v2',
    });

    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(first, same);
    assert.notEqual(first, changedContent);
    assert.notEqual(first, changedProfile);
});

test('isolates cache keys for MinerU and Mistral parser profiles', async () => {
    const pdf = new TextEncoder().encode('same PDF bytes');
    const mineruKey = await createMinerUCacheKey(pdf, { crypto: webcrypto });
    const mistralKey = await createMarkdownCacheKey(pdf, {
        crypto: webcrypto,
        parserProfile: MISTRAL_PARSER_PROFILE_ID,
    });

    assert.notEqual(mineruKey, mistralKey);
});

test('treats a corrupted cache entry as a miss and removes it', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cache-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const cache = new MarkdownCache({
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, filename: path.basename },
    });
    await cache.put(CACHE_KEY, { markdown: '# Paper' });
    await writeFile(
        path.join(rootPath, 'entries', CACHE_KEY, 'entry.json'),
        '{not-json'
    );

    assert.equal(await cache.get(CACHE_KEY), null);
    assert.deepEqual(await cache.getStats(), { entries: 0, sizeBytes: 0 });
});

test('keeps the previous result when replacing a cache entry fails', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cache-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const ioUtils = createNodeIOUtils();
    const cache = new MarkdownCache({
        rootPath,
        ioUtils,
        pathUtils: { join: path.join, filename: path.basename },
    });
    await cache.put(CACHE_KEY, { markdown: '# Previous result' });
    const originalWriteUTF8 = ioUtils.writeUTF8;
    ioUtils.writeUTF8 = async (filePath, data, options) => {
        if (data === '# Replacement result') throw new Error('disk full');
        return originalWriteUTF8(filePath, data, options);
    };

    await assert.rejects(
        () => cache.put(CACHE_KEY, { markdown: '# Replacement result' }),
        /disk full/
    );

    assert.equal((await cache.get(CACHE_KEY)).markdown, '# Previous result');
});

test('creates a Zotero cache under the current profile directory', () => {
    const ioUtils = createNodeIOUtils();
    const pathUtils = { join: path.join, filename: path.basename };
    const cache = createZoteroMarkdownCache({
        zotero: { Profile: { dir: '/profiles/test-profile' } },
        ioUtils,
        pathUtils,
    });

    assert.ok(cache instanceof MarkdownCache);
    assert.equal(
        cache.rootPath,
        path.join('/profiles/test-profile', 'mktero-cache', 'v1')
    );
});

test('serializes reads with replacement writes for the same PDF', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cache-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const ioUtils = createNodeIOUtils();
    const cache = new MarkdownCache({
        rootPath,
        ioUtils,
        pathUtils: { join: path.join, filename: path.basename },
    });
    await cache.put(CACHE_KEY, { markdown: '# Previous result' });

    const originalReadUTF8 = ioUtils.readUTF8;
    const originalWriteUTF8 = ioUtils.writeUTF8;
    let releaseRead;
    let markReadStarted;
    const readStarted = new Promise(resolve => { markReadStarted = resolve; });
    const resumeRead = new Promise(resolve => { releaseRead = resolve; });
    let pauseMarkdownRead = true;
    let replacementStarted = false;
    ioUtils.readUTF8 = async filePath => {
        if (pauseMarkdownRead && path.basename(filePath).startsWith('document-')) {
            pauseMarkdownRead = false;
            markReadStarted();
            await resumeRead;
        }
        return originalReadUTF8(filePath);
    };
    ioUtils.writeUTF8 = async (filePath, data, options) => {
        if (data === '# Replacement result') replacementStarted = true;
        return originalWriteUTF8(filePath, data, options);
    };

    const reading = cache.get(CACHE_KEY);
    await readStarted;
    const replacing = cache.put(CACHE_KEY, { markdown: '# Replacement result' });
    for (let index = 0; index < 20 && !replacementStarted; index++) {
        await new Promise(resolve => setImmediate(resolve));
    }
    const replacementStartedBeforeReadFinished = replacementStarted;
    releaseRead();

    assert.equal((await reading).markdown, '# Previous result');
    await replacing;
    assert.equal(replacementStartedBeforeReadFinished, false);
    assert.equal((await cache.get(CACHE_KEY)).markdown, '# Replacement result');
});

test('treats an entry past its inactivity limit as a cache miss', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cache-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    let timestamp = 1_700_000_000_000;
    const cache = new MarkdownCache({
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, filename: path.basename },
        now: () => timestamp,
        maxAgeMs: 1000,
    });
    await cache.put(CACHE_KEY, { markdown: '# Expired result' });

    timestamp += 1001;

    assert.equal(await cache.get(CACHE_KEY), null);
    assert.deepEqual(await cache.getStats(), { entries: 0, sizeBytes: 0 });
});

test('does not prune an entry while another cache operation is writing it', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cache-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const ioUtils = createNodeIOUtils();
    const cache = new MarkdownCache({
        rootPath,
        ioUtils,
        pathUtils: { join: path.join, filename: path.basename },
    });
    const originalWriteUTF8 = ioUtils.writeUTF8;
    let releaseWrite;
    let markWriteStarted;
    const writeStarted = new Promise(resolve => { markWriteStarted = resolve; });
    const resumeWrite = new Promise(resolve => { releaseWrite = resolve; });
    ioUtils.writeUTF8 = async (filePath, data, options) => {
        if (data === '# In progress') {
            markWriteStarted();
            await resumeWrite;
        }
        return originalWriteUTF8(filePath, data, options);
    };

    const writing = cache.put(CACHE_KEY, { markdown: '# In progress' });
    await writeStarted;
    let pruneFinished = false;
    const pruning = cache.prune().then(() => { pruneFinished = true; });
    for (let index = 0; index < 20 && !pruneFinished; index++) {
        await new Promise(resolve => setImmediate(resolve));
    }
    const pruneFinishedBeforeWrite = pruneFinished;
    releaseWrite();

    await writing;
    await pruning;
    assert.equal(pruneFinishedBeforeWrite, false);
    assert.equal((await cache.get(CACHE_KEY)).markdown, '# In progress');
});

test('cache statistics do not remove another instance in progress entry', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-cache-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const ioUtils = createNodeIOUtils();
    const options = {
        rootPath,
        ioUtils,
        pathUtils: { join: path.join, filename: path.basename },
    };
    const writer = new MarkdownCache(options);
    const statistics = new MarkdownCache(options);
    const originalWriteUTF8 = ioUtils.writeUTF8;
    let releaseWrite;
    let markWriteStarted;
    const writeStarted = new Promise(resolve => { markWriteStarted = resolve; });
    const resumeWrite = new Promise(resolve => { releaseWrite = resolve; });
    ioUtils.writeUTF8 = async (filePath, data, writeOptions) => {
        if (data === '# In progress') {
            markWriteStarted();
            await resumeWrite;
        }
        return originalWriteUTF8(filePath, data, writeOptions);
    };

    const writing = writer.put(CACHE_KEY, { markdown: '# In progress' });
    await writeStarted;
    assert.deepEqual(await statistics.getStats(), { entries: 0, sizeBytes: 0 });
    releaseWrite();

    await writing;
    assert.equal((await writer.get(CACHE_KEY)).markdown, '# In progress');
});

function createNodeIOUtils() {
    return {
        async exists(filePath) {
            try {
                await access(filePath);
                return true;
            }
            catch {
                return false;
            }
        },
        makeDirectory: (filePath, options = {}) => mkdir(filePath, {
            recursive: options.ignoreExisting !== false,
        }),
        read: async filePath => new Uint8Array(await readFile(filePath)),
        readUTF8: filePath => readFile(filePath, 'utf8'),
        getChildren: async filePath => (await readdir(filePath))
            .map(name => path.join(filePath, name)),
        stat: async filePath => {
            const value = await stat(filePath);
            return {
                type: value.isDirectory() ? 'directory' : 'regular',
                size: value.size,
            };
        },
        remove: (filePath, options = {}) => rm(filePath, {
            recursive: Boolean(options.recursive),
            force: Boolean(options.ignoreAbsent),
        }),
        async write(filePath, data, options = {}) {
            await atomicWrite(filePath, data, options.tmpPath);
        },
        async writeUTF8(filePath, data, options = {}) {
            await atomicWrite(filePath, data, options.tmpPath);
        },
    };
}

async function atomicWrite(filePath, data, temporaryPath) {
    if (!temporaryPath) {
        await writeFile(filePath, data);
        return;
    }
    await writeFile(temporaryPath, data);
    await rename(temporaryPath, filePath);
}
