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
import { makeRestoredFigureDocument } from './helpers/restored-figure-fixture.js';
import {
    openMarkdownRevisionSession,
} from '../src/core/markdown-revision-session.js';
import {
    ZoteroMarkdownRevisionStore,
} from '../src/platform/zotero-markdown-revision-store.js';

const CACHE_KEY = 'a'.repeat(64);

test('persists figure provenance and remaps a corrected document across store instances', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-figure-revisions-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const options = { rootPath, ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, parent: path.dirname } };
    const baseDocument = { ...await makeRestoredFigureDocument(), itemID: 42, cacheKey: CACHE_KEY };
    const first = await openMarkdownRevisionSession({ baseDocument, store: new ZoteroMarkdownRevisionStore(options) });
    const paragraph = first.snapshot().editableBlocks.find(block => block.markdown.includes('Body text'));
    const snapshot = await first.commit({ blockID: paragraph.id, replacementMarkdown: 'Corrected body text outside the figure.' });
    const second = await openMarkdownRevisionSession({ baseDocument, store: new ZoteroMarkdownRevisionStore(options) });
    assert.deepEqual(second.snapshot().figureMap, snapshot.figureMap);
    assert.equal(second.snapshot().figureMap.figures[0].id, baseDocument.figureMap.figures[0].id);
    await rm(path.join(rootPath, 'entries', CACHE_KEY, 'figure-map.json'));
    const missing = await new ZoteroMarkdownRevisionStore(options).load(CACHE_KEY);
    assert.equal(missing.base.figureMap, undefined);
    assert.equal(missing.base.markdown, baseDocument.markdown);
    assert.equal(missing.base.assets.length, baseDocument.assets.length);
});

test('restores corrected Markdown and assets across revision store instances', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-revisions-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const options = {
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, parent: path.dirname },
        now: () => 1_786_320_000_000,
    };
    const baseDocument = {
        itemID: 42,
        cacheKey: CACHE_KEY,
        markdown: '# Paper\n\nThe result was 9O%.',
        sourceMap: [],
        assets: [{
            path: 'paper/images/figure.png',
            mimeType: 'image/png',
            data: new Uint8Array([1, 2, 3]),
        }],
        assetBasePath: 'paper',
        extractedPages: 1,
        totalPages: 1,
    };
    const first = await openMarkdownRevisionSession({
        baseDocument,
        store: new ZoteroMarkdownRevisionStore(options),
    });
    const paragraph = first.snapshot().editableBlocks.find(block => (
        block.type === 'paragraph'
    ));
    await first.commit({
        blockID: paragraph.id,
        replacementMarkdown: 'The result was 90%.',
    });

    const reopened = await openMarkdownRevisionSession({
        baseDocument: { ...baseDocument, markdown: '# Ignored fresh result' },
        store: new ZoteroMarkdownRevisionStore(options),
    });

    const snapshot = reopened.snapshot();
    assert.equal(snapshot.markdown, '# Paper\n\nThe result was 90%.');
    assert.deepEqual([...snapshot.assets[0].data], [1, 2, 3]);
    assert.equal(snapshot.correctionCount, 1);
});

test('rejects changes to immutable figure metadata and ignores same-size on-disk tampering', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-figure-immutable-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const store = new ZoteroMarkdownRevisionStore({ rootPath, ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, parent: path.dirname } });
    const revision = { schemaVersion: 1, blocks: [], corrections: [],
        base: { ...await makeRestoredFigureDocument(), itemID: 42, cacheKey: CACHE_KEY } };
    await store.save(CACHE_KEY, revision);
    const changed = structuredClone(revision);
    changed.base.figureMap.figures[0].visualBBox[0]--;
    await assert.rejects(store.save(CACHE_KEY, changed), /base cannot be replaced/u);
    assert.deepEqual((await store.load(CACHE_KEY)).base.figureMap, revision.base.figureMap);

    const entryPath = path.join(rootPath, 'entries', CACHE_KEY);
    const filePath = path.join(entryPath, 'figure-map.json');
    const original = await readFile(filePath, 'utf8');
    const tampered = original.replace('Body', 'body').replace('Time', 'time');
    assert.notEqual(tampered, original);
    assert.equal(Buffer.byteLength(tampered), Buffer.byteLength(original));
    await writeFile(filePath, tampered);
    const loaded = await store.load(CACHE_KEY);
    assert.equal(loaded.base.figureMap, undefined);
    assert.equal(loaded.base.markdown, revision.base.markdown);
    await store.save(CACHE_KEY, loaded);
    assert.equal(await readFile(filePath, 'utf8'), tampered);
});

