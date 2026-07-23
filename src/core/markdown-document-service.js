import { ZoteroDocumentExtractor } from '../extractors/zotero-extractor.js';
import {
    renderPlainText,
    renderStructuredDocument,
} from '../markdown/structured-renderer.js';

export class MarkdownDocumentService {
    constructor({ extractor }) {
        if (!extractor) {
            throw new TypeError('A document extractor is required');
        }
        this.extractor = extractor;
        this.inFlight = new Map();
    }

    async convert(itemID, options = {}) {
        if (this.inFlight.has(itemID)) {
            return this.inFlight.get(itemID);
        }

        const conversion = this.#convert(itemID, options)
            .finally(() => this.inFlight.delete(itemID));
        this.inFlight.set(itemID, conversion);
        return conversion;
    }

    async #convert(itemID, options) {
        const extracted = await this.extractor.extract(itemID, options);
        const markdown = extracted.kind === 'structured'
            ? renderStructuredDocument(extracted.document)
            : renderPlainText(extracted.text);
        if (!markdown.trim()) {
            throw new Error('The PDF contains no extractable text; OCR may be required');
        }

        return {
            itemID,
            title: extracted.title,
            markdown,
            sourceKind: extracted.kind,
            extractedPages: extracted.extractedPages,
            totalPages: extracted.totalPages,
            warnings: extracted.warnings,
        };
    }
}

export function createMarkdownDocumentService({ zotero }) {
    return new MarkdownDocumentService({
        extractor: new ZoteroDocumentExtractor(zotero),
    });
}
