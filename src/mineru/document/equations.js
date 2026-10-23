import { BLOCK_KIND, blockPlainText } from './ir.js';
import { columnOfBox } from './reading-order.js';

const EQUATION_NUMBER = /^\(\s*([A-Z]?\d+(?:\.\d+)?[a-z]?)\s*\)$/u;
const TAG = /\\tag\*?\s*\{([^{}]*)\}/u;
const MIN_VERTICAL_OVERLAP = 0.5;
const HORIZONTAL_TOLERANCE = 4;

// MinerU sometimes reads an equation number printed beside display math as a
// text block of its own. A block that holds only "(n)", lies to the right of
// a display equation in the same column of the same page, and overlaps it
// vertically by at least half its height becomes that equation's tag. An
// equation that already has a different tag (a two-line array numbered once
// by MinerU) gets both numbers; a repeated number is dropped. The number
// block leaves the document and is recorded in the equation's `absorbed`.
// Needs the page columns from orderReadingFlow.
export function attachEquationNumbers(ir) {
    const pages = new Map(ir.pages.map(page => [page.pageIndex, page]));
    const equations = ir.blocks.filter(block => block.kind === BLOCK_KIND.EQUATION && block.bbox
        && typeof block.latex === 'string' && block.latex.trim());
    if (!equations.length) return ir;
    const numbered = new Set();
    for (const block of ir.blocks) {
        if (block.kind !== BLOCK_KIND.TEXT || !block.bbox || block.fragments.length !== 1) continue;
        const match = blockPlainText(block).trim().match(EQUATION_NUMBER);
        if (!match) continue;
        const page = pages.get(block.pageIndex);
        const column = columnOfBox(block.bbox, page);
        const equation = equations
            .filter(candidate => candidate.pageIndex === block.pageIndex
                && candidate.bbox[2] <= block.bbox[0] + HORIZONTAL_TOLERANCE
                && sameColumn(columnOfBox(candidate.bbox, page), column))
            .map(candidate => ({ candidate, share: verticalShare(block.bbox, candidate.bbox) }))
            .filter(entry => entry.share >= MIN_VERTICAL_OVERLAP)
            .sort((left, right) => right.share - left.share)[0]?.candidate;
        if (!equation) continue;
        equation.latex = withTag(equation.latex, match[1]);
        equation.absorbed.push(block.id);
        numbered.add(block);
        ir.diagnostics.equationNumbers ||= [];
        ir.diagnostics.equationNumbers.push({ id: block.id, into: equation.id, pageIndex: block.pageIndex });
    }
    if (numbered.size) ir.blocks = ir.blocks.filter(block => !numbered.has(block));
    return ir;
}

function withTag(latex, number) {
    const existing = latex.match(TAG);
    if (!existing) return `${latex.trimEnd()} \\tag{${number}}`;
    const numbers = existing[1].split(',').map(value => value.trim()).filter(Boolean);
    if (numbers.includes(number)) return latex;
    return latex.replace(TAG, `\\tag{${[...numbers, number].join(', ')}}`);
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
