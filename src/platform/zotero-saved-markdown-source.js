export async function resolveZoteroSavedMarkdownSourceItem(
    zotero,
    manifest
) {
    const sourceKey = String(manifest?.sourcePDFKey || '');
    if (!sourceKey || !zotero?.Items) return null;

    const sourceLibraryKey = manifest?.sourceLibraryKey;
    const parsedLibraryID = sourceLibraryKey !== null
        && sourceLibraryKey !== undefined
        && /^\d+$/.test(String(sourceLibraryKey))
        ? Number(sourceLibraryKey)
        : null;
    const libraryID = Number.isSafeInteger(parsedLibraryID)
        ? parsedLibraryID
        : zotero.Libraries?.userLibraryID;
    if (libraryID === undefined || libraryID === null) return null;

    const direct = await resolveItem(
        zotero,
        await Promise.resolve(
            zotero.Items.getByLibraryAndKey?.(libraryID, sourceKey)
        )
    );
    const item = direct || await findByKey(
        zotero,
        zotero.Items.getAll?.(libraryID, false, false, false),
        sourceKey
    );
    return item?.isPDFAttachment?.() ? item : null;
}

async function findByKey(zotero, items, key) {
    const resolved = await Promise.resolve(items);
    for (const value of resolved || []) {
        const item = await resolveItem(zotero, value);
        if (item?.key === key) return item;
    }
    return null;
}

async function resolveItem(zotero, value) {
    if (value && typeof value === 'object') return value;
    if (value === null || value === undefined) return null;
    return await zotero.Items.getAsync?.(value)
        || zotero.Items.get?.(value)
        || null;
}
