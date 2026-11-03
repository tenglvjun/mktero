import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { MkteroConversionClient } from '../src/mktero/mktero-conversion-client.js';
import { MkteroDocumentExtractor } from '../src/extractors/mktero-extractor.js';
import { createConversionBatch } from '../src/core/conversion-batch.js';
import { createPreferencesController } from '../src/ui/preferences.js';
import { localizeConversionError } from '../src/ui/provider-neutral-copy.js';
import { createZoteroConversionProgress } from '../src/platform/zotero-conversion-progress.js';
import { createLocalization } from '../src/i18n/localization.js';
import { notifyConversionQuotaChanged } from '../src/account/conversion-quota.js';

const changed = () => Object.assign(new Error('scope changed'), { code: 'MKTERO_QUOTA_ACCOUNT_CHANGED' });
const quotaError = () => Object.assign(new Error('quota'), { code: 'MKTERO_DAILY_SLOTS_RESERVED' });
const options = { apiBase: 'https://api.example', getAccessToken: () => 'token',
    fileName: 'a.pdf', fileData: new Uint8Array([1]) };
const flush = () => new Promise(resolve => setImmediate(resolve));

for (const refresh of [false, true]) {
    test(`stops an account switch during ${refresh ? '401 refresh' : 'token lookup'} before sending`, async () => {
        let current = true;
        let release;
        let fetchingToken;
        const tokenStarted = new Promise(resolve => { fetchingToken = resolve; });
        const token = new Promise(resolve => { release = resolve; });
        let sends = 0;
        const client = new MkteroConversionClient({ fetch: async () => {
            sends += 1;
            return new Response(JSON.stringify({ error: { code: 'invalid_token' } }), { status: 401 });
        } });
        const pending = assert.rejects(client.convert({ ...options,
            assertScope() { if (!current) throw changed(); },
            getAccessToken: async ({ forceRefresh = false } = {}) => {
                if (refresh && !forceRefresh) return 'first-token';
                fetchingToken();
                return token;
            },
        }), { code: 'MKTERO_QUOTA_ACCOUNT_CHANGED' });
        await tokenStarted;
        current = false;
        release('other-account-token');
        await pending;
        assert.equal(sends, refresh ? 1 : 0);
    });
}

test('does not start a hosted create after account switches during PDF reading', async () => {
    let current = true;
    let release;
    let sends = 0;
    const bytes = new Promise(resolve => { release = resolve; });
    const extractor = new MkteroDocumentExtractor({
        zotero: { Items: { getAsync: async () => ({
            isPDFAttachment: () => true, getFilePathAsync: async () => '/local.pdf',
            getDisplayTitle: () => 'Paper',
        }) } },
        readFile: () => bytes, getAccessToken: () => 'token', getApiBase: () => 'https://api.example',
        conversion: { convert() { sends += 1; } },
    });
    const pending = assert.rejects(extractor.extract(1, {
        assertScope() { if (!current) throw changed(); },
    }), { code: 'MKTERO_QUOTA_ACCOUNT_CHANGED' });
    await flush();
    current = false;
    release(new Uint8Array([1]));
    await pending;
    assert.equal(sends, 0);
});

for (const status of ['queued', 'submitting', 'processing', 'downloading']) {
    test(`polls replayed ${status} jobs without PUT or complete, keeps idempotency off storage`, async () => {
        const requests = [];
        const client = new MkteroConversionClient({
            sleep: async () => {}, extractMarkdownFromZip: () => ({ markdown: '# ready' }),
            fetch: async (url, init) => {
                requests.push({ url, init });
                if (url === 'https://storage.example/result') return new Response(new Uint8Array([1]));
                const body = url.endsWith('/conversions') ? { job_id: 'job', status }
                    : url.endsWith('/result-url') ? { result_url: 'https://storage.example/result' }
                        : { job_id: 'job', status: 'succeeded' };
                return new Response(JSON.stringify(body));
            },
        });
        await client.convert(options);
        assert.equal(requests.length, 4);
        assert.ok(requests[0].init.headers['Idempotency-Key']);
        assert.ok(requests.slice(1).every(request => request.init.headers['Idempotency-Key'] === undefined));
        assert.ok(requests.every(request => request.init.method !== 'PUT' && !request.url.endsWith('/complete')));
    });
}

