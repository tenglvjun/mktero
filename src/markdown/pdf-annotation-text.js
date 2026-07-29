import { createNormalizedTextIndex } from './text-normalization.js';

const SINGLE_QUOTES = new Set(['‘', '’', '‛']);
const DOUBLE_QUOTES = new Set(['“', '”', '„', '‟']);
const HYPHENS = new Set(['‐', '‑', '‒', '–', '—', '−']);
const CITATION_CONTENT = /^\d+(?:\s*[-–—]\s*\d+)?(?:\s*[,，;；]\s*\d+(?:\s*[-–—]\s*\d+)?)*$/u;
const CITATION_WRAPPER = /\$\[([0-9,，;；\s–—-]{1,512})\]\$/gu;

export function normalizePdfAnnotationText(text) {
    return createPdfAnnotationTextIndex(String(text)).text.trim();
}

export function createPdfAnnotationTextIndex(
    text,
    sourceOffsetAt = offset => offset
) {
    const citationDollars = collectCitationDollarOffsets(text);
    return createNormalizedTextIndex(
        text,
        sourceOffsetAt,
        (character, offset, source) => normalizePdfAnnotationCharacter(
            character,
            offset,
            source,
            citationDollars
        )
    );
}

function normalizePdfAnnotationCharacter(
    character,
    offset,
    source,
    citationDollars
) {
    if (citationDollars.has(offset)) return '';
    if (/^\s$/u.test(character)
        && /^\s*[,.;:!?，。；：！？]/u.test(
            source.slice(offset + character.length)
        )) {
        return '';
    }
    if (SINGLE_QUOTES.has(character)) return "'";
    if (DOUBLE_QUOTES.has(character)) return '"';
    if (HYPHENS.has(character)) return '-';
    return character.normalize('NFKC');
}

function collectCitationDollarOffsets(text) {
    const offsets = new Set();
    for (const match of text.matchAll(CITATION_WRAPPER)) {
        if (!CITATION_CONTENT.test(match[1])) continue;
        offsets.add(match.index);
        offsets.add(match.index + match[0].length - 1);
    }
    return offsets;
}
