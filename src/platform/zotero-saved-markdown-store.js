import {
    SAVED_MARKDOWN_NOTE_KIND,
    SAVED_MARKDOWN_NOTE_SCHEMA_VERSION,
    createSavedMarkdownManifest,
    extractZoteroNoteBody,
    isSavedMarkdownNote,
    parseSavedMarkdownNote,
    serializeSavedMarkdownNote,
    SOURCE_MAP_ATTACHMENT_TITLE,
    SOURCE_MARKDOWN_ATTACHMENT_TITLE,
} from '../core/saved-markdown-note-format.js';
import {
    isValidSourceLocation,
    isValidSourceMapEntry,
} from '../core/markdown-source-map.js';
import { sha256Hex } from '../core/sha256.js';
import { toUint8Array } from '../mineru/binary.js';
import { renderZoteroNoteHTML } from '../markdown/zotero-note-html-renderer.js';
import { translateEnglish } from '../i18n/localization.js';

const MAX_SOURCE_MARKDOWN_BYTES = 50 * 1024 * 1024;
const MAX_SOURCE_MAP_BYTES = 20 * 1024 * 1024;
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 150 * 1024 * 1024;
const MAX_ASSETS = 2_000;
const MAX_SOURCE_MAP_ENTRIES = 20_000;
const INTERNAL_IMAGE_PREFIX = 'Mktero image: ';

export class SavedMarkdownNoteConflictError extends Error {
    constructor() {
        super('The saved Markdown note was modified in Zotero; refusing to overwrite it');
        this.name = 'SavedMarkdownNoteConflictError';
        this.code = 'MKTERO_SAVED_NOTE_CONFLICT';
    }
}

export class ZoteroSavedMarkdownStore {
    constructor({
        zotero,
        readFile,
        writeTemporaryFile,
        createBlob,
        hash = sha256Hex,
        renderHTML = renderZoteroNoteHTML,
        translate = translateEnglish,
        preparingNoteText = '',
        now,
    }) {
        if (!zotero?.Items || !zotero?.Attachments) {
            throw new TypeError('A Zotero item and attachment API is required');
        }
        if (!zotero.Relations?.relatedItemPredicate
            || typeof zotero.URI?.getItemURI !== 'function') {
            throw new TypeError('A Zotero item relation API is required');
        }
        if (typeof readFile !== 'function') {
            throw new TypeError('A binary file reader is required');
        }
        if (typeof writeTemporaryFile !== 'function') {
            throw new TypeError('A temporary file writer is required');
        }
        if (typeof createBlob !== 'function') {
            throw new TypeError('A Blob factory is required');
        }
        if (typeof now !== 'function') {
            throw new TypeError('A saved Markdown clock is required');
        }
        this.zotero = zotero;
        this.readFile = readFile;
        this.writeTemporaryFile = writeTemporaryFile;
        this.createBlob = createBlob;
        this.hash = hash;
        this.renderHTML = renderHTML;
        this.translate = translate;
        this.preparingNoteText = String(preparingNoteText || '');
        this.now = now;
    }

    async findBySourcePDF(parentItem, sourcePDFKey, sourceLibraryKey = null) {
        if (!parentItem || typeof parentItem.getNotes !== 'function') return null;
        const expectedPDFKey = String(sourcePDFKey || '');
        const expectedLibraryKey = sourceLibraryKey === null
            || sourceLibraryKey === undefined
            ? null
            : String(sourceLibraryKey);
        for (const child of await this.#childItems(parentItem.getNotes())) {
            if (!child?.isNote?.()) continue;
            let manifest;
            try {
                manifest = parseSavedMarkdownNote(
                    child.getNote?.() || ''
                ).manifest;
            }
            catch {
                const recovered = await this.#recoverSavedNoteHeader(child)
                    .catch(() => null);
                if (!recovered) continue;
                manifest = recovered.manifest;
            }
            if (manifest.sourcePDFKey !== expectedPDFKey) continue;
            if (expectedLibraryKey !== null
                && String(manifest.sourceLibraryKey || '') !== expectedLibraryKey) {
                continue;
            }
            return child;
        }
        return null;
    }