test('different scope can explicitly reselect a paused item; blocked state persists', async () => {
    let scope = 'mktero:1';
    let reject;
    const calls = [];
    const batch = createConversionBatch({ concurrency: 1, getScope: () => scope,
        convert: item => {
            calls.push(item.scope);
            return scope === 'provider:mineru' ? Promise.resolve('BYOK')
                : new Promise((_resolve, fail) => { reject = fail; });
        },
    });
    batch.enqueue([{ itemID: 1 }, { itemID: 2 }]);
    reject(quotaError());
    await flush();
    assert.equal(batch.position(1).status, 'blocked');
    assert.equal(batch.position(2).status, 'paused');
    scope = 'provider:mineru';
    assert.equal(batch.isPreparing(1), false);
    batch.enqueue([{ itemID: 1 }]);
    assert.equal(await batch.wait(1), 'BYOK');
    assert.deepEqual(calls, ['mktero:1', 'provider:mineru']);
    assert.equal(batch.resume('mktero:1'), 0);
});

for (const provider of ['mineru', 'mistral']) {
    test(`switching providers releases queued ${provider} work without quota blocking`, async () => {
        let scope = `provider:${provider}`;
        let resolveFirst;
        const calls = [];
        const batch = createConversionBatch({ concurrency: 1, getScope: () => scope,
            convert: item => {
                calls.push(item.itemID);
                return item.itemID === 1 ? new Promise(resolve => { resolveFirst = resolve; })
                    : Promise.resolve(`${provider} ready`);
            },
        });
        batch.enqueue([{ itemID: 1 }, { itemID: 2 }]);
        const queued = assert.rejects(batch.wait(2), { name: 'AbortError' });
        scope = 'mktero:1';
        resolveFirst('first ready');
        await queued;
        await flush();
        assert.deepEqual(calls, [1]);
        assert.equal(batch.pausedScope(`provider:${provider}`), null);
        scope = `provider:${provider}`;
        batch.enqueue([{ itemID: 2 }]);
        assert.equal(await batch.wait(2), `${provider} ready`);
        assert.deepEqual(calls, [1, 2]);
    });
}

test('single quota rejection after cancelling the pending list restores the resume controls', async () => {
    const source = await readFile(new URL('../src/bootstrap.js', import.meta.url), 'utf8');
    const handleSource = source.slice(source.indexOf('function handleBatchEvent(event)'),
        source.indexOf('\nfunction updateProgressRow', source.indexOf('function handleBatchEvent(event)')));
    const calls = [];
    const context = vm.createContext({
        runtime: { conversionProgress: {
            setPaused: value => calls.push(['pause', value]),
            setStatus: value => calls.push(['status', value]),
            open: () => calls.push(['open']), add() {},
        } },
        currentConversionScope: () => 'mktero:1', runtimeTranslate: key => key,
        ensureConversionProgress() {}, userFacingError: () => 'quota',
        updateProgressRow() {}, clearConversionActivity() {}, notifyBatchItem() {},
        conversionNeedsSettings: () => false, openMinerUPreferences() {},
    });
    vm.runInContext(`${handleSource}\nthis.handle = handleBatchEvent`, context);
    context.handle({ type: 'blocked', item: { itemID: 7, title: 'Single PDF' }, error: quotaError() });
    assert.deepEqual(calls, [['pause', true], ['status', 'quota'], ['open']]);
});

