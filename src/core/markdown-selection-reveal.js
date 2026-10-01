const VIEWS = new Set(['original', 'translated', 'compare']);

export function markdownRevealTarget({
    sourceRange,
    translationView = 'original',
    translationStatus = 'none',
    blockRanges = [],
} = {}) {
    const sourceOffset = validOffset(sourceRange?.markdownFrom);
    if (sourceOffset === null || !validMarkdownRange(
        sourceRange?.markdownFrom,
        sourceRange?.markdownTo
    )) {
        return null;
    }
    const view = VIEWS.has(translationView) ? translationView : 'original';
    const block = coveringBlock(sourceRange, blockRanges);
    const sourceReveal = {
        view: 'original',
        offset: sourceOffset,
        from: sourceRange.markdownFrom,
        to: sourceRange.markdownTo,
    };
    if (!block) return sourceReveal;

    if (view === 'translated') {
        const translated = mappedReveal(
            sourceRange,
            'translated',
            block.sourceFrom,
            block.translatedFrom,
            block.translatedTo
        );
        if (translated) return translated;
    }
    if (view === 'compare') {
        const comparison = mappedReveal(
            sourceRange,
            'compare',
            block.sourceFrom,
            block.comparisonSourceFrom,
            block.comparisonSourceTo
        );
        if (comparison) return comparison;
    }
    if (hasCompleteBlockTranslation(block, translationStatus)) {
        const comparison = mappedReveal(
            sourceRange,
            'compare',
            block.sourceFrom,
            block.comparisonSourceFrom,
            block.comparisonSourceTo
        );
        if (comparison) return comparison;
    }
    return sourceReveal;
}

export function selectionRevealChanges(model, sourceRange) {
    return markdownRevealTarget({
        sourceRange,
        translationView: model?.translationView,
        translationStatus: model?.translationStatus,
        blockRanges: model?.translationBlockRanges,
    });
}

function coveringBlock(sourceRange, blockRanges) {
    if (!Array.isArray(blockRanges)) return null;
    const matches = blockRanges.filter(block => (
        Number.isSafeInteger(block?.sourceFrom)
        && Number.isSafeInteger(block?.sourceTo)
        && block.sourceFrom <= sourceRange.markdownFrom
        && block.sourceTo >= sourceRange.markdownTo
    ));
    return matches.length === 1 ? matches[0] : null;
}

function hasCompleteBlockTranslation(block, translationStatus) {
    return (translationStatus === 'ready' || translationStatus === 'partial')
        && validMarkdownRange(
            block.comparisonTranslationFrom,
            block.comparisonTranslationTo
        )
        && validMarkdownRange(
            block.comparisonSourceFrom,
            block.comparisonSourceTo
        );
}

function mappedReveal(
    sourceRange,
    view,
    sourceFrom,
    destinationFrom,
    destinationTo
) {
    const from = mappedOffset(
        sourceRange.markdownFrom,
        sourceFrom,
        destinationFrom,
        destinationTo
    );
    const end = mappedOffset(
        sourceRange.markdownTo - 1,
        sourceFrom,
        destinationFrom,
        destinationTo
    );
    if (from === null || end === null) return null;
    return {
        view,
        offset: from,
        from,
        to: Math.max(from + 1, end + 1),
    };
}

function mappedOffset(sourceOffset, sourceFrom, destinationFrom, destinationTo) {
    if (!Number.isSafeInteger(sourceFrom)
        || !validMarkdownRange(destinationFrom, destinationTo)
        || sourceOffset < sourceFrom) {
        return null;
    }
    return Math.min(
        destinationTo - 1,
        destinationFrom + (sourceOffset - sourceFrom)
    );
}

function validOffset(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function validMarkdownRange(from, to) {
    return Number.isSafeInteger(from)
        && Number.isSafeInteger(to)
        && from >= 0
        && to > from;
}
