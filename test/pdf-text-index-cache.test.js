import test from 'node:test';
import assert from 'node:assert/strict';
import {
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
    PDFTextIndexCache,
} from '../src/cache/pdf-text-index-cache.js';
import {
    createDehyphenatedPdfAnnotationTextIndex,
} from '../src/markdown/pdf-annotation-text.js';

test('persists PDF text indexes and reports their local cache usage', async t => {
    const fixture = await createCacheFixture(t);
    const cacheKey = 'a'.repeat(64);
    const index = createIndex('Selected text');

    await fixture.cache.put(cacheKey, index);

    assert.deepEqual(await fixture.cache.get(cacheKey), index);
    const statistics = await fixture.cache.getStats();
    assert.equal(statistics.entries, 1);
    assert.ok(statistics.sizeBytes > 0);
    await fixture.cache.clear();
    assert.deepEqual(await fixture.cache.getStats(), {
        entries: 0,
        sizeBytes: 0,
    });
});

test('removes a corrupted PDF text index instead of returning it', async t => {
    const fixture = await createCacheFixture(t);
    const cacheKey = 'b'.repeat(64);
    await fixture.cache.put(cacheKey, createIndex('Selected text'));
    const entryPath = path.join(fixture.rootPath, 'entries', cacheKey);
    const indexFile = (await readdir(entryPath)).find(name => (
        name.startsWith('index-') && name.endsWith('.json')
    ));
    await writeFile(path.join(entryPath, indexFile), '{"profile":"bad"}');

    assert.equal(await fixture.cache.get(cacheKey), null);
    assert.equal(await fixture.ioUtils.exists(entryPath), false);
});

test('expires old indexes and enforces the entry limit', async t => {
    let timestamp = 1_000;
    const fixture = await createCacheFixture(t, {
        now: () => timestamp,
        maxEntries: 1,
        maxAgeMs: 1_000,
    });
    const firstKey = 'c'.repeat(64);
    const secondKey = 'd'.repeat(64);
    await fixture.cache.put(firstKey, createIndex('First'));
    timestamp = 1_500;
    await fixture.cache.put(secondKey, createIndex('Second'));

    assert.equal(await fixture.cache.get(firstKey), null);
    assert.equal((await fixture.cache.get(secondKey)).pages[0].rawText, 'Second');

    timestamp = 3_000;
    assert.equal(await fixture.cache.get(secondKey), null);
    assert.deepEqual(await fixture.cache.getStats(), {
        entries: 0,
        sizeBytes: 0,
    });
});

test('rejects an index that exceeds its serialized size budget', async t => {
    const fixture = await createCacheFixture(t, { maxIndexBytes: 64 });

    await assert.rejects(
        fixture.cache.put('e'.repeat(64), createIndex('Selected text')),
        /cache size limit/
    );
    assert.deepEqual(await fixture.cache.getStats(), {
        entries: 0,
        sizeBytes: 0,
    });
});

async function createCacheFixture(t, options = {}) {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-pdf-cache-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const ioUtils = createNodeIOUtils();
    return {
        rootPath,
        ioUtils,
        cache: new PDFTextIndexCache({
            rootPath,
            ioUtils,
            pathUtils: {
                join: path.join,
                filename: path.basename,
                parent: path.dirname,
            },
            ...options,
        }),
    };
}

function createIndex(rawText) {
    return {
        profile: 'pdfjs-test|text-v1',
        pages: [{
            pageIndex: 0,
            pageLabel: '1',
            viewport: {
                transform: [1, 0, 0, -1, 0, 792],
                width: 612,
                height: 792,
            },
            rawText,
            normalizedText: createDehyphenatedPdfAnnotationTextIndex(
                rawText
            ).text,
            items: [{
                text: rawText,
                direction: 'ltr',
                width: rawText.length * 10,
                height: 12,
                transform: [12, 0, 0, 12, 72, 700],
                fontName: 'F1',
                sourceFrom: 0,
                sourceTo: rawText.length,
            }],
            styles: {
                F1: {
                    fontFamily: 'sans-serif',
                    ascent: 0.8,
                    descent: -0.2,
                    vertical: false,
                },
            },
        }],
    };
}

function createNodeIOUtils() {
    return {
        async exists(filePath) {
            try {
                await stat(filePath);
                return true;
            }
            catch {
                return false;
            }
        },
        async makeDirectory(filePath, { ignoreExisting } = {}) {
            await mkdir(filePath, { recursive: Boolean(ignoreExisting) });
        },
        readUTF8: filePath => readFile(filePath, 'utf8'),
        async writeUTF8(filePath, data, { tmpPath } = {}) {
            if (!tmpPath) return writeFile(filePath, data, 'utf8');
            await writeFile(tmpPath, data, 'utf8');
            await rename(tmpPath, filePath);
        },
        async stat(filePath) {
            const fileStat = await stat(filePath);
            return {
                size: fileStat.size,
                type: fileStat.isDirectory() ? 'directory' : 'regular',
            };
        },
        async getChildren(filePath) {
            return (await readdir(filePath)).map(child => (
                path.join(filePath, child)
            ));
        },
        async remove(filePath, { recursive, ignoreAbsent } = {}) {
            await rm(filePath, {
                recursive: Boolean(recursive),
                force: Boolean(ignoreAbsent),
            });
        },
    };
}
