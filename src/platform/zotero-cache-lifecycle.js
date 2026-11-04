import { CacheLifecycle, attachmentIdentity, normalizeCacheOwnership } from '../cache/cache-lifecycle.js';
import { ownedCacheResources } from '../cache/cache-owned-resources.js';
import { sha256Hex } from '../core/sha256.js';

const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_SCAN_ITEMS = 50_000;
const HASH_BATCH_BYTES = 32 * 1024 * 1024;
const SCAN_BATCH_ITEMS = 100;
export const CACHE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
export const CACHE_DELETE_DELAY_MS = 5_000;
export const CACHE_STARTUP_DELAY_MS = 60_000;
const CONTINUE_DELAY_MS = 250;

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

// getAll(..., false, true) includes child attachments AND trashed items. Hashing
// resumes across bounded batches; a library notification invalidates the cursor.
export function createCacheLibrarySnapshot({ zotero, ioUtils: io, yieldControl = async () => {},
    cancelled = () => false, batchItems = SCAN_BATCH_ITEMS, batchBytes = HASH_BATCH_BYTES }) {
    let cursor = null;
    const empty = () => ({ complete: false, owners: new Set(), libraries: new Set(), itemIDs: new Set(), sources: new Set() });
    async function* walk(result) {
        if (typeof zotero.Libraries?.getAll !== 'function' || typeof zotero.Items?.getAll !== 'function') return;
        const libraries = zotero.Libraries.getAll();
        if (!Array.isArray(libraries) || !libraries.length) return;
        let count = 0;
        for (const library of libraries) {
            if (cancelled() || !Number.isSafeInteger(library.libraryID)) return;
            result.libraries.add(library.libraryID);
            const items = await zotero.Items.getAll(library.libraryID, false, true);
            if (!Array.isArray(items)) return;
            for (const item of items) {
                if (cancelled() || ++count > MAX_SCAN_ITEMS || !Number.isSafeInteger(item?.id)) return;
                result.itemIDs.add(item.id);
                if (item.isPDFAttachment?.()) result.owners.add(attachmentIdentity({ libraryID: item.libraryID, attachmentKey: item.key }));
                yield item;
            }
        }
        result.complete = !cancelled();
    }
    return async ({ hashes, sourceSizes = null, generation = 0 }) => {
        if (!hashes) {
            const result = empty();
            let count = 0;
            for await (const _item of walk(result)) {
                if (++count % SCAN_BATCH_ITEMS === 0) await yieldControl();
            }
            return result;
        }
        const signature = JSON.stringify([generation, sourceSizes?.slice().sort((a, b) => a - b) ?? null]);
        if (!cursor || cursor.signature !== signature) {
            const result = empty();
            cursor = { signature, result, iterator: walk(result),
                fingerprints: new Map(), verification: null };
        }
        const current = cursor;
        const sizes = sourceSizes ? new Set(sourceSizes) : null;
        let bytes = 0;
        let count = 0;
        try {
            while (!cancelled()) {
                if (count >= batchItems || bytes >= batchBytes) {
                    return { ...current.result, complete: false, continuation: true };
                }
                if (current.verification) {
                    const step = current.verification.next();
                    if (step.done) { cursor = null; return current.result; }
                    const [file, before] = step.value;
                    const after = await io.stat(file);
                    if (after.type !== 'regular' || after.size !== before.size || after.lastModified !== before.lastModified) {
                        cursor = null;
                        return { ...current.result, complete: false, continuation: true };
                    }
                    count++;
                    continue;
                }
                const step = await current.iterator.next();
                if (step.done) {
                    if (!current.result.complete) { cursor = null; return current.result; }
                    // A file checked in an earlier batch may have changed on
                    // disk without a Zotero notification, including size skips.
                    current.verification = current.fingerprints.entries();
                    continue;
                }
                count++;
                const item = step.value;
                if (!item.isPDFAttachment?.()) continue;
                const file = await item.getFilePathAsync();
                if (!file) break;
                const before = await io.stat(file);
                if (before.type !== 'regular' || !Number.isSafeInteger(before.size) || before.size < 0
                    || !Number.isFinite(before.lastModified)) break;
                const previous = current.fingerprints.get(file);
                if (previous && (previous.size !== before.size || previous.lastModified !== before.lastModified)) {
                    cursor = null;
                    return { ...current.result, complete: false, continuation: true };
                }
                current.fingerprints.set(file, { size: before.size, lastModified: before.lastModified });
                if (sizes && !sizes.has(before.size)) continue;
                if (!before.size || before.size > MAX_PDF_BYTES) break;
                const data = await io.read(file);
                if (data.byteLength !== before.size) break;
                const hash = await sha256Hex(data);
                const after = await io.stat(file);
                if (after.size !== before.size || after.lastModified !== before.lastModified) break;
                current.result.sources.add(hash);
                bytes += before.size;
                await yieldControl();
            }
            cursor = null;
            return { ...current.result, complete: false };
        }
        catch (error) { cursor = null; throw error; }
    };
}

