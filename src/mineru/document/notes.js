import { isPublisherCopyrightParagraph } from '../../markdown/publisher-copyright.js';
import { footnoteMarkKeys } from '../../markdown/footnote-marks.js';
import { BLOCK_KIND, BLOCK_ROLE, blockPlainText, isFloatBlock } from './ir.js';

export const NOTE_KIND = Object.freeze({
    FRONT_MATTER: 'front-matter',
    CONTENT: 'content',
    CHROME: 'chrome',
});

// Article metadata printed as a page footnote: affiliations, contact,
// contributions, funding, dates, and manuscript identifiers.
const FRONT_MATTER = new RegExp([
    '\\b(?:universit(?:y|ies|é|ät|à|ad|at)|institut(?:e|o|ion)?|department|faculty|school of|college|laborator(?:y|ies)|',
    'hospital|cent(?:er|re) for|research (?:unit|organization|group)|organi[sz]ation|academy|is (?:now )?with the)\\b',
    '|\\bcorrespond(?:ence|ing)\\b',
    '|\\bcontributed equally\\b|\\bequal contribution\\b|\\bco-?(?:first|last|corresponding)\\b|\\bcore contributor\\b',
    '|\\b(?:funded|supported) by\\b|\\bfunding\\b|\\bgrant (?:no|number)s?\\b',
    '|\\b(?:received|accepted|revised|published)\\b[^.]{0,40}\\b(?:19|20)\\d{2}\\b|\\bversion of record\\b',
    '|\\bmanuscript\\b|\\bauthor contributions?\\b|\\b(?:no )?(?:disclosures|conflicts? of interest|competing interests?)\\b',
    '|\\bkeywords?\\b|\\bpublished simultaneously\\b|\\btask force\\b',
].join(''), 'iu');
// Metadata that says the note is about the authors, whichever page it is on.
// A bare e-mail address counts only in an unmarked note: a numbered footnote
// can name an address to write to.
const STRONG_FRONT_MATTER = /\bcorrespond(?:ence|ing)\b|\bcontributed equally\b|\b(?:received|accepted)\b[^.]{0,40}\b(?:19|20)\d{2}\b/iu;
const CONTACT = /\be-?mail\b|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/iu;
const COPYRIGHT_OR_DOI = /©|\(c\)\s*(?:19|20)\d{2}|\bcopyright\b|\blicen[cs]ed under\b|\bcreative commons\b|^(?:https?:\/\/)?(?:dx\.)?doi\.org\/|\bISSN\b/iu;
// "^{1}", "^{\dagger}", "*", "†", "¹": the mark a footnote opens with.
const NOTE_MARK = /^\s*(?:\{\s*\}\s*)?(?:\^\s*\{\s*([^{}]{1,24})\s*\}|\^\s*([0-9a-z*]))|^\s*([*†‡§¶#]+|[¹²³⁴⁵⁶⁷⁸⁹⁰]+)(?=\s|\S)/u;
// An author-year reference entry MinerU discarded as a page footnote.
const AUTHOR_YEAR_ENTRY = /^\p{Lu}[\p{L}'’-]+,\s*(?:\p{Lu}\.\s*){1,3}(?:,|and|&)[\s\S]*\((?:19|20)\d{2}[a-z]?\)/u;

// Page footnotes MinerU discarded are sorted into article metadata, notes
// the reader needs, and page decoration. Each keeps the mark it opens with,
// so a note can be placed after the paragraph that cites it.
export function classifyPageNote(block) {
    const text = blockPlainText(block).trim();
    const marker = noteMarker(block);
    if (marker) block.noteMarker = marker;
    if (!text) return (block.noteKind = NOTE_KIND.CHROME);
    if (STRONG_FRONT_MATTER.test(text) || !marker && CONTACT.test(text)) return (block.noteKind = NOTE_KIND.FRONT_MATTER);
    if (COPYRIGHT_OR_DOI.test(text) || isPublisherCopyrightParagraph(text)) return (block.noteKind = NOTE_KIND.CHROME);
    if (!marker && AUTHOR_YEAR_ENTRY.test(text)) block.referenceCandidate = true;
    if (FRONT_MATTER.test(text) && (block.pageIndex === 0 || !marker)) {
        return (block.noteKind = NOTE_KIND.FRONT_MATTER);
    }
    // The first page carries article metadata; a marked note there that is
    // not metadata is a footnote of the text.
    if (block.pageIndex === 0 && !marker && !block.referenceCandidate) return (block.noteKind = NOTE_KIND.FRONT_MATTER);
    return (block.noteKind = NOTE_KIND.CONTENT);
}

export function noteMarker(block) {
    const firstLine = block?.fragments?.[0]?.lines?.[0];
    const first = firstLine?.spans?.find(span => String(span.content || '').trim());
    if (!first) return null;
    const content = String(first.content).trim();
    const source = first.type === 'math' ? (content.startsWith('^') || content.startsWith('{') ? content : `^{${content}}`) : content;
    const match = source.match(NOTE_MARK);
    if (!match) return null;
    if (first.type !== 'math' && !match[3]) return null;
    const keys = markerKeys(match[1] ?? match[2] ?? match[3]);
    return keys.length === 1 ? keys[0] : null;
}

// Normalized marks of a superscript: "1,3" → ["1", "3"], "\dagger" → ["†"].
export const markerKeys = footnoteMarkKeys;

// Marks a body span cites: superscript math and attached symbols.
function citedMarks(block) {
    const marks = new Set();
    for (const fragment of block.fragments || []) {
        for (const line of fragment.lines || []) {
            for (const span of line.spans || []) {
                const content = String(span.content || '');
                if (span.type === 'math') {
                    for (const match of content.matchAll(/\^\s*\{\s*([^{}]{1,24})\s*\}|\^\s*([0-9*])/gu)) {
                        for (const key of markerKeys(match[1] ?? match[2])) marks.add(key);
                    }
                }
                else if (span.type === 'text') {
                    for (const match of content.matchAll(/\p{L}[)\].,;:]?([†‡§¶]+|[¹²³⁴⁵⁶⁷⁸⁹⁰]+)/gu)) {
                        for (const key of markerKeys(match[1])) marks.add(key);
                    }
                }
            }
        }
    }
    return marks;
}

const ANCHOR_ROLES = new Set([BLOCK_ROLE.BODY, BLOCK_ROLE.REFERENCE]);

function isAnchor(block) {
    return ANCHOR_ROLES.has(block.role)
        && (block.kind === BLOCK_KIND.TEXT || block.kind === BLOCK_KIND.LIST || block.kind === BLOCK_KIND.REFERENCE);
}

function onPage(block, pageIndex) {
    return block.pageIndex === pageIndex || (block.fragments || []).some(fragment => fragment.pageIndex === pageIndex);
}

// A content note follows the first paragraph of its page that cites its mark
// (a paragraph continued from the previous page counts for both pages, and
// the previous page is searched next). Without a cited mark it follows the
// last block of its page in the section of the page's last paragraph, so it
// never moves past a heading or onto a later page; on a page with no
// paragraph (a full-page table) it follows the page's last float. A note
// that finds none of these stays where MinerU put it. Runs after stitching,
// so a note never separates two halves of one paragraph.
export function placePageNotes(ir) {
    const notes = ir.blocks.filter(block => block.role === BLOCK_ROLE.PAGE_NOTE && block.noteKind === NOTE_KIND.CONTENT);
    if (!notes.length) return ir;
    let blocks = ir.blocks.filter(block => !notes.includes(block));
    const after = new Map();
    const placements = [];
    for (const note of notes) {
        const anchor = markedAnchor(blocks, note) || sectionEnd(blocks, note) || lastFloat(blocks, note);
        if (!anchor) {
            placements.push({ id: note.id, pageIndex: note.pageIndex, rule: 'unplaced' });
            continue;
        }
        note.anchorId = anchor.block.id;
        if (!after.has(anchor.block)) after.set(anchor.block, []);
        after.get(anchor.block).push(note);
        placements.push({ id: note.id, pageIndex: note.pageIndex, rule: anchor.rule, anchor: anchor.block.id });
    }
    const output = [];
    for (const block of blocks) {
        output.push(block);
        if (after.has(block)) output.push(...after.get(block));
    }
    // Unplaced notes keep their position relative to the blocks of their page.
    for (const note of notes.filter(item => !item.anchorId)) {
        const index = ir.blocks.indexOf(note);
        const previous = ir.blocks.slice(0, index).reverse().find(block => output.includes(block));
        output.splice(previous ? output.indexOf(previous) + 1 : 0, 0, note);
    }
    blocks = output;
    ir.blocks = blocks;
    ir.diagnostics.notePlacements = placements;
    return ir;
}

function markedAnchor(blocks, note) {
    if (!note.noteMarker) return null;
    for (const pageIndex of [note.pageIndex, note.pageIndex - 1]) {
        const block = blocks.find(candidate => isAnchor(candidate) && onPage(candidate, pageIndex)
            && citedMarks(candidate).has(note.noteMarker));
        if (block) return { block, rule: 'marker' };
    }
    return null;
}

function lastFloat(blocks, note) {
    const block = blocks.filter(candidate => isFloatBlock(candidate) && candidate.pageIndex === note.pageIndex).at(-1);
    return block ? { block, rule: 'float' } : null;
}

function sectionEnd(blocks, note) {
    let last = -1;
    for (const [index, block] of blocks.entries()) {
        if (isAnchor(block) && onPage(block, note.pageIndex)) last = index;
    }
    if (last < 0) return null;
    let end = last;
    for (let index = last + 1; index < blocks.length; index++) {
        const block = blocks[index];
        if (block.role === BLOCK_ROLE.HEADING || !onPage(block, note.pageIndex)) break;
        if (block.role !== BLOCK_ROLE.CHROME && block.kind !== BLOCK_KIND.DISCARDED) end = index;
    }
    return { block: blocks[end], rule: 'section-end' };
}

// A discarded author-year entry on a page of the references section, after
// its heading, is a reference. Needs the reference roles from the reading
// order.
export function restoreDiscardedReferences(ir) {
    const headingAt = ir.blocks.findIndex(block => block.referenceHeading);
    if (headingAt < 0) return ir;
    const referencePages = new Set(ir.blocks
        .filter(block => block.role === BLOCK_ROLE.REFERENCE)
        .map(block => block.pageIndex));
    for (const [index, block] of ir.blocks.entries()) {
        if (!block.referenceCandidate || block.role !== BLOCK_ROLE.PAGE_NOTE) continue;
        if (index < headingAt || !referencePages.has(block.pageIndex)) continue;
        block.kind = BLOCK_KIND.REFERENCE;
        block.role = BLOCK_ROLE.REFERENCE;
        delete block.noteKind;
        delete block.referenceCandidate;
        ir.diagnostics.notePlacements ||= [];
        ir.diagnostics.notePlacements.push({ id: block.id, pageIndex: block.pageIndex, rule: 'reference' });
    }
    return ir;
}
