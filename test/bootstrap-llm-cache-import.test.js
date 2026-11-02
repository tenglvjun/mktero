import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JSDOM } from 'jsdom';
import { EditorView } from '@codemirror/view';
import { unzipSync, strFromU8 } from 'fflate';
import { createZoteroMarkdownCache } from '../src/cache/markdown-cache.js';
import { createZoteroMinerUResultStore } from '../src/cache/mineru-result-store.js';
import { createZoteroMinerUImportIndex } from '../src/cache/mineru-import-index.js';
import { createLLMCacheIdentity } from '../src/mineru/llm-cache-profile.js';
import { ImportedMinerUDocumentExtractor } from '../src/extractors/imported-mineru-extractor.js';
import { createZoteroMarkdownRevisionStore } from '../src/platform/zotero-markdown-revision-store.js';
import { translateEnglish } from '../src/i18n/localization.js';
import { sha256Hex } from '../src/core/sha256.js';

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
    const controllers = [];
    class ObservedAbortController extends AbortController {
        constructor() {
            super();
            controllers.push(this);
        }
    }
    let serial = 0;
    let confirmImport = true;
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
        requests.push({ method, url: target });
        if (method === 'GET' && target === 'https://models.dev/api.json') {
            return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
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
        debug() {}, logError: error => errors.push(error),
    };
    const globals = {
        Zotero: zotero, IOUtils: ioUtils, PathUtils: pathUtils, fetch,
        AbortController: ObservedAbortController,
        Services: {
            obs: { addObserver() {}, removeObserver() {} },
            prompt: {
                confirm(ownerWindow, title, message) {
                    confirmations.push({ ownerWindow, title, message });
                    return confirmImport;
                },
            },
        },
        __MKTERO_MARKDOWN_STYLES__: await fs.readFile(new URL('../ui/markdown.css', import.meta.url), 'utf8'),
    };
    const previous = new Map([...Object.keys(globals), 'startup', 'shutdown', 'install',
        'uninstall', 'onMainWindowLoad', 'onMainWindowUnload'].map(key => [key, globalThis[key]]));
    Object.assign(globalThis, globals);
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
        assert.deepEqual(requests.filter(request => request.url !== 'https://models.dev/api.json'), [],
            'local imports and offline reads must make zero account or conversion requests');
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
    const importFromParent = async (target = parent) => {
        selectedItem = target;
        openMenu();
        const command = await waitFor(() => {
            const element = window.document.getElementById('mktero-import-llm-cache');
            return element && !element.hidden && !element.disabled ? element : null;
        }, 'the parent item import command');
        assert.equal(window.document.getElementById('mktero-import-llm-cache-options').hidden, true);
        closeMenu();
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

    await t.test('declining the first import closes its new tab without publishing a selection or either cache', async () => {
        assert.equal(window.document.getElementById('mktero-import-llm-cache').hidden, true);
        assert.equal(columnValue(attachment), '');
        confirmImport = false;
        await importFromParent();
        await waitFor(() => confirmations.length === 1 && tabs.size === 0,
            'the declined first import to close its tab');
        assert.equal(serial, 1, 'the declined import must have opened and closed a tab');
        assert.equal(await ioUtils.exists(indexPath), false);
        assert.deepEqual(await readSelections(), []);
        assert.equal((await resultStore.getStats()).entries, 0);
        assert.equal((await cache.getStats()).entries, 0);
        assert.deepEqual(await cache.listReadableEntries(), []);
        await waitForReadiness(attachment, '');
        assert.equal(columnValue(parent), '');
        assert.deepEqual(errors, []);
        assertLocalRequests();
        confirmImport = true;
    });

    await t.test('imports from the parent menu into a normal ready tab and persists both stores', async () => {
        await importFromParent();
        firstShadow = await waitFor(() => [...tabs.values()][0]?.container
            .querySelector('.mktero-tab-host')?.shadowRoot, 'the imported Markdown tab');
        firstTabID = [...tabs.keys()][0];
        await readyText(firstShadow, FIRST_TEXT);
        assert.equal(tabs.size, 1);
        assert.equal(confirmations.length, 2);
        assert.equal(confirmations[1].ownerWindow, owner);
        assert.ok(confirmations[1].title.trim());
        assert.match(confirmations[1].message, /paper\.pdf/);
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

    await t.test('declining a reimport restores the existing ready tab and preserves its content and selection', async () => {
        await writeSourceCache(sourcePath, attachment, UPDATED_TEXT);
        const previousIndex = await fs.readFile(indexPath, 'utf8');
        const previousSerial = serial;
        confirmImport = false;
        await importFromParent();
        await waitFor(() => confirmations.length === 3, 'the reimport confirmation to be declined');
        await readyText(firstShadow, FIRST_TEXT);
        assert.equal(tabs.size, 1);
        assert.equal(serial, previousSerial, 'declining a reimport must reuse the existing tab');
        assert.equal(tabs.get(firstTabID).container.querySelector('.mktero-tab-host').shadowRoot, firstShadow);
        assert.equal(firstShadow.querySelector('.cm-content').textContent.includes(UPDATED_TEXT), false);
        assert.deepEqual(await readSelection(), firstSelection);
        assert.equal(await fs.readFile(indexPath, 'utf8'), previousIndex);
        assert.equal((await resultStore.getStats()).entries, 1);
        assert.equal((await cache.getStats()).entries, 1);
        assert.equal(strFromU8(unzipSync((await resultStore.get(firstIdentity.rawKey)).archive)['full.md']), FIRST_TEXT);
        assert.ok((await cache.get(firstIdentity.cacheKey)).markdown.includes(FIRST_TEXT));
        await waitForReadiness(attachment, '1');
        assert.equal(columnValue(parent), '1');
        assert.deepEqual(errors, []);
        confirmImport = true;
    });

    await t.test('imports the same cache for a second attachment with an independent selection', async () => {
        await importFromParent(secondParent);
        const secondTabID = await waitFor(() => [...tabs.keys()].find(id => id !== firstTabID),
            'a separate tab for the second attachment');
        const shadow = await waitFor(() => tabs.get(secondTabID)?.container
            .querySelector('.mktero-tab-host')?.shadowRoot, 'the second imported document');
        await readyText(shadow, FIRST_TEXT);
        assert.equal(tabs.size, 2);
        assert.equal(confirmations.length, 4);
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
        assert.equal(confirmations.length, 5);
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
        assert.equal(confirmations.length, 5);
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
        assert.equal(confirmations.length, 5);
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
        assert.equal(confirmations.length, 5);
        assert.deepEqual(errors, []);
    });

    await t.test('shows an import error after both caches are cleared and keeps the selection without remote fallback', async () => {
        closeTab();
        await cache.clear();
        await resultStore.clear();
        assert.equal(await cache.get(updatedIdentity.cacheKey), null);
        assert.equal(await resultStore.get(updatedSelection.rawKey), null);
        const shadow = await reopenFromParent();
        const error = await waitFor(() => {
            const element = shadow.querySelector('.message.error');
            return element && !element.hidden && element.textContent.trim() ? element : null;
        }, 'an error for the selected import with missing local copies');
        assert.ok(error.textContent.trim());
        assert.equal(shadow.querySelector('#mktero-content').getAttribute('aria-busy'), 'false');
        assert.equal(shadow.querySelector('.cm-content').textContent.includes(UPDATED_TEXT), false);
        assert.ok(errors.some(value => value.code === 'LLM_CACHE_IMPORT_UNAVAILABLE'),
            `expected an import failure, received ${errors.map(value => value.code || value.message).join(', ')}`);
        assert.deepEqual(await readSelection(), updatedSelection);
        assert.deepEqual(await readSelection(secondAttachment), secondSelection);
        assert.equal(confirmations.length, 5);
        assertLocalRequests();
    });

    await t.test('saves a real pending correction before a declined reimport and keeps it after reopening', async t => {
        const target = await newRegressionPDF(46, 'Original article before its pending correction.');
        const shadow = await importReadyRegressionPDF(target);
        const selection = await readSelection(target.attachment);
        const identity = await createLLMCacheIdentity({ fileData: pdfData, snapshotHash: selection.snapshotHash });
        const entryPath = path.join(revisionStore.rootPath, 'entries', identity.cacheKey);
        const metadataPath = path.join(entryPath, 'metadata.json');
        const draft = 'Saved draft survives declining a local import and reopening its tab.';
        const errorCount = errors.length;
        const confirmationCount = confirmations.length;
        const previousSerial = serial;
        editDraft(shadow, draft);
        assert.equal(await revisionStore.load(identity.cacheKey), null, 'editing alone must leave a genuine unsaved draft');
        await writeSourceCache(target.sourcePath, target.attachment, 'Replacement that the user will decline.');
        const gate = gateIO(ioUtils, 'writeUTF8', file => file === metadataPath);
        t.after(() => { gate.restore(); confirmImport = true; });
        confirmImport = false;
        await importFromParent(target.parent);
        await waitFor(() => gate.entered, 'the pending correction metadata write');
        assert.equal(confirmations.length, confirmationCount, 'import confirmation must wait for the draft to reach disk');
        assert.equal(shadow.querySelector('#mktero-content').getAttribute('aria-busy'), 'false');
        assert.equal(shadow.querySelector('.cm-content').textContent, draft);
        assert.equal(await ioUtils.exists(metadataPath), false);
        gate.release();
        await waitFor(() => confirmations.length === confirmationCount + 1, 'the declined import after the draft is saved');
        await readyText(shadow, draft);
        assert.equal(serial, previousSerial);
        assert.equal(tabs.size, 1);
        const revision = await revisionStore.load(identity.cacheKey);
        assert.equal(revision.corrections.length, 1);
        assert.equal(revision.corrections[0].replacementMarkdown, draft);
        assert.deepEqual(await readSelection(target.attachment), selection);
        assert.equal((await cache.get(identity.cacheKey)).markdown.includes(draft), false,
            'corrections must not overwrite the imported OCR cache');
        closeTab();
        const reopened = await reopenFromParent(target.parent);
        await readyText(reopened, draft);
        assert.equal((await revisionStore.load(identity.cacheKey)).corrections[0].replacementMarkdown, draft);
        assert.deepEqual(errors.slice(errorCount), []);
        confirmImport = true;
    });

    await t.test('stops a reimport when saving its real pending correction fails and leaves the draft editable', async t => {
        const target = await newRegressionPDF(48, 'Original article before a failed correction save.');
        const shadow = await importReadyRegressionPDF(target);
        const selection = await readSelection(target.attachment);
        const identity = await createLLMCacheIdentity({ fileData: pdfData, snapshotHash: selection.snapshotHash });
        const entryPath = path.join(revisionStore.rootPath, 'entries', identity.cacheKey);
        const draft = 'This pending correction must survive its failed save.';
        const confirmationCount = confirmations.length;
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
        assert.equal(confirmations.length, confirmationCount, 'a failed correction save must stop before import confirmation');
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
            await t.test(`aborts an import paused during ${stage} when its ${closing} closes without publishing a new selection`, async t => {
                const id = 50 + (stage === 'write' ? 4 : 0) + (closing === 'owner' ? 2 : 0);
                const target = await newRegressionPDF(id, `Original ${stage} ${closing} article before cancellation.`);
                await importReadyRegressionPDF(target);
                const selection = await readSelection(target.attachment);
                const previousIndex = await fs.readFile(indexPath, 'utf8');
                const errorCount = errors.length;
                const controllerStart = controllers.length;
                const replacement = `Changed ${stage} ${closing} article that must never be selected.`;
                await writeSourceCache(target.sourcePath, target.attachment, replacement);
                const gate = stage === 'read'
                    ? gateIO(ioUtils, 'read', file => file === path.join(target.sourcePath, 'full.md'))
                    : gateIO(ioUtils, 'writeUTF8', file => file === `${indexPath}.staging`);
                t.after(() => gate.restore());
                await importFromParent(target.parent);
                await waitFor(() => gate.entered, `the import ${stage} gate`);
                const controller = controllers.slice(controllerStart).find(value => !value.signal.aborted);
                assert.ok(controller, 'the import must own a live native AbortController');
                assert.equal(currentShadow().querySelector('#mktero-content').getAttribute('aria-busy'), 'true');
                if (closing === 'owner') {
                    globalThis.onMainWindowUnload({ window: owner });
                    assert.equal(tabs.size, 1, 'window unload must release ownership even before Zotero closes its tabs');
                }
                else {
                    closeTab();
                }
                assert.equal(controller.signal.aborted, true, 'closing the owner must abort instead of continuing the import in the background');
                if (closing === 'owner') {
                    closeTab();
                    globalThis.onMainWindowLoad({ window: owner });
                }
                gate.release();
                await gate.finished;
                selectedItem = target.parent;
                openMenu();
                await waitFor(() => {
                    const command = window.document.getElementById('mktero-import-llm-cache');
                    return command && !command.hidden && !command.disabled;
                }, 'the cancelled import to finish and release the attachment');
                closeMenu();
                assert.equal(tabs.size, 0, 'a cancelled import must not reopen its closed tab');
                assert.deepEqual(await readSelection(target.attachment), selection);
                assert.equal(await fs.readFile(indexPath, 'utf8'), previousIndex);
                const reopened = await reopenFromParent(target.parent);
                await readyText(reopened, target.text);
                assert.equal(reopened.querySelector('.cm-content').textContent.includes(replacement), false);
                assert.deepEqual(errors.slice(errorCount), []);
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
        t.after(() => { ioUtils.read = read; confirmImport = true; });
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
        assert.equal(confirmations.length, confirmationCount, 'the disk failure must happen before import confirmation');
        assert.equal(await readSelection(target.attachment), null, 'a first failure has no published selection');
        assert.ok(errors.slice(errorCount).some(value => value.code === 'LLM_CACHE_IMPORT_FAILED' && value.cause === diskError));
        confirmImport = false;
        retry.click();
        await waitFor(() => confirmations.length === confirmationCount + 1 && !retry.disabled,
            'the remote reparse confirmation to be declined');
        assert.equal(confirmations.at(-1).title, translateEnglish('importLLM.reparse'));
        assert.equal(confirmations.at(-1).message, translateEnglish('importLLM.reparseConfirm'));
        assert.equal(confirmations.at(-1).ownerWindow, owner);
        assert.equal(error.hidden, false);
        assert.equal(retry.textContent, translateEnglish('importLLM.reparse'));
        assert.equal(await readSelection(target.attachment), null);
        assert.equal(await fs.readFile(indexPath, 'utf8'), previousIndex);
        assertLocalRequests();
        confirmImport = true;
    });

    await t.test('invalidates imported readiness when PDF bytes change and verifies readiness again after restoring them', async () => {
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
