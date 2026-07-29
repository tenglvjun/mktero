import { comparePdfAnnotations } from '../core/pdf-annotation.js';

const SUPPORTED_ANNOTATION_TYPES = new Set(['highlight', 'underline']);
const DEFAULT_ANNOTATION_COLOR = '#ffd400';
const SAFE_COLOR = /^#[0-9a-f]{6}$/i;
const MAX_TEXT_ANNOTATIONS = 5_000;
const MAX_ANNOTATION_TEXT_LENGTH = 100_000;
const MAX_TOTAL_ANNOTATION_TEXT_LENGTH = 2_000_000;

export class ZoteroAnnotationExtractor {
    constructor(zotero) {
        if (!zotero?.Items) {
            throw new TypeError('A Zotero runtime is required');
        }
        this.zotero = zotero;
    }

    async extract(itemID) {
        const item = await this.zotero.Items.getAsync(itemID);
        if (!item?.isPDFAttachment?.()) {
            throw new Error('Only PDF attachments can provide annotations');
        }

        await this.zotero.Items.loadDataTypes([item], ['childItems']);
        const annotationItems = item.getAnnotations(false);
        if (!annotationItems.length) return [];

        await this.zotero.Items.loadDataTypes(
            annotationItems,
            ['annotation', 'annotationDeferred']
        );
        const supported = annotationItems.filter(annotation => (
            SUPPORTED_ANNOTATION_TYPES.has(
                annotation.annotationType
            )
        ));
        if (supported.length > MAX_TEXT_ANNOTATIONS) {
            throw new Error('PDF annotation count exceeds the local safety limit');
        }
        let totalTextLength = 0;
        return supported
            .map(annotation => {
                const normalized = normalizeAnnotation(annotation);
                if (normalized.text.length > MAX_ANNOTATION_TEXT_LENGTH
                    || normalized.comment.length > MAX_ANNOTATION_TEXT_LENGTH) {
                    throw new Error(
                        'PDF annotation text exceeds the local safety limit'
                    );
                }
                totalTextLength += normalized.text.length
                    + normalized.comment.length;
                if (totalTextLength > MAX_TOTAL_ANNOTATION_TEXT_LENGTH) {
                    throw new Error(
                        'PDF annotation text exceeds the local safety limit'
                    );
                }
                return normalized;
            })
            .filter(annotation => annotation.text)
            .sort(comparePdfAnnotations);
    }
}

function normalizeAnnotation(annotation) {
    const color = String(annotation.annotationColor || '').trim();
    return {
        id: String(annotation.key || annotation.id || ''),
        type: annotation.annotationType,
        text: String(annotation.annotationText || ''),
        comment: String(annotation.annotationComment || ''),
        color: SAFE_COLOR.test(color)
            ? color.toLowerCase()
            : DEFAULT_ANNOTATION_COLOR,
        pageLabel: String(annotation.annotationPageLabel || ''),
        pageIndex: annotationPageIndex(annotation.annotationPosition),
        sortIndex: String(annotation.annotationSortIndex || ''),
    };
}

function annotationPageIndex(position) {
    try {
        const parsed = typeof position === 'string'
            ? JSON.parse(position)
            : position;
        return Number.isInteger(parsed?.pageIndex) && parsed.pageIndex >= 0
            ? parsed.pageIndex
            : null;
    }
    catch {
        return null;
    }
}
