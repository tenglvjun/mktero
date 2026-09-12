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
test('preserves a restored figure through bootstrap correction save and reopen', async t => {
    const profilePath = await fs.mkdtemp(path.join(os.tmpdir(), 'mktero-figure-bootstrap-'));
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
    const { window } = dom;
    window.URL.createObjectURL = () => 'blob:figure-bootstrap';
    window.URL.revokeObjectURL = () => {};
    const tabs = new Map();
    const errors = [];
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
        getMainWindow: () => owner, debug() {}, logError: error => errors.push(error),
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
    const figureID = source.figureMap.figures[0].id;
    const cacheKey = await createMinerUCacheKey(pdfData);
    await createZoteroMarkdownCache({ zotero, ioUtils, pathUtils }).put(cacheKey, source);
    await import('../src/bootstrap.js');
    await globalThis.startup({ id: 'mktero@tenglvjun.github.io', rootURI: 'resource://mktero/' });
    const buttons = [];
    toolbarHandler({ reader: { type: 'pdf', itemID: 42 }, doc: window.document,
        append: button => buttons.push(button) });
    buttons[0].click();
    const shadow = await waitFor(() => tabs.get('tab-1')?.container.querySelector('.mktero-tab-host')?.shadowRoot);
    await waitFor(() => shadow.querySelector('.cm-content')?.textContent.includes('Body text'));
    shadow.querySelector('#mktero-correction-toggle').click();
    const editorView = EditorView.findFromDOM(shadow.querySelector('.cm-editor'));
    editorView.posAtCoords = () => 2;
    const content = shadow.querySelector('.cm-content');
    content.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true, button: 0 }));
    assert.equal(content.getAttribute('contenteditable'), 'true');
    editorView.dispatch({ changes: { from: 0, to: 4, insert: 'Corrected body' } });
    shadow.querySelector('.mktero-correction-editor-save').click();
    const store = createZoteroMarkdownRevisionStore({ zotero, ioUtils, pathUtils });
    const revision = await waitFor(async () => {
        const saved = await store.load(cacheKey);
        return saved?.corrections?.length ? saved : null;
    });
    assert.equal(revision.base.figureMap?.figures[0]?.id, figureID);
    assert.equal(revision.base.markdown, source.markdown);
    owner.Zotero_Tabs.close('tab-1');
    buttons[0].click();
    const reopened = await waitFor(() => tabs.get('tab-2')?.container.querySelector('.mktero-tab-host')?.shadowRoot);
    await waitFor(() => reopened.querySelector('.cm-content')?.textContent.includes('Corrected body'));
    reopened.querySelector('.cm-mktero-figure-reference')
        .dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
    assert.ok(reopened.querySelector('.mktero-figure-source-button'));
    assert.deepEqual(errors, []);
});

async function waitFor(read) {
    for (let attempt = 0; attempt < 200; attempt++) {
        const value = await read();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Bootstrap figure state did not become ready');
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