    isSavedMarkdownNote(item) {
        if (!item?.isNote?.()) return false;
        if (isSavedMarkdownNote(item.getNote?.() || '')) return true;
        return Boolean(this.#linkedSourceAttachmentsSync(item));
    }

    async readManifest(noteItemOrID) {
        const note = await this.#resolveItem(noteItemOrID);
        try {
            const parsed = parseSavedMarkdownNote(note.getNote?.() || '');
            return {
                note,
                noteID: note.id,
                manifest: parsed.manifest,
                noteHTML: parsed.noteHTML,
                bodyHTML: parsed.bodyHTML,
                recovered: false,
            };
        }
        catch {
            const recovered = await this.#recoverSavedNoteHeader(note);
            if (recovered) return recovered;
            throw new Error('This Zotero note is not a Mktero saved Markdown note');
        }
    }

    async read(noteItemOrID) {
        const header = await this.readManifest(noteItemOrID);
        const {
            note,
            noteID,
            noteHTML,
            bodyHTML,
        } = header;
        let manifest = header.manifest;
        const parent = await this.#resolveParent(note);
        const [noteAttachments, parentAttachments] = await Promise.all([
            this.#childItems(note.getAttachments?.() || []),
            parent && parent !== note
                ? this.#childItems(parent.getAttachments?.() || [])
                : [],
        ]);
        const attachments = new Map(
            [...noteAttachments, ...parentAttachments]
                .filter(attachment => attachment?.key)
                .map(attachment => [String(attachment.key), attachment])
        );

        const sourceAttachment = header.sourceAttachment
            || this.#ownedSourceAttachment(
                attachments.get(manifest.sourceAttachmentKey),
                SOURCE_MARKDOWN_ATTACHMENT_TITLE,
                note,
                parent
            );
        const sourceMapAttachment = header.sourceMapAttachment
            || this.#ownedSourceAttachment(
                attachments.get(manifest.sourceMapAttachmentKey),
                SOURCE_MAP_ATTACHMENT_TITLE,
                note,
                parent
            );
        const markdown = sourceAttachment
            ? await this.#readUTF8Attachment(sourceAttachment, MAX_SOURCE_MARKDOWN_BYTES)
            : null;
        const sourceMapJSON = sourceMapAttachment
            ? await this.#readUTF8Attachment(sourceMapAttachment, MAX_SOURCE_MAP_BYTES)
            : null;
        const sourceMap = sourceMapJSON === null
            ? null
            : parseSourceMap(sourceMapJSON, markdown?.length || 0);
        const sourceHash = markdown === null
            ? null
            : await this.hash(new TextEncoder().encode(markdown));

