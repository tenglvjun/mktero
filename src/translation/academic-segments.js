import { GFM, parser as markdownParser } from '@lezer/markdown';
import { findMinerUAlgorithmGroups } from '../markdown/markdown-algorithms.js';
import {
    findAcademicFigures,
    findAcademicTableGroups,
} from '../markdown/markdown-figures.js';
import {
    TRANSLATION_SEGMENTATION_VERSION,
} from './translation-profile.js';
import {
    findDisplayMathMatches,
    findInlineMathMatches,
} from '../markdown/markdown-html.js';

const TRANSLATION_PARSER = markdownParser.configure(GFM);
const HEADING_NODE = /^(?:ATXHeading|SetextHeading)([1-6])$/;
const SKIPPED_SUBTREES = new Set([
    'CodeBlock',
    'FencedCode',
    'HTMLBlock',
    'LinkReference',
    'Table',
]);
const REFERENCE_HEADING_PATTERN = /^(?:references?|bibliograph(?:y|ies)|literature cited|works cited|参考文献|引用文献)$/iu;
const PLACEHOLDER_PATTERN = /⟦MKTERO_(\d+)⟧/gu;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>{}\[\]"']+/giu;
const NUMERIC_CITATION_PATTERN = /\[(?:\s*\d+[a-z]?(?:\s*[-–,;]\s*\d+[a-z]?)*\s*)\]/giu;
const AUTHOR_YEAR_CITATION_PATTERN = /\([^()\r\n]{0,180}\b(?:19|20)\d{2}[a-z]?[^()\r\n]{0,80}\)/giu;
const PANDOC_CITATION_PATTERN = /\[(?:[^\]\r\n]{0,200})@[A-Za-z0-9_:.+-]+(?:[^\]\r\n]{0,200})\]/gu;

export { TRANSLATION_SEGMENTATION_VERSION };

export function extractAcademicTranslationSegments(markdown) {
    const source = String(markdown || '');
    if (!source) return [];
    const figures = findAcademicFigures(source);
    const tables = findAcademicTableGroups(source);
    const captionedFigures = figures.filter(figure => (
        String(figure?.caption?.text || '').trim()
    ));
    const excludedRanges = [
        ...findMinerUAlgorithmGroups(source),
        ...captionedFigures,
        ...tables,
    ];
    const displayMathRanges = findDisplayMathMatches(source).map(match => ({
        from: match.start,
        to: match.end,
    }));
    const segments = [];
    const headingPath = [];
    let referenceLevel = null;
    const appendedFigures = new Set();
    const resolvedFigures = new Set();
    const appendedTables = new Set();

    TRANSLATION_PARSER.parse(source).iterate({
        enter(node) {
            if (SKIPPED_SUBTREES.has(node.name)) return false;
            const headingMatch = HEADING_NODE.exec(node.name);
            if (headingMatch) {
                const level = Number(headingMatch[1]);
                const headingText = cleanHeadingSource(
                    source.slice(node.from, node.to),
                    node.name
                );
                if (referenceLevel !== null && level <= referenceLevel) {
                    referenceLevel = null;
                }
                headingPath.length = level - 1;
                if (REFERENCE_HEADING_PATTERN.test(headingText)) {
                    referenceLevel = level;
                    headingPath[level - 1] = headingText;
                    return false;
                }
                headingPath[level - 1] = headingText;
                const table = overlappingRange(tables, node);
                if (table) {
                    ensureTableCaptionSegment({
                        table,
                        headingPath,
                        segments,
                        appendedTables,
                    });
                    return false;
                }
                if (referenceLevel === null) {
                    appendSegment({
                        source,
                        node,
                        kind: 'heading',
                        headingPath,
                        excludedRanges,
                        displayMathRanges,
                        segments,
                    });
                }
                return false;
            }
            if (node.name === 'Paragraph' && referenceLevel === null) {
                const table = overlappingRange(tables, node);
                if (table) {
                    ensureTableCaptionSegment({
                        table,
                        headingPath,
                        segments,
                        appendedTables,
                    });
                    return false;
                }
                const figure = overlappingRange(figures, node);
                if (figure) {
                    if (!appendedFigures.has(figure)) {
                        appendedFigures.add(figure);
                        const result = appendFigureCaptionSegment({
                            figure,
                            headingPath,
                            segments,
                        });
                        if (result === 'appended' || result === 'skipped') {
                            resolvedFigures.add(figure);
                            return false;
                        }
                    }
                    if (resolvedFigures.has(figure)) {
                        return false;
                    }
                    appendSegment({
                        source,
                        node,
                        kind: paragraphKind(node),
                        headingPath,
                        excludedRanges,
                        displayMathRanges,
                        segments,
                    });
                    return false;
                }
                appendSegment({
                    source,
                    node,
                    kind: paragraphKind(node),
                    headingPath,
                    excludedRanges,
                    displayMathRanges,
                    segments,
                });
                return false;
            }
            return undefined;
        },
    });
    return segments.map((segment, index) => ({
        ...segment,
        id: `segment-${String(index + 1).padStart(6, '0')}`,
        sourceHash: segmentSourceHash(segment.source),
    }));
}

