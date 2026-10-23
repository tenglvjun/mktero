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
