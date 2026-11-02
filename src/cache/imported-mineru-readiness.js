import { createLLMCacheParserProfile, getPreviousLLMCacheParserProfiles } from '../mineru/llm-cache-profile.js';

/** Readiness is advisory; only a verified attachment's current PDF may use an import marker. */
export function createImportedMinerUReadiness({ index, extractor, readiness, getFileStamp, onChange, onError } = {}) {
    const verified = new Map();
    const pending = new Map();
    let active = true;
    let verificationTail = Promise.resolve();

    function identity(item) {
        return `${item.libraryID}:${item.key}`;
    }

    function selection(item) {
        return index.peekForAttachment({ libraryID: item.libraryID, attachmentKey: item.key });
    }

    function publication(record) {
        return `${record.sourceHash}:${record.snapshotHash}:${record.importedAt}`;
    }

    function stamp(item) {
        try { return getFileStamp(item); }
        catch { return null; }
    }

    function profiles(record) {
        return [createLLMCacheParserProfile(record.snapshotHash), ...getPreviousLLMCacheParserProfiles(record.snapshotHash)];
    }

    function cacheKey(item, record) {
        for (const profile of profiles(record)) {
            const key = readiness.cacheKeyFor(item, profile);
            if (key) return key;
        }
        return null;
    }

    async function validate(item) {
        const record = selection(item);
        if (!record) return { selected: false, cacheKey: null };
        const before = stamp(item);
        const current = await extractor.lookup(item.id);
        const after = stamp(item);
        if (!active) return { selected: true, cacheKey: null };
        const unchanged = before !== null && before === after
            && publication(selection(item) || {}) === publication(record);
        if (unchanged) verified.set(identity(item), { stamp: after, publication: publication(record), current });
        return { selected: true, cacheKey: current && (before === null || unchanged) ? cacheKey(item, current) : null };
    }

    function requestVerification(item, record, fileStamp) {
        const key = identity(item);
        const signature = `${fileStamp}:${publication(record)}`;
        if (pending.get(key)?.signature === signature) return;
        const operation = verificationTail.catch(() => {}).then(() => active ? validate(item) : null).then(() => {
            if (active && verified.get(key)?.stamp === fileStamp) onChange?.();
        }).catch(error => onError?.(error)).finally(() => {
            if (pending.get(key)?.operation === operation) pending.delete(key);
        });
        pending.set(key, { signature, operation });
        verificationTail = operation;
    }

    return {
        // undefined leaves unselected attachments on the ordinary provider's readiness path.
        cacheKeyFor(item, { verify = true } = {}) {
            if (!active) return null;
            try {
                const record = selection(item);
                if (!record) return undefined;
                const fileStamp = stamp(item);
                if (fileStamp === null) return null;
                const known = verified.get(identity(item));
                if (known?.stamp !== fileStamp || known.publication !== publication(record)) {
                    if (verify) requestVerification(item, record, fileStamp);
                    return null;
                }
                return known.current ? cacheKey(item, known.current) : null;
            }
            catch (error) { onError?.(error); return null; }
        },
        validate,
        dispose() {
            active = false;
            verified.clear();
            pending.clear();
        },
    };
}
