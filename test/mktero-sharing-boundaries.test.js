import test from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { sha256Hex } from '../src/core/sha256.js';
import { MarkdownDocumentService } from '../src/core/markdown-document-service.js';
import { createConversionRunRegistry } from '../src/core/conversion-runs.js';
import { MkteroDocumentExtractor } from '../src/extractors/mktero-extractor.js';
import { MkteroConversionClient } from '../src/mktero/mktero-conversion-client.js';
import { SharedMkteroConversion } from '../src/mktero/shared-conversion.js';
import { createHostedConversionScope } from '../src/mktero/conversion-scope.js';
import { saveAccountSession, clearAccountSession } from '../src/config/account-preferences.js';

function deferred() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}
const PDF = strToU8('%PDF-1.7 synthetic content');
function json(status, body) {
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null },
        arrayBuffer: async () => strToU8(JSON.stringify(body)).buffer };
}
function memoryStore({ fail = false } = {}) {
    const records = new Map();
    return { records, reads: 0, writes: 0,
        async get(key) { this.reads++; return records.get(key) || null; },
        async put(key, record, { canCommit = () => true } = {}) {
            this.writes++;
            if (fail) throw new Error('disk full');
            if (canCommit()) records.set(key, record);
        },
        async delete(key) { records.delete(key); },
    };
}

function harness({ cacheEnabled = false, failCache = false,
    prepareResult = async raw => raw, recoverFigures = async raw => raw,
    readFile = async () => PDF,
    getToken = async () => 'access-token', beforeCreate = () => {},
    scopeProvider = null, unauthorizedFirstCreate = false } = {}) {
    const finish = deferred();
    const polling = deferred();
    const requests = [];
    const rawStore = memoryStore({ fail: failCache });
    const cache = memoryStore({ fail: failCache });
    const archive = zipSync({ 'full.md': strToU8('# Shared paper\n\nBody text.') });
    let scope = 's1';
    let creates = 0;
    const client = new MkteroConversionClient({
        sleep: async () => { polling.resolve(); await finish.promise; },
        fetch: async (url, request) => {
            requests.push({ url, ...request });
            // The client resolves the parse target before creating a job. These
            // scenarios exercise sharing, so the route answers the shipped vlm
            // target and the job echoes that same snapshot.
            if (request.method === 'POST' && url.endsWith('/conversions/resolve')) {
                return json(200, {
                    route_id: 'route-shared',
                    model_version: 'vlm',
                    parser_profile_id: 'mineru/v4-batch-vlm-1',
                });
            }
            if (request.method === 'POST' && url.endsWith('/conversions')) {
                const jobID = `job-${++creates}`;
                if (unauthorizedFirstCreate && creates === 1) {
                    return json(401, { error: { code: 'invalid_token' } });
                }
                return json(201, { job_id: jobID, status: 'awaiting_upload',
                    upload_url: `https://storage.example.test/upload/${jobID}`, upload_method: 'PUT',
                    model_version: 'vlm', parser_profile_id: 'mineru/v4-batch-vlm-1' });
            }
            if (request.method === 'PUT') return json(200, {});
            if (request.method === 'DELETE') return json(409, { error: { code: 'conflict' } });
            if (url.endsWith('/complete')) return json(202, { status: 'processing' });
            if (url.endsWith('/result-url')) return json(200, { result_url: 'https://storage.example.test/result.zip' });
            if (url.endsWith('/result.zip')) return { ok: true, status: 200,
                headers: { get: () => null }, arrayBuffer: async () => archive.slice().buffer };
            return json(200, {
                job_id: url.split('/').pop(), status: 'succeeded',
                model_version: 'vlm', parser_profile_id: 'mineru/v4-batch-vlm-1',
            });
        },
    });
    const getScope = () => scopeProvider?.current() ?? scope;
    const shared = new SharedMkteroConversion({ conversion: client, getScope,
        resultStore: rawStore });
    const extractor = new MkteroDocumentExtractor({
        zotero: { Items: { getAsync: async id => ({ id, isPDFAttachment: () => true,
            attachmentFilename: `${id}.pdf`, getDisplayTitle: () => `Paper ${id}`,
            getFilePathAsync: async () => `/pdf/${id}.pdf` }) } },
        conversion: client, sharedConversion: shared, getSharedScope: getScope,
        getApiBase: () => 'https://api.example.test', getAccessToken: getToken,
        readFile, createSourceHash: sha256Hex, createCacheKey: sha256Hex,
        createResultKey: async (_data, { sourceHash }) => sourceHash,
        isCacheEnabled: () => cacheEnabled, resultStore: rawStore, cache,
        prepareResult, recoverFigures,
    });
    const service = new MarkdownDocumentService({ extractor });
    return { shared, extractor, service, finish, polling, requests, rawStore, cache,
        run: (itemID, options = {}) => service.convert(itemID, { sharedScope: getScope(), beforeCreate, ...options }),
        changeScope() { scope = 's2'; shared.invalidateScope(); },
        get creates() { return creates; },
        deletes: () => requests.filter(request => request.method === 'DELETE'),
    };
}

