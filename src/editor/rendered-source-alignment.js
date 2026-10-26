import { collectFigureImageNodes } from '../figures/figure-model.js';
import { findInlineMathMatches } from '../markdown/markdown-html.js';
import { parseGFMTable } from '../markdown/markdown-tables.js';
import {
    createVisibleMarkdownTextIndex,
    htmlCellTypesetFormulas,
    htmlTableSourceCells,
} from '../markdown/markdown-visible-text.js';
import {
    hiddenMathTextNode,
    wrapRenderedAnnotationRange,
} from './pdf-annotations.js';

// A figure caption, a table caption, or a table cell renders its formulas as
// glyphs, so its text cannot be searched for in the Markdown it came from.
// Instead each rendered element is aligned with its source: every visible
// character maps to its own source character and every rendered formula to
// its whole `$…$`. A selection maps through that alignment, and a highlight
// is placed through it, so neither depends on how a formula reads as text.

const SKIPPABLE_SOURCE = /^[\s\\]$/u;
const TABLE_ELEMENTS = 'caption, td, th';

// Every rendered figcaption of a block that lines up with its own source, in
// order, with its atoms mapped to block-relative source offsets.
export function alignRenderedCaptions(container, source) {
    const aligned = [];
    pairWithCandidates(
        [...container.querySelectorAll('figcaption')],
        figureCaptionSourceCandidates(source).map(range => ({
            ...range,
            entries: rawSourceEntries(source, range.from, range.to),
        })),
        (element, atoms) => aligned.push({ element, atoms })
    );
    return aligned;
}

// Places each annotation whose visible text lies in aligned captions and
// cells, one mark per aligned element and range. Returns the annotations it
// could not place, for the text search: those with visible text outside the
// aligned elements, or no aligned text at all.
export function installAnnotationsByPosition(
    container,
    annotations,
    translate,
    source,
    sourceFrom
) {
    if (!annotations?.length
        || !Number.isInteger(sourceFrom)
        || !container.querySelector('figcaption, table')) {
        return annotations || [];
    }
    const alignment = prepareRenderedAlignment(container, source);
    if (!alignment.targets.length) return annotations;
    const blockTo = sourceFrom + source.length;
    let visible = null;
    return annotations.filter(annotation => {
        const ranges = (annotation.ranges || []).flatMap(range => {
            if (!Number.isInteger(range?.from) || !Number.isInteger(range?.to)) return [];
            const from = Math.max(range.from, sourceFrom) - sourceFrom;
            const to = Math.min(range.to, blockTo) - sourceFrom;
            return to > from ? [{ from, to }] : [];
        });
        if (!ranges.length) return true;
        visible ||= createVisibleMarkdownTextIndex(source, [], { imageMath: true });
        if (ranges.some(range => (
            showsTextOutside(range, alignment.covered, visible)
        ))) {
            return true;
        }
        const plan = [];
        for (const range of ranges) {
            alignment.targets.forEach((target, targetIndex) => {
                const span = spanIn(target.atoms, range);
                if (span) plan.push({ targetIndex, range, from: span.first.from });
            });
        }
        if (!plan.length) return true;
        // The note marker goes on the first span the reader sees.
        plan.sort((left, right) => left.from - right.from);
        let placed = 0;
        for (const { targetIndex, range } of plan) {
            const target = alignment.targets[targetIndex];
            const span = spanIn(target.atoms, range);
            if (!span) continue;
            wrapRenderedAnnotationRange(
                spanDOMRange(container.ownerDocument, span),
                placed ? { ...annotation, showNoteMarker: false } : annotation,
                translate
            );
            placed++;
            // The wrap split this element's text nodes. Its source entries
            // do not move, so only its rendered side is read again.
            target.atoms = alignRenderedAtoms(
                renderedTextAtoms(target.element),
                target.entries
            ) || [];
        }
        return false;
    });
}

// The block-relative source ranges of a selection inside the block's table
// captions and cells, one per element it covers, or null when it leaves them
// or selects text in one that does not line up with its source.
export function selectedTableCellRanges(container, range, source) {
    const start = closestElement(range.startContainer, TABLE_ELEMENTS);
    const end = closestElement(range.endContainer, TABLE_ELEMENTS);
    if (!start || !end || !container.contains(start) || !container.contains(end)) {
        return null;
    }
    const alignment = prepareRenderedAlignment(container, source, {
        figureCaptions: false,
    });
    const aligned = new Set(alignment.targets.map(target => target.element));
    for (const element of container.querySelectorAll(TABLE_ELEMENTS)) {
        if (!aligned.has(element) && selectsTextIn(range, element)) return null;
    }
    const ranges = [];
    for (const { atoms } of alignment.targets) {
        const selected = atoms.filter(atom => atomSelected(range, atom));
        if (!selected.length) continue;
        ranges.push({ from: selected[0].from, to: selected.at(-1).to });
    }
    return ranges.length ? ranges : null;
}