test('keeps corrected documents readable and writable with old or malformed optional figure metadata', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-figure-compatibility-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const store = new ZoteroMarkdownRevisionStore({ rootPath, ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, parent: path.dirname } });
    const revision = { schemaVersion: 1, blocks: [], corrections: [{ blockID: 'body-correction' }],
        base: { ...await makeRestoredFigureDocument(), itemID: 42, cacheKey: CACHE_KEY } };
    await store.save(CACHE_KEY, revision);
    const metadataPath = path.join(rootPath, 'entries', CACHE_KEY, 'metadata.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    const legacy = { ...metadata };
    delete legacy.figureMapHash;
    await writeFile(metadataPath, JSON.stringify(legacy));
    const loaded = await store.load(CACHE_KEY);
    assert.deepEqual(loaded.base.figureMap, revision.base.figureMap);
    await store.save(CACHE_KEY, loaded);
    assert.match(JSON.parse(await readFile(metadataPath, 'utf8')).figureMapHash, /^[a-f0-9]{64}$/u);
    for (const invalid of [
        { figureMapHash: 'invalid' }, { figureMapHash: null },
        { figureMapBytes: -1 }, { figureMapBytes: 9 * 1024 * 1024 },
        { figureMapBytes: '100' }, { figureMapBytes: 0 }, { figureMapBytes: null },
        { figureMapBytes: false }, { figureMapBytes: '' },
    ]) {
        await writeFile(metadataPath, JSON.stringify({ ...metadata, ...invalid }));
        const result = await store.load(CACHE_KEY);
        assert.equal(result.base.figureMap, undefined);
        assert.equal(result.base.markdown, revision.base.markdown);
        assert.deepEqual(result.corrections, revision.corrections);
        await store.save(CACHE_KEY, result);
        const reopened = await store.load(CACHE_KEY);
        assert.equal(reopened.base.markdown, result.base.markdown);
        assert.equal(reopened.base.figureMap, undefined);
        assert.deepEqual(reopened.corrections, result.corrections);
    }
});

test('cleans every failed first figure write and allows a retry without deleting unrelated files', async t => {
    const revision = { schemaVersion: 1, blocks: [], corrections: [],
        base: { ...await makeRestoredFigureDocument(), itemID: 42, cacheKey: CACHE_KEY } };
    for (const failAt of ['base.md', 'source-map.json', 'figure-map.json', '0001.bin', 'corrections-', 'metadata.json']) {
        const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-figure-write-'));
        t.after(() => rm(rootPath, { recursive: true, force: true }));
        const io = createNodeIOUtils();
        let failing = true;
        for (const method of ['write', 'writeUTF8']) {
            const original = io[method];
            io[method] = async (filePath, data, options) => {
                if (failing && path.basename(filePath).startsWith(failAt)) {
                    await writeFile(options.tmpPath, data);
                    throw new Error('Injected write failure');
                }
                return original(filePath, data, options);
            };
        }
        const entryPath = path.join(rootPath, 'entries', CACHE_KEY);
        await mkdir(entryPath, { recursive: true });
        await writeFile(path.join(entryPath, 'user-file.txt'), 'keep');
        const store = new ZoteroMarkdownRevisionStore({ rootPath, ioUtils: io,
            pathUtils: { join: path.join, parent: path.dirname } });
        await assert.rejects(store.save(CACHE_KEY, revision), /Injected/u);
        assert.deepEqual((await readdir(entryPath, { recursive: true })).sort(), ['assets', 'user-file.txt']);
        assert.equal(await readFile(path.join(entryPath, 'user-file.txt'), 'utf8'), 'keep');
        failing = false;
        await store.save(CACHE_KEY, revision);
        assert.ok((await store.load(CACHE_KEY)).base.figureMap);
    }
});

