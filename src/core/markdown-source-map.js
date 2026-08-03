import { GFM, parser } from '@lezer/markdown';
import { createVisibleMarkdownTextIndex } from '../markdown/markdown-visible-text.js';
import {
    createNormalizedTextIndex,
    findTextOccurrences,
    normalizeText,
} from '../markdown/text-normalization.js';
import { findDisplayMathMatches } from '../markdown/markdown-html.js';

const MARKDOWN_PARSER = parser.configure(GFM);
const MIN_TEXT_MATCH_LENGTH = 12;
const MATCH_BUDGET_EXHAUSTED = Symbol('match-budget-exhausted');
export const DEFAULT_MAX_SOURCE_MAP_MARKDOWN_LENGTH = 4 * 1024 * 1024;
export const DEFAULT_MAX_SOURCE_MAP_BLOCKS = 20_000;
export const DEFAULT_MAX_SOURCE_MAP_MATCH_WORK = 256 * 1024 * 1024;

export function createMarkdownSourceMap(markdown, contentList, {
    maxMarkdownLength = DEFAULT_MAX_SOURCE_MAP_MARKDOWN_LENGTH,
    maxContentBlocks = DEFAULT_MAX_SOURCE_MAP_BLOCKS,
    maxMatchWork = DEFAULT_MAX_SOURCE_MAP_MATCH_WORK,
} = {}) {
    if (typeof markdown !== 'string' || !Array.isArray(contentList)) return [];
    if (markdown.length > normalizedLimit(maxMarkdownLength)) return [];
    const blockLimit = normalizedLimit(maxContentBlocks);
    const matchWorkLimit = normalizedLimit(maxMatchWork);
    if (!contentList.length || !blockLimit || !matchWorkLimit) return [];

    const syntaxRanges = collectSyntaxRanges(markdown);
    const visible = createVisibleMarkdownTextIndex(markdown);
    const visibleIndex = createNormalizedTextIndex(
        visible.text,
        visible.sourceOffsetAt
    );
    let tolerantBlockTexts;
    const getTolerantBlockTexts = () => {
        if (!tolerantBlockTexts) {
            tolerantBlockTexts = syntaxRanges.blocks.map(range => (
                normalizeTolerantText(
                    visible.textForSourceRange(range.from, range.to)
                )
            ));
        }
        return tolerantBlockTexts;
    };
    const entries = new Map();
    const matchBudget = { remaining: matchWorkLimit };

    for (let index = 0; index < contentList.length && index < blockLimit; index++) {
        const contentBlock = contentList[index];
        if (!validContentLocation(contentBlock)) continue;
        const matchedRange = matchContentBlock(
            contentBlock,
            markdown,
            visibleIndex,
            getTolerantBlockTexts,
            syntaxRanges,
            matchBudget
        );
        if (matchedRange === MATCH_BUDGET_EXHAUSTED) break;
        if (!matchedRange) continue;
        const markdownRange = findContainingRange(
            syntaxRanges.blocks,
            matchedRange
        );
        if (!markdownRange) continue;

        const key = `${markdownRange.from}:${markdownRange.to}`;
        let entry = entries.get(key);
        if (!entry) {
            entry = {
                type: contentBlock.type,
                markdownFrom: markdownRange.from,
                markdownTo: markdownRange.to,
                locations: [],
            };
            entries.set(key, entry);
        }
        appendUniqueLocation(entry.locations, contentBlock);
    }

    return [...entries.values()]
        .filter(entry => entry.locations.length)
        .sort((left, right) => left.markdownFrom - right.markdownFrom);
}

