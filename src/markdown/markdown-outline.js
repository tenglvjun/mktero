import { GFM, parser as markdownParser } from '@lezer/markdown';
import { normalizeChromeRanges } from './chrome-ranges.js';

const OUTLINE_PARSER = markdownParser.configure(GFM);
const HEADING_NODE = /^(?:ATXHeading|SetextHeading)([1-6])$/;

const MAX_PDF_OUTLINE_ENTRIES = 500;
const MIN_PDF_OUTLINE_MATCHES = 3;
const SECTION_NUMBER_PREFIX_PATTERN =
    /^(?:\d{1,2}(?:\.\d+)*\.?\s+|[ivxlcdm]{1,6}\.\s+|[a-z]\.\s+)/i;

export function extractMarkdownOutline(markdown, chromeRanges = []) {
    const source = String(markdown || '');
    const hidden = normalizeChromeRanges(chromeRanges, source.length);
    const headings = [];
    OUTLINE_PARSER.parse(source).iterate({
        enter(node) {
            const match = HEADING_NODE.exec(node.name);
            if (!match) return;
            if (hidden.some(range => (
                range.from <= node.from && node.from < range.to
            ))) {
                return;
            }
            const text = visibleHeadingText(
                source.slice(node.from, node.to),
                node.name
            );
            if (!text) return;
            headings.push({
                level: Number(match[1]),
                text,
                offset: node.from,
            });
        },
    });
    return assignOutlineLevels(
        omitNonSectionHeadings(source, headings),
        source
    );
}

export function extractAlignedMarkdownOutline(
    markdown,
    chromeRanges = [],
    pdfOutline = []
) {
    const headings = extractMarkdownOutline(markdown, chromeRanges);
    const bookmarks = flattenPdfOutline(pdfOutline);
    if (!bookmarks.length) return headings;

    const used = new Set();
    const matched = [];
    for (const bookmark of bookmarks) {
        const key = outlineMatchKey(bookmark.title);
        if (!key) continue;
        const indexes = [];
        for (const [index, heading] of headings.entries()) {
            if (used.has(index)) continue;
            if (outlineMatchKey(heading.text) === key) indexes.push(index);
        }
        if (indexes.length !== 1) continue;
        const index = indexes[0];
        used.add(index);
        matched.push({
            ...headings[index],
            level: bookmark.level,
        });
    }

    if (matched.length < MIN_PDF_OUTLINE_MATCHES
        || matched.length * 2 < bookmarks.length) {
        return headings;
    }
    return matched;
}

function flattenPdfOutline(nodes, level = 1, output = []) {
    if (!Array.isArray(nodes) || output.length >= MAX_PDF_OUTLINE_ENTRIES) {
        return output;
    }
    for (const node of nodes) {
        if (output.length >= MAX_PDF_OUTLINE_ENTRIES) break;
        const title = String(node?.title || '').trim();
        if (title) {
            output.push({
                title,
                level: clampOutlineLevel(level),
            });
        }
        if (Array.isArray(node?.items) && node.items.length) {
            flattenPdfOutline(
                node.items,
                title ? level + 1 : level,
                output
            );
        }
    }
    return output;
}

function outlineMatchKey(text) {
    return markdownHeadingKey(
        String(text || '').trim().replace(SECTION_NUMBER_PREFIX_PATTERN, '')
    );
}

const KEYWORD_HEADING_PATTERN = /^(keywords?|关键词|highlights?)\s*:?\s*$/i;
const LIST_ITEM_PATTERN = /^\s*(?:[-*]|[0-9]+\.)\s+/;
const SENTENCE_END_PATTERN = /[.!?。！？]\s*$/;
const LOWERCASE_PROSE_PATTERN = /^\p{Ll}/u;

function omitNonSectionHeadings(markdown, headings) {
    return headings.filter((heading, index) => {
        const next = headings[index + 1];
        const body = markdown.slice(
            headingExclusiveEnd(markdown, heading.offset),
            next ? next.offset : markdown.length
        );
        if (isKeywordListHeading(heading.text, body)) return false;
        if (isListBoxHeading(markdown, heading.offset, body)) return false;
        return true;
    });
}

function isKeywordListHeading(text, body) {
    if (!KEYWORD_HEADING_PATTERN.test(String(text).trim())) return false;
    const paragraphs = String(body)
        .split(/\n\s*\n/)
        .map(part => part.trim())
        .filter(Boolean);
    if (paragraphs.length >= 2) return false;
    return paragraphs.length === 0 || isShortCommaOrSpaceList(paragraphs[0]);
}

