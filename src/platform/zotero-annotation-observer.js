export function registerZoteroAnnotationObserver(zotero, {
    onChange,
    onError = () => {},
} = {}) {
    if (typeof onChange !== 'function') {
        throw new TypeError('An annotation change handler is required');
    }
    if (typeof zotero?.Notifier?.registerObserver !== 'function') {
        return () => {};
    }

    let active = true;
    const observer = {
        notify(event, type, ids, extraData) {
            if (!active || type !== 'item') return;
            const attachmentIDs = affectedAttachmentIDs(
                zotero,
                ids,
                extraData
            );
            if (!attachmentIDs.length && event !== 'delete') return;
            Promise.resolve().then(() => {
                if (!active) return;
                return onChange(
                    attachmentIDs.length ? attachmentIDs : null
                );
            }).catch(error => {
                try {
                    onError(error);
                }
                catch {
                    // Observer diagnostics must not break Zotero notifications.
                }
            });
        },
    };
    const observerID = zotero.Notifier.registerObserver(
        observer,
        ['item'],
        'mktero-annotation-sync'
    );

    return () => {
        if (!active) return;
        active = false;
        zotero.Notifier.unregisterObserver?.(observerID);
    };
}

function affectedAttachmentIDs(zotero, ids, extraData) {
    const attachmentIDs = new Set();
    for (const id of Array.isArray(ids) ? ids : []) {
        const item = itemForID(zotero, id);
        if (item?.isAnnotation?.()) {
            addItemID(attachmentIDs, item.parentID);
            continue;
        }
        const data = extraData?.[id] ?? extraData?.[String(id)];
        addItemID(
            attachmentIDs,
            data?.parentID
            ?? data?.parentItemID
            ?? data?.oldData?.parentID
            ?? data?.data?.parentID
        );
    }
    return [...attachmentIDs];
}

function itemForID(zotero, id) {
    try {
        return zotero.Items?.get?.(id) || null;
    }
    catch {
        return null;
    }
}

function addItemID(itemIDs, value) {
    const itemID = Number(value);
    if (Number.isInteger(itemID) && itemID > 0) itemIDs.add(itemID);
}
