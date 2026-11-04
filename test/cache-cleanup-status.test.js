import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createPreferencesController } from '../src/ui/preferences.js';
import { createLocalization } from '../src/i18n/localization.js';
import {
    CACHE_CLEANUP_STATUS_TOPIC, CACHE_CLEANUP_STATUS_REQUEST_TOPIC, CACHE_CLEANUP_RETRY_TOPIC,
    publishCacheCleanupStatus, observeCacheCleanupStatus, requestCacheCleanupStatus,
    requestCacheCleanupRetry, registerCacheCleanupStatusProvider,
} from '../src/cache/cache-events.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const snapshot = (overrides = {}) => ({
    state: 'blocked', checkedAt: 100, nextRunAt: 60000, removed: 0, ownersRemoved: 1,
    referenced: 0, busy: 0, unknown: 1, errors: 0,
    reasons: [{ code: 'missing-file', count: 1 }],
    blockers: [{ itemID: 9, libraryID: 1, attachmentKey: 'MISSING1', reason: 'missing-file' }],
    ...overrides,
});
function observerService() {
    const observers = new Map();
    return { observers, obs: {
        addObserver(observer, topic) {
            const set = observers.get(topic) || new Set();
            set.add(observer);
            observers.set(topic, set);
        },
        removeObserver(observer, topic) { observers.get(topic)?.delete(observer); },
        notifyObservers(subject, topic, data) {
            for (const observer of observers.get(topic) || []) observer.observe(subject, topic, data);
        },
    } };
}

test('cleanup events expose only bounded safe status fields and dispose observers', () => {
    const services = observerService();
    const values = [];
    const dispose = observeCacheCleanupStatus(services, value => values.push(value));
    publishCacheCleanupStatus(services, snapshot({
        path: '/private/file.pdf', hash: 'secret', exception: 'secret',
        blockers: [...Array.from({ length: 12 }, (_, i) => ({
            itemID: i + 1, libraryID: 1, attachmentKey: 'MISSING1', reason: 'missing-file', path: 'secret',
        })), { itemID: 20, libraryID: 1, attachmentKey: '<img src=x>', reason: 'missing-file' }],
    }));
    assert.equal(values.length, 1);
    assert.equal(values[0].blockers.length, 10);
    assert.equal(JSON.stringify(values).includes('secret'), false);
    assert.equal(JSON.stringify(values).includes('/private'), false);
    services.obs.notifyObservers(null, CACHE_CLEANUP_STATUS_TOPIC, '{broken');
    services.obs.notifyObservers(null, CACHE_CLEANUP_STATUS_TOPIC, 'x'.repeat(16385));
    publishCacheCleanupStatus(services, { state: 'arbitrary' });
    assert.equal(values.length, 1);
    dispose();
    dispose();
    publishCacheCleanupStatus(services, snapshot());
    assert.equal(values.length, 1);
    assert.equal(services.observers.get(CACHE_CLEANUP_STATUS_TOPIC).size, 0);
});

test('status requests and retry requests are read-check operations, not cache clearing', async () => {
    const services = observerService();
    const values = [];
    let current = snapshot();
    let retries = 0;
    const stopListening = observeCacheCleanupStatus(services, value => values.push(value));
    const dispose = registerCacheCleanupStatusProvider(services, {
        getStatus: () => current,
        retry: () => { retries++; current = snapshot({ state: 'running' }); },
    });
    requestCacheCleanupStatus(services);
    assert.equal(values.at(-1).unknown, 1);
    requestCacheCleanupRetry(services);
    requestCacheCleanupRetry(services);
    await tick();
    assert.equal(retries, 1);
    assert.equal(values.at(-1).state, 'running');
    dispose();
    requestCacheCleanupRetry(services);
    await tick();
    assert.equal(retries, 1);
    assert.equal(services.observers.get(CACHE_CLEANUP_STATUS_REQUEST_TOPIC).size, 0);
    assert.equal(services.observers.get(CACHE_CLEANUP_RETRY_TOPIC).size, 0);
    stopListening();
});

test('late async status responses and stopped providers cannot overwrite current status', async () => {
    const services = observerService();
    const values = [];
    const resolves = [];
    const stopListening = observeCacheCleanupStatus(services, value => values.push(value));
    const dispose = registerCacheCleanupStatusProvider(services, {
        getStatus: () => new Promise(resolve => resolves.push(resolve)), retry: async () => {},
    });
    requestCacheCleanupStatus(services);
    requestCacheCleanupStatus(services);
    resolves[1](snapshot({ state: 'complete', unknown: 0 }));
    await tick();
    resolves[0](snapshot());
    await tick();
    assert.equal(values.length, 1);
    assert.equal(values[0].state, 'complete');
    requestCacheCleanupStatus(services);
    dispose();
    resolves[2](snapshot());
    await tick();
    assert.equal(values.length, 1);
    stopListening();
});

