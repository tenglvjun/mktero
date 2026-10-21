import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { JSDOM } from 'jsdom';
import { EditorView } from '@codemirror/view';
import { createMinerUCacheKey, createZoteroMarkdownCache } from '../src/cache/markdown-cache.js';
import { createZoteroMarkdownRevisionStore } from '../src/platform/zotero-markdown-revision-store.js';
import { makeRestoredFigureDocument } from './helpers/restored-figure-fixture.js';

// Bootstrap owns process globals, so this integration runs in its own test file.
test('saves an open correction when its tab closes and opens past damaged corrections', async t => {
    const profilePath = await fs.mkdtemp(path.join(os.tmpdir(), 'mktero-correction-recovery-'));
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
    const { window } = dom;
    window.URL.createObjectURL = () => 'blob:correction-recovery';
    window.URL.revokeObjectURL = () => {};
    const tabs = new Map();
    const errors = [];
    let serial = 0;
    let toolbarHandler;
    const createOwner = () => ({
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
    });
    const owner = createOwner();
    let currentOwner = owner;
    const ioUtils = nodeIO();
    const pathUtils = { join: path.join, parent: path.dirname, filename: path.basename,
        tempDir: path.join(profilePath, 'tmp') };
    const pdfData = new Uint8Array(await fs.readFile(new URL('./fixtures/offline-annotation.pdf', import.meta.url)));
    const pdfPath = path.join(profilePath, 'paper.pdf');
    await fs.writeFile(pdfPath, pdfData);
    const zotero = {
        version: '9.0.6', locale: 'en-US', uiReadyPromise: Promise.resolve(),
        Profile: { dir: profilePath }, Session: { state: { windows: [] } },
        Prefs: { get: key => key === 'extensions.mktero.cacheEnabled' ? true : '' },
        Items: {
            getAsync: async id => ({ id, attachmentFilename: 'paper.pdf', parentItem: null,
                isPDFAttachment: () => true, getDisplayTitle: () => 'Paper',
                getFilePathAsync: async () => pdfPath, getAnnotations: () => [] }),
            loadDataTypes: async () => {},
        },
        PreferencePanes: { register: async options => options.id, unregister() {} },
        Reader: { registerEventListener: (_type, handler) => { toolbarHandler = handler; } },
        getMainWindow: () => currentOwner, debug() {}, logError: error => errors.push(error),
    };
    const globals = {
        Zotero: zotero, IOUtils: ioUtils, PathUtils: pathUtils,
        Services: { obs: { addObserver() {}, removeObserver() {} } },
        __MKTERO_MARKDOWN_STYLES__: await fs.readFile(new URL('../ui/markdown.css', import.meta.url), 'utf8'),
    };
    const previous = new Map([...Object.keys(globals), 'startup', 'shutdown', 'install',
        'uninstall', 'onMainWindowLoad', 'onMainWindowUnload'].map(key => [key, globalThis[key]]));
    Object.assign(globalThis, globals);
    t.after(async () => {
        globalThis.shutdown?.();
        window.close();
        for (const [key, value] of previous) {
            if (value === undefined) delete globalThis[key];
            else globalThis[key] = value;
        }
        await fs.rm(profilePath, { recursive: true, force: true });
    });
    const source = await makeRestoredFigureDocument();
    const cacheKey = await createMinerUCacheKey(pdfData);
    await createZoteroMarkdownCache({ zotero, ioUtils, pathUtils }).put(cacheKey, source);
    await import('../src/bootstrap.js');
    await globalThis.startup({ id: 'mktero@tenglvjun.github.io', rootURI: 'resource://mktero/' });
    const buttons = [];
    toolbarHandler({ reader: { type: 'pdf', itemID: 42 }, doc: window.document,
        append: button => buttons.push(button) });
    const store = createZoteroMarkdownRevisionStore({ zotero, ioUtils, pathUtils });

    const openTab = async (tabID, expectedText) => {
        buttons[0].click();
        const shadow = await waitFor(() => tabs.get(tabID)?.container
            .querySelector('.mktero-tab-host')?.shadowRoot);
        await waitFor(() => shadow.querySelector('.cm-content')?.textContent.includes(expectedText));
        return shadow;
    };
    const editFirstBlock = (shadow, replacement, replacedLength = 4) => {
        shadow.querySelector('#mktero-correction-toggle').click();
        const editorView = EditorView.findFromDOM(shadow.querySelector('.cm-editor'));
        editorView.posAtCoords = () => 2;
        const content = shadow.querySelector('.cm-content');
        content.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true, button: 0 }));
        assert.equal(content.getAttribute('contenteditable'), 'true');
        editorView.dispatch({ changes: { from: 0, to: replacedLength, insert: replacement } });
    };

    // The test reads through its own store instance while bootstrap's store
    // may be replacing the corrections file, so a failed read is retried.
    const loadSavedRevision = async () => {
        try {
            return await store.load(cacheKey);
        }
        catch {
            return null;
        }
    };

    // Closing the tab without pressing Save keeps the open correction.
    const first = await openTab('tab-1', 'Body text');
    editFirstBlock(first, 'Unsaved body');
    owner.Zotero_Tabs.close('tab-1');
    await openTab('tab-2', 'Unsaved body');
    const saved = await store.load(cacheKey);
    assert.equal(saved.corrections.length, 1);
    assert.match(saved.corrections[0].replacementMarkdown, /^Unsaved body/);
    assert.deepEqual(errors, []);
    owner.Zotero_Tabs.close('tab-2');

    // Damaged corrections no longer turn the document into a conversion error.
    const metadataPath = path.join(profilePath, 'mktero-revisions', 'v1', 'entries', cacheKey,
        'metadata.json');
    await fs.writeFile(metadataPath, '{damaged');
    const recovered = await openTab('tab-3', 'Body text');
    assert.equal(recovered.querySelector('.cm-content').textContent.includes('Unsaved body'), false);
    const warning = await waitFor(() => {
        const message = recovered.querySelector('.message.warning');
        return message && !message.hidden ? message : null;
    });
    assert.match(warning.textContent, /Saved corrections for this document could not be read/);
    assert.ok(errors.length > 0);
    assert.ok(errors.every(error => error.code === 'MARKDOWN_REVISION_INVALID'));

    // The next save replaces the damaged entry.
    editFirstBlock(recovered, 'Recovered body');
    recovered.querySelector('.mktero-correction-editor-save').click();
    const replaced = await waitFor(async () => {
        const revision = await loadSavedRevision();
        return revision?.corrections?.length ? revision : null;
    });
    assert.equal(replaced.base.markdown, source.markdown);
    assert.match(replaced.corrections[0].replacementMarkdown, /^Recovered body/);

    // A read failure may be temporary: the corrections stay on disk and the
    // document opens without correction editing.
    await waitFor(() => recovered.querySelector('.mktero-correction-editor-toolbar')?.hidden);
    owner.Zotero_Tabs.close('tab-3');
    const entryPath = path.dirname(metadataPath);
    const nodeStat = ioUtils.stat;
    ioUtils.stat = async file => {
        if (file.startsWith(entryPath)) {
            throw Object.assign(new Error('The file is locked'), { name: 'NotReadableError' });
        }
        return nodeStat(file);
    };
    const locked = await openTab('tab-4', 'Body text');
    const lockedWarning = await waitFor(() => {
        const message = locked.querySelector('.message.warning');
        return message && !message.hidden ? message : null;
    });
    assert.match(lockedWarning.textContent, /Corrections are unavailable until the document is reopened/);
    assert.equal(locked.querySelector('#mktero-correction-toggle').hidden, true);
    assert.ok(errors.some(error => error.name === 'NotReadableError'));
    ioUtils.stat = nodeStat;
    assert.match((await store.load(cacheKey)).corrections[0].replacementMarkdown, /^Recovered body/);
    owner.Zotero_Tabs.close('tab-4');

    // A main window can close without closing its tabs, and macOS keeps Zotero
    // running. The open correction is saved, and the document opens again in
    // the next window instead of selecting a tab that no longer exists.
    const closingWindow = await openTab('tab-5', 'Recovered body');
    editFirstBlock(closingWindow, 'Window', 'Recovered'.length);
    globalThis.onMainWindowUnload({ window: owner });
    assert.equal(tabs.has('tab-5'), true);
    currentOwner = createOwner();
    await openTab('tab-6', 'Window body');
    assert.match((await store.load(cacheKey)).corrections[0].replacementMarkdown, /^Window body/);

    // Shutdown closes the tabs before their revision sessions are destroyed,
    // and returns the saves so Zotero waits for them.
    const reopenedRecovered = tabs.get('tab-6').container
        .querySelector('.mktero-tab-host').shadowRoot;
    editFirstBlock(reopenedRecovered, 'Shutdown', 'Window'.length);
    await globalThis.shutdown();
    const shutdownSave = await store.load(cacheKey);
    assert.equal(shutdownSave.corrections.length, 1);
    assert.match(shutdownSave.corrections[0].replacementMarkdown, /^Shutdown body/);
});

async function waitFor(read) {
    for (let attempt = 0; attempt < 200; attempt++) {
        const value = await read();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Bootstrap correction state did not become ready');
}

function nodeIO() {
    const write = async (file, data, { tmpPath } = {}) => {
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
