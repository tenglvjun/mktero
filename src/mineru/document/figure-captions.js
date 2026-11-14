import { FIGURE_LIMITS } from '../../figures/figure-limits.js';
import {
    parseAcademicFigureCaption,
    parseAcademicTableCaption,
    parseLooseAcademicFigureCaption,
} from '../../markdown/markdown-figures.js';
import { BLOCK_KIND, BLOCK_ROLE, blockPlainText, fragmentText } from './ir.js';
import { pdfLines, pdfTextItemsByPage } from './pdf-geometry.js';

// MinerU's layout sometimes loses a figure's number, or files the legend of
// one float under a different float. The PDF's own text layer still has it, so
// this pass reads the native caption and repairs the IR with it.
//
// Ownership is not decided by horizontal overlap: journals left-align a
// caption with the page frame while the picture stays centred. A caption
// belongs to the picture nearest it in the reading order, and a page's
// captions and pictures are matched one to one, so two captions can never
// claim the same picture and a picture with its own legend keeps it.
//
// Every repair is planned before the IR changes: matching, grouping and the
// copies to consume are decided from the untouched page, and only a caption
// with one owner is applied. Evidence that does not name a single owner
// leaves the page exactly as MinerU wrote it.
//
// Floats that share a band and a caption (a table and the plot beside it) are
// one picture. That wider group is recorded as `pdfFigure` and merged later,
// only after the PDF's own image container and pixels verify it.
const MAX_CAPTION_LENGTH = 2_000;
const MAX_CAPTION_WORDS = 60;
const MAX_PAGE_CANDIDATES = 256;
const MAX_LABEL_DESCRIPTION_GAP = 40;
const MAX_CAPTION_LINES = 8;
// A gap wider than this between two runs of one printed line is a column break.
const COLUMN_GAP = 120;
const LABEL_ALIGNMENT = 24;
const BAND_TOLERANCE = 24;
const MAX_CAPTION_GAP = 180;
const MIN_WORD_SHARE = 0.8;
const MIN_BASELINE_SHARE = 0.9;
const AMBIGUOUS_SCORE = 6;
const SIDE_BY_SIDE_GAP = 120;
// A caption line box and the picture edge can overlap by a hair: the OCR line
// box is drawn around the glyphs, not the printed frame.
const EDGE_TOLERANCE = 6;
// A caption's lines share one size and one leading. A body paragraph printed
// under a caption keeps the body's own type, so it is set at another size, at
// another leading, or reads as the column measure.
const SAME_TYPE_SIZE = 0.98;
const SAME_TYPE_SIZE_TOLERANCE = 0.02;
const MAX_TYPE_SIZE = 1.25;
const MIN_LINE_PITCH = 0.9;
const MAX_LINE_PITCH = 1.8;
const MIN_PROSE_FILL = 0.72;
const MIN_PROSE_LINES = 2;
const HOST_KINDS = new Set([BLOCK_KIND.IMAGE, BLOCK_KIND.CHART, BLOCK_KIND.TABLE]);
const LABEL_ONLY = /^(?:fig(?:ure)?|chart|scheme|algorithm|table)\.?[\s\p{Zs}]*\d+[a-z]?[.:：。]?$/iu;
const FIGURE_LABEL = /^(?:fig(?:ure)?|chart|scheme|algorithm)\b/iu;
// The printed number of a label: "Figure 4b" and "FIG. 4" are both 4.
const LABEL_NUMBER = /\d+[a-z]?/iu;

// Repairs figure captions from the PDF's own text layer. Idempotent: a second
// pass finds every native caption already attached and leaves the IR alone.
export function restorePDFFigureCaptions(ir, pdfText) {
    const diagnostics = ir.diagnostics || (ir.diagnostics = {});
    const report = { restored: 0, reassigned: 0, completed: 0, released: 0, groups: 0, skipped: 0 };
    diagnostics.pdfCaptions = report;
    const itemsByPage = pdfTextItemsByPage(ir, pdfText);
    if (!itemsByPage.size) return ir;
    for (const page of ir.pages) {
        const items = itemsByPage.get(page.pageIndex);
        if (!items?.length) continue;
        const pageBlocks = ir.blocks.filter(block => block.pageIndex === page.pageIndex);
        const floats = pageBlocks.filter(isVisualFloat);
        if (!floats.length) continue;
        // A page is repaired whole or not at all: its matching, grouping and
        // copy search are estimated up front, and a page whose evidence would
        // cost more than the pipeline allows is left exactly as MinerU wrote
        // it. A hostile page therefore cannot make the pass quadratic.
        const lines = captionLines(pdfLines(items));
        if (!withinBudget(lines.length, floats.length, pageBlocks.length)) {
            report.skipped++;
            continue;
        }
        const captions = findNativeCaptions(page, lines, pageBlocks);
        if (!captions.length) continue;
        if (!withinBudget(lines.length, floats.length, pageBlocks.length, captions.length)) {
            report.skipped++;
            continue;
        }
        for (const plan of planPage(captions, floats, pageBlocks)) applyPlan(ir, plan, report);
    }
    return ir;
}

