import {
    normalizeMarkdownFigureCaptions,
    normalizeMisassignedAcademicCaptions,
    parseAcademicFigureCaption,
} from '../markdown/markdown-figures.js';
import { normalizeFigureLayouts } from '../markdown/figure-layout-normalizer.js';
import { normalizeOutsideRestoredFigures } from '../figures/figure-normalization.js';

const BLANK_LINE_SEPARATOR = /(\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*)/;
const BLOCK_START_PATTERN = /^(?: {0,3}(?:#{1,6}(?:[ \t]|$)|>|(?:[-+*]|\d+[.)])[ \t]+|```|~~~)| {4}\S|\t\S|<|\$\$|\\\[|\\begin\{|\[[^\]\n]+\]:)/;
const TABLE_SEPARATOR_PATTERN = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*)?$/m;
const ATX_HEADING_PATTERN = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const SETEXT_HEADING_PATTERN = /\r?\n[ \t]*(?:=+|-+)[ \t]*$/;
const CAPTION_START_PATTERN = /^(?:algorithm|chart|fig\.?|figure|scheme|table)[ \t]+(?:[a-z]?\d+[a-z]?|[ivxlcdm]+[a-z]?)\b/i;
const PUBLICATION_METADATA_PATTERN = /^(?:doi|isbn|issn|pmcid?|url)\s*:/i;
const REFERENCE_HEADING_PATTERN = /^(?:#{1,6}[ \t]+)?(?:\*{1,2}|_{1,2})?(?:references?|bibliography|works[ \t]+cited|literature[ \t]+cited|参考文献|参考资料|参考书目)(?:\*{1,2}|_{1,2})?[ \t]*[:：]?[ \t]*#*[ \t]*$/i;
const LOAD_REACTION_MODIFIERS_END_PATTERN = /\binduc(?:e|es|ed|ing)[ \t]+physiological[ \t]+\((?:e\.g\.|i\.e\.)[^()\n]*\)[ \t]+and[ \t]+psychological[ \t]+\((?:e\.g\.|i\.e\.)[^()\n]*\)$/iu;
const LOAD_REACTIONS_START_PATTERN = /^load[ \t]+reactions\b/iu;
const MARKDOWN_IMAGE_LINE_PATTERN = /^!\[[^\]\n]*\]\(.+\)[ \t]*$/;
const PROSE_CONTINUATION_END_PATTERN = /[\p{L}\p{N}]$/u;
// A block that is nothing but a web address: a "www." host or a host with a
// path. MinerU keeps source-URL lines as plain text, but they are hyperlinks
// in the PDF and should render and open like the other Markdown links.
const HOST_LABEL_PATTERN = '(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)';
const URL_PATH_PATTERN = '\\/[^\\s()\\[\\]<>"\']*';
const STANDALONE_LINK_BLOCK_PATTERN = new RegExp(
    `^(?:www\\.${HOST_LABEL_PATTERN}+[a-z]{2,}(?:${URL_PATH_PATTERN})?`
    + `|${HOST_LABEL_PATTERN}+[a-z]{2,}${URL_PATH_PATTERN})$`,
    'iu'
);
const SEMICOLON_SERIES_CONTINUATION_PATTERN = /^[^.!?]*;/;
const CITATION_YEAR_CONTINUATION_PATTERN = /^(?:18|19|20)\d{2}[a-z]?[ \t]*[,;，；)]/i;
const OCR_BULLET_ITEM_PATTERN = /^[ \t]*(?:\\-|•)[ \t]+\S[^\r\n]*[ \t]*$/u;
const OCR_BULLET_PREFIX_PATTERN = /^([ \t]*)(?:\\-|•)(?=[ \t]+)/u;
const MIN_PRECEDING_WORDS = 6;

export function normalizeMinerUMarkdown(markdown, { figureBlocks = [], figureTables = [] } = {}) {
    if (typeof markdown !== 'string') return markdown;

    const withFigureImages = replaceFigureCaptionedTables(
        markdown,
        figureTables.length ? figureTables : figureBlocks
    );
    const withFigureCaptions = normalizeOutsideRestoredFigures(
        withFigureImages,
        figureBlocks,
        source => normalizeMisassignedAcademicCaptions(
            normalizeMarkdownFigureCaptions(source)
        )
    );
    const withLinks = linkifyStandaloneAddressLines(withFigureCaptions);
    if (!withLinks.includes('\n')) return withLinks;

    const parts = normalizeOCRBulletLists(withLinks).split(BLANK_LINE_SEPARATOR);
    if (parts.length < 3) return withLinks;

    let output = parts[0];
    let inReferences = isReferenceHeading(parts[0]);
    for (let index = 1; index < parts.length; index += 2) {
        const separator = parts[index];
        const nextBlock = parts[index + 1] || '';
        if (isReferenceHeading(parts[index - 1])) inReferences = true;
        if (!inReferences
            && isBrokenProseBoundary(parts[index - 1], separator, nextBlock)) {
            output = `${output.trimEnd()} ${nextBlock}`;
        }
        else {
            output += separator + nextBlock;
        }
    }
    return output;
}

export function normalizeMinerUFigureLayouts(markdown, imageBlocks = []) {
    return normalizeOutsideRestoredFigures(markdown, imageBlocks, source => normalizeFigureLayouts(source,
        imageBlocks.filter(block => !block.figureId), {
        // MinerU content_list locations are the evidence required for a
        // layout change. Do not guess a grid when those locations are absent.
        allowFallback: false,
        skipExistingPanelLayout: true,
    }));
}