async function joinSecond(h, options = {}) {
    const joined = deferred();
    const result = h.run(2, { ...options, onProgress: () => joined.resolve() });
    await joined.promise;
    return { result };
}

test('two attachment IDs share the real hosted pipeline and retain their own titles', async t => {
    const h = harness();
    t.after(() => h.shared.dispose());
    const a = h.run(1);
    await h.polling.promise;
    const b = await joinSecond(h);
    assert.equal(h.creates, 1);
    h.finish.resolve();
    const [left, right] = await Promise.all([a, b.result]);
    assert.equal(left.itemID, 1);
    assert.equal(right.itemID, 2);
    assert.equal(left.title, 'Paper 1');
    assert.equal(right.title, 'Paper 2');
    assert.equal(h.requests.filter(request => request.method === 'PUT').length, 1);
    assert.equal(h.requests.filter(request => request.url.endsWith('/result.zip')).length, 1);
    assert.equal(h.requests.filter(request => /\/conversions\/job-\d+$/.test(request.url)
        && request.method === 'GET').length, 1);
    assert.equal(h.deletes().length, 0);
});

test('cancelling the initiating attachment does not DELETE a shared real job', async t => {
    const h = harness();
    t.after(() => h.shared.dispose());
    const controller = new AbortController();
    const a = h.run(1, { signal: controller.signal });
    const cancelled = assert.rejects(a, { name: 'AbortError' });
    await h.polling.promise;
    const b = await joinSecond(h);
    controller.abort();
    await cancelled;
    assert.equal(h.deletes().length, 0);
    h.finish.resolve();
    await b.result;
    assert.equal(h.creates, 1);
    assert.equal(h.deletes().length, 0);
});

test('the last participant cancels a known real job once with an independent signal', async () => {
    const h = harness();
    const controller = new AbortController();
    const a = h.run(1, { signal: controller.signal });
    const cancelled = assert.rejects(a, { name: 'AbortError' });
    await h.polling.promise;
    controller.abort(); controller.abort();
    await cancelled;
    await h.shared.dispose();
    assert.equal(h.deletes().length, 1);
    assert.notEqual(h.deletes()[0].signal, controller.signal);
    assert.equal(h.deletes()[0].signal.aborted, false);
});

test('raw persistence happens once and a later attachment avoids a new job', async t => {
    const h = harness({ cacheEnabled: true });
    t.after(() => h.shared.dispose());
    const a = h.run(1);
    await h.polling.promise;
    const b = await joinSecond(h);
    h.finish.resolve();
    await Promise.all([a, b.result]);
    assert.equal(h.rawStore.writes, 1);
    h.cache.records.clear();
    await h.run(3);
    assert.equal(h.creates, 1);
});

test('both cache writes failing still permits late join during attachment processing', async t => {
    const local = deferred();
    const processing = deferred();
    const bothProcessing = deferred();
    let prepared = 0;
    const h = harness({ cacheEnabled: true, failCache: true,
        prepareResult: async raw => {
            processing.resolve();
            if (++prepared === 2) bothProcessing.resolve();
            await local.promise;
            return raw;
        } });
    t.after(() => h.shared.dispose());
    const a = h.run(1);
    await h.polling.promise;
    h.finish.resolve();
    await processing.promise;
    const b = h.run(2);
    await bothProcessing.promise;
    // Both callers can finish from the retained ready generation even though
    // there is no durable result to find on disk.
    local.resolve();
    await Promise.all([a, b]);
    assert.equal(h.creates, 1);
});

test('a local preparation failure does not fail another attachment or DELETE the job', async t => {
    let prepared = 0;
    const h = harness({ prepareResult: async raw => {
        if (++prepared === 1) throw new Error('local processing failed');
        return raw;
    } });
    t.after(() => h.shared.dispose());
    const a = h.run(1);
    const failed = assert.rejects(a, /local processing failed/);
    await h.polling.promise;
    const b = await joinSecond(h);
    h.finish.resolve();
    await failed;
    assert.equal((await b.result).title, 'Paper 2');
    assert.equal(h.creates, 1);
    assert.equal(h.deletes().length, 0);
});

