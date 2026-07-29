import { ZoteroDocumentExtractor } from '../extractors/zotero-extractor.js';
import {
    renderPlainText,
    renderStructuredDocument,
} from '../markdown/structured-renderer.js';

export class MarkdownDocumentService {
    constructor({ extractor, annotationOverlay = null }) {
        if (!extractor) {
            throw new TypeError('A document extractor is required');
        }
        this.extractor = extractor;
        this.annotationOverlay = annotationOverlay;
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
        if (!markdown.trim() && !extracted.userEdited) {
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
        if ('cacheHit' in extracted) {
            result.cacheHit = Boolean(extracted.cacheHit);
        }
        if (extracted.cacheKey) {
            result.cacheKey = extracted.cacheKey;
        }
        if (extracted.assets?.length) {
            result.assets = extracted.assets;
            result.assetBasePath = extracted.assetBasePath || '';
        }
        if (this.annotationOverlay) {
            const annotationResult = await this.annotationOverlay.resolve(
                itemID,
                markdown
            );
            const { warning, ...annotationOverlay } = annotationResult;
            result.annotationOverlay = annotationOverlay;
            if (warning) result.warnings = [...result.warnings, warning];
        }
        return result;
    }
}

export function createMarkdownDocumentService({ zotero }) {
    return new MarkdownDocumentService({
        extractor: new ZoteroDocumentExtractor(zotero),
    });
}
