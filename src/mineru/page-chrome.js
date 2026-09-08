import {
    absorbBlankLines,
    normalizeChromeRanges,
} from '../markdown/chrome-ranges.js';

const CANDIDATE_TYPES = new Set(['text', 'header', 'footer']);
const PAGE_NUMBER_PATTERN = /^(?:page\s+)?\d+\s+of\s+\d+$/iu;
const WHOLE_LINE_PAGE_NUMBER_PATTERN = /^\d{1,4}$/u;
const REFERENCE_HEADING_PATTERN = /^ {0,3}#{1,6}[ \t]+(?:references|bibliography|works[ \t]+cited|literature[ \t]+cited)\b/iu;
const PLAIN_REFERENCE_HEADING_PATTERN = /^(?:\*{1,2}|_{1,2})?(?:references?|bibliography|works[ \t]+cited|literature[ \t]+cited|参考文献|参考资料|参考书目)(?:\*{1,2}|_{1,2})?[ \t]*[:：]?[ \t]*#*[ \t]*$/iu;

export function detectMinerUPageChrome(markdown, contentList, sourceMap) {
    if (typeof markdown !== 'string' || !Array.isArray(contentList)) {
        return { chromeRanges: [], sourceMap };
    }

    const candidates = collectChromeCandidates(contentList);
    const lineOccurrences = collectLineOccurrences(markdown);
    const referenceStart = findReferenceHeadingOffset(markdown);
    const ranges = [];
    const mappedEntries = new Set();

    for (const [text, blocks] of groupCandidatesByText(candidates)) {
        const resolved = resolveCandidateRanges(
            blocks,
            sourceMap,
            lineOccurrences.get(text) || []
        );
        for (const item of resolved) {
            if (isAfterReferences(item.range, referenceStart)) continue;
            ranges.push(item.range);
            if (item.entry) mappedEntries.add(item.entry);
        }
    }

    const chromeRanges = normalizeChromeRanges(
        absorbBlankLines(markdown, ranges),
        markdown.length
    );
    const filteredSourceMap = Array.isArray(sourceMap)
        ? sourceMap.filter(entry => (
            !mappedEntries.has(entry) && !isCoveredByChrome(entry, chromeRanges)
        ))
        : sourceMap;
    return { chromeRanges, sourceMap: filteredSourceMap };
}

function collectChromeCandidates(contentList) {
    const pagesByText = new Map();
    const edgeBlocks = [];
    for (const block of contentList) {
        try {
            if (!isTextLikeBlock(block)) continue;
            const text = comparableMarkdownText(block.text);
            if (!text) continue;
            if (Number.isSafeInteger(block.pageIndex) && block.pageIndex >= 0) {
                const pages = pagesByText.get(text) || new Set();
                pages.add(block.pageIndex);
                pagesByText.set(text, pages);
            }
            if (!isPageEdgeBBox(block.bbox)) continue;
            edgeBlocks.push(block);
        }
        catch {
            continue;
        }
    }
    return edgeBlocks.filter(block => {
        try {
            const text = comparableMarkdownText(block.text);
            return isPageNumberText(text) || (pagesByText.get(text)?.size >= 2);
        }
        catch {
            return false;
        }
    });
}

function isTextLikeBlock(block) {
    return Boolean(block)
        && typeof block === 'object'
        && !Array.isArray(block)
        && CANDIDATE_TYPES.has(block.type)
        && typeof block.text === 'string'
        && block.text.trim();
}

function isPageEdgeBBox(bbox) {
    return Array.isArray(bbox)
        && bbox.length === 4
        && Number.isFinite(bbox[1])
        && Number.isFinite(bbox[3])
        && (bbox[1] <= 180 || bbox[3] >= 820);
}

function isPageNumberText(text) {
    return PAGE_NUMBER_PATTERN.test(text) || WHOLE_LINE_PAGE_NUMBER_PATTERN.test(text);
}

function groupCandidatesByText(candidates) {
    const groups = new Map();
    for (const block of candidates) {
        const text = comparableMarkdownText(block.text);
        const blocks = groups.get(text) || [];
        blocks.push(block);
        groups.set(text, blocks);
    }
    return groups;
}