function isShortCommaOrSpaceList(text) {
    const trimmed = String(text).trim();
    if (!trimmed) return true;
    if (/[.!?。！？]/.test(trimmed)) return false;
    if (LIST_ITEM_PATTERN.test(trimmed)) return false;
    return true;
}

function isListBoxHeading(markdown, offset, body) {
    const lines = String(body).split('\n');
    let index = 0;
    while (index < lines.length && !lines[index].trim()) index++;
    const items = [];
    while (index < lines.length) {
        const line = lines[index];
        if (!line.trim()) {
            let peek = index + 1;
            while (peek < lines.length && !lines[peek].trim()) peek++;
            if (peek < lines.length && LIST_ITEM_PATTERN.test(lines[peek])) {
                index = peek;
                continue;
            }
            break;
        }
        if (!LIST_ITEM_PATTERN.test(line)) break;
        items.push(line);
        index++;
        if (items.length > 6) return false;
    }
    if (items.length < 1 || items.length > 6) return false;

    const preceding = precedingNonBlankLine(markdown, offset).trim();
    if (!SENTENCE_END_PATTERN.test(preceding)) return true;
    while (index < lines.length && !lines[index].trim()) index++;
    const nextProse = index < lines.length ? lines[index].trim() : '';
    return LOWERCASE_PROSE_PATTERN.test(nextProse);
}

function precedingNonBlankLine(markdown, offset) {
    const lines = markdown.slice(0, offset).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim()) return lines[i];
    }
    return '';
}

function headingExclusiveEnd(markdown, offset) {
    const newline = markdown.indexOf('\n', offset);
    if (newline < 0) return markdown.length;
    let end = newline + 1;
    const nextNewline = markdown.indexOf('\n', end);
    const nextLine = nextNewline < 0
        ? markdown.slice(end)
        : markdown.slice(end, nextNewline);
    if (/^ {0,3}(?:=+|-+)[ \t]*$/.test(nextLine)) {
        return nextNewline < 0 ? markdown.length : nextNewline + 1;
    }
    return end;
}

const NUMBERED_HEADING_PATTERN = /^(\d+(?:\.\d+)*)(?:\.|\s|$)/;
const LETTER_HEADING_PATTERN = /^([A-Z](?:\.\d+)*)\.(?:\s|$)/;
const LETTER_SUBHEADING_PATTERN = /^([A-Z]\.\d+(?:\.\d+)*)(?:\s|$)/;
const ROMAN_HEADING_PATTERN = /^(I|II|III|IV|V|VI|VII|VIII|IX|X|XI|XII|XIII|XIV|XV|XVI|XVII|XVIII|XIX|XX)\.(?:\s|$)/i;

function assignOutlineLevels(headings, markdown) {
    if (headings.length < 2) return headings;
    const scheme = outlineNumberingScheme(headings.map(heading => heading.text));
    const numbered = headings.some(heading => (
        numberedHeadingDepth(heading.text, scheme) > 0
    ));
    if (numbered) {
        return headings.map(heading => {
            const depth = numberedHeadingDepth(heading.text, scheme);
            return {
                ...heading,
                level: depth || 1,
            };
        });
    }
    return promoteLongSectionSiblings(markdown, headings);
}

function promoteLongSectionSiblings(markdown, headings) {
    const next = headings.map(heading => ({ ...heading }));
    for (let index = 1; index < next.length; index++) {
        const previous = next[index - 1];
        const current = next[index];
        if (current.level <= previous.level) continue;
        if (!sectionBodyIsLong(markdown, previous.offset, current.offset)) {
            continue;
        }
        current.level = previous.level;
    }
    return next;
}

function sectionBodyIsLong(markdown, previousOffset, currentOffset) {
    const body = markdown.slice(
        headingExclusiveEnd(markdown, previousOffset),
        currentOffset
    );
    const paragraphs = body.split(/\n\s*\n/)
        .map(part => part.trim())
        .filter(Boolean);
    if (paragraphs.length >= 2) return true;
    return body.replace(/\s+/g, '').length > 400;
}

function outlineNumberingScheme(texts) {
    return texts.some(text => ROMAN_HEADING_PATTERN.test(String(text).trim()))
        ? 'ieee'
        : 'standard';
}

