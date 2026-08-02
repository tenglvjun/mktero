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
    createMinerUCacheKey,
    createZoteroMarkdownCache,
    MarkdownCache,
    sha256Hex,
} from '../src/cache/markdown-cache.js';

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
            recursive: options.recursive,
            force: options.ignoreAbsent,
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
