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
