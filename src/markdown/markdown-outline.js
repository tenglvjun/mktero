import { GFM, parser as markdownParser } from '@lezer/markdown';
import { normalizeChromeRanges } from './chrome-ranges.js';

const OUTLINE_PARSER = markdownParser.configure(GFM);
const HEADING_NODE = /^(?:ATXHeading|SetextHeading)([1-6])$/;

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
    return inferFlatNumberedOutlineLevels(headings);
}

const NUMBERED_HEADING_PATTERN = /^(\d+(?:\.\d+)*)(?:\.|\s|$)/;
const LETTER_HEADING_PATTERN = /^([A-Z](?:\.\d+)*)\.(?:\s|$)/;
const LETTER_SUBHEADING_PATTERN = /^([A-Z]\.\d+(?:\.\d+)*)(?:\s|$)/;
const ROMAN_HEADING_PATTERN = /^(I|II|III|IV|V|VI|VII|VIII|IX|X|XI|XII|XIII|XIV|XV|XVI|XVII|XVIII|XIX|XX)\.(?:\s|$)/i;

function inferFlatNumberedOutlineLevels(headings) {
    if (headings.length < 2) return headings;
    const groups = new Map();
    for (const [index, heading] of headings.entries()) {
        const indexes = groups.get(heading.level) || [];
        indexes.push(index);
        groups.set(heading.level, indexes);
    }
    const next = headings.map(heading => ({ ...heading }));
    for (const indexes of groups.values()) {
        if (indexes.length < 2) continue;
        const scheme = outlineNumberingScheme(
            indexes.map(index => headings[index].text)
        );
        const depths = indexes.map(index => (
            numberedHeadingDepth(headings[index].text, scheme)
        ));
        if (new Set(depths.filter(Boolean)).size < 2) continue;
        for (const [offset, index] of indexes.entries()) {
            next[index] = {
                ...next[index],
                level: depths[offset] || 1,
            };
        }
    }
    return next;
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
