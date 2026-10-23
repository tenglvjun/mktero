import { escapeImageDescription, parseAcademicFigureCaption } from '../../markdown/markdown-figures.js';
import { planFigureLayouts } from '../../markdown/figure-layout-normalizer.js';
import { BLOCK_KIND, BLOCK_ROLE } from './ir.js';
import {
    createHyphenationVocabulary,
    escapeLineStart,
    isStandaloneAddress,
    joinTextParts,
    normalizeOCRText,
    renderInlineSpans,
    sanitizeTableHTML,
} from './text.js';

export const DOCUMENT_STRUCTURE = 'mineru-ir-v1';

const BULLET_START = /^(?:[•●○◦▪▫‣∙·■□➢➤►✓✔]\s*|-\s+)(?=\S)/u;
const CODE_LANGUAGE = /^[a-z0-9+#-]{1,20}$/u;
const SKIPPED_ROLES = new Set([BLOCK_ROLE.CHROME, BLOCK_ROLE.PAGE_NOTE]);

// Writes the document IR as Markdown and records, for every block, the exact
// output range of each of its fragments. The source map comes from those
// ranges, so no text matching is needed afterwards.
export function serializeDocumentIR(ir, { vocabulary = createHyphenationVocabulary(ir), composites = null } = {}) {
    const units = [];
    const skipped = new Set(composites?.skippedBlockIds || []);
    const anchors = composites?.anchors || new Map();
    for (const block of ir.blocks) {
        for (const composite of anchors.get(block.id) || []) units.push(compositeUnit(composite));
        if (skipped.has(block.id)) continue;
        units.push(...blockUnits(block, vocabulary));
    }
    return assemble(applyFigureLayouts(units));
}

function blockUnits(block, vocabulary) {
    if (SKIPPED_ROLES.has(block.role)) return [];
    if (block.role === BLOCK_ROLE.FLOAT_NOTE && !block.attachedTo) return [];
    if (block.kind === BLOCK_KIND.DISCARDED) return [];
    if (block.role === BLOCK_ROLE.HEADING) return headingUnits(block, vocabulary);
    switch (block.kind) {
        case BLOCK_KIND.EQUATION:
            return equationUnits(block);
        case BLOCK_KIND.IMAGE:
        case BLOCK_KIND.CHART:
            return figureUnits(block);
        case BLOCK_KIND.TABLE:
            return tableUnits(block);
        case BLOCK_KIND.CODE:
            return codeUnits(block);
        case BLOCK_KIND.ALGORITHM:
            return algorithmUnits(block);
        default:
            return textUnits(block, vocabulary);
    }
}

// Inline text of all fragments, joined across line, column, and page breaks
// with the document's hyphenation rule. Returns the text and the output
// range of every fragment; a removed line-final hyphen belongs to neither.
function inlineText(block, vocabulary) {
    let text = '';
    const ranges = [];
    for (const fragment of block.fragments) {
        const lines = (fragment.lines || []).map(line => renderInlineSpans(line.spans)).filter(Boolean);
        if (!lines.length) continue;
        let from = -1;
        for (const line of lines) {
            const joined = joinTextParts(text, line, vocabulary);
            text = joined.text;
            if (from < 0) {
                from = text.length - line.length;
                const previous = ranges.at(-1);
                if (previous && previous.to > from) previous.to = from;
            }
        }
        ranges.push({ from, to: text.length, fragment });
    }
    return { text, ranges };
}

function textUnits(block, vocabulary) {
    const { text, ranges } = inlineText(block, vocabulary);
    if (!text) return [];
    if (block.role === BLOCK_ROLE.BODY && block.fragments.length === 1 && isStandaloneAddress(text)) {
        const address = text.trim();
        const output = `[${address}](https://${address})`;
        return [{ block, kind: 'text', type: 'text', text: output, fragments: wholeFragments(block, output) }];
    }
    const bullet = block.role === BLOCK_ROLE.REFERENCE ? null : BULLET_START.exec(text);
    let prefix = '';
    let body = text;
    if (bullet) {
        prefix = '- ';
        body = text.slice(bullet[0].length);
    }
    const escaped = block.role === BLOCK_ROLE.REFERENCE && /^\d{1,4}[.)]\s/u.test(body) ? body : escapeLineStart(body);
    // Offsets of the source text shift by the list prefix that replaced the
    // bullet and by a line-start escape inserted at the very beginning.
    const shift = prefix.length - (bullet ? bullet[0].length : 0) + escaped.length - body.length;
    const output = `${prefix}${escaped}`;
    return [{
        block,
        kind: prefix ? 'list' : 'text',
        type: 'text',
        text: output,
        fragments: ranges.map((range, index) => ({
            from: index === 0 ? 0 : Math.max(0, range.from + shift),
            to: index === ranges.length - 1 ? output.length : Math.max(0, range.to + shift),
            fragment: range.fragment,
        })),
    }];
}

