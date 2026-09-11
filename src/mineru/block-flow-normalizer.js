import { GFM, parser as markdownParser } from '@lezer/markdown';
import { isValidSourceMapEntry } from '../core/markdown-source-map.js';

const MARKDOWN_PARSER = markdownParser.configure(GFM);
const ATX_HEADING_PATTERN = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
const APPENDIX_TITLE_PATTERN = /^(?:appendix|附录)\b/i;
const APPENDIX_SUBSECTION_PATTERN = /^[A-Z]\.\d+\b/;

export function reassembleMinerUBlockFlow(markdown, sourceMap) {
    const source = String(markdown || '');
    if (!source) return source;
    const mapped = Array.isArray(sourceMap)
        ? reorderMappedCodeBlocks(source, sourceMap)
        : source;
    return relocateOrphanAppendixCode(mapped);
}

function reorderMappedCodeBlocks(source, sourceMap) {
    const entries = sourceMap
        .filter(entry => isValidSourceMapEntry(entry, source.length))
        .sort((left, right) => left.markdownFrom - right.markdownFrom);
    if (entries.length < 2) return source;

    const units = entries.map((entry, index) => ({
        entry,
        text: source.slice(
            entry.markdownFrom,
            index + 1 < entries.length
                ? entries[index + 1].markdownFrom
                : source.length
        ),
    }));
    const reordered = reorderMisplacedCodeUnits(units);
    if (reordered.every((unit, index) => unit === units[index])) return source;
    return source.slice(0, entries[0].markdownFrom)
        + reordered.map(unit => unit.text).join('');
}

function relocateOrphanAppendixCode(source) {
    const headings = collectAtxHeadings(source);
    const appendix = headings.find(heading => (
        APPENDIX_TITLE_PATTERN.test(heading.text)
    ));
    if (!appendix) return source;

    const fences = collectFencedCodeRanges(source);
    const orphan = fences.findLast(fence => (
        fence.to <= appendix.from
        && !source.slice(fence.to, appendix.from).trim()
    ));
    if (!orphan) return source;

    const sectionEnd = appendixSectionEnd(headings, appendix);
    const subsections = headings.filter(heading => (
        heading.from > appendix.from
        && heading.from < sectionEnd
        && APPENDIX_SUBSECTION_PATTERN.test(heading.text)
    ));
    const target = subsections.find(heading => {
        const next = headings.find(candidate => candidate.from > heading.from);
        const end = Math.min(next?.from ?? source.length, sectionEnd);
        return !fences.some(fence => (
            fence.from >= heading.to && fence.to <= end
        ));
    }) || subsections.at(-1) || appendix;
    if (orphan.from >= target.to) return source;

    const preceding = /(?:\r?\n[ \t]*){2}$/.exec(source.slice(0, orphan.from));
    const removalFrom = preceding
        ? orphan.from - preceding[0].length
        : orphan.from;
    const block = source.slice(removalFrom, orphan.to);
    return source.slice(0, removalFrom)
        + source.slice(orphan.to, target.to)
        + block
        + source.slice(target.to);
}

function collectAtxHeadings(source) {
    return [...source.matchAll(new RegExp(ATX_HEADING_PATTERN))].map(match => ({
        from: match.index,
        to: match.index + match[0].length,
        level: match[1].length,
        text: match[2].trim(),
    }));
}

function collectFencedCodeRanges(source) {
    const ranges = [];
    MARKDOWN_PARSER.parse(source).iterate({
        enter(node) {
            if (node.name !== 'FencedCode') return;
            ranges.push({ from: node.from, to: node.to });
            return false;
        },
    });
    return ranges;
}

function appendixSectionEnd(headings, appendix) {
    const next = headings.find(heading => (
        heading.from > appendix.from
        && heading.level <= appendix.level
        && !APPENDIX_SUBSECTION_PATTERN.test(heading.text)
    ));
    return next?.from ?? Infinity;
}

function reorderMisplacedCodeUnits(units) {
    const codeUnits = units
        .filter(unit => unit.entry.type === 'code')
        .sort((left, right) => compareVisualPosition(left.entry, right.entry));
    if (!codeUnits.length) return units;

    const ordered = units.filter(unit => unit.entry.type !== 'code');
    for (const codeUnit of codeUnits) {
        ordered.splice(insertionIndex(ordered, codeUnit), 0, codeUnit);
    }
    return ordered;
}

function insertionIndex(units, codeUnit) {
    let insertAt = 0;
    for (let index = 0; index < units.length; index++) {
        if (compareVisualPosition(units[index].entry, codeUnit.entry) < 0) {
            insertAt = index + 1;
        }
    }
    return insertAt;
}

function compareVisualPosition(left, right) {
    const leftPage = flowPageIndex(left);
    const rightPage = flowPageIndex(right);
    if (leftPage !== rightPage) return leftPage - rightPage;
    const leftBox = entryStartLocation(left).bbox;
    const rightBox = entryStartLocation(right).bbox;
    return leftBox[1] - rightBox[1]
        || leftBox[0] - rightBox[0]
        || left.markdownFrom - right.markdownFrom;
}

function flowPageIndex(entry) {
    return entry.locations.reduce((pageIndex, location) => (
        pageIndex === null || location.pageIndex < pageIndex
            ? location.pageIndex
            : pageIndex
    ), null);
}

function entryStartLocation(entry) {
    return entry.locations.reduce((start, location) => {
        if (!start
            || location.pageIndex < start.pageIndex
            || (location.pageIndex === start.pageIndex
                && (location.bbox[1] < start.bbox[1]
                    || (location.bbox[1] === start.bbox[1]
                        && location.bbox[0] < start.bbox[0])))) {
            return location;
        }
        return start;
    }, null);
}
