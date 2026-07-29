import { createNormalizedTextIndex } from './text-normalization.js';

const SINGLE_QUOTES = new Set(['‘', '’', '‛']);
const DOUBLE_QUOTES = new Set(['“', '”', '„', '‟']);
const HYPHENS = new Set(['‐', '‑', '‒', '–', '—', '−']);
const CITATION_CONTENT = /^\d+(?:\s*[-–—]\s*\d+)?(?:\s*[,，;；]\s*\d+(?:\s*[-–—]\s*\d+)?)*$/u;
const CITATION_WRAPPER = /\$\[([0-9,，;；\s–—-]{1,512})\]\$/gu;
const TRADEMARK_SUPERSCRIPT = /\$\^\{([®©™])\}\$/gu;

export function normalizePdfAnnotationText(text) {
    return createPdfAnnotationTextIndex(String(text)).text.trim();
}

export function createPdfAnnotationTextIndex(
    text,
    sourceOffsetAt = offset => offset
) {
    const ignoredMarkup = collectIgnoredMarkupOffsets(text);
    return createNormalizedTextIndex(
        text,
        sourceOffsetAt,
        (character, offset, source) => normalizePdfAnnotationCharacter(
            character,
            offset,
            source,
            ignoredMarkup
        )
    );
}

function normalizePdfAnnotationCharacter(
    character,
    offset,
    source,
    ignoredMarkup
) {
    if (ignoredMarkup.has(offset)) return '';
    if (/^\s$/u.test(character)
        && /^\s*[,.;:!?，。；：！？®©™]/u.test(
            source.slice(offset + character.length)
        )) {
        return '';
    }
    if (SINGLE_QUOTES.has(character)) return "'";
    if (DOUBLE_QUOTES.has(character)) return '"';
    if (HYPHENS.has(character)) return '-';
    return character.normalize('NFKC');
}

function collectIgnoredMarkupOffsets(text) {
    const offsets = new Set();
    for (const match of text.matchAll(CITATION_WRAPPER)) {
        if (!CITATION_CONTENT.test(match[1])) continue;
        offsets.add(match.index);
        offsets.add(match.index + match[0].length - 1);
    }
    for (const match of text.matchAll(TRADEMARK_SUPERSCRIPT)) {
        const symbolOffset = match.index + match[0].indexOf(match[1]);
        for (
            let offset = match.index;
            offset < match.index + match[0].length;
            offset++
        ) {
            if (offset !== symbolOffset) offsets.add(offset);
        }
        for (
            let offset = match.index - 1;
            offset >= 0 && /\s/u.test(text[offset]);
            offset--
        ) {
            offsets.add(offset);
        }
    }
    return offsets;
}