export function protectAcademicTranslationText(source, {
    displayMathRanges = [],
    sourceOffset = 0,
} = {}) {
    const value = String(source || '');
    const removals = displayMathRanges
        .map(range => ({
            from: Math.max(0, range.from - sourceOffset),
            to: Math.min(value.length, range.to - sourceOffset),
            remove: true,
        }))
        .filter(range => range.from < range.to);
    const protectedRanges = [];
    TRANSLATION_PARSER.parse(value).iterate({
        enter(node) {
            if (node.name === 'InlineCode' || node.name === 'URL') {
                protectedRanges.push({ from: node.from, to: node.to });
                return false;
            }
            return undefined;
        },
    });
    for (const match of findInlineMathMatches(value)) {
        protectedRanges.push({ from: match.start, to: match.end });
    }
    appendPatternRanges(protectedRanges, value, URL_PATTERN);
    appendPatternRanges(protectedRanges, value, NUMERIC_CITATION_PATTERN);
    appendPatternRanges(protectedRanges, value, AUTHOR_YEAR_CITATION_PATTERN);
    appendPatternRanges(protectedRanges, value, PANDOC_CITATION_PATTERN);

    const placeholders = [];
    const replacements = mergeProtectedRanges([
        ...removals,
        ...protectedRanges,
    ]).map(range => {
        if (range.remove) return { ...range, replacement: ' ' };
        const token = `⟦MKTERO_${placeholders.length}⟧`;
        placeholders.push({ token, value: value.slice(range.from, range.to) });
        return { ...range, replacement: token };
    });
    let prepared = applyReplacements(value, replacements);
    prepared = cleanMarkdownForTranslation(prepared);
    return { text: prepared, placeholders };
}

export function restoreAcademicTranslationPlaceholders(text, placeholders) {
    PLACEHOLDER_PATTERN.lastIndex = 0;
    let output = String(text || '').trim();
    const expected = new Set(placeholders.map(placeholder => placeholder.token));
    const seen = new Map();
    for (const match of output.matchAll(PLACEHOLDER_PATTERN)) {
        seen.set(match[0], (seen.get(match[0]) || 0) + 1);
        if (!expected.has(match[0])) {
            throw invalidPlaceholderError();
        }
    }
    for (const placeholder of placeholders) {
        if (seen.get(placeholder.token) !== 1) {
            throw invalidPlaceholderError();
        }
        output = output.replace(placeholder.token, placeholder.value);
    }
    const hasUnexpectedPlaceholder = PLACEHOLDER_PATTERN.test(output);
    PLACEHOLDER_PATTERN.lastIndex = 0;
    if (hasUnexpectedPlaceholder) throw invalidPlaceholderError();
    return output;
}

