import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
    parseSavedMarkdownNote,
} from '../src/core/saved-markdown-note-format.js';
import { sha256Hex } from '../src/core/sha256.js';
import {
    SavedMarkdownNoteConflictError,
    ZoteroSavedMarkdownStore,
} from '../src/platform/zotero-saved-markdown-store.js';

function createHarness(options = {}) {
    const items = new Map();
    const files = new Map();
    const importedContentTypes = [];
    let nextID = 1;
    let nextKey = 1;

    class Item {
        constructor(type) {
            this.id = nextID++;
            this.key = 'KEY' + String(nextKey++).padStart(5, '0');
            this.type = type;
            this.attachments = [];
            this.notes = [];
            this.fields = {};
            items.set(this.id, this);
        }

        isNote() {
            return this.type === 'note';
        }

        isPDFAttachment() {
            return this.type === 'pdf';
        }

        setField(name, value) {
            this.fields[name] = value;
        }

        getDisplayTitle() {
            return this.fields.title || 'Test PDF';
        }

        setNote(value) {
            this.noteHTML = value;
        }

        getNote() {
            return this.noteHTML || '';
        }

        getNotes() {
            return this.notes;
        }

        getAttachments() {
            return this.attachments;
        }

        async getFilePathAsync() {
            return this.filePath || null;
        }

        async saveTx() {
            if (this.parentID) {
                const parent = items.get(this.parentID);
                if (this.isNote() && !parent.notes.includes(this.id)) {
                    parent.notes.push(this.id);
                }
                if (!this.isNote() && !parent.attachments.includes(this.id)) {
                    parent.attachments.push(this.id);
                }
            }
        }

        async eraseTx() {
            const parent = items.get(this.parentID);
            parent?.notes.splice(parent.notes.indexOf(this.id), 1);
            parent?.attachments.splice(parent.attachments.indexOf(this.id), 1);
            items.delete(this.id);
        }
    }

    const zotero = {
        Item,
        Items: {
            get: id => items.get(id) || null,
            getAsync: async id => items.get(id) || null,
        },
        Attachments: {
            async importFromFile({ file, parentItemID, title, contentType }) {
                importedContentTypes.push(contentType);
                const attachment = new Item('file');
                attachment.parentID = parentItemID;
                attachment.setField('title', title);
                attachment.filePath = 'attachment:' + attachment.key;
                attachment.key = 'ATT' + String(nextKey++).padStart(5, '0');
                files.set(attachment.filePath, files.get(file));
                attachment.saveTx();
                return attachment;
            },
            async importEmbeddedImage({ blob, parentItemID }) {
                const attachment = new Item('file');
                attachment.parentID = parentItemID;
                attachment.filePath = 'image:' + attachment.key;
                files.set(
                    attachment.filePath,
                    new Uint8Array(await blob.arrayBuffer())
                );
                attachment.saveTx();
                return attachment;
            },
        },
    };

    const parent = new Item('regular');
    parent.key = 'PARENT01';
    parent.libraryID = 1;
    const pdf = new Item('pdf');
    pdf.key = 'PDF00001';
    pdf.libraryID = 1;
    pdf.parentID = parent.id;
    pdf.parentItem = parent;

    const store = new ZoteroSavedMarkdownStore({
        zotero,
        readFile: async path => files.get(path),
        writeTemporaryFile: async ({ name, data }) => {
            const path = 'temp:' + name + ':' + nextKey++;
            files.set(path, data);
            return {
                path,
                file: path,
                cleanup: async () => files.delete(path),
            };
        },
        hash: value => sha256Hex(value, { crypto: webcrypto }),
        renderHTML: options.renderHTML,
        now: () => '2026-08-04T00:00:00.000Z',
    });

    return { items, files, importedContentTypes, parent, pdf, store };
}

