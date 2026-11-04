import { CacheLifecycle, attachmentIdentity, normalizeCacheOwnership } from '../cache/cache-lifecycle.js';
import { ownedCacheResources } from '../cache/cache-owned-resources.js';
import { sha256Hex } from '../core/sha256.js';

const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_SCAN_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_SCAN_ITEMS = 50_000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export function createCacheOwnershipStorage({ zotero, ioUtils: io, pathUtils: path }) {
    const root = path.join(zotero.Profile.dir, 'mktero-cache-owners', 'v1');
    const file = path.join(root, 'index.json');
    return {
        async read() {
            if (!(await io.exists(file))) return [];
            const info = await io.stat(file);
            if (info.type !== 'regular' || info.size > MAX_INDEX_BYTES) throw new Error('Invalid cache ownership index size');
            const data = JSON.parse(await io.readUTF8(file));
            if (data.schemaVersion !== 1) throw new Error('Unsupported cache ownership index');
            return normalizeCacheOwnership(data.records);
        },
        async write(records) {
            const json = JSON.stringify({ schemaVersion: 1, records: normalizeCacheOwnership(records) });
            if (new TextEncoder().encode(json).length > MAX_INDEX_BYTES) throw new Error('Cache ownership index is full');
            await io.makeDirectory(path.parent(root), { ignoreExisting: true });
            await io.makeDirectory(root, { ignoreExisting: true });
            await io.writeUTF8(file, json, { tmpPath: `${file}.tmp` });
        },
    };
}

// getAll(..., false, true) includes child attachments AND trashed items. A
// missing local file never causes a download and cannot establish orphanhood.
export function createCacheLibrarySnapshot({ zotero, ioUtils: io, yieldControl = async () => {}, cancelled = () => false }) {
    return async ({ hashes, sourceSizes = null }) => {
        const sizes = sourceSizes ? new Set(sourceSizes) : null;
        const result = { complete: false, owners: new Set(), libraries: new Set(), itemIDs: new Set(), sources: new Set() };
        if (typeof zotero.Libraries?.getAll !== 'function' || typeof zotero.Items?.getAll !== 'function') return result;
        const libraries = zotero.Libraries.getAll();
        if (!Array.isArray(libraries) || !libraries.length) return result;
        let bytes = 0;
        let count = 0;
        for (const library of libraries) {
            if (cancelled() || !Number.isSafeInteger(library.libraryID)) return result;
            result.libraries.add(library.libraryID);
            const items = await zotero.Items.getAll(library.libraryID, false, true);
            if (!Array.isArray(items)) return result;
            for (const item of items) {
                if (cancelled() || ++count > MAX_SCAN_ITEMS || !Number.isSafeInteger(item?.id)) return result;
                result.itemIDs.add(item.id);
                if (!item.isPDFAttachment?.()) continue;
                result.owners.add(attachmentIdentity({ libraryID: item.libraryID, attachmentKey: item.key }));
                if (!hashes) continue;
                const file = await item.getFilePathAsync();
                if (!file) return result;
                const before = await io.stat(file);
                if (before.type !== 'regular' || !Number.isSafeInteger(before.size) || before.size < 0
                    || !Number.isFinite(before.lastModified)) return result;
                if (sizes && !sizes.has(before.size)) continue;
                if (!before.size || before.size > MAX_PDF_BYTES) return result;
                bytes += before.size;
                if (bytes > MAX_SCAN_BYTES) return result;
                const data = await io.read(file);
                if (data.byteLength !== before.size) return result;
                const hash = await sha256Hex(data);
                const after = await io.stat(file);
                if (after.size !== before.size || after.lastModified !== before.lastModified) return result;
                result.sources.add(hash);
                await yieldControl();
            }
        }
        result.complete = !cancelled();
        return result;
    };
}