function collectSyntaxRanges(markdown) {
    const tree = MARKDOWN_PARSER.parse(markdown);
    const ranges = {
        blocks: [],
        code: [],
        equation: [],
        image: [],
        table: [],
    };
    const htmlRanges = [];
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
        if (node.to > node.from) ranges.blocks.push(nodeRange(node));
    }
    tree.iterate({
        enter(node) {
            if (node.name === 'Image') ranges.image.push(nodeRange(node));
            if (node.name === 'Table') ranges.table.push(nodeRange(node));
            if (node.name === 'HTMLBlock') {
                const range = nodeRange(node);
                htmlRanges.push(range);
                if (isRawHTMLTable(markdown.slice(range.from, range.to))) {
                    ranges.table.push(range);
                }
            }
            if (['FencedCode', 'CodeBlock'].includes(node.name)) {
                ranges.code.push(nodeRange(node));
            }
        },
    });
    const excludedEquationRanges = [...ranges.code, ...htmlRanges]
        .sort((left, right) => left.from - right.from);
    ranges.equation = findDisplayMathMatches(markdown)
        .map(match => ({ from: match.start, to: match.end }))
        .filter(range => !overlapsAnyRange(range, excludedEquationRanges))
        .slice(0, DEFAULT_MAX_SOURCE_MAP_BLOCKS);
    return ranges;
}

function isRawHTMLTable(source) {
    return /^\s*<table(?:\s|>)[\s\S]*<\/table>\s*$/i.test(source);
}

function overlapsAnyRange(target, ranges) {
    return ranges.some(range => target.from < range.to && target.to > range.from);
}

function matchContentBlock(
    contentBlock,
    markdown,
    visibleIndex,
    getTolerantBlockTexts,
    syntaxRanges,
    matchBudget
) {
    if ((contentBlock.type === 'image' || contentBlock.type === 'chart')
        && typeof contentBlock.assetPath === 'string'
        && contentBlock.assetPath) {
        if (!consumeMatchWork(matchBudget, markdown.length)) {
            return MATCH_BUDGET_EXHAUSTED;
        }
        const occurrences = findTextOccurrences(markdown, contentBlock.assetPath, 2);
        if (occurrences.offsets.length !== 1 || occurrences.truncated) return null;
        const matchedRange = {
            from: occurrences.offsets[0],
            to: occurrences.offsets[0] + contentBlock.assetPath.length,
        };
        return compatibleSyntaxRange(contentBlock.type, matchedRange, syntaxRanges)
            ? matchedRange
            : null;
    }

    if (typeof contentBlock.text !== 'string') return null;
    const target = normalizeText(contentBlock.text);
    if ([...target].length < MIN_TEXT_MATCH_LENGTH) return null;
    if (!consumeMatchWork(matchBudget, visibleIndex.text.length)) {
        return MATCH_BUDGET_EXHAUSTED;
    }
    const occurrences = findTextOccurrences(visibleIndex.text, target, 2);
    let matchedRange;
    if (occurrences.offsets.length === 1 && !occurrences.truncated) {
        matchedRange = visibleIndex.sourceRange(
            occurrences.offsets[0],
            target.length
        );
    }
    else if (occurrences.offsets.length || occurrences.truncated) {
        return null;
    }
    else {
        if (!consumeMatchWork(matchBudget, visibleIndex.text.length)) {
            return MATCH_BUDGET_EXHAUSTED;
        }
        const tolerantTarget = normalizeTolerantText(contentBlock.text);
        if ([...tolerantTarget].length < MIN_TEXT_MATCH_LENGTH) return null;
        matchedRange = findTolerantBlockMatch(
            syntaxRanges.blocks,
            getTolerantBlockTexts(),
            tolerantTarget
        );
        if (!matchedRange) return null;
    }
    return compatibleSyntaxRange(contentBlock.type, matchedRange, syntaxRanges)
        ? matchedRange
        : null;
}