test('saves a portable snapshot and synced source attachments under the parent item', async () => {
    const { importedContentTypes, parent, pdf, store } = createHarness();
    const markdown = '# Paper\n\n![Figure](images/figure.png)';
    const result = await store.saveSnapshot({
        pdfItem: pdf,
        parentItem: parent,
        markdown,
        assets: [{
            path: 'result/images/figure.png',
            mimeType: 'image/png',
            data: new Uint8Array([1, 2, 3]),
        }],
        assetBasePath: 'result',
        sourceMap: [],
        cacheKey: 'a'.repeat(64),
        parserProfile: 'mineru-v1',
    });

    const parsed = parseSavedMarkdownNote(result.note.getNote());
    assert.equal(parsed.manifest.sourcePDFKey, 'PDF00001');
    assert.equal(parsed.manifest.assetBasePath, 'result');
    assert.equal(parsed.manifest.assets.length, 1);
    assert.match(parsed.bodyHTML, /data-attachment-key="/);

    const saved = await store.read(result.note);
    assert.equal(saved.sourceAvailable, true);
    assert.equal(saved.assetsComplete, true);
    assert.equal(saved.markdown, markdown);
    assert.deepEqual(saved.sourceMap, []);
    assert.deepEqual(importedContentTypes, ['text/markdown', 'application/json']);
});

test('falls back cleanly when Zotero has not downloaded a saved attachment', async () => {
    const { items, parent, pdf, store } = createHarness();
    const result = await store.saveSnapshot({
        pdfItem: pdf,
        parentItem: parent,
        markdown: '# Paper',
        assets: [],
        sourceMap: [],
        cacheKey: 'a'.repeat(64),
        parserProfile: 'mineru-v1',
    });
    const sourceID = result.note.getAttachments()[0];
    items.get(sourceID).getFilePathAsync = async () => {
        throw new Error('attachment is not downloaded');
    };

    const saved = await store.read(result.note);

    assert.equal(saved.sourceAvailable, false);
    assert.equal(saved.snapshotAvailable, true);
});

test('keeps the source Markdown usable when only the source map is unavailable', async () => {
    const { items, parent, pdf, store } = createHarness();
    const result = await store.saveSnapshot({
        pdfItem: pdf,
        parentItem: parent,
        markdown: '# Paper',
        assets: [],
        sourceMap: [],
        cacheKey: 'a'.repeat(64),
        parserProfile: 'mineru-v1',
    });
    const sourceMapID = result.note.getAttachments()[1];
    items.get(sourceMapID).getFilePathAsync = async () => {
        throw new Error('source map is not downloaded');
    };

    const saved = await store.read(result.note);

    assert.equal(saved.sourceAvailable, true);
    assert.equal(saved.sourceMap, null);
    assert.equal(saved.markdown, '# Paper');
});

test('does not overwrite a saved note modified by the user', async () => {
    const { parent, pdf, store } = createHarness();
    const first = await store.saveSnapshot({
        pdfItem: pdf,
        parentItem: parent,
        markdown: '# Original',
        assets: [],
        sourceMap: [],
        cacheKey: 'a'.repeat(64),
        parserProfile: 'mineru-v1',
    });
    first.note.setNote(first.note.getNote().replace('Original', 'Edited'));

    await assert.rejects(
        () => store.saveSnapshot({
            pdfItem: pdf,
            parentItem: parent,
            markdown: '# Replacement',
            assets: [],
            sourceMap: [],
            cacheKey: 'b'.repeat(64),
            parserProfile: 'mineru-v1',
        }),
        error => error instanceof SavedMarkdownNoteConflictError
    );
});

test('rolls back the note and imported attachments when snapshot rendering fails', async () => {
    const { items, parent, pdf, store } = createHarness({
        renderHTML: () => {
            throw new Error('snapshot rendering failed');
        },
    });

    await assert.rejects(
        () => store.saveSnapshot({
            pdfItem: pdf,
            parentItem: parent,
            markdown: '# Paper',
            assets: [{
                path: 'figure.png',
                mimeType: 'image/png',
                data: new Uint8Array([1, 2, 3]),
            }],
            sourceMap: [],
            cacheKey: 'a'.repeat(64),
            parserProfile: 'mineru-v1',
        }),
        /snapshot rendering failed/
    );

    assert.deepEqual(parent.notes, []);
    assert.equal(items.size, 2);
});

test('refuses to treat an ordinary Zotero note as a saved Markdown note', async () => {
    const { parent, store } = createHarness();
    const ordinary = {
        id: 900,
        isNote: () => true,
        getNote: () => '<div><p>Ordinary note</p></div>',
    };
    parent.notes.push(ordinary.id);

    assert.equal(store.isSavedMarkdownNote(ordinary), false);
    await assert.rejects(() => store.read(ordinary), /not a Mktero saved Markdown note/);
});
