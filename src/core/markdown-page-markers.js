import {
    isValidSourceLocation,
    isValidSourceMapEntry,
} from './markdown-source-map.js';

// A full normalized page: the whole printable area of the PDF page, so a page
// marker click navigates to the page itself rather than one text region.
const FULL_PAGE_BBOX = Object.freeze([0, 0, 1000, 1000]);
const PAGE_MARKER_COMMENT = /^<!--\s*zotero-page:\s*([\s\S]*?)\s*-->$/;

/**
 * Locate every page-boundary comment in the Markdown source.
 *
 * Page markers are emitted by the structured and plain-text renderers as
 * standalone `<!-- zotero-page: label -->` comments, in page order. The label
 * is display text ("2", "A-1", "iv"); `pageMarkerPageIndex` derives the
 * source page index from it. The offsets point at the comment itself,
 * inclusive.
 */
export function findMarkdownPageMarkers(markdown) {
    if (typeof markdown !== 'string') return [];
    const markers = [];
    const pattern = new RegExp(
        `^${PAGE_MARKER_COMMENT.source}$`,
        'gm'
    );
    for (const match of markdown.matchAll(pattern)) {
        markers.push({
            page: match[1],
            from: match.index,
            to: match.index + match[0].length,
        });
    }
    return markers;
}

/**
 * Derive the source page index for a marker. Numeric labels are the 1-based
 * page number both renderers emit; non-numeric labels fall back to the
 * marker's ordinal position, which is correct while every page boundary has
 * a marker.
 */
export function pageMarkerPageIndex(marker, markerIndex) {
    const label = String(marker?.page ?? '').trim();
    if (/^\d+$/.test(label)) {
        const page = Number(label);
        if (page >= 1) return page - 1;
    }
    return Number.isSafeInteger(markerIndex) && markerIndex >= 0
        ? markerIndex
        : null;
}

/**
 * Build a whole-page source map for documents whose extractor produced no
 * block-level source map. Structured and plain-text extraction know page
 * boundaries only, so each marker starts one entry covering everything up to
 * the next marker. Entries appear in document order, which lets a page
 * marker resolve to its own page.
 */
export function createPageMarkerSourceMap(markdown, pageMarkers) {
    const markers = Array.isArray(pageMarkers)
        ? pageMarkers
        : findMarkdownPageMarkers(markdown);
    if (!Array.isArray(pageMarkers) || !pageMarkers.length) return [];
    const entries = [];
    for (let index = 0; index < markers.length; index++) {
        const marker = markers[index];
        if (!Number.isSafeInteger(marker.from)
            || !Number.isSafeInteger(marker.to)
            || marker.to <= marker.from
            || marker.to > markdown.length) {
            continue;
        }
        const from = marker.to;
        const to = index + 1 < markers.length
            ? markers[index + 1].from
            : markdown.length;
        if (to <= from) continue;
        entries.push({
            type: 'page',
            markdownFrom: from,
            markdownTo: to,
            locations: [{
                pageIndex: pageMarkerPageIndex(marker, index),
                bbox: [...FULL_PAGE_BBOX],
            }],
        });
    }
    return entries;
}

/**
 * Resolve the PDF location a page marker click navigates to: the marker's
 * own whole-page entry when the document carries one, otherwise the nearest
 * mapped block at or after the marker.
 */
export function resolvePageMarkerSourceLocation(
    sourceMap,
    pageMarkers,
    markerIndex,
    documentLength = Infinity
) {
    const marker = Array.isArray(pageMarkers)
        ? pageMarkers[markerIndex]
        : null;
    if (!marker
        || !Number.isSafeInteger(marker.from)
        || !Number.isSafeInteger(marker.to)
        || marker.to <= marker.from) {
        return null;
    }
    if (!Array.isArray(sourceMap)) return null;

    const ownEntry = sourceMap.find(entry => (
        isValidSourceMapEntry(entry, documentLength)
        && entry.markdownFrom === marker.to
    ));
    if (ownEntry) return sourceMapLocation(ownEntry.locations);

    const following = sourceMap
        .filter(entry => (
            isValidSourceMapEntry(entry, documentLength)
            && entry.markdownFrom >= marker.from
        ))
        .sort((left, right) => left.markdownFrom - right.markdownFrom);
    for (const entry of following) {
        const location = sourceMapLocation(entry.locations);
        if (location) return location;
    }
    // Page markers only exist in structured and plain-text documents, which
    // carry no block-level source map at all. Their label or ordinal position
    // still identifies the page, so fall back to a whole-page location.
    const pageIndex = pageMarkerPageIndex(marker, markerIndex);
    return pageIndex === null
        ? null
        : { pageIndex, bbox: [...FULL_PAGE_BBOX] };
}

function sourceMapLocation(locations) {
    const location = locations?.[0];
    if (!isValidSourceLocation(location)) return null;
    return {
        pageIndex: location.pageIndex,
        bbox: [...location.bbox],
    };
}
