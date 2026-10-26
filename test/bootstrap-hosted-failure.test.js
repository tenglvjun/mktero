import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { JSDOM } from 'jsdom';

const JOB_ID = 'job_55470de0567cde08c2add693b168a186';

// Bootstrap owns process globals, so this integration runs in its own test file.
test('shows a hosted conversion failure instead of staying on the progress screen', async t => {
    const profilePath = await fs.mkdtemp(path.join(os.tmpdir(), 'mktero-hosted-failure-'));
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
    const { window } = dom;
    window.URL.createObjectURL = () => 'blob:hosted-failure';
    window.URL.revokeObjectURL = () => {};
    const tabs = new Map();
    let serial = 0;
    let toolbarHandler;
    const owner = {
        document: window.document,
        AbortController,
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
    const ioUtils = nodeIO();
    const pathUtils = { join: path.join, parent: path.dirname, filename: path.basename,
        tempDir: path.join(profilePath, 'tmp') };
    const pdfData = new Uint8Array(await fs.readFile(new URL('./fixtures/offline-annotation.pdf', import.meta.url)));
    const pdfPath = path.join(profilePath, 'paper.pdf');
    await fs.writeFile(pdfPath, pdfData);
    const prefs = new Map([
        ['extensions.mktero.cacheEnabled', true],
        ['extensions.mktero.accountEmail', 'reader@example.com'],
        ['extensions.mktero.accountAccessToken', 'access-token'],
        ['extensions.mktero.accountRefreshToken', 'refresh-token'],
        ['extensions.mktero.accountAccessExpiresAtMs', String(Date.now() + 3600_000)],
    ]);
    const logged = [];
    // Zotero's logError reads `this`, so it must be called as a method of
    // Zotero. A detached call throws before the tab can show the failure.
    const zotero = {
        version: '9.0.6', locale: 'en-US', uiReadyPromise: Promise.resolve(),
        Profile: { dir: profilePath }, Session: { state: { windows: [] } },
        Prefs: {
            get: key => (prefs.has(key) ? prefs.get(key) : ''),
            set: (key, value) => prefs.set(key, value),
            clear: key => prefs.delete(key),
        },
        Items: {
            get: id => ({ id, libraryID: 1, key: 'PAPERKEY', isPDFAttachment: () => true }),
            getAsync: async id => ({ id, libraryID: 1, key: 'PAPERKEY',
                attachmentFilename: 'paper.pdf', parentItem: null,
                isPDFAttachment: () => true, getDisplayTitle: () => 'Paper',
                getFilePathAsync: async () => pdfPath, getAnnotations: () => [] }),
            loadDataTypes: async () => {},
        },
        PreferencePanes: { register: async options => options.id, unregister() {} },
        Reader: { registerEventListener: (_type, handler) => { toolbarHandler = handler; } },
        getMainWindow: () => owner,
        debug() {},
        log(message, type) {
            logged.push({ message: String(message), type });
        },
        logError: function logError(error) {
            this.log(error.message ? error.message : error.toString(), 'error');
        },
    };
    const requests = [];
    const fetch = async (url, options = {}) => {
        const method = String(options.method || 'GET').toUpperCase();
        const target = String(url);
        requests.push(`${method} ${target}`);
        if (method === 'POST' && target.endsWith('/api/v1/conversions')) {
            return jsonResponse(201, {
                job_id: JOB_ID,
                status: 'awaiting_upload',
                progress: 0,
                upload_url: 'https://r2.example/upload?X-Amz-Signature=secret',
                upload_method: 'PUT',
            });
        }
        if (method === 'PUT' && target.startsWith('https://r2.example/upload')) {
            return { ok: true, status: 200, headers: { get: () => null } };
        }
        if (method === 'POST' && target.endsWith(`/${JOB_ID}/complete`)) {
            return jsonResponse(202, { job_id: JOB_ID, status: 'processing', progress: 10 });
        }
        if (method === 'GET' && target.endsWith(`/conversions/${JOB_ID}`)) {
            return jsonResponse(200, {
                job_id: JOB_ID,
                status: 'failed',
                progress: 10,
                error_code: 'MINERU_TASK_FAILED',
            });
        }
        if (method === 'DELETE' && target.endsWith(`/conversions/${JOB_ID}`)) {
            return jsonResponse(200, { job_id: JOB_ID, status: 'failed' });
        }
        throw new Error(`Unexpected request ${method} ${target}`);
    };
    const globals = {
        Zotero: zotero, IOUtils: ioUtils, PathUtils: pathUtils, fetch,
        Services: { obs: { addObserver() {}, removeObserver() {} } },
        __MKTERO_MARKDOWN_STYLES__: await fs.readFile(new URL('../ui/markdown.css', import.meta.url), 'utf8'),
    };
    const previous = new Map([...Object.keys(globals), 'startup', 'shutdown', 'install',
        'uninstall', 'onMainWindowLoad', 'onMainWindowUnload'].map(key => [key, globalThis[key]]));
    Object.assign(globalThis, globals);
    t.after(async () => {
        await globalThis.shutdown?.();
        window.close();
        for (const [key, value] of previous) {
            if (value === undefined) delete globalThis[key];
            else globalThis[key] = value;
        }
        await fs.rm(profilePath, { recursive: true, force: true });
    });

    await import('../src/bootstrap.js?hosted-failure');
    await globalThis.startup({ id: 'mktero@tenglvjun.github.io', rootURI: 'resource://mktero/' });
    const buttons = [];
    toolbarHandler({ reader: { type: 'pdf', itemID: 42 }, doc: window.document,
        append: button => buttons.push(button) });
    const markdownButton = buttons.find(button => (
        String(button.className).includes('mktero-markdown-button')
    ));
    assert.ok(markdownButton);
    markdownButton.click();

    const shadow = await waitFor(() => tabs.get('tab-1')?.container
        .querySelector('.mktero-tab-host')?.shadowRoot);
    const error = await waitFor(() => {
        const message = shadow.querySelector('.message.error');
        return message && !message.hidden && message.textContent.trim() ? message : null;
    });

    assert.match(error.textContent, /The Mktero service could not convert this PDF/);
    assert.ok(requests.includes(`GET http://127.0.0.1:8080/api/v1/conversions/${JOB_ID}`));
    assert.ok(logged.some(entry => entry.type === 'error'
        && entry.message === 'The Mktero conversion failed'));
});

function jsonResponse(status, body) {
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        async arrayBuffer() { return bytes.slice().buffer; },
    };
}

async function waitFor(read, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await read();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Bootstrap hosted conversion state did not become ready');
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