// The pass reads captions against pictures, pictures against pictures, and
// lines against lines. Counting the worst case of each keeps a page with many
// repeated candidates from costing more than one ordinary page times the
// budget, without measuring anything while the work runs.
function withinBudget(lineCount, floatCount, blockCount, captionCount = floatCount) {
    const pairs = captionCount * floatCount;
    const work = pairs * pairs // pairing, rival search and the copy scan
        + pairs * blockCount // text between a caption and a picture
        + lineCount * lineCount; // column measure and following lines
    return work <= FIGURE_LIMITS.maxComparisons;
}

// What one native caption repairs, decided before the IR changes. A plan names
// exactly one destination, the pictures grouped with it, the OCR copy it
// completes, and the misfiled copies it consumes. A caption with no single
// owner produces no plan, so the page keeps every child MinerU wrote.
function planPage(captions, floats, pageBlocks) {
    const assignments = assignCaptions(captions, floats, pageBlocks);
    // A picture another caption owns is never absorbed into this one: two
    // pictures printed side by side with their own legends stay separate.
    const assigned = new Set(assignments.map(pair => pair.float));
    const claimed = new Set();
    const plans = [];
    for (const { caption, float } of assignments) {
        const group = figureGroup(float, floats, pageBlocks, assigned);
        // A table's own legend stays the table's caption; only a figure legend
        // marks a picture as restored from the PDF.
        if (caption.kind === 'table' && group.every(member => member.kind === BLOCK_KIND.TABLE)) continue;
        const destination = group[0];
        const existing = captionChildren(destination).filter(child => !claimed.has(child));
        const match = existing.find(child => completesCaption(child, caption)) || null;
        // A picture that prints another numbered legend keeps it: this caption
        // then has no owner on the page, and the page is left as MinerU wrote
        // it rather than carrying two legends on one picture.
        if (existing.length && !match) continue;
        const copies = captionCopies(floats, caption, match, claimed);
        const texts = textCopies(pageBlocks, caption, group);
        // Nothing to repair and nothing to merge: the picture prints the whole
        // legend, and the page beside it prints its own legends too. Marking it
        // would let the figure pipeline claim a picture that already reads.
        if (match && coversCaption(captionText(match), caption.text)
            && !copies.length && !texts.length && group.length === 1
            && hasCaptionedNeighbour(destination, floats)) continue;
        for (const { child } of copies) claimed.add(child);
        for (const { block } of texts) claimed.add(block);
        plans.push({ caption, destination, group, copies, texts, match });
    }
    return plans;
}

function applyPlan(ir, plan, report) {
    if (plan.match) report.completed++;
    else report.restored++;
    if (plan.group.length > 1) report.groups++;
    for (const member of plan.group) member.pdfFigure = figureMark(plan.caption, plan.group.length > 1);
    if (plan.match) adoptNativeText(plan.match, plan.caption);
    else plan.destination.children.push(attachCaption(plan.destination, plan.caption));
    if (plan.copies.length) {
        releaseChildCopies(ir, plan.copies, plan.destination);
        report.reassigned += plan.copies.length;
    }
    releaseTextCopies(ir, plan.texts, plan.destination, report);
}

// A native caption, in one of the three shapes a journal prints it:
// - a bare number on its own line, with the description under it;
// - a whole caption on one line ("Figure 4. Sensitivity test in adults.");
// - a numbered caption whose description runs over several printed lines.
function findNativeCaptions(page, lines, pageBlocks) {
    const captions = [];
    const prose = bodyType(pageBlocks);
    for (const [index, { line, text }] of lines.entries()) {
        if (captions.length >= MAX_PAGE_CANDIDATES) break;
        const bare = bareLabel(text);
        if (bare) {
            // A bare number takes the description printed under it, and only
            // that: a label with nothing under it is not a caption.
            const parts = [{ line, text }];
            let cursor = index;
            while (parts.length < MAX_CAPTION_LINES) {
                const following = nextLineInColumn(lines, cursor);
                if (!following || !continuesCaption(parts.at(-1).line, following.line,
                    { lines, prose, first: parts.length === 1 })) break;
                parts.push(following);
                cursor = lines.indexOf(following);
            }
            if (parts.length < 2) continue;
            const value = parts.map(part => part.text).join(' ');
            if (!withinLimits(value)) continue;
            captions.push(nativeCaption(page, captions.length, bare, parts));
            continue;
        }
        const inline = inlineCaption(text);
        if (!inline) continue;
        // A numbered caption that opens with a sentence is a reference in the
        // body ("Figure 6 shows ..."), not the legend printed under a picture.
        const parts = [{ line, text }];
        let cursor = index;
        while (parts.length < MAX_CAPTION_LINES) {
            const following = nextLineInColumn(lines, cursor);
            if (!following || !continuesCaption(parts.at(-1).line, following.line, { lines, prose })) break;
            parts.push(following);
            cursor = lines.indexOf(following);
        }
        const value = parts.map(part => part.text).join(' ');
        if (!withinLimits(value)) continue;
        captions.push(nativeCaption(page, captions.length, inline, parts));
    }
    return captions;
}

