import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
    parseSavedMarkdownNote,
    serializeSavedMarkdownNote,
} from '../src/core/saved-markdown-note-format.js';
import { sha256Hex } from '../src/core/sha256.js';
import {
    SavedMarkdownNoteConflictError,
    createZoteroBlobFactory,
    ZoteroSavedMarkdownStore,
} from '../src/platform/zotero-saved-markdown-store.js';

function createHarness(options = {}) {
    const items = new Map();
    const files = new Map();
    const importedContentTypes = [];
    const BlobType = globalThis.Blob;
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
            this.relations = new Map();
            items.set(this.id, this);
        }

        isNote() {
            return this.type === 'note';
        }

        isPDFAttachment() {
            return this.type === 'pdf';
        }

        isRegularItem() {
            return this.type === 'regular';
        }

        setField(name, value) {
            this.fields[name] = value;
        }

        getField(name) {
            return this.fields[name] || '';
        }

        addRelation(predicate, object) {
            if (!this.relations.has(predicate)) {
                this.relations.set(predicate, new Set());
            }
            this.relations.get(predicate).add(object);
        }

        hasRelation(predicate, object) {
            return this.relations.get(predicate)?.has(object) || false;
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
            this.saveCount = (this.saveCount || 0) + 1;
            if (options.failAttachmentMetadataSave === this.type
                && this.saveCount === 2) {
                throw new Error('attachment metadata save failed');
            }
            if (this.parentID) {
                const parent = items.get(this.parentID);
                if (options.enforceZoteroParentRules
                    && parent?.isNote()
                    && this.type !== 'embedded-image') {
                    throw new Error(
                        `Parent item ${parent.key} must be a regular item`
                    );
                }
                if (this.isNote() && !parent.notes.includes(this.id)) {
                    parent.notes.push(this.id);
                }
                if (!this.isNote() && !parent.attachments.includes(this.id)) {
                    parent.attachments.push(this.id);
                }
            }
        }

        async eraseTx() {
            if (options.failAttachmentEraseTitle
                && this.fields.title === options.failAttachmentEraseTitle) {
                throw new Error('attachment cleanup failed');
            }
            const parent = items.get(this.parentID);
            const children = this.isNote()
                ? parent?.notes
                : parent?.attachments;
            const index = children?.indexOf(this.id) ?? -1;
            if (index >= 0) children.splice(index, 1);
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
                await attachment.saveTx();
                return attachment;
            },
            async importEmbeddedImage({ blob, parentItemID }) {
                const attachment = new Item('embedded-image');
                attachment.parentID = parentItemID;
                attachment.attachmentContentType = blob.type;
                attachment.filePath = 'image:' + attachment.key;
                files.set(
                    attachment.filePath,
                    new Uint8Array(await blob.arrayBuffer())
                );
                await attachment.saveTx();
                return attachment;
            },
        },
        Relations: {
            relatedItemPredicate: 'dc:relation',
        },
        URI: {
            getItemURI: item => 'zotero://item/' + item.key,
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
    parent.attachments.push(pdf.id);

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
        createBlob: options.createBlob
            || ((parts, blobOptions) => new BlobType(parts, blobOptions)),
        now: () => '2026-08-04T00:00:00.000Z',
    });

    const createUserAttachment = parentItem => {
        const attachment = new Item('file');
        attachment.parentID = parentItem.id;
        parentItem.attachments.push(attachment.id);
        return attachment;
    };
    const createRegularItem = () => new Item('regular');
    const createPDFAttachment = parentItem => {
        const attachment = new Item('pdf');
        attachment.libraryID = parentItem.libraryID;
        attachment.parentID = parentItem.id;
        attachment.parentItem = parentItem;
        parentItem.attachments.push(attachment.id);
        return attachment;
    };

    return {
        items,
        files,
        importedContentTypes,
        parent,
        pdf,
        store,
        createPDFAttachment,
        createRegularItem,
        createUserAttachment,
    };
}

test('creates image attachments through an injected Blob factory', async () => {
    const BlobType = globalThis.Blob;
    const blobCalls = [];
    const { parent, pdf, store } = createHarness({
        createBlob: (parts, options) => {
            blobCalls.push({ parts, options });
            return new BlobType(parts, options);
        },
    });
    const originalBlob = globalThis.Blob;
    try {
        globalThis.Blob = undefined;
        await store.saveSnapshot({
            pdfItem: pdf,
            parentItem: parent,
            markdown: '![Figure](figure.png)',
            assets: [{
                path: 'figure.png',
                mimeType: 'image/png',
                data: new Uint8Array([1, 2, 3]),
            }],
            sourceMap: [],
            cacheKey: 'a'.repeat(64),
            parserProfile: 'mineru-v1',
        });
    }
    finally {
        globalThis.Blob = originalBlob;
    }

    assert.equal(blobCalls.length, 1);
    assert.equal(blobCalls[0].options.type, 'image/png');
    assert.deepEqual(blobCalls[0].parts[0], new Uint8Array([1, 2, 3]));
});

