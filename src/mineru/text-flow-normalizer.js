import { isValidSourceMapEntry } from '../core/markdown-source-map.js';

const MAX_CONTINUATION_TOP = 220;
const MIN_ANCHOR_BOTTOM = 780;
const MIN_ANCHOR_WORDS = 6;
const INCOMPLETE_TEXT_END_PATTERN = /(?:[+\-*/=<>≤≥≠]|[([{,;:])\s*$/u;
const DANGLING_WORD_END_PATTERN = new RegExp(
    '\\b(?:a|an|and|as|at|because|between|but|by|for|from|her|his|if|in|into'
    + '|its|my|nor|of|on|or|our|over|than|that|the|their|these|this|those|though'
    + '|to|under|when|where|whether|which|while|who|whom|whose|with|without|your)'
    + '\\s*$',
    'iu'
);
const NON_PROSE_BLOCK_START_PATTERN = /^(?:#{1,6}(?:\s|$)|(?:[-+*]|\d+[.)])\s+|>\s|```|~~~|<)/u;

export function reassembleMinerUTextFlow(markdown, sourceMap) {
    const source = String(markdown || '');
    if (!source || !Array.isArray(sourceMap)) return source;

    const entries = sourceMap
        .filter(entry => isValidSourceMapEntry(entry, source.length))
        .sort((left, right) => left.markdownFrom - right.markdownFrom);
    const edits = [];
    const usedAnchors = new Set();

    for (const continuation of entries) {
        const continuationPage = singlePageIndex(continuation);
        if (continuation.type !== 'text'
            || continuationPage === null
            || !isTopOfPage(continuation)
            || !startsLikeContinuation(source, continuation)) {
            continue;
        }

        const match = findContinuationAnchor(
            source,
            entries,
            continuation,
            continuationPage,
            usedAnchors
        );
        if (!match) continue;

        const { anchor, bridge } = match;
        const anchorSource = source
            .slice(anchor.markdownFrom, anchor.markdownTo)
            .trimEnd();
        const continuationSource = source
            .slice(continuation.markdownFrom, continuation.markdownTo)
            .trimStart();
        if (!anchorSource || !continuationSource) continue;

        if (bridge.kind === 'page-headings') {
            const firstHeading = bridge.entries[0];
            const lastHeading = bridge.entries.at(-1);
            const headings = source.slice(
                firstHeading.markdownFrom,
                lastHeading.markdownTo
            ).trim();
            if (!headings) continue;
            edits.push({
                from: anchor.markdownFrom,
                to: continuation.markdownTo,
                replacement: `${headings}\n\n${anchorSource} ${continuationSource}`,
            });
        }
        else {
            const removal = continuationRemovalRange(source, continuation);
            if (!removal) continue;
            edits.push({
                from: anchor.markdownFrom,
                to: anchor.markdownTo,
                replacement: `${anchorSource} ${continuationSource}`,
            }, {
                from: removal.from,
                to: removal.to,
                replacement: '',
            });
        }
        usedAnchors.add(anchor);
    }

    return applyNonOverlappingEdits(source, edits);
}

function findContinuationAnchor(
    source,
    entries,
    continuation,
    continuationPage,
    usedAnchors
) {
    const candidates = [];
    for (const entry of entries) {
        if (entry.type !== 'text'
            || entry.markdownTo > continuation.markdownFrom
            || singlePageIndex(entry) !== continuationPage - 1
            || usedAnchors.has(entry)) {
            continue;
        }
        const bridge = continuationBridge(
            source,
            entries,
            entry,
            continuation,
            continuationPage
        );
        if (!bridge) continue;
        const hasIncompleteAnchor = bridge.kind === 'charts'
            ? endsWithIncompleteText(source, entry)
            : endsWithDanglingWord(source, entry)
                && isBottomOfPage(entry)
                && startsWithLowercaseProse(source, continuation);
        if (hasIncompleteAnchor) {
            candidates.push({ anchor: entry, bridge });
        }
    }
    candidates.sort((left, right) => (
        right.anchor.markdownFrom - left.anchor.markdownFrom
    ));
    return candidates[0] || null;
}

function continuationBridge(
    source,
    entries,
    anchor,
    continuation,
    continuationPage
) {
    const intervening = collectInterveningEntries(
        source,
        entries,
        anchor,
        continuation
    );
    if (!intervening?.length) return null;
    if (intervening.every(entry => (
        entry.type === 'chart'
        && singlePageIndex(entry) === continuationPage - 1
    ))) {
        return { kind: 'charts', entries: intervening };
    }
    if (intervening.length <= 2 && intervening.every(entry => (
        isTopPageHeading(entry, continuation, continuationPage)
    ))) {
        return { kind: 'page-headings', entries: intervening };
    }
    return null;
}

function collectInterveningEntries(source, entries, anchor, continuation) {
    const intervening = [];
    let cursor = anchor.markdownTo;
    for (const entry of entries) {
        if (entry.markdownFrom < anchor.markdownTo) continue;
        if (entry.markdownFrom >= continuation.markdownFrom) break;
        if (entry.markdownTo > continuation.markdownFrom
            || source.slice(cursor, entry.markdownFrom).trim()) {
            return null;
        }
        intervening.push(entry);
        cursor = entry.markdownTo;
    }
    return source.slice(cursor, continuation.markdownFrom).trim()
        ? null
        : intervening;
}

function isTopPageHeading(entry, continuation, continuationPage) {
    if (entry.type !== 'heading'
        || singlePageIndex(entry) !== continuationPage
        || !isTopOfPage(entry)) {
        return false;
    }
    const continuationTop = Math.min(...continuation.locations.map(
        location => location.bbox[1]
    ));
    return entry.locations.every(location => location.bbox[3] <= continuationTop);
}

function startsWithLowercaseProse(source, entry) {
    const text = source.slice(entry.markdownFrom, entry.markdownTo).trimStart();
    return /^\p{Ll}/u.test(text) && !NON_PROSE_BLOCK_START_PATTERN.test(text);
}

function isBottomOfPage(entry) {
    return entry.locations.some(location => location.bbox[3] >= MIN_ANCHOR_BOTTOM);
}

function endsWithDanglingWord(source, entry) {
    const text = source.slice(entry.markdownFrom, entry.markdownTo).trimEnd();
    if (!DANGLING_WORD_END_PATTERN.test(text)) return false;
    const words = text.match(/\p{L}[\p{L}\p{N}'’-]*/gu) || [];
    return words.length >= MIN_ANCHOR_WORDS;
}

function endsWithIncompleteText(source, entry) {
    const text = source.slice(entry.markdownFrom, entry.markdownTo).trimEnd();
    if (!INCOMPLETE_TEXT_END_PATTERN.test(text)) return false;
    const words = text.match(/\p{L}[\p{L}\p{N}'’-]*/gu) || [];
    return words.length >= MIN_ANCHOR_WORDS;
}

function startsLikeContinuation(source, entry) {
    const text = source.slice(entry.markdownFrom, entry.markdownTo).trimStart();
    return Boolean(text) && !NON_PROSE_BLOCK_START_PATTERN.test(text);
}

function isTopOfPage(entry) {
    return entry.locations.every(location => (
        location.bbox[1] <= MAX_CONTINUATION_TOP
    ));
}

function singlePageIndex(entry) {
    const pageIndex = entry.locations[0]?.pageIndex;
    return entry.locations.every(location => location.pageIndex === pageIndex)
        ? pageIndex
        : null;
}

function continuationRemovalRange(source, entry) {
    const preceding = /(?:\r?\n[ \t]*){2}$/.exec(
        source.slice(0, entry.markdownFrom)
    );
    if (!preceding) return null;
    return {
        from: entry.markdownFrom - preceding[0].length,
        to: entry.markdownTo,
    };
}

function applyNonOverlappingEdits(source, edits) {
    const sorted = [...edits].sort((left, right) => right.from - left.from);
    let result = source;
    let lastFrom = source.length + 1;
    for (const edit of sorted) {
        if (edit.to > lastFrom) continue;
        result = result.slice(0, edit.from)
            + edit.replacement
            + result.slice(edit.to);
        lastFrom = edit.from;
    }
    return result;
}