// The next printed line in the same column as `lines[index]`. Splitting a line
// into column runs puts the neighbouring column's runs right after it, so a
// caption's description is found by matching the left margin, not by taking
// the very next run.
function nextLineInColumn(lines, index) {
    const current = lines[index];
    let cursor = index + 1;
    while (cursor < lines.length && Math.abs(lines[cursor].line.bottom - current.line.bottom) < 1) cursor++;
    for (; cursor < lines.length; cursor++) {
        const candidate = lines[cursor];
        if (Math.abs(candidate.line.left - current.line.left) <= LABEL_ALIGNMENT) return candidate;
        if (candidate.line.bottom - current.line.bottom > MAX_LABEL_DESCRIPTION_GAP) return null;
    }
    return null;
}

// Every printed line of the page, split into its column runs, with the run's
// own text and box. Continuation lines are looked up in this same list.
function captionLines(lines) {
    const output = [];
    for (const line of lines) {
        const runs = columnRuns(line);
        if (!runs) {
            output.push({ line, text: lineText(line) });
            continue;
        }
        for (const run of runs) {
            const text = run.items.map(item => item.text).filter(Boolean).join(' ').replace(/\s+/gu, ' ').trim();
            if (!text) continue;
            // pdfLines keeps no box on the line itself; each run derives one
            // from its own items.
            const boxes = run.items.map(item => item.bbox);
            output.push({
                line: { ...line, items: run.items, left: run.left, right: run.right,
                    bbox: [run.left, Math.min(...boxes.map(box => box[1])),
                        run.right, Math.max(...boxes.map(box => box[3]))] },
                text,
            });
        }
    }
    return output;
}

function nativeCaption(page, ordinal, labeled, parts) {
    const boxes = parts.map(part => part.line.bbox
        || [part.line.left, part.line.bottom - part.line.height, part.line.right, part.line.bottom]);
    return {
        id: `pdf-caption-p${page.pageIndex}-${ordinal}`,
        pageIndex: page.pageIndex,
        label: labeled.label,
        kind: labeled.kind,
        text: parts.map(part => part.text).join(' '),
        bbox: unionOf(boxes),
        labelBBox: [...boxes[0]],
        lineBBoxes: boxes.map(box => [...box]),
        lineTexts: parts.map(part => part.text),
        // Everything printed after the number, for the OCR copy of the legend.
        description: parts.length > 1 ? parts.slice(1).map(part => part.text).join(' ') : null,
    };
}

function lineText(line) {
    return (line.items || []).map(item => item.text).filter(Boolean).join(' ').replace(/\s+/gu, ' ').trim();
}

// A printed line can hold two columns when the gap between them is small; the
// caption is the left run, and the right run is the neighbouring column's
// prose. Splitting on a wide horizontal gap keeps both readable and keeps the
// right column's words out of the caption.
function columnRuns(line) {
    const items = [...(line.items || [])].sort((left, right) => left.bbox[0] - right.bbox[0]);
    const runs = [];
    let current = null;
    for (const item of items) {
        if (current && item.bbox[0] - current.right > COLUMN_GAP) {
            runs.push(current);
            current = null;
        }
        if (!current) {
            current = { items: [], left: item.bbox[0], right: item.bbox[2] };
        }
        current.items.push(item);
        current.right = Math.max(current.right, item.bbox[2]);
    }
    if (current) runs.push(current);
    return runs.length > 1 ? runs : null;
}

// A number printed alone on its line ("FIGURE 2", "Fig. 4."), never a caption.
function bareLabel(text) {
    const value = text.trim();
    if (!LABEL_ONLY.test(value)) return null;
    return { label: value, kind: /^table\b/iu.test(value) ? 'table' : 'figure' };
}

// A whole caption on one line, with its number and description together.
function inlineCaption(text) {
    const table = parseAcademicTableCaption(text);
    if (table && /^table\b/iu.test(table.label)) return { label: table.label, kind: 'table' };
    const strict = parseAcademicFigureCaption(text);
    if (strict && FIGURE_LABEL.test(strict.label) && !opensWithSentence(strict.description)) {
        return { label: strict.label, kind: 'figure' };
    }
    const loose = parseLooseAcademicFigureCaption(text);
    if (loose && FIGURE_LABEL.test(loose.label) && !opensWithSentence(loose.description)) {
        return { label: loose.label, kind: 'figure' };
    }
    return null;
}