test('uses the Zotero main window Blob constructor before the plugin global', () => {
    const BlobType = globalThis.Blob;
    const factory = createZoteroBlobFactory({
        zotero: {
            getMainWindow: () => ({ Blob: BlobType }),
        },
        globalObject: {},
    });
    const originalBlob = globalThis.Blob;
    try {
        globalThis.Blob = undefined;
        const blob = factory([new Uint8Array([4, 5])], {
            type: 'image/jpeg',
        });
        assert.equal(blob.type, 'image/jpeg');
    }
    finally {
        globalThis.Blob = originalBlob;
    }
});

test('saves source files when Zotero restricts ordinary attachments to regular items', async () => {
    const { parent, pdf, store } = createHarness({
        enforceZoteroParentRules: true,
    });
    const result = await store.saveSnapshot({
        pdfItem: pdf,
        parentItem: parent,
        markdown: '# Paper',
        assets: [],
        sourceMap: [],
        cacheKey: 'a'.repeat(64),
        parserProfile: 'mineru-v1',
    });

    const saved = await store.read(result.note);
    assert.equal(saved.sourceAvailable, true);
    assert.equal(saved.sourceAttachment.parentID, parent.id);
    assert.equal(saved.sourceMapAttachment.parentID, parent.id);
    assert.equal(
        saved.sourceAttachment.hasRelation(
            'dc:relation',
            'zotero://item/' + pdf.key
        ),
        true
    );
});

test('rejects a standalone PDF before creating snapshot items or files', async () => {
    const { files, items, parent, pdf, store } = createHarness();
    pdf.parentID = null;
    pdf.parentItem = null;
    parent.attachments = [];

    await assert.rejects(
        () => store.saveSnapshot({
            pdfItem: pdf,
            markdown: '# Paper',
            assets: [],
            sourceMap: [],
            cacheKey: 'a'.repeat(64),
            parserProfile: 'mineru-v1',
        }),
        /PDF parent item is unavailable/
    );

    assert.deepEqual(parent.notes, []);
    assert.deepEqual(parent.attachments, []);
    assert.equal(items.size, 2);
    assert.equal(files.size, 0);
});

test('rejects a regular item that is not the PDF parent', async () => {
    const {
        createRegularItem,
        files,
        items,
        parent,
        pdf,
        store,
    } = createHarness();
    const unrelated = createRegularItem();

    await assert.rejects(
        () => store.saveSnapshot({
            pdfItem: pdf,
            parentItem: unrelated,
            markdown: '# Paper',
            assets: [],
            sourceMap: [],
            cacheKey: 'a'.repeat(64),
            parserProfile: 'mineru-v1',
        }),
        /PDF parent item is unavailable/
    );

    assert.deepEqual(parent.notes, []);
    assert.deepEqual(unrelated.notes, []);
    assert.deepEqual(unrelated.attachments, []);
    assert.equal(items.size, 3);
    assert.equal(files.size, 0);
});

test('saves a portable snapshot and synced source attachments under the parent item', async () => {
    const { importedContentTypes, parent, pdf, store } = createHarness();
    const markdown = [
        '# Paper',
        '',
        'Authors $^{1,2,3\\dagger}$',
        '',
        '![Figure](images/figure.png)',
        '',
        '$$x^2 + y^2$$',
    ].join('\n');
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
    assert.match(
        parsed.bodyHTML,
        /<span class="math">\$\^\{1,2,3\\dagger\}\$<\/span>/
    );
    assert.match(
        parsed.bodyHTML,
        /<pre class="math">\$\$x\^2 \+ y\^2\$\$<\/pre>/
    );
    assert.doesNotMatch(
        parsed.bodyHTML,
        /<math\b|<annotation\b|class="katex"/i
    );

    const saved = await store.read(result.note);
    assert.equal(saved.sourceAvailable, true);
    assert.equal(saved.assetsComplete, true);
    assert.equal(saved.markdown, markdown);
    assert.deepEqual(saved.sourceMap, []);
    assert.deepEqual(importedContentTypes, ['text/markdown', 'application/json']);
});

