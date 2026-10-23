import { parseAcademicFigureCaption } from '../../markdown/markdown-figures.js';
import {
    clampOutlineLevel,
    followsHeadingNumber,
    numberedHeadingDepth,
    outlineNumberingScheme,
    parseHeadingNumber,
} from '../../markdown/heading-numbering.js';
import { BLOCK_KIND, BLOCK_ROLE, blockPlainText } from './ir.js';
import { markReferenceSections } from './reading-order.js';

const MAX_HEADING_WORDS = 20;
const MAX_PROMOTED_WORDS = 12;
const MIN_UPPERCASE_SHARE = 0.8;
const MAX_TITLE_PAGE = 1;
const CAPTION_START = /^(?:fig(?:ure)?s?\.?|tables?|algorithms?)\s*[A-Z]?\d/iu;
// Heading styles from the PDF: levels 2 to 5, and the share of headings
// whose nesting must make sense for the styles to be trusted.
const MAX_STYLE_RANKS = 4;
const MIN_NESTED_SHARE = 0.9;
const MIN_STYLED_SHARE = 0.8;
// End matter is a top-level section whatever type the journal sets it in.
const BACK_MATTER = /^(?:references?(?: and notes)?|bibliography|works cited|literature cited|acknowledge?ments?|funding(?: information)?|conflicts? of interest(?: statement)?|competing interests?|declaration of (?:competing )?interests?|author contributions?|credit author(?:ship)? contributions?(?: statement)?|data(?: and code)? availability(?: statement)?|code availability|abbreviations|supplementary (?:materials?|information|data)|appendix\b.*|additional information|ethics(?: statement| declarations)?|online content|disclosures?)$/iu;

// Heading depth comes from the section number, because MinerU reports only
// two title levels. The paper title is the tallest level-1 title on the
// first page that has one; numbered sections nest by their number; other
// headings are top-level sections. A body line that continues the section
// numbering in capitals ("VIII. BIOGRAPHY SECTION" after "VII.") is promoted,
// and a "heading" that is a figure caption or a whole sentence is demoted.
export function assignHeadingLevels(ir) {
    for (const block of ir.blocks) {
        if (block.role !== BLOCK_ROLE.HEADING) continue;
        const text = blockPlainText(block).trim();
        if (!text || wordCount(text) > MAX_HEADING_WORDS
            || CAPTION_START.test(text) && parseAcademicFigureCaption(text)) {
            block.role = BLOCK_ROLE.BODY;
            block.kind = BLOCK_KIND.TEXT;
            block.demotedHeading = true;
        }
    }
    if (promoteNumberedLines(ir.blocks)) markReferenceSections(ir);
    const headings = ir.blocks.filter(block => block.role === BLOCK_ROLE.HEADING);
    const title = findTitle(headings);
    const scheme = outlineNumberingScheme(headings.map(block => blockPlainText(block)));
    for (const block of headings) {
        if (block === title) {
            block.level = 1;
            block.documentTitle = true;
            continue;
        }
        const depth = numberedHeadingDepth(blockPlainText(block), scheme);
        block.level = clampOutlineLevel(1 + (depth || 1));
    }
    return ir;
}

// Levels the headings of a paper without section numbers by their type
// (see styleLevels). Runs after the sections are grouped: the headings of a
// collapsible section (a reporting summary has its own styles) keep their
// level and do not take part.
export function levelHeadingsByStyle(ir) {
    const headings = ir.blocks.filter(block => block.role === BLOCK_ROLE.HEADING && !block.documentTitle);
    if (headings.some(block => parseHeadingNumber(blockPlainText(block)))) return ir;
    const levels = styleLevels(headings.filter(block => !block.sectionKind));
    if (!levels) return ir;
    for (const [block, level] of levels) block.level = level;
    ir.diagnostics.headingStyles = true;
    return ir;
}

