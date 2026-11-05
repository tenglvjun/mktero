import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { JSDOM } from 'jsdom';
import { strToU8, zipSync } from 'fflate';
import { MarkdownDocumentService } from '../src/core/markdown-document-service.js';
import { CONVERSION_PROGRESS } from '../src/core/conversion-progress.js';
import { sha256Hex } from '../src/core/sha256.js';
import { CLIENT_HEARTBEAT_INTERVAL_MS } from '../src/account/account-session.js';

const API_BASE = 'http://127.0.0.1:8080';
const JOB_ID = 'job_bootstrap_hosted_sharing';
const JOB_URL = `${API_BASE}/api/v1/conversions/${JOB_ID}`;
const UPLOAD_URL = 'https://storage.example.test/shared/upload';
const RESULT_URL = 'https://storage.example.test/shared/result.zip';
const PDF_TEXT = 'Ovulation limits (±2 days)';
let importSerial = 0;

// Bootstrap owns process globals; each scenario gets its own module instance.
test('shares one hosted job through two real toolbar entries and finishes a closed tab in the background', async t => {
    const h = await createHarness(t);
    h.open(42);
    h.open(44);
    const left = await h.shadow('tab-1');
    const right = await h.shadow('tab-2');
    await h.waitForShared(left, right);

    assert.equal(h.tabs.size, 2);
    assert.deepEqual(h.runs.map(run => run.itemID), [42, 44]);
    assert.notEqual(h.runs[0].signal, h.runs[1].signal);
    assert.equal(h.count('POST', `${API_BASE}/api/v1/conversions`), 1);
    assert.equal(h.count('PUT', UPLOAD_URL), 1);
    assert.equal(h.completed.size, 0, 'the HTTP gate must keep both documents pending');

    h.owner.Zotero_Tabs.close('tab-1');
    await waitFor(() => h.rows.get(42)?.status === h.zotero.ProgressQueue.ROW_PROCESSING,
        'the closed tab to move into the background progress queue');
    assert.equal(h.rows.get(42).title, 'Paper 42');
    assert.ok(h.progressOpened > 0);
    assert.equal(h.tabs.has('tab-1'), false);
    assert.equal(h.tabs.has('tab-2'), true);
    assert.ok(h.runs.every(run => !run.signal.aborted));
    assert.ok(h.requests.filter(request => request.url === JOB_URL)
        .every(request => !request.signal.aborted));
    assert.equal(h.count('DELETE'), 0);

    h.finish();
    await waitFor(() => h.completed.size === 2
        && h.rows.get(42)?.status === h.zotero.ProgressQueue.ROW_SUCCEEDED,
    'both per-attachment conversions and the background row to finish');
    await readyText(right);
    const first = h.completed.get(42);
    const second = h.completed.get(44);
    assert.notEqual(first, second);
    for (const [itemID, result] of [[42, first], [44, second]]) {
        assert.equal(result.itemID, itemID);
        assert.equal(result.title, `Paper ${itemID}`);
        assert.ok(result.markdown.includes(PDF_TEXT));
        assert.equal(result.sourceKind, 'markdown');
        assert.equal(result.cacheHit, false);
        assert.equal(result.provider, 'mktero');
        // The hosted ZIP decoder exposes structure and locations, not page-count metadata.
        assert.equal(typeof result.documentStructure, 'string');
        const pages = result.sourceMap.flatMap(entry => entry.locations.map(location => location.pageIndex));
        assert.deepEqual([...new Set(pages)], [0]);
    }
    assert.equal(first.sourceHash, await sha256Hex(h.pdfData));
    assert.equal(first.sourceHash, second.sourceHash);
    assert.equal(first.cacheKey, second.cacheKey);
    assert.equal(h.count('POST', `${API_BASE}/api/v1/conversions`), 1);
    assert.equal(h.count('GET', JOB_URL), 1);
    assert.equal(h.count('GET', `${JOB_URL}/result-url`), 1);
    assert.equal(h.count('GET', RESULT_URL), 1);
    assert.equal(h.count('DELETE'), 0);

    // Reopen the background attachment through the same real toolbar button.
    h.open(42);
    const reopened = await h.shadow('tab-3');
    await readyText(reopened);
    assert.equal(h.tabs.size, 2);
    assert.equal(h.runs.length, 3);
    assert.equal(h.completed.get(42).cacheHit, true);
    assert.equal(h.completed.get(42).title, 'Paper 42');
    assert.equal(h.count('POST', `${API_BASE}/api/v1/conversions`), 1);
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.unexpectedRequests, []);

    h.assertHeartbeatScheduled();
    await h.stop();
    h.assertDisposed();
    assert.equal(h.count('DELETE'), 0, 'shutdown must not cancel an already completed job');
    assert.deepEqual(h.errors, []);
});