test('old account quota events do not pause the new account UI or open settings', async () => {
    const source = await readFile(new URL('../src/bootstrap.js', import.meta.url), 'utf8');
    const handleSource = source.slice(source.indexOf('function handleBatchEvent(event)'),
        source.indexOf('\nfunction updateProgressRow', source.indexOf('function handleBatchEvent(event)')));
    const calls = [];
    const context = vm.createContext({
        runtime: { conversionProgress: {
            setPaused: value => calls.push(['pause', value]), setStatus: value => calls.push(['status', value]),
            add() {}, open: () => calls.push(['open']),
        } },
        currentConversionScope: () => 'mktero:2', runtimeTranslate: key => key,
        ensureConversionProgress() {},
        userFacingError: () => 'quota', updateProgressRow: () => calls.push(['row']),
        clearConversionActivity() {}, notifyBatchItem() {},
        conversionNeedsSettings: () => false, openMinerUPreferences: () => calls.push(['settings']),
    });
    vm.runInContext(`${handleSource}\nthis.handle = handleBatchEvent`, context);
    context.handle({ type: 'quota-blocked', scope: 'mktero:1', error: quotaError() });
    assert.equal(calls.length, 0);
    context.handle({ type: 'blocked', item: { itemID: 1, title: 'Paper' }, error: quotaError() });
    assert.deepEqual(calls, [['pause', true], ['status', 'quota'], ['open'], ['row']]);
    context.handle({ type: 'quota-blocked', scope: 'mktero:2', error: quotaError() });
    assert.deepEqual(calls.slice(4), [['pause', true], ['status', 'quota'], ['open']]);
});

async function quotaPane(t, { status = 200, mode = 'enforce', delay = null } = {}) {
    const dom = new JSDOM('<body><span id="mktero-cache-status"></span><button id="mktero-clear-cache"></button><p id="mktero-account-quota"></p></body>');
    const prefs = new Map([
        ['extensions.mktero.accountEmail', 'a@example.test'], ['extensions.mktero.accountAccessToken', 'token'],
        ['extensions.mktero.accountRefreshToken', 'refresh'], ['extensions.mktero.accountAccessExpiresAtMs', String(Date.now() + 3600_000)],
    ]);
    const observers = new Map();
    const services = { obs: {
        addObserver(observer, topic) { observers.set(topic, observer); },
        removeObserver(_observer, topic) { observers.delete(topic); },
        notifyObservers(_subject, topic) { observers.get(topic)?.observe(null, topic); },
    } };
    let requests = 0;
    const controller = createPreferencesController({ document: dom.window.document, services,
        localization: createLocalization({ zoteroLocale: 'zh-CN' }),
        zotero: { Prefs: { get: key => prefs.get(key), set: (key, value) => prefs.set(key, value) } },
        cache: { getStats: async () => ({ entries: 0 }), clear: async () => {} },
        accountFetch: async url => {
            if (!url.endsWith('/conversion-quota')) return { ok: false, status: 404, json: async () => ({}) };
            requests += 1;
            if (delay) await delay;
            return { ok: status === 200, status, json: async () => ({ mode, limit: 30,
                used: 28, reserved: 2, remaining: 0,
                reset_at: '2026-11-03T00:00:00Z', server_time: '2026-11-02T12:00:00Z',
            }) };
        },
    });
    t.after(() => { controller.destroy(); dom.window.close(); });
    const loaded = controller.start();
    return { controller, loaded, services, prefs, observers, requests: () => requests,
        row: dom.window.document.getElementById('mktero-account-quota') };
}

test('quota pane renders dynamic values and coalesces conversion completion refreshes', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pane = await quotaPane(t);
    await pane.loaded;
    assert.match(pane.row.textContent, /28\/30/);
    assert.match(pane.row.textContent, /处理中 2/);
    for (let i = 0; i < 3; i++) notifyConversionQuotaChanged(pane.services);
    assert.equal(pane.requests(), 1);
    t.mock.timers.tick(150);
    await flush();
    assert.equal(pane.requests(), 2);
    pane.controller.destroy();
    assert.equal(pane.observers.size, 0);
});

