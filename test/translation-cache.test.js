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
import { webcrypto } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
    createTranslationCacheKey,
    TranslationCache,
} from '../src/cache/translation-cache.js';
import { sha256Hex } from '../src/core/sha256.js';
import {
    TRANSLATION_SEGMENTATION_VERSION,
    translationProfileDescriptor,
} from '../src/translation/translation-profile.js';

const FIRST_KEY = 'a'.repeat(64);
const SECOND_KEY = 'b'.repeat(64);

function result(overrides = {}) {
    return {
        status: 'partial',
        targetLanguage: 'zh-CN',
        serviceName: 'Academic service',
        segments: [{
            id: 'segment-000001',
            sourceHash: '1234abcd',
            from: 0,
            to: 20,
            kind: 'paragraph',
            status: 'complete',
            text: '第一段译文。',
        }, {
            id: 'segment-000002',
            sourceHash: '5678abcd',
            from: 22,
            to: 42,
            kind: 'paragraph',
            status: 'failed',
            errorCode: 'TRANSLATION_HTTP_ERROR',
        }],
        ...overrides,
    };
}

function options(rootPath, overrides = {}) {
    return {
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: {
            join: path.join,
            filename: path.basename,
            parent: path.dirname,
        },
        ...overrides,
    };
}

test('restores partial translations across cache instances', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-translation-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    await new TranslationCache(options(rootPath)).put(FIRST_KEY, result());

    const restored = await new TranslationCache(options(rootPath)).get(FIRST_KEY);

    assert.deepEqual(restored, result());
    const files = await readdir(path.join(rootPath, 'entries', FIRST_KEY));
    assert.ok(files.includes('entry.json'));
    assert.equal(
        files.filter(file => file.startsWith('translation-')).length,
        1
    );
});

test('treats corrupt metadata as a cache miss and self-heals', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-translation-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const cache = new TranslationCache(options(rootPath));
    await cache.put(FIRST_KEY, result());
    await writeFile(
        path.join(rootPath, 'entries', FIRST_KEY, 'entry.json'),
        '{not-json'
    );

    assert.equal(await cache.get(FIRST_KEY), null);
    assert.equal(
        await access(path.join(rootPath, 'entries', FIRST_KEY))
            .then(() => true, () => false),
        false
    );
});

test('prunes least recently used entries and reports aggregate usage', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-translation-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    let timestamp = 1_700_000_000_000;
    const cache = new TranslationCache(options(rootPath, {
        now: () => timestamp,
        maxEntries: 1,
    }));
    await cache.put(FIRST_KEY, result());
    timestamp++;
    await cache.put(SECOND_KEY, result({
        status: 'complete',
        segments: [{
            id: 'segment-000001',
            sourceHash: '1234abcd',
            from: 0,
            to: 20,
            kind: 'paragraph',
            status: 'complete',
            text: 'Second translation.',
        }],
    }));

    assert.equal(await cache.get(FIRST_KEY), null);
    assert.equal((await cache.get(SECOND_KEY)).status, 'complete');
    assert.deepEqual(await cache.getStats(), {
        entries: 1,
        sizeBytes: new TextEncoder().encode('Second translation.').length,
    });
});

test('clears translation entries without affecting another cache root', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-translation-'));
    const otherRoot = await mkdtemp(path.join(os.tmpdir(), 'mktero-other-'));
    t.after(() => Promise.all([
        rm(rootPath, { recursive: true, force: true }),
        rm(otherRoot, { recursive: true, force: true }),
    ]));
    const cache = new TranslationCache(options(rootPath));
    const other = new TranslationCache(options(otherRoot));
    await cache.put(FIRST_KEY, result());
    await other.put(FIRST_KEY, result());

    await cache.clear();

    assert.deepEqual(await cache.getStats(), { entries: 0, sizeBytes: 0 });
    assert.ok(await other.get(FIRST_KEY));
});