test('does not let an invalid source map block a portable snapshot', async () => {
    const { parent, pdf, store } = createHarness();
    const markdown = 'Results from the menstrual-cycle study.';
    const result = await store.saveSnapshot({
        pdfItem: pdf,
        parentItem: parent,
        markdown,
        assets: [],
        sourceMap: [{
            type: 'text',
            markdownFrom: 0,
            markdownTo: markdown.length + 1,
            locations: [{ pageIndex: 0, bbox: [0, 0, 100, 100] }],
        }],
        cacheKey: 'a'.repeat(64),
        parserProfile: 'mineru-v1',
    });

    const saved = await store.read(result.note);

    assert.equal(saved.sourceAvailable, true);
    assert.deepEqual(saved.sourceMap, []);
    assert.match(saved.markdown, /menstrual-cycle/);
});

test('recognizes a saved snapshot after Zotero wraps the note HTML', async () => {
    const { parent, pdf, store } = createHarness();
    const result = await store.saveSnapshot({
        pdfItem: pdf,
        parentItem: parent,
        markdown: '# Paper',
        assets: [],
        sourceMap: [],
        cacheKey: 'a'.repeat(64),
        parserProfile: 'mineru-v1',
    });
    const persistedNote = result.note.getNote();
    result.note.setNote(
        `<div class="zotero-note znv9">${persistedNote}</div>`
    );

    assert.equal(store.isSavedMarkdownNote(result.note), true);
    const saved = await store.read(result.note);
    assert.equal(saved.sourceAvailable, true);
    assert.equal(saved.markdown, '# Paper');
});

test('recovers a Zotero-normalized snapshot after custom metadata is stripped', async () => {
    const { parent, pdf, store } = createHarness();
    const markdown = '# Paper\n\n![Figure](figure.png)';
    const result = await store.saveSnapshot({
        pdfItem: pdf,
        parentItem: parent,
        markdown,
        assets: [{
            path: 'figure.png',
            mimeType: 'image/png',
            data: new Uint8Array([1, 2, 3]),
        }],
        sourceMap: [],
        cacheKey: 'a'.repeat(64),
        parserProfile: 'mineru-v1',
    });
    result.note.setNote([
        '<div class="zotero-note znv1"><div data-schema-version="9">',
        result.bodyHTML,
        '</div></div>',
    ].join(''));

    assert.equal(store.isSavedMarkdownNote(result.note), true);
    const saved = await store.read(result.note);
    assert.equal(saved.manifest.sourcePDFKey, pdf.key);
    assert.equal(saved.sourceAvailable, true);
    assert.equal(saved.markdown, markdown);
    assert.equal(saved.assetsComplete, true);
    assert.deepEqual(
        saved.assets.map(asset => asset.path),
        ['figure.png']
    );
    assert.equal(saved.snapshotModified, false);
});

test('updates a recovered snapshot instead of creating a duplicate note', async () => {
    const { items, parent, pdf, store } = createHarness();
    const first = await store.saveSnapshot({
        pdfItem: pdf,
        parentItem: parent,
        markdown: '![Figure](figure.png)',
        assets: [{
            path: 'figure.png',
            mimeType: 'image/png',
            data: new Uint8Array([1, 2, 3]),
        }],
        sourceMap: [],
        cacheKey: 'a'.repeat(64),
        parserProfile: 'mineru-v1',
    });
    const oldAttachmentIDs = [
        ...parent.attachments.filter(id => id !== pdf.id),
        ...first.note.attachments,
    ];
    first.note.setNote([
        '<div class="zotero-note znv1"><div data-schema-version="9">',
        first.bodyHTML,
        '</div></div>',
    ].join(''));

    const replacement = await store.saveSnapshot({
        pdfItem: pdf,
        parentItem: parent,
        markdown: '# Replacement',
        assets: [],
        sourceMap: [],
        cacheKey: 'b'.repeat(64),
        parserProfile: 'mineru-v1',
    });

    assert.equal(replacement.note.id, first.note.id);
    assert.deepEqual(parent.notes, [first.note.id]);
    assert.equal(oldAttachmentIDs.every(id => !items.has(id)), true);
    assert.equal(parent.attachments.length, 3);
    assert.deepEqual(first.note.attachments, []);
});

