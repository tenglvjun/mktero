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
import { parseHTML } from 'linkedom';
import {
    createMarkdownReadinessController,
} from '../src/cache/markdown-readiness-controller.js';
import {
    createMarkdownReadinessIndex,
    parseMarkdownReadinessRecords,
    resolveMarkdownReadinessIdentity,
} from '../src/cache/markdown-readiness-index.js';
import {
    MarkdownCache,
} from '../src/cache/markdown-cache.js';
import {
    MarkdownReadinessStore,
} from '../src/platform/zotero-markdown-readiness-store.js';
import {
    markdownReadinessColumnOptions,
    refreshMarkdownReadinessColumn,
    registerMarkdownReadinessColumn,
} from '../src/ui/markdown-readiness-column.js';

const CACHE_KEY = 'a'.repeat(64);
const OTHER_CACHE_KEY = 'b'.repeat(64);
const PROFILE = 'mineru-profile';
const OTHER_PROFILE = 'mistral-profile';
const NOW = 1_700_000_000_000;

test('marks the parent paper and its PDF when the current cache is readable', async () => {
    const harness = createHarness();
    const remembered = await harness.controller.remember(record());

    assert.equal(remembered, true);
    assert.equal(harness.controller.isReady(parentItem(), PROFILE), true);
    assert.equal(harness.controller.cacheKeyFor(attachmentItem(), PROFILE), CACHE_KEY);
    assert.equal(harness.controller.cacheKeyFor(parentItem(), OTHER_PROFILE), null);
    assert.equal(harness.controller.isReady(attachmentItem(), PROFILE), true);
    assert.equal(harness.controller.isReady(parentItem(), OTHER_PROFILE), false);
    assert.equal(harness.controller.isReady({
        libraryID: 2,
        key: 'PARENT01',
    }, PROFILE), false);
    assert.equal(harness.changes, 1);
});

test('keeps the marker when the cache remains readable, and clears it when removed', async () => {
    const harness = createHarness();
    await harness.controller.remember(record());
    harness.indexNow = NOW + 10 * 365 * 24 * 60 * 60 * 1_000;
    assert.equal(harness.controller.isReady(parentItem(), PROFILE), true);

    await harness.controller.forgetCacheKeys([CACHE_KEY]);
    assert.equal(harness.controller.isReady(parentItem(), PROFILE), false);

    await harness.controller.remember(record());
    await harness.controller.handleCacheEvent({ type: 'cleared' });
    assert.equal(harness.controller.isReady(parentItem(), PROFILE), false);
    assert.equal(harness.store.cleared, 1);
});

test('keeps another parser profile recorded but hidden until it is current again', async () => {
    const harness = createHarness();
    await harness.controller.remember(record());
    await harness.controller.remember(record({
        parserProfile: OTHER_PROFILE,
        cacheKey: OTHER_CACHE_KEY,
    }));

    assert.equal(harness.controller.isReady(parentItem(), PROFILE), true);
    assert.equal(harness.controller.isReady(parentItem(), OTHER_PROFILE), true);
    assert.equal(
        harness.store.saved.at(-1).filter(entry => (
            entry.attachmentKey === 'ATTACH01'
        )).length,
        2
    );
});

test('drops index records whose cache entries are no longer readable', async () => {
    const harness = createHarness();
    await harness.controller.remember(record());
    await harness.controller.remember(record({
        attachmentKey: 'ATTACH02',
        cacheKey: OTHER_CACHE_KEY,
    }));

    await harness.controller.retainLiveEntries([{
        cacheKey: OTHER_CACHE_KEY,
        expiresAt: null,
    }]);

    assert.equal(harness.controller.isReady(attachmentItem(), PROFILE), false);
    assert.equal(harness.controller.isReady({
        libraryID: 1,
        key: 'ATTACH02',
    }, PROFILE), true);
});