export function atomSelected(range, atom) {
    try {
        if (atom.math) return range.intersectsNode(atom.element);
        return range.comparePoint(atom.node, atom.offset) >= 0
            && range.comparePoint(atom.node, atom.offset + 1) <= 0;
    }
    catch {
        return false;
    }
}

// Every aligned figure caption, table caption and table cell of a block, as
// targets `{ element, entries, atoms }`, plus the block-relative source
// ranges they account for. A table counts as accounted for apart from the
// cells and captions that do not line up, so its delimiters and tags never
// keep a highlight from being placed.
function prepareRenderedAlignment(container, source, { figureCaptions = true } = {}) {
    const targets = [];
    const covered = [];
    const add = (element, atoms, candidate) => {
        targets.push({ element, entries: candidate.entries, atoms });
        covered.push({ from: candidate.from, to: candidate.to });
    };
    if (figureCaptions) {
        pairWithCandidates(
            [...container.querySelectorAll('figcaption')],
            figureCaptionSourceCandidates(source).map(range => ({
                ...range,
                entries: rawSourceEntries(source, range.from, range.to),
            })),
            add
        );
    }
    const tables = [...container.querySelectorAll('table')];
    if (!tables.length) return { targets, covered };
    const layout = tableSourceLayout(container, source);
    if (!layout) return { targets, covered };
    const renderedCells = tables.flatMap(table => [...table.querySelectorAll('td, th')]);
    const unaligned = [];
    if (layout.cells.length === renderedCells.length) {
        renderedCells.forEach((element, index) => {
            const cell = layout.cells[index];
            const atoms = alignRenderedAtoms(renderedTextAtoms(element), cell.entries);
            if (atoms) targets.push({ element, entries: cell.entries, atoms });
            else unaligned.push(cell);
        });
    }
    else {
        unaligned.push(...layout.cells);
    }
    const captionElements = tables.flatMap(table => [...table.querySelectorAll('caption')]);
    const usedCaptions = pairWithCandidates(
        captionElements,
        layout.captions,
        (element, atoms, candidate) => {
            targets.push({ element, entries: candidate.entries, atoms });
            if (!candidate.insideTable) covered.push({ from: candidate.from, to: candidate.to });
        }
    );
    unaligned.push(...layout.captions.filter((caption, index) => (
        caption.insideTable && !usedCaptions.has(index)
    )));
    for (const region of layout.regions) {
        covered.push(...subtractRanges(region, unaligned));
    }
    return { targets, covered };
}

// Pairs each element, in order, with the first unused candidate it lines up
// with, and returns the indexes of the candidates it used.
function pairWithCandidates(elements, candidates, add) {
    const used = new Set();
    for (const element of elements) {
        const atoms = renderedTextAtoms(element);
        for (const [index, candidate] of candidates.entries()) {
            if (used.has(index)) continue;
            const aligned = alignRenderedAtoms(atoms, candidate.entries);
            if (!aligned) continue;
            used.add(index);
            add(element, aligned, candidate);
            break;
        }
    }
    return used;
}

// Where a block's table cells and captions come from. A GFM table widget
// records where its table sits in the block with `data-table-source-from` and
// `data-table-source-to`; a caption line can sit in the block beside it.
function tableSourceLayout(container, source) {
    const html = container.classList.contains('cm-mktero-html-table')
        || (!container.classList.contains('cm-mktero-table')
            && /<table\b/iu.test(source));
    const layout = html ? htmlTableLayout(source) : gfmTableLayout(container, source);
    if (!layout) return null;
    layout.captions.push(...outsideLineCandidates(source, layout.regions));
    layout.captions.sort((left, right) => left.from - right.from);
    return layout;
}

// GFM cells render as inline Markdown, so their entries are the visible
// text of each cell (marks and escapes hidden), each formula as one entry.
function gfmTableLayout(container, source) {
    const recordedFrom = Number.parseInt(container.dataset?.tableSourceFrom, 10);
    const recordedTo = Number.parseInt(container.dataset?.tableSourceTo, 10);
    const tableFrom = Number.isInteger(recordedFrom) ? recordedFrom : 0;
    const tableTo = Number.isInteger(recordedTo) ? recordedTo : source.length;
    if (tableFrom < 0 || tableTo > source.length || tableTo <= tableFrom) return null;
    const model = parseGFMTable(source.slice(tableFrom, tableTo));
    if (!model) return null;
    const visible = createVisibleMarkdownTextIndex(source);
    const formulas = findInlineMathMatches(source);
    const cells = model.cellRanges.map(range => {
        if (!range) return { from: tableFrom, to: tableFrom, entries: [] };
        const from = tableFrom + range.from;
        const to = tableFrom + range.to;
        return { from, to, entries: visibleSourceEntries(visible, formulas, from, to) };
    });
    return {
        cells,
        captions: [],
        regions: [{ from: tableFrom, to: tableTo }],
    };
}

