import { GFM, parser as markdownParser } from '@lezer/markdown';
import {
    normalizeMarkdownFigureCaptions,
    parseAcademicFigureCaption,
} from '../markdown/markdown-figures.js';
import { normalizeFigureLayouts } from '../markdown/figure-layout-normalizer.js';
import { isNumericCitationContent } from '../markdown/text-normalization.js';

const MARKDOWN_PARSER = markdownParser.configure(GFM);
const PARENTHESIZED_MARKER_PATTERN = /\\\(\s*(?:(\[[^\]\r\n]{1,80}\])|(\^\{[^{}\r\n]{1,80}\}))\s*\\\)/g;
const IMAGE_LINE_PATTERN = /^( {0,3})!\[([^\]\r\n]*)\]\(\s*(<[^>\r\n]+>|[^)\s]+)([^)]*)\)[ \t]*(?:\r?\n)?$/;
const TABLE_LINK_PATTERN = /^([ \t]*)\[([^\]\r\n]+)\]\(\s*(<[^>\r\n]+>|[^)\s]+)([^)]*)\)[ \t]*(?:\r?\n)?$/;
const BLANK_LINE_PATTERN = /^[ \t]*(?:\r?\n)?$/;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Normalize Markdown dialect quirks emitted by Mistral OCR.
 *
 * Mistral commonly wraps numeric citations and superscript markers in TeX
 * parentheses, while Mktero's citation parser expects the canonical dollar
 * form for those constructs.
 */
export function normalizeMistralMarkdown(markdown, {
    tables = null,
    onMissingTable = null,
} = {}) {
    if (typeof markdown !== 'string' || !markdown) return markdown;

    const withMarkers = normalizeMistralMarkers(markdown);
    const withTables = normalizeMistralTableReferences(
        withMarkers,
        tables,
        onMissingTable
    );
    return normalizeMistralFigureCaptions(withTables);
}

export function normalizeMistralFigureLayouts(markdown, imageBlocks = []) {
    return normalizeFigureLayouts(markdown, imageBlocks, {
        allowFallback: true,
    });
}

function nextNearbyLineIsImage(lines, index) {
    let nextIndex = index + 1;
    while (nextIndex < lines.length && !lines[nextIndex].trim()) nextIndex++;
    return nextIndex < lines.length
        && IMAGE_LINE_PATTERN.test(lines[nextIndex]);
}

/**
 * Mistral emits extracted tables as local Markdown file links in page.markdown
 * and returns their contents separately in page.tables. Resolve only the
 * provider's safe table-link shape, leaving ordinary document links untouched.
 */
function normalizeMistralTableReferences(markdown, tables, onMissingTable) {
    const tableMap = tables instanceof Map ? tables : null;
    if (!tableMap && typeof onMissingTable !== 'function') return markdown;

    const lines = markdown.match(/[^\r\n]*(?:\r\n|\n|$)/g) || [];
    let activeFence = null;
    let changed = false;
    const normalized = lines.map(line => {
        const lineWithoutEnding = line.replace(/\r?\n$/, '');
        const fence = FENCE_PATTERN.exec(lineWithoutEnding);
        if (activeFence) {
            if (fence
                && fence[1][0] === activeFence.character
                && fence[1].length >= activeFence.length
                && !fence[2].trim()) {
                activeFence = null;
            }
            return line;
        }
        if (fence) {
            activeFence = {
                character: fence[1][0],
                length: fence[1].length,
            };
            return line;
        }
        if (/^(?: {4}|\t)/.test(line)) return line;

        const link = TABLE_LINK_PATTERN.exec(line);
        if (!link) return line;
        const destination = link[3].startsWith('<')
            ? link[3].slice(1, -1)
            : link[3];
        const tableID = tableReferenceID(destination);
        if (!tableID) return line;
        if (tableReferenceID(link[2]) !== tableID || link[4].trim()) {
            return line;
        }
        const content = tableMap?.get(tableID);
        if (typeof content !== 'string' || !content.trim()) {
            onMissingTable?.(destination);
            return line;
        }
        changed = true;
        return `${link[1]}${content.trim()}${lineEnding(line)}`;
    });

    return changed ? normalized.join('') : markdown;
}

function normalizeMistralMarkers(markdown) {
    const codeRanges = markdownCodeRanges(markdown);
    let rangeIndex = 0;
    return markdown.replace(
        PARENTHESIZED_MARKER_PATTERN,
        (match, citation, superscript, offset) => {
            while (codeRanges[rangeIndex]?.to <= offset) rangeIndex++;
            const range = codeRanges[rangeIndex];
            if (range && offset < range.to && offset + match.length > range.from) {
                return match;
            }
            if (superscript) return `$${superscript}$`;
            return isNumericCitationContent(citation.slice(1, -1).trim())
                ? `$${citation}$`
                : match;
        }
    );
}

