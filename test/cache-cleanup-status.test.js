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
    state: 'blocked', checkedAt: 100, nextRunAt: 60000, removed: 0, released: 0, ownersRemoved: 1,
    referenced: 0, busy: 0, unknown: 1, errors: 0,
    reasons: [{ code: 'missing-file', count: 1 }],
    blockers: [{ itemID: 9, libraryID: 1, attachmentKey: 'MISSING1', reason: 'missing-file' }],
    unidentified: [],
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

async function cleanupPane(t, locale, provider = {}) {
    const dom = new JSDOM('<div id="mktero-cache-status"></div><button id="mktero-clear-cache"></button>'
        + '<div id="mktero-cache-cleanup-status"></div><button id="mktero-cache-cleanup-retry"></button>');
    t.after(() => dom.window.close());
    const services = observerService();
    const localization = createLocalization({ zoteroLocale: locale });
    let statsCalls = 0;
    t.after(registerCacheCleanupStatusProvider(services, {
        getStatus: () => snapshot(),
        retry: () => assert.fail('unexpected cleanup retry'),
        ...provider,
    }));
    const controller = createPreferencesController({
        document: dom.window.document, services, zotero: { logError: assert.fail }, localization,
        cache: {
            getStats: async () => { statsCalls++; return { entries: 2, sizeBytes: 200 }; },
            clear: async () => assert.fail('checking again must not clear caches'),
        },
    });
    t.after(() => controller.destroy());
    await controller.init();
    await tick();
    return {
        dom, services, localization, controller, statsCalls: () => statsCalls,
        status: dom.window.document.getElementById('mktero-cache-cleanup-status'),
        retry: dom.window.document.getElementById('mktero-cache-cleanup-retry'),
    };
}

function observeCleanupMutations(t, pane) {
    const records = [];
    const observer = new pane.dom.window.MutationObserver(batch => records.push(...batch));
    for (const node of [pane.status, pane.retry]) {
        observer.observe(node, {
            childList: true, characterData: true, characterDataOldValue: true,
            attributes: true, subtree: true,
        });
    }
    t.after(() => observer.disconnect());
    return records;
}

