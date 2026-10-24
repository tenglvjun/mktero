import { LATEX_MATH_SYMBOLS } from './pdf-annotation-text.js';

// A last-resort comparison key for text that carries mathematics. The same
// formula reaches Mktero in several spellings: MinerU writes TeX
// ("a_{t} \sim \pi_{\theta}(a \mid \tau)"), the PDF text layer keeps the
// glyphs ("at ∼ πθ (a | τ)"), and either side may add or drop spacing,
// delimiters, font commands, and equation tags. Reducing both to the letters,
// digits, and math symbols they display lets one formula match the other
// while every kept character still maps to its own source offset.

const MIN_MATH_COMPACT_MATCH_LENGTH = 12;
const MAX_MATH_COMPACT_CANDIDATES = 10_000;

const EXTRA_COMMAND_SYMBOLS = new Map([
    ['mid', '|'],
    ['vert', '|'],
    ['lvert', '|'],
    ['rvert', '|'],
    ['leq', '≤'],
    ['le', '≤'],
    ['geq', '≥'],
    ['ge', '≥'],
    ['neq', '≠'],
    ['ne', '≠'],
    ['pm', '±'],
    ['mp', '∓'],
    ['ast', '*'],
    ['star', '⋆'],
    ['circ', '∘'],
    ['bullet', '•'],
    ['prime', '′'],
    ['langle', '⟨'],
    ['rangle', '⟩'],
    ['lbrace', ''],
    ['rbrace', ''],
]);

const COMMAND_SYMBOLS = new Map([
    ...LATEX_MATH_SYMBOLS,
    ...EXTRA_COMMAND_SYMBOLS,
]);

// Glyphs that print the same symbol under different code points.
const CANONICAL_SYMBOLS = new Map([
    ['∣', '|'],
    ['ǀ', '|'],
    ['ϵ', 'ε'],
    ['ϑ', 'θ'],
    ['ϰ', 'κ'],
    ['ϖ', 'π'],
    ['ϱ', 'ρ'],
    ['ς', 'σ'],
    ['ϕ', 'φ'],
    ['∆', 'Δ'],
    ['∑', 'Σ'],
    ['∏', 'Π'],
    ['−', '-'],
    ['∶', ':'],
    ['⋅', '·'],
]);

const KEPT_CHARACTER = /^(?:\p{L}|\p{N}|\p{Sm}|[|·∼∈∉⊂⊃⊆⊇∪∩∅∀∃∂∇∞≈≃≡∝≪≫′⋆∘•⟨⟩→←↔⇒⇐↦])$/u;
const MATH_MARKUP = /\\[A-Za-z]+|[_^]\{|\$|[\p{Script=Greek}∼∈∉⊂⊃⊆⊇∪∩∑∏∫∂∇∞≈≃≡∝≤≥≠±∣]/u;

/**
 * Index `text` as its math-compact key. `sourceRange(from, length)` maps a
 * range of the key back to the offsets of `text` it came from.
 */
export function createMathCompactTextIndex(text) {
    const source = String(text ?? '');
    const characters = [];
    const offsets = [];
    const push = (value, from, to) => {
        for (const character of compactCharacters(value)) {
            characters.push(character);
            offsets.push({ from, to });
        }
    };
    for (let index = 0; index < source.length;) {
        const character = source[index];
        if (character === '\\') {
            const command = /^\\([A-Za-z]+)/u.exec(source.slice(index, index + 64));
            if (command) {
                const end = index + command[0].length;
                const symbol = COMMAND_SYMBOLS.get(command[1]);
                // An unknown command (\mathcal, \frac, \tag, \quad) carries
                // no glyph of its own; its argument is read on its own.
                if (symbol) push(symbol, index, end);
                index = end;
                continue;
            }
            // \{, \%, \, and the like: the escaped character is markup
            // the rendered formula never prints as a separate glyph.
            index += 2;
            continue;
        }
        const codePoint = source.codePointAt(index);
        const width = codePoint > 0xFFFF ? 2 : 1;
        push(String.fromCodePoint(codePoint), index, index + width);
        index += width;
    }
    return {
        text: characters.join(''),
        sourceRange(from, length) {
            if (!Number.isSafeInteger(from)
                || !Number.isSafeInteger(length)
                || from < 0
                || length <= 0
                || from + length > offsets.length) {
                return null;
            }
            return {
                from: offsets[from].from,
                to: offsets[from + length - 1].to,
            };
        },
    };
}

export function hasMathMarkup(text) {
    return MATH_MARKUP.test(String(text ?? ''));
}

export function mathCompactText(text) {
    return createMathCompactTextIndex(text).text;
}

/**
 * Find every occurrence of `needle`'s math-compact key in `index`. Returns
 * null when the key is too short to identify a passage or the search would
 * be unbounded.
 */
export function findMathCompactOccurrences(index, needle) {
    const key = typeof needle === 'string' ? needle : '';
    if ([...key].length < MIN_MATH_COMPACT_MATCH_LENGTH) return null;
    const offsets = [];
    let from = index.text.indexOf(key);
    while (from >= 0) {
        offsets.push(from);
        if (offsets.length > MAX_MATH_COMPACT_CANDIDATES) return null;
        from = index.text.indexOf(key, from + 1);
    }
    return offsets;
}

function compactCharacters(value) {
    const output = [];
    for (const raw of value.normalize('NFKC')) {
        const canonical = CANONICAL_SYMBOLS.get(raw) || raw;
        for (const character of canonical.toLowerCase()) {
            if (KEPT_CHARACTER.test(character)) output.push(character);
        }
    }
    return output;
}