test('keeps the last committed correction and figure map after repeated metadata failures', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-figure-atomic-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const io = createNodeIOUtils();
    const options = { rootPath, ioUtils: io, now: () => 123,
        pathUtils: { join: path.join, parent: path.dirname } };
    const revision = { schemaVersion: 1, blocks: [], corrections: [],
        base: { ...await makeRestoredFigureDocument(), itemID: 42, cacheKey: CACHE_KEY } };
    await new ZoteroMarkdownRevisionStore(options).save(CACHE_KEY, revision);
    const entryPath = path.join(rootPath, 'entries', CACHE_KEY);
    const before = (await readdir(entryPath, { recursive: true })).sort();
    const write = io.writeUTF8;
    io.writeUTF8 = async (filePath, data, options) => {
        if (path.basename(filePath) === 'metadata.json') {
            await writeFile(options.tmpPath, data);
            throw new Error('Injected metadata failure');
        }
        return write(filePath, data, options);
    };
    const store = new ZoteroMarkdownRevisionStore(options);
    const changed = { ...revision, corrections: [{ blockID: 'new-correction' }] };
    for (let attempt = 0; attempt < 3; attempt++) {
        await assert.rejects(store.save(CACHE_KEY, changed), /Injected/u);
        assert.deepEqual((await readdir(entryPath, { recursive: true })).sort(), before);
        assert.deepEqual((await store.load(CACHE_KEY)).corrections, []);
    }
    io.writeUTF8 = write;
    await store.save(CACHE_KEY, changed);
    assert.deepEqual((await store.load(CACHE_KEY)).corrections, changed.corrections);
});

test('deletes a revision without touching a sibling cache directory', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-revisions-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const cacheMarker = path.join(path.dirname(rootPath), 'mktero-cache-marker');
    await writeFile(cacheMarker, 'keep');
    t.after(() => rm(cacheMarker, { force: true }));
    const store = new ZoteroMarkdownRevisionStore({
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, parent: path.dirname },
    });
    const baseDocument = {
        itemID: 42,
        cacheKey: CACHE_KEY,
        markdown: '# Paper\n\nOriginal.',
        sourceMap: [],
        assets: [],
    };
    const session = await openMarkdownRevisionSession({ baseDocument, store });
    const paragraph = session.snapshot().editableBlocks.find(block => (
        block.type === 'paragraph'
    ));
    await session.commit({
        blockID: paragraph.id,
        replacementMarkdown: 'Corrected.',
    });

    await session.restoreAll();

    assert.equal(await store.load(CACHE_KEY), null);
    assert.equal(await readFile(cacheMarker, 'utf8'), 'keep');
});

test('reports corrupt revision metadata without deleting user files', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-revisions-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const entryPath = path.join(rootPath, 'entries', CACHE_KEY);
    await mkdir(entryPath, { recursive: true });
    const metadataPath = path.join(entryPath, 'metadata.json');
    await writeFile(metadataPath, '{invalid');
    const store = new ZoteroMarkdownRevisionStore({
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, parent: path.dirname },
    });

    await assert.rejects(() => store.load(CACHE_KEY), /invalid revision metadata/i);
    assert.equal(await readFile(metadataPath, 'utf8'), '{invalid');
});

test('rejects an individual revision image above the existing image budget', async () => {
    const writes = [];
    const store = new ZoteroMarkdownRevisionStore({
        rootPath: '/profile/mktero-revisions/v1',
        ioUtils: createMemoryIOUtils(writes),
        pathUtils: { join: path.join, parent: path.dirname },
    });
    const oversized = new Uint8Array(25 * 1024 * 1024 + 1);

    await assert.rejects(() => store.save(CACHE_KEY, createRevisionWithAssets([{
        path: 'images/oversized.png',
        mimeType: 'image/png',
        data: oversized,
    }])), /assets exceed their size limit/i);
    assert.deepEqual(writes, []);
});

test('rejects aggregate revision images above the existing archive budget', async () => {
    const writes = [];
    const store = new ZoteroMarkdownRevisionStore({
        rootPath: '/profile/mktero-revisions/v1',
        ioUtils: createMemoryIOUtils(writes),
        pathUtils: { join: path.join, parent: path.dirname },
    });
    const sharedData = new Uint8Array(25 * 1024 * 1024);
    const assets = Array.from({ length: 7 }, (_, index) => ({
        path: `images/${index}.png`,
        mimeType: 'image/png',
        data: sharedData,
    }));

    await assert.rejects(
        () => store.save(CACHE_KEY, createRevisionWithAssets(assets)),
        /assets exceed their size limit/i
    );
    assert.deepEqual(writes, []);
});

function createRevisionWithAssets(assets) {
    return {
        schemaVersion: 1,
        base: {
            itemID: 42,
            cacheKey: CACHE_KEY,
            markdown: 'Original.',
            sourceMap: [],
            assets,
        },
        blocks: [],
        corrections: [{
            blockID: 'block-0',
            originalMarkdown: 'Original.',
            replacementMarkdown: 'Corrected.',
        }],
    };
}

function createMemoryIOUtils(writes) {
    return {
        exists: async () => false,
        makeDirectory: async () => {},
        write: async filePath => { writes.push(filePath); },
        writeUTF8: async filePath => { writes.push(filePath); },
    };
}

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