        const snapshotHash = await this.hash(
            new TextEncoder().encode(bodyHTML)
        );
        let recoveredAssets = null;
        if (header.recovered) {
            recoveredAssets = this.#recoverSnapshotAssets({
                markdown,
                bodyHTML,
                noteAttachments,
            });
            manifest = {
                ...manifest,
                markdownHash: sourceHash,
                assets: recoveredAssets.assets,
                snapshotHTMLHash: snapshotHash,
            };
        }
        const sourceAvailable = markdown !== null
            && (header.recovered || sourceHash === manifest.markdownHash);

        const assets = [];
        let assetsComplete = recoveredAssets?.complete ?? true;
        let totalAssetBytes = 0;
        for (const asset of manifest.assets) {
            const attachment = attachments.get(asset.attachmentKey);
            const data = attachment
                ? await this.#readAttachment(attachment, MAX_ASSET_BYTES)
                : null;
            if (!data) {
                assetsComplete = false;
                continue;
            }
            totalAssetBytes += data.length;
            if (totalAssetBytes > MAX_TOTAL_ASSET_BYTES) {
                assetsComplete = false;
                break;
            }
            assets.push({
                path: asset.path,
                mimeType: asset.mimeType,
                data,
                attachmentKey: asset.attachmentKey,
            });
        }

        return {
            note,
            noteID,
            manifest,
            noteHTML,
            bodyHTML,
            markdown,
            sourceMap,
            sourceAvailable,
            snapshotAvailable: Boolean(bodyHTML.trim()),
            snapshotModified: !header.recovered
                && snapshotHash !== manifest.snapshotHTMLHash,
            assets,
            assetsComplete,
            sourceAttachment,
            sourceMapAttachment,
        };
    }

    async saveSnapshot({
        pdfItem,
        parentItem = null,
        markdown,
        assets = [],
        assetBasePath = '',
        sourceMap = [],
        cacheKey,
        parserProfile,
    }) {
        const pdf = await this.#resolveItem(pdfItem);
        if (!pdf?.isPDFAttachment?.()) {
            throw new Error('Only PDF attachments can have a saved Markdown note');
        }
        if (typeof markdown !== 'string' || !markdown.trim()) {
            throw new TypeError('Saved Markdown source is required');
        }
        if (!Array.isArray(sourceMap)) {
            throw new TypeError('Saved Markdown source map must be an array');
        }
        const actualParent = await this.#resolveParent(pdf);
        const parent = parentItem
            ? await this.#resolveItem(parentItem)
            : actualParent;
        if (!actualParent?.id
            || !actualParent.isRegularItem?.()
            || !parent?.id
            || String(parent.id) !== String(actualParent.id)) {
            throw new Error('The PDF parent item is unavailable');
        }
        const sourcePDFKey = requiredItemKey(pdf, 'PDF');
        const sourceLibraryKey = pdf.libraryID === undefined
            || pdf.libraryID === null
            ? null
            : String(pdf.libraryID);
        const existing = await this.findBySourcePDF(
            parent,
            sourcePDFKey,
            sourceLibraryKey
        );
        let previous = null;
        if (existing) {
            previous = await this.read(existing);
            if (previous.snapshotModified) {
                throw new SavedMarkdownNoteConflictError();
            }
        }

        const prepared = await this.#prepareSnapshot({
            markdown,
            assets,
            assetBasePath,
            sourceMap,
        });
        const note = existing || await this.#createNote(parent);
        const createdAttachments = [];
        const temporaryFiles = [];
        try {
            const attachments = await this.#importSnapshotAttachments(
                note,
                parent,
                pdf,
                prepared,
                temporaryFiles,
                createdAttachments
            );
            const bodyHTML = this.renderHTML(markdown, {
                resolveImageAttachmentKey: href => (
                    resolveAssetAttachmentKey(
                        prepared.assetBasePath,
                        href,
                        attachments.assetAttachments
                    )
                ),
                translate: this.translate,
            });
            const snapshotHTMLHash = await this.hash(
                new TextEncoder().encode(bodyHTML)
            );
            const manifest = this.#createSnapshotManifest({
                sourcePDFKey,
                parent,
                sourceLibraryKey,
                cacheKey,
                parserProfile,
                prepared,
                attachments,
                snapshotHTMLHash,
            });
            const noteHTML = serializeSavedMarkdownNote({ bodyHTML, manifest });
            note.setNote(noteHTML);
            await note.saveTx();

            await this.#removeOldAttachments(previous, createdAttachments);
            return {
                note,
                noteID: note.id,
                manifest,
                bodyHTML,
                noteHTML,
            };
        }
        catch (error) {
            await this.#rollbackSnapshot({
                note,
                existing,
                previous,
                createdAttachments,
            });
            throw error;
        }
        finally {
            await Promise.all(temporaryFiles.map(file => (
                file.cleanup?.().catch?.(() => {})
            )));
        }
    }

    async deleteSavedNote(noteItemOrID) {
        const note = await this.#resolveItem(noteItemOrID);
        if (!this.isSavedMarkdownNote(note)) {
            throw new Error('Refusing to delete an ordinary Zotero note');
        }
        const saved = await this.read(note);
        await saved.note.eraseTx();
        await this.#eraseAttachments([
            saved.sourceAttachment,
            saved.sourceMapAttachment,
        ].filter(attachment => (
            attachment
            && String(attachment.parentID || '') !== String(saved.note.id)
        )), { suppressErrors: false });
    }

    async #resolveItem(itemOrID) {
        if (itemOrID && typeof itemOrID === 'object') return itemOrID;
        const item = await this.zotero.Items.getAsync?.(itemOrID)
            || this.zotero.Items.get?.(itemOrID);
        if (!item) throw new Error('The Zotero item is unavailable');
        return item;
    }

    async #resolveParent(pdf) {
        if (pdf.parentItem) return pdf.parentItem;
        if (!pdf.parentID) return pdf;
        return this.#resolveItem(pdf.parentID);
    }

    #linkedSourceAttachmentsSync(note) {
        try {
            const parent = note.parentItem
                || this.zotero.Items.get?.(note.parentID);
            if (!parent?.isRegularItem?.()) return null;
            const values = [
                ...(note.getAttachments?.() || []),
                ...(parent.getAttachments?.() || []),
            ];
            const attachments = values
                .map(value => value && typeof value === 'object'
                    ? value
                    : this.zotero.Items.get?.(value))
                .filter(Boolean);
            return this.#sourceAttachmentPair(note, parent, attachments);
        }
        catch {
            return null;
        }
    }

    async #recoverSavedNoteHeader(note) {
        if (!note?.isNote?.()) return null;
        const parent = await this.#resolveParent(note);
        if (!parent?.isRegularItem?.()) return null;
        const [noteAttachments, parentAttachments] = await Promise.all([
            this.#childItems(note.getAttachments?.() || []),
            this.#childItems(parent.getAttachments?.() || []),
        ]);
        const pair = this.#sourceAttachmentPair(
            note,
            parent,
            [...noteAttachments, ...parentAttachments]
        );
        if (!pair) return null;
        const sourcePDF = this.#recoverSourcePDF(
            pair,
            parentAttachments.filter(item => item?.isPDFAttachment?.())
        );
        if (!sourcePDF) {
            throw new Error('The saved Markdown source PDF is ambiguous');
        }
        const noteHTML = note.getNote?.() || '';
        const bodyHTML = extractZoteroNoteBody(noteHTML);
        return {
            note,
            noteID: note.id,
            manifest: {
                schemaVersion: SAVED_MARKDOWN_NOTE_SCHEMA_VERSION,
                kind: SAVED_MARKDOWN_NOTE_KIND,
                sourcePDFKey: requiredItemKey(sourcePDF, 'PDF'),
                sourceParentKey: parent.key ? String(parent.key) : null,
                sourceLibraryKey: sourcePDF.libraryID === undefined
                    || sourcePDF.libraryID === null
                    ? null
                    : String(sourcePDF.libraryID),
                cacheKey: null,
                markdownHash: null,
                parserProfile: 'mktero-recovered-v1',
                sourceAttachmentKey: requiredItemKey(
                    pair.sourceAttachment,
                    'source attachment'
                ),
                sourceMapAttachmentKey: requiredItemKey(
                    pair.sourceMapAttachment,
                    'source map attachment'
                ),
                assetBasePath: '',
                assets: [],
                snapshotHTMLHash: null,
                createdAt: String(note.dateAdded || this.now()),
            },
            noteHTML,
            bodyHTML,
            recovered: true,
            sourceAttachment: pair.sourceAttachment,
            sourceMapAttachment: pair.sourceMapAttachment,
        };
    }

    #sourceAttachmentPair(note, parent, attachments) {
        const sourceAttachment = attachments.find(attachment => (
            this.#ownedSourceAttachment(
                attachment,
                SOURCE_MARKDOWN_ATTACHMENT_TITLE,
                note,
                parent
            )
        )) || null;
        const sourceMapAttachment = attachments.find(attachment => (
            this.#ownedSourceAttachment(
                attachment,
                SOURCE_MAP_ATTACHMENT_TITLE,
                note,
                parent
            )
        )) || null;
        return sourceAttachment && sourceMapAttachment
            ? { sourceAttachment, sourceMapAttachment }
            : null;
    }

    #recoverSourcePDF(pair, pdfItems) {
        const related = pdfItems.filter(pdf => (
            this.#hasRelatedItem(pair.sourceAttachment, pdf)
            && this.#hasRelatedItem(pair.sourceMapAttachment, pdf)
        ));
        if (related.length === 1) return related[0];
        return pdfItems.length === 1 ? pdfItems[0] : null;
    }

    #hasRelatedItem(attachment, item) {
        try {
            const relation = this.#sourceAttachmentRelation(item);
            return Boolean(attachment.hasRelation?.(
                relation.predicate,
                relation.object
            ));
        }
        catch {
            return false;
        }
    }

    #recoverSnapshotAssets({ markdown, bodyHTML, noteAttachments }) {
        const attachmentKeys = extractSnapshotImageAttachmentKeys(bodyHTML);
        if (typeof markdown !== 'string') {
            return { assets: [], complete: attachmentKeys.length === 0 };
        }
        const hrefs = [];
        try {
            this.renderHTML(markdown, {
                resolveImageAttachmentKey: href => {
                    const index = hrefs.length;
                    hrefs.push(href);
                    return attachmentKeys[index] || null;
                },
                translate: this.translate,
            });
        }
        catch {
            return { assets: [], complete: false };
        }

        const attachments = new Map(noteAttachments.map(attachment => (
            [String(attachment.key || ''), attachment]
        )));
        const assets = [];
        const seenPaths = new Set();
        let complete = hrefs.length === attachmentKeys.length;
        for (let index = 0; index < Math.min(
            hrefs.length,
            attachmentKeys.length
        ); index++) {
            const attachmentKey = attachmentKeys[index];
            const attachment = attachments.get(attachmentKey);
            const path = recoverAssetPath(hrefs[index]);
            const mimeType = String(
                attachment?.attachmentContentType || ''
            );
            if (!attachment
                || !path
                || !/^image\/[A-Za-z0-9.+-]+$/.test(mimeType)) {
                complete = false;
                continue;
            }
            if (seenPaths.has(path)) continue;
            seenPaths.add(path);
            assets.push({ path, attachmentKey, mimeType });
        }
        return { assets, complete };
    }

    async #createNote(parent) {
        const note = new this.zotero.Item('note');
        note.parentID = parent.id;
        note.setNote(`<p>${escapeHTML(this.preparingNoteText)}</p>`);
        await note.saveTx();
        return note;
    }

    async #childItems(values) {
        const resolvedValues = await Promise.resolve(values);
        const items = [];
        for (const value of resolvedValues || []) {
            const item = await this.#resolveItem(value).catch(() => null);
            if (item) items.push(item);
        }
        return items;
    }

    async #readAttachment(attachment, maxBytes) {
        let path;
        try {
            path = await attachment.getFilePathAsync?.();
        }
        catch {
            return null;
        }
        if (!path) return null;
        let data;
        try {
            data = toUint8Array(
                await this.readFile(path),
                'Zotero attachment'
            );
        }
        catch {
            return null;
        }
        if (data.length > maxBytes) {
            return null;
        }
        return data;
    }

    async #readUTF8Attachment(attachment, maxBytes) {
        const data = await this.#readAttachment(attachment, maxBytes);
        if (!data) return null;
        return new TextDecoder().decode(data);
    }

    #ownedSourceAttachment(attachment, expectedTitle, note, parent) {
        if (!attachment) return null;
        try {
            if (String(attachment.getField?.('title') || '') !== expectedTitle) {
                return null;
            }
            const attachmentParentID = String(attachment.parentID || '');
            if (attachmentParentID === String(note?.id || '')) {
                return attachment;
            }
            if (attachmentParentID !== String(parent?.id || '')) {
                return null;
            }
            const relation = this.#sourceAttachmentRelation(note);
            return attachment.hasRelation?.(relation.predicate, relation.object)
                ? attachment
                : null;
        }
        catch {
            return null;
        }
    }

    #sourceAttachmentRelation(note) {
        const predicate = String(
            this.zotero.Relations.relatedItemPredicate || ''
        );
        const object = String(this.zotero.URI.getItemURI(note) || '');
        if (!predicate || !object) {
            throw new Error('The Zotero source attachment relation is unavailable');
        }
        return { predicate, object };
    }

    async #prepareSnapshot({ markdown, assets, assetBasePath, sourceMap }) {
        const normalizedAssets = normalizeAssets(assets);
        const sourceMapJSON = serializeSourceMapJSON(sourceMap, markdown.length);
        return {
            markdown,
            normalizedAssets,
            sourceMapJSON,
            markdownHash: await this.hash(new TextEncoder().encode(markdown)),
            assetBasePath: assetBasePath
                ? normalizeAssetPath(assetBasePath)
                : '',
        };
    }

    async #importSnapshotAttachments(
        note,
        parent,
        pdf,
        prepared,
        temporaryFiles,
        createdAttachments
    ) {
        const sourceAttachment = await this.#importTextAttachment(
            note,
            parent,
            pdf,
            SOURCE_MARKDOWN_ATTACHMENT_TITLE,
            'mktero-source',
            prepared.markdown,
            temporaryFiles,
            'text/markdown',
            createdAttachments
        );
        const sourceMapAttachment = await this.#importTextAttachment(
            note,
            parent,
            pdf,
            SOURCE_MAP_ATTACHMENT_TITLE,
            'mktero-source-map',
            prepared.sourceMapJSON,
            temporaryFiles,
            'application/json',
            createdAttachments
        );

        const assetAttachments = [];
        for (const asset of prepared.normalizedAssets) {
            const attachment = await this.#importImageAttachment(
                note,
                asset,
                createdAttachments
            );
            assetAttachments.push({
                ...asset,
                attachmentKey: requiredItemKey(attachment, 'image attachment'),
            });
        }
        return { sourceAttachment, sourceMapAttachment, assetAttachments };
    }

    #createSnapshotManifest({
        sourcePDFKey,
        parent,
        sourceLibraryKey,
        cacheKey,
        parserProfile,
        prepared,
        attachments,
        snapshotHTMLHash,
    }) {
        return createSavedMarkdownManifest({
            sourcePDFKey,
            sourceParentKey: parent.key ? String(parent.key) : null,
            sourceLibraryKey,
            cacheKey,
            markdownHash: prepared.markdownHash,
            parserProfile,
            sourceAttachmentKey: requiredItemKey(
                attachments.sourceAttachment,
                'source attachment'
            ),
            sourceMapAttachmentKey: requiredItemKey(
                attachments.sourceMapAttachment,
                'source map attachment'
            ),
            assetBasePath: prepared.assetBasePath,
            assets: attachments.assetAttachments.map(asset => ({
                path: asset.path,
                attachmentKey: asset.attachmentKey,
                mimeType: asset.mimeType,
            })),
            snapshotHTMLHash,
            createdAt: this.now(),
        });
    }

    async #rollbackSnapshot({
        note,
        existing,
        previous,
        createdAttachments,
    }) {
        await this.#eraseAttachments(createdAttachments);
        if (existing && previous) {
            try {
                existing.setNote(previous.noteHTML);
                await existing.saveTx();
            }
            catch {
                // Preserve the original error; the note may need manual repair.
            }
        }
        else if (!existing) {
            await note.eraseTx?.().catch?.(() => {});
        }
    }

    async #importTextAttachment(
        note,
        parent,
        pdf,
        title,
        fileBaseName,
        text,
        temporaryFiles,
        contentType,
        createdAttachments
    ) {
        const data = new TextEncoder().encode(text);
        const temporary = await this.writeTemporaryFile({
            name: fileBaseName,
            data,
        });
        temporaryFiles.push(temporary);
        const imported = await this.zotero.Attachments.importFromFile({
            file: temporary.file || temporary.path,
            parentItemID: parent.id,
            title,
            contentType,
            charset: 'utf-8',
            fileBaseName,
        });
        const attachment = await this.#normalizeImportedItem(imported);
        createdAttachments.push(attachment);
        if (typeof attachment.addRelation !== 'function') {
            throw new Error('The Zotero source attachment relation is unavailable');
        }
        for (const item of [note, pdf]) {
            const relation = this.#sourceAttachmentRelation(item);
            attachment.addRelation(relation.predicate, relation.object);
        }
        attachment.setField?.('title', title);
        await attachment.saveTx?.();
        return attachment;
    }

    async #importImageAttachment(note, asset, createdAttachments) {
        const blob = this.createBlob([asset.data], { type: asset.mimeType });
        const imported = await this.zotero.Attachments.importEmbeddedImage({
            blob,
            parentItemID: note.id,
        });
        const attachment = await this.#normalizeImportedItem(imported);
        createdAttachments.push(attachment);
        attachment.setField?.('title', INTERNAL_IMAGE_PREFIX + asset.path);
        await attachment.saveTx?.();
        return attachment;
    }

    async #normalizeImportedItem(imported) {
        const item = imported && typeof imported === 'object'
            ? imported
            : await this.#resolveItem(imported);
        if (!item?.id || !item.key) {
            throw new Error('Zotero did not return the imported attachment');
        }
        return item;
    }

    async #removeOldAttachments(previous, keep) {
        if (!previous?.note) return;
        const keepKeys = new Set(keep.map(item => String(item.key || '')));
        const oldKeys = new Set([
            previous.manifest.sourceAttachmentKey,
            previous.manifest.sourceMapAttachmentKey,
            ...previous.manifest.assets.map(asset => asset.attachmentKey),
        ]);
        const previousAttachments = [
            previous.sourceAttachment,
            previous.sourceMapAttachment,
            ...await this.#childItems(previous.note.getAttachments?.() || []),
        ].filter(Boolean);
        for (const attachment of previousAttachments) {
            if (!oldKeys.has(String(attachment.key))
                || keepKeys.has(String(attachment.key))) {
                continue;
            }
            try {
                await attachment.eraseTx?.();
            }
            catch {
                // Stale Mktero attachments are harmless if cleanup is unavailable.
            }
        }
    }

    async #eraseAttachments(attachments, { suppressErrors = true } = {}) {
        const results = await Promise.allSettled(
            attachments.map(async attachment => {
                await attachment?.eraseTx?.();
            })
        );
        if (suppressErrors) return;
        const failure = results.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
    }

}