test('migrates finite readiness expiry records to permanent records', () => {
    const legacy = record({ expiresAt: NOW - 1 });
    const records = parseMarkdownReadinessRecords({ schemaVersion: 1, records: [legacy] });
    assert.equal(records[0].expiresAt, null);

    const index = createMarkdownReadinessIndex({ now: () => NOW + 10 * 365 * 24 * 60 * 60 * 1_000 });
    index.replace(records);
    assert.equal(index.isReady(parentItem(), PROFILE), true);
});

test('does not cap readiness records at the former fixed maximum', () => {
    const index = createMarkdownReadinessIndex({ now: () => NOW });
    for (let number = 0; number < 501; number++) {
        index.remember(record({
            itemKey: `P${number.toString(36).padStart(6, '0')}`,
            attachmentKey: `A${number.toString(36).padStart(6, '0')}`,
            cacheKey: number.toString(16).padStart(64, '0'),
        }));
    }
    assert.equal(index.snapshot().length, 501);
});
test('resolves a PDF attachment to its parent paper without writing the item', () => {
    const item = attachmentItem();
    item.addTag = () => { throw new Error('must not tag'); };
    item.setField = () => { throw new Error('must not edit'); };
    item.saveTx = () => { throw new Error('must not save'); };

    assert.deepEqual(resolveMarkdownReadinessIdentity(item), {
        libraryID: 1,
        itemKey: 'PARENT01',
        attachmentKey: 'ATTACH01',
    });
    assert.deepEqual(resolveMarkdownReadinessIdentity({
        libraryID: 1,
        key: 'PARENT01',
    }), {
        libraryID: 1,
        itemKey: 'PARENT01',
        attachmentKey: 'PARENT01',
    });
    assert.equal(resolveMarkdownReadinessIdentity({
        libraryID: 1,
        key: '../escape',
    }), null);
});

test('persists readiness only in the profile index', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-readiness-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const options = {
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: {
            join: path.join,
            parent: path.dirname,
        },
    };
    const first = new MarkdownReadinessStore(options);
    await first.save([record()]);

    const restored = await new MarkdownReadinessStore(options).load();
    assert.deepEqual(restored, [record()]);
    const savedPath = path.join(rootPath, 'index.json');
    assert.equal(savedPath.startsWith(rootPath), true);
    await first.clear();
    assert.deepEqual(await first.load(), []);
});

test('migrates finite readiness expiries in the persisted index', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-readiness-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    await writeFile(path.join(rootPath, 'index.json'), JSON.stringify({
        schemaVersion: 1,
        records: [record({ expiresAt: NOW - 1 })],
    }));
    const store = new MarkdownReadinessStore({
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, parent: path.dirname },
    });

    assert.deepEqual(await store.load(), [record({ expiresAt: null })]);
    const persisted = JSON.parse(await readFile(path.join(rootPath, 'index.json'), 'utf8'));
    assert.equal(persisted.records[0].expiresAt, null);
});

test('keeps legacy readiness records if the best-effort migration write fails', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-readiness-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const indexPath = path.join(rootPath, 'index.json');
    const legacy = JSON.stringify({ schemaVersion: 1, records: [record()] });
    await writeFile(indexPath, legacy);
    const ioUtils = createNodeIOUtils();
    ioUtils.writeUTF8 = async () => { throw new Error('migration write failed'); };
    const store = new MarkdownReadinessStore({
        rootPath,
        ioUtils,
        pathUtils: { join: path.join, parent: path.dirname },
    });

    assert.deepEqual(await store.load(), [record({ expiresAt: null })]);
    assert.equal(await readFile(indexPath, 'utf8'), legacy);
});