test('old server 404 leaves session intact, hides quota and stops background quota queries', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pane = await quotaPane(t, { status: 404 });
    await pane.loaded;
    assert.equal(pane.row.hidden, true);
    assert.equal(pane.prefs.get('extensions.mktero.accountRefreshToken'), 'refresh');
    notifyConversionQuotaChanged(pane.services);
    t.mock.timers.tick(150);
    await flush();
    assert.equal(pane.requests(), 1);
});

test('shadow quota is informational and stale account responses are discarded', async t => {
    const pane = await quotaPane(t, { mode: 'shadow' });
    await pane.loaded;
    assert.match(pane.row.textContent, /仅观察，不限制/);
    let release;
    const delayed = await quotaPane(t, { delay: new Promise(resolve => { release = resolve; }) });
    await flush();
    delayed.prefs.set('extensions.mktero.accountEmail', 'b@example.test');
    release();
    await delayed.loaded;
    assert.equal(delayed.row.hidden, true);
    assert.equal(delayed.row.textContent, '');
});

test('a single quota rejection creates a resumable blocked entry and cancel does not unpause new work', async () => {
    const batch = createConversionBatch({ getScope: () => 'mktero:1', convert: async () => 'ready' });
    batch.blockScope(quotaError(), 'mktero:1', { itemID: 1, title: 'single' });
    assert.equal(batch.position(1).status, 'blocked');
    await assert.rejects(batch.wait(1), { code: 'MKTERO_QUOTA_PAUSED' });
    batch.cancelRemaining();
    batch.enqueue([{ itemID: 2 }]);
    assert.equal(batch.position(2).status, 'paused');
    assert.equal(batch.resume(), 1);
    assert.equal(await batch.wait(2), 'ready');
});

test('malformed quota details never print unsafe numbers or invalid reset times', () => {
    const error = Object.assign(quotaError(), { quota: {
        mode: 'enforce', limit: 30, used: NaN, reserved: 2, remaining: 0,
        resetAt: 'not a date', serverTime: 'not a date',
    } });
    const message = localizeConversionError(error);
    assert.match(message, /quota is unavailable/);
    assert.doesNotMatch(message, /NaN|Invalid Date/);
});

test('legacy complete quota rejection is recognized and does not retry the PDF upload', async () => {
    const requests = [];
    const client = new MkteroConversionClient({ fetch: async (url, init) => {
        requests.push({ url, init });
        if (url.endsWith('/conversions')) return new Response(JSON.stringify({
            job_id: 'job', status: 'awaiting_upload', upload_url: 'https://storage.example/upload',
        }));
        assert.equal(init.headers['Idempotency-Key'], undefined);
        if (init.method === 'PUT') return new Response('');
        if (url.endsWith('/complete')) return new Response(JSON.stringify({
            error: { code: 'conversion_daily_slots_reserved' },
        }), { status: 429 });
        return new Response('{}', { status: 409 });
    } });
    await assert.rejects(client.convert(options), { code: 'MKTERO_DAILY_SLOTS_RESERVED' });
    await flush();
    assert.equal(requests.filter(request => request.init.method === 'PUT').length, 1);
    assert.equal(requests.filter(request => request.url.endsWith('/complete')).length, 1);
});

test('progress dialog exposes pause actions after delayed opening and removes them on disposal', () => {
    const dom = new JSDOM('<body><div id="progress-queue-root"></div></body>');
    const win = dom.window;
    win.arguments = [{ progressQueue: { getID: () => 'mktero-prepare' } }];
    let visible = false;
    let resumed = 0;
    let cancelled = 0;
    const scheduled = [];
    const queue = { addListener() {}, removeListener() {}, getDialog: () => ({ open() {} }) };
    const progress = createZoteroConversionProgress({
        zotero: { ProgressQueue: { ROW_QUEUED: 1 }, ProgressQueues: { get: () => queue, create: () => queue } },
        services: { wm: { getEnumerator() { let remains = visible; return {
            hasMoreElements: () => remains, getNext: () => { remains = false; return win; },
        }; } } },
        schedule: callback => scheduled.push(callback), onResume: () => { resumed += 1; },
        onCancelRemaining: () => { cancelled += 1; },
    });
    progress.setPaused(true);
    progress.open();
    visible = true;
    scheduled.shift()();
    const resume = win.document.getElementById('mktero-quota-resume');
    const cancel = win.document.getElementById('mktero-quota-cancel-remaining');
    assert.equal(resume.hidden, false);
    resume.dispatchEvent(new win.Event('command'));
    cancel.dispatchEvent(new win.Event('command'));
    assert.equal(resumed, 1);
    assert.equal(cancelled, 1);
    progress.dispose();
    assert.equal(win.document.getElementById('mktero-quota-resume'), null);
    dom.window.close();
});

