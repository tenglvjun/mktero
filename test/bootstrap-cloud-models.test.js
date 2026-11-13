import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { JSDOM } from 'jsdom';
import { strToU8, zipSync } from 'fflate';
import { MarkdownDocumentService } from '../src/core/markdown-document-service.js';
import { createMarkdownCacheKey } from '../src/cache/markdown-cache.js';
import { createMinerUResultKey } from '../src/cache/mineru-result-store.js';
import { mineruCloudProfilesFor, MINERU_PARSER_PROFILE_ID } from '../src/mineru/parser-profile.js';

const MINERU_API = 'https://mineru.net/api/v4';
const API_BASE = 'http://127.0.0.1:8080';
const PDF_TEXT = 'Ovulation limits (±2 days)';
const PIPELINE = mineruCloudProfilesFor('pipeline');
let importSerial = 0;

// A real bootstrap run owns process globals, so each scenario imports it once.
test('direct MinerU cloud keeps the model a conversion started with and reads it back from cache', {
    timeout: 60_000,
}, async t => {
    const h = await createHarness(t, {
        prefs: {
            'extensions.mktero.conversionProvider': 'mineru',
            'extensions.mktero.mineruEndpoint': 'cloud',
            'extensions.mktero.mineruCloudModelVersion': 'pipeline',
            'extensions.mktero.mineruApiKey': 'cloud-fixture-token',
        },
    });
    const keys = await cacheKeys(h.pdfData);

    h.open(42);
    const shadow = await h.shadow('tab-1');
    // The preference flips while the batch is still running. A pipeline task
    // was already accepted, so it must finish, cache, and become ready as
    // pipeline; the VLM identity must not claim that pipeline cache key.
    await h.waitForSubmission();
    h.prefs.set('extensions.mktero.mineruCloudModelVersion', 'vlm');
    h.finish();
    await readyText(shadow, 'Parsed with pipeline');
    await h.waitForResult(42);

    assert.deepEqual(h.submissions, ['pipeline']);
    assert.equal(h.uploads.length, 1);
    const result = h.completed.get(42);
    assert.equal(result.cacheHit, false);
    assert.equal(result.parserProfile, PIPELINE.cacheProfile);
    assert.equal(result.cacheKey, keys.pipeline.markdown);
    assert.notEqual(result.cacheKey, keys.vlm.markdown);
    assert.ok(result.markdown.includes(PDF_TEXT));

    // Only the pipeline identities exist on disk: Markdown, raw ZIP, readiness.
    assert.equal(await h.hasMarkdown(keys.pipeline.markdown), true);
    assert.equal(await h.hasMarkdown(keys.vlm.markdown), false);
    assert.equal(await h.hasRaw(keys.pipeline.raw), true);
    assert.equal(await h.hasRaw(keys.vlm.raw), false);
    // Readiness is written asynchronously after the result is published.
    const records = await waitFor(async () => {
        const current = await h.readinessRecords();
        return current.length ? current : null;
    }, 'the pipeline readiness record');
    assert.ok(records.every(record => record.parserProfile === PIPELINE.cacheProfile));
    assert.ok(records.some(record => record.cacheKey === keys.pipeline.markdown));
    assert.equal(records.some(record => record.cacheKey === keys.vlm.markdown), false);
    // Readiness follows the selected model, so the VLM profile stays empty even
    // though a pipeline document for this attachment is cached.
    await h.waitForReadiness('', 'the VLM profile to stay unready');
    h.owner.Zotero_Tabs.close('tab-1');
    assert.equal(h.tabs.size, 0);

    // Switching back to pipeline reuses the cache: no new batch, no new upload.
    h.prefs.set('extensions.mktero.mineruCloudModelVersion', 'pipeline');
    await h.waitForReadiness('1', 'the pipeline profile to be ready');
    h.open(42);
    const reopened = await h.shadow('tab-2');
    await readyText(reopened, 'Parsed with pipeline');
    await h.waitForResult(42);
    assert.equal(h.completed.get(42).cacheHit, true);
    assert.equal(h.completed.get(42).cacheKey, keys.pipeline.markdown);
    assert.deepEqual(h.submissions, ['pipeline']);
    assert.equal(h.uploads.length, 1);
    assert.deepEqual(h.errors, []);

    await h.stop();
    h.assertDisposed();
    assert.equal(h.requests.filter(request => request.method === 'PUT').length, 1);
});

