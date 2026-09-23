export function createConversionActivity() {
    const records = new Map();

    return {
        mark(identity) {
            const record = normalizeIdentity(identity);
            if (!record) return false;
            const key = recordKey(record);
            const previous = records.get(key);
            if (previous
                && previous.libraryID === record.libraryID
                && previous.itemKey === record.itemKey
                && previous.attachmentKey === record.attachmentKey) {
                return false;
            }
            records.set(key, record);
            return true;
        },

        clear(identity) {
            const record = normalizeIdentity(identity);
            if (!record) return false;
            return records.delete(recordKey(record));
        },

        clearAll() {
            if (!records.size) return false;
            records.clear();
            return true;
        },

        isActive(item) {
            const libraryID = normalizeLibraryID(item?.libraryID);
            const itemKey = typeof item?.key === 'string' ? item.key : '';
            if (libraryID === null || !itemKey) return false;
            for (const record of records.values()) {
                if (record.libraryID === libraryID
                    && (record.itemKey === itemKey
                        || record.attachmentKey === itemKey)) {
                    return true;
                }
            }
            return false;
        },
    };
}

function normalizeIdentity(identity) {
    const libraryID = normalizeLibraryID(identity?.libraryID);
    const itemKey = cleanKey(identity?.itemKey);
    const attachmentKey = cleanKey(identity?.attachmentKey);
    if (libraryID === null || !itemKey || !attachmentKey) return null;
    return { libraryID, itemKey, attachmentKey };
}

function normalizeLibraryID(value) {
    const libraryID = Number(value);
    return Number.isSafeInteger(libraryID) && libraryID >= 0
        ? libraryID
        : null;
}

function cleanKey(value) {
    return typeof value === 'string' && value ? value : '';
}

function recordKey(record) {
    return `${record.libraryID}\0${record.attachmentKey}`;
}