test('excludes API keys, display names, and QPS from cache keys', async () => {
    const configuration = {
        service: {
            name: 'First name',
            apiURL: 'https://api.example.test/v1/chat/completions',
            apiKey: 'secret-one',
            model: 'model-a',
            maxRequestsPerSecond: 1,
            maxParagraphsPerRequest: 8,
            maxCharactersPerRequest: 6000,
            temperature: 0.2,
        },
        targetLanguage: 'zh-CN',
        systemPrompt: 'Academic prompt',
    };
    const first = await createTranslationCacheKey('Markdown source', configuration, {
        crypto: webcrypto,
    });
    const ignoredChanges = await createTranslationCacheKey('Markdown source', {
        ...configuration,
        service: {
            ...configuration.service,
            name: 'Renamed',
            apiKey: 'secret-two',
            maxRequestsPerSecond: 10,
        },
    }, { crypto: webcrypto });
    const outputChange = await createTranslationCacheKey('Markdown source', {
        ...configuration,
        service: {
            ...configuration.service,
            temperature: 0.4,
        },
    }, { crypto: webcrypto });

    assert.equal(first, ignoredChanges);
    assert.notEqual(first, outputChange);
});

test('includes segmentation version in translation cache keys', async () => {
    const configuration = {
        service: {
            name: 'Service',
            apiURL: 'https://api.example.test/v1/chat/completions',
            apiKey: 'secret',
            model: 'model-a',
            maxRequestsPerSecond: 1,
            maxParagraphsPerRequest: 8,
            maxCharactersPerRequest: 6000,
            temperature: 0.2,
        },
        targetLanguage: 'zh-CN',
        systemPrompt: 'Academic prompt',
    };
    assert.equal(TRANSLATION_SEGMENTATION_VERSION, 3);

    const markdown = 'Markdown source';
    const key = await createTranslationCacheKey(markdown, configuration, {
        crypto: webcrypto,
    });
    const sourceHash = await sha256Hex(
        new TextEncoder().encode(markdown),
        { crypto: webcrypto }
    );
    const descriptor = translationProfileDescriptor(configuration);
    assert.equal(descriptor.segmentationVersion, 3);
    const expected = await sha256Hex(new TextEncoder().encode(JSON.stringify({
        sourceHash,
        ...descriptor,
    })), { crypto: webcrypto });
    assert.equal(key, expected);

    const previousVersion = await sha256Hex(new TextEncoder().encode(JSON.stringify({
        sourceHash,
        ...descriptor,
        segmentationVersion: 2,
    })), { crypto: webcrypto });
    assert.notEqual(key, previousVersion);
});

test('rejects excessive entries before writing cache files', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-translation-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const cache = new TranslationCache(options(rootPath, { maxSegments: 1 }));

    assert.throws(
        () => cache.put(FIRST_KEY, result()),
        /invalid translation cache result/i
    );
    assert.deepEqual(await cache.getStats(), { entries: 0, sizeBytes: 0 });
});


test('keeps the previous generation when atomic metadata replacement fails', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-translation-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const ioUtils = createNodeIOUtils();
    const cache = new TranslationCache({
        ...options(rootPath),
        ioUtils,
    });
    await cache.put(FIRST_KEY, result());
    const originalWriteUTF8 = ioUtils.writeUTF8;
    ioUtils.writeUTF8 = async (filePath, data, ioOptions) => {
        if (path.basename(filePath) === 'entry.json'
            && String(data).includes('"serviceName":"Replacement"')) {
            throw new Error('simulated metadata failure');
        }
        return originalWriteUTF8(filePath, data, ioOptions);
    };

    await assert.rejects(
        () => cache.put(FIRST_KEY, result({
            serviceName: 'Replacement',
            segments: [{
                id: 'segment-000001',
                sourceHash: '1234abcd',
                from: 0,
                to: 20,
                kind: 'paragraph',
                status: 'complete',
                text: 'Replacement translation.',
            }],
        })),
        /simulated metadata failure/i
    );
    ioUtils.writeUTF8 = originalWriteUTF8;
    assert.deepEqual(await cache.get(FIRST_KEY), result());
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
        makeDirectory: (filePath, ioOptions = {}) => mkdir(filePath, {
            recursive: ioOptions.ignoreExisting !== false,
        }),
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
        remove: (filePath, ioOptions = {}) => rm(filePath, {
            recursive: ioOptions.recursive,
            force: ioOptions.ignoreAbsent,
        }),
        async writeUTF8(filePath, data, ioOptions = {}) {
            if (!ioOptions.tmpPath) {
                await writeFile(filePath, data);
                return;
            }
            await writeFile(ioOptions.tmpPath, data);
            await rename(ioOptions.tmpPath, filePath);
        },
    };
}
