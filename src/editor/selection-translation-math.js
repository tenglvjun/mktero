import { parser } from '@lezer/markdown';
import { findDisplayMathMatches, findInlineMathMatches } from '../markdown/markdown-html.js';
import { portableMathMarkdown } from '../markdown/portable-markdown.js';

export function selectionTranslationInput(segments) {
    return segments.map(segment => segment.type === 'math'
        ? portableMathMarkdown(segment.tex, segment.display) : segment.text).join('');
}

const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const TEX_SCRIPT = /^([_^])\s*(?:\{\s*([A-Za-z0-9])\s*\}|([A-Za-z0-9]))$/u;

// When a provider drops the delimiters, allow only the selected formula,
// including harmless changes such as "s _ {t}" becoming "s_t".
function bareFormulaPattern(tex) {
    if (/\\(?:text|mbox|hbox|operatorname|verb| )/u.test(tex)) return escapePattern(tex);
    const tokens = tex.match(/\\[A-Za-z]+|\\.|[_^]\s*(?:\{\s*[A-Za-z0-9]\s*\}|[A-Za-z0-9])|[A-Za-z0-9]+|[^\s]/gu);
    return tokens.map(token => {
        const script = TEX_SCRIPT.exec(token);
        if (!script) return escapePattern(token);
        const value = script[2] || script[3];
        return escapePattern(script[1]) + '[ \\t]*(?:\\{[ \\t]*' + value + '[ \\t]*\\}|' + value + ')';
    }).join('[ \\t]*');
}

export function bareSelectionFormulaPatterns(segments) {
    const groups = new Map();
    let length = 0;
    for (const { type, tex, display } of segments || []) {
        if (type !== 'math' || tex.length > 1000 || !/\\[A-Za-z]+|[_^]\s*\{|(?<!\w)[A-Za-z][_^][A-Za-z0-9](?!\w)/u.test(tex)) continue;
        const pattern = bareFormulaPattern(tex);
        if (groups.get(display)?.has(pattern)) continue;
        // Delimited formulas always render; bound the optional recovery work.
        if (length + pattern.length > 24_000) break;
        length += pattern.length;
        if (!groups.has(display)) groups.set(display, new Set());
        groups.get(display).add(pattern);
    }
    return Array.from(groups, ([display, patterns]) => {
        const choices = [...patterns].sort((a, b) => b.length - a.length).join('|');
        return { display, pattern: new RegExp('(?<![a-zA-Z0-9_\\\\])(?:' + choices + ')(?![a-zA-Z0-9_])', 'gu') };
    });
}

export function translationResultMathSegments(text, known) {
    if (!/[$\\_^]/u.test(text)) return null;
    const matches = [];
    const addProse = (from, to) => {
        const source = text.slice(from, to);
        for (const match of findDisplayMathMatches(source)) {
            matches.push({ from: from + match.start, to: from + match.start + match.raw.trimEnd().length,
                tex: match.text, display: true });
        }
        for (const match of findInlineMathMatches(source)) {
            matches.push({ from: from + match.start, to: from + match.end, tex: match.text, display: false });
        }
        for (const { display, pattern } of known) {
            for (const match of source.matchAll(pattern)) {
                matches.push({ tex: match[0], display, from: from + match.index, to: from + match.index + match[0].length });
            }
        }
    };
    let cursor = 0;
    if (/`|^ {0,3}~~~|^(?: {4}|\t)/mu.test(text)) {
        parser.parse(text).iterate({ enter(node) {
            if (!['InlineCode', 'FencedCode', 'CodeBlock'].includes(node.name)) return;
            addProse(cursor, node.from);
            cursor = node.to;
            return false;
        } });
    }
    addProse(cursor, text.length);
    if (!matches.length) return null;
    matches.sort((a, b) => a.from - b.from || b.to - a.to);
    const segments = [];
    cursor = 0;
    for (const match of matches) {
        if (match.from < cursor) continue;
        if (cursor < match.from) segments.push({ type: 'text', text: text.slice(cursor, match.from) });
        segments.push({ type: 'math', tex: match.tex, display: match.display });
        cursor = match.to;
    }
    if (cursor < text.length) segments.push({ type: 'text', text: text.slice(cursor) });
    return segments;
}
