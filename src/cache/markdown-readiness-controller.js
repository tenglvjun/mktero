import { createMarkdownReadinessIndex } from './markdown-readiness-index.js';

export function createMarkdownReadinessController({
    store,
    now = Date.now,
    onChange = null,
    onError = null,
} = {}) {
    if (!store?.load || !store?.save) {
        throw new TypeError('A Markdown readiness store is required');
    }
    const index = createMarkdownReadinessIndex({ now });
    let active = true;
    let tail = Promise.resolve();

    return {
        load() {
            return enqueue(async () => {
                index.replace(await store.load());
                notify();
            });
        },

        remember(record) {
            return enqueue(async () => {
                if (!index.remember(record)) return false;
                await persist();
                notify();
                return true;
            });
        },

        forgetCacheKeys(cacheKeys) {
            return enqueue(async () => {
                if (!index.forgetCacheKeys(cacheKeys)) return false;
                await persist();
                notify();
                return true;
            });
        },

        noteCacheWritten(cacheKey) {
            if (!active) return false;
            const changed = index.noteCacheWritten(cacheKey);
            if (changed) notify();
            return changed;
        },

        clear() {
            return enqueue(async () => {
                index.clear();
                await store.clear?.();
                notify();
            });
        },

        retainLiveEntries(entries) {
            return enqueue(async () => {
                index.retainLiveEntries(entries);
                await persist();
                notify();
            });
        },

        handleCacheEvent(event) {
            if (!active || !event) return Promise.resolve(false);
            if (event.type === 'cleared') return this.clear();
            if (event.type === 'removed') {
                return this.forgetCacheKeys(event.cacheKeys || event.cacheKey);
            }
            if (event.type === 'written') {
                return Promise.resolve(this.noteCacheWritten(event.cacheKey));
            }
            return Promise.resolve(false);
        },

        isReady(item, parserProfile) {
            if (!active) return false;
            try {
                return index.isReady(item, parserProfile);
            }
            catch {
                return false;
            }
        },

        dispose() {
            active = false;
        },
    };

    function enqueue(operation) {
        if (!active) return Promise.resolve(false);
        const run = tail.catch(() => {}).then(() => {
            if (!active) return false;
            return operation();
        });
        tail = run;
        return run.catch(error => {
            report(error);
            return false;
        });
    }

    async function persist() {
        await store.save(index.snapshot());
    }

    function notify() {
        try {
            onChange?.();
        }
        catch (error) {
            report(error);
        }
    }

    function report(error) {
        try {
            onError?.(error);
        }
        catch {
            // A readiness failure must not affect conversion or reading.
        }
    }
}