function visibleSourceEntries(visible, formulas, from, to) {
    const cellFormulas = formulas.filter(formula => (
        formula.start >= from && formula.end <= to
    ));
    const entries = [];
    const visibleTo = visible.visibleOffsetAt(to);
    let formula = null;
    for (let offset = visible.visibleOffsetAt(from); offset < visibleTo; offset++) {
        const sourceOffset = visible.sourceOffsetAt(offset);
        const inFormula = cellFormulas.find(candidate => (
            sourceOffset >= candidate.start && sourceOffset < candidate.end
        ));
        if (inFormula) {
            if (inFormula !== formula) {
                entries.push({ math: true, from: inFormula.start, to: inFormula.end });
            }
            formula = inFormula;
            continue;
        }
        formula = null;
        entries.push(characterEntry(visible.text[offset], sourceOffset));
    }
    return entries;
}

// HTML cells render their decoded text; a formula the renderer typesets is
// one entry, and text it leaves alone (a caption, `code`) stays characters.
function htmlTableLayout(source) {
    const regions = htmlTableRegions(source);
    if (!regions.length) return null;
    const cells = [];
    const captions = [];
    for (const region of regions) {
        const table = source.slice(region.from, region.to);
        for (const cell of htmlTableSourceCells(table)) {
            const formulas = htmlCellTypesetFormulas(table, cell.atoms);
            const atoms = cell.atoms.map(atom => ({
                ...atom,
                from: region.from + atom.from,
                to: region.from + atom.to,
            }));
            const entry = {
                from: atoms[0]?.from ?? region.from,
                to: atoms.at(-1)?.to ?? region.from,
                entries: decodedSourceEntries(atoms, formulas),
            };
            if (cell.tag === 'caption') captions.push({ ...entry, insideTable: true });
            else cells.push(entry);
        }
    }
    return { cells, captions, regions };
}

function decodedSourceEntries(atoms, formulas) {
    const entries = [];
    let cursor = 0;
    for (const formula of formulas) {
        for (; cursor < formula.startIndex; cursor++) {
            const atom = atoms[cursor];
            entries.push(characterEntry(atom.text, atom.from, atom.to));
        }
        entries.push({
            math: true,
            from: atoms[formula.startIndex].from,
            to: atoms[formula.endIndex].to,
        });
        cursor = formula.endIndex + 1;
    }
    for (; cursor < atoms.length; cursor++) {
        const atom = atoms[cursor];
        entries.push(characterEntry(atom.text, atom.from, atom.to));
    }
    return entries;
}

// Each top-level `<table>…</table>` of the source.
function htmlTableRegions(source) {
    const regions = [];
    let depth = 0;
    let from = 0;
    for (const match of source.matchAll(/<(\/?)table\b[^<>]*>/giu)) {
        if (!match[1]) {
            if (depth === 0) from = match.index;
            depth++;
        }
        else if (depth > 0) {
            depth--;
            if (depth === 0) regions.push({ from, to: match.index + match[0].length });
        }
    }
    return regions;
}

// Lines outside the tables that a rendered table caption can come from: each
// line, and each line with the next one, since a caption split into a label
// line and a description line renders as one caption.
function outsideLineCandidates(source, regions) {
    const lines = [];
    let offset = 0;
    for (const line of source.split('\n')) {
        const trimmed = line.trim();
        const from = offset + line.indexOf(trimmed);
        const to = from + trimmed.length;
        if (trimmed && !regions.some(region => from < region.to && to > region.from)) {
            lines.push({ from, to, entries: rawSourceEntries(source, from, to) });
        }
        offset += line.length + 1;
    }
    const candidates = [...lines];
    for (let index = 0; index + 1 < lines.length; index++) {
        const [first, second] = [lines[index], lines[index + 1]];
        if (regions.some(region => first.to <= region.from && second.from >= region.to)) {
            continue;
        }
        candidates.push({
            from: first.from,
            to: second.to,
            entries: [...first.entries, ...second.entries],
        });
    }
    return candidates.sort((left, right) => (
        left.from - right.from || left.to - right.to
    ));
}