function markdownCodeRanges(markdown) {
    const ranges = [];
    MARKDOWN_PARSER.parse(markdown).iterate({
        enter(node) {
            if (!['CodeBlock', 'FencedCode', 'InlineCode'].includes(node.name)) {
                return undefined;
            }
            ranges.push({ from: node.from, to: node.to });
            return false;
        },
    });
    return ranges;
}

function tableReferenceID(destination) {
    const source = String(destination || '').trim();
    if (!/^tbl-[^/\\?#]+\.md$/iu.test(source)) return null;
    return source.slice(0, -3).toLowerCase();
}

/**
 * Mistral uses the extracted image filename as alt text and emits the
 * academic caption as a separate paragraph. The shared figure normalizer
 * intentionally treats only empty-alt images as structural OCR images, so
 * collapse this unambiguous Mistral shape before handing it off.
 */
function normalizeMistralFigureCaptions(markdown) {
    const lines = markdown.match(/[^\r\n]*(?:\r\n|\n|$)/g) || [];
    const replacements = new Map();
    let activeFence = null;

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const fence = FENCE_PATTERN.exec(line.replace(/\r?\n$/, ''));
        if (activeFence) {
            if (fence
                && fence[1][0] === activeFence.character
                && fence[1].length >= activeFence.length
                && !fence[2].trim()) {
                activeFence = null;
            }
            continue;
        }
        if (fence) {
            activeFence = {
                character: fence[1][0],
                length: fence[1].length,
            };
            continue;
        }
        if (/^(?: {4}|\t)/.test(line)) continue;

        const image = IMAGE_LINE_PATTERN.exec(line);
        if (!image || !looksLikeImageFilenameAlt(image[2], image[3])) {
            continue;
        }
        const followingCaption = hasNearbyAcademicCaption(lines, index, 1);
        const precedingCaption = hasNearbyAcademicCaption(lines, index, -1);
        // Leave a preceding caption in place when another image follows. The
        // shared figure analyzer can then keep the caption attached to the
        // complete panel group instead of making it look like a standalone
        // first image.
        if (precedingCaption && nextNearbyLineIsImage(lines, index)) {
            continue;
        }
        if (followingCaption || precedingCaption) {
            replacements.set(index, `${image[1]}![](${image[3]}${image[4]})`
                + lineEnding(line));
        }
    }

    if (!replacements.size) return markdown;
    const collapsed = lines
        .map((line, index) => replacements.get(index) || line)
        .join('');
    return normalizeMarkdownFigureCaptions(collapsed);
}

function hasNearbyAcademicCaption(lines, imageIndex, direction) {
    let index = imageIndex + direction;
    if (index < 0 || index >= lines.length) return false;
    if (BLANK_LINE_PATTERN.test(lines[index])) index += direction;
    if (index < 0 || index >= lines.length) return false;
    return Boolean(parseAcademicFigureCaption(stripLineEnding(lines[index])));
}

function looksLikeImageFilenameAlt(alt, destination) {
    const cleanAlt = String(alt || '').trim();
    if (!cleanAlt) return false;
    const cleanDestination = String(destination || '')
        .replace(/^</, '')
        .replace(/>$/, '');
    let decodedDestination = cleanDestination;
    try {
        decodedDestination = decodeURIComponent(cleanDestination);
    }
    catch {
        // Keep the original destination when a provider emits malformed escapes.
    }
    if (!isLocalImageDestination(decodedDestination)) return false;
    const filename = decodedDestination.split('/').at(-1) || '';
    return cleanAlt === filename
        && /^[^/\\?#]+\.[a-z0-9]{1,8}$/iu.test(filename);
}

function isLocalImageDestination(destination) {
    if (!destination
        || destination.startsWith('/')
        || destination.startsWith('\\')
        || /^[a-z][a-z0-9+.-]*:/iu.test(destination)
        || /[?#]/u.test(destination)) {
        return false;
    }
    return destination
        .replace(/\\/g, '/')
        .split('/')
        .every(segment => segment && segment !== '.' && segment !== '..');
}

function stripLineEnding(line) {
    return String(line || '').replace(/\r?\n$/, '');
}

function lineEnding(line) {
    return /\r?\n$/.exec(line || '')?.[0] || '';
}