// "Figure 6 shows ..." / "Fig. 4 reports ..." is prose that cites a figure.
// A legend names the picture ("Funnel plot.") and does not continue as a
// sentence about it.
function opensWithSentence(description) {
    const text = String(description || '').trim();
    if (!text) return false;
    return /^(?:shows?|reports?|presents?|illustrates?|depicts?|summari[sz]es?|displays?|lists?|gives?|provides?)\b/iu.test(text);
}

// The type a page's running text is set in: the size most of its measured
// paragraphs share, and the paragraphs themselves, so a continuation line can
// be checked against the body it would otherwise swallow.
function bodyType(pageBlocks) {
    const sizes = [];
    const blocks = [];
    for (const block of pageBlocks) {
        if (!isProse(block) || !validBox(block.bbox)) continue;
        blocks.push(block);
        for (const fragment of block.fragments || []) {
            const size = fragment.pdf?.fontSize;
            if (size > 0) sizes.push(size);
        }
    }
    return { size: sizes.length ? median(sizes) : 0, blocks };
}

// The next printed line of a caption: same left margin, no other caption
// starting, set in the caption's own type, and not running text.
function continuesCaption(currentLine, nextLine, { lines = [], prose = { size: 0, blocks: [] }, first = false } = {}) {
    const text = lineText(nextLine);
    if (!text || text.length > MAX_CAPTION_LENGTH || LABEL_ONLY.test(text)) return false;
    if (bareLabel(text) || inlineCaption(text)) return false;
    const gap = nextLine.bottom - currentLine.bottom;
    if (gap < -2 || gap > MAX_LABEL_DESCRIPTION_GAP) return false;
    if (first ? !startsDescription(currentLine, nextLine, prose) : !sameType(currentLine, nextLine)) return false;
    if (readsAsBody({ line: nextLine, text }, lines, prose)) return false;
    if (Math.abs(nextLine.left - currentLine.left) > LABEL_ALIGNMENT) return false;
    return text.split(/\s+/u).filter(Boolean).length <= MAX_CAPTION_WORDS;
}

// A printed label is often set smaller than its description (small capitals), so
// the description under a label only has to be at least as large as the label
// and no larger than the page's running text. Every later line of the caption
// shares the description's own type.
function startsDescription(labelLine, nextLine, prose) {
    const label = labelLine.height || 0;
    const next = nextLine.height || 0;
    if (!(next > 0)) return true;
    if (label > 0 && next < label * SAME_TYPE_SIZE) return false;
    if (prose.size > 0 && next > prose.size * MAX_TYPE_SIZE) return false;
    return true;
}

// Two printed lines of one caption are set at the same size, with one leading
// between them. A body line under a caption is set at the body's size, and its
// paragraph leading is wider than a caption's.
function sameType(currentLine, nextLine) {
    const size = currentLine.height || 0;
    const next = nextLine.height || 0;
    if (!(size > 0) || !(next > 0)) return true;
    if (Math.abs(next - size) / size > SAME_TYPE_SIZE_TOLERANCE) return false;
    const pitch = (nextLine.bottom - currentLine.bottom) / next;
    return pitch >= MIN_LINE_PITCH && pitch <= MAX_LINE_PITCH;
}

// A caption line is short; running text fills the column. A line that belongs
// to a body paragraph, or that is the column measure followed by another line
// of the same measure, is prose that happened to be printed under a caption.
function readsAsBody(line, lines, prose) {
    if (bodyBlockAt(line, prose.blocks)) return true;
    const width = (line.line.right || 0) - (line.line.left || 0);
    if (!(width > 0) || !(prose.size > 0)) return false;
    const measure = columnMeasure(line.line, lines);
    if (!(measure > 0) || width / measure < MIN_PROSE_FILL) return false;
    const following = lines
        .filter(candidate => candidate.line !== line.line
            && Math.abs(candidate.line.left - line.line.left) <= LABEL_ALIGNMENT
            && candidate.line.bottom > line.line.bottom
            && candidate.line.bottom - line.line.bottom <= MAX_LABEL_DESCRIPTION_GAP)
        .sort((left, right) => left.line.bottom - right.line.bottom)[0];
    if (!following) return false;
    const followingWidth = (following.line.right || 0) - (following.line.left || 0);
    return followingWidth / measure >= MIN_PROSE_FILL;
}

