import { createVisibleMarkdownTextIndex } from './markdown-visible-text.js';

export const MAX_DOCUMENT_SEARCH_MATCHES = 10_000;

export function searchMarkdownDocument(markdown, query, options = {}) {
    const source = String(markdown || '');
    const needle = String(query ?? '');
    if (!needle) {
        return { matches: [], truncated: false };
    }

    const maxMatches = normalizeMaxMatches(options.maxMatches);
    const index = createVisibleMarkdownTextIndex(
        source,
        options.chromeRanges
    );
    const visibleMatches = findVisibleMatches(
        index.text,
        needle,
        Boolean(options.caseSensitive),
        maxMatches
    );
    return {
        matches: visibleMatches.matches.map(match => (
            index.sourceRange(match.from, match.length)
        )),
        truncated: visibleMatches.truncated,
    };
}

function findVisibleMatches(haystack, needle, caseSensitive, maxMatches) {
    const matches = [];
    if (caseSensitive) {
        let from = 0;
        while (from <= haystack.length) {
            const found = haystack.indexOf(needle, from);
            if (found < 0) break;
            if (matches.length >= maxMatches) {
                return { matches, truncated: true };
            }
            matches.push({ from: found, length: needle.length });
            from = found + needle.length;
        }
        return { matches, truncated: false };
    }

    const pattern = new RegExp(escapeRegExp(needle), 'giu');
    let match = pattern.exec(haystack);
    while (match) {
        if (matches.length >= maxMatches) {
            return { matches, truncated: true };
        }
        const length = match[0].length || 1;
        matches.push({
            from: match.index,
            length,
        });
        if (match[0].length === 0) {
            pattern.lastIndex += 1;
        }
        match = pattern.exec(haystack);
    }
    return { matches, truncated: false };
}

function normalizeMaxMatches(value) {
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric) || numeric <= 0) {
        return MAX_DOCUMENT_SEARCH_MATCHES;
    }
    return Math.min(numeric, MAX_DOCUMENT_SEARCH_MATCHES);
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
