import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JSDOM } from 'jsdom';
import { EditorView } from '@codemirror/view';
import { unzipSync, strFromU8, zipSync, strToU8 } from 'fflate';
import { createMinerUCacheKey, createZoteroMarkdownCache } from '../src/cache/markdown-cache.js';
import { createZoteroMinerUResultStore } from '../src/cache/mineru-result-store.js';
import { createZoteroMinerUImportIndex } from '../src/cache/mineru-import-index.js';
import { createLLMCacheIdentity } from '../src/mineru/llm-cache-profile.js';
import { ImportedMinerUDocumentExtractor } from '../src/extractors/imported-mineru-extractor.js';
import { createZoteroMarkdownRevisionStore } from '../src/platform/zotero-markdown-revision-store.js';
import { translateEnglish } from '../src/i18n/localization.js';
import { sha256Hex } from '../src/core/sha256.js';
import { MINERU_PARSER_PROFILE_ID } from '../src/mineru/parser-profile.js';

const FIRST_TEXT = 'First imported article with a source location.';
const UPDATED_TEXT = 'Updated local article replaces the previously ready document.';
const STARTUP_OPTIONS = { id: 'mktero@tenglvjun.github.io', rootURI: 'resource://mktero/' };

// Bootstrap owns process globals, so this integration runs in its own test file.
test('imports a local MinerU cache through bootstrap and preserves its offline selection', async t => {
    const profilePath = await fs.mkdtemp(path.join(os.tmpdir(), 'mktero-llm-cache-bootstrap-'));
    const dom = new JSDOM('<!doctype html><html><body><menupopup id="zotero-itemmenu"></menupopup></body></html>', {
        pretendToBeVisual: true,
    });
    const { window } = dom;
    window.URL.createObjectURL = () => 'blob:llm-cache-bootstrap';
    window.URL.revokeObjectURL = () => {};
    window.HTMLCanvasElement.prototype.getContext = () => null;
    const tabs = new Map();
    const errors = [];
    const confirmations = [];
    const requests = [];
    const hostedRequests = [];
    let hostedRun = null;
    const readyResults = [];
    const controllers = [];
    const conversionStarts = [];
    class ObservedAbortController extends AbortController {
        constructor() {
            super();
            controllers.push(this);
        }
    }
    let serial = 0;
    let remoteReparsePromptAllowed = false;
    let readinessColumn = null;
    const parent = {
        id: 41, libraryID: 1, key: 'PARENTKEY',
        isRegularItem: () => true, isPDFAttachment: () => false,
        getDisplayTitle: () => 'Public offline article',
        getAttachments: () => [42], getNotes: () => [],
    };
    const pdfPath = path.join(profilePath, 'paper.pdf');
    const attachment = {
        id: 42, libraryID: 1, key: 'PDFKEY42',
        parentItemID: parent.id, parentItem: parent,
        attachmentFilename: 'paper.pdf',
        isRegularItem: () => false, isPDFAttachment: () => true,
        getDisplayTitle: () => 'Public offline article PDF',
        getFilePath: () => pdfPath,
        getFilePathAsync: async () => pdfPath, getAnnotations: () => [],
    };
    const secondParent = {
        ...parent, id: 43, key: 'PARENT43',
        getDisplayTitle: () => 'Second public offline article',
        getAttachments: () => [44],
    };
    const secondPDFPath = path.join(profilePath, 'paper-copy.pdf');
    const secondAttachment = {
        ...attachment, id: 44, key: 'PDFKEY44',
        parentItemID: secondParent.id, parentItem: secondParent,
        getFilePath: () => secondPDFPath,
        getFilePathAsync: async () => secondPDFPath,
    };
    const items = new Map([parent, attachment, secondParent, secondAttachment].map(item => [item.id, item]));
    let selectedItem = parent;
    const fetch = async (url, options = {}) => {
        const target = String(url);
        const method = String(options.method || 'GET').toUpperCase();
        const request = { method, url: target };
        requests.push(request);
        if (method === 'GET' && target === 'https://models.dev/api.json') {
            return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (hostedRun) {
            const expected = hostedRun.steps.shift();
            assert.ok(expected, `unexpected hosted request: ${method} ${target}`);
            assert.deepEqual(request, { method: expected.method, url: expected.url });
            hostedRequests.push(request);
            expected.check?.(options);
            return expected.response;
        }
        throw new Error(`Unexpected network request: ${method} ${target}`);
    };
    const owner = {
        document: window.document,
        AbortController,
        fetch,
        setTimeout: window.setTimeout.bind(window),
        clearTimeout: window.clearTimeout.bind(window),
        addEventListener: window.addEventListener.bind(window),
        removeEventListener: window.removeEventListener.bind(window),
        ZoteroPane: { getSelectedItems: () => [selectedItem] },
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
    const pathUtils = {
        join: path.join, parent: path.dirname, filename: path.basename,
        tempDir: path.join(profilePath, 'tmp'),
    };
    const prefs = new Map([
        ['extensions.mktero.cacheEnabled', true],
        ['extensions.mktero.conversionProvider', 'mktero'],
    ]);
    const zotero = {
        version: '9.0.6', locale: 'en-US', uiReadyPromise: Promise.resolve(),
        Profile: { dir: profilePath }, DataDirectory: { dir: profilePath },
        File: {
            pathToFile(filePath) {
                return {
                    path: filePath,
                    exists: () => existsSync(filePath),
                    isFile: () => statSync(filePath).isFile(),
                    get fileSize() { return statSync(filePath).size; },
                    get lastModifiedTime() { return statSync(filePath).mtimeMs; },
                };
            },
        },
        Session: { state: { windows: [] } },
        Prefs: {
            get: key => prefs.has(key) ? prefs.get(key) : '',
            set: (key, value) => prefs.set(key, value),
            clear: key => prefs.delete(key),
        },
        Items: {
            get: id => items.get(id), getAsync: async id => items.get(id),
            loadDataTypes: async () => {},
        },
        ItemTreeManager: {
            registerColumn(options) {
                readinessColumn = options;
                return 'mktero-markdownReady';
            },
            unregisterColumn() { readinessColumn = null; },
            refresh() {},
        },
        PreferencePanes: { register: async options => options.id, unregister() {} },
        Reader: { registerEventListener() {}, unregisterEventListener() {} },
        getMainWindow: () => owner,
        debug(message) {
            const started = /^Mktero: conversion started for item (\d+) /u.exec(message);
            if (!started) return;
            // The registry creates the controller and logs this start synchronously,
            // before the import awaits IO or PDF.js can create unrelated controllers.
            conversionStarts.push({ itemID: Number(started[1]), controller: controllers.at(-1) });
        },
        logError: error => errors.push(error),
    };
    const globals = {
        Zotero: zotero, IOUtils: ioUtils, PathUtils: pathUtils, fetch,
        AbortController: ObservedAbortController,
        Services: {
            obs: { addObserver() {}, removeObserver() {} },
            prompt: {
                confirm(ownerWindow, title, message) {
                    confirmations.push({ ownerWindow, title, message });
                    assert.equal(remoteReparsePromptAllowed, true, 'local import must never call Services.prompt.confirm');
                    return false;
                },
            },
        },
        __MKTERO_MARKDOWN_STYLES__: await fs.readFile(new URL('../ui/markdown.css', import.meta.url), 'utf8'),
    };
    const previous = new Map([...Object.keys(globals), 'startup', 'shutdown', 'install',
        'uninstall', 'onMainWindowLoad', 'onMainWindowUnload'].map(key => [key, globalThis[key]]));
    Object.assign(globalThis, globals);
    // Import the real presenter only after the bundled styles global is set.
    // Observe published identities while preserving every real view update.
    const { MarkdownTabPresenter } = await import('../src/ui/markdown-tab-presenter.js');
    const update = MarkdownTabPresenter.prototype.update;
    t.mock.method(MarkdownTabPresenter.prototype, 'update', function (presentation, changes) {
        const result = update.call(this, presentation, changes);
        if (changes.status === 'ready') {
            const { documentID, provider, parserProfile, cacheKey } = presentation.model;
            readyResults.push({ documentID, provider, parserProfile, cacheKey });
        }
        return result;
    });
    t.after(async () => {
        try {
            await globalThis.shutdown?.();
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

    const pdfData = new Uint8Array(await fs.readFile(new URL('./fixtures/offline-annotation.pdf', import.meta.url)));
    await fs.writeFile(pdfPath, pdfData);
    await fs.writeFile(secondPDFPath, pdfData);
    const sourcePath = path.join(profilePath, 'llm-for-zotero-mineru', String(attachment.id));
    const secondSourcePath = path.join(profilePath, 'llm-for-zotero-mineru', String(secondAttachment.id));
    await writeSourceCache(sourcePath, attachment, FIRST_TEXT);
    await writeSourceCache(secondSourcePath, secondAttachment, FIRST_TEXT);
    const adapters = { zotero, ioUtils, pathUtils };
    const cache = createZoteroMarkdownCache(adapters);
    const resultStore = createZoteroMinerUResultStore(adapters);
    const revisionStore = createZoteroMarkdownRevisionStore(adapters);
    const menu = window.document.getElementById('zotero-itemmenu');
    const indexPath = path.join(profilePath, 'mktero-imports', 'v1', 'index.json');
    const assertLocalRequests = () => {
        assert.deepEqual(requests.filter(request => request.url !== 'https://models.dev/api.json'
            && !hostedRequests.includes(request)), [],
            'only the explicit cache-miss conversion scenarios may make account or conversion requests');
    };
    const readSelections = () => createZoteroMinerUImportIndex(adapters).load();
    const readSelection = async (target = attachment) => {
        const index = createZoteroMinerUImportIndex(adapters);
        await index.load();
        return index.peekForAttachment({ libraryID: target.libraryID, attachmentKey: target.key });
    };
    const columnValue = target => {
        assert.ok(readinessColumn, 'bootstrap must register its readiness column');
        return readinessColumn.dataProvider(target);
    };
    const waitForReadiness = (target, expected) => waitFor(() => columnValue(target) === expected,
        `readiness ${JSON.stringify(expected)} for ${target.key}`);
    const openMenu = () => menu.dispatchEvent(new window.Event('popupshowing', { bubbles: true }));
    const closeMenu = () => menu.dispatchEvent(new window.Event('popuphidden', { bubbles: true }));
    const waitForImportCommand = async (target = parent) => {
        selectedItem = target;
        openMenu();
        try {
            const command = await waitFor(() => {
                const element = window.document.getElementById('mktero-import-llm-cache');
                return element && !element.hidden && !element.disabled ? element : null;
            }, 'the parent item import command');
            assert.equal(window.document.getElementById('mktero-import-llm-cache-options').hidden, true);
            return command;
        }
        finally {
            closeMenu();
        }
    };
    const importFromParent = async (target = parent) => {
        const command = await waitForImportCommand(target);
        command.dispatchEvent(new window.Event('command', { bubbles: true }));
    };
    const reopenFromParent = async (target = parent) => {
        assert.equal(tabs.size, 0);
        selectedItem = target;
        openMenu();
        const command = window.document.getElementById('mktero-read-as-markdown');
        assert.equal(command.hidden, false);
        closeMenu();
        command.dispatchEvent(new window.Event('command', { bubbles: true }));
        return waitFor(() => [...tabs.values()][0]?.container.querySelector('.mktero-tab-host')?.shadowRoot,
            'a normal Markdown tab');
    };
    const closeTab = () => {
        for (const id of [...tabs.keys()]) owner.Zotero_Tabs.close(id);
        assert.equal(tabs.size, 0);
    };
    const readyText = async (shadow, expected) => {
        await waitFor(() => shadow.querySelector('.cm-content')?.textContent.includes(expected)
            && shadow.querySelector('#mktero-content')?.getAttribute('aria-busy') === 'false',
        `a ready document containing ${expected}`);
        assert.equal(shadow.querySelector('.message.error').hidden, true);
        assert.equal(shadow.querySelector('.cm-content').getAttribute('contenteditable'), 'false');
        assertLocalRequests();
    };

    const beginHostedConversion = ({ failed = false, text = '' } = {}) => {
        assert.equal(hostedRun, null);
        const jobID = failed ? 'job_cache_miss_failure' : 'job_cache_miss_success';
        const apiURL = 'http://127.0.0.1:8080/api/v1/conversions';
        const jobURL = `${apiURL}/${jobID}`;
        const uploadURL = `https://storage.example/${jobID}/upload`;
        const resultURL = `https://storage.example/${jobID}/result.zip`;
        const json = (status, body) => new Response(JSON.stringify(body), {
            status, headers: { 'content-type': 'application/json' },
        });
        const authenticated = options => assert.equal(options.headers.Authorization, 'Bearer test-access-token');
        const sessionPrefs = {
            accountEmail: 'reader@example.com',
            accountAccessToken: 'test-access-token',
            accountRefreshToken: 'test-refresh-token',
            accountAccessExpiresAtMs: String(Date.now() + 3600_000),
        };
        const previousPrefs = new Map(Object.keys(sessionPrefs).map(name => {
            const key = `extensions.mktero.${name}`;
            const value = prefs.get(key);
            prefs.set(key, sessionPrefs[name]);
            return [key, value];
        }));
        const steps = [
            {
                method: 'POST', url: apiURL,
                response: json(201, { job_id: jobID, status: 'awaiting_upload', upload_url: uploadURL, upload_method: 'PUT' }),
                check(options) {
                    authenticated(options);
                    const body = JSON.parse(options.body);
                    assert.equal(body.filename, attachment.attachmentFilename);
                    assert.equal(body.size, pdfData.byteLength);
                    assert.equal(body.content_type, 'application/pdf');
                    assert.equal(body.sha256, updatedSelection.sourceHash);
                },
            },
            {
                method: 'PUT', url: uploadURL, response: new Response(null, { status: 200 }),
                check(options) {
                    assert.deepEqual(new Uint8Array(options.body), pdfData);
                    assert.equal(options.headers.Authorization, undefined);
                },
            },
            {
                method: 'POST', url: `${jobURL}/complete`, check: authenticated,
                response: json(202, { job_id: jobID, status: 'queued' }),
            },
            {
                method: 'GET', url: jobURL, check: authenticated,
                response: json(200, failed
                    ? { job_id: jobID, status: 'failed', error_code: 'MINERU_TASK_FAILED' }
                    : { job_id: jobID, status: 'succeeded', progress: 100 }),
            },
        ];
        if (failed) {
            steps.push({ method: 'DELETE', url: jobURL, check: authenticated,
                response: json(200, { job_id: jobID, status: 'failed' }) });
        }
        else {
            const archive = zipSync({
                'full.md': strToU8(text),
                'content_list.json': strToU8(JSON.stringify([
                    { type: 'text', text, page_idx: 0, bbox: [100, 100, 900, 200] },
                ])),
            });
            steps.push(
                { method: 'GET', url: `${jobURL}/result-url`, check: authenticated,
                    response: json(200, { result_url: resultURL, method: 'GET' }) },
                { method: 'GET', url: resultURL, response: new Response(archive),
                    check: options => assert.equal(options.headers.Authorization, undefined) }
            );
        }
        const run = { steps, requestStart: hostedRequests.length };
        hostedRun = run;
        return {
            ...run,
            restore() {
                hostedRun = null;
                for (const [key, value] of previousPrefs) {
                    if (value === undefined) prefs.delete(key);
                    else prefs.set(key, value);
                }
            },
        };
    };

    const newRegressionPDF = async (id, text) => {
        const targetPath = path.join(profilePath, `paper-${id}.pdf`);
        const targetParent = { ...parent, id: id - 1, key: `PARENT${id - 1}`, getAttachments: () => [id] };
        const targetAttachment = {
            ...attachment, id, key: `PDFKEY${id}`, parentItemID: targetParent.id, parentItem: targetParent,
            getFilePath: () => targetPath, getFilePathAsync: async () => targetPath,
        };
        items.set(targetParent.id, targetParent);
        items.set(id, targetAttachment);
        await fs.writeFile(targetPath, pdfData);
        const targetSource = path.join(profilePath, 'llm-for-zotero-mineru', String(id));
        await writeSourceCache(targetSource, targetAttachment, text);
        return { parent: targetParent, attachment: targetAttachment, sourcePath: targetSource, text };
    };
    const currentShadow = () => [...tabs.values()][0]?.container
        .querySelector('.mktero-tab-host')?.shadowRoot;
    const importReadyRegressionPDF = async target => {
        closeTab();
        await importFromParent(target.parent);
        const shadow = await waitFor(currentShadow, 'the regression attachment tab');
        await readyText(shadow, target.text);
        return shadow;
    };
    const editDraft = (shadow, replacement) => {
        shadow.querySelector('#mktero-correction-toggle').click();
        const content = shadow.querySelector('.cm-content');
        const view = EditorView.findFromDOM(shadow.querySelector('.cm-editor'));
        view.posAtCoords = () => 2;
        content.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true, button: 0 }));
        assert.equal(content.getAttribute('contenteditable'), 'true');
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: replacement } });
    };

    await import('../src/bootstrap.js?llm-cache-import-integration');
    await globalThis.startup(STARTUP_OPTIONS);
    let firstSelection;
    let secondSelection;
    let firstIdentity;
    let updatedSelection;
    let updatedIdentity;
    let firstShadow;
    let firstTabID;

    await t.test('imports directly from the parent menu without a native confirmation', async () => {
        assert.equal(window.document.getElementById('mktero-import-llm-cache').hidden, true);
        assert.equal(columnValue(attachment), '');
        assert.equal(await ioUtils.exists(indexPath), false);
        assert.deepEqual(await readSelections(), []);
        assert.equal((await resultStore.getStats()).entries, 0);
        assert.equal((await cache.getStats()).entries, 0);
        assert.deepEqual(await cache.listReadableEntries(), []);
        await importFromParent();
        firstShadow = await waitFor(() => [...tabs.values()][0]?.container
            .querySelector('.mktero-tab-host')?.shadowRoot, 'the imported Markdown tab');
        firstTabID = [...tabs.keys()][0];
        await readyText(firstShadow, FIRST_TEXT);
        assert.equal(tabs.size, 1);
        assert.equal(serial, 1, 'the menu command must directly open one ready import tab');
        assert.equal(confirmations.length, 0, 'clicking the import menu must not open a native confirmation');
        assert.deepEqual(errors, []);
    });

    await t.test('persists the explicit menu selection and both imported stores without a confirmation', async () => {
        await readyText(firstShadow, FIRST_TEXT);
        assert.equal(tabs.size, 1);
        assert.equal(confirmations.length, 0);
        firstSelection = await readSelection();
        assert.equal(firstSelection.libraryID, attachment.libraryID);
        assert.equal(firstSelection.attachmentKey, attachment.key);
        assert.equal(firstSelection.sourceHash, await sha256Hex(pdfData));
        assert.equal(firstSelection.binding, 'user-confirmed');
        assert.equal(firstSelection.sourceFormat, 'v2');
        firstIdentity = await createLLMCacheIdentity({ fileData: pdfData, snapshotHash: firstSelection.snapshotHash });
        assert.equal(firstSelection.rawKey, firstIdentity.rawKey);
        const stored = await resultStore.get(firstIdentity.rawKey);
        assert.equal(stored.provider, 'llm-for-zotero');
        assert.equal(stored.totalPages, 1);
        assert.equal(stored.extractedPages, 1);
        const archive = unzipSync(stored.archive);
        assert.equal(strFromU8(archive['full.md']), FIRST_TEXT);
        assert.equal(JSON.parse(strFromU8(archive['content_list.json']))[0].text, FIRST_TEXT);
        assert.equal(Object.keys(archive).some(name => name.endsWith('.pdf')), false);
        const derived = await cache.get(firstIdentity.cacheKey);
        assert.ok(derived.markdown.includes(FIRST_TEXT));
        assert.ok(derived.sourceMap.some(entry => entry.locations.some(location => location.pageIndex === 0)));
        const persisted = JSON.parse(await fs.readFile(indexPath, 'utf8'));
        assert.deepEqual(persisted.records, [firstSelection]);
        await waitForReadiness(attachment, '1');
        assert.equal(columnValue(parent), '1');
        assert.equal(columnValue(secondAttachment), '', 'sharing PDF bytes must not select an import for another attachment');
        assert.equal(columnValue(secondParent), '');
        assert.deepEqual(errors, []);
    });

    await t.test('rejects a reimport whose source changes during verification and preserves the ready selection', async () => {
        await writeSourceCache(sourcePath, attachment, UPDATED_TEXT);
        const previousIndex = await fs.readFile(indexPath, 'utf8');
        const previousSerial = serial;
        const errorCount = errors.length;
        const runStart = conversionStarts.length;
        let sourceReads = 0;
        const markdownPath = path.join(sourcePath, 'full.md');
        // The first two reads capture and recheck the snapshot. Pause its later
        // verification so a real source change invalidates the captured bytes.
        const gate = gateIO(ioUtils, 'read', file => file === markdownPath
            && conversionStarts.slice(runStart).some(run => run.itemID === attachment.id)
            && ++sourceReads === 3);
        try {
            await importFromParent();
            await waitFor(() => gate.entered, 'the captured source snapshot verification');
            assert.equal(firstShadow.querySelector('#mktero-content').getAttribute('aria-busy'), 'true');
            assert.equal(confirmations.length, 0, 'reimport must reach verification without a native confirmation');
            assert.deepEqual(await readSelection(), firstSelection);
            await fs.appendFile(markdownPath, '\nThe source changed after capture.');
            gate.release();
            await waitFor(() => errors.slice(errorCount).some(error => error.code === 'LLM_CACHE_CHANGED'),
                'the changed source to reject the reimport');
            await readyText(firstShadow, FIRST_TEXT);
            assert.equal(tabs.size, 1);
            assert.equal(serial, previousSerial, 'a failed reimport must reuse the existing tab');
            assert.equal(tabs.get(firstTabID).container.querySelector('.mktero-tab-host').shadowRoot, firstShadow);
            assert.equal(firstShadow.querySelector('.cm-content').textContent.includes(UPDATED_TEXT), false);
            assert.ok(firstShadow.querySelector('.message.warning').textContent.includes(translateEnglish('importLLM.changed')));
            assert.deepEqual(await readSelection(), firstSelection);
            assert.equal(await fs.readFile(indexPath, 'utf8'), previousIndex);
            assert.equal((await resultStore.getStats()).entries, 1);
            assert.equal((await cache.getStats()).entries, 1);
            assert.equal(strFromU8(unzipSync((await resultStore.get(firstIdentity.rawKey)).archive)['full.md']), FIRST_TEXT);
            assert.ok((await cache.get(firstIdentity.cacheKey)).markdown.includes(FIRST_TEXT));
            await waitForReadiness(attachment, '1');
            assert.equal(columnValue(parent), '1');
            assert.equal(confirmations.length, 0);
            assert.deepEqual(errors.slice(errorCount).map(error => error.code), ['LLM_CACHE_CHANGED']);
            errors.splice(errorCount);
        }
        finally {
            await gate.restore();
            await waitForImportCommand();
        }
    });

    await t.test('imports the same cache for a second attachment with an independent selection', async () => {
        await importFromParent(secondParent);
        const secondTabID = await waitFor(() => [...tabs.keys()].find(id => id !== firstTabID),
            'a separate tab for the second attachment');
        const shadow = await waitFor(() => tabs.get(secondTabID)?.container
            .querySelector('.mktero-tab-host')?.shadowRoot, 'the second imported document');
        await readyText(shadow, FIRST_TEXT);
        assert.equal(tabs.size, 2);
        assert.equal(confirmations.length, 0);
        secondSelection = await readSelection(secondAttachment);
        assert.equal(secondSelection.attachmentKey, secondAttachment.key);
        assert.equal(secondSelection.libraryID, secondAttachment.libraryID);
        assert.equal(secondSelection.sourceHash, firstSelection.sourceHash);
        assert.equal(secondSelection.snapshotHash, firstSelection.snapshotHash);
        assert.equal(secondSelection.rawKey, firstSelection.rawKey);
        assert.deepEqual(await readSelection(), firstSelection);
        assert.equal((await readSelections()).length, 2);
        assert.equal((await resultStore.getStats()).entries, 1);
        assert.equal((await cache.getStats()).entries, 1);
        await waitForReadiness(secondAttachment, '1');
        assert.equal(columnValue(secondParent), '1');
        assert.equal(columnValue(attachment), '1');
        owner.Zotero_Tabs.close(secondTabID);
        assert.equal(tabs.size, 1);
        await readyText(firstShadow, FIRST_TEXT);
        assert.deepEqual(errors, []);
    });

    await t.test('reimports into the same ready tab and publishes the updated content', async () => {
        await writeSourceCache(sourcePath, attachment, UPDATED_TEXT);
        const previousSerial = serial;
        await importFromParent();
        await readyText(firstShadow, UPDATED_TEXT);
        assert.equal(tabs.size, 1);
        assert.equal(serial, previousSerial, 'reimport must reuse the existing PDF tab');
        assert.equal(tabs.get(firstTabID).container.querySelector('.mktero-tab-host').shadowRoot, firstShadow);
        assert.equal(firstShadow.querySelector('.cm-content').textContent.includes(FIRST_TEXT), false);
        assert.equal(confirmations.length, 0);
        updatedSelection = await readSelection();
        assert.equal(updatedSelection.sourceHash, firstSelection.sourceHash);
        assert.notEqual(updatedSelection.snapshotHash, firstSelection.snapshotHash);
        assert.notEqual(updatedSelection.rawKey, firstSelection.rawKey);
        updatedIdentity = await createLLMCacheIdentity({ fileData: pdfData, snapshotHash: updatedSelection.snapshotHash });
        const raw = await resultStore.get(updatedSelection.rawKey);
        assert.equal(strFromU8(unzipSync(raw.archive)['full.md']), UPDATED_TEXT);
        assert.ok((await cache.get(updatedIdentity.cacheKey)).markdown.includes(UPDATED_TEXT));
        assert.deepEqual(await readSelection(secondAttachment), secondSelection);
        assert.equal(strFromU8(unzipSync((await resultStore.get(secondSelection.rawKey)).archive)['full.md']), FIRST_TEXT);
        await waitForReadiness(attachment, '1');
        assert.equal(columnValue(parent), '1');
        assert.equal(columnValue(secondAttachment), '1');
        const readiness = JSON.parse(await fs.readFile(path.join(profilePath, 'mktero-readiness', 'v1', 'index.json'), 'utf8'));
        assert.ok(readiness.records.some(record => record.attachmentKey === attachment.key
            && record.cacheKey === updatedIdentity.cacheKey && record.parserProfile === updatedIdentity.parserProfile));
        assert.ok(readiness.records.some(record => record.attachmentKey === secondAttachment.key
            && record.cacheKey === firstIdentity.cacheKey && record.parserProfile === firstIdentity.parserProfile));
        assert.deepEqual(errors, []);
    });

    await t.test('reopens the copied document after removing the temporary source cache and restarting bootstrap', async () => {
        closeTab();
        await fs.rm(sourcePath, { recursive: true });
        await fs.rm(secondSourcePath, { recursive: true });
        assert.equal(await ioUtils.exists(sourcePath), false);
        assert.equal(await ioUtils.exists(pdfPath), true);
        await globalThis.shutdown();
        await globalThis.startup(STARTUP_OPTIONS);
        const shadow = await reopenFromParent();
        await readyText(shadow, UPDATED_TEXT);
        await waitFor(() => window.document.getElementById('mktero-import-llm-cache').hidden,
            'the missing-source import command to stay hidden');
        assert.deepEqual(await readSelection(), updatedSelection);
        assert.deepEqual(await readSelection(secondAttachment), secondSelection);
        await waitForReadiness(attachment, '1');
        assert.equal(columnValue(parent), '1');
        await waitForReadiness(secondAttachment, '1');
        assert.equal(confirmations.length, 0);
        assert.deepEqual(errors, []);
    });

    await t.test('readiness follows each selected snapshot when another imported profile remains cached', async () => {
        closeTab();
        await globalThis.shutdown();
        await fs.rm(path.join(cache.rootPath, 'entries', updatedIdentity.cacheKey), { recursive: true });
        assert.equal(await cache.get(updatedIdentity.cacheKey), null);
        assert.ok((await cache.get(firstIdentity.cacheKey)).markdown.includes(FIRST_TEXT));
        await globalThis.startup(STARTUP_OPTIONS);
        await waitForReadiness(secondAttachment, '1');
        await waitForReadiness(attachment, '');
        assert.equal(columnValue(parent), '', 'an older cached profile must not mark the selected new snapshot ready');
        assert.equal(columnValue(secondParent), '1');
        selectedItem = parent;
        openMenu();
        assert.equal(window.document.getElementById('mktero-export-obsidian').hidden, true);
        closeMenu();
        selectedItem = secondParent;
        openMenu();
        assert.equal(window.document.getElementById('mktero-export-obsidian').hidden, false);
        closeMenu();
        const shadow = await reopenFromParent(secondParent);
        await readyText(shadow, FIRST_TEXT);
        assert.equal(shadow.querySelector('.cm-content').textContent.includes(UPDATED_TEXT), false);
        assert.deepEqual(await readSelection(), updatedSelection);
        assert.deepEqual(await readSelection(secondAttachment), secondSelection);
        closeTab();
        const restoredShadow = await reopenFromParent();
        await readyText(restoredShadow, UPDATED_TEXT);
        await waitForReadiness(attachment, '1');
        assert.equal(columnValue(parent), '1');
        assert.equal(columnValue(secondAttachment), '1');
        assert.equal(confirmations.length, 0);
        assert.deepEqual(errors, []);
    });

    await t.test('rebuilds the derived Markdown offline from the imported raw copy', async () => {
        closeTab();
        await cache.clear();
        assert.equal(await cache.get(updatedIdentity.cacheKey), null);
        assert.ok(await resultStore.get(updatedSelection.rawKey));
        const shadow = await reopenFromParent();
        await readyText(shadow, UPDATED_TEXT);
        assert.ok((await cache.get(updatedIdentity.cacheKey)).markdown.includes(UPDATED_TEXT));
        assert.deepEqual(await readSelection(), updatedSelection);
        assert.deepEqual(await readSelection(secondAttachment), secondSelection);
        assert.equal(confirmations.length, 0);
        assert.deepEqual(errors, []);
    });

    await t.test('keeps a selected imported correction on disk and never uploads when its revision cannot be read', async () => {
        const target = await newRegressionPDF(64, 'Original imported article with a saved correction on disk.');
        const readUTF8 = ioUtils.readUTF8;
        let run;
        try {
            const shadow = await importReadyRegressionPDF(target);
            const selection = await readSelection(target.attachment);
            const identity = await createLLMCacheIdentity({ fileData: pdfData, snapshotHash: selection.snapshotHash });
            const entryPath = path.join(revisionStore.rootPath, 'entries', identity.cacheKey);
            const metadataPath = path.join(entryPath, 'metadata.json');
            const correction = 'This saved imported correction must survive a temporary disk read failure.';
            editDraft(shadow, correction);
            shadow.querySelector('.mktero-correction-editor-save').click();
            await waitFor(() => shadow.querySelector('.mktero-correction-editor-toolbar')?.hidden,
                'the imported correction to finish saving');
            await readyText(shadow, correction);
            const savedRevision = await revisionStore.load(identity.cacheKey);
            assert.equal(savedRevision.corrections.length, 1);
            assert.equal(savedRevision.corrections[0].replacementMarkdown, correction);
            const metadata = await fs.readFile(metadataPath, 'utf8');
            const correctionsPath = path.join(entryPath, JSON.parse(metadata).correctionsFile);
            const corrections = await fs.readFile(correctionsPath, 'utf8');
            const revisionFiles = (await fs.readdir(entryPath, { recursive: true })).sort();
            closeTab();
            await fs.rm(path.join(cache.rootPath, 'entries', identity.cacheKey), { recursive: true });
            await fs.rm(path.join(resultStore.rootPath, 'entries', identity.rawKey), { recursive: true });
            await fs.rm(target.sourcePath, { recursive: true });
            assert.equal(await cache.get(identity.cacheKey), null);
            assert.equal(await resultStore.get(identity.rawKey), null);
            assert.equal(await ioUtils.exists(target.sourcePath), false);
            assert.equal(await cache.get(await createMinerUCacheKey(pdfData)), null,
                'there must be no current provider result to mask an erroneous conversion fallback');
            const previousIndex = await fs.readFile(indexPath, 'utf8');
            const errorCount = errors.length;
            const requestCount = requests.length;
            const publishedCount = readyResults.length;
            const diskError = Object.assign(new Error('The imported correction metadata could not be read'), { code: 'EIO' });
            let readAttempts = 0;
            ioUtils.readUTF8 = async (file, ...options) => {
                if (file === metadataPath) {
                    readAttempts++;
                    throw diskError;
                }
                return readUTF8(file, ...options);
            };
            // Supply a signed-in fake hosted provider so an incorrect fallback
            // reaches the actual upload path and cannot hide behind missing auth.
            run = beginHostedConversion({ failed: true });
            const failedShadow = await reopenFromParent(target.parent);
            const error = await waitFor(() => {
                const element = failedShadow.querySelector('.message.error');
                return element && !element.hidden && element.textContent.trim() ? element : null;
            }, 'the saved imported revision read error');
            assert.ok(readAttempts > 0, 'normal reading must attempt to load the real saved revision');
            assert.deepEqual(requests.slice(requestCount).filter(request => request.url !== 'https://models.dev/api.json'), [],
                'a revision read error must never start an account, upload, poll, or result request');
            assert.equal(hostedRequests.length, run.requestStart);
            assert.equal(run.steps.length, 5, 'the fake Mktero HTTP responses must remain unused');
            assert.equal(error.querySelector('.message-body').textContent, translateEnglish('error.conversionFailed'));
            assert.equal(failedShadow.querySelector('#mktero-content').getAttribute('aria-busy'), 'false');
            assert.equal(failedShadow.querySelector('.cm-content').textContent.includes(target.text), false);
            assert.equal(failedShadow.querySelector('.cm-content').textContent.includes(correction), false);
            assert.equal(readyResults.length, publishedCount, 'unreadable corrections must not publish another document');
            assert.ok(errors.slice(errorCount).includes(diskError));
            assert.deepEqual(await readSelection(target.attachment), selection);
            assert.equal(await fs.readFile(indexPath, 'utf8'), previousIndex);
            assert.deepEqual((await fs.readdir(entryPath, { recursive: true })).sort(), revisionFiles);
            assert.equal(await fs.readFile(metadataPath, 'utf8'), metadata);
            assert.equal(await fs.readFile(correctionsPath, 'utf8'), corrections);
            assert.equal(confirmations.length, 0);

            ioUtils.readUTF8 = readUTF8;
            closeTab();
            const reopened = await reopenFromParent(target.parent);
            await readyText(reopened, correction);
            assert.deepEqual(await revisionStore.load(identity.cacheKey), savedRevision);
            assert.deepEqual(await readSelection(target.attachment), selection);
            assert.equal(await fs.readFile(indexPath, 'utf8'), previousIndex);
            assert.equal(reopened.querySelector('.message.warning').hidden, true);
            assert.deepEqual(readyResults.slice(publishedCount), [{
                documentID: target.attachment.id, provider: 'llm-for-zotero',
                parserProfile: identity.parserProfile, cacheKey: identity.cacheKey,
            }]);
            assert.deepEqual(requests.slice(requestCount).filter(request => request.url !== 'https://models.dev/api.json'), [],
                'restoring revision reads must reopen the saved correction without remote conversion');
            assert.equal(confirmations.length, 0);
        }
        finally {
            ioUtils.readUTF8 = readUTF8;
            closeTab();
            run?.restore();
        }
    });

    await t.test('shows the current Mktero conversion error after both imported copies are cleared and retains the selection', async () => {
        closeTab();
        await cache.clear();
        await resultStore.clear();
        assert.equal(await ioUtils.exists(sourcePath), false);
        assert.equal(await cache.get(updatedIdentity.cacheKey), null);
        assert.equal(await resultStore.get(updatedSelection.rawKey), null);
        const previousIndex = await fs.readFile(indexPath, 'utf8');
        const errorCount = errors.length;
        const publishedCount = readyResults.length;
        const run = beginHostedConversion({ failed: true });
        try {
            const shadow = await reopenFromParent();
            const error = await waitFor(() => {
                const element = shadow.querySelector('.message.error');
                return element && !element.hidden && element.textContent.trim() ? element : null;
            }, 'the ordinary conversion error after the imported content expires');
            assert.equal(error.querySelector('.message-body').textContent, translateEnglish('error.mkteroConversionFailed'));
            assert.equal(shadow.querySelector('#mktero-content').getAttribute('aria-busy'), 'false');
            assert.equal(shadow.querySelector('.cm-content').textContent.includes(UPDATED_TEXT), false);
            assert.equal(shadow.querySelector('#mktero-error-retry').textContent, translateEnglish('viewer.retryConversion'));
            assert.equal(readyResults.length, publishedCount, 'a failed fallback must not publish a document');
            await waitFor(() => run.steps.length === 0, 'the failed hosted job cleanup');
            assert.equal(hostedRequests.length - run.requestStart, 5, 'the real Mktero upload and poll path must run');
            assert.deepEqual(errors.slice(errorCount).map(value => value.code), ['MKTERO_CONVERSION_FAILED']);
            assert.deepEqual(await readSelection(), updatedSelection);
            assert.deepEqual(await readSelection(secondAttachment), secondSelection);
            assert.equal(await fs.readFile(indexPath, 'utf8'), previousIndex);
            assert.equal(await cache.get(updatedIdentity.cacheKey), null);
            assert.equal(await resultStore.get(updatedSelection.rawKey), null);
            assert.equal(confirmations.length, 0, 'ordinary reading must start the configured conversion without an import prompt');
            assertLocalRequests();
        }
        finally {
            closeTab();
            run.restore();
        }
    });

    await t.test('converts through the current Mktero provider on an import cache miss and reopens its result offline after restart', async () => {
        assert.equal(await ioUtils.exists(sourcePath), false);
        assert.equal(await cache.get(updatedIdentity.cacheKey), null);
        assert.equal(await resultStore.get(updatedSelection.rawKey), null);
        assert.deepEqual(await readSelection(), updatedSelection);
        const text = 'The current Mktero service converted the PDF after both imported copies were cleared.';
        const providerCacheKey = await createMinerUCacheKey(pdfData);
        const errorCount = errors.length;
        const publishedCount = readyResults.length;
        const run = beginHostedConversion({ text });
        try {
            const shadow = await reopenFromParent();
            await readyText(shadow, text);
            assert.equal(run.steps.length, 0, 'the real Mktero client must upload, poll, and download its ZIP');
            assert.equal(hostedRequests.length - run.requestStart, 6);
            assert.deepEqual(readyResults.slice(publishedCount), [{
                documentID: attachment.id, provider: 'mktero',
                parserProfile: MINERU_PARSER_PROFILE_ID, cacheKey: providerCacheKey,
            }]);
            assert.equal(shadow.querySelector('.cm-content').textContent.includes(UPDATED_TEXT), false);
            assert.equal(await readSelection(), null, 'a successful fallback must forget the old attachment selection');
            const persisted = JSON.parse(await fs.readFile(indexPath, 'utf8'));
            assert.equal(persisted.records.some(record => record.attachmentKey === attachment.key), false);
            assert.deepEqual(await readSelection(secondAttachment), secondSelection, 'the other attachment keeps its independent selection');
            assert.equal(await cache.get(updatedIdentity.cacheKey), null);
            assert.ok((await cache.get(providerCacheKey)).markdown.includes(text));
            await waitForReadiness(attachment, '1');
            assert.equal(columnValue(parent), '1');
            await waitFor(async () => {
                const readiness = JSON.parse(await fs.readFile(path.join(profilePath, 'mktero-readiness', 'v1', 'index.json'), 'utf8'));
                return readiness.records.some(record => record.attachmentKey === attachment.key
                    && record.cacheKey === providerCacheKey && record.parserProfile === MINERU_PARSER_PROFILE_ID);
            }, 'the current provider readiness to reach disk');
            assert.equal(confirmations.length, 0);
            assert.deepEqual(errors.slice(errorCount), []);
        }
        finally {
            closeTab();
            run.restore();
        }
        const requestCount = requests.length;
        const reopenedCount = readyResults.length;
        await globalThis.shutdown();
        await globalThis.startup(STARTUP_OPTIONS);
        try {
            const shadow = await reopenFromParent();
            await readyText(shadow, text);
            assert.deepEqual(readyResults.slice(reopenedCount), [{
                documentID: attachment.id, provider: 'mktero',
                parserProfile: MINERU_PARSER_PROFILE_ID, cacheKey: providerCacheKey,
            }]);
            assert.deepEqual(requests.slice(requestCount).filter(request => request.url !== 'https://models.dev/api.json'), [],
                'reopening must use the current provider cache without any account, upload, or result request');
            assert.equal(await ioUtils.exists(sourcePath), false);
            assert.equal(await readSelection(), null);
            assert.deepEqual(await readSelection(secondAttachment), secondSelection);
            await waitForReadiness(attachment, '1');
            assert.equal(confirmations.length, 0);
            assert.deepEqual(errors.slice(errorCount), []);
        }
        finally {
            closeTab();
        }
    });

    await t.test('saves a real pending correction before importing and preserves it after source failure and reopening', async () => {
        const target = await newRegressionPDF(46, 'Original article before its pending correction.');
        const shadow = await importReadyRegressionPDF(target);
        const selection = await readSelection(target.attachment);
        const identity = await createLLMCacheIdentity({ fileData: pdfData, snapshotHash: selection.snapshotHash });
        const entryPath = path.join(revisionStore.rootPath, 'entries', identity.cacheKey);
        const metadataPath = path.join(entryPath, 'metadata.json');
        const markdownPath = path.join(target.sourcePath, 'full.md');
        const draft = 'Saved draft survives a failed local import and reopening its tab.';
        const errorCount = errors.length;
        const previousSerial = serial;
        const previousIndex = await fs.readFile(indexPath, 'utf8');
        editDraft(shadow, draft);
        assert.equal(await revisionStore.load(identity.cacheKey), null, 'editing alone must leave a genuine unsaved draft');
        await writeSourceCache(target.sourcePath, target.attachment, 'Replacement whose source will change during import.');
        const runStart = conversionStarts.length;
        const targetRun = () => conversionStarts.slice(runStart).find(run => run.itemID === target.attachment.id);
        const draftGate = gateIO(ioUtils, 'writeUTF8', file => file === metadataPath);
        const sourceGate = gateIO(ioUtils, 'read', file => file === markdownPath && targetRun());
        try {
            await importFromParent(target.parent);
            await waitFor(() => draftGate.entered, 'the pending correction metadata write');
            assert.equal(confirmations.length, 0);
            assert.equal(targetRun(), undefined, 'the import must wait for the draft to reach disk before starting');
            assert.equal(sourceGate.entered, false, 'the import must not read its source while the draft is being saved');
            assert.equal(shadow.querySelector('#mktero-content').getAttribute('aria-busy'), 'false');
            assert.equal(shadow.querySelector('.cm-content').textContent, draft);
            assert.equal(await ioUtils.exists(metadataPath), false);
            draftGate.release();
            await waitFor(() => sourceGate.entered, 'the import source read after saving the pending correction');
            assert.equal(shadow.querySelector('#mktero-content').getAttribute('aria-busy'), 'true');
            const revision = await revisionStore.load(identity.cacheKey);
            assert.equal(revision.corrections.length, 1);
            assert.equal(revision.corrections[0].replacementMarkdown, draft);
            assert.equal(confirmations.length, 0, 'saving a draft must lead straight to the local import');
            await fs.appendFile(markdownPath, '\nSource invalidated after saving the pending correction.');
            sourceGate.release();
            await waitFor(() => errors.slice(errorCount).some(error => error.code === 'LLM_CACHE_CHANGED'),
                'the changed source to fail after saving the draft');
            await readyText(shadow, draft);
            assert.equal(serial, previousSerial);
            assert.equal(tabs.size, 1);
            assert.deepEqual(await readSelection(target.attachment), selection);
            assert.equal(await fs.readFile(indexPath, 'utf8'), previousIndex);
            assert.equal((await cache.get(identity.cacheKey)).markdown.includes(draft), false,
                'corrections must not overwrite the imported OCR cache');
            closeTab();
            const reopened = await reopenFromParent(target.parent);
            await readyText(reopened, draft);
            assert.equal((await revisionStore.load(identity.cacheKey)).corrections[0].replacementMarkdown, draft);
            assert.deepEqual(await readSelection(target.attachment), selection);
            assert.equal(confirmations.length, 0);
            assert.deepEqual(errors.slice(errorCount).map(error => error.code), ['LLM_CACHE_CHANGED']);
        }
        finally {
            closeTab();
            await Promise.all([sourceGate.restore(), draftGate.restore()]);
            await waitForImportCommand(target.parent);
        }
    });

    await t.test('stops a reimport when saving its real pending correction fails and leaves the draft editable', async t => {
        const target = await newRegressionPDF(48, 'Original article before a failed correction save.');
        const shadow = await importReadyRegressionPDF(target);
        const selection = await readSelection(target.attachment);
        const identity = await createLLMCacheIdentity({ fileData: pdfData, snapshotHash: selection.snapshotHash });
        const entryPath = path.join(revisionStore.rootPath, 'entries', identity.cacheKey);
        const draft = 'This pending correction must survive its failed save.';
        const errorCount = errors.length;
        const diskError = new Error('The correction file could not be written');
        const write = ioUtils.writeUTF8;
        let attempted = false;
        editDraft(shadow, draft);
        ioUtils.writeUTF8 = async (file, ...options) => {
            if (file.startsWith(`${entryPath}${path.sep}`) && path.basename(file).startsWith('corrections-')) {
                attempted = true;
                throw diskError;
            }
            return write(file, ...options);
        };
        t.after(() => { ioUtils.writeUTF8 = write; });
        await importFromParent(target.parent);
        await waitFor(() => attempted && !window.document.getElementById('mktero-import-llm-cache').disabled,
            'the failed draft save to stop the import');
        assert.equal(confirmations.length, 0, 'a failed correction save must stop before the local import starts');
        assert.equal(shadow.querySelector('#mktero-content').getAttribute('aria-busy'), 'false');
        assert.equal(shadow.querySelector('.cm-content').getAttribute('contenteditable'), 'true');
        assert.equal(shadow.querySelector('.cm-content').textContent, draft);
        assert.equal(await revisionStore.load(identity.cacheKey), null);
        assert.deepEqual(await readSelection(target.attachment), selection);
        assert.ok(errors.slice(errorCount).includes(diskError));
        assertLocalRequests();
        ioUtils.writeUTF8 = write;
        shadow.querySelector('.mktero-correction-editor-save').click();
        await waitFor(() => shadow.querySelector('.mktero-correction-editor-toolbar')?.hidden,
            'the correction to finish saving after the disk recovers');
        await readyText(shadow, draft);
        assert.equal((await revisionStore.load(identity.cacheKey)).corrections[0].replacementMarkdown, draft);
    });

    for (const stage of ['read', 'write']) {
        for (const closing of ['tab', 'owner']) {
            await t.test(`aborts an import paused during ${stage} when its ${closing} closes without publishing a new selection`, async () => {
                const id = 50 + (stage === 'write' ? 4 : 0) + (closing === 'owner' ? 2 : 0);
                const target = await newRegressionPDF(id, `Original ${stage} ${closing} article before cancellation.`);
                let gate;
                let backgroundPDF;
                try {
                    await importReadyRegressionPDF(target);
                    const selection = await readSelection(target.attachment);
                    const previousIndex = await fs.readFile(indexPath, 'utf8');
                    const errorCount = errors.length;
                    const controllerStart = controllers.length;
                    // A real PDF.js task deterministically interleaves unrelated live
                    // controllers before the import, as background PDF work can in CI.
                    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
                    backgroundPDF = getDocument({ data: pdfData.slice(), verbosity: 0 });
                    await backgroundPDF.promise;
                    const unrelatedController = controllers.slice(controllerStart).find(value => !value.signal.aborted);
                    assert.ok(unrelatedController, 'the background PDF must contribute an unrelated live controller');
                    const replacement = `Changed ${stage} ${closing} article that must never be selected.`;
                    await writeSourceCache(target.sourcePath, target.attachment, replacement);
                    const runStart = conversionStarts.length;
                    const targetRun = () => conversionStarts.slice(runStart).find(run => run.itemID === id);
                    gate = stage === 'read'
                        ? gateIO(ioUtils, 'read', file => file === path.join(target.sourcePath, 'full.md') && targetRun())
                        : gateIO(ioUtils, 'writeUTF8', (file, data) => file === `${indexPath}.staging` && targetRun()
                            && JSON.parse(data).records.some(record => record.attachmentKey === target.attachment.key
                                && record.libraryID === target.attachment.libraryID && record.snapshotHash !== selection.snapshotHash));
                    await importFromParent(target.parent);
                    const { controller } = await waitFor(targetRun, `the conversion start for attachment ${id}`);
                    await waitFor(() => gate.entered, `the import ${stage} gate`);
                    assert.ok(controller, 'the import must own a live native AbortController');
                    assert.equal(controller.signal.aborted, false);
                    assert.notEqual(controller, unrelatedController, 'the import signal must come from its own conversion start');
                    assert.equal(controllers.slice(controllerStart).find(value => !value.signal.aborted), unrelatedController,
                        'selecting the first live controller would observe the background PDF instead of the import');
                    assert.equal(tabs.size, 1);
                    assert.equal([...tabs.values()][0].options.data.mkteroSourceItemID, id,
                        'the closing tab must belong to the attachment being imported');
                    assert.equal(zotero.getMainWindow(), owner);
                    assert.equal(currentShadow().querySelector('#mktero-content').getAttribute('aria-busy'), 'true');
                    if (closing === 'owner') {
                        globalThis.onMainWindowUnload({ window: owner });
                        assert.equal(tabs.size, 1, 'window unload must release ownership even before Zotero closes its tabs');
                    }
                    else {
                        closeTab();
                    }
                    assert.equal(controller.signal.aborted, true, 'closing the owner must abort instead of continuing the import in the background');
                    assert.equal(unrelatedController.signal.aborted, false, 'closing the import must leave unrelated PDF work alive');
                    if (closing === 'owner') {
                        closeTab();
                        globalThis.onMainWindowLoad({ window: owner });
                    }
                    gate.release();
                    await gate.finished;
                    await waitForImportCommand(target.parent);
                    assert.equal(tabs.size, 0, 'a cancelled import must not reopen its closed tab');
                    assert.deepEqual(await readSelection(target.attachment), selection);
                    assert.equal(await fs.readFile(indexPath, 'utf8'), previousIndex);
                    const reopened = await reopenFromParent(target.parent);
                    await readyText(reopened, target.text);
                    assert.equal(reopened.querySelector('.cm-content').textContent.includes(replacement), false);
                    assert.deepEqual(errors.slice(errorCount), []);
                    assert.equal(confirmations.length, 0, 'cancellable local imports must not open a native confirmation');
                }
                finally {
                    try {
                        closeMenu();
                        closeTab();
                    }
                    finally {
                        // Restore the window even if the owner-close assertion fails,
                        // then drain the import before the next scenario changes IO.
                        const drained = gate?.restore();
                        globalThis.onMainWindowLoad({ window: owner });
                        try {
                            await drained;
                            await waitForImportCommand(target.parent);
                        }
                        finally {
                            await backgroundPDF?.destroy();
                        }
                    }
                }
            });
        }
    }

    await t.test('a generic disk error on the first import offers local recovery and confirms before remote reparsing', async t => {
        closeTab();
        const target = await newRegressionPDF(60, 'A first import that cannot read its PDF from disk.');
        const pdfFile = target.attachment.getFilePath();
        const read = ioUtils.read;
        const diskError = new Error('The local disk could not be read');
        const errorCount = errors.length;
        const confirmationCount = confirmations.length;
        const previousIndex = await fs.readFile(indexPath, 'utf8');
        ioUtils.read = async (file, ...options) => {
            if (file === pdfFile) throw diskError;
            return read(file, ...options);
        };
        t.after(() => { ioUtils.read = read; remoteReparsePromptAllowed = false; });
        await importFromParent(target.parent);
        const shadow = await waitFor(currentShadow, 'the first import error tab');
        const error = await waitFor(() => {
            const element = shadow.querySelector('.message.error');
            return element && !element.hidden ? element : null;
        }, 'a generic disk failure shown as a local import error');
        ioUtils.read = read;
        assert.equal(error.querySelector('.message-body').textContent, translateEnglish('importLLM.failed'));
        const retry = shadow.querySelector('#mktero-error-retry');
        assert.equal(retry.hidden, false);
        assert.equal(retry.disabled, false);
        assert.equal(retry.textContent, translateEnglish('importLLM.reparse'));
        assert.equal(retry.getAttribute('aria-label'), translateEnglish('importLLM.reparse'));
        assert.equal(shadow.querySelector('#mktero-content').getAttribute('aria-busy'), 'false');
        assert.equal(confirmations.length, 0, 'a failed first import must not open a native confirmation');
        assert.equal(await readSelection(target.attachment), null, 'a first failure has no published selection');
        assert.ok(errors.slice(errorCount).some(value => value.code === 'LLM_CACHE_IMPORT_FAILED' && value.cause === diskError));
        remoteReparsePromptAllowed = true;
        retry.click();
        await waitFor(() => confirmations.length === confirmationCount + 1 && !retry.disabled,
            'the remote reparse confirmation to be declined');
        assert.equal(confirmations.at(-1).title, translateEnglish('importLLM.reparse'));
        assert.equal(confirmations.at(-1).message, translateEnglish('importLLM.reparseConfirm'));
        assert.equal(confirmations.at(-1).ownerWindow, owner);
        assert.equal(error.hidden, false);
        assert.equal(retry.textContent, translateEnglish('importLLM.reparse'));
        assert.equal(await readSelection(target.attachment), null);
        assert.equal(confirmations.length, 1, 'only the explicitly requested remote reparse may open a confirmation');
        assert.equal(await fs.readFile(indexPath, 'utf8'), previousIndex);
        assertLocalRequests();
        remoteReparsePromptAllowed = false;
    });

    await t.test('invalidates imported readiness when PDF bytes change and verifies readiness again after restoring them', async () => {
        const confirmationCount = confirmations.length;
        assert.equal(confirmationCount, 1, 'the declined remote reparse must be the only native confirmation');
        const target = await newRegressionPDF(62, 'A local import bound to the current PDF bytes.');
        await importReadyRegressionPDF(target);
        await waitForReadiness(target.attachment, '1');
        assert.equal(columnValue(target.parent), '1');
        const selection = await readSelection(target.attachment);
        const index = createZoteroMinerUImportIndex(adapters);
        await index.load();
        const extractor = new ImportedMinerUDocumentExtractor({ zotero, index, readFile: ioUtils.read });
        assert.deepEqual(await extractor.lookup(target.attachment.id), selection);
        const pdfFile = target.attachment.getFilePath();
        await fs.writeFile(pdfFile, new Uint8Array([...pdfData, 10]));
        assert.equal(columnValue(target.attachment), '', 'a changed file stamp must synchronously remove the imported ready marker');
        assert.equal(columnValue(target.parent), '');
        assert.equal(await extractor.lookup(target.attachment.id), null, 'the changed PDF hash must not resolve to the selected import');
        assert.equal(columnValue(target.attachment), '');
        selectedItem = target.parent;
        openMenu();
        assert.equal(window.document.getElementById('mktero-export-obsidian').hidden, true);
        closeMenu();
        assert.deepEqual(await readSelection(target.attachment), selection);
        await fs.writeFile(pdfFile, pdfData);
        assert.equal(columnValue(target.attachment), '', 'restoring the bytes must wait for a fresh hash verification');
        await waitForReadiness(target.attachment, '1');
        assert.equal(columnValue(target.parent), '1');
        assert.deepEqual(await extractor.lookup(target.attachment.id), selection);
        selectedItem = target.parent;
        openMenu();
        assert.equal(window.document.getElementById('mktero-export-obsidian').hidden, false);
        closeMenu();
        assert.equal(confirmations.length, confirmationCount, 'a later direct import must not add another native confirmation');
        assertLocalRequests();
    });
});