// Where a block's captions can come from: every image description and every
// other non-blank line, in source order.
function figureCaptionSourceCandidates(source) {
    const candidates = collectFigureImageNodes(source)
        .filter(image => image.captionRange.to > image.captionRange.from)
        .map(image => image.captionRange);
    let offset = 0;
    for (const line of source.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('![') && !trimmed.startsWith('<')) {
            const from = offset + line.indexOf(trimmed);
            candidates.push({ from, to: from + trimmed.length });
        }
        offset += line.length + 1;
    }
    return candidates.sort((left, right) => left.from - right.from);
}

// An element as the reader sees it: each visible non-space character with
// its text node and offset, and each rendered formula as one atom.
function renderedTextAtoms(element) {
    const atoms = [];
    const document = element.ownerDocument;
    const walker = document.createTreeWalker(
        element,
        document.defaultView.NodeFilter.SHOW_ELEMENT
            | document.defaultView.NodeFilter.SHOW_TEXT
    );
    let skipping = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (skipping && skipping.contains(node)) continue;
        skipping = null;
        if (node.nodeType === 1) {
            if (node.classList?.contains('math-inline')) {
                atoms.push({ math: true, element: node });
                skipping = node;
            }
            continue;
        }
        if (hiddenMathTextNode(node)) continue;
        const text = node.textContent || '';
        for (let index = 0; index < text.length; index++) {
            if (!/\s/u.test(text[index])) {
                atoms.push({ math: false, node, offset: index, character: text[index] });
            }
        }
    }
    return atoms;
}

// Pairs every rendered atom with a source entry: a character with the same
// source character, a formula with the next source formula. A source space
// or backslash (an escape the reader does not show) may be passed over.
// Returns null when any visible character or formula does not line up.
function alignRenderedAtoms(atoms, entries) {
    if (!entries
        || atoms.filter(atom => atom.math).length
            !== entries.filter(entry => entry.math).length) {
        return null;
    }
    const aligned = [];
    let cursor = 0;
    for (const atom of atoms) {
        while (cursor < entries.length && !entryMatches(entries[cursor], atom)) {
            if (!skippableEntry(entries[cursor])) return null;
            cursor++;
        }
        if (cursor >= entries.length) return null;
        aligned.push({ ...atom, from: entries[cursor].from, to: entries[cursor].to });
        cursor++;
    }
    for (; cursor < entries.length; cursor++) {
        if (!skippableEntry(entries[cursor])) return null;
    }
    return aligned;
}

function entryMatches(entry, atom) {
    return atom.math
        ? entry.math
        : !entry.math && entry.character === atom.character;
}

function skippableEntry(entry) {
    return !entry.math && SKIPPABLE_SOURCE.test(entry.character);
}

// The characters of `source.slice(from, to)`, each formula as one entry.
function rawSourceEntries(source, from, to) {
    const text = source.slice(from, to);
    const entries = [];
    let cursor = 0;
    for (const formula of findInlineMathMatches(text)) {
        for (; cursor < formula.start; cursor++) {
            entries.push(characterEntry(text[cursor], from + cursor));
        }
        entries.push({ math: true, from: from + formula.start, to: from + formula.end });
        cursor = formula.end;
    }
    for (; cursor < text.length; cursor++) {
        entries.push(characterEntry(text[cursor], from + cursor));
    }
    return entries;
}

function characterEntry(character, from, to = from + 1) {
    return { math: false, character, from, to };
}

// Whether the reader shows any text of `range` outside the covered ranges.
function showsTextOutside(range, covered, visible) {
    return subtractRanges(range, covered).some(part => (
        /\S/u.test(visible.textForSourceRange(part.from, part.to))
    ));
}

function subtractRanges(range, removed) {
    let parts = [{ from: range.from, to: range.to }];
    for (const cut of removed) {
        if (cut.to <= cut.from) continue;
        parts = parts.flatMap(part => {
            if (cut.to <= part.from || cut.from >= part.to) return [part];
            return [
                { from: part.from, to: cut.from },
                { from: cut.to, to: part.to },
            ].filter(piece => piece.to > piece.from);
        });
    }
    return parts;
}

// The first and last atoms of `atoms` that `range` covers, or null.
function spanIn(atoms, range) {
    let first = null;
    let last = null;
    for (const atom of atoms) {
        if (atom.from >= range.to || atom.to <= range.from) continue;
        first ||= atom;
        last = atom;
    }
    return first ? { first, last } : null;
}

function spanDOMRange(document, { first, last }) {
    const range = document.createRange();
    if (first.math) range.setStartBefore(first.element);
    else range.setStart(first.node, first.offset);
    if (last.math) range.setEndAfter(last.element);
    else range.setEnd(last.node, last.offset + 1);
    return range;
}

function selectsTextIn(range, element) {
    return renderedTextAtoms(element).some(atom => atomSelected(range, atom));
}

function closestElement(node, selector) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    return element?.closest?.(selector) || null;
}
