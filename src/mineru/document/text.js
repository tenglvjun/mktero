import { spansText } from './ir.js';

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
const STANDALONE_ADDRESS = new RegExp(
    `^(?:www\\.${HOST_LABEL}+[a-z]{2,}(?:${URL_PATH})?|${HOST_LABEL}+[a-z]{2,}${URL_PATH})$`,
    'iu'
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

// Escapes text so Markdown reads it literally. Math is never passed here.
// Brackets stay as written except where they would form a link or image,
// so numeric citations such as "[12]" keep their source form.
export function escapeMarkdownText(text) {
    let output = '';
    const source = String(text || '');
    for (let index = 0; index < source.length; index++) {
        const character = source[index];
        const next = source[index + 1] || '';
        if (character === '\\' || character === '`' || character === '*' || character === '_'
            || character === '$') {
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
export function renderInlineSpans(spans) {
    let output = '';
    for (const span of spans || []) {
        let piece = '';
        if (span.type === 'math') {
            const content = String(span.content || '').replace(/\s*\n\s*/gu, ' ').replace(/\$/gu, '\\$').trim();
            if (content) piece = `$${content}$`;
        }
        else if (span.type === 'text') {
            const content = normalizeOCRText(span.content).replace(/\s+/gu, ' ').trim();
            if (content) piece = escapeMarkdownText(content);
        }
        if (!piece) continue;
        if (!output) output = piece;
        else if (NO_SPACE_BEFORE.test(piece) || NO_SPACE_AFTER.test(output)
            || isCJKCharacter(output.at(-1)) && isCJKCharacter(piece[0])) {
            output += piece;
        }
        else output += ` ${piece}`;
    }
    return output;
}

// MinerU table HTML as one Markdown HTML block: no line breaks (a blank line
// would end the block), `<eq>` math as `$…$`, and nothing that is not a
// complete table. The renderer still sanitizes the markup itself.
export function sanitizeTableHTML(html) {
    if (typeof html !== 'string') return '';
    let output = html.replace(/\r?\n/gu, ' ').trim();
    output = output.replace(/<eq>([\s\S]*?)<\/eq>/giu, (match, content) => {
        const latex = decodeEntities(content).replace(/\$/gu, '\\$').trim();
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
