export const MAX_PDF_ANNOTATION_TEXT_LENGTH = 100_000;

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
