import { translateEnglish } from '../i18n/localization.js';

const ITEM_KEY = /^[A-Z0-9]{8}$/;
const SUMMARY_COUNTS = [
    'exported',
    'notReady',
    'preparing',
    'duplicate',
    'conflict',
    'failed',
];

export function selectObsidianExportGroups(targets) {
    const groups = [];
    const indexByIdentity = new Map();
    for (const target of targets || []) {
        const pdf = normalizeTarget(target);
        if (!pdf) continue;
        const identity = `${pdf.libraryID}:${pdf.itemKey}`;
        let group = indexByIdentity.get(identity);
        if (!group) {
            group = {
                identity,
                title: pdf.title,
                pdfs: [],
            };
            indexByIdentity.set(identity, group);
            groups.push(group);
        }
        group.pdfs.push({ itemID: pdf.itemID, title: pdf.title });
    }
    return groups;
}

export function summarizeObsidianExportBatch(result, translate = translateEnglish) {
    const counts = obsidianExportBatchCounts(result);
    return SUMMARY_COUNTS.map(name => translate(`obsidianBatch.${name}`, {
        count: counts[name],
    })).join(' ');
}

export function selectObsidianExportConfirmations(result) {
    const selected = [];
    const seen = new Set();
    const add = item => {
        if (item?.identity == null || seen.has(item.identity)) return;
        seen.add(item.identity);
        selected.push(item);
    };
    for (const item of result?.conflict || []) add(item);
    for (const item of result?.exported || []) {
        if (!hasConflicts(item)) continue;
        add(item);
    }
    return selected;
}

export function mergeObsidianExportOverwrite(skipped, overwritten) {
    const finished = new Set();
    for (const name of ['exported', 'notReady', 'preparing', 'conflict', 'failed']) {
        for (const item of overwritten?.[name] || []) {
            if (item?.identity != null) finished.add(item.identity);
        }
    }
    const seenDuplicates = new Set((skipped?.duplicate || []).map(item => item.itemID));
    return {
        status: overwritten?.status === 'cancelled' ? 'cancelled' : skipped?.status,
        exported: mergeExported(skipped?.exported, overwritten?.exported),
        notReady: [...(skipped?.notReady || []), ...(overwritten?.notReady || [])],
        preparing: [...(skipped?.preparing || []), ...(overwritten?.preparing || [])],
        duplicate: [
            ...(skipped?.duplicate || []),
            ...(overwritten?.duplicate || []).filter(item => (
                !seenDuplicates.has(item.itemID)
            )),
        ],
        conflict: [
            ...(skipped?.conflict || []).filter(item => !finished.has(item.identity)),
            ...(overwritten?.conflict || []),
        ],
        failed: [...(skipped?.failed || []), ...(overwritten?.failed || [])],
    };
}

export function createObsidianExportBatch({
    load,
    exportDocument,
    isPreparing = () => false,
    onEvent = () => {},
} = {}) {
    if (typeof load !== 'function') {
        throw new TypeError('An Obsidian export loader is required');
    }
    if (typeof exportDocument !== 'function') {
        throw new TypeError('An Obsidian document exporter is required');
    }

    return {
        async run(groups, { signal, conflictPolicy } = {}) {
            const result = emptyResult();
            for (const group of groups || []) {
                if (signal?.aborted) {
                    result.status = 'cancelled';
                    return result;
                }
                const outcome = await exportGroup(group, {
                    load,
                    exportDocument,
                    isPreparing,
                    signal,
                    conflictPolicy,
                });
                if (outcome.cancelled) {
                    result.status = 'cancelled';
                    return result;
                }
                record(result, outcome);
                emit(onEvent, {
                    type: outcome.type,
                    group: groupRef(outcome.group, outcome.group),
                    result: outcome.exportResult
                        ?? (outcome.message ? { message: outcome.message } : null),
                });
            }
            return result;
        },
    };
}