test('the hosted provider follows the resolved VLM target even when the Cloud model preference is pipeline', {
    timeout: 60_000,
}, async t => {
    const h = await createHarness(t, {
        hosted: true,
        prefs: {
            'extensions.mktero.conversionProvider': 'mktero',
            'extensions.mktero.mineruEndpoint': 'cloud',
            'extensions.mktero.mineruCloudModelVersion': 'pipeline',
            'extensions.mktero.accountEmail': 'reader@example.test',
            'extensions.mktero.accountAccessToken': 'test-access-token',
            'extensions.mktero.accountRefreshToken': 'test-refresh-token',
            'extensions.mktero.accountAccessExpiresAtMs': String(Date.now() + 3600_000),
        },
    });
    const keys = await cacheKeys(h.pdfData);

    h.open(42);
    const shadow = await h.shadow('tab-1');
    h.finish();
    await readyText(shadow, 'Parsed with vlm');
    await h.waitForResult(42);

    assert.deepEqual(h.submissions, []);
    assert.equal(h.hosted.modelVersions.join(','), 'vlm');
    const result = h.completed.get(42);
    assert.equal(result.provider, 'mktero');
    assert.equal(result.parserProfile, MINERU_PARSER_PROFILE_ID);
    assert.equal(result.cacheKey, keys.vlm.markdown);
    assert.notEqual(result.cacheKey, keys.pipeline.markdown);
    assert.equal(await h.hasRaw(keys.hosted.vlm), true);
    assert.equal(await h.hasRaw(keys.hosted.pipeline), false);
    assert.equal(await h.hasRaw(keys.vlm.raw), false);
    const records = await h.readinessRecords();
    assert.ok(records.every(record => record.parserProfile === MINERU_PARSER_PROFILE_ID));

    await h.stop();
    h.assertDisposed();
    assert.deepEqual(h.errors, []);
});

async function cacheKeys(pdfData) {
    const keys = {};
    for (const model of ['vlm', 'pipeline']) {
        const profiles = mineruCloudProfilesFor(model);
        keys[model] = {
            markdown: await createMarkdownCacheKey(pdfData, { parserProfile: profiles.cacheProfile }),
            raw: await createMinerUResultKey({
                fileData: pdfData,
                provider: 'mineru',
                requestProfile: profiles.requestProfile,
            }),
        };
    }
    // The hosted provider stores its raw results under its own provider name.
    keys.hosted = {};
    for (const model of ['vlm', 'pipeline']) {
        keys.hosted[model] = await createMinerUResultKey({
            fileData: pdfData,
            provider: 'mktero',
            requestProfile: mineruCloudProfilesFor(model).requestProfile,
        });
    }
    return keys;
}

