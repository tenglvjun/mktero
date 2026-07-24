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
        const existing = this.inFlight.get(itemID);
        if (existing && !existing.signal?.aborted) {
            return existing.promise;
        }

        const entry = { signal: options.signal, promise: null };
        entry.promise = this.#convert(itemID, options)
            .finally(() => {
                if (this.inFlight.get(itemID) === entry) {
                    this.inFlight.delete(itemID);
                }
            });
        this.inFlight.set(itemID, entry);
        return entry.promise;
    }

    async #convert(itemID, options) {
        const extracted = await this.extractor.extract(itemID, options);
        const markdown = extracted.kind === 'markdown'
            ? extracted.markdown
            : extracted.kind === 'structured'
                ? renderStructuredDocument(extracted.document)
                : renderPlainText(extracted.text);
        if (!markdown.trim()) {
            throw new Error('The PDF contains no extractable text; OCR may be required');
        }

        const result = {
            itemID,
            title: extracted.title,
            markdown,
            sourceKind: extracted.kind,
            extractedPages: extracted.extractedPages,
            totalPages: extracted.totalPages,
            warnings: extracted.warnings,
        };
        if (extracted.assets?.length) {
            result.assets = extracted.assets;
            result.assetBasePath = extracted.assetBasePath || '';
        }
        return result;
    }
}

export function createMarkdownDocumentService({ zotero }) {
    return new MarkdownDocumentService({
        extractor: new ZoteroDocumentExtractor(zotero),
    });
}