test('shutdown aborts a shared hosted job once and removes its real bootstrap registrations', async t => {
    const h = await createHarness(t);
    h.open(42);
    h.open(44);
    const left = await h.shadow('tab-1');
    const right = await h.shadow('tab-2');
    await h.waitForShared(left, right);
    h.owner.Zotero_Tabs.close('tab-1');
    await waitFor(() => h.rows.has(42), 'the first attachment to continue in the background');
    assert.equal(h.count('DELETE'), 0);
    const settled = Promise.allSettled(h.runs.map(run => run.promise));

    h.assertHeartbeatScheduled();
    await h.stop();
    const results = await settled;
    assert.ok(results.every(result => result.status === 'rejected' && result.reason.name === 'AbortError'));
    assert.ok(h.runs.every(run => run.signal.aborted));
    assert.equal(h.count('POST', `${API_BASE}/api/v1/conversions`), 1);
    assert.equal(h.count('DELETE', JOB_URL), 1);
    const cancellation = h.requests.find(request => request.method === 'DELETE');
    assert.equal(cancellation.signal.aborted, false);
    assert.ok(h.requests.find(request => request.method === 'GET' && request.url === JOB_URL).signal.aborted);
    assert.equal(h.completed.size, 0);
    h.assertDisposed();
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.unexpectedRequests, []);
});