test('persists readiness indexes larger than the former byte cap', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-readiness-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const store = new MarkdownReadinessStore({
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: { join: path.join, parent: path.dirname },
    });
    const records = Array.from({ length: 800 }, (_, number) => record({
        itemKey: `P${number.toString(36).padStart(6, '0')}`,
        attachmentKey: `A${number.toString(36).padStart(6, '0')}`,
        cacheKey: number.toString(16).padStart(64, '0'),
        parserProfile: `profile-${number}-${'p'.repeat(1_500)}`,
    }));

    await store.save(records);
    assert.ok((await stat(path.join(rootPath, 'index.json'))).size > 1024 * 1024);
    assert.equal((await store.load()).length, 800);
});

test('registers a narrow local column and does not require a color tag', () => {
    const calls = [];
    const zotero = {
        ItemTreeManager: {
            registerColumn(options) {
                calls.push(options);
                return 'plugin-markdownReady';
            },
            unregisterColumn(key) {
                calls.push({ unregistered: key });
            },
            refresh() {
                calls.push('refresh');
            },
        },
        getMainWindow: () => ({
            ZoteroPane: {
                itemsView: {
                    _rowCache: { 7: {} },
                    tree: { invalidate() { calls.push('invalidate'); } },
                },
            },
        }),
    };
    const column = registerMarkdownReadinessColumn({
        zotero,
        pluginID: 'mktero@tenglvjun.github.io',
        rootURI: 'resource://mktero/',
        isReady: item => item.libraryID === 1 && item.key === 'PARENT01',
        translate: key => key,
    });

    const options = calls[0];
    assert.equal(options.dataKey, 'markdownReady');
    assert.equal(options.pluginID, 'mktero@tenglvjun.github.io');
    assert.equal(Object.hasOwn(options, 'defaultIn'), false);
    assert.equal(options.flex, 0);
    assert.equal(options.width, '32');
    assert.equal(options.fixedWidth, true);
    assert.equal(options.iconPath, 'resource://mktero/ui/icons/mktero.svg');
    assert.equal(options.dataProvider(parentItem()), '1');
    assert.equal(options.dataProvider(attachmentItem()), '');
    assert.equal(options.dataProvider({ key: 'PARENT01' }), '');
    const { document } = parseHTML('<html><body></body></html>');
    const cell = options.renderCell(0, '1', { className: 'column' }, false, document);
    assert.equal(cell.getAttribute('aria-label'), 'column.markdownReadyTooltip');
    assert.equal(cell.querySelector('svg')?.getAttribute('data-lucide'), 'file-text');
    assertEmptyReadinessCell(options.renderCell(0, '', {}, false, document));

    column.refresh();
    column.dispose();
    assert.deepEqual(calls.slice(1), [
        'refresh',
        'invalidate',
        { unregistered: 'plugin-markdownReady' },
    ]);
});

test('uses the Zotero 7 registerColumns fallback and ignores a missing column API', () => {
    const calls = [];
    const legacy = registerMarkdownReadinessColumn({
        zotero: {
            ItemTreeManager: {
                registerColumns(options) {
                    calls.push(options.dataKey);
                    return ['legacy-markdownReady'];
                },
                unregisterColumns(key) {
                    calls.push(key);
                },
            },
        },
        pluginID: 'mktero@tenglvjun.github.io',
        isReady: () => false,
        translate: key => key,
    });
    legacy.dispose();
    const missing = registerMarkdownReadinessColumn({
        zotero: {},
        pluginID: 'mktero@tenglvjun.github.io',
        isReady: () => true,
    });
    missing.refresh();
    missing.dispose();

    assert.deepEqual(calls, ['markdownReady', 'legacy-markdownReady']);
    assert.equal(missing.registeredKey, null);
    refreshMarkdownReadinessColumn(null);
    assert.equal(markdownReadinessColumnOptions({
        pluginID: 'mktero@example.test',
        isReady: () => false,
    }).dataKey, 'markdownReady');
});