export function createZoteroCacheLifecycle({ zotero, ioUtils, pathUtils, pdfIndexProfile,
    stores, annotations, groups, importIndex, readiness, isBusy, timers,
    onError = () => {}, now = Date.now }) {
    let stopped = false;
    let observerID = null;
    let timer = null;
    let nextRun = Infinity;
    const removers = Object.fromEntries(Object.entries(stores).map(([name, store]) => [name, store.delete.bind(store)]));
    const removeAnnotations = annotations.delete.bind(annotations);
    const removeGroups = groups.delete.bind(groups);
    const forgetImports = importIndex.forgetAttachment.bind(importIndex);
    const lifecycle = new CacheLifecycle({
        storage: createCacheOwnershipStorage({ zotero, ioUtils, pathUtils }),
        snapshot: createCacheLibrarySnapshot({ zotero, ioUtils,
            cancelled: () => stopped || isBusy() || lifecycle.users > 0,
            yieldControl: () => zotero.Promise?.delay?.(0) ?? Promise.resolve(),
        }),
        remove: ({ store, key }) => removers[store](key),
        removeOwner: async record => {
            await removeAnnotations(record.itemID);
            await removeGroups(record.itemID);
            await forgetImports(record);
            await readiness?.forgetAttachment(record);
        },
        isBusy, onError: () => report(), now,
    });

    // Capture removers first: GC bypasses these leases while ordinary writes
    // wait for its critical section. New activity also invalidates its scan.
    for (const store of [...Object.values(stores), annotations, groups, importIndex]) {
        for (const method of ['get', 'put', 'load', 'save', 'delete', 'getTranslation', 'putTranslation',
            'copyTranslations', 'deleteTranslation', 'clear', 'prune', 'setAside', 'publish', 'forget', 'forgetAttachment']) {
            if (typeof store[method] !== 'function') continue;
            const original = store[method].bind(store);
            store[method] = (...args) => lifecycle.use(() => original(...args));
        }
    }

    const report = () => {
        // Do not log paths, file contents, or errors from user-controlled files.
        try { onError(new Error('Local cache ownership maintenance deferred')); }
        catch { /* Diagnostics are optional. */ }
    };
    const schedule = delay => {
        if (stopped || !timers?.setTimer || nextRun <= now() + delay) return;
        if (timer !== null) timers.clearTimer(timer);
        nextRun = now() + delay;
        timer = timers.setTimer(() => {
            timer = null;
            nextRun = Infinity;
            return lifecycle.sweep().catch(report).finally(() => schedule(SWEEP_INTERVAL_MS));
        }, delay);
        if (timer === null) nextRun = Infinity;
    };
    return {
        use: operation => lifecycle.use(operation),
        // Called with the bytes actually read by the extractor, before writes.
        // Registration failure never prevents reading/conversion; the failed
        // registry remains unreadable to GC as well.
        async rememberPDF(item, fileData, importedIdentity = null) {
            try {
                await lifecycle.use(async () => {
                    const sourceHash = await sha256Hex(fileData);
                    const identity = { libraryID: item.libraryID, attachmentKey: item.key };
                    const imports = await importIndex.selectionsForAttachment(identity);
                    if (importedIdentity) imports.push(importedIdentity);
                    const artifacts = await ownedCacheResources(sourceHash, { pdfIndexProfile, imports });
                    await lifecycle.remember({ ...identity, itemID: item.id, sourceHash,
                        sourceBytes: fileData.byteLength, artifacts });
                });
            }
            catch { report(); }
        },
        resume() {
            if (observerID === null || stopped) return;
            if (timer !== null) timers.clearTimer(timer);
            timer = null;
            nextRun = Infinity;
            schedule(60_000);
        },
        start() {
            if (observerID !== null || stopped) return;
            if (typeof zotero.Notifier?.registerObserver !== 'function'
                || typeof zotero.Libraries?.getAll !== 'function' || typeof zotero.Items?.getAll !== 'function') return;
            observerID = zotero.Notifier.registerObserver({
                notify(_event, type) {
                    if (stopped || !['item', 'file', 'collection-item', 'group', 'trash'].includes(type)) return;
                    lifecycle.invalidate();
                    schedule(30_000);
                },
            }, ['item', 'file', 'collection-item', 'group', 'trash'], 'mktero-cache-ownership');
            schedule(60_000);
        },
        async dispose() {
            stopped = true;
            if (timer !== null) timers.clearTimer(timer);
            if (observerID !== null) zotero.Notifier.unregisterObserver(observerID);
            await lifecycle.dispose();
        },
    };
}