// A printed line that lies inside a multi-line body paragraph, with more of
// that paragraph under it, is body text: the caption ends before it. The OCR
// copy of a caption is a one-line body block too, so it never qualifies.
function bodyBlockAt(line, blocks) {
    const box = line.line.bbox;
    if (!validBox(box)) return false;
    const height = box[3] - box[1];
    const width = box[2] - box[0];
    if (!(height > 0) || !(width > 0)) return false;
    return blocks.some(block => {
        const overlapY = Math.min(box[3], block.bbox[3]) - Math.max(box[1], block.bbox[1]);
        if (overlapY / height < 0.5) return false;
        const overlapX = Math.min(box[2], block.bbox[2]) - Math.max(box[0], block.bbox[0]);
        if (overlapX / width < 0.5) return false;
        if (!((block.fragments || []).some(fragment => (fragment.pdf?.lines || 0) >= MIN_PROSE_LINES))) {
            return false;
        }
        return block.bbox[3] > box[3] + height * 0.8;
    });
}

// The widest printed run on the page near this line's column: the measure of
// the running text, not the caption's own short line.
function columnMeasure(line, lines) {
    const widths = lines
        .filter(candidate => Math.abs(candidate.line.left - line.left) <= LABEL_ALIGNMENT * 2)
        .map(candidate => (candidate.line.right || 0) - (candidate.line.left || 0))
        .filter(width => width > 0)
        .sort((left, right) => left - right);
    return widths.length >= MIN_PROSE_LINES ? widths[Math.floor(widths.length * 0.75)] : 0;
}

function withinLimits(text) {
    if (typeof text !== 'string' || !text || text.length > MAX_CAPTION_LENGTH
        || text.length > FIGURE_LIMITS.maxCaptionLength) return false;
    return text.split(/\s+/u).filter(Boolean).length <= MAX_CAPTION_WORDS;
}

function figureMark(caption, grouped) {
    return {
        id: caption.id,
        label: caption.label,
        text: caption.text,
        bbox: [...caption.bbox],
        pageIndex: caption.pageIndex,
        ...(grouped ? { group: true } : {}),
    };
}

function isVisualFloat(block) {
    return block?.role === BLOCK_ROLE.FLOAT && HOST_KINDS.has(block.kind) && validBox(block.bbox);
}

// The OCR copies of a native caption: caption children of the page's pictures
// printed where the PDF prints this very legend, except the copy this plan
// completes. A copy is only read here, never moved before the plan exists, so a
// page whose caption has no single owner keeps every child it had.
function captionCopies(floats, caption, match, claimed) {
    const copies = [];
    for (const float of floats) {
        for (const child of captionChildren(float)) {
            if (child === match || child.pdfNativeCaption || claimed.has(child)) continue;
            if (sameCaption(child, caption) || bareLabelAt(child, caption)) copies.push({ float, child });
        }
    }
    return copies;
}

// The body blocks that print this very caption: the OCR copy of the legend,
// turned into a caption so it is not read as prose twice. A body block is only
// read here; the plan decides whether it is consumed.
function textCopies(pageBlocks, caption, group) {
    const copies = [];
    for (const block of pageBlocks) {
        if (group.includes(block) || !isProse(block)) continue;
        if (block.kind !== BLOCK_KIND.TEXT || block.role !== BLOCK_ROLE.BODY) continue;
        if ((block.fragments || []).length !== 1 || !validBox(block.bbox)) continue;
        if (!samePlace(block.bbox, caption)) continue;
        if (!copiesCaption(blockPlainText(block), caption)) continue;
        copies.push({ block, caption });
    }
    return copies;
}

// The OCR copy is printed in the caption's own lines: the same band, or the
// description line just under the number.
function samePlace(box, caption) {
    return boxMatches(box, caption.bbox) || boxMatches(box, caption.labelBBox)
        || caption.lineBBoxes.some(line => boxMatches(box, line));
}

// The OCR text is this caption, or its description, or only its number.
function copiesCaption(text, caption) {
    const value = normalize(text);
    if (!value) return false;
    if (value === normalize(caption.text)) return true;
    if (caption.description && value === normalize(caption.description)) return true;
    return value === normalize(caption.label);
}

function labelNumber(value) {
    return LABEL_NUMBER.exec(String(value || '').trim())?.[0]?.toLowerCase() || '';
}

// A child of the destination that is this caption, in whole or in part: the
// whole legend, its bare number printed at the label, or its description
// printed at the caption's own place. Completing it in place is what turns an
// OCR copy that lost its number into the printed caption.
function completesCaption(child, caption) {
    if (sameCaption(child, caption) || bareLabelAt(child, caption)) return true;
    const text = captionText(child).trim();
    if (!text || !caption.description) return false;
    if (!boxMatches(child.bbox, caption.bbox)) return false;
    return wordsMatch(text, caption.description);
}

