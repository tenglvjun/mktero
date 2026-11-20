import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { JSDOM } from 'jsdom';
import { createMarkdownCacheKey, createZoteroMarkdownCache } from '../src/cache/markdown-cache.js';
import { createZoteroMarkdownAnnotationStore } from '../src/cache/markdown-annotation-store.js';
import { MISTRAL_PARSER_PROFILE_ID } from '../src/mistral/parser-profile.js';

test('shows an initial synchronization failure that settles before the reader becomes ready', async t => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mktero-initial-annotation-failure-'));
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
    const { window } = dom;
    window.URL.createObjectURL = () => 'blob:annotation-failure';
    window.URL.revokeObjectURL = () => {};
    const errors = [];
    const isSyncFailure = error => ['MKTERO_PDF_INDEX_UNAVAILABLE', 'MKTERO_PDF_READER_UNAVAILABLE'].includes(error.code);
    const tabs = new Map();
    let toolbarHandler;
    let publicationReadWaitedForFailure = false;
    const publicationReached = Promise.withResolvers();
    const owner = {
        document: window.document,
        AbortController,
        Zotero_Tabs: {
            add(options) {
                const container = window.document.createElement('div');
                window.document.body.append(container);
                tabs.set('annotation-tab', { options, container });
                return { id: 'annotation-tab', container };
            },
            select() {}, rename() {}, getState: () => [],
            close(id) {
                tabs.get(id)?.options.onClose?.();
                tabs.get(id)?.container.remove();
                tabs.delete(id);
            },
        },
    };
    const pdfPath = path.join(profile, 'temporarily-damaged.pdf');
    const bytes = new TextEncoder().encode('%PDF-1.4\nSynthetic damaged PDF.\n');
    await fs.writeFile(pdfPath, bytes);
    const markdown = 'A saved cross-page passage remains local while its damaged PDF is unavailable.';
    const prefs = new Map([
        ['extensions.mktero.conversionProvider', 'mistral'],
        ['extensions.mktero.cacheEnabled', true],
        ['extensions.mktero.readerOutlineVisible', true],
        ['extensions.mktero.readerOutlineSegment', 'annotations'],
    ]);
    const pdf = {
        id: 42, libraryID: 1, key: 'PAPERKEY', attachmentFilename: 'temporarily-damaged.pdf',
        parentItem: null, isPDFAttachment: () => true, getDisplayTitle: () => 'Synthetic paper',
        getFilePathAsync: async () => pdfPath, getAnnotations: () => [],
    };
    const zotero = {
        version: '10.0.9', locale: 'en-US', uiReadyPromise: Promise.resolve(),
        Profile: { dir: profile }, Session: { state: { windows: [] } },
        Prefs: { get: key => prefs.get(key) ?? '' },
        Items: { get: () => pdf, getAsync: async () => pdf, loadDataTypes: async () => {} },
        PreferencePanes: { register: async options => options.id, unregister() {} },
        Reader: { registerEventListener: (_type, handler) => { toolbarHandler = handler; } },
        getMainWindow: () => owner, debug() {}, logError: error => errors.push(error),
    };
    const ioUtils = nodeIO();
    const exists = ioUtils.exists;
    const read = ioUtils.read;
    let pdfReads = 0;
    ioUtils.read = async file => {
        // Let the conversion read the fixture, but hold the annotation
        // locator's separate file read until the ready result is assembled.
        if (file === pdfPath && ++pdfReads > 1) await publicationReached.promise;
        return read(file);
    };
    ioUtils.exists = async file => {
        if (file.includes(`${path.sep}mktero-reading-positions${path.sep}`)) {
            // This local read happens after annotation resolution, before
            // publication. Settle the real failed attempt while still loading.
            publicationReached.resolve();
            await waitFor(() => errors.some(isSyncFailure));
            publicationReadWaitedForFailure = true;
        }
        return exists(file);
    };
    const pathUtils = { join: path.join, parent: path.dirname, filename: path.basename,
        tempDir: path.join(profile, 'tmp') };
    const globals = {
        Zotero: zotero, IOUtils: ioUtils, PathUtils: pathUtils,
        fetch: async () => { throw new Error('This local regression must not use the network'); },
        Services: { obs: { addObserver() {}, removeObserver() {} } },
        __MKTERO_MARKDOWN_STYLES__: await fs.readFile(new URL('../ui/markdown.css', import.meta.url), 'utf8'),
    };
    const previous = new Map([...Object.keys(globals), 'startup', 'shutdown', 'install',
        'uninstall', 'onMainWindowLoad', 'onMainWindowUnload'].map(key => [key, globalThis[key]]));
    Object.assign(globalThis, globals);
    t.after(async () => {
        publicationReached.resolve();
        await globalThis.shutdown?.();
        window.close();
        for (const [key, value] of previous) {
            if (value === undefined) delete globalThis[key];
            else globalThis[key] = value;
        }
        await fs.rm(profile, { recursive: true, force: true });
    });
    const cacheKey = await createMarkdownCacheKey(bytes, { parserProfile: MISTRAL_PARSER_PROFILE_ID });
    await createZoteroMarkdownCache({ zotero, ioUtils, pathUtils }).put(cacheKey, {
        markdown, assets: [], parserProfile: MISTRAL_PARSER_PROFILE_ID,
    });
    const store = createZoteroMarkdownAnnotationStore({ zotero, ioUtils, pathUtils });
    const draft = {
        id: 'mktero-existing-failed-draft', source: 'markdown', type: 'highlight',
        text: markdown, comment: 'Keep the original comment', color: '#ffd400',
        ranges: [{ from: 0, to: markdown.length }],
    };
    await store.put(42, [draft]);
    await import('../src/bootstrap.js');
    await globalThis.startup({ id: 'mktero@tenglvjun.github.io', rootURI: 'resource://mktero/' });
    const buttons = [];
    toolbarHandler({ reader: { type: 'pdf', itemID: 42 }, doc: window.document,
        append: button => buttons.push(button) });
    buttons[0].click();
    const root = await waitFor(() => tabs.get('annotation-tab')?.container
        .querySelector('.mktero-tab-host')?.shadowRoot);
    await waitFor(() => root.querySelector('.cm-content')?.textContent.includes(markdown)).catch(error => {
        error.message += `; messages=${JSON.stringify([...root.querySelectorAll('.message')].map(node => node.textContent))}; errors=${JSON.stringify(errors.map(value => ({ code: value.code, message: value.message })))}`;
        throw error;
    });
    assert.equal(publicationReadWaitedForFailure, true);
    const retry = await waitFor(() => root.querySelector(
        `.markdown-note-sync-retry[data-annotation-id="${draft.id}"]`
    ));
    assert.match(root.querySelector('.markdown-note-sync').textContent, /unavailable|failed|could not/i);
    assert.deepEqual(await store.get(42), [draft]);
    const failureCount = errors.filter(isSyncFailure).length;
    retry.click();
    await waitFor(() => errors.filter(isSyncFailure).length > failureCount);
    await waitFor(() => root.querySelector('.markdown-note-sync-retry') && !root.querySelector('.markdown-note-sync-retry').disabled);
    assert.deepEqual(await store.get(42), [draft]);
});

async function waitFor(read) {
    for (let attempt = 0; attempt < 300; attempt++) {
        const value = await read();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Annotation synchronization state did not become ready');
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
