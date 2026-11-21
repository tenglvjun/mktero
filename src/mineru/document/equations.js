import katex from 'katex';
import { BLOCK_KIND, blockPlainText, unionBBox } from './ir.js';
import { columnOfBox } from './reading-order.js';
import { itemsInBox, pdfLines, pdfTextItemsByPage } from './pdf-geometry.js';
import { createMathCompactTextIndex, mathCompactText } from '../../markdown/math-compact-text.js';

const NUMBER = '[A-Z]?\\d+(?:\\.\\d+)?[a-z]?';
const EQUATION_NUMBER = new RegExp(`^\\(\\s*(${NUMBER})\\s*\\)$`, 'u');
const TAG_NUMBERS = new RegExp(`^${NUMBER}(?:\\s*,\\s*${NUMBER})*$`, 'u');
const MIN_VERTICAL_OVERLAP = 0.5;
const HORIZONTAL_TOLERANCE = 4;
const MAX_REPAIR_SOURCE = 10_000;
const MAX_REPAIR_TOTAL = 100_000;
const MAX_REPAIR_OUTPUT = 250_000;
const UNSAFE_MATH_COMMAND = /\\(?:csname|def|edef|futurelet|gdef|global|let|newcommand|providecommand|renewcommand|xdef)\b/u;

// A standalone number beside, or just below the right edge of, an equation
// belongs to it only when the page/column and geometry give one candidate.
// Non-numeric tags are preserved unless native PDF text proves that a math
// tail was incorrectly put in the tag instead of the equation body.
export function attachEquationNumbers(ir, pdfText = null) {
    const pages = new Map(ir.pages.map(page => [page.pageIndex, page]));
    const byPage = new Map();
    for (const block of ir.blocks) {
        if (!byPage.has(block.pageIndex)) byPage.set(block.pageIndex, []);
        byPage.get(block.pageIndex).push(block);
    }
    const proposals = [];
    for (const blocks of byPage.values()) {
        const equations = blocks.filter(block => block.kind === BLOCK_KIND.EQUATION && block.bbox
            && typeof block.latex === 'string' && block.latex.trim());
        if (!equations.length) continue;
        for (const block of blocks) {
            if (block.kind !== BLOCK_KIND.TEXT || !block.bbox || block.fragments.length !== 1) continue;
            const match = blockPlainText(block).trim().match(EQUATION_NUMBER);
            if (!match) continue;
            const page = pages.get(block.pageIndex);
            const column = columnOfBox(block.bbox, page);
            const candidates = equations
                .filter(candidate => candidate.bbox[2] <= block.bbox[0] + HORIZONTAL_TOLERANCE
                    && sameColumn(columnOfBox(candidate.bbox, page), column))
                .map(candidate => association(candidate, block, blocks))
                .filter(Boolean)
                .sort((left, right) => right.share - left.share);
            if (!candidates.length || candidates.length > 1
                && Math.abs(candidates[0].share - candidates[1].share) < 0.01) continue;
            proposals.push({ ...candidates[0], block, number: match[1] });
        }
    }
    const counts = new Map();
    for (const { equation } of proposals) counts.set(equation, (counts.get(equation) || 0) + 1);
    const itemsByPage = pdfTextItemsByPage(ir, pdfText);
    const numbered = new Set();
    const budget = { remaining: MAX_REPAIR_TOTAL };
    for (const { equation, block, number, share } of proposals) {
        if (share < MIN_VERTICAL_OVERLAP && counts.get(equation) !== 1) continue;
        const latex = withTag(equation, number, block.bbox, pages.get(equation.pageIndex),
            itemsByPage.get(equation.pageIndex), budget);
        if (latex === null) continue;
        equation.latex = latex;
        equation.absorbed.push(block.id);
        numbered.add(block);
        ir.diagnostics.equationNumbers ||= [];
        ir.diagnostics.equationNumbers.push({ id: block.id, into: equation.id, pageIndex: block.pageIndex });
    }
    if (numbered.size) ir.blocks = ir.blocks.filter(block => !numbered.has(block));
    return ir;
}

