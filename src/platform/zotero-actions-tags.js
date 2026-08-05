const OPEN_FILE_EVENT = 2;
const CLOSE_TAB_EVENT = 3;
const USER_CLOSE_REASON = 'user';
const ITEM_MENU_ENTRY_POINT = 'item-menu';

export function createZoteroActionsTagsBridge({
    zotero,
    onError = error => zotero?.logError?.(error),
    resolveTopLevelItemIDs = itemID => (
        resolveTopLevelItemIDsFromZotero(zotero, itemID)
    ),
    isNativePDFReaderOpen = itemID => (
        isNativePDFReaderOpenInZotero(zotero, itemID)
    ),
} = {}) {
    if (!zotero) throw new TypeError('A Zotero runtime is required');

    let active = true;
    const sessions = new Map();
    const queues = new Map();

    return {
        openMarkdownSession({
            sessionID,
            sourceItemID,
            entryPoint = ITEM_MENU_ENTRY_POINT,
        } = {}) {
            if (!active) return Promise.resolve(false);

            const sessionKey = normalizeID(sessionID);
            const itemKey = normalizeID(sourceItemID);
            if (!sessionKey || !itemKey || sessions.has(sessionKey)) {
                return Promise.resolve(false);
            }

            const session = {
                ownsLifecycle: entryPoint === ITEM_MENU_ENTRY_POINT
                    && !safeIsNativePDFReaderOpen(sourceItemID),
                opened: false,
                opening: null,
                closing: false,
                suppressOpen: false,
            };
            sessions.set(sessionKey, session);
            if (!session.ownsLifecycle) return Promise.resolve(false);

            session.opening = enqueue(itemKey, async () => {
                if (!active
                    || !sessions.has(sessionKey)
                    || session.suppressOpen) {
                    return false;
                }
                const dispatched = await dispatchEvent(
                    OPEN_FILE_EVENT,
                    sourceItemID
                );
                session.opened = dispatched;
                return dispatched;
            });
            return session.opening;
        },

        closeMarkdownSession({
            sessionID,
            sourceItemID,
            reason = USER_CLOSE_REASON,
        } = {}) {
            const sessionKey = normalizeID(sessionID);
            const itemKey = normalizeID(sourceItemID);
            const session = sessions.get(sessionKey);
            if (!session) return Promise.resolve(false);
            if (session.closing) return Promise.resolve(false);
            session.closing = true;

            if (!active
                || reason !== USER_CLOSE_REASON
                || !session.ownsLifecycle) {
                session.suppressOpen = true;
                sessions.delete(sessionKey);
                return Promise.resolve(false);
            }

            return enqueue(itemKey, async () => {
                await session.opening?.catch(() => {});
                sessions.delete(sessionKey);
                if (!active
                    || !session.opened
                    || safeIsNativePDFReaderOpen(sourceItemID)) {
                    return false;
                }
                return dispatchEvent(CLOSE_TAB_EVENT, sourceItemID);
            });
        },

        dispose() {
            active = false;
            sessions.clear();
        },
    };

    function safeIsNativePDFReaderOpen(itemID) {
        try {
            return Boolean(isNativePDFReaderOpen(itemID));
        }
        catch (error) {
            reportError(error);
            return false;
        }
    }

    async function dispatchEvent(eventType, sourceItemID) {
        const actionManager = zotero.ActionsTags?.api?.actionManager;
        if (typeof actionManager?.dispatchActionByEvent !== 'function') {
            return false;
        }

        let itemIDs;
        try {
            itemIDs = normalizeIDs(resolveTopLevelItemIDs(sourceItemID));
        }
        catch (error) {
            reportError(error);
            return false;
        }
        if (!itemIDs.length) return false;

        let dispatched = false;
        for (const itemID of itemIDs) {
            try {
                await actionManager.dispatchActionByEvent(eventType, {
                    itemID,
                });
                dispatched = true;
            }
            catch (error) {
                reportError(error);
            }
        }
        return dispatched;
    }

    function enqueue(itemKey, operation) {
        if (!itemKey) return Promise.resolve(false);
        const previous = queues.get(itemKey) || Promise.resolve();
        const current = previous.catch(() => {}).then(operation);
        const settled = current.finally(() => {
            if (queues.get(itemKey) === settled) queues.delete(itemKey);
        });
        queues.set(itemKey, settled);
        return current;
    }

    function reportError(error) {
        try {
            onError?.(error);
        }
        catch {
            // Actions & Tags integration must never affect Markdown reading.
        }
    }
}

function resolveTopLevelItemIDsFromZotero(zotero, sourceItemID) {
    const sourceItem = zotero.Items?.get?.(sourceItemID);
    if (!sourceItem) return [];

    const getTopLevel = zotero.Items?.getTopLevel;
    if (typeof getTopLevel === 'function') {
        const topLevelItems = getTopLevel.call(
            zotero.Items,
            [sourceItem]
        );
        const itemIDs = normalizeIDs(topLevelItems);
        if (itemIDs.length) return itemIDs;
    }

    return normalizeIDs([
        sourceItem.parentItemID ?? sourceItem.parentID ?? sourceItem,
    ]);
}

function isNativePDFReaderOpenInZotero(zotero, itemID) {
    if (!Array.isArray(zotero.Reader?._readers)) return false;

    const sourceIDs = new Set([
        String(itemID),
        ...resolveTopLevelItemIDsFromZotero(zotero, itemID)
            .map(value => String(value)),
    ]);
    return zotero.Reader._readers.some(reader => {
        if (reader?.type !== 'pdf') return false;
        if (sourceIDs.has(String(reader.itemID))) return true;
        return resolveTopLevelItemIDsFromZotero(zotero, reader.itemID)
            .some(value => sourceIDs.has(String(value)));
    });
}

function normalizeIDs(values) {
    const list = Array.isArray(values) ? values : [values];
    return [...new Set(list.map(value => {
        if (value && typeof value === 'object') return value.id;
        return value;
    }).filter(value => value !== null && value !== undefined
        && String(value) !== ''))];
}

function normalizeID(value) {
    if (value === null || value === undefined || String(value) === '') {
        return null;
    }
    return String(value);
}