test('cleanup events expose only bounded safe status fields and dispose observers', () => {
    const services = observerService();
    const values = [];
    const dispose = observeCacheCleanupStatus(services, value => values.push(value));
    publishCacheCleanupStatus(services, snapshot({
        path: '/private/file.pdf', hash: 'secret', exception: 'secret',
        released: 3,
        blockers: [...Array.from({ length: 12 }, (_, i) => ({
            itemID: i + 1, libraryID: 1, attachmentKey: 'MISSING1', reason: 'missing-file', path: 'secret',
        })), { itemID: 20, libraryID: 1, attachmentKey: '<img src=x>', reason: 'missing-file' }],
        unidentified: [...Array.from({ length: 12 }, (_, i) => ({
            itemID: i + 1, libraryID: 1, attachmentKey: 'MISSING1', reason: 'missing-file', path: 'secret',
        })), { itemID: 20, libraryID: 1, attachmentKey: '<img src=x>', reason: 'missing-file' }],
    }));
    assert.equal(values.length, 1);
    assert.equal(values[0].blockers.length, 10);
    assert.equal(values[0].unidentified.length, 10);
    assert.equal(values[0].released, 3);
    // A missing-file report is a warning, never a retained blocker, and carries
    // no path or content identifier.
    assert.deepEqual(values[0].unidentified[0], {
        itemID: 1, libraryID: 1, attachmentKey: 'MISSING1', reason: 'missing-file',
    });
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
    test(`preferences keep batched running cleanup text and DOM stable in ${locale}`, async t => {
        const pane = await cleanupPane(t, locale);
        const { status, retry, services } = pane;
        assert.ok(status.textContent.includes('MISSING1'));
        assert.equal(retry.disabled, false);
        const initialStatsCalls = pane.statsCalls();
        const runningText = locale === 'zh-CN'
            ? '正在检查缓存归属及共享引用…' : 'Checking cache ownership and shared references…';
        publishCacheCleanupStatus(services, snapshot({ state: 'running', nextRunAt: null }));
        await tick();
        assert.equal(status.textContent, runningText);
        assert.equal(status.getAttribute('aria-busy'), 'true');
        assert.equal(retry.disabled, true);
        const records = observeCleanupMutations(t, pane);
        for (let batch = 0; batch < 8; batch++) {
            publishCacheCleanupStatus(services, snapshot({
                state: 'running', checkedAt: 200 + batch,
                nextRunAt: batch % 2 === 0 ? 60000 + batch * 250 : null,
                removed: batch, ownersRemoved: batch + 1, referenced: batch + 2,
                busy: batch + 3, unknown: batch + 4, errors: batch,
                reasons: [{ code: 'missing-file', count: batch + 4 }],
                blockers: [{ itemID: batch + 20, libraryID: 2,
                    attachmentKey: `BATCH${String(batch).padStart(3, '0')}`, reason: 'missing-file' }],
            }));
            await tick();
            assert.equal(status.textContent, runningText, `batch ${batch} must keep the running message`);
            assert.equal(status.getAttribute('aria-busy'), 'true');
            assert.equal(retry.disabled, true);
            assert.deepEqual(records.map(record => ({
                type: record.type, target: record.target.id, attribute: record.attributeName,
            })), [], `batch ${batch} must not rewrite text or attributes`);
        }
        assert.equal(pane.statsCalls(), initialStatsCalls);
    });

    test(`preferences restore final cleanup reasons, next check, and retry after batches in ${locale}`, async t => {
        const pane = await cleanupPane(t, locale);
        const { status, retry, services, localization } = pane;
        const translate = (key, variables) => localization.t(`preferences.cache.cleanup.${key}`, variables);
        for (const nextRunAt of [null, 60250, null, 60750]) {
            publishCacheCleanupStatus(services, snapshot({ state: 'running', nextRunAt }));
            await tick();
        }
        const finalStatus = snapshot({
            checkedAt: Date.UTC(2026, 0, 2, 15), nextRunAt: Date.UTC(2026, 0, 2, 15, 4),
            removed: 2, ownersRemoved: 3, referenced: 4, busy: 5, unknown: 6, errors: 1,
            reasons: [{ code: 'changed-file', count: 6 }],
            blockers: [{ itemID: 11, libraryID: 2, attachmentKey: 'CHANGED1', reason: 'changed-file' }],
        });
        publishCacheCleanupStatus(services, finalStatus);
        await tick();
        const reason = translate('reason.changed-file');
        const time = new Intl.DateTimeFormat(locale, {
            dateStyle: 'medium', timeStyle: 'short',
        }).format(new Date(finalStatus.nextRunAt));
        for (const text of [
            translate('blocked'), translate('removed', finalStatus),
            translate('unknown', { count: 6 }), translate('referenced', { count: 4 }),
            translate('busy', { count: 5 }), translate('errors', { count: 1 }),
            translate('reasonCount', { reason, count: 6 }),
            translate('blocker', { key: 'CHANGED1', library: 2, reason }),
            translate('nextRun', { time }),
        ]) assert.ok(status.textContent.includes(text), `final status must show ${text}`);
        assert.equal(status.textContent.includes('MISSING1'), false);
        assert.equal(status.textContent.includes(translate('reason.missing-file')), false);
        assert.equal(status.getAttribute('aria-busy'), 'false');
        assert.equal(retry.disabled, false);
        const records = observeCleanupMutations(t, pane);
        const statsCalls = pane.statsCalls();
        publishCacheCleanupStatus(services, finalStatus);
        await tick();
        assert.equal(records.length, 0, 'repeated final status must not rewrite the DOM');
        assert.equal(pane.statsCalls(), statsCalls);
        publishCacheCleanupStatus(services, snapshot({
            state: 'complete', checkedAt: finalStatus.checkedAt + 1000, nextRunAt: null,
            removed: 7, ownersRemoved: 8, unknown: 0, reasons: [], blockers: [],
        }));
        await tick();
        assert.equal(status.textContent, [
            translate('complete'), translate('removed', { removed: 7, ownersRemoved: 8 }),
        ].join(' '));
        assert.equal(status.getAttribute('aria-busy'), 'false');
        assert.equal(retry.disabled, false);
    });

    test(`preferences report released rebuildable caches and unidentified missing PDFs in ${locale}`, async t => {
        const pane = await cleanupPane(t, locale);
        const { status, retry, services, localization } = pane;
        const translate = (key, variables) => localization.t(`preferences.cache.cleanup.${key}`, variables);
        publishCacheCleanupStatus(services, snapshot({
            state: 'complete', checkedAt: 500, nextRunAt: null,
            removed: 0, released: 2, ownersRemoved: 3, unknown: 0, referenced: 0, busy: 0, errors: 0,
            reasons: [], blockers: [],
            unidentified: [{ itemID: 42, libraryID: 4, attachmentKey: 'IGPWJHML', reason: 'missing-file' }],
        }));
        await tick();
        assert.ok(status.textContent.includes(translate('released', { count: 2 })));
        assert.ok(status.textContent.includes(translate('unidentified', {
            key: 'IGPWJHML', library: 4,
        })));
        // A missing PDF is a warning, not a retained-cache blocker.
        assert.equal(status.textContent.includes(translate('unknown', { count: 1 })), false);
        assert.equal(status.textContent.includes(translate('blocker', {
            key: 'IGPWJHML', library: 4, reason: translate('reason.missing-file'),
        })), false);
        assert.equal(status.getAttribute('aria-busy'), 'false');
        assert.equal(retry.disabled, false);
    });

    test(`preferences retry enters running without a transient waiting message in ${locale}`, async t => {
        let current = snapshot();
        let retries = 0;
        let finishRetry;
        const pendingRetry = new Promise(resolve => { finishRetry = resolve; });
        t.after(() => finishRetry());
        const pane = await cleanupPane(t, locale, {
            getStatus: () => current,
            retry: () => { retries++; return pendingRetry; },
        });
        const { status, retry, localization } = pane;
        const runningText = localization.t('preferences.cache.cleanup.running');
        const waitingText = localization.t('preferences.cache.cleanup.waiting');
        const statsCalls = pane.statsCalls();
        assert.ok(status.textContent.includes('MISSING1'));
        assert.equal(retry.disabled, false);
        const records = observeCleanupMutations(t, pane);
        retry.click();
        assert.equal(status.textContent, runningText);
        assert.equal(status.getAttribute('aria-busy'), 'true');
        assert.equal(retry.disabled, true);
        await tick();
        const messages = records.flatMap(record => {
            // Keep intermediate text nodes: waiting can be replaced by running
            // before MutationObserver delivers either mutation.
            if (record.type === 'childList') return Array.from(record.addedNodes, node => node.textContent);
            if (record.type === 'characterData') return [record.oldValue, record.target.textContent];
            return [];
        });
        assert.ok(messages.length > 0, 'observe the transition from blocked to running');
        assert.equal(messages.some(text => text?.includes(waitingText)), false,
            'retry must never render waiting, even within one event turn');
        retry.click();
        await tick();
        assert.equal(retries, 1);
        assert.equal(pane.statsCalls(), statsCalls);
        current = snapshot({
            state: 'complete', checkedAt: 300, nextRunAt: null, removed: 1,
            unknown: 0, reasons: [], blockers: [],
        });
        finishRetry();
        await tick();
        assert.ok(status.textContent.includes(localization.t('preferences.cache.cleanup.complete')));
        assert.equal(status.getAttribute('aria-busy'), 'false');
        assert.equal(retry.disabled, false);
        assert.equal(pane.statsCalls(), statsCalls + 1);
    });

    test(`destroyed preferences ignore later cleanup batches and stale callbacks in ${locale}`, async t => {
        let retries = 0;
        const pane = await cleanupPane(t, locale, { retry: () => { retries++; } });
        const { services, controller, status, retry } = pane;
        const staleObservers = [...services.observers.get(CACHE_CLEANUP_STATUS_TOPIC)];
        assert.equal(staleObservers.length, 1);
        const beforeDestroy = { text: status.textContent, busy: status.getAttribute('aria-busy'), disabled: retry.disabled };
        const statsCalls = pane.statsCalls();
        controller.destroy();
        const records = observeCleanupMutations(t, pane);
        for (const state of ['running', 'running', 'blocked', 'complete']) {
            const value = snapshot({ state, checkedAt: 400, nextRunAt: state === 'running' ? null : 90000 });
            publishCacheCleanupStatus(services, value);
            for (const observer of staleObservers) {
                observer.observe(null, CACHE_CLEANUP_STATUS_TOPIC, JSON.stringify(value));
            }
            await tick();
        }
        retry.click();
        await tick();
        assert.deepEqual({
            text: status.textContent, busy: status.getAttribute('aria-busy'), disabled: retry.disabled,
        }, beforeDestroy);
        assert.equal(records.length, 0);
        assert.equal(pane.statsCalls(), statsCalls);
        assert.equal(retries, 0);
        assert.equal(services.observers.get(CACHE_CLEANUP_STATUS_TOPIC).size, 0);
    });

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
