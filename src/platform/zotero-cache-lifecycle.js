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
const BLOCKED_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, CACHE_SWEEP_INTERVAL_MS];

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
    const empty = () => ({ complete: false, owners: new Set(), libraries: new Set(), itemIDs: new Set(),
        sources: new Set(), uncertainSources: new Map(), unidentified: [] });
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
    return async ({ hashes, sourceSizes = null, candidates = null, generation = 0 }) => {
        if (!hashes) {
            const result = empty();
            let count = 0;
            try {
                for await (const _item of walk(result)) {
                    if (++count % SCAN_BATCH_ITEMS === 0) await yieldControl();
                }
            }
            catch { result.complete = false; }
            return result;
        }
        const signature = JSON.stringify([generation, sourceSizes?.slice().sort((a, b) => a - b) ?? null,
            candidates?.map(record => [record.sourceHash, record.sourceBytes]).sort() ?? null]);
        if (!cursor || cursor.signature !== signature) {
            const result = empty();
            cursor = { signature, result, iterator: walk(result),
                fingerprints: new Map(), verification: null };
        }
        const current = cursor;
        const sizes = sourceSizes ? new Set(sourceSizes) : null;
        const uncertain = (item, reason, size = null) => {
            const blocker = { itemID: item.id, libraryID: item.libraryID, attachmentKey: item.key, reason };
            // An absent file with no observable size has no content identity at
            // all: it cannot be shown to share a candidate, and it cannot be
            // reading one right now. Protecting every candidate for it would
            // retain unrelated caches forever, so report it separately and let
            // the lifecycle release only rebuildable resources.
            // A file whose size was observed before it vanished stays strong:
            // it may be the very content of a same-size candidate.
            if (reason === 'missing-file' && size === null) {
                if (current.result.unidentified.length < 10
                    && !current.result.unidentified.some(value => value.itemID === item.id)) {
                    current.result.unidentified.push(blocker);
                }
                return;
            }
            // Only an observed, rechecked file size can exclude a candidate.
            // A last-synced MD5 or a historical owner hash is not proof of a
            // missing file's current content: unsynced changes may be absent.
            const affected = candidates
                ? candidates.filter(record => size === null || record.sourceBytes === size).map(record => record.sourceHash)
                : ['*'];
            for (const hash of new Set(affected)) {
                const list = current.result.uncertainSources.get(hash) || [];
                if (list.length < 10 && !list.some(value => value.itemID === item.id && value.reason === reason)) list.push(blocker);
                current.result.uncertainSources.set(hash, list);
            }
        };
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
                    let after;
                    try { after = await io.stat(file); }
                    catch (error) {
                        // The file was observed earlier and has since vanished.
                        // Its size can no longer be trusted to describe what is
                        // on disk now, so revoke every size-based exclusion.
                        uncertain(before.item, error?.name === 'NotFoundError' || error?.code === 'ENOENT'
                            ? 'changed-file' : 'unreadable-file');
                        count++;
                        continue;
                    }
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
                let file;
                try { file = await item.getFilePathAsync(); }
                catch { uncertain(item, 'unreadable-file'); continue; }
                if (!file) { uncertain(item, 'missing-file'); continue; }
                let before;
                try { before = await io.stat(file); }
                catch (error) {
                    // A path that never resolved has no observed size, so it is a
                    // weak signal rather than evidence of a same-size candidate.
                    uncertain(item, error?.name === 'NotFoundError' || error?.code === 'ENOENT'
                        ? 'missing-file' : 'unreadable-file');
                    continue;
                }
                if (before.type !== 'regular' || !Number.isSafeInteger(before.size) || before.size < 0
                    || !Number.isFinite(before.lastModified)) { uncertain(item, 'unreadable-file'); continue; }
                const previous = current.fingerprints.get(file);
                if (previous && (previous.size !== before.size || previous.lastModified !== before.lastModified)) {
                    cursor = null;
                    return { ...current.result, complete: false, continuation: true };
                }
                current.fingerprints.set(file, { size: before.size, lastModified: before.lastModified, item });
                if (sizes && !sizes.has(before.size)) continue;
                if (!before.size || before.size > MAX_PDF_BYTES) {
                    uncertain(item, 'oversized-file', before.size);
                    continue;
                }
                try {
                    const data = await io.read(file);
                    bytes += before.size;
                    if (data.byteLength !== before.size) { uncertain(item, 'changed-file'); continue; }
                    const hash = await sha256Hex(data);
                    const after = await io.stat(file);
                    if (after.type !== 'regular' || after.size !== before.size || after.lastModified !== before.lastModified) {
                        uncertain(item, 'changed-file');
                        continue;
                    }
                    current.result.sources.add(hash);
                }
                catch { uncertain(item, 'unreadable-file', before.size); }
                await yieldControl();
            }
            cursor = null;
            return { ...current.result, complete: false };
        }
        catch { cursor = null; return { ...current.result, complete: false }; }
    };
}