test('shows a preparing spinner ahead of the ready mark', () => {
    const options = markdownReadinessColumnOptions({
        pluginID: 'mktero@example.test',
        isReady: () => true,
        isPreparing: item => item.key === 'PARENT01',
        translate: key => key,
    });
    const { document } = parseHTML('<html><body></body></html>');
    assert.equal(options.dataProvider({ libraryID: 1, key: 'PARENT01' }), 'loading');
    const cell = options.renderCell(
        0,
        'loading',
        { className: 'column' },
        false,
        document
    );
    assert.equal(cell.getAttribute('aria-label'), 'column.markdownPreparingTooltip');
    assert.equal(
        cell.querySelector('svg')?.getAttribute('data-lucide'),
        'loader-circle'
    );
    assert.equal(document.getElementById('mktero-markdown-readiness-style')?.textContent.includes('prefers-reduced-motion'), true);
    assertEmptyReadinessCell(options.renderCell(0, '', {}, false, document));
});

function assertEmptyReadinessCell(cell) {
    assert.equal(cell?.tagName, 'SPAN');
    assert.equal(cell.className, 'cell');
    assert.equal(cell.childNodes.length, 0);
}

test('notifies readiness when a cache entry is written or cleared', async t => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'mktero-readiness-cache-'));
    t.after(() => rm(rootPath, { recursive: true, force: true }));
    const events = [];
    let now = NOW;
    const cache = new MarkdownCache({
        rootPath,
        ioUtils: createNodeIOUtils(),
        pathUtils: {
            join: path.join,
            parent: path.dirname,
            filename: path.basename,
        },
        now: () => now,
    });
    cache.setStoreChangeListener(event => events.push(event));

    await cache.put(CACHE_KEY, { markdown: '# Paper' });
    await flushMicrotasks();
    const readable = await cache.hasReadable(CACHE_KEY);
    assert.equal(readable.cacheKey, CACHE_KEY);
    assert.equal(readable.expiresAt, null);
    assert.deepEqual(await cache.listReadableEntries(), [readable]);

    now = NOW + 1_001;
    assert.equal((await cache.hasReadable(CACHE_KEY)).expiresAt, null);
    assert.equal((await cache.get(CACHE_KEY)).markdown, '# Paper');
    await cache.clear();
    await flushMicrotasks();

    assert.deepEqual(events.map(event => event.type), [
        'written',
        'cleared',
    ]);
});

function createHarness() {
    const saved = [];
    let cleared = 0;
    const changes = [];
    let indexNow = NOW;
    const store = {
        async load() { return []; },
        async save(records) { saved.push(records.map(record => ({ ...record }))); },
        async clear() { cleared += 1; },
    };
    const controller = createMarkdownReadinessController({
        store,
        now: () => indexNow,
        onChange: () => changes.push('changed'),
    });
    return {
        controller,
        get changes() { return changes.length; },
        get indexNow() { return indexNow; },
        set indexNow(value) { indexNow = value; },
        store: {
            get saved() { return saved; },
            get cleared() { return cleared; },
        },
    };
}

function record(overrides = {}) {
    return {
        libraryID: 1,
        itemKey: 'PARENT01',
        attachmentKey: 'ATTACH01',
        cacheKey: CACHE_KEY,
        parserProfile: PROFILE,
        expiresAt: null,
        ...overrides,
    };
}

function parentItem() {
    return { libraryID: 1, key: 'PARENT01' };
}

function attachmentItem() {
    return {
        libraryID: 1,
        key: 'ATTACH01',
        parentItem: parentItem(),
    };
}

function flushMicrotasks() {
    return new Promise(resolve => setTimeout(resolve, 0));
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
            recursive: Boolean(options.recursive),
            force: Boolean(options.ignoreAbsent),
        }),
        async write(filePath, data, options = {}) {
            if (options.tmpPath) {
                await writeFile(options.tmpPath, data);
                await rename(options.tmpPath, filePath);
                return;
            }
            await writeFile(filePath, data);
        },
        writeUTF8(filePath, data, options = {}) {
            return this.write(filePath, data, options);
        },
    };
}