function headingUnits(block, vocabulary) {
    const { text } = inlineText(block, vocabulary);
    const content = text.replace(/^#+\s*/u, '').replace(/\s+#+$/u, '').trim();
    if (!content) return [];
    const level = Math.min(6, Math.max(1, block.level || 2));
    const output = `${'#'.repeat(level)} ${content}`;
    return [{ block, kind: 'heading', type: 'text', text: output, fragments: wholeFragments(block, output) }];
}

function equationUnits(block) {
    const latex = String(block.latex || '')
        .replace(/\$\$/gu, '')
        .split('\n').map(line => line.trimEnd()).filter(line => line.trim())
        .join('\n')
        .trim();
    if (!latex) {
        return block.assetPath ? [imageUnit(block, null, block.assetPath, '', 'equation')] : [];
    }
    const output = `$$\n${latex}\n$$`;
    return [{ block, kind: 'math', type: 'equation', text: output, fragments: wholeFragments(block, output) }];
}

function figureUnits(block) {
    const bodies = block.children.filter(child => child.kind === 'body' && child.assetPath);
    const caption = captionText(block);
    const units = [];
    if (!bodies.length) units.push(...captionUnits(block));
    for (const [index, body] of bodies.entries()) {
        units.push(imageUnit(block, body, body.assetPath, index === bodies.length - 1 ? caption : '',
            block.kind === BLOCK_KIND.CHART ? 'chart' : 'image'));
    }
    units.push(...footnoteUnits(block));
    return units;
}

function tableUnits(block) {
    const body = block.children.find(child => child.kind === 'body');
    const captions = captionChildren(block).map(child => childText(child));
    const caption = captions.join(' ').trim();
    const figureCaption = /^(?:fig|figure)\b/iu.test(parseAcademicFigureCaption(caption)?.label || '');
    const units = [];
    if (figureCaption && body?.assetPath) {
        units.push(imageUnit(block, body, body.assetPath, caption, 'image'));
        units.push(...footnoteUnits(block));
        return units;
    }
    if (captions.length) {
        // MinerU writes a table label and its description as separate caption
        // lines; a hard line break keeps them in one caption paragraph.
        const output = captionChildren(block)
            .map(child => escapeLineStart(childInline(child))).filter(Boolean).join('  \n');
        if (output) units.push(childUnit(block, captionChildren(block), output, { caption: true }));
    }
    const html = sanitizeTableHTML(body?.html);
    if (html) units.push({ block, kind: 'table', type: 'table', text: html, fragments: wholeFragments(block, html) });
    else if (body?.assetPath) units.push(imageUnit(block, body, body.assetPath, '', 'image'));
    units.push(...footnoteUnits(block));
    return units;
}

function codeUnits(block) {
    const code = block.children.find(child => child.kind === 'body')?.code;
    if (!code) return [];
    const longest = Math.max(2, ...[...code.matchAll(/`+/gu)].map(match => match[0].length));
    const fence = '`'.repeat(longest + 1);
    const language = String(block.codeLanguage || '').toLowerCase();
    const output = `${fence}${CODE_LANGUAGE.test(language) ? language : ''}\n${code}\n${fence}`;
    const units = captionUnits(block);
    units.push({ block, kind: 'code', type: 'code', text: output, fragments: wholeFragments(block, output) });
    units.push(...footnoteUnits(block));
    return units;
}

// The renderer finds an algorithm between MinerU's container tags, so a
// line inside that looks like a div tag is escaped.
function algorithmUnits(block) {
    const code = block.children.find(child => child.kind === 'body')?.code;
    if (!code) return [];
    const content = code.split('\n').map(line => (
        /^\s*<\/?div\b/iu.test(line) ? line.replace('<', '\\<') : line
    )).join('\n');
    const output = '<div class="mineru-algorithm" style="white-space: pre-wrap; font-family:monospace;">\n'
        + `${content}\n</div>`;
    const units = captionUnits(block);
    units.push({ block, kind: 'algorithm', type: 'code', text: output, fragments: wholeFragments(block, output) });
    units.push(...footnoteUnits(block));
    return units;
}

function captionUnits(block) {
    const children = captionChildren(block);
    const caption = escapeLineStart(children.map(child => childInline(child)).filter(Boolean).join(' '));
    return caption ? [childUnit(block, children, caption, { caption: true })] : [];
}

function footnoteUnits(block) {
    return block.children
        .filter(child => child.kind === 'footnote' && child.role !== BLOCK_ROLE.CHROME)
        .map(child => ({ child, text: escapeLineStart(childInline(child)) }))
        .filter(({ text }) => text)
        .map(({ child, text }) => childUnit(block, [child], text, { footnote: true }));
}

// A caption or note paragraph is located by its own boxes, not the float's.
function childUnit(block, children, text, extra) {
    const fragments = children.flatMap(child => (child.fragments || [])
        .filter(fragment => fragment.bbox)
        .map(fragment => ({ from: 0, to: text.length, fragment, whole: true })));
    return {
        block,
        kind: 'text',
        type: 'text',
        text,
        fragments: fragments.length ? fragments : wholeFragments(block, text),
        ...extra,
    };
}

// Caption lines from top to bottom: MinerU can list a table label after
// the description printed under it.
function captionChildren(block) {
    return block.children
        .filter(child => child.kind === 'caption')
        .map((child, index) => ({ child, index }))
        .sort((left, right) => (left.child.bbox && right.child.bbox
            ? left.child.bbox[1] - right.child.bbox[1] : 0) || left.index - right.index)
        .map(({ child }) => child);
}

function captionText(block) {
    return captionChildren(block).map(child => childText(child)).join(' ').trim();
}

// Inline Markdown of a caption or note: escaped text and `$…$` math.
function childInline(child) {
    return (child.fragments || [])
        .flatMap(fragment => fragment.lines || [])
        .map(line => renderInlineSpans(line.spans))
        .filter(Boolean)
        .join(' ')
        .trim();
}

function childText(child) {
    return (child.fragments || [])
        .flatMap(fragment => fragment.lines || [])
        .map(line => line.spans.map(span => span.type === 'math'
            ? `$${String(span.content || '').trim()}$`
            : normalizeOCRText(span.content).replace(/\s+/gu, ' ').trim()).filter(Boolean).join(' '))
        .filter(Boolean)
        .join(' ')
        .trim();
}

function imageUnit(block, body, assetPath, caption, type) {
    const alt = caption ? escapeImageDescription(caption) : '';
    const text = `![${alt}](${assetPath})`;
    return {
        block,
        kind: 'image',
        type,
        text,
        image: { from: 0, to: text.length },
        ...(alt ? { caption: { from: 2, to: 2 + alt.length, text: caption } } : {}),
        child: body,
        assetPath,
        location: { pageIndex: block.pageIndex, bbox: body?.bbox || block.bbox },
        fragments: [{ from: 0, to: text.length, fragment: { pageIndex: block.pageIndex, bbox: body?.bbox || block.bbox } }],
    };
}

function compositeUnit(composite) {
    const alt = composite.captionText ? escapeImageDescription(composite.captionText) : '';
    const text = `![${alt}](${composite.assetPath})`;
    return {
        block: null,
        composite,
        kind: 'image',
        type: 'image',
        text,
        image: { from: 0, to: text.length },
        ...(alt ? { caption: { from: 2, to: 2 + alt.length, text: composite.captionText } } : {}),
        fragments: [{ from: 0, to: text.length, fragment: { pageIndex: composite.pageIndex, bbox: composite.bbox } }],
    };
}

function wholeFragments(block, text) {
    const fragments = block.fragments.filter(fragment => fragment.bbox);
    if (!fragments.length && block.bbox) fragments.push({ pageIndex: block.pageIndex, bbox: block.bbox });
    return fragments.map(fragment => ({ from: 0, to: text.length, fragment, whole: true }));
}

// A run of separate images that share one academic caption becomes a grid
// marker, as in the previous pipeline. The planner works on lines; every
// image unit is one line, so its decisions map back to whole units.
function applyFigureLayouts(units) {
    const imageBlocks = units
        .filter(unit => unit.kind === 'image' && unit.block && unit.child?.bbox)
        .map(unit => ({ assetPath: unit.assetPath, pageIndex: unit.block.pageIndex, bbox: unit.child.bbox }));
    if (imageBlocks.length < 2) return units;
    const unitAtLine = new Map();
    let line = 0;
    for (const [index, unit] of units.entries()) {
        unitAtLine.set(line, index);
        line += unit.text.split('\n').length + 1;
    }
    const draft = units.map(unit => unit.text).join('\n\n');
    const { markers, lineOverrides } = planFigureLayouts(draft, imageBlocks, {
        allowFallback: false,
        skipExistingPanelLayout: true,
    });
    if (!markers.size) return units;
    const unitByText = new Map();
    for (const [index, unit] of units.entries()) {
        if (unit.kind === 'image' && !unitByText.has(unit.text)) unitByText.set(unit.text, index);
    }
    const output = [...units];
    for (const [target, raw] of lineOverrides) {
        const targetUnit = unitAtLine.get(target);
        const sourceUnit = unitByText.get(raw.replace(/\r?\n$/u, ''));
        if (targetUnit === undefined || sourceUnit === undefined) return units;
        output[targetUnit] = units[sourceUnit];
    }
    const markerBefore = new Map();
    for (const [markerLine, marker] of markers) {
        const index = unitAtLine.get(markerLine);
        if (index === undefined) return units;
        markerBefore.set(index, marker.trimEnd());
    }
    const withMarkers = [];
    for (const [index, unit] of output.entries()) {
        if (markerBefore.has(index)) withMarkers.push({ block: null, kind: 'marker', text: markerBefore.get(index), fragments: [] });
        withMarkers.push(unit);
    }
    return withMarkers;
}

function separator(previous, next) {
    if (previous.kind === 'marker') return '\n';
    if (previous.kind === 'list' && next.kind === 'list') return '\n';
    return '\n\n';
}

function assemble(units) {
    let markdown = '';
    const sourceMap = [];
    const blockRanges = new Map();
    for (const [index, unit] of units.entries()) {
        if (index > 0) markdown += separator(units[index - 1], unit);
        const from = markdown.length;
        markdown += unit.text;
        const to = markdown.length;
        if (unit.kind === 'marker') continue;
        const entry = sourceMapEntry(unit, from, to);
        if (entry) sourceMap.push(entry);
        recordBlockRange(blockRanges, unit, from, to);
    }
    return { markdown, sourceMap, blockRanges };
}

function sourceMapEntry(unit, from, to) {
    const fragments = unit.fragments.filter(fragment => fragment.fragment?.bbox && fragment.to > fragment.from);
    if (!fragments.length) return null;
    if (unit.kind === 'image') {
        return { type: unit.type, markdownFrom: from, markdownTo: to,
            locations: [{ pageIndex: fragments[0].fragment.pageIndex, bbox: [...fragments[0].fragment.bbox] }] };
    }
    const locations = [];
    for (const fragment of fragments) {
        const location = { pageIndex: fragment.fragment.pageIndex, bbox: [...fragment.fragment.bbox] };
        if (!locations.some(existing => sameLocation(existing, location))) locations.push(location);
    }
    const entry = { type: unit.type, markdownFrom: from, markdownTo: to, locations };
    if (fragments.length > 1 && !fragments.some(fragment => fragment.whole)) {
        entry.locationRanges = fragments.map(fragment => ({
            markdownFrom: from + fragment.from,
            markdownTo: from + fragment.to,
            location: { pageIndex: fragment.fragment.pageIndex, bbox: [...fragment.fragment.bbox] },
        }));
    }
    return entry;
}

function recordBlockRange(blockRanges, unit, from, to) {
    const id = unit.block?.id || unit.composite?.figureId;
    if (!id) return;
    if (!blockRanges.has(id)) blockRanges.set(id, { from, to, units: [] });
    const record = blockRanges.get(id);
    record.to = to;
    record.units.push({
        kind: unit.kind,
        from,
        to,
        ...(unit.child ? { childId: unit.child.id } : {}),
        ...(unit.image ? { image: { from: from + unit.image.from, to: from + unit.image.to } } : {}),
        ...(unit.caption ? { caption: { from: from + unit.caption.from, to: from + unit.caption.to, text: unit.caption.text } } : {}),
        ...(unit.footnote ? { footnote: true } : {}),
        fragments: unit.fragments.map(fragment => ({
            from: from + fragment.from,
            to: from + fragment.to,
            pageIndex: fragment.fragment.pageIndex,
            bbox: fragment.fragment.bbox,
        })),
    });
}

function sameLocation(left, right) {
    return left.pageIndex === right.pageIndex && left.bbox.every((value, index) => value === right.bbox[index]);
}