// A paper without section numbers sets its heading levels in type: a larger
// or a different font for a section than for a subsection. With the PDF's
// fonts, every style used by two or more headings is a level, larger sizes
// first and, at one size, the style seen first. A heading in a style of its
// own takes the level of the closest recurring style no larger than it. The
// result is kept only when nearly every heading follows a heading one level
// up; otherwise all stay top-level sections.
function styleLevels(headings) {
    const styled = headings.map(block => ({ block, style: headingStyle(block) }));
    if (styled.length < 3 || styled.filter(item => item.style).length < MIN_STYLED_SHARE * styled.length) return null;
    const counts = new Map();
    const firstAt = new Map();
    for (const [index, { style }] of styled.entries()) {
        if (!style) continue;
        counts.set(style.key, (counts.get(style.key) || 0) + 1);
        if (!firstAt.has(style.key)) firstAt.set(style.key, { index, size: style.size });
    }
    const recurring = [...counts].filter(([, count]) => count >= 2)
        .map(([key]) => ({ key, ...firstAt.get(key) }))
        .sort((left, right) => right.size - left.size || left.index - right.index)
        .slice(0, MAX_STYLE_RANKS);
    if (recurring.length < 2) return null;
    const rank = new Map(recurring.map((style, index) => [style.key, index]));
    const levels = new Map();
    for (const { block, style } of styled) {
        let level = 2;
        if (BACK_MATTER.test(blockPlainText(block).trim().replace(/[:.]$/u, ''))) level = 2;
        else if (style && rank.has(style.key)) level = 2 + rank.get(style.key);
        else if (style) {
            const closest = recurring.findIndex(candidate => candidate.size <= style.size);
            level = 2 + (closest < 0 ? recurring.length - 1 : closest);
        }
        levels.set(block, level);
    }
    if (levels.get(styled[0].block) !== 2) return null;
    let nested = 0;
    let deeper = 0;
    const open = [];
    for (const { block } of styled) {
        const level = levels.get(block);
        while (open.length && open.at(-1) >= level) open.pop();
        if (level > 2) {
            deeper++;
            if (open.at(-1) === level - 1) nested++;
        }
        open.push(level);
    }
    if (!deeper || nested < MIN_NESTED_SHARE * deeper) return null;
    return levels;
}

// The heading's font size, to half a point, and its main font.
function headingStyle(block) {
    const geometry = (block.fragments || []).find(fragment => fragment.pdf)?.pdf;
    if (!geometry || !(geometry.fontSize > 0)) return null;
    const size = Math.round(geometry.fontSize * 2) / 2;
    return { key: `${size}|${geometry.font}`, size };
}

function findTitle(headings) {
    const candidates = headings.filter(block => block.mineruLevel === 1 && block.pageIndex <= MAX_TITLE_PAGE);
    if (!candidates.length) return null;
    const page = Math.min(...candidates.map(block => block.pageIndex));
    return candidates
        .filter(block => block.pageIndex === page)
        .sort((left, right) => height(right) - height(left))[0];
}

function promoteNumberedLines(blocks) {
    const last = new Map();
    let promoted = false;
    for (const block of blocks) {
        if (block.role === BLOCK_ROLE.HEADING) {
            const number = parseHeadingNumber(blockPlainText(block));
            if (number) last.set(number.kind, number);
            continue;
        }
        // A missed heading after the references (an IEEE biography section)
        // was read as a reference entry; it is promoted the same way.
        if (block.role !== BLOCK_ROLE.BODY && block.role !== BLOCK_ROLE.REFERENCE) continue;
        if (block.kind !== BLOCK_KIND.TEXT || block.fragments.length !== 1) continue;
        const text = blockPlainText(block).trim();
        if (wordCount(text) > MAX_PROMOTED_WORDS || /[.:;,]$/u.test(text)) continue;
        const number = parseHeadingNumber(text);
        if (!number || !followsHeadingNumber(last.get(number.kind), number)) continue;
        if (uppercaseShare(text.replace(/^\S+\s*/u, '')) < MIN_UPPERCASE_SHARE) continue;
        block.role = BLOCK_ROLE.HEADING;
        block.kind = BLOCK_KIND.TITLE;
        block.promotedHeading = true;
        last.set(number.kind, number);
        promoted = true;
    }
    return promoted;
}

function uppercaseShare(text) {
    const letters = [...text].filter(character => /\p{L}/u.test(character));
    if (!letters.length) return 0;
    return letters.filter(character => /\p{Lu}/u.test(character)).length / letters.length;
}

function wordCount(text) {
    return text.split(/\s+/u).filter(Boolean).length;
}

function height(block) {
    return block.bbox ? block.bbox[3] - block.bbox[1] : 0;
}
