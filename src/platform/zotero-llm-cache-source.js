import { sha256Hex } from '../core/sha256.js';
import {
    LLM_CACHE_LIMITS, LLMCacheError, isLLMCacheImagePath, isLLMCacheInputPath,
    normalizeLLMCachePath, throwIfLLMCacheAborted,
} from '../mineru/llm-cache-bundle.js';

const PENDING = '_llm_write_pending.json';

/** Read-only Zotero filesystem boundary. All I/O can be replaced in tests. */
export function createZoteroLLMCacheSource({
    zotero,
    io = globalThis.IOUtils,
    path = globalThis.PathUtils,
    hash = sha256Hex,
    createFile = zotero?.File?.pathToFile?.bind(zotero.File),
    canonicalizeRoot = null,
    yieldToUI = () => new Promise(resolve => globalThis.setTimeout(resolve, 0)),
    limits: overrides,
} = {}) {
    if (!zotero || !io?.stat || !io?.read || !io?.getChildren || !path?.join) {
        throw new TypeError('Zotero and read-only filesystem adapters are required');
    }
    const limits = { ...LLM_CACHE_LIMITS, ...overrides };
    const encoder = new TextEncoder();

    async function baseDirectory() {
        const configured = zotero.DataDirectory?.dir;
        const value = typeof configured === 'string' && configured.trim()
            ? configured : zotero.Profile?.dir;
        if (typeof value !== 'string' || !value.trim()) {
            throw new LLMCacheError('LLM_CACHE_NO_DATA_DIRECTORY', 'The Zotero data directory is unavailable');
        }
        if (canonicalizeRoot) return canonicalizeRoot(value.trim());
        if (createFile) {
            const file = createFile(value.trim());
            file.normalize?.();
            return file.path;
        }
        return value.trim();
    }

    async function sourceDirectory(attachment) {
        assertAttachment(attachment);
        const base = await baseDirectory();
        const cacheRoot = path.join(base, 'llm-for-zotero-mineru');
        const root = path.join(cacheRoot, String(attachment.id));
        await assertSafeNode(cacheRoot, 'directory');
        await assertSafeNode(root, 'directory');
        return root;
    }

    async function stat(filePath) {
        try {
            if (createFile) {
                const file = createFile(filePath);
                if (file.isSymlink?.()) {
                    throw new LLMCacheError('LLM_CACHE_UNSAFE_PATH', 'Symbolic links inside the local cache are not supported');
                }
            }
            const info = await io.stat(filePath, { followSymlinks: false });
            if (info.type === 'symlink' || info.type === 'symbolic-link' || info.isSymlink === true) {
                throw new LLMCacheError('LLM_CACHE_UNSAFE_PATH', 'Symbolic links inside the local cache are not supported');
            }
            return info;
        }
        catch (error) {
            if (isMissing(error)) return null;
            throw error;
        }
    }

    async function assertSafeNode(filePath, type) {
        const info = await stat(filePath);
        if (!info || info.type !== type) {
            throw new LLMCacheError('LLM_CACHE_NOT_FOUND', 'The local cache is unavailable');
        }
        return info;
    }

    async function assertNotWriting(root, signal) {
        throwIfLLMCacheAborted(signal);
        if (await stat(path.join(root, PENDING))) {
            throw new LLMCacheError('LLM_CACHE_WRITING', 'The source plugin is still writing its cache');
        }
        throwIfLLMCacheAborted(signal);
    }

    async function probeCandidate(attachment, { signal } = {}) {
        throwIfLLMCacheAborted(signal);
        try {
            const root = await sourceDirectory(attachment);
            await assertNotWriting(root, signal);
            const markdown = await stat(path.join(root, 'full.md'));
            if (markdown?.type !== 'regular' || !Number.isSafeInteger(markdown.size) || markdown.size < 1) return false;
            const pdfPath = await attachment.getFilePathAsync?.() || attachment.getFilePath?.();
            throwIfLLMCacheAborted(signal);
            if (!pdfPath) return false;
            const pdf = await stat(pdfPath);
            throwIfLLMCacheAborted(signal);
            return pdf?.type === 'regular' && pdf.size > 0;
        }
        catch (error) {
            throwIfLLMCacheAborted(signal);
            if (error instanceof LLMCacheError || isMissing(error)) return false;
            throw error;
        }
    }

    async function collect(root, signal, { retainEntries = true } = {}) {
        await assertSafeNode(root, 'directory');
        await assertNotWriting(root, signal);
        const entries = [];
        const fingerprints = [];
        let visited = 0;
        let total = 0;
        let assetTotal = 0;
        let assetCount = 0;
        const seen = new Set();
        async function visit(directory, relative, depth) {
            if (depth > limits.maxDepth) resourceError();
            throwIfLLMCacheAborted(signal);
            const children = await io.getChildren(directory);
            if (!Array.isArray(children) || visited + children.length > limits.maxEntries) resourceError();
            visited += children.length;
            for (const child of children.sort()) {
                throwIfLLMCacheAborted(signal);
                // getChildren must return immediate children, never arbitrary paths.
                const prefix = directory.replace(/[\\/]$/u, '') + (directory.includes('\\') ? '\\' : '/');
                if (typeof child !== 'string' || !child.startsWith(prefix)) unsafePath();
                const leaf = child.slice(prefix.length);
                if (!leaf || /[\\/]/u.test(leaf) || leaf === '.' || leaf === '..') unsafePath();
                const name = normalizeLLMCachePath(relative ? `${relative}/${leaf}` : leaf);
                if (seen.has(name)) unsafePath();
                seen.add(name);
                const info = await stat(child);
                if (!info) changed();
                if (info.type === 'directory') await visit(child, name, depth + 1);
                else if (name === PENDING) {
                    throw new LLMCacheError('LLM_CACHE_WRITING', 'The source plugin is still writing its cache');
                }
                else if (isLLMCacheInputPath(name)) {
                    if (info.type !== 'regular' || !Number.isSafeInteger(info.size) || info.size < 0) unsafePath();
                    const image = isLLMCacheImagePath(name);
                    const max = image ? limits.maxAssetBytes
                        : name === 'full.md' ? limits.maxMarkdownBytes : limits.maxJSONBytes;
                    if (info.size > max || total + info.size > limits.maxTotalBytes) resourceError();
                    if (image && (assetTotal + info.size > limits.maxTotalAssetBytes
                        || ++assetCount > limits.maxAssets)) resourceError();
                    const data = await io.read(child, { maxBytes: max + 1 });
                    throwIfLLMCacheAborted(signal);
                    if (!ArrayBuffer.isView(data) || data.BYTES_PER_ELEMENT !== 1
                        || data.byteLength !== info.size || data.byteLength > max) changed();
                    const after = await stat(child);
                    if (!after || after.type !== info.type || after.size !== info.size
                        || modified(after) !== modified(info)) changed();
                    total += data.byteLength;
                    if (image) assetTotal += data.byteLength;
                    if (retainEntries) entries.push({ path: name, data });
                    fingerprints.push({ path: name, size: data.byteLength,
                        modified: modified(after), hash: await hash(data) });
                }
                await yieldToUI();
                throwIfLLMCacheAborted(signal);
            }
        }
        await visit(root, '', 0);
        await assertNotWriting(root, signal);
        fingerprints.sort((left, right) => left.path.localeCompare(right.path, 'en'));
        const readFingerprint = await hash(encoder.encode(JSON.stringify(fingerprints)));
        throwIfLLMCacheAborted(signal);
        return { entries, readFingerprint };
    }

    async function capture(attachment, { signal } = {}) {
        throwIfLLMCacheAborted(signal);
        const root = await sourceDirectory(attachment);
        const identity = { id: attachment.id, key: attachment.key, libraryID: attachment.libraryID };
        const captured = await collect(root, signal);
        const recheck = await collect(root, signal, { retainEntries: false });
        if (captured.readFingerprint !== recheck.readFingerprint) changed();
        assertAttachmentIdentity(attachment, identity);
        return { ...captured, sourceRoot: root, attachment: identity };
    }

    async function verify(snapshot, { signal } = {}) {
        throwIfLLMCacheAborted(signal);
        if (!snapshot?.attachment || typeof snapshot.readFingerprint !== 'string') {
            throw new TypeError('A captured local cache snapshot is required');
        }
        const current = zotero.Items?.get
            ? zotero.Items.get(snapshot.attachment.id)
            : await zotero.Items?.getAsync?.(snapshot.attachment.id);
        if (current) assertAttachmentIdentity(current, snapshot.attachment);
        else if (zotero.Items?.get || zotero.Items?.getAsync) changed();
        const root = await sourceDirectory(current || {
            ...snapshot.attachment, isPDFAttachment: () => true,
        });
        if (root !== snapshot.sourceRoot) changed();
        const check = await collect(root, signal, { retainEntries: false });
        if (check.readFingerprint !== snapshot.readFingerprint) changed();
        return true;
    }

    return { probeCandidate, capture, verify };
}