test('a force replacement reserves the real job before slow file reading', async t => {
    const read = deferred();
    const reading = deferred();
    let reads = 0;
    const h = harness({ readFile: async () => {
        if (++reads > 1) { reading.resolve(); await read.promise; }
        return PDF;
    } });
    t.after(() => h.shared.dispose());
    const runs = createConversionRunRegistry({
        createController: () => new AbortController(),
        beforeReplace: (old, next) => h.shared.reserveReplacement(old, next),
        onSettled: signal => h.shared.releaseRun(signal),
        execute: (itemID, options) => h.run(itemID, { ...options, retainSharedLease: true }),
    });
    const first = runs.begin({ itemID: 1, owner: 'tab' });
    const rejected = assert.rejects(first.run.promise, { code: 'MKTERO_CONVERSION_REPLACED' });
    await h.polling.promise;
    const replacement = runs.begin({ itemID: 1, owner: 'tab', forceRefresh: true });
    await reading.promise;
    await rejected;
    assert.equal(h.deletes().length, 0);
    assert.equal(h.creates, 1);
    read.resolve(); h.finish.resolve();
    await replacement.run.promise;
    assert.equal(h.creates, 1);
    assert.equal(h.deletes().length, 0);
});

test('an older attachment finishing after forced refresh cannot overwrite the new derived cache', async t => {
    const processing = deferred();
    const finishOld = deferred();
    let prepared = 0;
    const h = harness({ cacheEnabled: true, prepareResult: async raw => {
        const generation = ++prepared;
        if (generation === 1) { processing.resolve(); await finishOld.promise; }
        return { ...raw, markdown: generation === 1 ? '# Old' : '# Fresh' };
    } });
    t.after(() => h.shared.dispose());
    const old = h.run(1);
    await h.polling.promise;
    h.finish.resolve();
    await processing.promise;
    const fresh = await h.run(2, { forceRefresh: true });
    assert.equal(fresh.markdown, '# Fresh');
    finishOld.resolve();
    assert.equal((await old).markdown, '# Old');
    assert.equal(h.creates, 2);
    assert.equal(h.cache.writes, 1);
    assert.equal([...h.cache.records.values()][0].markdown, '# Fresh');
});

for (const origin of ['derived', 'raw']) {
    test(`an older ${origin} cache restoration cannot overwrite a parallel forced conversion`, async t => {
        const restoring = deferred();
        const restored = deferred();
        let recoveries = 0;
        const h = harness({ cacheEnabled: true, recoverFigures: async raw => {
            if (++recoveries === 1) {
                restoring.resolve();
                await restored.promise;
                return { ...raw, markdown: '# Recovered old' };
            }
            return { ...raw, markdown: '# Fresh' };
        } });
        t.after(() => h.shared.dispose());
        const key = await sha256Hex(PDF);
        if (origin === 'derived') h.cache.records.set(key, { markdown: '# Cached' });
        else h.rawStore.records.set(key, {
            archive: zipSync({ 'full.md': strToU8('# Cached raw') }),
        });
        const old = origin === 'derived' ? h.run(1) : h.extractor.readCached(1);
        await restoring.promise;
        const fresh = h.run(2, { forceRefresh: true });
        await h.polling.promise;
        h.finish.resolve();
        assert.equal((await fresh).markdown, '# Fresh');
        restored.resolve();
        assert.equal((await old).markdown, '# Recovered old');
        assert.equal(h.creates, 1);
        assert.equal(h.cache.writes, 1);
        assert.equal(h.cache.records.get(key).markdown, '# Fresh');
    });
}

test('joining an existing job does not perform a new quota admission check', async t => {
    let blocked = false;
    let admissions = 0;
    const h = harness({ beforeCreate() {
        admissions++;
        if (blocked) throw Object.assign(new Error('quota paused'), { code: 'MKTERO_DAILY_SLOTS_RESERVED' });
    } });
    t.after(() => h.shared.dispose());
    const a = h.run(1);
    await h.polling.promise;
    blocked = true;
    const b = await joinSecond(h);
    h.finish.resolve();
    await Promise.all([a, b.result]);
    assert.equal(admissions, 1);
    await assert.rejects(h.run(3, { forceRefresh: true }), { code: 'MKTERO_DAILY_SLOTS_RESERVED' });
    assert.equal(h.creates, 1);
});

test('switching scope during token lookup cannot send using the new account token', async () => {
    const token = deferred();
    const lookup = deferred();
    const h = harness({ getToken: async () => { lookup.resolve(); return token.promise; } });
    const a = h.run(1);
    const rejected = assert.rejects(a, { code: 'MKTERO_QUOTA_ACCOUNT_CHANGED' });
    await lookup.promise;
    h.changeScope();
    token.resolve('new-account-token');
    await rejected;
    await h.shared.dispose();
    // The resolve lookup is the only request that may have been attempted: no
    // job was created and no PDF bytes were sent.
    assert.equal(h.creates, 0);
    assert.equal(h.requests.filter(request => request.method === 'PUT').length, 0);
});

