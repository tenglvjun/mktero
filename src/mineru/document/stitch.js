import { parseAcademicFigureCaption } from '../../markdown/markdown-figures.js';
import { BLOCK_KIND, BLOCK_ROLE, fragmentText, isFloatBlock } from './ir.js';
import { columnOfBox, isFlowBlock } from './reading-order.js';
import { isCJKCharacter } from './text.js';

const TERMINAL = /(?:[.!?。！？…:：]["'”’»)\]）】]*|(?:https?:\/\/|www\.|doi:\s*|10\.\d{4,9}\/)\S+|\S+@\S+\.\w+)$/iu;
const LIST_START = /^(?:[•●○◦▪▫‣∙·■□➢➤►✓✔\-–—*]\s|(?:\(?[0-9]{1,3}[.)]|\(?[a-z][.)]|\(?[ivx]{1,4}[.)])\s)/u;
const REFERENCE_MARKER = /^(?:\[\d{1,4}\]|\d{1,4}\.\s|\d{1,4}\)\s|\d{1,4}\s+\p{Lu})/u;
const AUTHOR_START = /^(?:\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+)*,\s*(?:\p{Lu}\.|\p{Lu}[\p{L}'’-]+[,.])|(?:\p{Lu}\.\s*){1,3}(?:-\s*)?\p{Lu}[\p{L}'’-]+,)/u;
const CAPTION_START = /^(?:fig(?:ure)?s?\.?|tables?|algorithms?|scheme|chart|plate|supplementary (?:fig(?:ure)?|table))\s*[A-Z]?\d/iu;
const LABEL_START = /^(?:[\p{Lu}][\p{L}'’]*(?:\s+[\p{L}'’]+){0,4}\s*[:：]|publisher[’']?s note\b|open access\b|reprints and permissions\b)/u;
const FUNCTION_WORD_END = /\b(?:a|an|the|of|in|on|at|to|for|from|with|by|and|or|as|that|which|is|are|was|were|be|been|this|these|its|their|our|between|into|than|using|via)$/iu;
const MIN_LEFT_WORDS = 6;
const MIN_LEFT_CJK = 12;
const MIN_PROSE_SHARE = 0.3;
const MAX_HEADING_UPPERCASE = 0.8;
const MAX_SIDEBAR_SKIP = 6;
const VERTICAL_TOLERANCE = 6;

// Joins paragraphs that a column, page, or float split. A join needs both a
// layout boundary (the first piece ends its column or page and the second
// starts the next one, or only a float lies between them in one column) and
// a sentence that is visibly unfinished. Blocks next to each other in one
// column are never joined: MinerU kept those apart on purpose.
export function stitchParagraphs(ir) {
    const pages = new Map(ir.pages.map(page => [page.pageIndex, page]));
    const pieces = indexPieces(ir.blocks, pages);
    const blocks = ir.blocks;
    const consumed = new Set();
    for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        if (consumed.has(block) || !isStitchable(block)) continue;
        let leftEnd = index + 1;
        for (;;) {
            const found = findContinuation(block, blocks, leftEnd, pieces);
            if (!found) break;
            const candidate = blocks[found.index];
            ir.diagnostics.joins.push({
                into: block.id,
                from: candidate.id,
                boundary: found.boundary,
                pageIndex: block.fragments.at(-1).pageIndex,
            });
            block.fragments.push(...candidate.fragments);
            block.mergedFrom.push(candidate.id, ...candidate.mergedFrom);
            block.absorbed.push(...candidate.absorbed);
            consumed.add(candidate);
            leftEnd = found.index + 1;
        }
    }
    // Blocks between two joined parts keep their place, which is now after
    // the joined paragraph.
    ir.blocks = blocks.filter(block => !consumed.has(block));
    markEquationContinuations(ir.blocks);
    return ir;
}

function findContinuation(block, blocks, from, pieces) {
    const next = nextFlowIndex(blocks, from);
    if (next < 0) return null;
    const candidate = blocks[next];
    if (isStitchable(candidate) && textContinues(block, candidate)) {
        const boundary = joinBoundary(block, candidate, blocks, from, next, pieces);
        // Across a float the sentence must visibly run on: the next part is
        // in lower case or the first stops on a function word.
        if (boundary && (boundary !== 'float' || /^\p{Ll}/u.test(firstText(candidate))
            || FUNCTION_WORD_END.test(lastText(block)))) {
            return { index: next, boundary };
        }
    }
    return findPastSidebar(block, blocks, next, pieces);
}

// A page can open with a sidebar (PLOS and Nature put article metadata in a
// side column) before the paragraph that continues the previous page. The
// continuation is accepted past such blocks only when it starts in lower
// case at the top of its own column and the skipped blocks sit in another
// column; they then follow the joined paragraph.
function findPastSidebar(block, blocks, from, pieces) {
    const last = pieces.get(block.fragments.at(-1));
    if (!last || TERMINAL.test(lastText(block))) return null;
    const skipped = [];
    for (let index = from; index < blocks.length && skipped.length <= MAX_SIDEBAR_SKIP; index++) {
        const candidate = blocks[index];
        if (isTransparent(candidate)) continue;
        if (candidate.role === BLOCK_ROLE.HEADING || candidate.kind === BLOCK_KIND.EQUATION) return null;
        const first = pieces.get(candidate.fragments[0]);
        if (!first) return null;
        if (isStitchable(candidate) && /^\p{Ll}/u.test(firstText(candidate)) && textContinues(block, candidate)
            && skipped.length
            && skipped.every(other => other.fragment.pageIndex === first.fragment.pageIndex
                && !overlapsHorizontally(other.fragment.bbox, first.fragment.bbox))) {
            const page = pieces.page(first.fragment.pageIndex);
            const above = textPieces(page).some(piece => piece !== first
                && overlapsHorizontally(piece.fragment.bbox, first.fragment.bbox)
                && piece.fragment.bbox[1] < first.fragment.bbox[1]);
            if (above) return null;
            if (first.fragment.pageIndex > last.fragment.pageIndex
                && endsPage(pieces.page(last.fragment.pageIndex), last)) {
                return { index, boundary: 'page' };
            }
            if (first.fragment.pageIndex === last.fragment.pageIndex
                && typeof first.column === 'number' && first.column === last.column + 1
                && endsColumn(pieces.page(last.fragment.pageIndex), last)) {
                return { index, boundary: 'column' };
            }
            return null;
        }
        const piece = pieces.get(candidate.fragments.at(-1));
        if (!piece) return null;
        skipped.push(piece);
    }
    return null;
}

function isStitchable(block) {
    return isFlowBlock(block)
        && (block.kind === BLOCK_KIND.TEXT || block.kind === BLOCK_KIND.LIST || block.kind === BLOCK_KIND.REFERENCE)
        && block.fragments.length > 0
        && !isCaptionLike(block);
}

function isTransparent(block) {
    return !isFlowBlock(block) || isFloatBlock(block) || isCaptionLike(block);
}

function isCaptionLike(block) {
    if (block.kind !== BLOCK_KIND.TEXT) return false;
    const text = firstText(block);
    return CAPTION_START.test(text) && Boolean(parseAcademicFigureCaption(text));
}

function nextFlowIndex(blocks, from) {
    for (let index = from; index < blocks.length; index++) {
        if (!isTransparent(blocks[index])) return index;
    }
    return -1;
}

function firstText(block) {
    return fragmentText(block.fragments[0], { math: false }).trim();
}

function lastText(block) {
    return fragmentText(block.fragments.at(-1)).trim();
}

// Every fragment of every flow block and float, with its own column on its
// own page and its reading-order rank.
function indexPieces(blocks, pages) {
    const byFragment = new Map();
    const byPage = new Map();
    let order = 0;
    for (const block of blocks) {
        if (!isFlowBlock(block) && !isFloatBlock(block)) continue;
        for (const fragment of block.fragments) {
            if (!fragment.bbox) continue;
            const piece = {
                fragment,
                order: order++,
                column: columnOfBox(fragment.bbox, pages.get(fragment.pageIndex)),
                float: isFloatBlock(block) || isCaptionLike(block),
            };
            byFragment.set(fragment, piece);
            if (!byPage.has(fragment.pageIndex)) byPage.set(fragment.pageIndex, []);
            byPage.get(fragment.pageIndex).push(piece);
        }
    }
    return {
        get: fragment => byFragment.get(fragment) || null,
        page: pageIndex => byPage.get(pageIndex) || [],
    };
}

function joinBoundary(left, right, blocks, leftEnd, rightIndex, pieces) {
    const last = pieces.get(left.fragments.at(-1));
    const first = pieces.get(right.fragments[0]);
    if (!last || !first) return null;
    const between = blocks.slice(leftEnd, rightIndex);
    if (between.some(block => !isTransparent(block))) return null;
    const lastPage = last.fragment.pageIndex;
    const firstPage = first.fragment.pageIndex;
    if (firstPage > lastPage) {
        return endsPage(pieces.page(lastPage), last) && startsPage(pieces.page(firstPage), first) ? 'page' : null;
    }
    if (firstPage !== lastPage) return null;
    const page = pieces.page(lastPage);
    if (typeof last.column === 'number' && typeof first.column === 'number' && first.column === last.column + 1) {
        return endsColumn(page, last) && startsColumn(page, first) ? 'column' : null;
    }
    if (last.column === first.column && first.fragment.bbox[1] >= last.fragment.bbox[3] - VERTICAL_TOLERANCE) {
        const top = last.fragment.bbox[3] - VERTICAL_TOLERANCE;
        const bottom = first.fragment.bbox[1] + VERTICAL_TOLERANCE;
        const floatBetween = page.some(piece => piece.float
            && piece.fragment.bbox[1] >= top && piece.fragment.bbox[3] <= bottom
            && overlapsHorizontally(piece.fragment.bbox, last.fragment.bbox));
        const textBetween = page.some(piece => !piece.float && piece !== last && piece !== first
            && piece.column === last.column
            && piece.fragment.bbox[1] >= top && piece.fragment.bbox[3] <= bottom);
        if (floatBetween && !textBetween) return 'float';
        // A word hyphenated at the end of a line that MinerU split into two
        // blocks of one column.
        if (!textBetween && /\p{L}-$/u.test(lastText(left)) && /^\p{Ll}/u.test(firstText(right))
            && first.fragment.bbox[1] - last.fragment.bbox[3] <= VERTICAL_TOLERANCE * 2) {
            return 'hyphen';
        }
    }
    return null;
}

function textPieces(page) {
    return page.filter(piece => !piece.float);
}

function endsPage(page, last) {
    return textPieces(page).every(piece => piece.order <= last.order);
}

function startsPage(page, first) {
    return textPieces(page).every(piece => piece.order >= first.order);
}

function endsColumn(page, last) {
    return textPieces(page).every(piece => piece === last || piece.column !== last.column
        || piece.fragment.bbox[1] < last.fragment.bbox[1]);
}

function startsColumn(page, first) {
    return textPieces(page).every(piece => piece === first || piece.column !== first.column
        || piece.fragment.bbox[1] > first.fragment.bbox[1]);
}

function overlapsHorizontally(left, right) {
    return Math.min(left[2], right[2]) > Math.max(left[0], right[0]);
}

// The first part must be an unfinished sentence of prose and the second a
// continuation, not a new list item, caption, labelled note, or heading.
export function textContinues(left, right) {
    const head = lastText(left);
    const tail = firstText(right);
    if (!head || !tail) return false;
    if (LIST_START.test(tail) || CAPTION_START.test(tail)) return false;
    if (left.role === BLOCK_ROLE.REFERENCE || right.role === BLOCK_ROLE.REFERENCE) {
        if (left.role !== right.role || REFERENCE_MARKER.test(tail)) return false;
        if (/-$/u.test(head) || /^\p{Ll}/u.test(tail)) return true;
        if (TERMINAL.test(head)) return false;
        // An author-year list has no markers; a new entry opens with a name.
        return !AUTHOR_START.test(tail) || /(?:,|\band|&)$/u.test(head);
    }
    // A word broken by a line-final hyphen continues whatever the text is.
    if (/\p{L}-$/u.test(head) && /^\p{Ll}/u.test(tail)) return true;
    if (TERMINAL.test(head) || LABEL_START.test(tail) && !/^\p{Ll}/u.test(tail)) return false;
    if (/^\p{Lu}/u.test(tail) && !/[\p{L}\p{N},\-–]$/u.test(head)) return false;
    return looksLikeProse(head, { minimum: true }) && looksLikeProse(tail, { minimum: false });
}

function looksLikeProse(text, { minimum }) {
    const characters = [...text];
    if (characters.filter(isCJKCharacter).length >= (minimum ? MIN_LEFT_CJK : 1)) return true;
    const letters = characters.filter(character => /\p{L}/u.test(character));
    if (letters.length && letters.filter(character => /\p{Lu}/u.test(character)).length
        >= MAX_HEADING_UPPERCASE * letters.length) {
        return false;
    }
    const words = text.split(/\s+/u).filter(word => /\p{L}/u.test(word));
    if (minimum && words.length < MIN_LEFT_WORDS) return false;
    if (words.length < 2) return !minimum && /^\p{Ll}/u.test(words[0] || '');
    const lower = words.slice(1).filter(word => /^\p{Ll}/u.test(word)).length;
    return lower >= MIN_PROSE_SHARE * (words.length - 1);
}

// Text that continues a sentence across display math ("…given by" $$…$$
// "where …") stays a separate paragraph; the link is kept for translation.
function markEquationContinuations(blocks) {
    for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        if (block.kind !== BLOCK_KIND.EQUATION) continue;
        let before = index - 1;
        while (before >= 0 && (blocks[before].kind === BLOCK_KIND.EQUATION || isTransparent(blocks[before]))) before--;
        let after = index + 1;
        while (after < blocks.length && (blocks[after].kind === BLOCK_KIND.EQUATION || isTransparent(blocks[after]))) after++;
        const previous = blocks[before];
        const following = blocks[after];
        if (!previous || !following || !isStitchable(previous) || !isStitchable(following)) continue;
        const head = lastText(previous);
        const open = !TERMINAL.test(head) || /[:：]$/u.test(head);
        if (open && /^\p{Ll}/u.test(firstText(following))) following.continuesFrom = previous.id;
    }
}
