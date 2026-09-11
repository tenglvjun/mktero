import {
    createNormalizedTextIndex,
    isLikelyNumericSuperscriptExponent,
    isNumericCitationContent,
} from './text-normalization.js';

const SINGLE_QUOTES = new Set(['‘', '’', '‛']);
const DOUBLE_QUOTES = new Set(['“', '”', '„', '‟']);
const HYPHENS = new Set(['‐', '‑', '‒', '–', '—', '−']);
const CITATION_WRAPPER = /\$\[([0-9,，;；\s–—-]{1,512})\]\$/gu;
const NUMERIC_SUPERSCRIPT = /\$\^\{\s*([0-9][0-9,，;；\s–—-]{0,511}?)\s*\}\$/gu;
const TRADEMARK_SUPERSCRIPT = /\$\^\{([®©™])\}\$/gu;
const SENTENCE_FOOTNOTE_SUPERSCRIPT = /\$\^\{([0-9]{1,4})\}\$/gu;
const STATISTICAL_NUMERIC_EXPONENT = /\^\{\s*([0-9]{1,4})\s*\}(?=\s*(?:<=|>=|!=|[=<>≤≥≠]))/gu;
const SENTENCE_END = /[.!?。！？]/u;
const RELATIONAL_OPERATOR_PATTERN = /([\p{L}\p{N})\]}([{])(\s*)(<=|>=|!=|[=<>≤≥≠])(\s*)(?=[\p{L}\p{N}([{\-+−±.])/gu;
const LATEX_RELATIONAL_OPERATOR_PATTERN = /([\p{L}\p{N})\]}([{])(\s*)(\\(?:geq|ge|leq|le|neq|ne))(?![A-Za-z])(\s*)(?=[\p{L}\p{N}([{\-+−±.])/gu;
const OPENING_DELIMITER_SIGNED_NUMBER_WHITESPACE_PATTERN = /[([{](\s+)(?=(?:[+\-−±]|(?<!\\)\\pm)\s*\d)/gu;
const SIGNED_NUMBER_WHITESPACE_PATTERN = /(?:[+\-−±]|(?<!\\)\\pm)(\s+)(?=\d)/gu;
const DEGREE_SYMBOL_WHITESPACE_PATTERN = /([\p{N})\]}])(\s+)(?=°)/gu;
const DEGREE_SYMBOL_UNIT_WHITESPACE_PATTERN = /°(\s+)(?=\p{L})/gu;
const LATEX_TEXT_UNIT_PATTERN = /(?<!\\)\\mathrm\{([A-Za-z]{1,32})\}/gu;
const LATEX_BRACED_SUBSCRIPT_PATTERN = /(?<!\\)_[ \t]*\{[ \t]*([A-Za-z0-9][A-Za-z0-9,.;:+-]{0,63})[ \t]*\}/gu;
const LATEX_TAG_PATTERN = /(?<!\\)\\tag\{([^}]{0,32})\}/gu;
const EQUATION_NUMBER_WHITESPACE_PATTERN = /,(\s+)(?=\(\d{1,4}\))/gu;
const LATEX_SINGLE_SUBSCRIPT_PATTERN = /(?<!\\)_([A-Za-z0-9])/gu;
const LATEX_MATH_COMMAND_NAMES = new Set([
    'alpha',
    'beta',
    'gamma',
    'delta',
    'epsilon',
    'varepsilon',
    'zeta',
    'eta',
    'theta',
    'vartheta',
    'iota',
    'kappa',
    'varkappa',
    'lambda',
    'mu',
    'nu',
    'xi',
    'pi',
    'varpi',
    'rho',
    'varrho',
    'sigma',
    'varsigma',
    'tau',
    'upsilon',
    'phi',
    'varphi',
    'chi',
    'psi',
    'omega',
    'Gamma',
    'Delta',
    'Theta',
    'Lambda',
    'Xi',
    'Pi',
    'Sigma',
    'Upsilon',
    'Phi',
    'Psi',
    'Omega',
    'in',
]);
const PDF_ANNOTATION_SYMBOL_REPLACEMENTS = [
    { pattern: /(?<!\\)\\%/gu, text: '%' },
    { pattern: /(?<![\\;])(?:\\;)?\^\{\\circ\}/gu, text: '°' },
    { pattern: /(?<!\\)\\pm(?![A-Za-z])/gu, text: '±' },
    { pattern: /(?<!\\)\\(?:geq|ge)(?![A-Za-z])/gu, text: '≥' },
    { pattern: /(?<!\\)\\(?:leq|le)(?![A-Za-z])/gu, text: '≤' },
    { pattern: /(?<!\\)\\(?:neq|ne)(?![A-Za-z])/gu, text: '≠' },
    { pattern: />=/gu, text: '≥' },
    { pattern: /<=/gu, text: '≤' },
    { pattern: /!=/gu, text: '≠' },
];
const LATEX_MATH_SYMBOL_REPLACEMENTS = [
    { pattern: /(?<!\\)\\alpha(?![A-Za-z])/gu, text: 'α' },
    { pattern: /(?<!\\)\\beta(?![A-Za-z])/gu, text: 'β' },
    { pattern: /(?<!\\)\\gamma(?![A-Za-z])/gu, text: 'γ' },
    { pattern: /(?<!\\)\\delta(?![A-Za-z])/gu, text: 'δ' },
    { pattern: /(?<!\\)\\epsilon(?![A-Za-z])/gu, text: 'ε' },
    { pattern: /(?<!\\)\\varepsilon(?![A-Za-z])/gu, text: 'ε' },
    { pattern: /(?<!\\)\\zeta(?![A-Za-z])/gu, text: 'ζ' },
    { pattern: /(?<!\\)\\eta(?![A-Za-z])/gu, text: 'η' },
    { pattern: /(?<!\\)\\theta(?![A-Za-z])/gu, text: 'θ' },
    { pattern: /(?<!\\)\\vartheta(?![A-Za-z])/gu, text: 'θ' },
    { pattern: /(?<!\\)\\iota(?![A-Za-z])/gu, text: 'ι' },
    { pattern: /(?<!\\)\\kappa(?![A-Za-z])/gu, text: 'κ' },
    { pattern: /(?<!\\)\\varkappa(?![A-Za-z])/gu, text: 'κ' },
    { pattern: /(?<!\\)\\lambda(?![A-Za-z])/gu, text: 'λ' },
    { pattern: /(?<!\\)\\mu(?![A-Za-z])/gu, text: 'μ' },
    { pattern: /(?<!\\)\\nu(?![A-Za-z])/gu, text: 'ν' },
    { pattern: /(?<!\\)\\xi(?![A-Za-z])/gu, text: 'ξ' },
    { pattern: /(?<!\\)\\pi(?![A-Za-z])/gu, text: 'π' },
    { pattern: /(?<!\\)\\varpi(?![A-Za-z])/gu, text: 'π' },
    { pattern: /(?<!\\)\\rho(?![A-Za-z])/gu, text: 'ρ' },
    { pattern: /(?<!\\)\\varrho(?![A-Za-z])/gu, text: 'ρ' },
    { pattern: /(?<!\\)\\sigma(?![A-Za-z])/gu, text: 'σ' },
    { pattern: /(?<!\\)\\varsigma(?![A-Za-z])/gu, text: 'σ' },
    { pattern: /(?<!\\)\\tau(?![A-Za-z])/gu, text: 'τ' },
    { pattern: /(?<!\\)\\upsilon(?![A-Za-z])/gu, text: 'υ' },
    { pattern: /(?<!\\)\\phi(?![A-Za-z])/gu, text: 'φ' },
    { pattern: /(?<!\\)\\varphi(?![A-Za-z])/gu, text: 'φ' },
    { pattern: /(?<!\\)\\chi(?![A-Za-z])/gu, text: 'χ' },
    { pattern: /(?<!\\)\\psi(?![A-Za-z])/gu, text: 'ψ' },
    { pattern: /(?<!\\)\\omega(?![A-Za-z])/gu, text: 'ω' },
    { pattern: /(?<!\\)\\Gamma(?![A-Za-z])/gu, text: 'Γ' },
    { pattern: /(?<!\\)\\Delta(?![A-Za-z])/gu, text: 'Δ' },
    { pattern: /(?<!\\)\\Theta(?![A-Za-z])/gu, text: 'Θ' },
    { pattern: /(?<!\\)\\Lambda(?![A-Za-z])/gu, text: 'Λ' },
    { pattern: /(?<!\\)\\Xi(?![A-Za-z])/gu, text: 'Ξ' },
    { pattern: /(?<!\\)\\Pi(?![A-Za-z])/gu, text: 'Π' },
    { pattern: /(?<!\\)\\Sigma(?![A-Za-z])/gu, text: 'Σ' },
    { pattern: /(?<!\\)\\Upsilon(?![A-Za-z])/gu, text: 'Υ' },
    { pattern: /(?<!\\)\\Phi(?![A-Za-z])/gu, text: 'Φ' },
    { pattern: /(?<!\\)\\Psi(?![A-Za-z])/gu, text: 'Ψ' },
    { pattern: /(?<!\\)\\Omega(?![A-Za-z])/gu, text: 'Ω' },
    { pattern: /(?<!\\)\\in(?![A-Za-z])/gu, text: '∈' },
];
const MATH_SYMBOL_CANONICAL_FORMS = new Map([
    ['ϵ', 'ε'],
    ['ϑ', 'θ'],
    ['ϰ', 'κ'],
    ['ϖ', 'π'],
    ['ϱ', 'ρ'],
    ['ς', 'σ'],
    ['ϕ', 'φ'],
    ['∆', 'Δ'],
]);
const ALL_PDF_ANNOTATION_SYMBOL_REPLACEMENTS = [
    ...PDF_ANNOTATION_SYMBOL_REPLACEMENTS,
    ...LATEX_MATH_SYMBOL_REPLACEMENTS,
];

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

export function createDehyphenatedPdfAnnotationTextIndex(
    text,
    sourceOffsetAt = offset => offset
) {
    return createLineWrappedPdfAnnotationTextIndex(
        text,
        false,
        false,
        sourceOffsetAt
    );
}

export function createHyphenPreservingPdfAnnotationTextIndex(text) {
    return createLineWrappedPdfAnnotationTextIndex(text, true);
}

export function createHyphenFoldedPdfAnnotationTextIndex(text) {
    return createLineWrappedPdfAnnotationTextIndex(text, false, true);
}

function createLineWrappedPdfAnnotationTextIndex(
    text,
    preserveHyphen,
    foldLexicalHyphens = false,
    sourceOffsetAt = offset => offset
) {
    const normalized = createPdfAnnotationTextIndex(
        String(text),
        sourceOffsetAt
    );
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
        const betweenLetters = character === '-'
            && isLetterBefore(normalized.text, offset)
            && isLetterAt(normalized.text, afterWhitespace);
        if (betweenLetters && (hasWhitespace || foldLexicalHyphens)) {
            if (preserveHyphen && hasWhitespace) {
                output.push(character);
                sourceStarts.push(offset);
                sourceEnds.push(nextOffset);
            }
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

function previousCodePointOffset(text, offset) {
    let previous = offset - 1;
    if (previous > 0
        && isLowSurrogate(text.charCodeAt(previous))
        && isHighSurrogate(text.charCodeAt(previous - 1))) {
        previous--;
    }
    return previous;
}

function isLetterBefore(text, offset) {
    if (offset <= 0) return false;
    const previousOffset = previousCodePointOffset(text, offset);
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
            text: replacement.text ?? character,
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
    if (character === '\uFFFD'
        && /^\p{N}$/u.test(source[offset - 1] || '')
        && /^[CF](?![\p{L}\p{N}])/u.test(source.slice(offset + 1))) {
        return '°';
    }
    return normalizeMathSymbolText(character.normalize('NFKC'));
}

function collectNormalizationMarkup(text) {
    const ignoredOffsets = new Set();
    const replacements = new Map();
    markAnnotationSymbols(text, ignoredOffsets, replacements);
    markLatexSubscripts(text, ignoredOffsets, replacements);
    markLatexTags(text, ignoredOffsets, replacements);
    markStatisticalNumericExponents(text, ignoredOffsets, replacements);
    markMathematicalWhitespace(text, ignoredOffsets);
    for (const match of text.matchAll(CITATION_WRAPPER)) {
        if (!isNumericCitationContent(match[1])) continue;
        ignoredOffsets.add(match.index);
        ignoredOffsets.add(match.index + match[0].length - 1);
    }
    for (const match of text.matchAll(NUMERIC_SUPERSCRIPT)) {
        const value = match[1].trim();
        if (!isNumericCitationContent(value)
            || !hasInlineSuperscriptContext(text, match.index)
            || isLikelyNumericSuperscriptExponent(
                text,
                match.index,
                value
            )) {
            continue;
        }
        const contentFrom = match.index + match[0].indexOf(value);
        const contentTo = contentFrom + value.length;
        for (
            let offset = match.index;
            offset < match.index + match[0].length;
            offset++
        ) {
            if (offset < contentFrom || offset >= contentTo) {
                ignoredOffsets.add(offset);
                continue;
            }
            const character = text[offset];
            replacements.set(offset, {
                from: match.index,
                to: match.index + match[0].length,
                text: HYPHENS.has(character)
                    ? '-'
                    : character.normalize('NFKC'),
            });
        }
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

function markStatisticalNumericExponents(
    text,
    ignoredOffsets,
    replacements
) {
    for (const match of text.matchAll(STATISTICAL_NUMERIC_EXPONENT)) {
        if (!isLikelyNumericSuperscriptExponent(
            text,
            match.index,
            match[1]
        )) {
            continue;
        }
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
            else {
                replacements.set(offset, {
                    from: match.index,
                    to: match.index + match[0].length,
                });
            }
        }
    }
}

function markAnnotationSymbols(text, ignoredOffsets, replacements) {
    for (const replacement of ALL_PDF_ANNOTATION_SYMBOL_REPLACEMENTS) {
        for (const match of text.matchAll(replacement.pattern)) {
            replacements.set(match.index, {
                from: match.index,
                to: match.index + match[0].length,
                text: normalizeMathSymbolText(replacement.text),
            });
            markOffsetRange(
                ignoredOffsets,
                match.index + 1,
                match[0].length - 1
            );
            let spaceFrom = match.index + match[0].length;
            let spaceTo = spaceFrom;
            while (spaceTo < text.length && /[ \t]/u.test(text[spaceTo])) {
                spaceTo++;
            }
            if (spaceTo > spaceFrom
                && (text[spaceTo] === '\\' || text[spaceTo] === '_')) {
                markOffsetRange(
                    ignoredOffsets,
                    spaceFrom,
                    spaceTo - spaceFrom
                );
            }
        }
    }
    for (const match of text.matchAll(LATEX_TEXT_UNIT_PATTERN)) {
        replacements.set(match.index, {
            from: match.index,
            to: match.index + match[0].length,
            text: match[1],
        });
        markOffsetRange(
            ignoredOffsets,
            match.index + 1,
            match[0].length - 1
        );
    }
}

function markLatexSubscripts(text, ignoredOffsets, replacements) {
    for (const pattern of [
        LATEX_BRACED_SUBSCRIPT_PATTERN,
        LATEX_SINGLE_SUBSCRIPT_PATTERN,
    ]) {
        for (const match of text.matchAll(pattern)) {
            if (!isLikelyLatexSubscript(text, match.index)) continue;
            let spaceFrom = match.index;
            while (spaceFrom > 0 && /[ \t]/u.test(text[spaceFrom - 1])) {
                spaceFrom--;
            }
            if (spaceFrom < match.index
                && /[\p{L}\p{N})\]}]/u.test(text[spaceFrom - 1] || '')) {
                markOffsetRange(
                    ignoredOffsets,
                    spaceFrom,
                    match.index - spaceFrom
                );
            }
            replacements.set(match.index, {
                from: match.index,
                to: match.index + match[0].length,
                text: match[1],
            });
            markOffsetRange(
                ignoredOffsets,
                match.index + 1,
                match[0].length - 1
            );
        }
    }
}

function markLatexTags(text, ignoredOffsets, replacements) {
    for (const match of text.matchAll(LATEX_TAG_PATTERN)) {
        const label = String(match[1] || '').trim();
        if (!label) continue;
        replacements.set(match.index, {
            from: match.index,
            to: match.index + match[0].length,
            text: `(${label})`,
        });
        markOffsetRange(
            ignoredOffsets,
            match.index + 1,
            match[0].length - 1
        );
        let spaceFrom = match.index;
        while (spaceFrom > 0 && /[ \t]/u.test(text[spaceFrom - 1])) {
            spaceFrom--;
        }
        if (spaceFrom < match.index) {
            markOffsetRange(
                ignoredOffsets,
                spaceFrom,
                match.index - spaceFrom
            );
        }
    }
}

function isLikelyLatexSubscript(text, offset) {
    const prefix = text.slice(Math.max(0, offset - 64), offset);
    const command = latexCommandAtEnd(prefix);
    if (command) {
        // A command identifies unbraced subscripts; unknown commands stay inert.
        return !command.escaped && (
            LATEX_MATH_COMMAND_NAMES.has(command.name)
            || command.name === 'mathrm'
            || command.name === 'text'
        );
    }
    let next = offset + 1;
    while (next < text.length && /[ \t]/u.test(text[next])) next++;
    if (text[next] === '{') return true;
    if (!/^[A-Za-z0-9]$/u.test(text[next] || '')) return false;
    if (next + 1 < text.length && /[A-Za-z0-9]/u.test(text[next + 1])) {
        return false;
    }
    let previous = offset;
    while (previous > 0 && /[ \t]/u.test(text[previous - 1])) previous--;
    if (previous <= 0) return false;
    const previousOffset = previousCodePointOffset(text, previous);
    return isPdfAnnotationMathLetter(
        String.fromCodePoint(text.codePointAt(previousOffset))
    );
}

function latexCommandAtEnd(prefix) {
    const match = /\\([A-Za-z]+)(?:\{[^{}]{0,64}\})?$/.exec(prefix);
    if (!match) return null;
    let slashFrom = match.index - 1;
    let precedingSlashes = 0;
    while (slashFrom >= 0 && prefix[slashFrom] === '\\') {
        precedingSlashes++;
        slashFrom--;
    }
    return {
        name: match[1],
        escaped: precedingSlashes % 2 !== 0,
    };
}

function normalizeMathSymbolText(text) {
    return [...String(text)].map(character => (
        MATH_SYMBOL_CANONICAL_FORMS.get(character) || character
    )).join('');
}

function isPdfAnnotationMathLetter(character) {
    const mapped = MATH_SYMBOL_CANONICAL_FORMS.get(character)
        || MATH_SYMBOL_CANONICAL_FORMS.get(character.normalize('NFKC'))
        || character.normalize('NFKC');
    return /^\p{Script=Greek}$/u.test(mapped);
}

function markMathLetterWhitespace(text, ignoredOffsets) {
    for (let offset = 0; offset < text.length;) {
        const character = String.fromCodePoint(text.codePointAt(offset));
        const nextOffset = offset + character.length;
        if (!/^\s$/u.test(character)) {
            offset = nextOffset;
            continue;
        }
        let end = nextOffset;
        while (end < text.length && /^\s$/u.test(text[end])) end++;
        let previous = offset;
        while (previous > 0 && /[ \t]/u.test(text[previous - 1])) previous--;
        const before = previous > 0
            ? String.fromCodePoint(
                text.codePointAt(previousCodePointOffset(text, previous))
            )
            : '';
        const after = end < text.length
            ? String.fromCodePoint(text.codePointAt(end))
            : '';
        if (isPdfAnnotationMathLetter(before)
            && isPdfAnnotationMathLetter(after)) {
            markOffsetRange(ignoredOffsets, offset, end - offset);
        }
        offset = end;
    }
}

function markMathematicalWhitespace(text, ignoredOffsets) {
    markMathLetterWhitespace(text, ignoredOffsets);
    for (const pattern of [
        RELATIONAL_OPERATOR_PATTERN,
        LATEX_RELATIONAL_OPERATOR_PATTERN,
    ]) {
        markRelationalOperatorWhitespace(text, pattern, ignoredOffsets);
    }
    for (const match of text.matchAll(EQUATION_NUMBER_WHITESPACE_PATTERN)) {
        markOffsetRange(
            ignoredOffsets,
            match.index + 1,
            match[1].length
        );
    }
    for (const match of text.matchAll(
        OPENING_DELIMITER_SIGNED_NUMBER_WHITESPACE_PATTERN
    )) {
        markOffsetRange(
            ignoredOffsets,
            match.index + 1,
            match[1].length
        );
    }
    for (const match of text.matchAll(SIGNED_NUMBER_WHITESPACE_PATTERN)) {
        markOffsetRange(
            ignoredOffsets,
            match.index + match[0].length - match[1].length,
            match[1].length
        );
    }
    for (const match of text.matchAll(DEGREE_SYMBOL_WHITESPACE_PATTERN)) {
        markOffsetRange(
            ignoredOffsets,
            match.index + match[1].length,
            match[2].length
        );
    }
    for (const match of text.matchAll(
        DEGREE_SYMBOL_UNIT_WHITESPACE_PATTERN
    )) {
        markOffsetRange(
            ignoredOffsets,
            match.index + 1,
            match[1].length
        );
    }
}

function markRelationalOperatorWhitespace(text, pattern, ignoredOffsets) {
    for (const match of text.matchAll(pattern)) {
        const leftLength = match[1].length;
        markOffsetRange(
            ignoredOffsets,
            match.index + leftLength,
            match[2].length
        );
        markOffsetRange(
            ignoredOffsets,
            match.index + leftLength + match[2].length + match[3].length,
            match[4].length
        );
    }
}

function markOffsetRange(offsets, from, length) {
    for (let offset = from; offset < from + length; offset++) {
        offsets.add(offset);
    }
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

function hasInlineSuperscriptContext(text, wrapperFrom) {
    let offset = wrapperFrom - 1;
    while (offset >= 0 && /[ \t]/u.test(text[offset])) offset--;
    return offset >= 0
        && !/[\r\n]/u.test(text[offset])
        && /[\p{L}\p{N})\]}.!?,;:。！？，；：'’”]/u.test(text[offset]);
}
