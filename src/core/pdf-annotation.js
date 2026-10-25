export const MAX_PDF_ANNOTATION_TEXT_LENGTH = 100_000;
export const MAX_PDF_ANNOTATION_TEXT_QUOTE_CONTEXT_CODE_POINTS = 80;
export const MAX_PDF_ANNOTATION_TEXT_QUOTE_CONTEXT_LENGTH
    = MAX_PDF_ANNOTATION_TEXT_QUOTE_CONTEXT_CODE_POINTS * 2;

export const ZOTERO_ANNOTATION_COLORS = Object.freeze([
    Object.freeze({ name: 'yellow', value: '#ffd400' }),
    Object.freeze({ name: 'red', value: '#ff6666' }),
    Object.freeze({ name: 'green', value: '#5fb236' }),
    Object.freeze({ name: 'blue', value: '#2ea8e5' }),
    Object.freeze({ name: 'purple', value: '#a28ae5' }),
    Object.freeze({ name: 'magenta', value: '#e56eee' }),
    Object.freeze({ name: 'orange', value: '#f19837' }),
    Object.freeze({ name: 'gray', value: '#aaaaaa' }),
]);

export function isZoteroAnnotationColor(value) {
    const color = String(value || '').toLowerCase();
    return ZOTERO_ANNOTATION_COLORS.some(option => option.value === color);
}

export function normalizePDFAnnotationTextQuote(value) {
    if (value === undefined || value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Invalid PDF annotation text quote');
    }
    const prefix = value.prefix === undefined ? '' : value.prefix;
    const suffix = value.suffix === undefined ? '' : value.suffix;
    if (typeof prefix !== 'string'
        || typeof suffix !== 'string'
        || prefix.length > MAX_PDF_ANNOTATION_TEXT_QUOTE_CONTEXT_LENGTH
        || suffix.length > MAX_PDF_ANNOTATION_TEXT_QUOTE_CONTEXT_LENGTH
        || [...prefix].length
            > MAX_PDF_ANNOTATION_TEXT_QUOTE_CONTEXT_CODE_POINTS
        || [...suffix].length
            > MAX_PDF_ANNOTATION_TEXT_QUOTE_CONTEXT_CODE_POINTS) {
        throw new TypeError('Invalid PDF annotation text quote');
    }
    return prefix || suffix ? { prefix, suffix } : null;
}

export function leadingCodePoints(value, limit, from = 0) {
    let offset = from;
    let count = 0;
    while (offset < value.length && count < limit) {
        const character = String.fromCodePoint(value.codePointAt(offset));
        offset += character.length;
        count++;
    }
    return value.slice(from, offset);
}

export function trailingCodePoints(value, limit, to = value.length) {
    let offset = to;
    let count = 0;
    while (offset > 0 && count < limit) {
        offset--;
        if (offset > 0
            && isLowSurrogate(value.charCodeAt(offset))
            && isHighSurrogate(value.charCodeAt(offset - 1))) {
            offset--;
        }
        count++;
    }
    return value.slice(offset, to);
}

export function comparePdfAnnotations(left, right) {
    return compareStrings(
        String(left?.sortIndex || ''),
        String(right?.sortIndex || '')
    )
        || annotationPageIndex(left) - annotationPageIndex(right)
        || compareStrings(
            String(left?.id || ''),
            String(right?.id || '')
        );
}

// The localization key that explains a local highlight's Zotero sync state,
// or null when it is synchronized. Shared by the highlight in the text and the
// note list, so both say the same thing.
export function annotationSynchronizationLabelKey(synchronization) {
    if (synchronization?.status === 'pending') return 'annotation.syncPending';
    if (synchronization?.status !== 'failed') return null;
    switch (synchronization.reason) {
        case 'pdf-index-unavailable':
            return 'annotation.syncFailed.pdfIndexUnavailable';
        case 'text-not-found':
            return 'annotation.syncFailed.textNotFound';
        case 'text-ambiguous':
            return 'annotation.syncFailed.textAmbiguous';
        case 'reader-unavailable':
            return 'annotation.syncFailed.readerUnavailable';
        case 'search-timeout':
            return 'annotation.syncFailed.searchTimeout';
        default:
            return 'annotation.syncFailed.unknown';
    }
}

// Set on the error an action throws when the Zotero annotation it targets no
// longer exists or cannot be edited, so a caller can tell that apart from a
// failed save.
export const PDF_ANNOTATION_UNAVAILABLE = 'MKTERO_PDF_ANNOTATION_UNAVAILABLE';

export function isPDFAnnotationUnavailableError(error) {
    return error?.code === PDF_ANNOTATION_UNAVAILABLE;
}

export function accessibleAnnotationText(value) {
    const text = String(value || '').replace(/\s+/gu, ' ').trim();
    return text.length <= 200 ? text : `${text.slice(0, 199)}…`;
}

function annotationPageIndex(annotation) {
    return Number.isInteger(annotation?.pageIndex) && annotation.pageIndex >= 0
        ? annotation.pageIndex
        : Number.MAX_SAFE_INTEGER;
}

function compareStrings(left, right) {
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

function isHighSurrogate(value) {
    return value >= 0xD800 && value <= 0xDBFF;
}

function isLowSurrogate(value) {
    return value >= 0xDC00 && value <= 0xDFFF;
}