export function createZoteroSavedMarkdownStore(options) {
    return new ZoteroSavedMarkdownStore(options);
}

export function createZoteroBlobFactory({
    zotero,
    services = null,
    globalObject = globalThis,
} = {}) {
    return (parts, options) => {
        let mainWindow = null;
        try {
            mainWindow = zotero?.getMainWindow?.() || null;
        }
        catch {
            mainWindow = null;
        }
        const hiddenDOMWindow = services?.appShell?.hiddenDOMWindow || null;
        const BlobType = [mainWindow, hiddenDOMWindow, globalObject]
            .map(window => window?.Blob)
            .find(candidate => typeof candidate === 'function');
        if (!BlobType) {
            throw new Error('The Zotero runtime cannot create image attachments');
        }
        return new BlobType(parts, options);
    };
}

function requiredItemKey(item, label) {
    const key = String(item?.key || '');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(key)) {
        throw new Error('Zotero returned an invalid ' + label + ' key');
    }
    return key;
}

function normalizeAssets(assets) {
    if (!Array.isArray(assets) || assets.length > MAX_ASSETS) {
        throw new Error('Saved Markdown images are invalid');
    }
    const seen = new Set();
    let totalBytes = 0;
    return assets.map(asset => {
        const path = normalizeAssetPath(asset?.path);
        const mimeType = String(asset?.mimeType || '');
        const data = toUint8Array(asset?.data, 'Saved Markdown image');
        totalBytes += data.length;
        if (!/^image\/[A-Za-z0-9.+-]+$/.test(mimeType)
            || data.length > MAX_ASSET_BYTES
            || totalBytes > MAX_TOTAL_ASSET_BYTES
            || seen.has(path)) {
            throw new Error('Saved Markdown image metadata is invalid');
        }
        seen.add(path);
        return { path, mimeType, data };
    });
}

