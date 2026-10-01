import {
    collectSourceMapSelectionTargets,
    maximumPdfSelectionCoverage,
    pdfSelectionPagesFromAnnotation,
    resolvePdfSelectionSource,
    resolveUniqueSelectionText,
    selectionCandidatesFromTargets,
} from '../core/pdf-selection-source-resolver.js';

export async function revealPdfSelectionAsMarkdown({
    reader,
    annotation,
    loadSource,
    rectForBBox,
    queueReveal,
    openMarkdown,
} = {}) {
    if (reader?.type !== 'pdf' || !Number.isSafeInteger(reader.itemID)) {
        return { status: 'unresolved' };
    }
    const pages = pdfSelectionPagesFromAnnotation(annotation);
    if (!pages || typeof loadSource !== 'function') {
        return { status: 'unresolved' };
    }
    const source = await loadSource(reader.itemID);
    if (!source
        || !Array.isArray(source.sourceMap)
        || !Number.isSafeInteger(source.documentLength)
        || source.documentLength < 0) {
        return { status: 'unresolved' };
    }
    const selectedPages = new Set(pages.map(page => page.pageIndex));
    const candidates = selectionCandidatesFromTargets(
        collectSourceMapSelectionTargets(source.sourceMap, source.documentLength)
            .filter(target => selectedPages.has(target.pageIndex)),
        rectForBBox
    );
    const geometric = candidates
        ? resolvePdfSelectionSource({ pages, candidates })
        : null;
    const coverage = candidates
        ? maximumPdfSelectionCoverage({ pages, candidates })
        : 0;
    const match = geometric || (coverage === 0
        ? resolveUniqueSelectionText({
            markdown: source.markdown,
            sourceMap: source.sourceMap,
            text: annotation?.text,
        })
        : null);
    if (!match
        || typeof queueReveal !== 'function'
        || typeof openMarkdown !== 'function') {
        return { status: 'unresolved' };
    }
    queueReveal(reader.itemID, match);
    const opened = await openMarkdown(reader.itemID);
    if (opened === false) return { status: 'unresolved' };
    return { status: 'opened', sourceRange: match };
}
