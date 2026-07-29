import {
    createNormalizedTextIndex,
    isNumericCitationContent,
} from './text-normalization.js';

const SINGLE_QUOTES = new Set(['‘', '’', '‛']);
const DOUBLE_QUOTES = new Set(['“', '”', '„', '‟']);
const HYPHENS = new Set(['‐', '‑', '‒', '–', '—', '−']);
const CITATION_WRAPPER = /\$\[([0-9,，;；\s–—-]{1,512})\]\$/gu;
const TRADEMARK_SUPERSCRIPT = /\$\^\{([®©™])\}\$/gu;
const SENTENCE_FOOTNOTE_SUPERSCRIPT = /\$\^\{([0-9]{1,4})\}\$/gu;
const SENTENCE_END = /[.!?。！？]/u;

export function normalizePdfAnnotationText(text) {
    return createPdfAnnotationTextIndex(String(text)).text.trim();
}

export function expandPdfAnnotationSourceRange(source, range) {
    const symbol = source.slice(range.from, range.to);
    const wrapperFrom = range.from - 3;
    const wrapperTo = range.to + 2;
    if (wrapperFrom >= 0
        && /^[®©™]$/u.test(symbol)
        && source.slice(wrapperFrom, wrapperTo) === `$^{${symbol}}$`) {
        return { from: wrapperFrom, to: wrapperTo };
    }
    if (wrapperFrom >= 0
        && /^[0-9]{1,4}$/u.test(symbol)
        && source.slice(wrapperFrom, wrapperTo) === `$^{${symbol}}$`
        && sentenceFootnoteWhitespaceFrom(source, wrapperFrom) !== null) {
        return { from: wrapperFrom, to: wrapperTo };
    }
    return range;
}

export function createPdfAnnotationTextIndex(
    text,
    sourceOffsetAt = offset => offset
) {
    const markup = collectNormalizationMarkup(text);
    return createNormalizedTextIndex(
        text,
        sourceOffsetAt,
        (character, offset, source) => normalizePdfAnnotationCharacter(
            character,
            offset,
            source,
            markup
        )
    );
}

function normalizePdfAnnotationCharacter(
    character,
    offset,
    source,
    markup
) {
    const replacement = markup.replacements.get(offset);
    if (replacement) {
        return {
            text: character,
            sourceFrom: replacement.from,
            sourceTo: replacement.to,
        };
    }
    if (markup.ignoredOffsets.has(offset)) return '';
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

function collectNormalizationMarkup(text) {
    const ignoredOffsets = new Set();
    const replacements = new Map();
    for (const match of text.matchAll(CITATION_WRAPPER)) {
        if (!isNumericCitationContent(match[1])) continue;
        ignoredOffsets.add(match.index);
        ignoredOffsets.add(match.index + match[0].length - 1);
    }
    for (const match of text.matchAll(TRADEMARK_SUPERSCRIPT)) {
        const symbolOffset = match.index + match[0].indexOf(match[1]);
        replacements.set(symbolOffset, {
            from: match.index,
            to: match.index + match[0].length,
        });
        for (
            let offset = match.index;
            offset < match.index + match[0].length;
            offset++
        ) {
            if (offset !== symbolOffset) ignoredOffsets.add(offset);
        }
        for (
            let offset = match.index - 1;
            offset >= 0 && /\s/u.test(text[offset]);
            offset--
        ) {
            ignoredOffsets.add(offset);
        }
    }
    for (const match of text.matchAll(SENTENCE_FOOTNOTE_SUPERSCRIPT)) {
        const whitespaceFrom = sentenceFootnoteWhitespaceFrom(
            text,
            match.index
        );
        if (whitespaceFrom === null) continue;
        const contentFrom = match.index + match[0].indexOf(match[1]);
        const contentTo = contentFrom + match[1].length;
        for (
            let offset = match.index;
            offset < match.index + match[0].length;
            offset++
        ) {
            if (offset < contentFrom || offset >= contentTo) {
                ignoredOffsets.add(offset);
            }
        }
        for (let offset = contentFrom; offset < contentTo; offset++) {
            replacements.set(offset, {
                from: match.index,
                to: match.index + match[0].length,
            });
        }
        for (let offset = whitespaceFrom; offset < match.index; offset++) {
            ignoredOffsets.add(offset);
        }
    }
    return { ignoredOffsets, replacements };
}

function sentenceFootnoteWhitespaceFrom(text, wrapperFrom) {
    let whitespaceFrom = wrapperFrom;
    while (whitespaceFrom > 0 && /[ \t]/u.test(text[whitespaceFrom - 1])) {
        whitespaceFrom--;
    }
    return whitespaceFrom > 0 && SENTENCE_END.test(text[whitespaceFrom - 1])
        ? whitespaceFrom
        : null;
}