// A zero remaining balance blocks new documents only. Resuming must still lift
// the account pause, because an item this account already converted is admitted
// without consuming quota. The server re-pauses the scope on a real refusal.
test('resume lifts the account pause even when the remaining balance is zero', async () => {
    const source = await readFile(new URL('../src/bootstrap.js', import.meta.url), 'utf8');
    const resumeSource = source.slice(source.indexOf('async function resumeQuotaBatch()'),
        source.indexOf('\nfunction ensureConversionProgress',
            source.indexOf('async function resumeQuotaBatch()')));
    const calls = [];
    const quota = { mode: 'enforce', limit: 1, used: 1, reserved: 0, remaining: 0 };
    // Mirrors the real batch: resume() clears the scope, so pausedScope() then
    // returns null and the progress row is unpaused.
    let paused = quotaError();
    const context = vm.createContext({
        runtime: {
            conversionProgress: {
                setPaused: value => calls.push(['pause', value]),
                setStatus: value => calls.push(['status', value]),
            },
            conversionBatch: {
                pausedScope: () => paused,
                resume: () => { calls.push(['resume']); paused = null; return 2; },
            },
        },
        currentConversionScope: () => 'mktero:1',
        runtimeTranslate: (key, params) => `${key}:${params?.count ?? ''}`,
        ensureAccountAccessToken: async () => 'token',
        getAccountApiBase: () => 'https://api.example',
        getMkteroConversionQuota: async () => quota,
        createWindowFetch: () => async () => new Response('{}'),
        liveZoteroWindow: () => null,
        Zotero: {},
        userFacingError: () => 'quota-error',
    });
    vm.runInContext(`${resumeSource}\nthis.resume = resumeQuotaBatch`, context);
    await context.resume();
    assert.deepEqual(calls, [
        ['resume'],
        ['pause', false],
        ['status', 'batch.quotaResumeWithoutCapacity:2'],
    ]);
});

test('resume refuses to lift the pause when the quota snapshot is unavailable', async () => {
    const source = await readFile(new URL('../src/bootstrap.js', import.meta.url), 'utf8');
    const resumeSource = source.slice(source.indexOf('async function resumeQuotaBatch()'),
        source.indexOf('\nfunction ensureConversionProgress',
            source.indexOf('async function resumeQuotaBatch()')));
    const calls = [];
    const context = vm.createContext({
        runtime: {
            conversionProgress: {
                setPaused: value => calls.push(['pause', value]),
                setStatus: value => calls.push(['status', value]),
            },
            conversionBatch: {
                pausedScope: () => quotaError(),
                resume: () => { calls.push(['resume']); return 0; },
            },
        },
        currentConversionScope: () => 'mktero:1',
        runtimeTranslate: key => key,
        ensureAccountAccessToken: async () => 'token',
        getAccountApiBase: () => 'https://api.example',
        getMkteroConversionQuota: async () => null,
        createWindowFetch: () => async () => new Response('{}'),
        liveZoteroWindow: () => null,
        Zotero: {},
        userFacingError: () => 'quota-error',
    });
    vm.runInContext(`${resumeSource}\nthis.resume = resumeQuotaBatch`, context);
    await context.resume();
    assert.deepEqual(calls, [['status', 'error.mkteroQuotaUnavailable']]);
});