// One-to-one matching of a page's native captions to its pictures, nearest
// first. A picture already carrying a legend of its own is not a candidate,
// and a pair that ties with another picture is left alone. A child that only
// copies another native caption is not the picture's own legend: the page
// prints that caption elsewhere, so it never blocks its real owner.
function assignCaptions(captions, floats, pageBlocks) {
    const pairs = [];
    for (const caption of captions) {
        for (const float of floats) {
            const score = captionScore(caption, float, pageBlocks, captions);
            if (score === null) continue;
            pairs.push({ caption, float, score, distance: captionDistance(caption, float) });
        }
    }
    pairs.sort((left, right) => left.score - right.score
        || left.caption.pageIndex - right.caption.pageIndex
        || left.float.bbox[1] - right.float.bbox[1]);
    const usedCaptions = new Set();
    const usedFloats = new Set();
    const output = [];
    for (const pair of pairs) {
        if (usedCaptions.has(pair.caption) || usedFloats.has(pair.float)) continue;
        // Two pictures at the same distance are not evidence for either one;
        // the caption stays out instead of being guessed. A picture that
        // already prints this very legend is completed in place, so that pair
        // is never ambiguous; a bare number filed at the caption's place is not
        // enough, because the same spot is where another picture's label can
        // have been filed.
        const rivals = pairs.filter(other => other.caption === pair.caption
            && !usedFloats.has(other.float)
            && Math.abs(other.distance - pair.distance) <= AMBIGUOUS_SCORE);
        if (rivals.length > 1 && !captionChildren(pair.float).some(child => sameCaption(child, pair.caption))) {
            usedCaptions.add(pair.caption);
            continue;
        }
        usedCaptions.add(pair.caption);
        usedFloats.add(pair.float);
        output.push({ caption: pair.caption, float: pair.float });
    }
    // Top to bottom, so grouping decisions do not depend on match order.
    return output.sort((left, right) => left.caption.bbox[1] - right.caption.bbox[1]);
}

// How far a caption is from a picture, or null when it cannot belong to it.
// A caption printed inside the picture, on the far side of body text, or more
// than one figure away is never a candidate.
function captionScore(caption, float, pageBlocks, captions = [caption]) {
    if (hasOwnCaption(float, captions) && !misplacedCaptionOf(caption, float)) return null;
    const relation = captionRelation(caption.bbox, float.bbox);
    if (!relation) return null;
    const { vertical, horizontal } = relation;
    if (vertical > MAX_CAPTION_GAP) return null;
    // Side by side: the caption is in the picture's band, outside its frame.
    if (vertical === 0 && horizontal > SIDE_BY_SIDE_GAP) return null;
    if (blockedByText(caption, float, pageBlocks)) return null;
    return vertical + horizontal * 0.25;
}

// The plain distance between a caption and a picture, for tie-breaking.
function captionDistance(caption, float) {
    const relation = captionRelation(caption.bbox, float.bbox);
    return relation ? relation.vertical + relation.horizontal : Infinity;
}

// How far a caption sits from a picture. A caption printed inside the
// picture's frame is not its legend, so an overlap of the whole band rejects
// the pair; a one-line overlap of the printed edges does not.
function captionRelation(caption, picture) {
    const overlapY = Math.min(caption[3], picture[3]) - Math.max(caption[1], picture[1]);
    const overlapX = Math.min(caption[2], picture[2]) - Math.max(caption[0], picture[0]);
    // MinerU's box for a chart can swallow the legend printed under it. A
    // caption wholly inside the box at its lower edge is still that legend.
    if (overlapY > EDGE_TOLERANCE && overlapX > 0) {
        const inside = caption[0] >= picture[0] - EDGE_TOLERANCE && caption[2] <= picture[2] + EDGE_TOLERANCE
            && caption[1] >= picture[1] - EDGE_TOLERANCE && caption[3] <= picture[3] + EDGE_TOLERANCE;
        const height = picture[3] - picture[1];
        if (!inside || caption[1] < picture[1] + height * 0.6) return null;
        return { vertical: 0, horizontal: 0 };
    }
    const horizontal = overlapX > 0 ? 0
        : Math.max(picture[0] - caption[2], caption[0] - picture[2]);
    if (overlapY > 0) return { vertical: 0, horizontal };
    const vertical = caption[3] <= picture[1]
        ? picture[1] - caption[3]
        : caption[1] - picture[3];
    return { vertical, horizontal };
}

// A picture whose only legend is this very caption, filed under it by MinerU,
// is a candidate: completing that copy is what repairs the page.
function misplacedCaptionOf(caption, float) {
    return captionChildren(float).some(child => sameCaption(child, caption) || bareLabelAt(child, caption));
}

function blockedByText(caption, float, pageBlocks) {
    const prose = pageBlocks.filter(block => isProse(block) && validBox(block.bbox));
    if (!prose.length) return false;
    if (verticalGap(caption.bbox, float.bbox) === 0) {
        const [left, right] = caption.bbox[0] <= float.bbox[0]
            ? [caption.bbox, float.bbox] : [float.bbox, caption.bbox];
        return prose.some(block => block.bbox[0] >= left[2] - 2 && block.bbox[2] <= right[0] + 2
            && block.bbox[1] < Math.max(left[3], right[3]) && block.bbox[3] > Math.min(left[1], right[1]));
    }
    const [top, bottom] = caption.bbox[3] <= float.bbox[1]
        ? [caption.bbox, float.bbox] : [float.bbox, caption.bbox];
    return prose.some(block => block.bbox[1] >= top[3] - 2 && block.bbox[3] <= bottom[1] + 2);
}

