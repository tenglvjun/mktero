// Section numbering shared by the Markdown outline and the MinerU document
// pipeline. "standard" papers number with digits and letters (1, 1.2, A,
// A.1); IEEE papers use Roman sections with lettered subsections.

const NUMBERED_HEADING_PATTERN = /^(\d+(?:\.\d+)*)(?:\.|\s|$)/;
const LETTER_HEADING_PATTERN = /^([A-Z](?:\.\d+)*)\.(?:\s|$)/;
const LETTER_SUBHEADING_PATTERN = /^([A-Z]\.\d+(?:\.\d+)*)(?:\s|$)/;
const ROMAN_HEADING_PATTERN = /^(I|II|III|IV|V|VI|VII|VIII|IX|X|XI|XII|XIII|XIV|XV|XVI|XVII|XVIII|XIX|XX)\.(?:\s|$)/i;
const ROMAN_VALUES = new Map([['I', 1], ['V', 5], ['X', 10]]);

export function outlineNumberingScheme(texts) {
    return texts.some(text => ROMAN_HEADING_PATTERN.test(String(text).trim()))
        ? 'ieee'
        : 'standard';
}

export function numberedHeadingDepth(text, scheme = 'standard') {
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

// The heading number as a list of ordinals ("VIII." -> [8], "A.2" -> [1, 2],
// "3.1.4" -> [3, 1, 4]), or null for an unnumbered heading.
export function parseHeadingNumber(text) {
    const trimmed = String(text).trim();
    const roman = ROMAN_HEADING_PATTERN.exec(trimmed);
    if (roman) return { kind: 'roman', parts: [romanValue(roman[1])] };
    const letter = LETTER_SUBHEADING_PATTERN.exec(trimmed) || LETTER_HEADING_PATTERN.exec(trimmed);
    if (letter) {
        const [head, ...rest] = letter[1].split('.');
        return { kind: 'letter', parts: [head.charCodeAt(0) - 64, ...rest.map(Number)] };
    }
    const number = NUMBERED_HEADING_PATTERN.exec(trimmed);
    if (number) return { kind: 'arabic', parts: number[1].split('.').map(Number) };
    return null;
}

// True when `next` is the sibling after `previous` (II after I, 2.4 after
// 2.3) or its first child (2.1 after 2).
export function followsHeadingNumber(previous, next) {
    if (!previous || !next || previous.kind !== next.kind) return false;
    const a = previous.parts;
    const b = next.parts;
    if (a.length === b.length) {
        return a.slice(0, -1).every((value, index) => value === b[index]) && b.at(-1) === a.at(-1) + 1;
    }
    return b.length === a.length + 1 && a.every((value, index) => value === b[index]) && b.at(-1) === 1;
}

export function clampOutlineLevel(depth) {
    return Math.min(6, Math.max(1, depth));
}

function romanValue(text) {
    let total = 0;
    const letters = text.toUpperCase();
    for (let index = 0; index < letters.length; index++) {
        const value = ROMAN_VALUES.get(letters[index]);
        const next = ROMAN_VALUES.get(letters[index + 1]) || 0;
        total += value < next ? -value : value;
    }
    return total;
}