export function createZoteroCacheLifecycle({ zotero, ioUtils, pathUtils, pdfIndexProfile,
    stores, annotations, groups, importIndex, readiness, isBusy = () => false, timers,
    onError = () => {}, onSummary = () => {}, now = Date.now }) {
    let stopped = false;
    let observerID = null;
    let timer = null;
    let nextRun = Infinity;
    let nextFullRun = Infinity;
    let fullRequested = false;
    let running = false;
    const pendingIDs = new Set();
    const originals = [];
    const removers = Object.fromEntries(Object.entries(stores).map(([name, store]) => [name, store.delete.bind(store)]));
    const removeAnnotations = annotations.delete.bind(annotations);
    const removeGroups = groups.delete.bind(groups);
    const forgetImports = importIndex.forgetAttachment.bind(importIndex);
    const yieldControl = () => zotero.Promise?.delay?.(0) ?? Promise.resolve();
    const report = () => {
        try { onError(new Error('Local cache ownership maintenance deferred')); }
        catch { /* Diagnostics are optional. */ }
    };
    const retry = () => {
        if (!lifecycle.deferred.size) return;
        fullRequested = true;
        schedule(CACHE_DELETE_DELAY_MS);
    };
    const lifecycle = new CacheLifecycle({
        storage: createCacheOwnershipStorage({ zotero, ioUtils, pathUtils }),
        snapshot: createCacheLibrarySnapshot({ zotero, ioUtils, cancelled: () => stopped, yieldControl }),
        remove: ({ store, key }) => removers[store](key),
        removeOwner: async record => {
            await removeAnnotations(record.itemID);
            await removeGroups(record.itemID);
            await forgetImports(record);
            await readiness?.forgetAttachment(record);
        },
        isBusy, onError: report, now, onIdle: retry, yieldControl,
    });

    // GC uses the original removers. Ordinary operations hold only their own
    // resource keys, except explicit store-wide maintenance (clear/prune).
    const wrap = (store, methods, scopeFor) => {
        for (const method of methods) {
            if (typeof store[method] !== 'function') continue;
            const original = store[method];
            originals.push(() => { store[method] = original; });
            store[method] = (...args) => lifecycle.use(() => original.apply(store, args), scopeFor(method, args));
        }
    };
    for (const [name, store] of Object.entries(stores)) {
        wrap(store, ['get', 'put', 'load', 'save', 'delete', 'hasReadable', 'getTranslation',
            'getTranslationByLanguage', 'putTranslation', 'copyTranslations', 'deleteTranslation', 'clear', 'prune', 'setAside'],
        (method, args) => ['clear', 'prune'].includes(method) ? null : {
            artifacts: (method === 'copyTranslations' ? args.slice(0, 2) : args.slice(0, 1))
                .map(key => ({ store: name, key })),
        });
    }
    for (const store of [annotations, groups]) {
        wrap(store, ['get', 'put', 'load', 'save', 'delete', 'setAside', 'clear', 'prune'],
            (method, args) => ['clear', 'prune'].includes(method) ? null : { itemID: args[0] });
    }
    wrap(importIndex, ['get', 'publish', 'forget', 'forgetAttachment', 'selectionsForAttachment', 'clear'],
        (method, args) => method === 'clear' ? null : args[0]);

    const schedule = delay => {
        if (stopped || !timers?.setTimer || nextRun <= now() + delay) return;
        if (timer !== null) timers.clearTimer(timer);
        nextRun = now() + delay;
        timer = timers.setTimer(async () => {
            timer = null;
            nextRun = Infinity;
            if (stopped) return;
            if (running) { schedule(CACHE_DELETE_DELAY_MS); return; }
            running = true;
            const full = fullRequested || now() >= nextFullRun || !pendingIDs.size;
            const itemIDs = full ? null : new Set(pendingIDs);
            fullRequested = false;
            pendingIDs.clear();
            if (full) nextFullRun = now() + CACHE_SWEEP_INTERVAL_MS;
            try {
                const summary = await lifecycle.sweep({ itemIDs });
                try { onSummary(summary); } catch { /* Diagnostics are optional. */ }
                if (summary.continuation || summary.interrupted) {
                    if (full) fullRequested = true;
                    else for (const id of itemIDs) pendingIDs.add(id);
                    schedule(summary.continuation ? CONTINUE_DELAY_MS : CACHE_DELETE_DELAY_MS);
                }
            }
            catch { report(); }
            finally {
                running = false;
                schedule(Math.max(0, Math.min(CACHE_SWEEP_INTERVAL_MS, nextFullRun - now())));
            }
        }, delay);
        if (timer === null) nextRun = Infinity;
    };
    return {
        use: (operation, scope) => lifecycle.use(operation, scope),
        retry,
        async rememberPDF(item, fileData, importedIdentity = null) {
            try {
                const identity = { itemID: item.id, libraryID: item.libraryID, attachmentKey: item.key };
                await lifecycle.use(async () => {
                    const sourceHash = await sha256Hex(fileData);
                    await lifecycle.use(async () => {
                        const imports = await importIndex.selectionsForAttachment(identity);
                        if (importedIdentity) imports.push(importedIdentity);
                        const artifacts = await ownedCacheResources(sourceHash, { pdfIndexProfile, imports });
                        await lifecycle.remember({ ...identity, sourceHash, sourceBytes: fileData.byteLength, artifacts });
                    }, { ...identity, sourceHash });
                }, identity);
            }
            catch { report(); }
        },
        resume() {
            if (observerID === null || stopped) return;
            nextFullRun = Math.min(nextFullRun, now() + CACHE_STARTUP_DELAY_MS);
            schedule(CACHE_STARTUP_DELAY_MS);
        },
        start() {
            if (observerID !== null || stopped) return;
            if (typeof zotero.Notifier?.registerObserver !== 'function'
                || typeof zotero.Libraries?.getAll !== 'function' || typeof zotero.Items?.getAll !== 'function') return;
            observerID = zotero.Notifier.registerObserver({
                notify(event, type, ids) {
                    if (stopped || !['item', 'file', 'collection-item', 'group', 'trash'].includes(type)) return;
                    lifecycle.invalidate();
                    if (event !== 'delete' || type !== 'item') return;
                    for (const id of ids || []) if (Number.isSafeInteger(Number(id))) pendingIDs.add(Number(id));
                    if (!pendingIDs.size) fullRequested = true;
                    schedule(CACHE_DELETE_DELAY_MS);
                },
            }, ['item', 'file', 'collection-item', 'group', 'trash'], 'mktero-cache-ownership');
            nextFullRun = now() + CACHE_STARTUP_DELAY_MS;
            schedule(CACHE_STARTUP_DELAY_MS);
        },
        async dispose() {
            stopped = true;
            if (timer !== null) timers.clearTimer(timer);
            if (observerID !== null) zotero.Notifier.unregisterObserver(observerID);
            await lifecycle.dispose();
            for (const restore of originals) restore();
        },
    };
}