async function createHarness(t) {
    const profilePath = await fs.mkdtemp(path.join(os.tmpdir(), 'mktero-hosted-sharing-'));
    const dom = new JSDOM('<!doctype html><html><body><div id="zotero-pq-buttons"></div></body></html>', {
        pretendToBeVisual: true,
    });
    const progressDOM = new JSDOM('<!doctype html><html><body><div id="progress-queue-root"></div></body></html>');
    const { window } = dom;
    window.URL.createObjectURL = () => 'blob:hosted-sharing';
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
    const timers = new Map();
    const timerHistory = [];
    const completed = new Map();
    const runs = [];
    const buttons = new Map();
    const gate = deferred();
    let polling = false;
    let serial = 0;
    let progressOpened = 0;
    let queueCreated = false;
    let stopped = false;
    const pdfData = new Uint8Array(await fs.readFile(new URL('./fixtures/offline-annotation.pdf', import.meta.url)));
    const items = new Map();
    for (const id of [42, 44]) {
        const pdfPath = path.join(profilePath, `paper-${id}.pdf`);
        await fs.writeFile(pdfPath, pdfData);
        items.set(id, {
            id, libraryID: 1, key: `PDFKEY${id}`, attachmentFilename: `paper-${id}.pdf`, parentItem: null,
            isPDFAttachment: () => true, isRegularItem: () => false,
            getDisplayTitle: () => `Paper ${id}`, getFilePathAsync: async () => pdfPath,
            getAnnotations: () => [],
        });
    }
    const prefs = new Map([
        ['extensions.mktero.cacheEnabled', true],
        ['extensions.mktero.conversionProvider', 'mktero'],
        ['extensions.mktero.accountEmail', 'reader@example.test'],
        ['extensions.mktero.accountAccessToken', 'test-access-token'],
        ['extensions.mktero.accountRefreshToken', 'test-refresh-token'],
        ['extensions.mktero.accountAccessExpiresAtMs', String(Date.now() + 3600_000)],
    ]);
    // This one-page OCR result matches the text in offline-annotation.pdf.
    const archive = zipSync({
        'full.md': strToU8(PDF_TEXT),
        'content_list.json': strToU8(JSON.stringify([
            { type: 'text', text: PDF_TEXT, page_idx: 0, bbox: [118, 100, 400, 125] },
        ])),
    });
    const fetch = async (url, options = {}) => {
        const target = String(url);
        const method = String(options.method || 'GET').toUpperCase();
        requests.push({ method, url: target, signal: options.signal });
        if (target.startsWith(`${API_BASE}/api/v1/`)) {
            assert.equal(options.headers.Authorization, 'Bearer test-access-token');
        }
        if (method === 'GET' && target === 'https://models.dev/api.json') return jsonResponse(200, {});
        if (method === 'POST' && target === `${API_BASE}/api/v1/me/client-version`) return jsonResponse(200, {});
        if (method === 'POST' && target === `${API_BASE}/api/v1/conversions`) {
            const body = JSON.parse(options.body);
            assert.equal(body.size, pdfData.byteLength);
            assert.equal(body.sha256, await sha256Hex(pdfData));
            assert.equal(body.content_type, 'application/pdf');
            return jsonResponse(201, {
                job_id: JOB_ID, status: 'awaiting_upload', progress: 0,
                upload_url: UPLOAD_URL, upload_method: 'PUT',
            });
        }
        if (method === 'PUT' && target === UPLOAD_URL) {
            assert.equal(options.headers.Authorization, undefined);
            assert.deepEqual(new Uint8Array(options.body), pdfData);
            return new Response(null, { status: 200 });
        }
        if (method === 'POST' && target === `${JOB_URL}/complete`) {
            return jsonResponse(202, { job_id: JOB_ID, status: 'processing', progress: 10 });
        }
        if (method === 'GET' && target === JOB_URL) {
            polling = true;
            await waitForGate(gate.promise, options.signal);
            return jsonResponse(200, { job_id: JOB_ID, status: 'succeeded', progress: 100 });
        }
        if (method === 'GET' && target === `${JOB_URL}/result-url`) {
            return jsonResponse(200, { result_url: RESULT_URL, method: 'GET' });
        }
        if (method === 'GET' && target === RESULT_URL) {
            assert.equal(options.headers.Authorization, undefined);
            return new Response(archive);
        }
        if (method === 'DELETE' && target === JOB_URL) return jsonResponse(200, { job_id: JOB_ID, status: 'failed' });
        unexpectedRequests.push({ method, url: target });
        throw new Error(`Unexpected mocked request: ${method} ${target}`);
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
        getDialog: () => ({ open: () => { progressOpened++; }, setStatus() {} }),
        cancel: () => { for (const callback of listeners.get('cancel') || []) callback(); },
    };
    progressDOM.window.arguments = [{ progressQueue: queue }];
    const owner = {
        document: window.document, AbortController, fetch,
        setTimeout(callback, delay) {
            const record = { delay, state: 'pending', origin: new Error('Timer created').stack };
            const handle = window.setTimeout(() => {
                timers.delete(handle);
                record.state = 'fired';
                callback();
            }, delay);
            timers.set(handle, record);
            timerHistory.push(record);
            return handle;
        },
        clearTimeout(handle) {
            const record = timers.get(handle);
            if (record) record.state = 'cleared';
            timers.delete(handle);
            window.clearTimeout(handle);
        },
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
        Profile: { dir: profilePath }, Session: { state: { windows: [] } },
        Prefs: {
            get: key => prefs.has(key) ? prefs.get(key) : '',
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
        PreferencePanes: {
            register: async options => { registeredPanes.add(options.id); return options.id; },
            unregister: id => registeredPanes.delete(id),
        },
        Reader: {
            registerEventListener: (type, handler) => readerListeners.set(type, handler),
            unregisterEventListener(type, handler) {
                if (readerListeners.get(type) === handler) readerListeners.delete(type);
            },
            _unregisterEventListenerByPluginID(pluginID) {
                assert.equal(pluginID, 'mktero@tenglvjun.github.io');
                readerListeners.clear();
            },
        },
        ProgressQueue: { ROW_QUEUED: 1, ROW_PROCESSING: 2, ROW_FAILED: 3, ROW_SUCCEEDED: 4 },
        ProgressQueues: {
            get: () => queueCreated ? queue : null,
            create: () => { queueCreated = true; return queue; },
        },
        getMainWindow: () => owner, debug() {}, logError: error => errors.push(error),
    };
    const globals = {
        Zotero: zotero, IOUtils: nodeIO(),
        PathUtils: { join: path.join, parent: path.dirname, filename: path.basename, tempDir: path.join(profilePath, 'tmp') },
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
            wm: {
                getEnumerator() {
                    let available = true;
                    return {
                        hasMoreElements: () => available,
                        getNext: () => { available = false; return progressDOM.window; },
                    };
                },
            },
        },
        __MKTERO_MARKDOWN_STYLES__: await fs.readFile(new URL('../ui/markdown.css', import.meta.url), 'utf8'),
    };
    const previous = new Map([...Object.keys(globals), 'startup', 'shutdown', 'install',
        'uninstall', 'onMainWindowLoad', 'onMainWindowUnload'].map(key => [key, globalThis[key]]));
    Object.assign(globalThis, globals);
    const convert = MarkdownDocumentService.prototype.convert;
    // Observe results without replacing any extractor, client, or presentation step.
    t.mock.method(MarkdownDocumentService.prototype, 'convert', function (itemID, options) {
        const promise = convert.call(this, itemID, options).then(result => {
            completed.set(itemID, result);
            return result;
        });
        runs.push({ itemID, signal: options.signal, promise });
        return promise;
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
            await Promise.allSettled(runs.map(run => run.promise));
        }
        finally {
            window.close();
            progressDOM.window.close();
            for (const [key, value] of previous) {
                if (value === undefined) delete globalThis[key];
                else globalThis[key] = value;
            }
            await fs.rm(profilePath, { recursive: true, force: true });
        }
    });
    await import(`../src/bootstrap.js?hosted-sharing-${++importSerial}`);
    await globalThis.startup({ id: 'mktero@tenglvjun.github.io', rootURI: 'resource://mktero/' });
    assert.ok(readerListeners.has('renderToolbar'));
    assert.ok(prefObservers.size > 0);
    assert.ok(registeredPanes.size > 0);
    return {
        tabs, owner, zotero, requests, unexpectedRequests, rows, errors, completed, runs, pdfData, stop,
        get polling() { return polling; },
        get progressOpened() { return progressOpened; },
        finish: gate.resolve,
        async waitForShared(...shadows) {
            try {
                await waitFor(() => {
                    assert.deepEqual(errors, []);
                    assert.deepEqual(unexpectedRequests, []);
                    return polling && runs.length === 2 && shadows.every(shadow => (
                        shadow.querySelector('#mktero-progress')?.value >= CONVERSION_PROGRESS.PARSING
                    ));
                }, 'both attachments to join the pending hosted job');
            }
            catch (error) {
                t.diagnostic(JSON.stringify({ polling, runs: runs.map(run => run.itemID),
                    requests: requests.map(request => [request.method, request.url]),
                    progress: shadows.map(shadow => shadow.querySelector('#mktero-progress')?.value) }));
                throw error;
            }
        },
        count: (method, url) => requests.filter(request => request.method === method && (!url || request.url === url)).length,
        shadow: id => waitFor(() => tabs.get(id)?.container.querySelector('.mktero-tab-host')?.shadowRoot, `shadow root for ${id}`),
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
        assertHeartbeatScheduled() {
            assert.ok([...timers.values()].some(record => record.delay === CLIENT_HEARTBEAT_INTERVAL_MS),
                'the live heartbeat timer must exist before testing shutdown cleanup');
        },
        assertDisposed() {
            assert.equal(tabs.size, 0, 'shutdown closes every Markdown tab');
            assert.equal(readerListeners.size, 0, 'shutdown unregisters both Reader listeners');
            assert.equal(prefObservers.size, 0, 'shutdown unregisters preference observers');
            assert.equal(registeredPanes.size, 0, 'shutdown unregisters the preferences pane');
            assert.equal(timers.size, 0, `shutdown leaves pending timers: ${JSON.stringify([...timers.values()])}`);
            assert.ok(timerHistory.some(record => record.delay === CLIENT_HEARTBEAT_INTERVAL_MS && record.state === 'cleared'),
                'shutdown clears the scheduled heartbeat timer');
            assert.ok([...serviceObservers.values(), ...listeners.values()].every(set => set.size === 0));
            assert.equal(window.document.querySelector('.mktero-tab-host'), null);
            assert.equal(window.document.getElementById('zotero-tb-pq-mktero-prepare'), null);
            assert.equal(progressDOM.window.document.getElementById('mktero-quota-resume'), null);
        },
    };
}

function jsonResponse(status, body) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function deferred() {
    let resolve;
    const promise = new Promise(yes => { resolve = yes; });
    return { promise, resolve };
}

function waitForGate(promise, signal) {
    return new Promise((resolve, reject) => {
        const abort = () => { cleanup(); reject(new DOMException('Request aborted', 'AbortError')); };
        const cleanup = () => signal?.removeEventListener('abort', abort);
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener('abort', abort, { once: true });
        promise.then(() => { cleanup(); resolve(); });
    });
}

async function readyText(shadow) {
    await waitFor(() => shadow.querySelector('.cm-content')?.textContent.includes(PDF_TEXT)
        && shadow.querySelector('#mktero-content')?.getAttribute('aria-busy') === 'false', 'a ready Markdown document');
    assert.equal(shadow.querySelector('.message.error').hidden, true);
    assert.equal(shadow.querySelector('.cm-content').getAttribute('contenteditable'), 'false');
}

async function waitFor(read, description, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await read();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Bootstrap sharing timed out waiting for ${description}`);
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
