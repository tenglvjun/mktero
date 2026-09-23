const MAX_RECORDS = 500;
const MAX_PARSER_PROFILE_LENGTH = 8_192;
const ITEM_KEY = /^[A-Za-z0-9]{1,32}$/;
const CACHE_KEY = /^[a-f0-9]{64}$/;

export function createMarkdownReadinessIndex({
    now = Date.now,
} = {}) {
    let records = [];
    const liveCacheKeys = new Set();

    return {
        replace(nextRecords) {
            records = normalizeRecords(nextRecords);
            liveCacheKeys.clear();
            for (const record of records) {
                if (record.expiresAt > now()) liveCacheKeys.add(record.cacheKey);
            }
        },

        remember(record) {
            const normalized = normalizeRecord(record);
            if (!normalized) return false;
            records = records.filter(existing => !sameAttachmentProfile(
                existing,
                normalized
            ));
            records.push(normalized);
            liveCacheKeys.add(normalized.cacheKey);
            records = capRecords(records, liveCacheKeys);
            return true;
        },

        forgetCacheKeys(cacheKeys) {
            const removed = new Set(
                (Array.isArray(cacheKeys) ? cacheKeys : [cacheKeys])
                    .filter(cacheKey => CACHE_KEY.test(String(cacheKey || '')))
            );
            if (!removed.size) return false;
            const before = records.length;
            records = records.filter(record => !removed.has(record.cacheKey));
            for (const cacheKey of removed) liveCacheKeys.delete(cacheKey);
            return records.length !== before;
        },

        noteCacheWritten(cacheKey) {
            if (!CACHE_KEY.test(String(cacheKey || ''))) return false;
            liveCacheKeys.add(cacheKey);
            return true;
        },

        clear() {
            const hadRecords = records.length > 0 || liveCacheKeys.size > 0;
            records = [];
            liveCacheKeys.clear();
            return hadRecords;
        },

        retainLiveEntries(entries) {
            const live = new Map();
            for (const entry of entries || []) {
                if (!CACHE_KEY.test(String(entry?.cacheKey || ''))) continue;
                if (!Number.isFinite(entry.expiresAt)) continue;
                live.set(entry.cacheKey, entry.expiresAt);
            }
            liveCacheKeys.clear();
            for (const cacheKey of live.keys()) liveCacheKeys.add(cacheKey);
            records = records
                .filter(record => live.has(record.cacheKey))
                .map(record => ({
                    ...record,
                    expiresAt: live.get(record.cacheKey),
                }));
            records = capRecords(records, liveCacheKeys);
        },

        isReady(item, parserProfile) {
            const libraryID = normalizeLibraryID(item?.libraryID);
            const itemKey = typeof item?.key === 'string' ? item.key : '';
            if (libraryID === null || !ITEM_KEY.test(itemKey)) return false;
            if (typeof parserProfile !== 'string' || !parserProfile) return false;
            const timestamp = now();
            return records.some(record => (
                record.libraryID === libraryID
                && record.parserProfile === parserProfile
                && (record.itemKey === itemKey || record.attachmentKey === itemKey)
                && liveCacheKeys.has(record.cacheKey)
                && record.expiresAt > timestamp
            ));
        },

        snapshot() {
            return records.map(record => ({ ...record }));
        },
    };
}

export function resolveMarkdownReadinessIdentity(item) {
    if (!item) return null;
    const attachmentKey = typeof item.key === 'string' ? item.key : '';
    if (!ITEM_KEY.test(attachmentKey)) return null;
    const parent = item.parentItem;
    const parentKey = typeof parent?.key === 'string' ? parent.key : '';
    const top = ITEM_KEY.test(parentKey) ? parent : item;
    const libraryID = normalizeLibraryID(top.libraryID);
    if (libraryID === null || !ITEM_KEY.test(top.key)) return null;
    return {
        libraryID,
        itemKey: top.key,
        attachmentKey,
    };
}

export function parseMarkdownReadinessRecords(value) {
    if (value?.schemaVersion !== 1 || !Array.isArray(value.records)) return [];
    return normalizeRecords(value.records);
}

export function serializeMarkdownReadinessRecords(records) {
    return {
        schemaVersion: 1,
        records: normalizeRecords(records),
    };
}

function normalizeRecords(records) {
    const byIdentity = new Map();
    for (const record of records || []) {
        const normalized = normalizeRecord(record);
        if (!normalized) continue;
        byIdentity.set(recordIdentity(normalized), normalized);
    }
    return capRecords([...byIdentity.values()], null);
}

function normalizeRecord(record) {
    const libraryID = normalizeLibraryID(record?.libraryID);
    const itemKey = typeof record?.itemKey === 'string' ? record.itemKey : '';
    const attachmentKey = typeof record?.attachmentKey === 'string'
        ? record.attachmentKey
        : '';
    const cacheKey = typeof record?.cacheKey === 'string' ? record.cacheKey : '';
    const parserProfile = typeof record?.parserProfile === 'string'
        ? record.parserProfile
        : '';
    if (libraryID === null
        || !ITEM_KEY.test(itemKey)
        || !ITEM_KEY.test(attachmentKey)
        || !CACHE_KEY.test(cacheKey)
        || !parserProfile
        || parserProfile.length > MAX_PARSER_PROFILE_LENGTH
        || parserProfile.includes('\u0000')
        || !Number.isFinite(record?.expiresAt)) {
        return null;
    }
    return {
        libraryID,
        itemKey,
        attachmentKey,
        cacheKey,
        parserProfile,
        expiresAt: record.expiresAt,
    };
}

function normalizeLibraryID(value) {
    const libraryID = Number(value);
    return Number.isSafeInteger(libraryID) && libraryID >= 0 ? libraryID : null;
}

function sameAttachmentProfile(left, right) {
    return left.libraryID === right.libraryID
        && left.attachmentKey === right.attachmentKey
        && left.parserProfile === right.parserProfile;
}

function recordIdentity(record) {
    return `${record.libraryID}\0${record.attachmentKey}\0${record.parserProfile}`;
}

function capRecords(records, liveCacheKeys) {
    if (records.length <= MAX_RECORDS) return records;
    const kept = records
        .slice()
        .sort((left, right) => right.expiresAt - left.expiresAt)
        .slice(0, MAX_RECORDS);
    if (liveCacheKeys) {
        const keptKeys = new Set(kept.map(record => record.cacheKey));
        for (const cacheKey of [...liveCacheKeys]) {
            if (!keptKeys.has(cacheKey)) liveCacheKeys.delete(cacheKey);
        }
    }
    return kept;
}
