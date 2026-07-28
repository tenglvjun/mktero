import { normalizeMarkdownFigureCaptions } from '../markdown/markdown-figures.js';

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
const SEMICOLON_SERIES_CONTINUATION_PATTERN = /^[^.!?]*;/;
const CITATION_YEAR_CONTINUATION_PATTERN = /^(?:18|19|20)\d{2}[a-z]?[ \t]*[,;，；)]/i;
const OCR_BULLET_ITEM_PATTERN = /^[ \t]*(?:\\-|•)[ \t]+\S[^\r\n]*[ \t]*$/u;
const OCR_BULLET_PREFIX_PATTERN = /^([ \t]*)(?:\\-|•)(?=[ \t]+)/u;
const MIN_PRECEDING_WORDS = 6;

export function normalizeMinerUMarkdown(markdown) {
    if (typeof markdown !== 'string') return markdown;

    const withFigureCaptions = normalizeMarkdownFigureCaptions(markdown);
    if (!withFigureCaptions.includes('\n')) return withFigureCaptions;

    const parts = normalizeOCRBulletLists(withFigureCaptions).split(BLANK_LINE_SEPARATOR);
    if (parts.length < 3) return withFigureCaptions;

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
    const continuesCitationYear = previous.endsWith(',')
        && hasUnclosedParenthetical(previous)
        && CITATION_YEAR_CONTINUATION_PATTERN.test(next);
    const continuesProse = PROSE_CONTINUATION_END_PATTERN.test(previous)
        || continuesLoadReaction
        || continuesCitationYear
        || (previous.endsWith(';')
            && SEMICOLON_SERIES_CONTINUATION_PATTERN.test(next));
    if ((!/^\p{Ll}/u.test(next) && !continuesCitationYear)
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