function normalizeTolerantText(value) {
    return String(value)
        .normalize('NFKC')
        .replace(/[\u2018\u2019]/gu, '\'')
        .replace(/[\u201c\u201d]/gu, '"')
        .replace(/\\chi(?![\p{L}\p{N}])/gu, '\u03c7')
        .replace(/\\([%$#&_{}])/gu, '$1')
        .replace(/[$}{]/gu, '')
        .replace(/\^(?=[\p{L}\p{N}])/gu, '')
        .replace(/(\p{L}{2})[-\u2010\u2011](?=\p{L}{2})/gu, '$1')
        .replace(/[\u2010-\u2014\u2212]/gu, '-')
        .replace(/\s+([,.;:!?%)\]])/gu, '$1')
        .replace(/\s+/gu, ' ')
        .trim();
}

function findTolerantBlockMatch(blocks, blockTexts, target) {
    let matchedRange = null;
    for (let index = 0; index < blocks.length; index++) {
        const occurrences = findTextOccurrences(blockTexts[index], target, 2);
        if (occurrences.truncated || occurrences.offsets.length > 1) return null;
        if (!occurrences.offsets.length) continue;
        if (matchedRange) return null;
        matchedRange = blocks[index];
    }
    return matchedRange;
}

function compatibleSyntaxRange(type, matchedRange, syntaxRanges) {
    const syntaxType = type === 'chart' ? 'image' : type;
    if (!['code', 'equation', 'image', 'table'].includes(syntaxType)) return true;
    return Boolean(findContainingRange(syntaxRanges[syntaxType], matchedRange));
}

function findContainingRange(ranges, target) {
    let low = 0;
    let high = ranges.length - 1;
    while (low <= high) {
        const middle = (low + high) >> 1;
        const range = ranges[middle];
        if (target.from < range.from) high = middle - 1;
        else if (target.from >= range.to) low = middle + 1;
        else return target.to <= range.to ? range : null;
    }
    return null;
}

function nodeRange(node) {
    return { from: node.from, to: node.to };
}

function consumeMatchWork(budget, amount) {
    if (amount > budget.remaining) return false;
    budget.remaining -= amount;
    return true;
}

function normalizedLimit(value) {
    if (!Number.isFinite(value)) return Number.MAX_SAFE_INTEGER;
    return Math.max(0, Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER));
}

function validContentLocation(contentBlock) {
    return isValidSourceLocation(contentBlock);
}

export function isValidSourceLocation(value) {
    return Number.isSafeInteger(value?.pageIndex)
        && value.pageIndex >= 0
        && isValidNormalizedSourceBBox(value.bbox);
}

export function isValidSourceMapEntry(value, documentLength = Infinity) {
    return Number.isSafeInteger(value?.markdownFrom)
        && Number.isSafeInteger(value?.markdownTo)
        && value.markdownFrom >= 0
        && value.markdownTo > value.markdownFrom
        && value.markdownTo <= documentLength
        && Array.isArray(value.locations)
        && value.locations.length > 0
        && value.locations.every(isValidSourceLocation);
}

export function resolvePDFPageIndexHint(
    sourceMap,
    range,
    documentLength = Infinity
) {
    const match = findUniqueContainingSourceMapEntry(
        sourceMap,
        range,
        documentLength
    );
    if (!match) return null;
    const pageIndex = match.locations[0].pageIndex;
    return match.locations.every(location => location.pageIndex === pageIndex)
        ? pageIndex
        : null;
}

export function findUniqueContainingSourceMapEntry(
    sourceMap,
    range,
    documentLength = Infinity
) {
    if (!Array.isArray(sourceMap)
        || !Number.isSafeInteger(range?.from)
        || !Number.isSafeInteger(range?.to)
        || range.from < 0
        || range.to <= range.from
        || range.to > documentLength) {
        return null;
    }
    let match = null;
    for (const entry of sourceMap) {
        if (!isValidSourceMapEntry(entry, documentLength)
            || entry.markdownFrom > range.from
            || entry.markdownTo < range.to) {
            continue;
        }
        if (match) return null;
        match = entry;
    }
    return match;
}

export function isValidNormalizedSourceBBox(value) {
    return Array.isArray(value)
        && value.length === 4
        && value.every(coordinate => Number.isFinite(coordinate)
            && coordinate >= 0
            && coordinate <= 1000)
        && value[0] < value[2]
        && value[1] < value[3];
}

function appendUniqueLocation(locations, contentBlock) {
    const location = {
        pageIndex: contentBlock.pageIndex,
        bbox: [...contentBlock.bbox],
    };
    if (!locations.some(existing => (
        existing.pageIndex === location.pageIndex
        && existing.bbox.every((value, index) => value === location.bbox[index])
    ))) {
        locations.push(location);
    }
}
