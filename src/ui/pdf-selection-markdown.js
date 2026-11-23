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

export function resolveResearchExcerptRange({ source, pages, text, rectForBBox }) {
    if (typeof source?.markdown !== 'string' || !pages?.length) return null;
    const { markdown } = source;
    const pageIndexes = new Set(pages.map(page => page.pageIndex));
    const targets = collectSourceMapSelectionTargets(source.sourceMap, markdown.length);
    const pageTargets = targets.filter(target => pageIndexes.has(target.pageIndex));
    const candidates = selectionCandidatesFromTargets(pageTargets, rectForBBox);
    const geometric = resolvePdfSelectionSource({ pages, candidates });
    const quote = String(text ?? '').trim().replace(/^[“"]([\s\S]+)[”"]$/u, '$1').trim();
    if (geometric) {
        return uniqueExcerptText(markdown, quote, [geometric]) || geometric;
    }
    if (maximumPdfSelectionCoverage({ pages, candidates }) > 0) return null;
    // Some older conversions have no source map. Require a unique literal
    // excerpt there. With a source map, also require the saved PDF page.
    if (!targets.length) {
        return uniqueExcerptText(markdown, quote, [{ markdownFrom: 0, markdownTo: markdown.length }]);
    }
    return uniqueExcerptText(markdown, quote, pageTargets);
}

function uniqueExcerptText(markdown, quote, ranges) {
    if ((quote.match(/[\p{L}\p{N}]/gu) || []).length < 8) return null;
    const escaped = quote.split(/\s+/u)
        .map(word => word.replace(/[.*+?^\u0024{}()|[\]\\]/gu, '\\$&')).join('\\s+');
    const pattern = new RegExp(escaped, 'gu');
    let found = null;
    for (const { markdownFrom, markdownTo } of ranges) {
        const slice = markdown.slice(markdownFrom, markdownTo);
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(slice))) {
            const from = markdownFrom + match.index;
            if (found && found.markdownFrom !== from) return null;
            found = { markdownFrom: from, markdownTo: markdownFrom + pattern.lastIndex };
            // Count overlapping occurrences as ambiguous, too.
            pattern.lastIndex = match.index + 1;
        }
    }
    return found;
}