async function createHarness(t, { prefs: initialPrefs = {}, hosted = false } = {}) {
    const profilePath = await fs.mkdtemp(path.join(os.tmpdir(), 'mktero-cloud-models-'));
    const dom = new JSDOM('<!doctype html><html><body><div id="zotero-pq-buttons"></div></body></html>', {
        pretendToBeVisual: true,
    });
    const { window } = dom;
    window.URL.createObjectURL = () => 'blob:cloud-models';
    window.URL.revokeObjectURL = () => {};
    window.HTMLCanvasElement.prototype.getContext = () => null;
    const tabs = new Map();
    const errors = [];
    const requests = [];
    const unexpectedRequests = [];
    const rows = new Map();
    const listeners = new Map();
    const prefObservers = new Map();
    const serviceObservers = new Map();
    const readerListeners = new Map();
    const registeredPanes = new Set();
    const completed = new Map();
    const buttons = new Map();
    const submissions = [];
    const uploads = [];
    const batches = new Map();
    const hostedState = { modelVersions: [] };
    const gate = deferred();
    let serial = 0;
    let stopped = false;
    let readinessColumn = null;
    const pdfData = new Uint8Array(await fs.readFile(new URL('./fixtures/offline-annotation.pdf', import.meta.url)));
    const pdfPath = path.join(profilePath, 'paper-42.pdf');
    await fs.writeFile(pdfPath, pdfData);
    const items = new Map([[42, {
        id: 42, libraryID: 1, key: 'PDFKEY42', parentItem: null,
        attachmentFilename: 'paper-42.pdf', isPDFAttachment: () => true,
        isRegularItem: () => false, getDisplayTitle: () => 'Paper 42',
        getFilePathAsync: async () => pdfPath, getAnnotations: () => [],
    }]]);
    const prefs = new Map([
        ['extensions.mktero.cacheEnabled', true],
        ...Object.entries(initialPrefs),
    ]);
    // The document pipeline rebuilds Markdown from content_list.json, so the
    // model name lives in the block text to stay visible in the rendered
    // document as well as in the archive.
    const archiveFor = model => zipSync({
        'full.md': strToU8(`# Parsed with ${model}\n\nParsed with ${model}: ${PDF_TEXT}`),
        'content_list.json': strToU8(JSON.stringify([
            { type: 'text', text: `Parsed with ${model}: ${PDF_TEXT}`, page_idx: 0, bbox: [118, 100, 400, 125] },
        ])),
    });
    const json = (status, body) => new Response(JSON.stringify(body), {
        status, headers: { 'content-type': 'application/json' },
    });
    const fetch = async (url, options = {}) => {
        const target = String(url);
        const method = String(options.method || 'GET').toUpperCase();
        requests.push({ method, url: target });
        if (method === 'GET' && target === 'https://models.dev/api.json') return json(200, {});
        if (method === 'POST' && (target === `${API_BASE}/api/v1/me/client-version`
            || target === `${API_BASE}/api/v1/me/reading-activity`)) {
            return new Response(null, { status: 204 });
        }
        if (hosted) return hostedTransport({ target, method, options });
        return mineruTransport({ target, method, options });
    };
    const mineruTransport = async ({ target, method, options }) => {
        if (target.startsWith(MINERU_API)) {
            assert.equal(options.headers?.Authorization || options.headers?.authorization,
                'Bearer cloud-fixture-token');
        }
        if (method === 'POST' && target === `${MINERU_API}/file-urls/batch`) {
            const body = JSON.parse(options.body);
            submissions.push(body.model_version);
            const batchID = `batch-${submissions.length}`;
            batches.set(batchID, { model: body.model_version, dataID: body.files[0].data_id });
            return json(200, {
                code: 0,
                data: { batch_id: batchID, file_urls: [`https://upload.example.test/${batchID}`] },
            });
        }
        if (method === 'PUT' && target.startsWith('https://upload.example.test/')) {
            uploads.push(target);
            assert.deepEqual(new Uint8Array(options.body), pdfData);
            return new Response(null, { status: 200 });
        }
        if (method === 'GET' && target.startsWith(`${MINERU_API}/extract-results/batch/`)) {
            const batch = batches.get(target.split('/').at(-1));
            assert.ok(batch, `known MinerU batch ${target}`);
            await gate.promise;
            return json(200, {
                code: 0,
                data: {
                    extract_result: [{
                        state: 'done', data_id: batch.dataID,
                        full_zip_url: `https://result.example.test/${batch.model}`,
                    }],
                },
            });
        }
        if (method === 'GET' && target.startsWith('https://result.example.test/')) {
            return new Response(archiveFor(target.split('/').at(-1)));
        }
        unexpectedRequests.push({ method, url: target });
        throw new Error(`Unexpected MinerU request: ${method} ${target}`);
    };
    const hostedTransport = async ({ target, method, options }) => {
        const jobURL = `${API_BASE}/api/v1/conversions/job_cloud_models`;
        if (target.startsWith(`${API_BASE}/api/v1/`)) {
            assert.equal(options.headers?.Authorization, 'Bearer test-access-token');
        }
        if (method === 'POST' && target === `${API_BASE}/api/v1/conversions/resolve`) {
            return json(200, {
                route_id: 'route_cloud_models',
                model_version: 'vlm',
                parser_profile_id: 'mineru/v4-batch-vlm-1',
            });
        }
        if (method === 'POST' && target === `${API_BASE}/api/v1/conversions`) {
            const body = JSON.parse(options.body);
            hostedState.modelVersions.push(body.model_version);
            assert.equal(body.route_id, 'route_cloud_models');
            assert.equal(body.parser_profile_id, 'mineru/v4-batch-vlm-1');
            return json(201, {
                job_id: 'job_cloud_models', status: 'awaiting_upload', progress: 0,
                upload_url: 'https://storage.example.test/cloud/upload', upload_method: 'PUT',
                model_version: 'vlm', parser_profile_id: 'mineru/v4-batch-vlm-1',
            });
        }
        if (method === 'PUT' && target === 'https://storage.example.test/cloud/upload') {
            uploads.push(target);
            return new Response(null, { status: 200 });
        }
        if (method === 'POST' && target === `${jobURL}/complete`) {
            return json(202, { job_id: 'job_cloud_models', status: 'processing', progress: 10 });
        }
        if (method === 'GET' && target === jobURL) {
            await gate.promise;
            return json(200, {
                job_id: 'job_cloud_models', status: 'succeeded', progress: 100,
                model_version: 'vlm', parser_profile_id: 'mineru/v4-batch-vlm-1',
            });
        }
        if (method === 'GET' && target === `${jobURL}/result-url`) {
            return json(200, { result_url: 'https://storage.example.test/cloud/result', method: 'GET' });
        }
        if (method === 'GET' && target === 'https://storage.example.test/cloud/result') {
            return new Response(archiveFor('vlm'));
        }
        unexpectedRequests.push({ method, url: target });
        throw new Error(`Unexpected hosted request: ${method} ${target}`);
    };
    const queue = {
        getID: () => 'mktero-prepare',
        addRow: item => rows.set(item.id, { title: item.getDisplayTitle() }),
        updateRow: (id, status, message) => rows.set(id, { ...rows.get(id), status, message }),
        deleteRow: id => rows.delete(id),
        addListener(name, callback) {
            if (!listeners.has(name)) listeners.set(name, new Set());
            listeners.get(name).add(callback);
        },
        removeListener: (name, callback) => listeners.get(name)?.delete(callback),
        getTotal: () => rows.size,
        getDialog: () => ({ open() {}, setStatus() {} }),
        cancel: () => { for (const callback of listeners.get('cancel') || []) callback(); },
    };
    const owner = {
        document: window.document, AbortController, fetch,
        setTimeout: window.setTimeout.bind(window),
        clearTimeout: window.clearTimeout.bind(window),
        Zotero_Tabs: {
            add(options) {
                const id = `tab-${++serial}`;
                const container = window.document.createElement('div');
                window.document.body.append(container);
                tabs.set(id, { options, container });
                return { id, container };
            },
            select() {}, rename() {}, getState: () => [],
            close(id) {
                const entry = tabs.get(id);
                entry?.options.onClose?.();
                entry?.container.remove();
                tabs.delete(id);
            },
        },
    };
    const zotero = {
        version: '9.0.6', locale: 'en-US', uiReadyPromise: Promise.resolve(),
        Profile: { dir: profilePath }, DataDirectory: { dir: profilePath },
        Session: { state: { windows: [] } },
        Prefs: {
            get: (key, global) => (prefs.has(key) ? prefs.get(key) : ''),
            set(key, value) {
                prefs.set(key, value);
                for (const observer of prefObservers.values()) {
                    if (observer.key === key) observer.callback();
                }
            },
            clear: key => prefs.delete(key),
            registerObserver(key, callback) {
                const id = Symbol(key);
                prefObservers.set(id, { key, callback });
                return id;
            },
            unregisterObserver: id => prefObservers.delete(id),
        },
        Items: { get: id => items.get(id), getAsync: async id => items.get(id), loadDataTypes: async () => {} },
        ItemTreeManager: {
            registerColumn(options) { readinessColumn = options; return 'mktero-markdownReady'; },
            unregisterColumn() { readinessColumn = null; },
            refresh() {},
        },
        PreferencePanes: {
            register: async options => { registeredPanes.add(options.id); return options.id; },
            unregister: id => registeredPanes.delete(id),
        },
        Reader: {
            registerEventListener: (type, handler) => readerListeners.set(type, handler),
            unregisterEventListener(type, handler) {
                if (readerListeners.get(type) === handler) readerListeners.delete(type);
            },
            _unregisterEventListenerByPluginID() { readerListeners.clear(); },
        },
        ProgressQueue: { ROW_QUEUED: 1, ROW_PROCESSING: 2, ROW_FAILED: 3, ROW_SUCCEEDED: 4 },
        ProgressQueues: { get: () => queue, create: () => queue },
        getMainWindow: () => owner, debug() {}, logError: error => errors.push(error),
    };
    const globals = {
        Zotero: zotero, IOUtils: nodeIO(),
        PathUtils: {
            join: path.join, parent: path.dirname, filename: path.basename,
            tempDir: path.join(profilePath, 'tmp'),
        },
        fetch,
        Services: {
            obs: {
                addObserver(observer, topic) {
                    if (!serviceObservers.has(topic)) serviceObservers.set(topic, new Set());
                    serviceObservers.get(topic).add(observer);
                },
                removeObserver: (observer, topic) => serviceObservers.get(topic)?.delete(observer),
                notifyObservers(_subject, topic, data) {
                    for (const observer of serviceObservers.get(topic) || []) observer.observe(null, topic, data);
                },
            },
        },
        __MKTERO_MARKDOWN_STYLES__: await fs.readFile(new URL('../ui/markdown.css', import.meta.url), 'utf8'),
    };
    const previous = new Map([...Object.keys(globals), 'startup', 'shutdown', 'install',
        'uninstall', 'onMainWindowLoad', 'onMainWindowUnload'].map(key => [key, globalThis[key]]));
    Object.assign(globalThis, globals);
    const convert = MarkdownDocumentService.prototype.convert;
    // Observe published results without replacing any extractor or client.
    t.mock.method(MarkdownDocumentService.prototype, 'convert', function (itemID, options) {
        return convert.call(this, itemID, options).then(result => {
            completed.set(itemID, result);
            return result;
        });
    });
    const stop = async () => {
        if (stopped) return;
        stopped = true;
        await globalThis.shutdown?.();
    };
    t.after(async () => {
        try {
            await stop();
            gate.resolve();
        }
        finally {
            window.close();
            for (const [key, value] of previous) {
                if (value === undefined) delete globalThis[key];
                else globalThis[key] = value;
            }
            await fs.rm(profilePath, { recursive: true, force: true });
        }
    });
    await import(`../src/bootstrap.js?cloud-models-${++importSerial}`);
    await globalThis.startup({ id: 'mktero@tenglvjun.github.io', rootURI: 'resource://mktero/' });
    assert.ok(readerListeners.has('renderToolbar'));
    assert.ok(readinessColumn, 'bootstrap must register its readiness column');
    const exists = async file => fs.access(file).then(() => true, () => false);
    return {
        pdfData, tabs, owner, prefs, requests, unexpectedRequests, errors, completed,
        submissions, uploads, hosted: hostedState, stop,
        finish: gate.resolve,
        open(itemID) {
            if (!buttons.has(itemID)) {
                const rendered = [];
                readerListeners.get('renderToolbar')({
                    reader: { type: 'pdf', itemID }, doc: window.document,
                    append: button => rendered.push(button),
                });
                buttons.set(itemID, rendered.find(button => button.classList.contains('mktero-markdown-button')));
            }
            assert.ok(buttons.get(itemID), `a real Markdown toolbar button for ${itemID}`);
            buttons.get(itemID).click();
        },
        shadow: id => waitFor(() => tabs.get(id)?.container.querySelector('.mktero-tab-host')?.shadowRoot,
            `shadow root for ${id}`),
        waitForSubmission: () => waitFor(() => submissions.length === 1, 'the MinerU batch submission'),
        waitForResult: itemID => waitFor(() => completed.get(itemID), `the published conversion result for ${itemID}`),
        waitForReadiness: (expected, description) => waitFor(
            () => readinessColumn.dataProvider(items.get(42)) === expected, description),
        readinessRecords: async () => JSON.parse(await fs.readFile(
            path.join(profilePath, 'mktero-readiness', 'v1', 'index.json'), 'utf8')).records,
        hasMarkdown: cacheKey => exists(path.join(
            profilePath, 'mktero-cache', 'v1', 'entries', cacheKey, 'entry.json')),
        hasRaw: cacheKey => exists(path.join(
            profilePath, 'mktero-mineru-results', 'v1', 'entries', cacheKey, 'entry.json')),
        assertDisposed() {
            assert.equal(tabs.size, 0, 'shutdown closes every Markdown tab');
            assert.equal(readerListeners.size, 0, 'shutdown unregisters the Reader listeners');
            assert.equal(prefObservers.size, 0, 'shutdown unregisters preference observers');
            assert.equal(registeredPanes.size, 0, 'shutdown unregisters the preferences pane');
            assert.ok([...serviceObservers.values(), ...listeners.values()].every(set => set.size === 0));
            assert.equal(window.document.querySelector('.mktero-tab-host'), null);
        },
    };
}