export function splitTranslationSegment(segment, maximumCharacters) {
    const limit = Math.max(1, Math.trunc(Number(maximumCharacters) || 0));
    const text = String(segment?.preparedText || '');
    if (text.length <= limit) {
        return [{
            id: segment.id,
            segmentID: segment.id,
            partIndex: 0,
            partCount: 1,
            kind: segment.kind,
            headingPath: segment.headingPath,
            source: text,
        }];
    }
    const parts = splitAtSafeBoundaries(text, limit);
    return parts.map((part, index) => ({
        id: `${segment.id}::${index + 1}`,
        segmentID: segment.id,
        partIndex: index,
        partCount: parts.length,
        kind: segment.kind,
        headingPath: segment.headingPath,
        source: part,
    }));
}

function appendSegment({
    source,
    node,
    kind,
    headingPath,
    excludedRanges,
    displayMathRanges,
    segments,
}) {
    if (overlapsAny(node, excludedRanges)) return;
    const raw = source.slice(node.from, node.to);
    const protectedText = protectAcademicTranslationText(raw, {
        displayMathRanges: displayMathRanges.filter(range => (
            range.from < node.to && range.to > node.from
        )),
        sourceOffset: node.from,
    });
    if (!hasEnglishTranslationCandidate(protectedText.text)) return;
    segments.push({
        from: node.from,
        to: node.to,
        anchor: node.to,
        kind,
        headingPath: headingPath.filter(Boolean).slice(),
        source: raw,
        preparedText: protectedText.text,
        placeholders: protectedText.placeholders,
    });
}

function appendFigureCaptionSegment({ figure, headingPath, segments }) {
    const raw = String(figure?.caption?.text || '').trim();
    if (!raw) return 'empty';
    const protectedText = protectAcademicTranslationText(raw);
    if (!hasEnglishTranslationCandidate(protectedText.text)) return 'skipped';
    segments.push({
        from: figure.from,
        to: figure.to,
        anchor: figure.to,
        kind: 'figure-caption',
        headingPath: headingPath.filter(Boolean).slice(),
        source: raw,
        preparedText: protectedText.text,
        placeholders: protectedText.placeholders,
    });
    return 'appended';
}

function ensureTableCaptionSegment({
    table,
    headingPath,
    segments,
    appendedTables,
}) {
    if (appendedTables.has(table)) return;
    appendedTables.add(table);
    appendTableCaptionSegment({ table, headingPath, segments });
}

function appendTableCaptionSegment({ table, headingPath, segments }) {
    const raw = String(table?.caption?.text || '').trim();
    if (!raw) return;
    const protectedText = protectAcademicTranslationText(raw);
    if (!hasEnglishTranslationCandidate(protectedText.text)) return;
    segments.push({
        from: table.from,
        to: table.to,
        anchor: table.to,
        kind: 'table-caption',
        headingPath: headingPath.filter(Boolean).slice(),
        source: raw,
        preparedText: protectedText.text,
        placeholders: protectedText.placeholders,
    });
}

function overlappingRange(ranges, node) {
    return ranges.find(candidate => (
        node.from < candidate.to && node.to > candidate.from
    ));
}

function paragraphKind(node) {
    for (let parent = node.node.parent; parent; parent = parent.parent) {
        if (parent.name === 'Blockquote') return 'blockquote';
        if (parent.name === 'ListItem') return 'list-item';
    }
    return 'paragraph';
}