test('a failing cleanup provider reports a safe error without exception details', async () => {
    const services = observerService();
    const values = [];
    const stopListening = observeCacheCleanupStatus(services, value => values.push(value));
    const dispose = registerCacheCleanupStatusProvider(services, {
        getStatus: () => snapshot(), retry: () => { throw new Error('/private/secret'); },
    });
    requestCacheCleanupRetry(services);
    await tick();
    assert.equal(values.at(-1).state, 'error');
    assert.equal(values.at(-1).reasons[0].code, 'cleanup-failed');
    assert.equal(JSON.stringify(values).includes('secret'), false);
    dispose();
    stopListening();
});

for (const locale of ['en-US', 'zh-CN']) {
    test(`preferences render cleanup reasons, refresh statistics, and retry safely in ${locale}`, async t => {
        const dom = new JSDOM('<div id="mktero-cache-status"></div><button id="mktero-clear-cache"></button>'
            + '<div id="mktero-cache-cleanup-status"></div><button id="mktero-cache-cleanup-retry"></button>');
        t.after(() => dom.window.close());
        const services = observerService();
        let current = snapshot();
        let statsCalls = 0;
        let retries = 0;
        let clearCalls = 0;
        let entries = 2;
        const dispose = registerCacheCleanupStatusProvider(services, {
            getStatus: () => current,
            retry: () => { retries++; current = snapshot({ state: 'running' }); },
        });
        t.after(dispose);
        const controller = createPreferencesController({
            document: dom.window.document, services, zotero: { logError: assert.fail },
            localization: createLocalization({ zoteroLocale: locale }),
            cache: { getStats: async () => { statsCalls++; return { entries, sizeBytes: entries * 100 }; },
                clear: async () => { clearCalls++; } },
        });
        t.after(() => controller.destroy());
        await controller.init();
        const status = dom.window.document.getElementById('mktero-cache-cleanup-status');
        const retry = dom.window.document.getElementById('mktero-cache-cleanup-retry');
        const expected = locale === 'zh-CN' ? 'PDF 本地文件缺失' : 'A PDF is missing locally';
        assert.ok(status.textContent.includes(expected));
        assert.ok(status.textContent.includes('MISSING1'));
        assert.ok(status.textContent.includes(locale === 'zh-CN' ? '下次检查' : 'Next check'));
        assert.equal(retry.disabled, false);
        const initial = statsCalls;
        for (let i = 0; i < 10; i++) publishCacheCleanupStatus(services, snapshot({ state: 'running' }));
        await tick();
        assert.equal(statsCalls, initial);
        assert.equal(retry.disabled, true);
        entries = 0;
        current = snapshot({ state: 'complete', checkedAt: 200, unknown: 0, removed: 1, blockers: [], reasons: [] });
        publishCacheCleanupStatus(services, current);
        await tick();
        assert.equal(statsCalls, initial + 1);
        assert.ok(dom.window.document.getElementById('mktero-cache-status').textContent.includes(
            locale === 'zh-CN' ? '没有本地缓存' : 'No local cache entries'
        ));
        publishCacheCleanupStatus(services, { ...current, nextRunAt: 90000 });
        await tick();
        assert.equal(statsCalls, initial + 1);
        retry.click();
        await tick();
        assert.equal(retries, 1);
        assert.equal(clearCalls, 0);
        const beforeDestroy = status.textContent;
        controller.destroy();
        publishCacheCleanupStatus(services, snapshot());
        await tick();
        assert.equal(status.textContent, beforeDestroy);
        assert.equal(services.observers.get(CACHE_CLEANUP_STATUS_TOPIC).size, 0);
    });
}

test('preferences keep retry disabled when no cleanup provider is available', async t => {
    const dom = new JSDOM('<div id="mktero-cache-status"></div><button id="mktero-clear-cache"></button>'
        + '<div id="mktero-cache-cleanup-status"></div><button id="mktero-cache-cleanup-retry"></button>');
    t.after(() => dom.window.close());
    const controller = createPreferencesController({
        document: dom.window.document, services: observerService(), zotero: { logError: assert.fail },
        cache: { getStats: async () => ({ entries: 0, sizeBytes: 0 }), clear: async () => assert.fail('must not clear') },
    });
    t.after(() => controller.destroy());
    await controller.init();
    assert.equal(dom.window.document.getElementById('mktero-cache-cleanup-retry').disabled, true);
    assert.match(dom.window.document.getElementById('mktero-cache-cleanup-status').textContent, /Waiting/);
});