async function readyText(shadow, expected) {
    await waitFor(() => shadow.querySelector('.cm-content')?.textContent.includes(expected)
        && shadow.querySelector('#mktero-content')?.getAttribute('aria-busy') === 'false',
    `a ready Markdown document containing ${JSON.stringify(expected)}`);
    assert.equal(shadow.querySelector('.message.error').hidden, true);
}

function deferred() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}

async function waitFor(read, description, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await read();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Bootstrap cloud models timed out waiting for ${description}`);
}

function nodeIO() {
    const write = async (file, data, { tmpPath } = {}) => {
        await fs.mkdir(path.dirname(tmpPath || file), { recursive: true });
        await fs.writeFile(tmpPath || file, data);
        if (tmpPath) await fs.rename(tmpPath, file);
    };
    return {
        exists: async file => fs.access(file).then(() => true, () => false),
        makeDirectory: (file, options = {}) => fs.mkdir(file, { recursive: options.ignoreExisting !== false }),
        read: async file => new Uint8Array(await fs.readFile(file)),
        readUTF8: file => fs.readFile(file, 'utf8'),
        getChildren: async file => (await fs.readdir(file)).map(name => path.join(file, name)),
        stat: async file => {
            const value = await fs.stat(file);
            return { type: value.isDirectory() ? 'directory' : 'regular', size: value.size };
        },
        remove: (file, options = {}) => fs.rm(file, {
            recursive: Boolean(options.recursive), force: Boolean(options.ignoreAbsent),
        }),
        write, writeUTF8: write,
    };
}