// MinerU emits source-URL lines flush after the paragraph above them (and
// sometimes glued to the chart image below), so only lines that start a new
// paragraph outside a fenced code block are converted.
// MinerU classifies figures that contain a table (for example a forest plot
// with its study table) as tables. When the caption is an academic figure
// caption, restore the figure image so the plot is not lost.
function replaceFigureCaptionedTables(markdown, figureBlocks) {
    let output = markdown;
    for (const block of figureBlocks || []) {
        if (block?.type && block.type !== 'table') continue;
        if (typeof block?.assetPath !== 'string' || !block.assetPath) continue;
        const captions = Array.isArray(block.captions) ? block.captions : [];
        if (!captions.some(caption => /^(?:fig|figure)\b/iu.test(
            parseAcademicFigureCaption(caption)?.label || ''
        ))) {
            continue;
        }
        const body = typeof block.text === 'string' ? block.text : '';
        if (!body) continue;
        const index = output.indexOf(body);
        if (index < 0) continue;
        output = `${output.slice(0, index)}![](${block.assetPath})${output.slice(index + body.length)}`;
    }
    return output;
}

function linkifyStandaloneAddressLines(markdown) {
    const lines = markdown.split(/(\r?\n)/u);
    let inFence = false;
    let changed = false;
    for (let index = 0; index < lines.length; index += 2) {
        const line = lines[index];
        if (/^[ \t]*(?:`{3,}|~{3,})/u.test(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence || /^[ \t]/u.test(line)) continue;
        if (index >= 2 && lines[index - 2].trim() !== '') continue;
        const address = line.trim();
        if (!STANDALONE_LINK_BLOCK_PATTERN.test(address)) continue;
        // Keep the trailing hard-break spaces so the line boundary survives.
        lines[index] = `[${address}](https://${address})${line.slice(address.length)}`;
        changed = true;
    }
    return changed ? lines.join('') : markdown;
}

function normalizeOCRBulletLists(markdown) {
    const parts = markdown.split(BLANK_LINE_SEPARATOR);
    let run = [];
    let inReferences = false;
    const flushRun = () => {
        if (run.length >= 2) {
            for (const index of run) {
                parts[index] = parts[index].replace(
                    OCR_BULLET_PREFIX_PATTERN,
                    '$1-'
                );
            }
        }
        run = [];
    };

    for (let index = 0; index < parts.length; index += 2) {
        const block = parts[index];
        if (isReferenceHeading(block)) {
            flushRun();
            inReferences = true;
            continue;
        }
        if (ATX_HEADING_PATTERN.test(block) || SETEXT_HEADING_PATTERN.test(block)) {
            flushRun();
            inReferences = false;
            continue;
        }
        if (inReferences) {
            flushRun();
            continue;
        }
        if (OCR_BULLET_ITEM_PATTERN.test(block)) {
            if (run.length && countLineBreaks(parts[index - 1]) !== 2) {
                flushRun();
            }
            run.push(index);
        }
        else {
            flushRun();
        }
    }
    flushRun();
    return parts.join('');
}

function isBrokenProseBoundary(previousBlock, separator, nextBlock) {
    if (countLineBreaks(separator) !== 2) return false;

    const previous = previousBlock.trimEnd();
    const next = nextBlock.trimEnd();
    if (!previous.trim() || !next.trim()
        || isMarkdownBlock(previous) || isMarkdownBlock(next)) {
        return false;
    }
    const continuesLoadReaction = LOAD_REACTION_MODIFIERS_END_PATTERN.test(previous)
        && LOAD_REACTIONS_START_PATTERN.test(next);
    const continuesUnclosedParenthetical = previous.endsWith(',')
        && hasUnclosedParenthetical(previous);
    const continuesCitationYear = continuesUnclosedParenthetical
        && CITATION_YEAR_CONTINUATION_PATTERN.test(next);
    const continuesProse = PROSE_CONTINUATION_END_PATTERN.test(previous)
        || continuesLoadReaction
        || continuesUnclosedParenthetical
        || (previous.endsWith(';')
            && SEMICOLON_SERIES_CONTINUATION_PATTERN.test(next));
    if ((!/^\p{Ll}/u.test(next)
            && !continuesCitationYear
            && !continuesUnclosedParenthetical)
        || !continuesProse) {
        return false;
    }

    const words = previous.match(/\p{L}[\p{L}\p{N}'’-]*/gu) || [];
    return words.length >= MIN_PRECEDING_WORDS;
}

function hasUnclosedParenthetical(value) {
    let depth = 0;
    for (const character of value) {
        if (character === '(' || character === '（') depth++;
        if ((character === ')' || character === '）') && depth > 0) depth--;
    }
    return depth > 0;
}

function isMarkdownBlock(block) {
    return BLOCK_START_PATTERN.test(block)
        || TABLE_SEPARATOR_PATTERN.test(block)
        || SETEXT_HEADING_PATTERN.test(block)
        || CAPTION_START_PATTERN.test(block)
        || PUBLICATION_METADATA_PATTERN.test(block)
        || isImageOnlyBlock(block);
}

function isReferenceHeading(block) {
    const heading = block.trim().replace(SETEXT_HEADING_PATTERN, '').trim();
    return REFERENCE_HEADING_PATTERN.test(heading);
}

function isImageOnlyBlock(block) {
    const lines = block.split(/\r?\n/).filter(line => line.trim());
    return lines.length > 0
        && lines.every(line => MARKDOWN_IMAGE_LINE_PATTERN.test(line.trim()));
}

function countLineBreaks(value) {
    return value.match(/\n/g)?.length || 0;
}
