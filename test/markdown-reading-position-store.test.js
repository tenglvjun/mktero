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
import {
    MarkdownReadingPositionStore,
} from '../src/cache/markdown-reading-position-store.js';

const SOURCE_HASH = 'a'.repeat(64);
const MINERU_CACHE_KEY = 'b'.repeat(64);
const MISTRAL_CACHE_KEY = 'c'.repeat(64);
const ANCHOR = Object.freeze({
    offset: 42,
    headingKey: 'methods',
    headingOccurrence: 0,
    relativeOffset: 12,
});

test('restores a reading position across store instances', async t => {
    const options = await createStoreOptions(t);
    await new MarkdownReadingPositionStore(options).save(SOURCE_HASH, {
        cacheKey: MINERU_CACHE_KEY,
        anchor: ANCHOR,
    });

    assert.deepEqual(
        await new MarkdownReadingPositionStore(options).load(
            SOURCE_HASH,
            MINERU_CACHE_KEY
        ),
        {
            sourceHash: SOURCE_HASH,
            cacheKey: MINERU_CACHE_KEY,
            anchor: ANCHOR,
        }
    );
});

test('keeps only the current conversion key for one PDF', async t => {
    const options = await createStoreOptions(t);
    const store = new MarkdownReadingPositionStore(options);
    await store.save(SOURCE_HASH, {
        cacheKey: MINERU_CACHE_KEY,
        anchor: ANCHOR,
    });
    await store.save(SOURCE_HASH, {
        cacheKey: MISTRAL_CACHE_KEY,
        anchor: { offset: 8 },
    });

    assert.deepEqual(
        await store.load(SOURCE_HASH, MISTRAL_CACHE_KEY),
        {
            sourceHash: SOURCE_HASH,
            cacheKey: MISTRAL_CACHE_KEY,
            anchor: { offset: 8 },
        }
    );
    assert.equal(
        await store.load(SOURCE_HASH, MINERU_CACHE_KEY),
        null
    );
});

test('deletes a stored position when the conversion key no longer matches', async t => {
    const options = await createStoreOptions(t);
    const store = new MarkdownReadingPositionStore(options);
    await store.save(SOURCE_HASH, {
        cacheKey: MINERU_CACHE_KEY,
        anchor: ANCHOR,
    });

    assert.equal(
        await store.load(SOURCE_HASH, MISTRAL_CACHE_KEY),
        null
    );
    assert.equal(
        await store.load(SOURCE_HASH, MINERU_CACHE_KEY),
        null
    );
});

test('clear removes every stored reading position', async t => {
    const options = await createStoreOptions(t);
    const store = new MarkdownReadingPositionStore(options);
    await store.save(SOURCE_HASH, {
        cacheKey: MINERU_CACHE_KEY,
        anchor: ANCHOR,
    });
    await store.save('d'.repeat(64), {
        cacheKey: MISTRAL_CACHE_KEY,
        anchor: { offset: 3 },
    });

    await store.clear();

    assert.equal(await store.load(SOURCE_HASH, MINERU_CACHE_KEY), null);
    assert.deepEqual(await store.getStats(), {
        entries: 0,
        sizeBytes: 0,
    });
});

test('reports cache statistics for combined cache usage', async t => {
    const options = await createStoreOptions(t);
    const store = new MarkdownReadingPositionStore(options);
    await store.save(SOURCE_HASH, {
        cacheKey: MINERU_CACHE_KEY,
        anchor: ANCHOR,
    });

    const stats = await store.getStats();
    assert.equal(stats.entries, 1);
    assert.ok(stats.sizeBytes > 0);
});

test('rejects oversized reading-position files before reading them', async () => {
    let read = false;
    const store = new MarkdownReadingPositionStore({
        rootPath: '/profile/mktero-reading-positions/v1',
        ioUtils: {
            exists: async () => true,
            stat: async () => ({ size: 8 * 1024 + 1 }),
            getChildren: async () => [],
            async readUTF8() {
                read = true;
                return '{}';
            },
        },
        pathUtils: {
            join: path.join,
            parent: path.dirname,
            filename: path.basename,
        },
    });

    await assert.rejects(
        () => store.load(SOURCE_HASH, MINERU_CACHE_KEY),
        /exceeds the safety limit/
    );
    assert.equal(read, false);
});

async function createStoreOptions(t) {
    const rootPath = await mkdtemp(
        path.join(os.tmpdir(), 'mktero-reading-positions-')
    );
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    return {
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: {
            join: path.join,
            parent: path.dirname,
            filename: path.basename,
        },
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
        readUTF8: filePath => readFile(filePath, 'utf8'),
        getChildren: async filePath => (await readdir(filePath))
            .map(name => path.join(filePath, name)),
        stat,
        remove: (filePath, options = {}) => rm(filePath, {
            recursive: Boolean(options.recursive),
            force: Boolean(options.ignoreAbsent),
        }),
        async writeUTF8(filePath, value, options = {}) {
            const temporaryPath = options.tmpPath || `${filePath}.tmp`;
            await writeFile(temporaryPath, value, 'utf8');
            await rename(temporaryPath, filePath);
        },
    };
}