function assertAttachment(item) {
    if (!Number.isSafeInteger(item?.id) || item.id < 1 || item.deleted
        || typeof item.isPDFAttachment === 'function' && !item.isPDFAttachment()) {
        throw new LLMCacheError('LLM_CACHE_INVALID_ATTACHMENT', 'A current PDF attachment is required');
    }
}

function assertAttachmentIdentity(item, identity) {
    assertAttachment(item);
    if (item.id !== identity.id || item.key !== identity.key || item.libraryID !== identity.libraryID) changed();
}

function modified(info) {
    const value = info.lastModified ?? info.lastModificationDate ?? null;
    return value instanceof Date ? value.getTime() : value;
}

function isMissing(error) {
    return ['NotFoundError', 'NS_ERROR_FILE_NOT_FOUND'].includes(error?.name) || error?.code === 'ENOENT';
}

function changed() {
    throw new LLMCacheError('LLM_CACHE_CHANGED', 'The source cache changed during import; wait for the source plugin to finish');
}

function unsafePath() {
    throw new LLMCacheError('LLM_CACHE_UNSAFE_PATH', 'The local cache contains an unsafe filesystem entry');
}

function resourceError() {
    throw new LLMCacheError('LLM_CACHE_RESOURCE_LIMIT', 'The local cache exceeds its resource budget');
}
