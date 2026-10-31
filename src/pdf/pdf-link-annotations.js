import { safePDFLinkURL } from '../markdown/markdown-links.js';

export const PDF_LINK_ANNOTATION_LIMITS = Object.freeze({
    maxLinksPerPage: 2_000,
    maxRectsPerLink: 128,
    maxURLLength: 4_096,
});

const PDF_LINK_ANNOTATION_TYPE = 2;
const MIN_SPAN_COVERAGE = 0.75;
const MIN_LINE_COVERAGE = 0.9;
const MIN_LINK_COVERAGE = 0.1;
const MAX_PARTIAL_LINK_AREA = 100_000;
const MIN_RECT_SIZE = 0.01;

// PDF.js reports link rectangles in PDF user space. Store them in the same
// top-left, 0-1000 page frame used by the MinerU document IR so matching does
// not depend on page rotation or crop-box offsets.
export function normalizePDFLinkAnnotations(annotations, viewport) {
    if (!Array.isArray(annotations) || !validViewport(viewport)) return [];
    const output = [];
    for (const annotation of annotations) {
        if (!isLinkAnnotation(annotation)) continue;
        const url = safePDFLinkURL(annotation.url);
        if (typeof annotation.url !== 'string'
            || !url || url.length > PDF_LINK_ANNOTATION_LIMITS.maxURLLength) continue;
        const rects = annotationRects(annotation, viewport)
            .slice(0, PDF_LINK_ANNOTATION_LIMITS.maxRectsPerLink);
        if (!rects.length) continue;
        output.push({ url, rects });
        if (output.length >= PDF_LINK_ANNOTATION_LIMITS.maxLinksPerPage) break;
    }
    return output;
}

export function validatePDFLink(link) {
    if (!link || typeof link !== 'object' || Array.isArray(link)
        || typeof link.url !== 'string') return false;
    const url = safePDFLinkURL(link.url);
    return Boolean(url && url.length <= PDF_LINK_ANNOTATION_LIMITS.maxURLLength
        && link.url === url
        && Array.isArray(link.rects)
        && link.rects.length > 0
        && link.rects.length <= PDF_LINK_ANNOTATION_LIMITS.maxRectsPerLink
        && link.rects.every(validNormalizedRect));
}

// Match PDF-native links to MinerU text spans. A native annotation is the
// strongest source: when it matches, `nativeLinkURL` intentionally overrides a
// provider URL while preserving that URL for diagnostics and future fallback.
// A line-level fallback is used only when the line contains one text span;
// otherwise the target is ambiguous and remains ordinary text.
export function applyPDFLinkAnnotations(ir, pdfText) {
    const diagnostics = {
        pages: 0,
        annotations: 0,
        matched: 0,
        ambiguous: 0,
        skipped: 0,
    };
    ir.diagnostics ||= {};
    ir.diagnostics.pdfLinks = diagnostics;
    const pages = new Map((pdfText?.pages || []).map(page => [page.pageIndex, page]));
    if (pdfText?.linkAnnotationsComplete === false) diagnostics.incomplete = true;
    if (!pages.size) return ir;

    for (const page of ir.pages || []) {
        const pdfPage = pages.get(page.pageIndex);
        const links = Array.isArray(pdfPage?.links)
            ? pdfPage.links.filter(validatePDFLink)
            : [];
        if (!links.length) continue;
        diagnostics.pages++;
        diagnostics.annotations += links.length;
        if (!pageShapeMatches(page, pdfPage)) {
            diagnostics.skipped += links.length;
            continue;
        }
        const spans = textSpansOnPage(ir, page.pageIndex);
        const assignments = new Map();
        for (const link of links) {
            const candidates = matchLinkToSpans(link, spans);
            if (!candidates.length) {
                diagnostics.skipped++;
                continue;
            }
            for (const candidate of candidates) {
                const previous = assignments.get(candidate.span);
                if (previous && previous !== link.url) {
                    assignments.set(candidate.span, null);
                }
                else if (previous !== null) {
                    assignments.set(candidate.span, link.url);
                }
            }
        }
        for (const [span, url] of assignments) {
            if (!url) {
                diagnostics.ambiguous++;
                continue;
            }
            span.nativeLinkURL = url;
            diagnostics.matched++;
        }
    }
    return ir;
}

