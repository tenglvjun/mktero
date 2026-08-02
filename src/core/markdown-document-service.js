import { ZoteroDocumentExtractor } from '../extractors/zotero-extractor.js';
import {
    renderPlainText,
    renderStructuredDocument,
} from '../markdown/structured-renderer.js';
import { mergeAnnotationOverlays } from './markdown-local-annotations.js';

export class MarkdownDocumentService {
    constructor({
        extractor,
        annotationOverlay = null,
        localAnnotations = null,
    }) {
        if (!extractor) {
            throw new TypeError('A document extractor is required');
        }
        this.extractor = extractor;
        this.annotationOverlay = annotationOverlay;
        this.localAnnotations = localAnnotations;
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
            warnings: extracted.warnings || [],
        };
        if ('cacheHit' in extracted) {
            result.cacheHit = Boolean(extracted.cacheHit);
        }
        if ('resumedTask' in extracted) {
            result.resumedTask = Boolean(extracted.resumedTask);
        }
        if (extracted.cacheKey) {
            result.cacheKey = extracted.cacheKey;
        }
        if (Array.isArray(extracted.sourceMap)) {
            result.sourceMap = extracted.sourceMap;
        }
        if (extracted.assets?.length) {
            result.assets = extracted.assets;
            result.assetBasePath = extracted.assetBasePath || '';
        }
        const annotationResult = await this.resolveAnnotations(
            itemID,
            markdown,
            { retryLocalAnnotations: true },
        );
        result.warnings = [
            ...result.warnings,
            ...annotationResult.warnings,
        ];
        if (annotationResult.annotationOverlay) {
            result.annotationOverlay = annotationResult.annotationOverlay;
        }
        return result;
    }

    async resolveAnnotations(itemID, markdown, {
        retryLocalAnnotations = false,
    } = {}) {
        const overlays = [];
        const warnings = [];
        if (this.annotationOverlay) {
            const annotationResult = await this.annotationOverlay.resolve(
                itemID,
                markdown
            );
            const { warning, ...annotationOverlay } = annotationResult;
            overlays.push(annotationOverlay);
            if (warning) warnings.push(warning);
        }
        if (this.localAnnotations) {
            const localResult = await this.localAnnotations.resolve(
                itemID,
                markdown,
                { retryFailed: retryLocalAnnotations },
            );
            const { warning, ...localOverlay } = localResult;
            overlays.push(localOverlay);
            if (warning) warnings.push(warning);
        }
        return {
            annotationOverlay: overlays.length
                ? mergeAnnotationOverlays(...overlays)
                : null,
            warnings,
        };
    }
}

export function createMarkdownDocumentService({ zotero }) {
    return new MarkdownDocumentService({
        extractor: new ZoteroDocumentExtractor(zotero),
    });
}