function resolveCandidateRanges(blocks, sourceMap, lines) {
    const unique = blocks.map(block => {
        const entry = findUniqueSourceMapEntry(sourceMap, block);
        const range = entry ? rangeFromSourceMapEntry(entry, block) : null;
        return { block, entry, range };
    });
    if (unique.every(item => item.range)) {
        return unique.map(item => ({ range: item.range, entry: item.entry }));
    }
    if (lines.length !== blocks.length) {
        return unique
            .filter(item => item.range)
            .map(item => ({ range: item.range, entry: item.entry }));
    }
    return blocks.map((block, index) => ({
        range: { from: lines[index].from, to: lines[index].to },
        entry: unique[index].entry,
    }));
}

function findUniqueSourceMapEntry(sourceMap, block) {
    if (!Array.isArray(sourceMap)) return null;
    const matches = [];
    for (const entry of sourceMap) {
        if (entryMatchesBlock(entry, block)) matches.push(entry);
        if (matches.length > 1) return null;
    }
    return matches[0] || null;
}

function entryMatchesBlock(entry, block) {
    if (!entry || typeof entry !== 'object') return false;
    const locations = Array.isArray(entry.locations) ? entry.locations : [];
    if (locations.some(location => sameLocation(location, block))) return true;
    const locationRanges = Array.isArray(entry.locationRanges)
        ? entry.locationRanges
        : [];
    return locationRanges.some(range => sameLocation(range.location, block));
}

function rangeFromSourceMapEntry(entry, block) {
    const locationRanges = Array.isArray(entry.locationRanges)
        ? entry.locationRanges.filter(range => sameLocation(range.location, block))
        : [];
    if (locationRanges.length === 1) {
        return halfOpenRange(locationRanges[0].markdownFrom, locationRanges[0].markdownTo);
    }
    if (locationRanges.length > 1) return null;
    return halfOpenRange(entry.markdownFrom, entry.markdownTo);
}

function halfOpenRange(from, to) {
    if (!Number.isSafeInteger(from)
        || !Number.isSafeInteger(to)
        || from < 0
        || from >= to) {
        return null;
    }
    return { from, to };
}

function sameLocation(location, block) {
    return Boolean(location)
        && location.pageIndex === block.pageIndex
        && Array.isArray(location.bbox)
        && Array.isArray(block.bbox)
        && location.bbox.length === 4
        && block.bbox.length === 4
        && location.bbox.every((value, index) => value === block.bbox[index]);
}

function collectLineOccurrences(markdown) {
    const lines = markdown.match(/[^\r\n]*(?:\r\n|\n|$)/g) || [];
    const occurrences = new Map();
    let offset = 0;
    for (const line of lines) {
        const from = offset;
        const to = offset + line.replace(/\r?\n$/, '').length;
        offset += line.length;
        const text = comparableMarkdownText(line);
        if (!text || from >= to) continue;
        const list = occurrences.get(text) || [];
        list.push({ from, to });
        occurrences.set(text, list);
    }
    return occurrences;
}

function findReferenceHeadingOffset(markdown) {
    const lines = markdown.match(/[^\r\n]*(?:\r\n|\n|$)/g) || [];
    let offset = 0;
    for (const line of lines) {
        const heading = comparableMarkdownText(line) || line.trim();
        if (REFERENCE_HEADING_PATTERN.test(line)
            || PLAIN_REFERENCE_HEADING_PATTERN.test(heading)) {
            return offset;
        }
        offset += line.length;
    }
    return -1;
}

function isAfterReferences(range, referenceStart) {
    return referenceStart >= 0 && range.from >= referenceStart;
}

function isCoveredByChrome(entry, chromeRanges) {
    if (!Number.isSafeInteger(entry?.markdownFrom)
        || !Number.isSafeInteger(entry?.markdownTo)
        || entry.markdownFrom >= entry.markdownTo) {
        return false;
    }
    return chromeRanges.some(range => (
        range.from <= entry.markdownFrom && range.to >= entry.markdownTo
    ));
}

function comparableMarkdownText(value) {
    let text = String(value || '').replace(/\r?\n$/, '').trim();
    if (!text || /^!\[/u.test(text) || /^<!--/u.test(text)) return '';
    text = text
        .replace(/^ {0,3}#{1,6}[ \t]+/u, '')
        .replace(/^ {0,3}(?:[-+*]|\d+[.)])[ \t]+/u, '')
        .replace(/^ {0,3}>[ \t]?/u, '')
        .replace(/\[([^\]\r\n]+)\]\([^)]*\)/gu, '$1')
        .replace(/[*_~`]/gu, '');
    return text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}