function cleanHeadingSource(value, nodeName) {
    const source = String(value || '');
    if (nodeName.startsWith('ATXHeading')) {
        return source
            .replace(/^ {0,3}#{1,6}[\t ]+/u, '')
            .replace(/[\t ]+#+[\t ]*$/u, '')
            .trim();
    }
    return source.replace(/\r?\n {0,3}(?:=+|-+)[\t ]*$/u, '').trim();
}

function stripHtmlTags(value) {
    let previous;
    let output = String(value || '');
    do {
        previous = output;
        output = output.replace(/<\/?[A-Za-z][^>]*>/gu, '');
    } while (output !== previous);
    return output;
}

function cleanMarkdownForTranslation(value) {
    return stripHtmlTags(
        String(value || '')
            .replace(/^ {0,3}#{1,6}[\t ]+/gmu, '')
            .replace(/[\t ]+#+[\t ]*$/gmu, '')
            .replace(/\r?\n {0,3}(?:=+|-+)[\t ]*$/gmu, '')
            .replace(/^ {0,3}(?:>\s*)+/gmu, '')
            .replace(/^ {0,3}(?:[-+*]|\d+[.)])[\t ]+/gmu, '')
            .replace(/!\[([^\]]*)\]\([^\r\n)]*\)/gu, '$1')
            .replace(/\[([^\]]+)\]\((⟦MKTERO_\d+⟧)\)/gu, '$1 ($2)')
            .replace(/<br\s*\/?>/giu, ' ')
    )
        .replace(/(^|[\s([{])[*_~]{1,3}(?=\S)/gu, '$1')
        .replace(/[*_~]{1,3}(?=$|[\s)\]},.!?:;])/gu, '')
        .replace(/\\([\\`*_[\]{}()#+.!<>~-])/gu, '$1')
        .replace(/[\t ]+/gu, ' ')
        .replace(/\s*\r?\n\s*/gu, ' ')
        .trim();
}

function hasEnglishTranslationCandidate(value) {
    const source = String(value || '');
    const latin = source.match(/[A-Za-z]/gu)?.length || 0;
    const cjk = source.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu)
        ?.length || 0;
    return latin >= 3 && latin >= cjk;
}

function appendPatternRanges(output, source, pattern) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
        output.push({ from: match.index, to: match.index + match[0].length });
    }
    pattern.lastIndex = 0;
}

function mergeProtectedRanges(ranges) {
    const sorted = ranges
        .filter(range => Number.isSafeInteger(range.from)
            && Number.isSafeInteger(range.to)
            && range.from >= 0
            && range.to > range.from)
        .sort((left, right) => (
            left.from - right.from
            || Number(Boolean(right.remove)) - Number(Boolean(left.remove))
            || right.to - left.to
        ));
    const output = [];
    for (const range of sorted) {
        const previous = output.at(-1);
        if (!previous || range.from >= previous.to) {
            output.push({ ...range });
            continue;
        }
        if (range.remove && !previous.remove) {
            previous.remove = true;
        }
        previous.to = Math.max(previous.to, range.to);
    }
    return output;
}

function applyReplacements(source, replacements) {
    let output = '';
    let offset = 0;
    for (const replacement of replacements) {
        output += source.slice(offset, replacement.from);
        output += replacement.replacement;
        offset = replacement.to;
    }
    return output + source.slice(offset);
}

function overlapsAny(node, ranges) {
    return ranges.some(range => node.from < range.to && node.to > range.from);
}

function segmentSourceHash(source) {
    let hash = 0x811c9dc5;
    for (const character of String(source || '')) {
        hash ^= character.codePointAt(0);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function splitAtSafeBoundaries(text, limit) {
    const parts = [];
    let offset = 0;
    while (offset < text.length) {
        let end = Math.min(text.length, offset + limit);
        if (end < text.length) {
            end = safeBoundary(text, offset, end, limit);
        }
        const part = text.slice(offset, end).trim();
        if (part) parts.push(part);
        offset = end;
        while (/\s/u.test(text[offset] || '')) offset++;
    }
    return parts;
}

function safeBoundary(text, start, proposedEnd, limit) {
    let end = proposedEnd;
    const opening = text.lastIndexOf('⟦', end);
    const closing = text.lastIndexOf('⟧', end);
    if (opening > closing) {
        const tokenEnd = text.indexOf('⟧', end);
        end = opening > start ? opening : tokenEnd >= 0 ? tokenEnd + 1 : end;
    }
    const minimum = start + Math.floor(limit * 0.4);
    const candidate = text.slice(start, end);
    let boundary = -1;
    for (const match of candidate.matchAll(/[.!?。！？](?:["')\]]*)\s+/gu)) {
        const position = start + match.index + match[0].length;
        if (position >= minimum) boundary = position;
    }
    if (boundary < minimum) {
        const whitespace = candidate.lastIndexOf(' ');
        if (start + whitespace >= minimum) boundary = start + whitespace + 1;
    }
    return boundary >= minimum ? boundary : Math.max(start + 1, end);
}

function invalidPlaceholderError() {
    const error = new Error('The translation changed a protected placeholder');
    error.code = 'TRANSLATION_PLACEHOLDER_INVALID';
    return error;
}
