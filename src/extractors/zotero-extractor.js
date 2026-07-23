export class ZoteroDocumentExtractor {
    constructor(zotero) {
        if (!zotero) {
            throw new TypeError('A Zotero runtime is required');
        }
        this.zotero = zotero;
    }

    async extract(itemID, { onProgress } = {}) {
        const item = await this.zotero.Items.getAsync(itemID);
        if (!item?.isPDFAttachment?.()) {
            throw new Error('Only PDF attachments can be converted');
        }

        const title = item.parentItem?.getDisplayTitle?.()
            || item.getDisplayTitle?.()
            || 'Untitled PDF';

        if (this.zotero.SDT?.getReader) {
            const reader = await this.zotero.SDT.getReader(itemID, {
                isPriority: true,
                onProgress,
            });
            if (reader) {
                return {
                    kind: 'structured',
                    title,
                    document: await reader.materialize(),
                    extractedPages: null,
                    totalPages: null,
                    warnings: [],
                };
            }
        }

        if (!this.zotero.PDFWorker?.getFullText) {
            throw new Error('PDF text extraction is unavailable in this Zotero version');
        }

        const result = await this.zotero.PDFWorker.getFullText(itemID, null, true);
        if (!result?.text?.trim()) {
            throw new Error('The PDF contains no extractable text; OCR may be required');
        }

        return {
            kind: 'plain',
            title,
            text: result.text,
            extractedPages: result.extractedPages ?? null,
            totalPages: result.totalPages ?? null,
            warnings: ['Structured PDF extraction was unavailable; showing plain text.'],
        };
    }
}
