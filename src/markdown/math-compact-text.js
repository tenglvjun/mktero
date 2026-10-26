import { KATEX_COMMAND_GLYPHS } from './katex-command-glyphs.js';
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
    ['circ', '∘'],
    ['bullet', '•'],
    ['langle', '⟨'],
    ['rangle', '⟩'],
    ['lbrace', ''],
    ['rbrace', ''],
]);

// \max, \log and the other operator names print their name as upright
// letters, which the PDF text layer keeps ("arg max", "log N").
const OPERATOR_NAMES = [
    'arccos', 'arcsin', 'arctan', 'arg', 'cos', 'cosh', 'cot', 'coth', 'csc',
    'deg', 'det', 'dim', 'exp', 'gcd', 'hom', 'inf', 'ker', 'lg', 'lim',
    'liminf', 'limsup', 'ln', 'log', 'max', 'min', 'Pr', 'sec', 'sin', 'sinh',
    'sup', 'tan', 'tanh',
];

// KaTeX's own table first: a command reads as the glyph KaTeX prints for it.
// The hand-written maps after it keep their spelling where they differ.
const COMMAND_SYMBOLS = new Map([
    ...KATEX_COMMAND_GLYPHS,
    ...LATEX_MATH_SYMBOLS,
    ...EXTRA_COMMAND_SYMBOLS,
    ...OPERATOR_NAMES.map(name => [name, name]),
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
    ['∙', '•'],
    ['⩽', '≤'],
    ['⩾', '≥'],
    // OCR reads a math-italic v (𝑣) as \nu, which prints ν. In the
    // last-resort key the two letters are one, as they look in the PDF.
    ['ν', 'v'],
]);

// A font with a nonstandard large-symbol encoding leaves the display
// operators in the PDF text layer as Latin-1 letters on their own: Dream-RSI
// prints \sum as "Í", \prod as "Ö", and \bigcup as "Ð". Only text-layer
// keys read them back, and only when no Latin letter touches them.
const MISENCODED_BIG_OPERATORS = new Map([
    ['Í', '∑'],
    ['Ö', '∏'],
    ['Ð', '⋃'],
]);
const LATIN_LETTER = /\p{Script=Latin}/u;

// Glyphs the two spellings of one formula do not share, so neither key
// keeps them:
// - a hat, caron, macron, acute or grave the PDF text layer keeps as its own
//   spacing glyph ("ˆy" for \hat{y}), where TeX has only the accent command.
//   Accents that decompose to combining marks are already dropped by NFKC.
// - a prime: MinerU writes ' or \prime, the PDF prints ′ (″ is two of them).
// - a star: MinerU writes *, \ast or \star, the PDF prints ∗, ⋆ or ★.
// - a left or right triangle: \triangleright prints ▹ in KaTeX, and a PDF
//   font may keep ⊲ for it, which even points the other way.
const DROPPED_GLYPHS = new Set([
    '\u02C6', '\u02C7', '\u02C9', '\u02CA', '\u02CB',
    '\u02B9', '\u2032',
    '\u2217', '\u22C6', '\u2605',
    '\u22B2', '\u22B3', '\u25B6', '\u25B7', '\u25B9',
    '\u25C0', '\u25C1', '\u25C3',
]);

