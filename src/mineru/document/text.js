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