function association(equation, number, blocks) {
    const share = verticalShare(number.bbox, equation.bbox);
    if (share >= MIN_VERTICAL_OVERLAP) return { equation, share };
    const height = number.bbox[3] - number.bbox[1];
    const gap = number.bbox[1] - equation.bbox[3];
    if (!(height > 0) || gap < -height / 2 || gap > height / 2
        || number.bbox[0] - equation.bbox[2] > 2 * height) return null;
    const intervening = blocks.some(block => block !== equation && block !== number && block.bbox
        && !(block.kind === BLOCK_KIND.TEXT && EQUATION_NUMBER.test(blockPlainText(block).trim()))
        && block.bbox[1] >= equation.bbox[3] - HORIZONTAL_TOLERANCE
        && block.bbox[1] <= number.bbox[1] && block.bbox[3] > equation.bbox[3]
        && block.bbox[0] < number.bbox[2] && block.bbox[2] > equation.bbox[0]);
    return intervening ? null : { equation, share };
}

function withTag(equation, number, numberBox, page, items, budget) {
    const source = equation.latex;
    if (source.length > MAX_REPAIR_SOURCE) return null;
    const tags = equationTags(source);
    if (!tags) return null;
    if (!tags.length) return `${source.trimEnd()} \\tag{${number}}`;
    if (tags.length !== 1) return null;
    const tag = tags[0];
    if (tag.closed && TAG_NUMBERS.test(tag.inner.trim())) {
        const numbers = tag.inner.split(',').map(value => value.trim());
        if (numbers.includes(number)) return source;
        const merged = source.slice(0, tag.open + 1) + [...numbers, number].join(', ') + source.slice(tag.end - 1);
        if (tag.depth > 0) {
            if (source.length > budget.remaining) return null;
            budget.remaining -= source.length;
            if (!validRepair(merged)) return null;
        }
        return merged;
    }
    if (!items || tag.depth > 0 || tag.starred || source.slice(tag.end).trim()) return null;
    const tail = wrappedMathTail(tag);
    if (!tail || mathCompactText(source.slice(0, tag.start)).endsWith(mathCompactText(tail.math))) return null;
    if (source.length > budget.remaining) return null;
    budget.remaining -= source.length;
    const printed = printedMathTail(equation.bbox, numberBox, page, items, tail);
    if (printed === null) return null;
    const restored = `${source.slice(0, tag.start).trimEnd()} ${tail.math}${printed.punctuation} \\tag{${number}}`;
    if (!validRepair(restored)) return null;
    equation.bbox = unionBBox([equation.bbox, printed.bbox]);
    for (const fragment of equation.fragments) {
        if (fragment.pageIndex === equation.pageIndex) fragment.bbox = unionBBox([fragment.bbox, printed.bbox]);
    }
    return restored;
}

// Scan real TeX groups, including ordinary math groups around a tag:
// escaped braces, comments, and escaped command names do not add tags.
function equationTags(source) {
    const tags = [];
    let depth = 0;
    for (let index = 0; index < source.length;) {
        const character = source[index];
        if (character === '%') {
            const newline = source.indexOf('\n', index);
            index = newline < 0 ? source.length : newline + 1;
            continue;
        }
        if (character === '\\') {
            const command = /^\\(?:[A-Za-z]+|[^])/u.exec(source.slice(index, index + 64));
            const name = command?.[0] || '\\';
            if (name === '\\tag') {
                const start = index;
                index += name.length;
                const starred = source[index] === '*';
                if (starred) index++;
                while (/\s/u.test(source[index] || '') && index < source.length) index++;
                if (source[index] !== '{') return null;
                const open = index++;
                let groupDepth = 1;
                while (index < source.length && groupDepth) {
                    if (source[index] === '\\') index += 2;
                    else if (source[index] === '%') {
                        const newline = source.indexOf('\n', index);
                        index = newline < 0 ? source.length : newline + 1;
                    }
                    else {
                        if (source[index] === '{') groupDepth++;
                        else if (source[index] === '}') groupDepth--;
                        index++;
                    }
                }
                const closed = groupDepth === 0;
                tags.push({ start, open, end: index, depth, starred, closed,
                    inner: source.slice(open + 1, closed ? index - 1 : index) });
                continue;
            }
            index += name.length;
            continue;
        }
        if (character === '{') depth++;
        else if (character === '}' && --depth < 0) return null;
        index++;
    }
    return depth === 0 ? tags : null;
}

function wrappedMathTail(tag) {
    if (typeof tag.inner !== 'string' || tag.inner.length > 512) return null;
    const inner = tag.inner.trim();
    if (!inner.startsWith('\\(')) return null;
    const match = /^\\\(([^]*?)\\\)([,.]?)$/u.exec(inner);
    if (tag.closed && match) return { math: match[1].trim(), punctuation: match[2] };
    // OCR sometimes leaves "\tag{\(math\}". Recover only this outer
    // wrapper, and only when independent PDF evidence below confirms math.
    if (!tag.closed && inner.endsWith('\\}')) {
        const math = inner.slice(2, -2).trim();
        if (!/\\[()]/u.test(math)) return { math, punctuation: '' };
    }
    return null;
}