function numberedHeadingDepth(text, scheme = 'standard') {
    const trimmed = String(text).trim();
    if (ROMAN_HEADING_PATTERN.test(trimmed)) return 1;
    if (scheme === 'ieee') {
        const letter = LETTER_SUBHEADING_PATTERN.exec(trimmed)
            || LETTER_HEADING_PATTERN.exec(trimmed);
        if (!letter) return 0;
        return clampOutlineLevel(1 + letter[1].split('.').length);
    }
    const match = LETTER_HEADING_PATTERN.exec(trimmed)
        || LETTER_SUBHEADING_PATTERN.exec(trimmed)
        || NUMBERED_HEADING_PATTERN.exec(trimmed);
    if (!match) return 0;
    return clampOutlineLevel(match[1].split('.').length);
}

function clampOutlineLevel(depth) {
    return Math.min(6, Math.max(1, depth));
}

export function createMarkdownFragmentIndex(markdown) {
    const fragments = new Map();
    const usedIDs = new Set();
    for (const [index, heading] of extractMarkdownOutline(markdown).entries()) {
        const fragment = createMarkdownFragmentID(
            heading.text,
            index,
            usedIDs
        );
        fragments.set(fragment, heading.offset);
    }
    return fragments;
}

export function createMarkdownFragmentID(text, index, usedIDs = new Set()) {
    const base = createMarkdownFragmentSlug(text) || `heading-${index}`;
    let id = base;
    let suffix = 0;
    while (usedIDs.has(id)) {
        suffix++;
        id = `${base}-${suffix}`;
    }
    usedIDs.add(id);
    return id;
}

export function createMarkdownReadingPositionAnchor(markdown, offset) {
    const source = String(markdown || '');
    const requestedOffset = clampMarkdownOffset(offset, source.length);
    const headings = extractMarkdownOutline(source);
    let headingIndex = -1;
    for (let index = 0; index < headings.length; index++) {
        if (headings[index].offset > requestedOffset) break;
        headingIndex = index;
    }
    if (headingIndex < 0) return { offset: requestedOffset };

    const heading = headings[headingIndex];
    const headingKey = markdownHeadingKey(heading.text);
    return {
        offset: requestedOffset,
        headingKey,
        headingOccurrence: headings
            .slice(0, headingIndex + 1)
            .filter(candidate => (
                markdownHeadingKey(candidate.text) === headingKey
            )).length - 1,
        relativeOffset: requestedOffset - heading.offset,
    };
}

export function resolveMarkdownReadingPosition(markdown, anchor) {
    const source = String(markdown || '');
    const fallback = clampMarkdownOffset(anchor?.offset, source.length);
    if (!anchor?.headingKey) return fallback;

    const headings = extractMarkdownOutline(source);
    let occurrence = 0;
    for (const heading of headings) {
        const key = markdownHeadingKey(heading.text);
        if (key !== anchor.headingKey) continue;
        if (occurrence === anchor.headingOccurrence) {
            return clampMarkdownOffset(
                heading.offset + Math.max(0, Number(anchor.relativeOffset) || 0),
                source.length
            );
        }
        occurrence++;
    }
    return fallback;
}

export function createMarkdownFragmentSlug(text) {
    return String(text || '')
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{Letter}\p{Number}\p{Mark}\s-]/gu, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');
}

function visibleHeadingText(headingSource, nodeName) {
    let text = headingSource;
    if (nodeName.startsWith('ATXHeading')) {
        text = text
            .replace(/^ {0,3}#{1,6}(?:[\t ]+|$)/, '')
            .replace(/[\t ]+#+[\t ]*$/, '');
    }
    else {
        text = text.replace(/\n {0,3}(?:=+|-+)[\t ]*$/, '');
    }
    return text
        .replace(/!\[([^\]]*)\]\([^\n)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^\n)]*\)/g, '$1')
        .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, '$1')
        .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
        .replace(/(`+)(.*?)\1/g, '$2')
        .replace(
            /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*|[^<>\s@]+@[^<>\s@]+)>/g,
            '$1'
        )
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<\/?[A-Za-z][^>]*>/g, '')
        .replace(/(^|[\s([{])[*_~]{1,3}(?=\S)/g, '$1')
        .replace(/[*_~]{1,3}(?=$|[\s)\]},.!?:;])/g, '')
        .replace(/\\([\\`*_[\]{}()#+.!<>~-])/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}

function clampMarkdownOffset(offset, length) {
    const requestedOffset = Number(offset);
    if (!Number.isFinite(requestedOffset)) return 0;
    return Math.max(0, Math.min(Math.trunc(requestedOffset), length));
}

function markdownHeadingKey(text) {
    return createMarkdownFragmentSlug(text) || String(text || '');
}
