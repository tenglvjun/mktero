const NUMERIC_CITATION_CONTENT = /^\d+(?:\s*[-–—]\s*\d+)?(?:\s*[,，;；]\s*\d+(?:\s*[-–—]\s*\d+)?)*$/u;

export function isNumericCitationContent(text) {
    return NUMERIC_CITATION_CONTENT.test(text);
}

export function isLikelyNumericSuperscriptExponent(body, from, value) {
    if (!/^\s*\d+\s*$/u.test(value)) return false;
    const preceding = String(body).slice(0, from);
    if (/\d[ \t]*$/u.test(preceding)) return true;
    const baseMatch = /([\p{L}_][\p{L}\p{N}_]*)([ \t]*)$/u.exec(preceding);
    if (!baseMatch) return false;
    const base = baseMatch[1];
    const spacing = baseMatch[2];
    return base.length === 1 || (base.length === 2 && !spacing);
}


const GREEK_LETTER_NAMES = new Map(Object.entries({
    'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'ε': 'epsilon', 'ζ': 'zeta',
    'η': 'eta', 'θ': 'theta', 'ι': 'iota', 'κ': 'kappa', 'λ': 'lambda', 'μ': 'mu',
    'ν': 'nu', 'ξ': 'xi', 'ο': 'omicron', 'π': 'pi', 'ρ': 'rho', 'σ': 'sigma', 'ς': 'sigma',
    'τ': 'tau', 'υ': 'upsilon', 'φ': 'phi', 'χ': 'chi', 'ψ': 'psi', 'ω': 'omega',
    'Δ': 'delta', 'Γ': 'gamma', 'Θ': 'theta', 'Λ': 'lambda', 'Ξ': 'xi', 'Π': 'pi',
    'Σ': 'sigma', 'Υ': 'upsilon', 'Φ': 'phi', 'Ψ': 'psi', 'Ω': 'omega',
    '∇': 'nabla', '∂': 'partial', '∞': 'infty', '≤': 'le', '≥': 'ge', '≠': 'ne',
    '×': 'times', '·': 'cdot', '±': 'pm', '→': 'to', '←': 'leftarrow', '∈': 'in',
}));
const MATH_FONT_COMMAND = /\\?(?:mathbf|boldsymbol|mathrm|mathit|mathcal|mathbb|mathsf|bm)/gu;
// Sizing and style commands carry no letters of their own and OCR often adds
// or drops them around the same delimiter.
const MATH_SIZING_COMMAND = /\\(?:biggl|biggr|Biggl|Biggr|displaystyle|scriptscriptstyle|scriptstyle|textstyle|nolimits|limits|bigl|bigr|Bigl|Bigr|bigg|Bigg|big|Big|left|right|middle)/gu;

// The layout JSON and its rendered Markdown can differ in whitespace,
// hyphenation, Greek glyphs and math font commands. This last-resort key
// drops all of them so the same sentence still matches on both sides.
export function normalizeCompactText(value) {
    let mapped = '';
    for (const character of String(value)) {
        mapped += GREEK_LETTER_NAMES.get(character) || character;
    }
    return mapped
        .replace(MATH_SIZING_COMMAND, '')
        .replace(MATH_FONT_COMMAND, '')
        .toLowerCase()
        // A dash or dot between digits carries meaning ("10-20" is not
        // "1020", "0.68" is not "068"), so keep a marker for those.
        .replace(/(?<=\p{N})[-\u00ad\u2010-\u2015\u2212](?=\p{N})/gu, '\uE001')
        .replace(/(?<=\p{N})\.(?=\p{N})/gu, '\uE000')
        .replace(/[^\p{L}\p{N}\uE000\uE001]+/gu, '');
}

export function normalizeText(text) {
    return String(text)
        .normalize('NFKC')
        .replace(/\s+/gu, ' ')
        .trim();
}

export function normalizeTolerantText(value) {
    return String(value)
        .normalize('NFKC')
        .replace(/[\u2018\u2019]/gu, '\'')
        .replace(/[\u201c\u201d]/gu, '"')
        .replace(/\\chi(?![\p{L}\p{N}])/gu, '\u03c7')
        .replace(/\\([%$#&_{}~])/gu, '$1')
        .replace(/[$}{]/gu, '')
        .replace(/\^(?=[\p{L}\p{N}])/gu, '')
        .replace(/(\p{L}{2})[-\u2010\u2011](?=\p{L}{2})/gu, '$1')
        .replace(/[\u2010-\u2014\u2212]/gu, '-')
        .replace(/\s+([,.;:!?%)\]])/gu, '$1')
        .replace(/\s+/gu, ' ')
        .trim();
}

export function createNormalizedTextIndex(
    text,
    sourceOffsetAt = offset => offset,
    normalizeCharacter = character => character.normalize('NFKC')
) {
    const output = [];
    const sourceStarts = [];
    const sourceEnds = [];
    for (let offset = 0; offset < text.length;) {
        const character = String.fromCodePoint(text.codePointAt(offset));
        const nextOffset = offset + character.length;
        const result = normalizeCharacter(character, offset, text);
        const normalized = typeof result === 'string' ? result : result.text;
        const normalizedSourceFrom = typeof result === 'string'
            ? offset
            : result.sourceFrom;
        const normalizedSourceTo = typeof result === 'string'
            ? nextOffset
            : result.sourceTo;
        const sourceFrom = sourceOffsetAt(normalizedSourceFrom);
        const sourceTo = sourceOffsetAt(normalizedSourceTo - 1) + 1;
        if (/^\s+$/u.test(normalized)) {
            if (output.at(-1) === ' ') {
                sourceEnds[sourceEnds.length - 1] = sourceTo;
            }
            else {
                output.push(' ');
                sourceStarts.push(sourceFrom);
                sourceEnds.push(sourceTo);
            }
        }
        else {
            for (let unit = 0; unit < normalized.length; unit++) {
                output.push(normalized[unit]);
                sourceStarts.push(sourceFrom);
                sourceEnds.push(sourceTo);
            }
        }
        offset = nextOffset;
    }
    return {
        text: output.join(''),
        normalizedRangeForSourceRange(from, to) {
            if (!Number.isSafeInteger(from)
                || !Number.isSafeInteger(to)
                || from < 0
                || to < from) {
                throw new TypeError('Invalid source text range');
            }
            return {
                from: firstIndexGreaterThan(sourceEnds, from),
                to: firstIndexAtLeast(sourceStarts, to),
            };
        },
        sourceRange(from, length) {
            return {
                from: sourceStarts[from],
                to: sourceEnds[from + length - 1],
            };
        },
    };
}

function firstIndexAtLeast(values, target) {
    let low = 0;
    let high = values.length;
    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (values[middle] < target) low = middle + 1;
        else high = middle;
    }
    return low;
}

function firstIndexGreaterThan(values, target) {
    let low = 0;
    let high = values.length;
    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (values[middle] <= target) low = middle + 1;
        else high = middle;
    }
    return low;
}

export function findTextOccurrences(source, target, limit = 10_000) {
    if (!target || !Number.isInteger(limit) || limit <= 0) {
        return { offsets: [], truncated: false };
    }
    const offsets = [];
    let from = 0;
    const step = Math.max(1, target.length);
    while (from <= source.length - target.length) {
        const index = source.indexOf(target, from);
        if (index < 0) break;
        offsets.push(index);
        from = index + step;
        if (offsets.length === limit) {
            return {
                offsets,
                truncated: source.indexOf(target, from) >= 0,
            };
        }
    }
    return { offsets, truncated: false };
}