function extractSnapshotImageAttachmentKeys(bodyHTML) {
    const keys = [];
    const pattern = /<img\b[^>]*\bdata-attachment-key\s*=\s*(?:"([A-Za-z0-9_-]{1,128})"|'([A-Za-z0-9_-]{1,128})')[^>]*>/gi;
    for (const match of String(bodyHTML || '').matchAll(pattern)) {
        keys.push(match[1] || match[2]);
        if (keys.length > MAX_ASSETS) break;
    }
    return keys;
}

function recoverAssetPath(href) {
    const source = String(href || '').split(/[?#]/, 1)[0];
    if (!source
        || /^[a-z][a-z0-9+.-]*:/i.test(source)
        || source.startsWith('/')) {
        return null;
    }
    let decoded;
    try {
        decoded = decodeURIComponent(source);
    }
    catch {
        return null;
    }
    try {
        return normalizeAssetPath(decoded);
    }
    catch {
        return null;
    }
}

function normalizeAssetPath(path) {
    const source = String(path || '');
    if (!source
        || source.startsWith('/')
        || source.includes('\\')
        || source.includes('\u0000')) {
        throw new Error('Saved Markdown image path is invalid');
    }
    const segments = [];
    for (const segment of source.split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') throw new Error('Saved Markdown image path escapes its root');
        segments.push(segment);
    }
    const normalized = segments.join('/');
    if (!normalized || normalized.length > 1_024) {
        throw new Error('Saved Markdown image path is invalid');
    }
    return normalized;
}

function resolveAssetAttachmentKey(basePath, href, assets) {
    const source = String(href || '').split(/[?#]/, 1)[0];
    if (!source || /^[a-z][a-z0-9+.-]*:/i.test(source) || source.startsWith('/')) {
        return null;
    }
    let decoded;
    try {
        decoded = decodeURIComponent(source);
    }
    catch {
        return null;
    }
    if (decoded.split('/').includes('..') || decoded.includes('\\')) return null;
    const candidate = joinAssetPath(basePath, decoded);
    const direct = normalizeRelativeAssetPath(decoded);
    return assets.find(asset => asset.path === candidate || asset.path === direct)
        ?.attachmentKey || null;
}

function joinAssetPath(basePath, relativePath) {
    const base = normalizeRelativeAssetPath(basePath);
    const relative = normalizeRelativeAssetPath(relativePath);
    return base ? base + '/' + relative : relative;
}

function normalizeRelativeAssetPath(path) {
    const source = String(path || '');
    if (source.includes('\\')) return '';
    const segments = [];
    for (const segment of source.split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            segments.pop();
            continue;
        }
        segments.push(segment);
    }
    return segments.join('/');
}

function parseSourceMap(sourceMapJSON, markdownLength) {
    let sourceMap;
    try {
        sourceMap = JSON.parse(sourceMapJSON);
    }
    catch {
        return null;
    }
    if (!Array.isArray(sourceMap) || sourceMap.length > MAX_SOURCE_MAP_ENTRIES) {
        return null;
    }
    let locationCount = 0;
    for (const entry of sourceMap) {
        if (!isValidSourceMapEntry(entry, markdownLength)) return null;
        locationCount += entry.locations.length;
        if (locationCount > 100_000
            || entry.locations.some(location => !isValidSourceLocation(location))) {
            return null;
        }
    }
    return sourceMap;
}

function serializeSourceMapJSON(sourceMap, markdownLength) {
    try {
        const validEntries = sourceMap.length > MAX_SOURCE_MAP_ENTRIES
            ? []
            : sourceMap.filter(entry => isValidSourceMapEntry(entry, markdownLength));
        const serialized = JSON.stringify(validEntries);
        return new TextEncoder().encode(serialized).length > MAX_SOURCE_MAP_BYTES
            ? '[]'
            : serialized;
    }
    catch {
        return '[]';
    }
}

function escapeHTML(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