function printedMathTail(bbox, numberBox, page, items, tail) {
    const key = mathCompactText(tail.math);
    if (key.length < 3 || /\\(?:tag|text)\b/u.test(tail.math)) return null;
    const height = numberBox[3] - numberBox[1];
    // MinerU can crop the wrongly tagged tail out of the equation box.
    // Search a narrow extension through its number's right margin as well.
    const column = columnOfBox(bbox, page);
    const gutters = page?.gutters || [];
    // The gutter's midpoint separates column ownership; a formula may
    // legitimately extend from its text column into its half of the gutter.
    const before = gutters[column - 1];
    const after = gutters[column];
    const left = column === 'span' || !before ? 0 : (before.from + before.to) / 2;
    const right = column === 'span' || !after ? 1000 : (after.from + after.to) / 2;
    const evidenceBox = [Math.max(bbox[0], left), bbox[1],
        Math.min(Math.max(bbox[2], numberBox[2]) + 2 * height, right), bbox[3]];
    const localItems = itemsInBox(evidenceBox, items).filter(item => item.bbox[0] >= left - HORIZONTAL_TOLERANCE
        && item.bbox[2] <= right + HORIZONTAL_TOLERANCE
        && (column === 'span' || columnOfBox(item.bbox, page) === column));
    const matches = [];
    for (const line of pdfLines(localItems)) {
        const text = line.items.map(item => item.text).join('');
        const index = createMathCompactTextIndex(text, { pdfTextLayer: true });
        if (!index.text.endsWith(key)) continue;
        const range = index.sourceRange(index.text.length - key.length, key.length);
        if (!range) continue;
        const suffix = text.slice(range.to).trim();
        if (!/^[)\]}\s]*([,.]?)$/u.test(suffix)) continue;
        const closing = tail.math.match(/[)\]]+\s*$/u)?.[0].trim() || '';
        if (closing && suffix.match(/^[)\]]*/u)?.[0] !== closing) continue;
        const punctuation = suffix.match(/[,.]$/u)?.[0] || '';
        if (tail.punctuation && tail.punctuation !== punctuation) continue;
        let offset = 0;
        let first = -1;
        for (const [itemIndex, item] of line.items.entries()) {
            if (offset + item.text.length > range.from) {
                first = itemIndex;
                break;
            }
            offset += item.text.length;
        }
        // The tail must touch body text on its left, rather than occupying
        // a separate equation-label cell at the page margin.
        if (first < 0) continue;
        const item = line.items[first];
        const previous = line.items[first - 1];
        const touchesBox = item.bbox[0] >= bbox[2] - HORIZONTAL_TOLERANCE
            && item.bbox[0] <= bbox[2] + height;
        if (range.from > offset) {
            // An item's internal character positions are unknown. Accept an
            // internal suffix only when the whole item belongs to the body.
            if (item.bbox[0] < bbox[0] - HORIZONTAL_TOLERANCE
                || item.bbox[2] > bbox[2] + HORIZONTAL_TOLERANCE) continue;
        }
        else if (!touchesBox && (!previous
            || item.bbox[0] - previous.bbox[2] > 2.5 * line.height)) continue;
        matches.push({ punctuation, bbox: unionBBox(line.items.slice(first).map(item => item.bbox)) });
    }
    return matches.length === 1 ? matches[0] : null;
}

function validRepair(source) {
    if (source.length > MAX_REPAIR_SOURCE || UNSAFE_MATH_COMMAND.test(source)) return false;
    try {
        return katex.renderToString(source, {
            displayMode: true, output: 'mathml', throwOnError: true,
            strict: 'ignore', trust: false, maxExpand: 100, maxSize: 100,
        }).length <= MAX_REPAIR_OUTPUT;
    }
    catch {
        return false;
    }
}

// A full-width equation shares a row with a number in any column.
function sameColumn(equation, number) {
    return equation === number || equation === 'span';
}

function verticalShare(number, equation) {
    const overlap = Math.min(number[3], equation[3]) - Math.max(number[1], equation[1]);
    const height = number[3] - number[1];
    return overlap > 0 && height > 0 ? overlap / height : 0;
}
