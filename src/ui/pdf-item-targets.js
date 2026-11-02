export function resolvePDFCandidates(zotero, selectedItems) {
    if (!Array.isArray(selectedItems)) return [];
    const targets = [];
    const seen = new Set();
    for (const item of selectedItems) {
        if (!item || item.deleted) continue;
        const attachments = item.isPDFAttachment?.()
            ? [item]
            : item.isRegularItem?.()
                ? pdfAttachments(zotero, item)
                : [];
        for (const attachment of attachments) {
            if (attachment?.deleted || !attachment?.isPDFAttachment?.()
                || !Number.isSafeInteger(attachment.id) || attachment.id <= 0
                || seen.has(attachment.id)) {
                continue;
            }
            seen.add(attachment.id);
            const parentID = attachment.parentItemID || attachment.parentID;
            const parent = attachment.parentItem
                || (parentID ? zotero?.Items?.get?.(parentID) : null);
            targets.push({
                itemID: attachment.id,
                libraryID: attachment.libraryID,
                attachmentKey: attachment.key,
                title: cleanTitle(parent?.getDisplayTitle?.() || attachment.getDisplayTitle?.()),
                attachmentTitle: cleanTitle(attachment.getDisplayTitle?.()),
                fileName: cleanTitle(attachment.attachmentFilename),
                item: attachment,
            });
        }
    }
    return targets;
}

function pdfAttachments(zotero, item) {
    try {
        const ids = item.getAttachments?.();
        if (!Array.isArray(ids)) return [];
        return ids.map(id => zotero?.Items?.get?.(id)).filter(Boolean);
    }
    catch {
        return [];
    }
}

function cleanTitle(value) {
    const text = String(value || '')
        .replace(/[\u0000-\u001F\u007F]/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
    if (!text) return 'PDF';
    return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}
