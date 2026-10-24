import { BLOCK_KIND, BLOCK_ROLE, blockPlainText, fragmentText, isFloatBlock } from './ir.js';
import { NOTE_KIND } from './notes.js';

export const SECTION_KIND = Object.freeze({
    ARTICLE_INFO: 'article-info',
    AUTHOR_BIOGRAPHIES: 'author-biographies',
    REPORTING_SUMMARY: 'reporting-summary',
});

// Labels of a journal's first-page sidebar ("EDITED BY", "CITATION") and the
// badges printed with them. The label alone is a heading in MinerU's output.
// Keywords stay with the abstract they follow.
const SIDEBAR_HEADING = /^(?:open access|check for updates|citation|copyright|edited by|reviewed by|\*?correspondence|specialty section|received|accepted|published|article history|article info(?:rmation)?)$/iu;
const KEYWORDS_HEADING = /^(?:keywords?|key words|index terms)$/iu;
// A first-page line that is article metadata rather than the reading text:
// a labeled sidebar field, a copyright line, a badge.
const METADATA_LINE = new RegExp([
    '^(?:\\*\\s*)?(?:edited by|reviewed by|\\*?correspondence|corresponding author|citation|specialty section)\\b',
    '|^(?:academic editor|editor|received|accepted|revised|published|copyright|data availability|funding',
    '|competing interests|peer review history|article history)\\s*[:：]',
    '|^(?:received|accepted|revised|published)\\s+(?:\\d{1,2}\\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)',
    '|^©\\s*(?:19|20)\\d{2}\\b|^(?:check for updates|open access)$|^published in final edited form as\\b',
].join(''), 'iu');
const AFFILIATION = /\b(?:universit(?:y|ies|é|ät|à|ad|at)|institut(?:e|o|ion)?|department|faculty|school of|college|laborator(?:y|ies)|hospital|cent(?:er|re) for|research (?:unit|organization|group)|academy)\b/iu;
const CONTACT = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/u;
// Addresses separated by spaces or punctuation; the separator keeps two
// addresses from being read as one in exponentially many ways.
const CONTACT_ONLY = /^(?:e-?mail\s*[:：]?\s*)?[\w.+-]+@[\w-]+(?:\.[\w-]+)+(?:[\s,;]+[\w.+-]+@[\w-]+(?:\.[\w-]+)+)*[\s,;]*$/iu;
const FRONT_MATTER_WORDS = /\bcorrespond|\bco-?(?:first|last)\b|\bcore contributor\b|\bequal(?:ly)? contribut|\bwork (?:was )?done\b/iu;
// "^{1}", "{}^{a,*}", "*", "¹" at the start of the first line; or a plain
// "1 " / "e " before an affiliation.
const LEADING_MATH_MARK = /^\s*(?:\{\s*\}\s*)?\^/u;
const LEADING_TEXT_MARK = /^[*†‡§¶#¹²³⁴⁵⁶⁷⁸⁹⁰]/u;
const LEADING_PLAIN_MARK = /^(?:\d{1,2}|[a-z])\s+\p{Lu}/u;
const SECTION_START = /^(?:abstract|summary|background|introduction|highlights|key points)\b/iu;
const MAX_METADATA_WORDS = 60;
const MAX_FIELD_WORDS = 200;
const MIN_PROSE_WORDS = 40;
const MIN_PROSE_LOWERCASE_SHARE = 0.5;
const MAX_NAME_LOWERCASE_SHARE = 0.3;
const NAME_PARTICLES = new Set(['of', 'and', 'the', 'for', 'de', 'di', 'da', 'do', 'du', 'des', 'del', 'della', 'la', 'le', 'van', 'von', 'at', 'in', 'on', 'und', 'et', 'y', 'e', 'and/or']);

const BIOGRAPHY_HEADING = /\bbiograph(?:y|ies)\b|^about the authors?$/iu;
// The opening of an IEEE-style author biography.
const BIOGRAPHY_TEXT = /\breceived (?:the|his|her) (?:B\.?\s?S|M\.?\s?S|Ph\.?\s?D|B\.?\s?Eng|M\.?\s?Eng|B\.?\s?Sc|M\.?\s?Sc|bachelor|master|doctoral)|\bis (?:currently )?(?:a|an) (?:full |associate |assistant )?(?:professor|research|lecturer|postdoctoral|ph\.?\s?d)|\b(?:his|her|their) (?:research|current) interests? /iu;
const MIN_BIOGRAPHIES = 2;

const REPORTING_HEADING = /^reporting summary$/iu;
const REPORTING_START = /\bwishes to improve the reproducibility\b/iu;
// The checklist's own banner lines printed above its heading.
const REPORTING_PREAMBLE = /^(?:nature (?:portfolio|research)|corresponding author\(s\)|last updated by author\(s\))/iu;

// Groups blocks that are not the reading text into collapsible sections:
// the article metadata of the first page, the author biographies after the
// references, and Nature's reporting summary. Each section's blocks are made
// contiguous; its first and last block carry `sectionStart` / `sectionEnd`
// so the serializer writes the directives around them. Runs last, after
// stitching and note placement.
export function groupSections(ir) {
    const sections = [];
    const claimed = new Set();
    for (const find of [reportingSummary, authorBiographies, articleInfo]) {
        const section = find(ir.blocks, claimed);
        if (!section?.blocks.length) continue;
        for (const block of section.blocks) claimed.add(block);
        sections.push(section);
    }
    for (const section of sections) {
        for (const block of section.blocks) block.sectionKind = section.kind;
        section.blocks[0].sectionStart = section.kind;
        section.blocks.at(-1).sectionEnd = section.kind;
    }
    ir.diagnostics.sections = sections.map(section => ({
        kind: section.kind,
        blocks: section.blocks.map(block => block.id),
        ...(section.anchor ? { anchor: section.anchor } : {}),
    }));
    return ir;
}

// --- Article information -------------------------------------------------

// Front-matter page notes, and first-page metadata lines and sidebar labels,
// gathered under the title and author line, before the abstract.
function articleInfo(blocks, claimed) {
    keepKeywordsVisible(blocks);
    const members = new Set();
    for (const block of blocks) {
        if (claimed.has(block)) continue;
        if (block.role === BLOCK_ROLE.PAGE_NOTE && block.noteKind === NOTE_KIND.FRONT_MATTER) members.add(block);
        else if (isFirstPageMetadata(block)) members.add(block);
    }
    addSidebarValues(blocks, members, claimed);
    fillBetweenMembers(blocks, members, claimed);
    addBadges(blocks, members, claimed);
    // A note whose mark only the title or the author line cites is about the
    // authors: it goes with the metadata, not under the author line.
    let rest = blocks.filter(block => !members.has(block));
    let at = articleInfoPosition(rest);
    const head = new Set(rest.slice(0, at).filter(block => onPage(block, 0)).map(block => block.id));
    for (const block of rest) {
        if (block.role === BLOCK_ROLE.PAGE_NOTE && block.noteKind === NOTE_KIND.CONTENT && block.pageIndex === 0
            && block.anchorId && head.has(block.anchorId) && !claimed.has(block)) {
            block.noteKind = NOTE_KIND.FRONT_MATTER;
            block.authorNote = true;
            members.add(block);
        }
    }
    if (![...members].some(isWritten)) return null;
    rest = blocks.filter(block => !members.has(block));
    at = articleInfoPosition(rest);
    // The first page's metadata lines, then its footnotes, as printed.
    const inOrder = blocks.filter(block => members.has(block));
    const isNote = block => block.role === BLOCK_ROLE.PAGE_NOTE || block.keywordsNote;
    const ordered = [...inOrder.filter(block => !isNote(block)), ...inOrder.filter(isNote)];
    blocks.splice(0, blocks.length, ...rest.slice(0, at), ...ordered, ...rest.slice(at));
    return { kind: SECTION_KIND.ARTICLE_INFO, blocks: ordered, anchor: rest[at]?.id || null };
}

function isFirstPageMetadata(block) {
    if (!onlyOnPage(block, 0)) return false;
    const text = blockPlainText(block).trim();
    if (!text) return false;
    if (block.role === BLOCK_ROLE.HEADING) return !block.documentTitle && SIDEBAR_HEADING.test(text);
    if (block.role !== BLOCK_ROLE.BODY || block.kind !== BLOCK_KIND.TEXT) return false;
    const words = wordCount(text);
    if (METADATA_LINE.test(text)) return words <= MAX_FIELD_WORDS;
    if (words > MAX_METADATA_WORDS || isProse(text)) return false;
    if (CONTACT_ONLY.test(text)) return true;
    // "¹ Department of …", "* Corresponding author …", "e Escola Superior
    // …": a marked line of an affiliation list.
    const mark = leadingMark(block);
    if (mark === 'plain') return AFFILIATION.test(text);
    return Boolean(mark) && (AFFILIATION.test(text) || CONTACT.test(text) || FRONT_MATTER_WORDS.test(text) || isNameLike(text));
}

function leadingMark(block) {
    const first = block.fragments?.[0]?.lines?.[0]?.spans?.find(span => String(span.content || '').trim());
    if (!first) return null;
    const content = String(first.content).trim();
    if (first.type === 'math') return LEADING_MATH_MARK.test(content) ? 'math' : null;
    if (LEADING_TEXT_MARK.test(content)) return 'symbol';
    return LEADING_PLAIN_MARK.test(content) ? 'plain' : null;
}

// MinerU discards the keyword list printed under a "KEYWORDS" label as a
// page footnote; it stays with the label, in the reading text: the note
// right below a keywords heading moves to follow it.
function keepKeywordsVisible(blocks) {
    const headings = blocks.filter(block => block.role === BLOCK_ROLE.HEADING && block.bbox
        && KEYWORDS_HEADING.test(blockPlainText(block).trim()));
    for (const heading of headings) {
        const note = blocks.find(block => block.role === BLOCK_ROLE.PAGE_NOTE && block.noteKind === NOTE_KIND.FRONT_MATTER
            && block.pageIndex === heading.pageIndex && block.bbox && directlyBelow(heading.bbox, block.bbox));
        if (!note) continue;
        note.role = BLOCK_ROLE.BODY;
        note.kind = BLOCK_KIND.TEXT;
        note.keywordsNote = true;
        blocks.splice(blocks.indexOf(note), 1);
        blocks.splice(blocks.indexOf(heading) + 1, 0, note);
    }
}

const MAX_LABEL_GAP = 30;

function directlyBelow(upper, lower) {
    const gap = lower[1] - upper[3];
    return gap >= -MAX_LABEL_GAP / 2 && gap <= MAX_LABEL_GAP && lower[0] < upper[2] && upper[0] < lower[2];
}

// The "Check for updates" badge: its text, and the uncaptioned first-page
// image it is printed on, go with the metadata.
function addBadges(blocks, members, claimed) {
    for (const block of blocks) {
        if (claimed.has(block) || block.pageIndex !== 0 || !/^check for updates$/iu.test(blockPlainText(block).trim())) continue;
        members.add(block);
        const image = blocks.find(item => !claimed.has(item) && isPhoto(item) && item.pageIndex === 0
            && (item.id === block.attachedTo || intersects(item.bbox, block.bbox)));
        if (image) members.add(image);
    }
}

function intersects(left, right) {
    return Boolean(left && right) && left[0] < right[2] && right[0] < left[2] && left[1] < right[3] && right[1] < left[3];
}

// The paragraph printed right below a sidebar label that takes a value
// ("CITATION", "EDITED BY") is that value, whether or not the text repeats
// the label. Prose below a label is the article's text.
const VALUE_LABEL = /^(?:citation|copyright|edited by|reviewed by|\*?correspondence|specialty section|received|accepted|published)$/iu;
function addSidebarValues(blocks, members, claimed) {
    for (const label of [...members]) {
        if (label.role !== BLOCK_ROLE.HEADING || !label.bbox || !VALUE_LABEL.test(blockPlainText(label).trim())) continue;
        const value = blocks
            .filter(block => !members.has(block) && !claimed.has(block) && onlyOnPage(block, 0)
                && block.role === BLOCK_ROLE.BODY && block.kind === BLOCK_KIND.TEXT && block.bbox
                && directlyBelow(label.bbox, block.bbox))
            .sort((left, right) => left.bbox[1] - right.bbox[1])[0];
        const text = value ? blockPlainText(value) : '';
        if (value && wordCount(text) <= MAX_FIELD_WORDS && !isProse(text)) members.add(value);
    }
}

// A short first-page line between two metadata lines (the second line of an
// address) belongs with them.
function fillBetweenMembers(blocks, members, claimed) {
    const flow = blocks.filter(block => onlyOnPage(block, 0) && block.role !== BLOCK_ROLE.CHROME && block.kind !== BLOCK_KIND.DISCARDED);
    for (let index = 1; index < flow.length - 1; index++) {
        const block = flow[index];
        if (members.has(block) || claimed.has(block) || block.role !== BLOCK_ROLE.BODY) continue;
        if (members.has(flow[index - 1]) && members.has(flow[index + 1]) && wordCount(blockPlainText(block)) <= 25) {
            members.add(block);
        }
    }
}

// After the title and the lines below it (authors, affiliations), before
// the first section heading, float, or paragraph of prose on the first page.
function articleInfoPosition(rest) {
    const first = rest.findIndex(block => onPage(block, 0) && isWritten(block));
    if (first < 0) return 0;
    const titleAt = rest.findIndex(block => block.documentTitle && block.pageIndex === 0);
    let index = titleAt >= 0 ? titleAt + 1 : first;
    for (; index < rest.length; index++) {
        const block = rest[index];
        if (!isWritten(block)) continue;
        // An uncaptioned image above the abstract is a logo or a badge.
        if (isPhoto(block)) continue;
        if (!onPage(block, 0) || block.role === BLOCK_ROLE.HEADING || isFloatBlock(block)) break;
        const text = blockPlainText(block).trim();
        if (SECTION_START.test(text) || isProse(text)) break;
    }
    return index;
}

// Prose reads mostly in lowercase words; a list of names and places does
// not, however many initials end in a period.
function isProse(text) {
    const words = String(text || '').split(/\s+/u).filter(word => /\p{L}/u.test(word));
    if (words.length < MIN_PROSE_WORDS) return false;
    return words.filter(word => /^\P{L}*\p{Ll}/u.test(word)).length / words.length >= MIN_PROSE_LOWERCASE_SHARE;
}

function isNameLike(text) {
    const words = String(text || '').split(/\s+/u).filter(word => /\p{L}/u.test(word) && !NAME_PARTICLES.has(word.toLowerCase()));
    if (!words.length) return false;
    return words.filter(word => /^\P{L}*\p{Ll}/u.test(word)).length / words.length <= MAX_NAME_LOWERCASE_SHARE;
}

// --- Author biographies --------------------------------------------------

// The biographies after the references: from a "Biography" heading, or the
// first biography paragraph after the last reference, to the end of the
// document or the next heading of the same or a higher level. The heading
// itself stays outside, so the outline keeps it. Uncaptioned photos on a
// biography page move in front of the biography beside them.
function authorBiographies(blocks, claimed) {
    const lastReference = blocks.findLastIndex(block => block.role === BLOCK_ROLE.REFERENCE);
    const headingAt = blocks.findIndex((block, index) => index > lastReference - 1 && block.role === BLOCK_ROLE.HEADING
        && BIOGRAPHY_HEADING.test(blockPlainText(block).trim()));
    const heading = blocks[headingAt];
    let start = headingAt >= 0 ? headingAt + 1 : blocks.findIndex((block, index) => index > lastReference
        && isBiography(block));
    if (start < 0 || lastReference < 0 && headingAt < 0) return null;
    let end = blocks.length;
    for (let index = start; index < blocks.length; index++) {
        const block = blocks[index];
        if (block.role === BLOCK_ROLE.HEADING && (!heading || (block.level || 2) <= (heading.level || 2))) {
            end = index;
            break;
        }
    }
    const range = blocks.slice(start, end).filter(block => !claimed.has(block));
    // A biography MinerU read as the footnote of the photo above it is a
    // paragraph of the section; the photo then stays where it is.
    const captioned = new Set();
    for (const block of range) {
        if (!isPhoto(block) || !(block.children || []).some(child => child.kind === 'footnote'
            && BIOGRAPHY_TEXT.test((child.fragments || []).map(fragment => fragmentText(fragment, { math: false })).join(' ')))) continue;
        block.footnotesAsText = true;
        captioned.add(block);
    }
    for (const block of range) {
        if (block.role !== BLOCK_ROLE.FLOAT_NOTE || !block.attachedTo || !BIOGRAPHY_TEXT.test(blockPlainText(block))) continue;
        const photo = range.find(item => item.id === block.attachedTo);
        if (!photo || !isPhoto(photo)) continue;
        captioned.add(photo);
        block.role = BLOCK_ROLE.BODY;
        block.kind = BLOCK_KIND.TEXT;
        block.biographyNote = true;
        delete block.attachedTo;
    }
    const biographies = range.filter(block => isBiography(block) || block.footnotesAsText);
    if (biographies.length < MIN_BIOGRAPHIES) return null;
    const pages = new Set(biographies.flatMap(blockPages));
    // A photo MinerU read among the references of the same page still
    // belongs to the biography beside it.
    const photos = blocks.filter(block => !claimed.has(block) && !captioned.has(block) && isPhoto(block)
        && pages.has(block.pageIndex) && (range.includes(block) || biographies.some(paragraph => besides(block, paragraph))));
    const ordered = [];
    const placed = new Set();
    const leading = photos.filter(photo => !biographies.some(paragraph => besides(photo, paragraph)));
    ordered.push(...leading);
    leading.forEach(photo => placed.add(photo));
    for (const block of range) {
        if (photos.includes(block)) continue;
        for (const photo of photos) {
            if (!placed.has(photo) && isBiography(block) && besides(photo, block)) {
                ordered.push(photo);
                placed.add(photo);
            }
        }
        ordered.push(block);
    }
    const moved = new Set(ordered);
    const before = blocks.slice(0, start).filter(block => !moved.has(block));
    const after = blocks.slice(end).filter(block => !moved.has(block));
    blocks.splice(0, blocks.length, ...before, ...ordered, ...after);
    return { kind: SECTION_KIND.AUTHOR_BIOGRAPHIES, blocks: ordered };
}

function isBiography(block) {
    return block.role === BLOCK_ROLE.BODY && BIOGRAPHY_TEXT.test(blockPlainText(block));
}

function isPhoto(block) {
    return block.kind === BLOCK_KIND.IMAGE && block.role === BLOCK_ROLE.FLOAT
        && !(block.children || []).some(child => child.kind === 'caption');
}

// The photo sits level with the paragraph on the same page.
function besides(photo, paragraph) {
    const fragment = (paragraph.fragments || []).find(item => item.pageIndex === photo.pageIndex && item.bbox);
    if (!fragment || !photo.bbox) return false;
    const top = Math.max(photo.bbox[1], fragment.bbox[1]);
    const bottom = Math.min(photo.bbox[3], fragment.bbox[3]);
    return bottom > top;
}

// --- Reporting summary ---------------------------------------------------

// Nature's reporting summary checklist: from its banner lines above the
// "Reporting Summary" heading to the end of the document. Only the checklist
// itself, recognized by the sentence that opens it, not a Methods
// subsection with the same title.
function reportingSummary(blocks) {
    const headingAt = blocks.findIndex((block, index) => block.role === BLOCK_ROLE.HEADING
        && REPORTING_HEADING.test(blockPlainText(block).trim())
        && blocks.slice(index + 1, index + 4).some(next => REPORTING_START.test(blockPlainText(next))));
    if (headingAt < 0) return null;
    let start = headingAt;
    while (start > 0) {
        const previous = blocks[start - 1];
        if (previous.pageIndex !== blocks[headingAt].pageIndex) break;
        if (!REPORTING_PREAMBLE.test(blockPlainText(previous).trim()) && isWritten(previous)) break;
        start -= 1;
    }
    const section = blocks.slice(start);
    return { kind: SECTION_KIND.REPORTING_SUMMARY, blocks: section };
}

// --- Helpers -------------------------------------------------------------

// Whether the serializer writes something for the block.
function isWritten(block) {
    if (block.role === BLOCK_ROLE.CHROME) return false;
    if (block.role === BLOCK_ROLE.PAGE_NOTE) return block.noteKind !== NOTE_KIND.CHROME;
    if (block.role === BLOCK_ROLE.FLOAT_NOTE) return Boolean(block.attachedTo);
    return block.kind !== BLOCK_KIND.DISCARDED || block.role === BLOCK_ROLE.PAGE_NOTE;
}

function blockPages(block) {
    return [...new Set((block.fragments || []).map(fragment => fragment.pageIndex))];
}

function onPage(block, pageIndex) {
    return blockPages(block).includes(pageIndex) || block.pageIndex === pageIndex;
}

function onlyOnPage(block, pageIndex) {
    const pages = blockPages(block);
    return block.pageIndex === pageIndex && pages.every(page => page === pageIndex);
}

function wordCount(text) {
    return String(text || '').split(/\s+/u).filter(Boolean).length;
}
