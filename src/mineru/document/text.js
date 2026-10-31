import { spansText } from './ir.js';
import {
    escapeMinerULinkDestination,
    normalizeMarkdownLinkURL,
    safeMarkdownLinkURL,
} from '../../markdown/markdown-links.js';

const WORD = /[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu;
const TRAILING_HYPHEN_WORD = /([\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*)-$/u;
const LEADING_WORD = /^([\p{L}\p{N}]+)/u;
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/u;
const MIN_STANDALONE_LENGTH = 3;

// Word counts of the document's own text. Line-final hyphens are decided by
// how the document writes the word elsewhere: "post-training" stays
// hyphenated in a paper that always writes it that way, while "archi-" +
// "tectures" becomes one word.
export function createHyphenationVocabulary(ir) {
    const counts = new Map();
    const add = text => {
        for (const match of String(text || '').matchAll(WORD)) {
            const word = match[0].toLowerCase();
            counts.set(word, (counts.get(word) || 0) + 1);
        }
    };
    for (const block of ir?.blocks || []) {
        for (const fragment of block.fragments || []) {
            for (const line of fragment.lines || []) add(spansText(line.spans, { math: false }));
        }
        for (const child of block.children || []) {
            for (const fragment of child.fragments || []) {
                for (const line of fragment.lines || []) add(spansText(line.spans, { math: false }));
            }
        }
    }
    return { count: word => counts.get(String(word).toLowerCase()) || 0 };
}

export function isCJKCharacter(character) {
    return CJK.test(character || '');
}

// Joins two pieces of one paragraph that a line, column, or page break
// separated. Returns the joined text and how a trailing hyphen was handled.
export function joinTextParts(left, right, vocabulary = null) {
    const head = String(left || '').replace(/\s+$/u, '');
    const tail = String(right || '').replace(/^\s+/u, '');
    if (!head) return { text: tail, hyphen: null };
    if (!tail) return { text: head, hyphen: null };
    const hyphenated = TRAILING_HYPHEN_WORD.exec(head);
    if (hyphenated && !/[-‐]-$/u.test(head)) {
        const next = LEADING_WORD.exec(tail);
        if (next && /^\p{Ll}/u.test(next[1])) {
            const keep = keepHyphen(hyphenated[1], next[1], vocabulary);
            return {
                text: keep ? head + tail : head.slice(0, -1) + tail,
                hyphen: keep ? 'kept' : 'removed',
            };
        }
        if (next) return { text: head + tail, hyphen: 'kept' };
    }
    if (/[–—]$/u.test(head)) return { text: head + tail, hyphen: null };
    if (isCJKCharacter(head.at(-1)) && isCJKCharacter(tail[0])) return { text: head + tail, hyphen: null };
    return { text: `${head} ${tail}`, hyphen: null };
}

export function keepHyphen(first, second, vocabulary) {
    if (!vocabulary) return false;
    const hyphenated = `${first}-${second}`;
    const closed = `${first.replaceAll('-', '')}${second}`;
    const hyphenCount = vocabulary.count(hyphenated);
    const closedCount = vocabulary.count(closed);
    if (hyphenCount > closedCount) return true;
    if (closedCount > 0) return false;
    // The broken occurrence itself counts once for each half, so a half is
    // a standalone word only when it also appears somewhere else.
    const lastPart = first.split('-').at(-1);
    return lastPart.length >= MIN_STANDALONE_LENGTH
        && second.length >= MIN_STANDALONE_LENGTH
        && vocabulary.count(lastPart) > 1
        && vocabulary.count(second) > 1;
}

const LIGATURES = new Map([
    ['ﬀ', 'ff'], ['ﬁ', 'fi'], ['ﬂ', 'fl'], ['ﬃ', 'ffi'], ['ﬄ', 'ffl'], ['ﬅ', 'st'], ['ﬆ', 'st'],
]);
const SPACING_MARKS = new Map([
    ['¨', '\u0308'], ['´', '\u0301'], ['ˆ', '\u0302'], ['˜', '\u0303'], ['¸', '\u0327'], ['ˇ', '\u030c'],
]);
const SPACING_MARK = /(\p{L})?(\s?)([¨´ˆ˜¸ˇ])(\s?)(\p{L})/gu;
const LINE_START_ESCAPE = /^(?:(#{1,6})(?=\s|$)|(>)|([-+*])(?=\s)|(\d{1,9})([.)])(?=\s)|(=+|-{2,}|\*{3,}|_{3,})(?=\s*$)|(`{3,}|~{3,}))/u;
const HOST_LABEL = '(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)';
const URL_PATH = '\\/[^\\s()\\[\\]<>"\']*';
const HTTP_SCHEME = 'https?:\\/\\/';
const HOST = `${HOST_LABEL}+[a-z]{2,}`;
const STANDALONE_ADDRESS = new RegExp(
    `^(?:(?:${HTTP_SCHEME})?www\\.${HOST}(?:${URL_PATH})?|${HTTP_SCHEME}${HOST}(?:${URL_PATH})?|${HOST}${URL_PATH})$`,
    'iu'
);
const URL_TEXT = new RegExp(
    `(?:https?:\\/\\/|www\\.)[^\\s<>"'()[\\]]+|${HOST_LABEL}+[a-z]{2,}\\/[^\\s<>"'()[\\]]+`,
    'giu'
);
const NO_SPACE_BEFORE = /^[.,;:!?%)\]}’”»，。；：！？、）】]/u;
const NO_SPACE_AFTER = /[([{‘“«（【]$/u;

// OCR text repairs that never change meaning: Unicode composition, Latin
// ligatures, and a spacing accent that OCR split from its letter
// ("Schl ¨ ogl" -> "Schlögl") when the letters compose to one character.
export function normalizeOCRText(text) {
    let output = String(text || '').normalize('NFC');
    output = output.replace(/[ﬀ-ﬆ]/gu, character => LIGATURES.get(character) || character);
    // A mark set off by a space is an OCR split; "John´s" is an apostrophe.
    output = output.replace(SPACING_MARK, (match, before, left, mark, right, letter) => {
        if (!left && !right) return match;
        const composed = `${letter}${SPACING_MARKS.get(mark)}`.normalize('NFC');
        if (composed.length !== 1) return match;
        return `${before || ''}${composed}`;
    });
    return output;
}

// Brackets stay as written in ordinary prose except where they would form a
// link or image. Link labels escape them unconditionally because the label is
// inside Markdown link syntax.
function escapeMarkdownTextSegment(text, { linkLabel = false } = {}) {
    let output = '';
    const source = String(text || '');
    for (let index = 0; index < source.length; index++) {
        const character = source[index];
        const next = source[index + 1] || '';
        if (character === '\\' || character === '`' || character === '*' || character === '$'
            || linkLabel && (character === '[' || character === ']')
            || character === '_' && (!linkLabel || !isLiteralUnderscoreRun(source, index))) {
            output += `\\${character}`;
        }
        else if (character === '~' && next === '~') output += '\\~';
        else if (character === '<' && /[A-Za-z/!?]/u.test(next)) output += '\\<';
        else if (character === '&' && /^&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]+);/iu.test(source.slice(index))) {
            output += '&amp;';
        }
        else if (character === '!' && next === '[') output += '\\!';
        else if (character === ']' && (next === '(' || next === ':' || next === '[')) output += '\\]';
        else if (character === '[' && next === '^') output += '\\[';
        else output += character;
    }
    return output;
}

function isLiteralUnderscoreRun(source, index) {
    let start = index;
    while (start > 0 && source[start - 1] === '_') start--;
    let end = index + 1;
    while (end < source.length && source[end] === '_') end++;
    return isWordCharacter(source[start - 1]) && isWordCharacter(source[end]);
}

function isWordCharacter(value) {
    return Boolean(value) && /[\p{L}\p{N}]/u.test(value);
}

export function escapeMarkdownLinkLabel(text) {
    return escapeMarkdownTextSegment(text, { linkLabel: true });
}

function escapeMarkdownURL(text) {
    // URL data is not Markdown prose. Normalize older escaped output first,
    // then keep legal URL punctuation such as '_' out of the Markdown escape
    // path so it cannot leak into the href. Other syntax characters remain
    // escaped to keep URL-like text such as `/$x$` out of inline math.
    return escapeMarkdownTextSegment(normalizeMarkdownLinkURL(text))
        .replaceAll('\\_', '_');
}

export function escapeMarkdownText(text) {
    const source = String(text || '');
    let output = '';
    let cursor = 0;
    for (const match of source.matchAll(URL_TEXT)) {
        output += escapeMarkdownTextSegment(source.slice(cursor, match.index));
        output += escapeMarkdownURL(match[0]);
        cursor = match.index + match[0].length;
    }
    return output + escapeMarkdownTextSegment(source.slice(cursor));
}

// Escapes what would start a Markdown block at the beginning of a line:
// headings, quotes, list markers, rules, setext underlines, and fences.
export function escapeLineStart(text) {
    const match = LINE_START_ESCAPE.exec(text);
    if (!match) return text;
    if (match[1] || match[2] || match[3]) return `\\${text}`;
    if (match[4]) return `${match[4]}\\${text.slice(match[4].length)}`;
    return `\\${text}`;
}

export function isStandaloneAddress(text) {
    return STANDALONE_ADDRESS.test(String(text || '').trim());
}

// Inline Markdown for one line of spans: escaped text and `$…$` math, with
// no space before closing punctuation or after an opening bracket.
function renderMarkdownLinkLabel(label, url) {
    const destination = escapeMinerULinkDestination(url);
    return destination ? { label, linkURL: destination } : { label, linkURL: null };
}

export function renderInlineSpans(spans) {
    const segments = [];
    for (const span of spans || []) {
        let label = '';
        let rawContent = '';
        if (span.type === 'math') label = renderInlineMath(span.content);
        else if (span.type === 'text') {
            rawContent = normalizeOCRText(span.content).replace(/\s+/gu, ' ');
            const content = rawContent.trim();
            if (content) {
                label = safeMarkdownLinkURL(span.linkURL)
                    ? escapeMarkdownLinkLabel(content)
                    : span.linkURL
                        ? escapeMarkdownTextSegment(content)
                        : escapeMarkdownText(content);
            }
        }
        if (!label) {
            if (span.type === 'text' && span.exactSpacing && rawContent && segments.length) {
                segments.at(-1).rawContent += rawContent;
            }
            continue;
        }
        const link = span.linkURL
            ? renderMarkdownLinkLabel(label, span.linkURL)
            : { label, linkURL: null };
        const exactSpacing = Boolean(span.exactSpacing);
        const previous = segments.at(-1);
        const exactBoundary = Boolean(span.type === 'text' && previous?.type === 'text'
            && span.exactSpacing && previous.exactSpacing);
        const separator = !previous ? ''
            : exactBoundary
                ? /\s$/u.test(previous.rawContent) || /^\s/u.test(rawContent) ? ' ' : ''
                : NO_SPACE_BEFORE.test(label) || NO_SPACE_AFTER.test(previous.label)
                    || isCJKCharacter(previous.label.at(-1)) && isCJKCharacter(label[0])
                    ? '' : ' ';
        if (previous && previous.linkURL === link.linkURL && previous.type === span.type) {
            previous.label += separator + label;
            previous.rawContent += rawContent;
            previous.exactSpacing ||= exactSpacing;
        }
        else {
            segments.push({ label, linkURL: link.linkURL, separator, rawContent, exactSpacing,
                type: span.type });
        }
    }
    return segments.map(segment => `${segment.separator}${segment.linkURL
        ? `[${segment.label}](${segment.linkURL})`
        : segment.label}`).join('');
}

const MATH_ABBREVIATION = /^\\(?:mathrm|text|textrm)\s*\{\s*(i\s*\.\s*e|e\s*\.\s*g|etc)\s*\.\s*\}$/u;
const MATH_LEADING_PUNCTUATION = /^([,.;:])\s*/u;
const MATH_TRAILING_PUNCTUATION = /(?<!\\)\s*([,.;:])$/u;

// Inline math as `$…$`. Sentence punctuation that OCR put inside the math at
// either end moves outside it, and math that is only "i.e.", "e.g." or "etc."
// becomes text. A trailing `\,` or `\;` is a spacing command and stays.
function renderInlineMath(value) {
    let content = String(value || '').replace(/\s*\n\s*/gu, ' ').trim();
    const abbreviation = content.match(MATH_ABBREVIATION);
    if (abbreviation) return `${abbreviation[1].replace(/\s+/gu, '')}.`;
    let before = '';
    let after = '';
    const leading = content.match(MATH_LEADING_PUNCTUATION);
    if (leading) {
        before = leading[1];
        content = content.slice(leading[0].length);
    }
    const trailing = content.match(MATH_TRAILING_PUNCTUATION);
    if (trailing) {
        after = trailing[1];
        content = content.slice(0, -trailing[0].length);
    }
    content = escapeMathDollars(content).trim();
    if (!content) return before + after;
    return `${before}${before ? ' ' : ''}$${content}$${after}`;
}

// A `$` inside math would end it; one already escaped (`\$`) stays as it is,
// and every other TeX escape (`\\`, `\{`) is kept whole.
export function escapeMathDollars(latex) {
    return String(latex).replace(/\\[\s\S]|\$/gu, match => (match === '$' ? '\\$' : match));
}

// MinerU table HTML as one Markdown HTML block: no line breaks (a blank line
// would end the block), `<eq>` math as `$…$`, and nothing that is not a
// complete table. The renderer still sanitizes the markup itself.
export function sanitizeTableHTML(html) {
    if (typeof html !== 'string') return '';
    let output = html.replace(/\r?\n/gu, ' ').trim();
    output = output.replace(/<eq>([\s\S]*?)<\/eq>/giu, (match, content) => {
        const latex = escapeMathDollars(decodeEntities(content)).trim();
        return latex ? ` $${latex}$ ` : '';
    });
    if (!/^<table\b/iu.test(output) || !/<\/table>$/iu.test(output)) return '';
    return output;
}

function decodeEntities(text) {
    return String(text)
        .replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"')
        .replace(/&#39;/gu, "'").replace(/&amp;/gu, '&');
}