// Two pictures printed in one band that each carry their own legend are two
// figures the OCR already read in full; the PDF adds no evidence about either.
function hasCaptionedNeighbour(float, floats) {
    return floats.some(other => other !== float && hasCaption(other)
        && sameBand(other.bbox, float.bbox)
        && horizontalGap(other.bbox, float.bbox) <= SIDE_BY_SIDE_GAP);
}

// The pictures one caption describes: the matched picture, plus pictures
// printed in the same band directly beside it that carry no legend of their
// own. A picture another caption on this page owns is never absorbed, so two
// independent legends printed side by side keep their own pictures.
function figureGroup(host, floats, pageBlocks, assigned = new Set()) {
    const members = [host];
    for (const float of floats) {
        if (float === host || hasCaption(float)) continue;
        if (assigned.has(float)) continue;
        if (!sameBand(float.bbox, host.bbox)) continue;
        if (horizontalGap(float.bbox, host.bbox) > SIDE_BY_SIDE_GAP) continue;
        if (pageBlocks.some(block => isProse(block) && betweenColumns(block.bbox, float.bbox, host.bbox))) continue;
        members.push(float);
    }
    return members.sort((left, right) => left.bbox[0] - right.bbox[0] || left.bbox[1] - right.bbox[1]);
}

// The native text completes the OCR copy it matches. A copy that already reads
// the whole legend only gains the printed place; a copy that lost part of it
// gains the printed caption as its text, and keeps its own OCR fragments as
// evidence, so the Markdown, the source map and the figure pipeline all read
// one complete caption even when native image recovery fails.
function adoptNativeText(child, caption) {
    child.bbox = [...caption.bbox];
    child.pdfNativeCaption = true;
    child.nativeText = caption.text;
    if (coversCaption(captionText(child), caption.text)) return;
    child.ocrFragments = [...(child.fragments || [])];
    child.fragments = [nativeFragment(caption)];
}

function attachCaption(float, caption) {
    return {
        id: `${float.id}:pdf-caption`,
        kind: 'caption',
        pageIndex: caption.pageIndex,
        bbox: [...caption.bbox],
        fragments: [nativeFragment(caption)],
        pdfNativeCaption: true,
        nativeText: caption.text,
    };
}

function nativeFragment(caption) {
    return {
        pageIndex: caption.pageIndex,
        bbox: [...caption.bbox],
        lines: caption.lineBBoxes.map((bbox, index) => ({
            bbox: [...bbox],
            spans: [{ type: 'text', content: caption.lineTexts[index] }],
        })),
    };
}

// The OCR copy reads the whole native caption: every printed word is there.
function coversCaption(text, native) {
    const words = new Set(normalize(text).split(' '));
    const printed = normalize(native).split(' ').filter(Boolean);
    return printed.length > 0 && printed.every(word => words.has(word));
}

// A misfiled child is moved off its float, keeping its id, box and text in the
// record of what the repair took, so nothing is dropped without evidence.
function releaseChildCopies(ir, copies, destination) {
    for (const { float, child } of copies) {
        if (!(float.children || []).includes(child)) continue;
        const list = ir.releasedCaptions || (ir.releasedCaptions = []);
        list.push({ id: child.id, from: float.id, into: destination.id,
            reason: 'native-caption', pageIndex: child.pageIndex,
            captionId: destination.pdfFigure.id, originalCaption: child });
        float.children = float.children.filter(candidate => candidate !== child);
    }
}

// The body copy of the native caption is consumed, never deleted: its role
// keeps it out of stitching, reading order and sections, while its fragments
// and geometry stay, so the source map and any correction still point at the
// same text. The record names the float whose legend it printed.
function releaseTextCopies(ir, texts, destination, report) {
    for (const { block, caption } of texts) {
        block.role = BLOCK_ROLE.CAPTION;
        block.captionConsumed = true;
        block.captionConsumedFor = destination.id;
        block.nativeCaptionId = caption.id;
        const list = ir.releasedCaptions || (ir.releasedCaptions = []);
        list.push({ id: block.id, from: destination.id, reason: 'native-caption',
            pageIndex: block.pageIndex, captionId: caption.id });
        report.released++;
    }
}

function sameCaption(child, caption) {
    const text = captionText(child);
    if (!text || !sameLabelNumber(text, caption.label)) return false;
    return wordsMatch(text, caption.text) && boxMatches(child.bbox, caption.bbox);
}

// The OCR copy and the printed caption name the same number. Shared words are
// not enough: "Figure 2" and "Figure 3" share every word but the digit, and
// two neighbouring legends can read alike.
function sameLabelNumber(text, label) {
    const first = labelNumber(text);
    const second = labelNumber(label);
    return Boolean(first) && first === second;
}