const KEPT_CHARACTER = /^(?:\p{L}|\p{N}|\p{Sm}|[|·∼∈∉⊂⊃⊆⊇∪∩∅∀∃∂∇∞≈≃≡∝≪≫∘•⟨⟩→←↔⇒⇐↦])$/u;
// What a formula leaves in text once its TeX delimiters are gone: a command,
// a script (x^2, S^*, H_t, x_{1}), a `$`, or a prime on a lone letter (H',
// f''). A possessive (students', Jones') has letters before the quote.
const TEX_MATH_MARKUP = /\\[A-Za-z]+|[_^]\{|\$|(?<=[\p{L}\p{N})\]}])[_^][\p{L}\p{N}*'\\]|(?<![\p{L}\p{N}])\p{L}'+(?![\p{L}\p{N}])/u;
// The glyphs a PDF text layer keeps where the TeX was: Greek and math-italic
// letters (𝑆, 𝛿), the letterlike math symbols (ℎ, ℓ, ℵ), a spacing accent
// (ˆ for \hat), a prime or star, and any math symbol beyond ASCII. ASCII
// + < = > | ~ stay ordinary text.
const PDF_MATH_GLYPHS = /[\p{Script=Greek}\u{1D400}-\u{1D7FF}\u210E\u210F\u2113\u2118\u2135-\u2138\u02C6\u02C7\u02C9\u02CA\u02CB\u2032-\u2034\u2217\u22C6\u2605∣]|(?![\u0000-\u007F])\p{Sm}/u;

/**
 * Index `text` as its math-compact key. `sourceRange(from, length)` maps a
 * range of the key back to the offsets of `text` it came from.
 */
export function createMathCompactTextIndex(text, { pdfTextLayer = false } = {}) {
    const source = String(text ?? '');
    const characters = [];
    const offsets = [];
    const push = (value, from, to) => {
        for (const character of compactCharacters(value)) {
            characters.push(character);
            offsets.push({ from, to });
        }
    };
    const walk = (start, end) => {
        for (let index = start; index < end;) {
            const character = source[index];
            // A base carrying both scripts prints its superscript first in the
            // PDF text layer ("T 𝑘\n𝑡" for T_{t}^{k}): TeX stacks the
            // superscript above the subscript. Read `_{t}^{k}` as `^{k}_{t}`.
            if (character === '_') {
                const subEnd = scriptArgumentEnd(source, index, end);
                let next = subEnd;
                while (next < end && source[next] === ' ') next++;
                if (subEnd > index + 1 && source[next] === '^') {
                    const supEnd = scriptArgumentEnd(source, next, end);
                    if (supEnd > next + 1) {
                        walk(next, supEnd);
                        walk(index + 1, subEnd);
                        index = supEnd;
                        continue;
                    }
                }
            }
            if (character === '\\') {
                const command = /^\\([A-Za-z]+)/u.exec(source.slice(index, index + 64));
                if (command) {
                    const commandEnd = index + command[0].length;
                    const symbol = COMMAND_SYMBOLS.get(command[1]);
                    // An unknown command (\mathcal, \frac, \tag, \quad) carries
                    // no glyph of its own; its argument is read on its own.
                    if (symbol) push(symbol, index, commandEnd);
                    index = commandEnd;
                    continue;
                }
                // \{, \%, \, and the like: the escaped character is markup
                // the rendered formula never prints as a separate glyph.
                index += 2;
                continue;
            }
            if (pdfTextLayer
                && MISENCODED_BIG_OPERATORS.has(character)
                && (index === 0 || /\s/u.test(source[index - 1]))
                && !LATIN_LETTER.test(source[index + 1] || '')) {
                push(MISENCODED_BIG_OPERATORS.get(character), index, index + 1);
                index++;
                continue;
            }
            const codePoint = source.codePointAt(index);
            const width = codePoint > 0xFFFF ? 2 : 1;
            push(String.fromCodePoint(codePoint), index, index + width);
            index += width;
        }
    };
    walk(0, source.length);
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
            // Reordered scripts map out of source order, so take the
            // extent of every character in the range.
            let sourceFrom = Infinity;
            let sourceTo = -Infinity;
            for (let offset = from; offset < from + length; offset++) {
                sourceFrom = Math.min(sourceFrom, offsets[offset].from);
                sourceTo = Math.max(sourceTo, offsets[offset].to);
            }
            return { from: sourceFrom, to: sourceTo };
        },
    };
}

export function hasMathMarkup(text) {
    const value = String(text ?? '');
    return TEX_MATH_MARKUP.test(value) || PDF_MATH_GLYPHS.test(value);
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

// The end of the script argument after the `_` or `^` at `index`: a braced
// group, a command, or one character, after any spaces MinerU leaves
// (`S _ {i}`). Returns `index + 1` when there is no argument before `end`.
function scriptArgumentEnd(source, index, end) {
    let start = index + 1;
    while (start < end && source[start] === ' ') start++;
    if (start >= end) return index + 1;
    if (source[start] === '{') {
        let depth = 0;
        for (let cursor = start; cursor < end; cursor++) {
            if (source[cursor] === '\\') {
                cursor++;
                continue;
            }
            if (source[cursor] === '{') depth++;
            else if (source[cursor] === '}' && --depth === 0) return cursor + 1;
        }
        return index + 1;
    }
    if (source[start] === '\\') {
        const command = /^\\(?:[A-Za-z]+|.)/u.exec(source.slice(start, Math.min(end, start + 64)));
        return command ? start + command[0].length : index + 1;
    }
    if (/[\s}]/u.test(source[start])) return index + 1;
    const codePoint = source.codePointAt(start);
    return start + (codePoint > 0xFFFF ? 2 : 1);
}

function compactCharacters(value) {
    const output = [];
    for (const raw of value.normalize('NFKC')) {
        if (DROPPED_GLYPHS.has(raw)) continue;
        const canonical = CANONICAL_SYMBOLS.get(raw) || raw;
        for (const character of canonical.toLowerCase()) {
            if (KEPT_CHARACTER.test(character)) output.push(character);
        }
    }
    return output;
}
