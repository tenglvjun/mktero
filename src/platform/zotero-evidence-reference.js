import { translateEnglish } from '../i18n/localization.js';

export function createZoteroEvidenceReference(
    zotero,
    translate = translateEnglish
) {
    return {
        async resolve(itemID, pageIndexes) {
            if (!zotero?.Items?.getAsync || !zotero?.Libraries?.get) {
                throw new Error('Zotero item and library information is unavailable');
            }
            const attachment = await zotero.Items.getAsync(itemID);
            if (!attachment?.isPDFAttachment?.()
                || typeof attachment.key !== 'string'
                || !attachment.key.trim()) {
                throw new Error('PDF attachment is unavailable');
            }
            const pages = normalizePageIndexes(pageIndexes);
            const library = zotero.Libraries.get(attachment.libraryID);
            if (!library) throw new Error('Zotero library is unavailable');
            const itemPath = zoteroItemPath(library, attachment.key.trim());
            const title = firstNonBlankString(
                attachment.parentItem?.getDisplayTitle?.(),
                attachment.getDisplayTitle?.(),
                translate('document.untitled')
            );
            return {
                title,
                pages: pages.map(pageIndex => ({
                    pageIndex,
                    pageNumber: pageIndex + 1,
                    href: `zotero://open-pdf/${itemPath}?page=${pageIndex + 1}`,
                })),
            };
        },
    };
}

function normalizePageIndexes(value) {
    if (!Array.isArray(value) || !value.length
        || value.some(pageIndex => (
            !Number.isSafeInteger(pageIndex) || pageIndex < 0
        ))) {
        throw new Error('PDF source pages are unavailable');
    }
    return [...new Set(value)].sort((left, right) => left - right);
}

function zoteroItemPath(library, attachmentKey) {
    const key = encodeURIComponent(attachmentKey);
    if (library?.libraryType !== 'group') return `library/items/${key}`;
    const groupID = typeof library.groupID === 'string'
        ? library.groupID.trim()
        : String(library.groupID);
    if (!/^[1-9]\d*$/.test(groupID)) {
        throw new Error('Zotero group library is unavailable');
    }
    return `groups/${groupID}/items/${key}`;
}

function firstNonBlankString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}