export function createZoteroCacheLifecycle({ zotero, ioUtils, pathUtils, pdfIndexProfile,
    stores, annotations, groups, importIndex, readiness, isBusy = () => false, timers,
    onError = () => {}, onSummary = () => {}, onStatus = () => {}, now = Date.now }) {
    let stopped = false;
    let observerID = null;
    let timer = null;
    let nextRun = Infinity;
    let nextFullRun = Infinity;
    let fullRequested = false;
    let running = false;
    let blockedRetry = 0;
    let continuing = false;
    let totals = { removed: 0, released: 0, ownersRemoved: 0, errors: 0 };
    let status = { state: 'waiting', checkedAt: null, nextRunAt: null, removed: 0, released: 0, ownersRemoved: 0,
        referenced: 0, busy: 0, unknown: 0, errors: 0, reasons: [], blockers: [], unidentified: [] };
    const getStatus = () => ({ ...status,
        nextRunAt: status.state !== 'running' && Number.isFinite(nextRun) ? nextRun : null,
        reasons: status.reasons.map(value => ({ ...value })), blockers: status.blockers.map(value => ({ ...value })),
        unidentified: status.unidentified.map(value => ({ ...value })) });
    const publish = () => {
        if (stopped) return;
        try { onStatus(getStatus()); } catch { /* Diagnostics are optional. */ }
    };
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
            if (!continuing) totals = { removed: 0, released: 0, ownersRemoved: 0, errors: 0 };
            const starting = status.state !== 'running';
            status = { ...status, state: 'running' };
            if (starting) publish();
            const full = fullRequested || now() >= nextFullRun || !pendingIDs.size;
            const itemIDs = full ? null : new Set(pendingIDs);
            fullRequested = false;
            pendingIDs.clear();
            if (full) nextFullRun = now() + CACHE_SWEEP_INTERVAL_MS;
            try {
                const summary = await lifecycle.sweep({ itemIDs });
                totals.removed += summary.removed;
                totals.released += summary.released;
                totals.ownersRemoved += summary.ownersRemoved;
                totals.errors += summary.errors;
                continuing = summary.continuation || summary.interrupted;
                const reasons = summary.reasons.slice();
                if (totals.errors && !reasons.some(value => value.code === 'cleanup-failed')) {
                    reasons.push({ code: 'cleanup-failed', count: totals.errors });
                }
                status = { ...status, ...totals, referenced: summary.referenced, busy: summary.busy,
                    unknown: summary.unknown, reasons, blockers: summary.blockers,
                    unidentified: summary.unidentified,
                    checkedAt: continuing ? status.checkedAt : now(),
                    state: continuing ? 'running' : (summary.unknown || summary.busy || summary.referenced || totals.errors)
                        ? 'blocked' : 'complete' };
                try { onSummary(summary); } catch { /* Diagnostics are optional. */ }
                if (continuing) {
                    if (full) fullRequested = true;
                    else for (const id of itemIDs) pendingIDs.add(id);
                    schedule(summary.continuation ? CONTINUE_DELAY_MS : CACHE_DELETE_DELAY_MS);
                }
                else if (summary.unknown || totals.errors) {
                    fullRequested = true;
                    schedule(BLOCKED_RETRY_DELAYS_MS[Math.min(blockedRetry++, BLOCKED_RETRY_DELAYS_MS.length - 1)]);
                }
                else blockedRetry = 0;
            }
            catch (error) {
                continuing = false;
                const code = error?.cleanupReason === 'index-unavailable' ? 'index-unavailable' : 'cleanup-failed';
                status = { ...status, ...totals, state: 'error', checkedAt: now(), referenced: 0, busy: 0, unknown: 0, errors: 1,
                    reasons: [{ code, count: 1 }], blockers: [], unidentified: [] };
                fullRequested = true;
                schedule(BLOCKED_RETRY_DELAYS_MS[Math.min(blockedRetry++, BLOCKED_RETRY_DELAYS_MS.length - 1)]);
                report();
            }
            finally {
                running = false;
                schedule(Math.max(0, Math.min(CACHE_SWEEP_INTERVAL_MS, nextFullRun - now())));
                // Continuation batches belong to one check. Publishing every
                // short timer makes the preferences pane resize repeatedly.
                if (!continuing) publish();
            }
        }, delay);
        if (timer === null) nextRun = Infinity;
    };
    return {
        use: (operation, scope) => lifecycle.use(operation, scope),
        retry,
        getStatus,
        requestCheck() {
            if (stopped || observerID === null) return;
            blockedRetry = 0;
            fullRequested = true;
            status = { ...status, state: 'running' };
            schedule(0);
            publish();
        },
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
            publish();
        },
        start() {
            if (observerID !== null || stopped) return;
            if (typeof zotero.Notifier?.registerObserver !== 'function'
                || typeof zotero.Libraries?.getAll !== 'function' || typeof zotero.Items?.getAll !== 'function') return;
            observerID = zotero.Notifier.registerObserver({
                notify(event, type, ids) {
                    if (stopped || !['item', 'file', 'collection-item', 'group', 'trash'].includes(type)) return;
                    lifecycle.invalidate();
                    // A recovered/relinked file or changed library can resolve a
                    // prior uncertainty. Retry without waiting for the hourly pass.
                    if ((status.unknown || status.errors) && ['item', 'file', 'group'].includes(type)) {
                        blockedRetry = 0;
                        fullRequested = true;
                        schedule(CACHE_DELETE_DELAY_MS);
                        publish();
                    }
                    if (event !== 'delete' || type !== 'item') return;
                    for (const id of ids || []) if (Number.isSafeInteger(Number(id))) pendingIDs.add(Number(id));
                    // Deleting a parent may remove child PDFs without listing their IDs.
                    // Reconcile every orphan so cascade deletions are not deferred hourly.
                    fullRequested = true;
                    schedule(CACHE_DELETE_DELAY_MS);
                },
            }, ['item', 'file', 'collection-item', 'group', 'trash'], 'mktero-cache-ownership');
            nextFullRun = now() + CACHE_STARTUP_DELAY_MS;
            schedule(CACHE_STARTUP_DELAY_MS);
            publish();
        },
        async dispose() {
            stopped = true;
            if (timer !== null) timers.clearTimer(timer);
            nextRun = Infinity;
            if (observerID !== null) zotero.Notifier.unregisterObserver(observerID);
            await lifecycle.dispose();
            for (const restore of originals) restore();
        },
    };
}