test('a scope change after job creation cannot DELETE through the later account', async () => {
    let tokens = 0;
    const h = harness({ getToken: () => { tokens++; return 'initial-token'; } });
    const a = h.run(1);
    const rejected = assert.rejects(a, { code: 'MKTERO_QUOTA_ACCOUNT_CHANGED' });
    await h.polling.promise;
    const before = tokens;
    h.changeScope();
    await rejected;
    await h.shared.dispose();
    assert.equal(h.creates, 1);
    assert.equal(tokens, before);
    assert.equal(h.deletes().length, 0);
});

const session = { email: 'person@example.test', accessToken: 'initial-token',
    refreshToken: 'initial-refresh', accessExpiresAt: Date.now() + 3600000 };
function sessionPreferences() {
    const values = new Map();
    const zotero = { Prefs: {
        get: key => values.get(key),
        set: (key, value) => values.set(key, value),
    } };
    saveAccountSession(zotero, session);
    return zotero;
}

for (const [label, change] of [
    ['account', zotero => saveAccountSession(zotero, { ...session, email: 'other@example.test' })],
    ['API address', zotero => zotero.Prefs.set('extensions.mktero.accountApiBase', 'https://other.example.test')],
    ['provider', zotero => zotero.Prefs.set('extensions.mktero.conversionProvider', 'mineru')],
    ['same-email logout and login', zotero => { clearAccountSession(zotero); saveAccountSession(zotero, session); }],
]) {
    test(`${label} change during a real 401 refresh prevents replay with another session`, async t => {
        const zotero = sessionPreferences();
        const refreshing = deferred();
        const token = deferred();
        let h;
        const scopeProvider = createHostedConversionScope({ zotero,
            onChange: () => h.shared.invalidateScope() });
        h = harness({ scopeProvider, unauthorizedFirstCreate: true,
            getToken: async options => {
                if (!options?.forceRefresh) return 'initial-token';
                refreshing.resolve();
                return token.promise;
            } });
        t.after(async () => { await h.shared.dispose(); scopeProvider.dispose(); });
        const a = h.run(1);
        const rejected = assert.rejects(a, { code: 'MKTERO_QUOTA_ACCOUNT_CHANGED' });
        await refreshing.promise;
        change(zotero);
        token.resolve('later-session-token');
        await rejected;
        assert.equal(h.creates, 1);
        assert.equal(h.deletes().length, 0);
        // Exactly one job was created, before the session changed; the resolve
        // lookup that preceded it is not a session for the new account.
        assert.equal(h.requests.filter(request => request.method === 'POST'
            && request.url.endsWith('/conversions')).length, 1);
        assert.equal(h.requests.filter(request => request.method === 'PUT').length, 0);
    });
}

test('automatic token refresh retains the shared job and replays the exact create identity', async t => {
    const zotero = sessionPreferences();
    let h;
    const scopeProvider = createHostedConversionScope({ zotero,
        onChange: () => h.shared.invalidateScope() });
    const originalScope = scopeProvider.current();
    h = harness({ scopeProvider, unauthorizedFirstCreate: true,
        getToken: async options => {
            if (!options?.forceRefresh) return 'initial-token';
            saveAccountSession(zotero, { ...session, accessToken: 'rotated-token',
                refreshToken: 'rotated-refresh' }, { preserveEpoch: true });
            return 'rotated-token';
        } });
    t.after(async () => { await h.shared.dispose(); scopeProvider.dispose(); });
    const a = h.run(1);
    await h.polling.promise;
    const b = await joinSecond(h);
    h.finish.resolve();
    await Promise.all([a, b.result]);
    const posts = h.requests.filter(request => request.url.endsWith('/conversions'));
    assert.equal(posts.length, 2);
    assert.equal(posts[0].body, posts[1].body);
    assert.equal(posts[0].headers['Idempotency-Key'], posts[1].headers['Idempotency-Key']);
    assert.equal(scopeProvider.current(), originalScope);
    assert.equal(h.requests.filter(request => request.method === 'PUT').length, 1);
});

test('local-only reading looks up a target but never starts or joins a conversion', async t => {
    const h = harness();
    t.after(() => h.shared.dispose());
    assert.equal(await h.extractor.readCached(1), null);
    // Reading asks which model the paper follows, which sends only the digest.
    // It never creates a job, uploads the PDF, or downloads a result.
    assert.equal(h.creates, 0);
    assert.equal(h.requests.filter(request => request.method === 'PUT').length, 0);
    assert.equal(h.requests.filter(request => request.url.endsWith('/result-url')).length, 0);
    const resolve = h.requests.filter(request => request.url.endsWith('/conversions/resolve'));
    assert.equal(resolve.length, 1);
    assert.equal(JSON.parse(resolve[0].body).sha256, await sha256Hex(PDF));
});
