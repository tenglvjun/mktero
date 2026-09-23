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
    resolveMarkdownReadinessIdentity,
} from '../src/cache/markdown-readiness-index.js';
import {
    MarkdownCache,
    MARKDOWN_CACHE_MAX_AGE_MS,
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
    assert.equal(harness.controller.isReady(attachmentItem(), PROFILE), true);
    assert.equal(harness.controller.isReady(parentItem(), OTHER_PROFILE), false);
    assert.equal(harness.controller.isReady({
        libraryID: 2,
        key: 'PARENT01',
    }, PROFILE), false);
    assert.equal(harness.changes, 1);
});

test('turns the marker off when the cache expires, is removed, or is cleared', async () => {
    const harness = createHarness();
    await harness.controller.remember(record());
    harness.indexNow = NOW + MARKDOWN_CACHE_MAX_AGE_MS + 1;
    assert.equal(harness.controller.isReady(parentItem(), PROFILE), false);

    harness.indexNow = NOW;
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
        expiresAt: NOW + 10,
    }]);

    assert.equal(harness.controller.isReady(attachmentItem(), PROFILE), false);
    assert.equal(harness.controller.isReady({
        libraryID: 1,
        key: 'ATTACH02',
    }, PROFILE), true);
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
    assert.deepEqual(options.defaultIn, ['default']);
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
    assert.equal(options.renderCell(0, '', {}, false, document), null);

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

test('notifies readiness when a cache entry is written, expires, or cleared', async t => {
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
        maxAgeMs: 1_000,
    });
    cache.setStoreChangeListener(event => events.push(event));

    await cache.put(CACHE_KEY, { markdown: '# Paper' });
    await flushMicrotasks();
    const readable = await cache.hasReadable(CACHE_KEY);
    assert.equal(readable.cacheKey, CACHE_KEY);
    assert.equal(readable.expiresAt, NOW + 1_000);
    assert.deepEqual(await cache.listReadableEntries(), [readable]);

    now = NOW + 1_001;
    assert.equal(await cache.hasReadable(CACHE_KEY), null);
    assert.equal(await cache.get(CACHE_KEY), null);
    await flushMicrotasks();
    await cache.clear();
    await flushMicrotasks();

    assert.deepEqual(events.map(event => event.type), [
        'written',
        'removed',
        'cleared',
    ]);
    assert.deepEqual(events[1].cacheKeys, [CACHE_KEY]);
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
        expiresAt: NOW + MARKDOWN_CACHE_MAX_AGE_MS,
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