function bareLabelAt(child, caption) {
    const text = captionText(child).trim();
    if (!text || !LABEL_ONLY.test(text)) return false;
    if (!wordsMatch(text, caption.label)) return false;
    // A bare OCR label box may cover the label line only, or the label and the
    // description printed under it; either is the same place on the page.
    return boxMatches(child.bbox, caption.labelBBox) || boxMatches(child.bbox, caption.bbox);
}

function captionText(child) {
    return (child.fragments || []).map(fragment => fragmentText(fragment)).filter(Boolean).join(' ');
}

function wordsMatch(left, right) {
    const first = normalize(left);
    const second = normalize(right);
    if (!first || !second) return false;
    if (first === second) return true;
    const words = new Set(first.split(' '));
    const other = new Set(second.split(' '));
    let shared = 0;
    for (const word of words) if (other.has(word)) shared++;
    return shared / Math.max(words.size, other.size) >= MIN_WORD_SHARE;
}

function normalize(value) {
    return String(value || '').normalize('NFKC').toLowerCase()
        .replace(/[\s\p{Zs}]+/gu, ' ')
        .replace(/[.:：。|｜—–-]+$/u, '')
        .trim();
}

function boxMatches(box, native) {
    if (!validBox(box) || !validBox(native)) return false;
    const overlapY = Math.min(box[3], native[3]) - Math.max(box[1], native[1]);
    const smallest = Math.min(box[3] - box[1], native[3] - native[1]);
    const horizontal = Math.min(box[2], native[2]) - Math.max(box[0], native[0]);
    const narrowest = Math.min(box[2] - box[0], native[2] - native[0]);
    if (horizontal <= 0 || narrowest <= 0 || horizontal / narrowest < 0.5) return false;
    if (overlapY > 0 && smallest > 0 && overlapY / smallest >= MIN_BASELINE_SHARE) return true;
    // A line box printed a hair under the native line is that same line.
    return -overlapY <= EDGE_TOLERANCE;
}

function captionChildren(float) {
    return (float.children || []).filter(child => child.kind === 'caption');
}

function hasCaption(float) {
    return captionChildren(float).length > 0;
}

// The picture's own legend: a caption child that is not a copy of a native
// caption printed at that caption's own place. A misfiled copy says where the
// PDF prints another picture's legend, not that this picture has one.
function hasOwnCaption(float, captions) {
    return captionChildren(float).some(child => !copiesNativeCaption(child, captions));
}

// A child that prints this very native caption, whole or in part: the legend
// itself, its bare number at the label, or its description where it is printed.
function copiesNativeCaption(child, captions) {
    return captions.some(caption => sameCaption(child, caption) || bareLabelAt(child, caption)
        || completesCaption(child, caption));
}

function isProse(block) {
    if (!block || block.captionConsumed) return false;
    if (block.role === BLOCK_ROLE.FLOAT || block.role === BLOCK_ROLE.CHROME
        || block.role === BLOCK_ROLE.PAGE_NOTE || block.role === BLOCK_ROLE.FLOAT_NOTE) return false;
    return block.kind === BLOCK_KIND.TEXT || block.kind === BLOCK_KIND.TITLE
        || block.kind === BLOCK_KIND.LIST || block.kind === BLOCK_KIND.REFERENCE
        || block.role === BLOCK_ROLE.HEADING;
}

function sameBand(left, right) {
    return verticalGap(left, right) <= BAND_TOLERANCE;
}

// Text printed in the gap between two columns keeps them apart; text inside
// one column does not.
function betweenColumns(box, first, second) {
    const [left, right] = first[0] <= second[0] ? [first, second] : [second, first];
    if (box[2] <= left[2] + 2 || box[0] >= right[0] - 2) return false;
    return box[1] < Math.max(left[3], right[3]) && box[3] > Math.min(left[1], right[1]);
}

function verticalGap(box, other) {
    if (box[3] <= other[1]) return other[1] - box[3];
    if (other[3] <= box[1]) return box[1] - other[3];
    return 0;
}

function horizontalGap(box, other) {
    if (box[2] < other[0]) return other[0] - box[2];
    if (other[2] < box[0]) return box[0] - other[2];
    return 0;
}

function validBox(box) {
    return Array.isArray(box) && box.length === 4 && box.every(Number.isFinite)
        && box[2] > box[0] && box[3] > box[1];
}

function unionOf(boxes) {
    let output = null;
    for (const box of boxes) {
        if (!validBox(box)) continue;
        output = output
            ? [Math.min(output[0], box[0]), Math.min(output[1], box[1]),
                Math.max(output[2], box[2]), Math.max(output[3], box[3])]
            : [...box];
    }
    return output;
}

function median(values) {
    const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}