test('uses source relations to recover a snapshot under a multi-PDF item', async () => {
    const {
        createPDFAttachment,
        parent,
        pdf,
        store,
    } = createHarness();
    createPDFAttachment(parent);
    const result = await store.saveSnapshot({
        pdfItem: pdf,
        parentItem: parent,
        markdown: '# Paper',
        assets: [],
        sourceMap: [],
        cacheKey: 'a'.repeat(64),
        parserProfile: 'mineru-v1',
    });
    result.note.setNote([
        '<div class="zotero-note znv1"><div data-schema-version="9">',
        result.bodyHTML,
        '</div></div>',
    ].join(''));

    const saved = await store.read(result.note);

    assert.equal(saved.manifest.sourcePDFKey, pdf.key);
    assert.equal(saved.sourceAvailable, true);
});

test('rejects ambiguous legacy recovery under a multi-PDF item', async () => {
    const {
        createPDFAttachment,
        parent,
        pdf,
        store,
    } = createHarness();
    const result = await store.saveSnapshot({
        pdfItem: pdf,
        parentItem: parent,
        markdown: '# Paper',
        assets: [],
        sourceMap: [],
        cacheKey: 'a'.repeat(64),
        parserProfile: 'mineru-v1',
    });
    const saved = await store.read(result.note);
    for (const attachment of [
        saved.sourceAttachment,
        saved.sourceMapAttachment,
    ]) {
        attachment.relations.get('dc:relation')
            ?.delete('zotero://item/' + pdf.key);
    }
    createPDFAttachment(parent);
    result.note.setNote([
        '<div class="zotero-note znv1"><div data-schema-version="9">',
        result.bodyHTML,
        '</div></div>',
    ].join(''));

    await assert.rejects(
        () => store.read(result.note),
        /source PDF is ambiguous/
    );
});

test('marks recovered image mappings incomplete when the snapshot lost an image', async () => {
    const { parent, pdf, store } = createHarness();
    const result = await store.saveSnapshot({
        pdfItem: pdf,
        parentItem: parent,
        markdown: '![Figure](figure.png)',
        assets: [{
            path: 'figure.png',
            mimeType: 'image/png',
            data: new Uint8Array([1, 2, 3]),
        }],
        sourceMap: [],
        cacheKey: 'a'.repeat(64),
        parserProfile: 'mineru-v1',
    });
    result.note.setNote([
        '<div class="zotero-note znv1">',
        '<div data-schema-version="9"><p>Snapshot without image</p></div>',
        '</div>',
    ].join(''));

    const saved = await store.read(result.note);

    assert.equal(saved.sourceAvailable, true);
    assert.equal(saved.assetsComplete, false);
    assert.deepEqual(saved.assets, []);
    assert.equal(saved.snapshotAvailable, true);
});

test('falls back cleanly when Zotero has not downloaded a saved attachment', async () => {
    const { parent, pdf, store } = createHarness();
    const result = await store.saveSnapshot({
        pdfItem: pdf,
        parentItem: parent,
        markdown: '# Paper',
        assets: [],
        sourceMap: [],
        cacheKey: 'a'.repeat(64),
        parserProfile: 'mineru-v1',
    });
    const initial = await store.read(result.note);
    initial.sourceAttachment.getFilePathAsync = async () => {
        throw new Error('attachment is not downloaded');
    };

    const saved = await store.read(result.note);

    assert.equal(saved.sourceAvailable, false);
    assert.equal(saved.snapshotAvailable, true);
});

