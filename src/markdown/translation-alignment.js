import { GFM, parser as markdownParser } from '@lezer/markdown';

export const TRANSLATION_MARKDOWN_PARSER = markdownParser.configure(GFM);
export const PROTECTED_PLACEHOLDER_PATTERN = /MKTEROPROTECTED\d+PLACEHOLDER/g;
export const TRANSLATION_PROTECTED_CONTENT_CHANGED = 'TRANSLATION_PROTECTED_CONTENT_CHANGED';

const VERSION = 1;
const SENTENCE_END = /[.!?\u3002\uff01\uff1f]+/gu;
const CLOSING_PUNCTUATION = /^["')\]\u2019\u201d\u3009\u300b\u300d\u300f\u3011\uff09]/u;
const NUMBERED_ABBREVIATION = /\b(?:figs?|eqs?|refs?|secs?|nos?|vols?|pp|ch|tabs?)$/iu;
const ABBREVIATION = /\b(?:e\.g|i\.e|viz|vs|cf|approx|et[ \t]+al|dept|inc|ltd|etc|ph\.d|a\.m|p\.m)$/iu;
const TITLE_ABBREVIATION = /\b(?:dr|prof|mr|mrs|ms|st)$/iu;
const INITIALS = /(?:^|[^\p{L}\p{N}.])(?:[A-Z]\.)*[A-Z]$/u;
const LETTERED_APPENDIX = /\b[Aa]ppendix[ \t]+[A-Z]$/u;
const UNIT_ABBREVIATION = /\d[\d.,]*[ \t]*(?:ms|s|min|h|sec|hrs?|cm|mm|km|g|kg|mol|mL)$/iu;
const WRAPPERS = new Set(['Emphasis', 'StrongEmphasis', 'Strikethrough', 'Link', 'Image']);
const OPAQUE = new Set(['InlineCode', 'URL', 'Autolink', 'Escape', 'Entity']);
const STRUCTURE = new Set([
    'BulletList', 'OrderedList', 'ListItem', 'ListMark', 'Paragraph', 'Task', 'TaskMarker',
    'Table', 'TableHeader', 'TableRow', 'TableCell', 'TableDelimiter', 'HeaderMark', 'HardBreak',
]);

export function createAlignmentPlan(block) {
    return planAlignment(block)?.plan || null;
}

function planAlignment(block) {
    if (!block?.translatable || typeof block.id !== 'string'
        || block.continuesFrom || block.continuationOf || block.continuesAcrossEquation) return null;
    const source = block.markdown;
    const protection = readProtection(block, block.requestMarkdown);
    const layout = typeof source === 'string' && readLayout(source, block.nodeType);
    if (!protection || protection.markdown !== source || !layout) return null;
    // Reject partial overlap with a parser-owned marker or line break. There is
    // no safe place to reconstruct it from an independently translated unit.
    const opaque = mergeOverlappingRanges([...layout.opaque, ...protection.edits.map(({ restoredFrom, restoredTo }) => ({
        from: restoredFrom, to: restoredTo,
    }))]);
    const fullyProtected = new Set(protection.edits.map(edit => `${edit.restoredFrom}:${edit.restoredTo}`));
    const preservedImages = layout.images.filter(image => fullyProtected.has(`${image.from}:${image.to}`));
    // A partly protected image has a translatable alt or caption. Do not
    // claim that its image wrapper and its description are one sentence.
    if (preservedImages.length !== layout.images.length) return null;
    const candidates = [];
    for (const [index, section] of layout.sections.entries()) {
        for (const prose of excludeImageLines(source, section, preservedImages)) {
            const spans = sentenceRanges(source, prose, opaque, layout.closers);
            if (!spans) return null;
            for (const range of spans) candidates.push({ index, range });
        }
    }
    const reverseEdits = protection.edits.map(edit => ({
        from: edit.restoredFrom,
        to: edit.restoredTo,
        text: edit.placeholder,
    }));
    const protectedRanges = projectMarkdownRanges(candidates.map(value => value.range), reverseEdits);
    const units = [];
    const sourceRanges = [];
    const sections = [];
    const ranges = [];
    for (const [i, { index, range }] of candidates.entries()) {
        const prose = protectedRanges[i];
        if (!prose || /[\r\n]/u.test(source.slice(range.from, range.to))
            || crossesWrapper(range, layout.wrappers)) return null;
        const sourceMarkdown = block.requestMarkdown.slice(prose.from, prose.to);
        if (!/\p{L}/u.test(sourceMarkdown.replace(PROTECTED_PLACEHOLDER_PATTERN, ''))) continue;
        sourceRanges.push([range]);
        ranges.push(prose);
        sections.push(index);
        units.push({ id: '', sourceMarkdown });
    }
    if (!units.length) return null;
    const stamp = sourceStamp(source);
    units.forEach((unit, index) => { unit.id = `${block.id}:s${index + 1}:${stamp}`; });
    return { plan: { units, sourceRanges }, ranges, sections, layout };
}

// Cache records already keep the exact source document. This compact stamp
// additionally prevents stale or cross-block IDs from matching at projection.
function sourceStamp(source) {
    let a = 0x811c9dc5;
    let b = 0x9e3779b9;
    for (let i = 0; i < source.length; i++) {
        const code = source.charCodeAt(i);
        a = Math.imul(a ^ code, 0x01000193);
        b = Math.imul(b ^ code, 0x85ebca6b);
    }
    return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

function readLayout(source, nodeType) {
    const root = TRANSLATION_MARKDOWN_PARSER.parse(source).topNode.firstChild;
    if (!root || root.nextSibling || root.name !== nodeType) return null;
    const sections = [];
    const shape = [];
    const wrappers = [];
    const images = [];
    const opaque = [];
    const closers = new Map();
    const columns = root.name === 'Table' ? headerWidth(root.firstChild) : 0;
    let unsupported = false;
    root.cursor().iterate(cursor => {
        const { from, to, name } = cursor;
        const node = cursor.node;
        const parent = node.parent?.name;
        if (name === 'HTMLBlock' || name === 'HTMLTag' || name === 'Blockquote') unsupported = true;
        if (STRUCTURE.has(name)) {
            shape.push(node.firstChild || !/Mark(?:er)?$|Delimiter$|Break$/u.test(name)
                ? name : `${name}:${source.slice(from, to)}`);
        }
        if (name === 'TableHeader' || name === 'TableRow') {
            let column = 0;
            for (let child = node.firstChild; child; child = child.nextSibling) {
                if (child.name === 'TableDelimiter' && child.prevSibling) column++;
                if (child.name === 'TableCell' && column < columns) {
                    sections.push({ from: child.from, to: child.to });
                }
            }
        }
        if (name === 'Paragraph' && (node.from === root.from && root.name === name || parent === 'ListItem')) {
            sections.push({ from, to });
        }
        if (name === 'Task' && parent === 'ListItem') {
            sections.push({ from: node.firstChild.to, to });
        }
        if (WRAPPERS.has(name)) {
            wrappers.push({ from, to });
            if (name === 'Image') {
                images.push({ from, to });
                opaque.push({ from, to });
                return false;
            }
            const close = name === 'Link'
                ? children(node).filter(child => child.name === 'LinkMark')[1]
                : node.lastChild;
            if (close) {
                closers.set(close.from, to);
                opaque.push({ from: close.from, to });
            }
        }
        if (OPAQUE.has(name)) {
            opaque.push({ from, to });
            return false;
        }
    }, cursor => {
        if (STRUCTURE.has(cursor.name)) shape.push('/');
    });
    if (/^(?:ATXHeading[1-6]|SetextHeading[12])$/u.test(nodeType)) {
        const marks = children(root).filter(node => node.name === 'HeaderMark');
        sections.push({
            from: nodeType.startsWith('ATX') ? marks.shift().to : root.from,
            to: marks[0]?.from ?? root.to,
        });
    }
    return !unsupported && sections.length
        ? { sections, shape, wrappers: mergeOverlappingRanges(wrappers), images, opaque, closers }
        : null;
}

function children(node) {
    const result = [];
    for (let child = node.firstChild; child; child = child.nextSibling) result.push(child);
    return result;
}

function headerWidth(header) {
    let width = 1;
    for (let child = header.firstChild; child?.nextSibling; child = child.nextSibling) {
        if (child.name === 'TableDelimiter' && child.prevSibling) width++;
    }
    return width;
}

function crossesWrapper(range, wrappers) {
    for (let i = firstRangeEndingAfter(wrappers, range.from); i < wrappers.length; i++) {
        const wrapper = wrappers[i];
        if (wrapper.from >= range.to) break;
        if (wrapper.from < range.from || wrapper.to > range.to) return true;
    }
    return false;
}

function mergeOverlappingRanges(ranges) {
    const merged = [];
    for (const range of ranges.sort((a, b) => a.from - b.from || b.to - a.to)) {
        const previous = merged.at(-1);
        if (previous && range.from < previous.to) previous.to = Math.max(previous.to, range.to);
        else merged.push({ ...range });
    }
    return merged;
}

function* excludeImageLines(source, section, images) {
    let from = section.from;
    for (let i = firstRangeEndingAfter(images, from); i < images.length; i++) {
        const image = images[i];
        if (image.from >= section.to) break;
        if (image.from < from || image.to > section.to) continue;
        const lineStart = Math.max(from, source.lastIndexOf('\n', image.from - 1) + 1);
        const newline = source.indexOf('\n', image.to);
        const lineEnd = newline < 0 ? section.to : Math.min(newline, section.to);
        if (source.slice(lineStart, image.from).trim() || source.slice(image.to, lineEnd).trim()) continue;
        if (lineStart > from) yield { from, to: lineStart };
        from = lineEnd + 1;
    }
    if (from < section.to) yield { from, to: section.to };
}

function sentenceRanges(source, section, opaque, closers) {
    const value = source.slice(section.from, section.to);
    const ranges = [];
    let start = section.from;
    let skipUntil = section.from;
    let opaqueIndex = firstRangeEndingAfter(opaque, start);
    for (const match of value.matchAll(SENTENCE_END)) {
        const from = section.from + match.index;
        if (from < skipUntil) continue;
        while (opaqueIndex < opaque.length && opaque[opaqueIndex].to <= from) opaqueIndex++;
        if (opaque[opaqueIndex]?.from <= from) continue;
        let end = from + match[0].length;
        if (match[0] === '.') {
            const kind = periodKind(source, start, from, end, section.to);
            if (kind === 'ambiguous') return null;
            if (kind === 'internal') continue;
        }
        end = sentenceSuffixEnd(source, end, section.to, closers);
        if (match[0] === '.' && /^[ \t]*[a-z]/u.test(source.slice(end, Math.min(end + 32, section.to)))) return null;
        // Citation markers placed immediately after terminal punctuation
        // belong to the cited sentence, not the prose that follows them.
        const citation = /^[ \t]*\[\d{1,4}[a-z]?(?:[ \t]*[-–—,;][ \t]*\d{1,4}[a-z]?)*\]/iu
            .exec(source.slice(end, Math.min(section.to, end + 128)));
        if (citation) {
            const closingBracket = end + citation[0].length - 1;
            end = sentenceSuffixEnd(source, closingBracket, section.to, closers);
        }
        const range = trimmedRange(source, { from: start, to: end });
        if (range) ranges.push(range);
        start = skipUntil = end;
    }
    const tail = trimmedRange(source, { from: start, to: section.to });
    if (tail) ranges.push(tail);
    return ranges;
}

function sentenceSuffixEnd(source, from, limit, closers) {
    let end = from;
    while (end < limit) {
        const closeTo = closers.get(end);
        if (closeTo !== undefined) end = closeTo;
        else if (CLOSING_PUNCTUATION.test(source[end]) || /[.!?\u3002\uff01\uff1f]/u.test(source[end])) end++;
        else break;
    }
    return end;
}

function firstRangeEndingAfter(ranges, position) {
    let left = 0;
    let right = ranges.length;
    while (left < right) {
        const mid = (left + right) >>> 1;
        if (ranges[mid].to <= position) left = mid + 1;
        else right = mid;
    }
    return left;
}

function periodKind(source, start, from, end, limit) {
    const before = source.slice(Math.max(start, from - 32), from);
    const next = source.slice(end, Math.min(end + 64, limit));
    if (/\d$/u.test(before) && /^\d/u.test(next)) return 'internal';
    if (/(?:^|[^\p{L}\p{N}.])(?:[A-Za-z]\.)*[A-Za-z]$/u.test(before)
        && /^[A-Za-z]\./u.test(next)) return 'internal';
    if (!next.trim()) return 'end';
    if (NUMBERED_ABBREVIATION.test(before) && /^[ \t]*(?:\(?\d|[IVXLCDM]+\b)/u.test(next)) return 'internal';
    if (TITLE_ABBREVIATION.test(before) && /^[ \t]+\p{Lu}/u.test(next)) return 'internal';
    if (LETTERED_APPENDIX.test(before) && /^[ \t]+\p{Lu}/u.test(next)) return 'end';
    const abbreviated = ABBREVIATION.test(before) || UNIT_ABBREVIATION.test(before) || INITIALS.test(before);
    if (abbreviated && /^[ \t]*[\p{Ll},;:]/u.test(next)) return 'internal';
    if (abbreviated && next.startsWith('](')) return 'internal';
    if ((abbreviated || NUMBERED_ABBREVIATION.test(before) || TITLE_ABBREVIATION.test(before))
        && /^["'\p{Pe}\p{Pf}\s]*[\p{L}\p{N}]/u.test(next)) return 'ambiguous';
    if (/^\s*[a-z]/u.test(next)) return 'ambiguous';
    return 'end';
}

export function assembleAlignedBlock(block, returnedUnits, targetLanguage) {
    const result = assemble(block, planAlignment(block), returnedUnits, sentenceSeparator(targetLanguage));
    return { id: block.id, markdown: result.markdown, alignment: { version: VERSION, units: result.units } };
}

export function verifyAlignedBlock(block, translation, targetLanguage) {
    if (translation?.id !== block.id || translation.alignment?.version !== VERSION) return null;
    const planned = planAlignment(block);
    if (!planned || !storedRangesMatch(translation.alignment.units, planned.plan)) return null;
    const separators = targetLanguage === undefined ? [' ', ''] : [sentenceSeparator(targetLanguage)];
    for (const separator of separators) {
        try {
            const result = assemble(block, planned, translation.alignment.units, separator);
            if (result.markdown === translation.markdown) return result;
        }
        catch { /* Another language's default separator may not parse. */ }
    }
    return null;
}

function storedRangesMatch(storedUnits, plan) {
    if (!Array.isArray(storedUnits) || storedUnits.length !== plan.units.length) return false;
    const rangesByID = new Map(storedUnits.map(unit => [unit?.id, unit?.sourceRanges]));
    return plan.units.every(({ id }, i) => {
        const actual = rangesByID.get(id);
        const expected = plan.sourceRanges[i];
        return Array.isArray(actual) && actual.length === expected.length
            && expected.every(({ from, to }, index) => actual[index]?.from === from && actual[index]?.to === to);
    });
}

function sentenceSeparator(targetLanguage) {
    return /^(?:zh|ja)(?:-|$)/iu.test(String(targetLanguage || '')) ? '' : ' ';
}

function assemble(block, planned, returnedUnits, separator) {
    if (!planned || !Array.isArray(returnedUnits) || returnedUnits.length !== planned.plan.units.length) {
        throw new Error('The Markdown alignment units are incomplete or unsupported');
    }
    const byID = new Map(returnedUnits.map(unit => [unit?.id, unit?.translatedMarkdown]));
    if (byID.size !== returnedUnits.length) throw new Error('The Markdown alignment contains a duplicate unit ID');
    let markdown = '';
    let cursor = 0;
    const protectedRanges = [];
    const units = planned.plan.units.map(({ id, sourceMarkdown }, index) => {
        const translatedMarkdown = typeof byID.get(id) === 'string' ? byID.get(id).trim() : '';
        if (!/[\p{L}\p{N}]/u.test(translatedMarkdown.replace(PROTECTED_PLACEHOLDER_PATTERN, ''))
            || /[\r\n]|MKTEROBLOCK\d+(?:START|END)MARKER/u.test(translatedMarkdown)) {
            throw new Error('The Markdown alignment unit is missing, empty, or structurally invalid');
        }
        if (!sameItems(placeholders(sourceMarkdown), placeholders(translatedMarkdown))) throw protectedContentChangedError();
        const { from, to } = planned.ranges[index];
        const gap = block.requestMarkdown.slice(cursor, from);
        const withinSection = index > 0 && planned.sections[index] === planned.sections[index - 1];
        markdown += withinSection && /^ ?$/u.test(gap) ? separator : gap;
        protectedRanges.push({ from: markdown.length, to: markdown.length + translatedMarkdown.length });
        markdown += translatedMarkdown;
        cursor = to;
        return { id, translatedMarkdown, sourceRanges: planned.plan.sourceRanges[index] };
    });
    markdown += block.requestMarkdown.slice(cursor);
    const protection = inspectTranslatedBlock(block, markdown);
    const restoredRanges = projectMarkdownRanges(protectedRanges, protection.edits);
    const layout = readLayout(protection.markdown, block.nodeType);
    if (!layout || !sameItems(layout.shape, planned.layout.shape)
        || layout.sections.length !== planned.layout.sections.length
        || restoredRanges.some((range, index) => {
            const section = layout.sections[planned.sections[index]];
            return !range || range.from < section.from || range.to > section.to
                || crossesWrapper(range, layout.wrappers);
        })) {
        throw new Error('The Markdown alignment changed the source structure');
    }
    return { markdown, units, restoredRanges, sourceRanges: planned.plan.sourceRanges };
}

function placeholders(markdown) {
    return markdown.match(PROTECTED_PLACEHOLDER_PATTERN) || [];
}

function sameItems(a, b) {
    return a.length === b.length && a.every((item, index) => item === b[index]);
}

function readProtection(block, markdown) {
    if (typeof markdown !== 'string') return null;
    const fragments = block.protectedFragments || [];
    const edits = [];
    let delta = 0;
    let index = 0;
    const restored = markdown.replace(PROTECTED_PLACEHOLDER_PATTERN, (placeholder, from) => {
        const fragment = fragments[index++];
        if (fragment?.placeholder !== placeholder) return placeholder;
        const to = from + placeholder.length;
        const text = fragment.markdown;
        const restoredFrom = from + delta;
        edits.push({ from, to, text, placeholder, restoredFrom, restoredTo: restoredFrom + text.length });
        delta += text.length - placeholder.length;
        return text;
    });
    return index === fragments.length && edits.length === index ? { markdown: restored, edits } : null;
}

// Edits and ranges are sorted half-open intervals in the same Markdown.
// A partial edit has no well-defined projection, unlike a contained edit.
export function projectMarkdownRanges(ranges, edits) {
    let index = 0;
    let delta = 0;
    return ranges.map(range => {
        if (!range) return null;
        while (index < edits.length && edits[index].to <= range.from) {
            const edit = edits[index++];
            delta += edit.text.length - (edit.to - edit.from);
        }
        const from = range.from + delta;
        let to = range.to + delta;
        for (let j = index; j < edits.length && edits[j].from < range.to; j++) {
            const edit = edits[j];
            if (edit.from < range.from || edit.to > range.to) return null;
            to += edit.text.length - (edit.to - edit.from);
        }
        return to > from ? { from, to } : null;
    });
}

export function trimmedRange(markdown, range) {
    if (!range) return null;
    const slice = markdown.slice(range.from, range.to);
    const start = slice.trimStart();
    const from = range.to - start.length;
    const to = from + start.trimEnd().length;
    return to > from ? { from, to } : null;
}

export function validateTranslatedBlock(block, translatedMarkdown) {
    return inspectTranslatedBlock(block, String(translatedMarkdown || '').trim()).markdown;
}

function inspectTranslatedBlock(block, translated) {
    if (!block?.translatable) throw new TypeError('Only translatable Markdown blocks can be validated');
    if (!translated) throw new Error('The translated Markdown block is empty');
    const protection = readProtection(block, translated);
    if (!protection) throw protectedContentChangedError();
    const tree = TRANSLATION_MARKDOWN_PARSER.parse(translated);
    if (protection.edits.length) {
        const originalTree = TRANSLATION_MARKDOWN_PARSER.parse(block.requestMarkdown);
        for (const { placeholder } of block.protectedFragments) {
            if (placeholderNodePath(originalTree, block.requestMarkdown, placeholder)
                !== placeholderNodePath(tree, translated, placeholder)) {
                throw new Error('The translated Markdown block changed protected structure');
            }
        }
    }
    const node = tree.topNode.firstChild;
    if (!node || node.nextSibling || node.name !== block.nodeType) {
        throw new Error('The translated Markdown block changed its structure');
    }
    let unsafe = false;
    tree.iterate({
        enter(node) {
            if (node.name === 'HTMLBlock' || node.name === 'HTMLTag' || node.name === 'Image') unsafe = true;
        },
    });
    if (unsafe) throw new Error('The translated Markdown block contains unsafe structure');
    return protection;
}

function placeholderNodePath(tree, source, placeholder) {
    const from = source.indexOf(placeholder);
    if (from < 0) return '';
    const to = from + placeholder.length;
    const path = [];
    for (let node = tree.resolveInner(from, 1); node; node = node.parent) {
        if (node.from <= from && node.to >= to) path.push(node.name);
    }
    return path.reverse().join('/');
}

export function protectedContentChangedError() {
    const error = new Error('The translated Markdown block changed protected content');
    error.code = TRANSLATION_PROTECTED_CONTENT_CHANGED;
    return error;
}