function gateIO(io, method, matches) {
    const original = io[method];
    const released = Promise.withResolvers();
    const finished = Promise.withResolvers();
    const gate = {
        entered: false,
        finished: finished.promise,
        release: () => released.resolve(),
        restore() {
            io[method] = original;
            released.resolve();
            return gate.entered ? finished.promise : Promise.resolve();
        },
    };
    io[method] = async (...args) => {
        if (gate.entered || !matches(...args)) return original(...args);
        gate.entered = true;
        await released.promise;
        try { return await original(...args); }
        finally { finished.resolve(); }
    };
    return gate;
}

async function writeSourceCache(directory, attachment, text) {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'full.md'), text);
    await fs.writeFile(path.join(directory, 'content_list.json'), JSON.stringify([
        { type: 'text', text, page_idx: 0, bbox: [100, 100, 900, 200] },
    ]));
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
        totalPages: 1, totalChars: text.length,
    }));
    await fs.writeFile(path.join(directory, '_llm_source.json'), JSON.stringify({
        kind: 'llm-for-zotero/mineru-cache-source', version: 2,
        attachmentId: attachment.id, attachmentKey: attachment.key,
        origin: 'parsed', parsedAt: '2026-01-01T00:00:00.000Z',
    }));
}

async function waitFor(read, description, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await read();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Bootstrap did not reach ${description}`);
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
        stat: async (file, options = {}) => {
            const value = await (options.followSymlinks === false ? fs.lstat(file) : fs.stat(file));
            return {
                type: value.isSymbolicLink() ? 'symlink' : value.isDirectory() ? 'directory' : 'regular',
                size: value.size, lastModified: value.mtimeMs,
            };
        },
        remove: (file, options = {}) => fs.rm(file, {
            recursive: Boolean(options.recursive), force: Boolean(options.ignoreAbsent),
        }),
        move: (from, to) => fs.rename(from, to),
        write, writeUTF8: write,
    };
}
