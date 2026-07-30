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

export function createDehyphenatedPdfAnnotationTextIndex(text) {
    const normalized = createPdfAnnotationTextIndex(String(text));
    const output = [];
    const sourceStarts = [];
    const sourceEnds = [];
    for (let offset = 0; offset < normalized.text.length;) {
        const character = String.fromCodePoint(
            normalized.text.codePointAt(offset)
        );
        const nextOffset = offset + character.length;
        const hasWhitespace = character === '-'
            && normalized.text[nextOffset] === ' ';
        const afterWhitespace = nextOffset + (hasWhitespace ? 1 : 0);
        if (character === '-'
            && isLetterBefore(normalized.text, offset)
            && isLetterAt(normalized.text, afterWhitespace)
            && hasWhitespace) {
            offset = afterWhitespace;
            continue;
        }
        for (let unit = 0; unit < character.length; unit++) {
            output.push(character[unit]);
            sourceStarts.push(offset);
            sourceEnds.push(nextOffset);
        }
        offset = nextOffset;
    }
    return {
        text: output.join(''),
        sourceRange(from, length) {
            const normalizedFrom = sourceStarts[from];
            const normalizedTo = sourceEnds[from + length - 1];
            return normalized.sourceRange(
                normalizedFrom,
                normalizedTo - normalizedFrom
            );
        },
    };
}

function isLetterBefore(text, offset) {
    if (offset <= 0) return false;
    let previousOffset = offset - 1;
    if (previousOffset > 0
        && isLowSurrogate(text.charCodeAt(previousOffset))
        && isHighSurrogate(text.charCodeAt(previousOffset - 1))) {
        previousOffset--;
    }
    const character = String.fromCodePoint(text.codePointAt(previousOffset));
    return /^\p{L}$/u.test(character);
}

function isLetterAt(text, offset) {
    if (offset >= text.length) return false;
    const character = String.fromCodePoint(text.codePointAt(offset));
    return /^\p{L}$/u.test(character);
}

function isHighSurrogate(value) {
    return value >= 0xD800 && value <= 0xDBFF;
}

function isLowSurrogate(value) {
    return value >= 0xDC00 && value <= 0xDFFF;
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
