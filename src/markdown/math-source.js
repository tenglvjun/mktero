// Formula copying hands the clipboard plain LaTeX, not the Markdown wrapper
// around it. Every delimiter form the reader can render is listed here, longest
// first so `$$` is never mistaken for two inline `$` markers.
const MATH_DELIMITER_PAIRS = Object.freeze([
    Object.freeze({ open: '$$', close: '$$' }),
    Object.freeze({ open: '\\[', close: '\\]' }),
    Object.freeze({ open: '\\(', close: '\\)' }),
    Object.freeze({ open: '$', close: '$', guarded: true }),
]);

/**
 * Strip the Markdown math delimiters from one formula source.
 *
 * The reader renders KaTeX from normalized source, so the caller usually
 * already holds the bare TeX. Saved snapshots keep the delimiters as text
 * (`$$E = mc^2$$`), and a display formula's widget source is the raw match
 * including them, so both paths need this.
 *
 * A single `$` pair is only unwrapped when nothing inside still looks like a
 * delimiter, so a paragraph that merely starts and ends with `$` is returned
 * unchanged instead of being silently truncated.
 */
export function stripMathDelimiters(source) {
    const text = String(source ?? '').trim();
    if (!text) return '';
    for (const { open, close, guarded } of MATH_DELIMITER_PAIRS) {
        if (text.length <= open.length + close.length) continue;
        if (!text.startsWith(open) || !text.endsWith(close)) continue;
        const inner = text.slice(open.length, text.length - close.length);
        if (guarded && hasUnescapedDollar(inner)) continue;
        const stripped = inner.trim();
        return stripped || text;
    }
    return text;
}

function hasUnescapedDollar(source) {
    return /(^|[^\\])\$/u.test(source);
}