async function exportGroup(group, {
    load,
    exportDocument,
    isPreparing,
    signal,
    conflictPolicy,
}) {
    const pdfs = group?.pdfs || [];
    let sawPreparing = false;
    let chosen = null;
    let document = null;
    const duplicates = [];

    for (const pdf of pdfs) {
        if (signal?.aborted) return { cancelled: true };
        if (chosen) {
            duplicates.push(pdfRef(group, pdf));
            continue;
        }
        if (preparing(isPreparing, pdf.itemID)) {
            sawPreparing = true;
            continue;
        }
        let loaded;
        try {
            loaded = await load(pdf, { signal });
        }
        catch (error) {
            if (isAbort(error) || signal?.aborted) return { cancelled: true };
            return failed(group, pdf, error);
        }
        if (signal?.aborted) return { cancelled: true };
        if (loaded == null) continue;
        chosen = pdf;
        document = loaded;
    }

    if (!chosen) {
        const representative = pdfs[0];
        return {
            type: sawPreparing ? 'preparing' : 'notReady',
            group: groupRef(group, representative),
        };
    }
    if (signal?.aborted) return { cancelled: true };

    let exportResult;
    try {
        exportResult = await exportDocument(document, { signal, conflictPolicy });
    }
    catch (error) {
        if (isAbort(error) || signal?.aborted) return { cancelled: true };
        return {
            ...failed(group, chosen, error),
            duplicates,
        };
    }
    if (exportResult?.status === 'exported') {
        const conflicts = Array.isArray(exportResult.conflicts)
            ? exportResult.conflicts.slice()
            : [];
        return {
            type: 'exported',
            group: conflicts.length
                ? { ...groupRef(group, chosen), conflicts }
                : groupRef(group, chosen),
            exportResult,
            duplicates,
        };
    }
    if (exportResult?.status === 'conflict') {
        return {
            type: 'conflict',
            group: {
                ...groupRef(group, chosen),
                conflicts: Array.isArray(exportResult.conflicts)
                    ? exportResult.conflicts.slice()
                    : [],
            },
            exportResult,
            duplicates,
        };
    }
    return {
        type: 'failed',
        group: groupRef(group, chosen),
        message: unexpectedStatus(exportResult),
        duplicates,
    };
}

function normalizeTarget(target) {
    const itemID = target?.itemID;
    const libraryID = target?.libraryID;
    const itemKey = target?.itemKey;
    if (!Number.isSafeInteger(itemID) || itemID <= 0) return null;
    if (!Number.isSafeInteger(libraryID) || libraryID < 0) return null;
    if (typeof itemKey !== 'string' || !ITEM_KEY.test(itemKey)) return null;
    return {
        itemID,
        libraryID,
        itemKey,
        title: target.title,
    };
}

function preparing(isPreparing, itemID) {
    try {
        return Boolean(isPreparing?.(itemID));
    }
    catch {
        return false;
    }
}

function failed(group, pdf, error) {
    return {
        type: 'failed',
        group: groupRef(group, pdf),
        message: errorMessage(error),
    };
}

function record(result, outcome) {
    if (outcome.duplicates?.length) {
        result.duplicate.push(...outcome.duplicates);
    }
    if (outcome.type === 'failed') {
        result.failed.push({ ...outcome.group, message: outcome.message });
        return;
    }
    result[outcome.type].push(outcome.group);
    if (outcome.type === 'exported' && hasConflicts(outcome.group)) {
        result.conflict.push(outcome.group);
    }
}

function emit(onEvent, event) {
    try {
        onEvent?.(event);
    }
    catch {
        // Batch progress reporting must not stop the queue.
    }
}

function groupRef(group, pdf) {
    return {
        identity: group?.identity,
        itemID: pdf?.itemID,
        title: pdf?.title,
    };
}

function pdfRef(group, pdf) {
    return {
        identity: group?.identity,
        itemID: pdf?.itemID,
        title: pdf?.title,
    };
}

function unexpectedStatus(exportResult) {
    const status = exportResult?.status;
    if (typeof status === 'string' && status) {
        return `Unexpected export status: ${status}`;
    }
    return 'Export failed';
}

function errorMessage(error) {
    if (typeof error?.message === 'string' && error.message) return error.message;
    return 'Export failed';
}

function isAbort(error) {
    return error?.name === 'AbortError';
}

function emptyResult() {
    return {
        status: 'completed',
        exported: [],
        notReady: [],
        preparing: [],
        duplicate: [],
        conflict: [],
        failed: [],
    };
}

function obsidianExportBatchCounts(result) {
    return {
        exported: countOf(result?.exported),
        notReady: countOf(result?.notReady),
        preparing: countOf(result?.preparing),
        duplicate: countOf(result?.duplicate),
        conflict: countOf(result?.conflict),
        failed: countOf(result?.failed),
    };
}

function countOf(value) {
    return Array.isArray(value) ? value.length : 0;
}

function hasConflicts(group) {
    return Array.isArray(group?.conflicts) && group.conflicts.length > 0;
}

function mergeExported(previous, next) {
    const merged = [];
    const indexByIdentity = new Map();
    for (const item of [...(previous || []), ...(next || [])]) {
        if (item?.identity == null) {
            merged.push(item);
            continue;
        }
        const index = indexByIdentity.get(item.identity);
        if (index == null) {
            indexByIdentity.set(item.identity, merged.length);
            merged.push(item);
            continue;
        }
        merged[index] = item;
    }
    return merged;
}