function pageShapeMatches(irPage, pdfPage) {
    if (irPage?.pageSizeKnown === false) return true;
    const width = Number(irPage?.width);
    const height = Number(irPage?.height);
    const viewportWidth = Number(pdfPage?.viewport?.width);
    const viewportHeight = Number(pdfPage?.viewport?.height);
    if (!(width > 0) || !(height > 0) || !(viewportWidth > 0) || !(viewportHeight > 0)) return true;
    const irAspect = width / height;
    const pdfAspect = viewportWidth / viewportHeight;
    return Math.abs(irAspect - pdfAspect) / irAspect <= 0.02;
}
function textSpansOnPage(ir, pageIndex) {
    const output = [];
    for (const block of ir.blocks || []) {
        for (const fragment of block.fragments || []) {
            if (fragment.pageIndex !== pageIndex) continue;
            for (const line of fragment.lines || []) {
                const textSpans = (line.spans || []).filter(span => (
                    span.type === 'text'
                    && String(span.content || '').trim()
                ));
                for (const span of textSpans) {
                    output.push({
                        span,
                        bbox: validNormalizedRect(span.bbox) ? span.bbox : null,
                        line,
                    });
                }
            }
        }
    }
    return output;
}

function matchLinkToSpans(link, spans) {
    const precise = spans.filter(candidate => candidate.bbox
        && coversSpan(link.rects, candidate.bbox));
    const matched = [...precise];
    const matchedLines = new Set(precise.map(candidate => candidate.line));

    const fallbackLines = [];
    for (const candidate of spans) {
        if (!candidate.bbox && !matchedLines.has(candidate.line)
            && validNormalizedRect(candidate.line.bbox)
            && coversLine(link.rects, candidate.line.bbox)) {
            if (!fallbackLines.includes(candidate.line)) fallbackLines.push(candidate.line);
        }
    }
    for (const line of fallbackLines) {
        const lineSpans = spans.filter(candidate => candidate.line === line);
        if (lineSpans.length === 1) matched.push(lineSpans[0]);
    }
    return matched;
}

function coversLine(rects, line) {
    const area = rectangleArea(line);
    const linkArea = rectangleUnionArea(rects);
    if (!(area > 0) || !(linkArea > 0)) return false;
    const overlap = linkRectsOverlapArea(rects, line);
    return overlap / area >= MIN_LINE_COVERAGE
        && sufficientLinkCoverage(overlap, linkArea);
}

function coversSpan(rects, span) {
    const area = rectangleArea(span);
    const linkArea = rectangleUnionArea(rects);
    if (!(area > 0) || !(linkArea > 0)) return false;
    const overlap = linkRectsOverlapArea(rects, span);
    return overlap / area >= MIN_SPAN_COVERAGE
        && sufficientLinkCoverage(overlap, linkArea);
}

// Normal text links are often split into several spans across one wide,
// line-height annotation. Permit those small pieces, but retain the area guard
// for page-sized annotations that are not reliable link targets.
function sufficientLinkCoverage(overlap, linkArea) {
    return linkArea <= MAX_PARTIAL_LINK_AREA
        || overlap / linkArea >= MIN_LINK_COVERAGE;
}

function linkRectsOverlapArea(rects, target) {
    return rectangleUnionArea(rects.map(rect => intersectRect(rect, target)).filter(Boolean));
}