test('keeps the source Markdown usable when only the source map is unavailable', async () => {
    const { parent, pdf, store } = createHarness();
    const result = await store.saveSnapshot({
        pdfItem: pdf,
        parentItem: parent,
        markdown: '# Paper',
        assets: [],
        sourceMap: [],
        cacheKey: 'a'.repeat(64),
        parserProfile: 'mineru-v1',
    });
    const initial = await store.read(result.note);
    initial.sourceMapAttachment.getFilePathAsync = async () => {
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
    let concurrentAttachment;
    let parent;
    let createUserAttachment;
    const harness = createHarness({
        renderHTML: () => {
            concurrentAttachment = createUserAttachment(parent);
            throw new Error('snapshot rendering failed');
        },
    });
    ({ parent, createUserAttachment } = harness);
    const { items, pdf, store } = harness;

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
    assert.equal(items.has(concurrentAttachment.id), true);
    assert.deepEqual(parent.attachments, [pdf.id, concurrentAttachment.id]);
    assert.equal(items.size, 3);
});

test('rolls back an imported source file when its metadata save fails', async () => {
    const { items, parent, pdf, store } = createHarness({
        failAttachmentMetadataSave: 'file',
    });

    await assert.rejects(
        () => store.saveSnapshot({
            pdfItem: pdf,
            parentItem: parent,
            markdown: '# Paper',
            assets: [],
            sourceMap: [],
            cacheKey: 'a'.repeat(64),
            parserProfile: 'mineru-v1',
        }),
        /attachment metadata save failed/
    );

    assert.deepEqual(parent.notes, []);
    assert.deepEqual(parent.attachments, [pdf.id]);
    assert.equal(items.size, 2);
});

test('rolls back an imported image when its metadata save fails', async () => {
    const { items, parent, pdf, store } = createHarness({
        failAttachmentMetadataSave: 'embedded-image',
    });

    await assert.rejects(
        () => store.saveSnapshot({
            pdfItem: pdf,
            parentItem: parent,
            markdown: '![Figure](figure.png)',
            assets: [{
                path: 'figure.png',
                mimeType: 'image/png',
                data: new Uint8Array([1, 2, 3]),
            }],
            sourceMap: [],
            cacheKey: 'a'.repeat(64),
            parserProfile: 'mineru-v1',
        }),
        /attachment metadata save failed/
    );

    assert.deepEqual(parent.notes, []);
    assert.deepEqual(parent.attachments, [pdf.id]);
    assert.equal(items.size, 2);
});

test('deletes only the marked note and its synchronized source files', async () => {
    const {
        items,
        parent,
        pdf,
        store,
        createUserAttachment,
    } = createHarness();
    const userAttachment = createUserAttachment(parent);
    const result = await store.saveSnapshot({
        pdfItem: pdf,
        parentItem: parent,
        markdown: '# Paper',
        assets: [],
        sourceMap: [],
        cacheKey: 'a'.repeat(64),
        parserProfile: 'mineru-v1',
    });
    const sourceIDs = parent.attachments.filter(id => (
        id !== pdf.id && id !== userAttachment.id
    ));

    await store.deleteSavedNote(result.note);

    assert.equal(items.has(result.note.id), false);
    assert.equal(items.has(userAttachment.id), true);
    assert.equal(sourceIDs.every(id => !items.has(id)), true);
});

test('does not delete a user attachment named by a tampered note manifest', async () => {
    const {
        items,
        parent,
        pdf,
        store,
        createUserAttachment,
    } = createHarness();
    const result = await store.saveSnapshot({
        pdfItem: pdf,
        parentItem: parent,
        markdown: '# Paper',
        assets: [],
        sourceMap: [],
        cacheKey: 'a'.repeat(64),
        parserProfile: 'mineru-v1',
    });
    const saved = await store.read(result.note);
    const userAttachment = createUserAttachment(parent);
    userAttachment.setField('title', 'Mktero source.md');
    result.note.setNote(serializeSavedMarkdownNote({
        bodyHTML: saved.bodyHTML,
        manifest: {
            ...saved.manifest,
            sourceAttachmentKey: userAttachment.key,
        },
    }));

    await store.deleteSavedNote(result.note);

    assert.equal(items.has(userAttachment.id), true);
    assert.equal(parent.attachments.includes(userAttachment.id), true);
});

test('reports a source cleanup failure after deleting the saved note', async () => {
    const { items, parent, pdf, store } = createHarness({
        failAttachmentEraseTitle: 'Mktero source.md',
    });
    const result = await store.saveSnapshot({
        pdfItem: pdf,
        parentItem: parent,
        markdown: '# Paper',
        assets: [],
        sourceMap: [],
        cacheKey: 'a'.repeat(64),
        parserProfile: 'mineru-v1',
    });
    const saved = await store.read(result.note);

    await assert.rejects(
        () => store.deleteSavedNote(result.note),
        /attachment cleanup failed/
    );

    assert.equal(items.has(result.note.id), false);
    assert.equal(items.has(saved.sourceAttachment.id), true);
    assert.equal(items.has(saved.sourceMapAttachment.id), false);
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
    await assert.rejects(
        () => store.deleteSavedNote(ordinary),
        /Refusing to delete an ordinary Zotero note/
    );
});

test('does not confuse a sibling note with a saved snapshot', async () => {
    const { parent, pdf, store } = createHarness();
    const result = await store.saveSnapshot({
        pdfItem: pdf,
        parentItem: parent,
        markdown: '# Paper',
        assets: [],
        sourceMap: [],
        cacheKey: 'a'.repeat(64),
        parserProfile: 'mineru-v1',
    });
    const ordinary = new result.note.constructor('note');
    ordinary.parentID = parent.id;
    ordinary.parentItem = parent;
    ordinary.setNote('<div><p>Ordinary sibling</p></div>');
    await ordinary.saveTx();

    assert.equal(store.isSavedMarkdownNote(ordinary), false);
    await assert.rejects(
        () => store.read(ordinary),
        /not a Mktero saved Markdown note/
    );
});
