import { GFM, parser as markdownParser } from '@lezer/markdown';
import { findMarkdownDirectives } from './markdown-directives.js';
import { footnoteMarkKeys } from './footnote-marks.js';

const PARSER = markdownParser.configure(GFM);
const HEADING = /^(?:ATXHeading[1-6]|SetextHeading[12])$/u;
// How many blocks before a note its citing paragraph may be: the note
// follows the paragraph that cites it, or closes the section of its page.
const MAX_BLOCKS_BACK = 40;
// "$^{1}$", "${}^{\dagger}$", "\(^{a}\)": a superscript in math.
const MATH_MARK = /\$(?:\{\s*\})?\^\s*\{\s*([^{}\r\n$]{1,24}?)\s*\}\$|\\\((?:\{\s*\})?\^\s*\{\s*([^{}\r\n]{1,24}?)\s*\}\\\)/gu;
const UNICODE_MARK = /[⁰¹²³⁴⁵⁶⁷⁸⁹]+/gu;
// A printed symbol attached to a word: "results†".
const SYMBOL_MARK = /(?<=[\p{L}\p{N})\].,;:])[†‡§¶]+/gu;
// The mark a note's quote opens with.
const LEADING_MARK = /^>\s?(?:\$(?:\{\s*\})?\^\s*\{\s*([^{}\r\n$]{1,24}?)\s*\}\$|([⁰¹²³⁴⁵⁶⁷⁸⁹]+)|(\\\*|[*†‡§¶]+))/u;

// Pairs every footnote note block (`<!-- mktero-note: footnote -->` and its
// quote) with the mark that cites it: the nearest earlier mark with the same
// key in the paragraphs of its section. A note is paired once and a mark
// cites one note. The result is positions only, so the reader can link the
// two both ways.
//
// Returns { notes: [{ key, label, quote, mark, citation }] } where `mark` is
// the range of the note's own leading mark, and `citation` is
// { from, to, wrapperFrom, wrapperTo } for the citing mark, or null.
export function analyzeMarkdownFootnotes(markdown, tree = PARSER.parse(String(markdown || ''))) {
    const source = String(markdown || '');
    const { notes: directives } = findMarkdownDirectives(source, tree);
    const footnotes = directives.filter(note => note.kind === 'footnote');
    if (!footnotes.length) return { notes: [] };
    const blocks = [];
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
        blocks.push({ name: node.name, from: node.from, to: node.to });
    }
    const claimed = new Set();
    const notes = [];
    for (const footnote of footnotes) {
        const lead = leadingMark(source, footnote.quote);
        if (!lead) continue;
        const citation = findCitingMark(source, blocks, footnote, lead.key, claimed);
        if (citation) claimed.add(citation.wrapperFrom);
        notes.push({
            key: lead.key,
            label: lead.label,
            quote: { ...footnote.quote },
            mark: { from: lead.from, to: lead.to },
            citation,
        });
    }
    return { notes };
}

function leadingMark(source, quote) {
    const text = source.slice(quote.from, quote.to);
    const match = text.match(LEADING_MARK);
    if (!match) return null;
    const raw = match[1] ?? match[2] ?? match[3];
    const keys = footnoteMarkKeys(raw === '\\*' ? '*' : raw);
    if (keys.length !== 1) return null;
    const offset = match[0].length - match[0].replace(/^>\s?/u, '').length;
    return { key: keys[0], label: raw === '\\*' ? '*' : raw, from: quote.from + offset, to: quote.from + match[0].length };
}

// Walks back from the note through the blocks of its section. Another note
// with the same mark, a heading, or a section directive ends the search.
function findCitingMark(source, blocks, footnote, key, claimed) {
    const at = blocks.findIndex(block => block.from === footnote.from);
    if (at < 0) return null;
    for (let index = at - 1, steps = 0; index >= 0 && steps < MAX_BLOCKS_BACK; index--, steps++) {
        const block = blocks[index];
        if (HEADING.test(block.name)) return null;
        if (block.name === 'CommentBlock') {
            const text = source.slice(block.from, block.to);
            if (/mktero-section/u.test(text)) return null;
            continue;
        }
        if (block.name === 'Blockquote' && isNoteQuote(source, blocks, index)) {
            if (leadingMark(source, block)?.key === key) return null;
            continue;
        }
        if (block.name !== 'Paragraph' && block.name !== 'BulletList' && block.name !== 'OrderedList') continue;
        const marks = citingMarks(source, block).filter(mark => mark.keys.includes(key) && !claimed.has(mark.wrapperFrom));
        const mark = marks.at(-1);
        if (mark) return { from: mark.from, to: mark.to, wrapperFrom: mark.wrapperFrom, wrapperTo: mark.wrapperTo };
    }
    return null;
}

function isNoteQuote(source, blocks, index) {
    const previous = blocks[index - 1];
    return previous?.name === 'CommentBlock' && /^<!--\s*mktero-note:/u.test(source.slice(previous.from, previous.to));
}

// Superscript marks in a block, outside inline code.
function citingMarks(source, block) {
    const text = source.slice(block.from, block.to);
    const code = [...text.matchAll(/`[^`\n]*`/gu)].map(match => [match.index, match.index + match[0].length]);
    const inCode = index => code.some(([from, to]) => from <= index && index < to);
    const marks = [];
    for (const match of text.matchAll(MATH_MARK)) {
        if (inCode(match.index)) continue;
        const value = match[1] ?? match[2];
        const contentFrom = match.index + match[0].indexOf(value);
        marks.push({
            keys: footnoteMarkKeys(value),
            from: block.from + contentFrom,
            to: block.from + contentFrom + value.length,
            wrapperFrom: block.from + match.index,
            wrapperTo: block.from + match.index + match[0].length,
        });
    }
    for (const pattern of [UNICODE_MARK, SYMBOL_MARK]) {
        for (const match of text.matchAll(pattern)) {
            if (inCode(match.index)) continue;
            const from = block.from + match.index;
            marks.push({ keys: footnoteMarkKeys(match[0]), from, to: from + match[0].length, wrapperFrom: from, wrapperTo: from + match[0].length });
        }
    }
    return marks.sort((left, right) => left.wrapperFrom - right.wrapperFrom);
}