function rectangleUnionArea(rects) {
    if (!rects.length) return 0;
    const xCoordinates = [...new Set(rects.flatMap(rect => [rect[0], rect[2]]))]
        .sort((left, right) => left - right);
    let area = 0;
    for (let index = 1; index < xCoordinates.length; index++) {
        const left = xCoordinates[index - 1];
        const right = xCoordinates[index];
        if (!(right > left)) continue;
        const intervals = rects
            .filter(rect => rect[0] < right && rect[2] > left)
            .map(rect => [rect[1], rect[3]])
            .sort((a, b) => a[0] - b[0]);
        let covered = 0;
        let start = null;
        let end = null;
        for (const [top, bottom] of intervals) {
            if (start === null) {
                start = top;
                end = bottom;
            }
            else if (top > end) {
                covered += end - start;
                start = top;
                end = bottom;
            }
            else {
                end = Math.max(end, bottom);
            }
        }
        if (start !== null) covered += end - start;
        area += (right - left) * covered;
    }
    return area;
}

function intersectRect(left, right) {
    const rect = [
        Math.max(left[0], right[0]), Math.max(left[1], right[1]),
        Math.min(left[2], right[2]), Math.min(left[3], right[3]),
    ];
    return validNormalizedRect(rect) ? rect : null;
}

function rectangleArea(rect) {
    return (rect[2] - rect[0]) * (rect[3] - rect[1]);
}

function isLinkAnnotation(annotation) {
    return annotation?.annotationType === PDF_LINK_ANNOTATION_TYPE
        || annotation?.subtype === 'Link';
}

function annotationRects(annotation, viewport) {
    const points = Array.from(annotation.quadPoints || []);
    if (points.length >= 8 && points.length % 8 === 0
        && points.every(Number.isFinite)) {
        const rects = [];
        for (let index = 0; index < points.length; index += 8) {
            const quad = points.slice(index, index + 8);
            const rect = normalizePDFRect(quad, viewport);
            if (rect) rects.push(rect);
        }
        if (rects.length) return rects;
    }
    return [normalizePDFRect(annotation.rect, viewport)].filter(Boolean);
}

function normalizePDFRect(values, viewport) {
    if (!Array.isArray(values) && !ArrayBuffer.isView(values)) return null;
    const numbers = Array.from(values, Number);
    if (numbers.length !== 4 && numbers.length !== 8) return null;
    if (!numbers.every(Number.isFinite)) return null;
    const points = [];
    if (numbers.length === 4) {
        const [x1, y1, x2, y2] = numbers;
        points.push([x1, y1], [x2, y1], [x1, y2], [x2, y2]);
    }
    else {
        for (let index = 0; index < numbers.length; index += 2) {
            points.push([numbers[index], numbers[index + 1]]);
        }
    }
    const transformed = points.map(([x, y]) => transformPoint(viewport.transform, x, y));
    const xs = transformed.map(point => point[0]);
    const ys = transformed.map(point => point[1]);
    const rect = [
        Math.max(0, Math.min(1000, Math.min(...xs) / viewport.width * 1000)),
        Math.max(0, Math.min(1000, Math.min(...ys) / viewport.height * 1000)),
        Math.max(0, Math.min(1000, Math.max(...xs) / viewport.width * 1000)),
        Math.max(0, Math.min(1000, Math.max(...ys) / viewport.height * 1000)),
    ];
    return validNormalizedRect(rect) ? rect : null;
}

function transformPoint(transform, x, y) {
    return [
        transform[0] * x + transform[2] * y + transform[4],
        transform[1] * x + transform[3] * y + transform[5],
    ];
}

function validViewport(viewport) {
    return Array.isArray(viewport?.transform)
        && viewport.transform.length === 6
        && viewport.transform.every(Number.isFinite)
        && Number.isFinite(viewport.width)
        && Number.isFinite(viewport.height)
        && viewport.width > 0
        && viewport.height > 0;
}

function validNormalizedRect(rect) {
    return Array.isArray(rect)
        && rect.length === 4
        && rect.every(Number.isFinite)
        && rect[0] >= 0
        && rect[1] >= 0
        && rect[2] <= 1000
        && rect[3] <= 1000
        && rect[2] - rect[0] >= MIN_RECT_SIZE
        && rect[3] - rect[1] >= MIN_RECT_SIZE;
}
