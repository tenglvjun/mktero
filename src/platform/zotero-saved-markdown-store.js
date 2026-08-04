import {
    createSavedMarkdownManifest,
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
        hash = sha256Hex,
        renderHTML = renderZoteroNoteHTML,
        preparingNoteText = '',
        now,
    }) {
        if (!zotero?.Items || !zotero?.Attachments) {
            throw new TypeError('A Zotero item and attachment API is required');
        }
        if (typeof readFile !== 'function') {
            throw new TypeError('A binary file reader is required');
        }
        if (typeof writeTemporaryFile !== 'function') {
            throw new TypeError('A temporary file writer is required');
        }
        if (typeof now !== 'function') {
            throw new TypeError('A saved Markdown clock is required');
        }
        this.zotero = zotero;
        this.readFile = readFile;
        this.writeTemporaryFile = writeTemporaryFile;
        this.hash = hash;
        this.renderHTML = renderHTML;
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
            let parsed;
            try {
                parsed = parseSavedMarkdownNote(child.getNote?.() || '');
            }
            catch {
                continue;
            }
            const manifest = parsed.manifest;
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
        return Boolean(item?.isNote?.()
            && isSavedMarkdownNote(item.getNote?.() || ''));
    }

    async readManifest(noteItemOrID) {
        const note = await this.#resolveItem(noteItemOrID);
        if (!this.isSavedMarkdownNote(note)) {
            throw new Error('This Zotero note is not a Mktero saved Markdown note');
        }
        const parsed = parseSavedMarkdownNote(note.getNote());
        return {
            note,
            noteID: note.id,
            manifest: parsed.manifest,
            noteHTML: parsed.noteHTML,
            bodyHTML: parsed.bodyHTML,
        };
    }

    async read(noteItemOrID) {
        const header = await this.readManifest(noteItemOrID);
        const {
            note,
            noteID,
            manifest,
            noteHTML,
            bodyHTML,
        } = header;
        const attachments = new Map(
            (await this.#childItems(note.getAttachments?.() || []))
                .filter(attachment => attachment?.key)
                .map(attachment => [String(attachment.key), attachment])
        );

        const sourceAttachment = attachments.get(manifest.sourceAttachmentKey) || null;
        const sourceMapAttachment
            = attachments.get(manifest.sourceMapAttachmentKey) || null;
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
        const sourceAvailable = sourceHash === manifest.markdownHash;

        const assets = [];
        let assetsComplete = true;
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

        const snapshotHash = await this.hash(
            new TextEncoder().encode(bodyHTML)
        );
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
            snapshotModified: snapshotHash !== manifest.snapshotHTMLHash,
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
        const parent = parentItem
            ? await this.#resolveItem(parentItem)
            : await this.#resolveParent(pdf);
        if (!parent?.id) {
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
        const originalAttachmentKeys = new Set(
            (await this.#childItems(note.getAttachments?.() || []))
                .map(attachment => String(attachment.key || ''))
        );
        const createdAttachments = [];
        const temporaryFiles = [];
        try {
            const attachments = await this.#importSnapshotAttachments(
                note,
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
                originalAttachmentKeys,
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
        await note.eraseTx();
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

    async #prepareSnapshot({ markdown, assets, assetBasePath, sourceMap }) {
        const normalizedAssets = normalizeAssets(assets);
        const sourceMapJSON = JSON.stringify(sourceMap);
        if (new TextEncoder().encode(sourceMapJSON).length > MAX_SOURCE_MAP_BYTES) {
            throw new Error('Saved Markdown source map exceeds the size limit');
        }
        validateSourceMap(sourceMap, markdown.length);
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
        prepared,
        temporaryFiles,
        createdAttachments
    ) {
        const sourceAttachment = await this.#importTextAttachment(
            note,
            SOURCE_MARKDOWN_ATTACHMENT_TITLE,
            'mktero-source',
            prepared.markdown,
            temporaryFiles,
            'text/markdown'
        );
        createdAttachments.push(sourceAttachment);
        const sourceMapAttachment = await this.#importTextAttachment(
            note,
            SOURCE_MAP_ATTACHMENT_TITLE,
            'mktero-source-map',
            prepared.sourceMapJSON,
            temporaryFiles,
            'application/json'
        );
        createdAttachments.push(sourceMapAttachment);

        const assetAttachments = [];
        for (const asset of prepared.normalizedAssets) {
            const attachment = await this.#importImageAttachment(note, asset);
            createdAttachments.push(attachment);
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
        originalAttachmentKeys,
    }) {
        await this.#eraseAttachments(createdAttachments);
        await this.#eraseNewAttachments(note, originalAttachmentKeys);
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
        title,
        fileBaseName,
        text,
        temporaryFiles,
        contentType
    ) {
        const data = new TextEncoder().encode(text);
        const temporary = await this.writeTemporaryFile({
            name: fileBaseName,
            data,
        });
        temporaryFiles.push(temporary);
        const imported = await this.zotero.Attachments.importFromFile({
            file: temporary.file || temporary.path,
            parentItemID: note.id,
            title,
            contentType,
            charset: 'utf-8',
            fileBaseName,
        });
        const attachment = await this.#normalizeImportedItem(imported);
        attachment.setField?.('title', title);
        await attachment.saveTx?.();
        return attachment;
    }

    async #importImageAttachment(note, asset) {
        if (typeof Blob !== 'function') {
            throw new Error('The Zotero runtime cannot create image attachments');
        }
        const blob = new Blob([asset.data], { type: asset.mimeType });
        const imported = await this.zotero.Attachments.importEmbeddedImage({
            blob,
            parentItemID: note.id,
        });
        const attachment = await this.#normalizeImportedItem(imported);
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
        for (const attachment of await this.#childItems(
            previous.note.getAttachments?.() || []
        )) {
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

    async #eraseAttachments(attachments) {
        await Promise.all(attachments.map(async attachment => {
            try {
                await attachment?.eraseTx?.();
            }
            catch {
                // Rollback is best effort after a failed Zotero transaction.
            }
        }));
    }

    async #eraseNewAttachments(note, originalKeys) {
        const current = await this.#childItems(note?.getAttachments?.() || []);
        await this.#eraseAttachments(current.filter(attachment => (
            !originalKeys.has(String(attachment.key || ''))
        )));
    }
}

export function createZoteroSavedMarkdownStore(options) {
    return new ZoteroSavedMarkdownStore(options);
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

function validateSourceMap(sourceMap, markdownLength) {
    if (sourceMap.length > MAX_SOURCE_MAP_ENTRIES
        || sourceMap.some(entry => !isValidSourceMapEntry(entry, markdownLength))) {
        throw new Error('Saved Markdown source map is invalid');
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
