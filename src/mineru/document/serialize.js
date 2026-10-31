import {
    escapeMarkdownLinkDestination,
    normalizeMarkdownLinkURL,
} from '../../markdown/markdown-links.js';
import { escapeImageDescription, parseAcademicFigureCaption } from '../../markdown/markdown-figures.js';
import { planFigureLayouts } from '../../markdown/figure-layout-normalizer.js';
import { noteDirective, SECTION_CLOSE_DIRECTIVE, sectionOpenDirective } from '../../markdown/markdown-directives.js';
import { NOTE_KIND } from './notes.js';
import { BLOCK_KIND, BLOCK_ROLE, fragmentText, spansText, unionBBox } from './ir.js';
import {
    createHyphenationVocabulary,
    escapeLineStart,
    isStandaloneAddress,
    joinTextParts,
    normalizeOCRText,
    renderInlineSpans,
    sanitizeTableHTML,
    escapeMarkdownText,
    escapeMarkdownLinkLabel,
} from './text.js';

export const DOCUMENT_STRUCTURE = 'mineru-ir-v1';

const BULLET_START = /^(?:[•●○◦▪▫‣∙·■□➢➤►✓✔]\s*|-\s+)(?=\S)/u;
const CODE_LANGUAGE = /^[a-z0-9+#-]{1,20}$/u;
const SKIPPED_ROLES = new Set([BLOCK_ROLE.CHROME]);
const NOTE_KIND_OF_FLOAT = new Map([
    [BLOCK_KIND.TABLE, 'table'], [BLOCK_KIND.IMAGE, 'figure'], [BLOCK_KIND.CHART, 'figure'],
    [BLOCK_KIND.CODE, 'code'], [BLOCK_KIND.ALGORITHM, 'code'],
]);

// Writes the document IR as Markdown and records, for every block, the exact
// output range of each of its fragments. The source map comes from those
// ranges, so no text matching is needed afterwards.
//
// Every unit also lists its pieces: a stable key, the part it plays, and its
// output range. The figure pipeline addresses blocks by these keys, and a
// composed figure (`composites`) replaces the pieces it consumed when the IR
// is written again.
export function serializeDocumentIR(ir, { vocabulary = createHyphenationVocabulary(ir), composites = [] } = {}) {
    const floats = new Map(ir.blocks.filter(block => block.role === BLOCK_ROLE.FLOAT).map(block => [block.id, block]));
    let units = [];
    for (const block of ir.blocks) {
        if (block.sectionStart) units.push(directiveUnit(sectionOpenDirective(block.sectionStart)));
        units.push(...blockUnits(block, vocabulary, floats));
        if (block.sectionEnd) units.push(directiveUnit(SECTION_CLOSE_DIRECTIVE));
    }
    if (composites?.length) units = placeComposites(units, composites);
    return assemble(dropEmptySections(applyFigureLayouts(units)));
}

// A section directive line; it has no source location.
function directiveUnit(text) {
    return { block: null, kind: 'directive', text, fragments: [] };
}

// A section whose blocks all wrote nothing (or a composed figure took them)
// is not written.
function dropEmptySections(units) {
    const output = [];
    for (const unit of units) {
        const previous = output.at(-1);
        if (unit.kind === 'directive' && unit.text === SECTION_CLOSE_DIRECTIVE
            && previous?.kind === 'directive' && previous.text !== SECTION_CLOSE_DIRECTIVE) {
            output.pop();
            continue;
        }
        output.push(unit);
    }
    return output;
}

// A composed figure is written where its earliest member was. A unit whose
// only piece the figure consumed is dropped; a panel whose embedded caption
// was consumed keeps its image; a paragraph of several fragments keeps all of
// its text, so a figure can never delete prose that continues elsewhere.
function placeComposites(units, composites) {
    const owners = new Map();
    for (const composite of composites) {
        for (const id of composite.memberBlockIds || []) {
            if (!owners.has(id)) owners.set(id, composite);
        }
    }
    const placed = new Set();
    const output = [];
    for (const unit of units) {
        for (const piece of unit.pieces || []) {
            const composite = owners.get(piece.key);
            if (composite && !placed.has(composite)) {
                placed.add(composite);
                output.push(compositeUnit(composite));
            }
        }
        if (unit.skipKey && owners.has(unit.skipKey)) continue;
        if (unit.captionKeys?.some(key => owners.has(key)) && unit.rebuild) {
            output.push(unit.rebuild(''));
            continue;
        }
        output.push(unit);
    }
    return output;
}

function blockUnits(block, vocabulary, floats) {
    if (SKIPPED_ROLES.has(block.role)) return [];
    if (block.role === BLOCK_ROLE.FLOAT_NOTE && !block.attachedTo) return [];
    // A content footnote of the page is a note; article metadata is a
    // paragraph of its collapsible section; page decoration MinerU discarded
    // stays out.
    if (block.role === BLOCK_ROLE.PAGE_NOTE) {
        if (block.noteKind === NOTE_KIND.CONTENT) return textUnits(block, vocabulary).map(unit => asNote(unit, 'footnote'));
        return block.noteKind === NOTE_KIND.FRONT_MATTER && block.sectionKind ? textUnits(block, vocabulary) : [];
    }
    if (block.role === BLOCK_ROLE.FLOAT_NOTE) {
        const kind = NOTE_KIND_OF_FLOAT.get(floats.get(block.attachedTo)?.kind) || 'table';
        return textUnits(block, vocabulary).map(unit => asNote(unit, kind));
    }
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

function stripTrailingAddressPunctuation(address) {
    return String(address).replace(/[.,;:!?]+$/u, '');
}

function textUnits(block, vocabulary) {
    const { text, ranges } = inlineText(block, vocabulary);
    if (!text) return [];
    const part = block.role === BLOCK_ROLE.REFERENCE ? 'reference'
        : block.role === BLOCK_ROLE.FLOAT_NOTE ? 'note' : 'text';
    if (block.role === BLOCK_ROLE.BODY && block.fragments.length === 1 && isStandaloneAddress(text)) {
        const address = normalizeOCRText(block.fragments[0].lines
            .map(line => spansText(line.spans))
            .filter(Boolean)
            .join(' ')).trim();
        const linkedAddress = stripTrailingAddressPunctuation(address);
        const suffix = address.slice(linkedAddress.length);
        const plainAddress = normalizeMarkdownLinkURL(linkedAddress);
        const target = /^https?:\/\//iu.test(plainAddress) ? plainAddress : `https://${plainAddress}`;
        const destination = escapeMarkdownLinkDestination(target);
        if (!destination) return [withPieces({ block, kind: 'text', type: 'text', text: escapeLineStart(text), fragments: wholeFragments(block, text) },
            [ownPiece(block, `${block.id}#f0`, part, text, text)])];
        const output = `[${escapeMarkdownLinkLabel(plainAddress)}](${destination})${escapeMarkdownText(suffix)}`;
        return [withPieces({ block, kind: 'text', type: 'text', text: output, fragments: wholeFragments(block, output) },
            [ownPiece(block, `${block.id}#f0`, part, output, address)])];
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
    const fragments = ranges.map((range, index) => ({
        from: index === 0 ? 0 : Math.max(0, range.from + shift),
        to: index === ranges.length - 1 ? output.length : Math.max(0, range.to + shift),
        fragment: range.fragment,
    }));
    const pieces = fragments.map((range, index) => ({
        key: `${block.id}#f${index}`,
        part,
        blockId: block.id,
        from: range.from,
        to: range.to,
        pageIndex: range.fragment.pageIndex,
        bbox: range.fragment.bbox,
        text: fragmentText(range.fragment),
    }));
    return [{
        block,
        kind: prefix ? 'list' : 'text',
        type: 'text',
        text: output,
        fragments,
        pieces,
        // A paragraph stitched from several fragments is never removed by a
        // figure: only the fragment inside the figure is a member.
        skipKey: pieces.length === 1 ? pieces[0].key : null,
    }];
}

function headingUnits(block, vocabulary) {
    const { text } = inlineText(block, vocabulary);
    const content = text.replace(/^#+\s*/u, '').replace(/\s+#+$/u, '').trim();
    if (!content) return [];
    const level = Math.min(6, Math.max(1, block.level || 2));
    const output = `${'#'.repeat(level)} ${content}`;
    return [withPieces({ block, kind: 'heading', type: 'text', text: output, fragments: wholeFragments(block, output) },
        [ownPiece(block, `${block.id}#f0`, 'heading', output, content)])];
}

function equationUnits(block) {
    const latex = String(block.latex || '')
        .replace(/\$\$/gu, '')
        .split('\n').map(line => line.trimEnd()).filter(line => line.trim())
        .join('\n')
        .trim();
    if (!latex) {
        return block.assetPath ? [imageUnit(block, null, block.assetPath, '', 'equation', 'equation')] : [];
    }
    const output = `$$\n${latex}\n$$`;
    return [withPieces({ block, kind: 'math', type: 'equation', text: output, fragments: wholeFragments(block, output) },
        [ownPiece(block, block.id, 'equation', output, latex)])];
}

function figureUnits(block) {
    const bodies = block.children.filter(child => child.kind === 'body' && child.assetPath);
    const caption = captionText(block);
    const units = [];
    if (!bodies.length) units.push(...captionUnits(block));
    for (const [index, body] of bodies.entries()) {
        units.push(imageUnit(block, body, body.assetPath, index === bodies.length - 1 ? caption : '',
            block.kind === BLOCK_KIND.CHART ? 'chart' : 'image', 'panel'));
    }
    units.push(...footnoteUnits(block, 'note'));
    if (block.kind === BLOCK_KIND.CHART) units.push(...chartDataUnits(block));
    return units;
}

// The data MinerU read from a chart (self-hosted, high effort) follows the
// chart in a collapsed section: a table as a sanitized table, anything else
// verbatim in a code block. A chart already inside a section shows its data
// without a section of its own, since sections do not nest.
function chartDataUnits(block) {
    const units = [];
    for (const child of block.children.filter(item => item.kind === 'body' && typeof item.data === 'string')) {
        const raw = child.data.trim();
        if (!raw) continue;
        const table = /<table[\s>]/iu.test(raw) ? sanitizeTableHTML(raw) : '';
        let output = table;
        if (!output) {
            const longest = Math.max(2, ...[...raw.matchAll(/`+/gu)].map(match => match[0].length));
            const fence = '`'.repeat(longest + 1);
            output = `${fence}text\n${raw}\n${fence}`;
        }
        const bbox = child.bbox || block.bbox;
        units.push(withPieces({
            block, kind: table ? 'table' : 'code', type: table ? 'table' : 'code', text: output,
            fragments: bbox ? [{ from: 0, to: output.length, fragment: { pageIndex: block.pageIndex, bbox } }] : [],
        }, [{ key: `${child.id}:data`, part: 'table', blockId: block.id, from: 0, to: output.length,
            pageIndex: block.pageIndex, bbox, text: '' }]));
    }
    if (!units.length || block.sectionKind) return units;
    return [directiveUnit(sectionOpenDirective('chart-data')), ...units, directiveUnit(SECTION_CLOSE_DIRECTIVE)];
}

function tableUnits(block) {
    const body = block.children.find(child => child.kind === 'body');
    const captions = captionChildren(block).map(child => childText(child));
    const caption = captions.join(' ').trim();
    const figureCaption = /^(?:fig|figure)\b/iu.test(parseAcademicFigureCaption(caption)?.label || '');
    const units = [];
    if (figureCaption && body?.assetPath) {
        units.push(imageUnit(block, body, body.assetPath, caption, 'image', 'table'));
        units.push(...footnoteUnits(block, 'table'));
        return units;
    }
    if (captions.length) {
        // MinerU writes a table label and its description as separate caption
        // lines; a hard line break keeps them in one caption paragraph.
        const output = captionChildren(block)
            .map(child => escapeLineStart(childInline(child))).filter(Boolean).join('  \n');
        if (output) units.push(childUnit(block, captionChildren(block), output, { caption: true }, `${block.id}:caption`, 'table'));
    }
    const html = sanitizeTableHTML(body?.html);
    if (html) {
        units.push(withPieces({ block, kind: 'table', type: 'table', text: html, fragments: wholeFragments(block, html) },
            [ownPiece(block, `${block.id}:body`, 'table', html, '')]));
    }
    else if (body?.assetPath) units.push(imageUnit(block, body, body.assetPath, '', 'image', 'table'));
    units.push(...footnoteUnits(block, 'table'));
    return units;
}

function codeUnits(block) {
    const code = block.children.find(child => child.kind === 'body')?.code;
    if (!code) return [];
    const longest = Math.max(2, ...[...code.matchAll(/`+/gu)].map(match => match[0].length));
    const fence = '`'.repeat(longest + 1);
    const language = String(block.codeLanguage || '').toLowerCase();
    const output = `${fence}${CODE_LANGUAGE.test(language) ? language : ''}\n${code}\n${fence}`;
    const units = captionUnits(block, 'code');
    units.push(withPieces({ block, kind: 'code', type: 'code', text: output, fragments: wholeFragments(block, output) },
        [ownPiece(block, `${block.id}:body`, 'code', output, '')]));
    units.push(...footnoteUnits(block, 'code'));
    return units;
}

// The renderer finds an algorithm between MinerU's container tags, so a
// line inside that looks like a div tag is escaped.
function algorithmUnits(block) {
    const code = block.children.find(child => child.kind === 'body')?.code;
    if (!code) return [];
    const content = code.split('\n').map(line => (
        line.replace(/^(\s*)<(?=\/?div\b)/iu, '$1\\<')
    )).join('\n');
    const output = '<div class="mineru-algorithm" style="white-space: pre-wrap; font-family:monospace;">\n'
        + `${content}\n</div>`;
    const units = captionUnits(block, 'code');
    units.push(withPieces({ block, kind: 'algorithm', type: 'code', text: output, fragments: wholeFragments(block, output) },
        [ownPiece(block, `${block.id}:body`, 'code', output, '')]));
    units.push(...footnoteUnits(block, 'code'));
    return units;
}

// A figure caption without an image is a text block for the figure
// pipeline; a code or algorithm caption belongs to the code.
function captionUnits(block, part = 'text') {
    const children = captionChildren(block);
    const caption = escapeLineStart(children.map(child => childInline(child)).filter(Boolean).join(' '));
    return caption
        ? [childUnit(block, children, caption, { caption: true }, `${block.id}:caption`, part, captionText(block))]
        : [];
}

// A float's footnotes are notes; a photo's biography text (in a section of
// author biographies) is plain paragraphs.
function footnoteUnits(block, part) {
    const kind = NOTE_KIND_OF_FLOAT.get(block.kind) || 'table';
    return block.children
        .filter(child => child.kind === 'footnote' && child.role !== BLOCK_ROLE.CHROME)
        .map(child => ({ child, text: escapeLineStart(childInline(child)) }))
        .filter(({ text }) => text)
        .map(({ child, text }) => {
            const unit = childUnit(block, [child], text, { footnote: true }, child.id, part, childText(child));
            return block.footnotesAsText ? unit : asNote(unit, kind);
        });
}

// A note is its directive line followed by the text as a one-paragraph
// blockquote. The unit stays one piece of output, so a figure that consumes
// the note removes the directive with it; every range of the text moves by
// the prefix. Its source map entry starts at the blockquote, which the reader
// indexes as a block of its own after the directive comment.
function asNote(unit, kind) {
    const directive = noteDirective(kind);
    const prefix = `${directive}\n> `;
    const shift = range => ({ ...range, from: range.from + prefix.length, to: range.to + prefix.length });
    return {
        ...unit,
        kind: 'note',
        text: `${prefix}${unit.text}`,
        fragments: unit.fragments.map(shift),
        pieces: (unit.pieces || []).map(shift),
        noteKind: kind,
        sourceFrom: directive.length + 1,
    };
}

// A caption or note paragraph is located by its own boxes, not the float's.
function childUnit(block, children, text, extra, key, part, plain = '') {
    const fragments = children.flatMap(child => (child.fragments || [])
        .filter(fragment => fragment.bbox)
        .map(fragment => ({ from: 0, to: text.length, fragment, whole: true })));
    const bbox = unionBBox(children.map(child => child.bbox).filter(Boolean)) || block.bbox;
    return withPieces({
        block,
        kind: 'text',
        type: 'text',
        text,
        fragments: fragments.length ? fragments : wholeFragments(block, text),
        ...extra,
    }, [{ key, part, blockId: block.id, from: 0, to: text.length, pageIndex: block.pageIndex, bbox,
        text: part === 'table' || part === 'code' ? '' : plain }]);
}

function withPieces(unit, pieces) {
    return { ...unit, pieces, skipKey: pieces.length === 1 ? pieces[0].key : null };
}

// A piece spanning the whole unit, located on the block's own page.
function ownPiece(block, key, part, output, text) {
    const fragment = block.fragments.find(item => item.pageIndex === block.pageIndex && item.bbox);
    return { key, part, blockId: block.id, from: 0, to: output.length, pageIndex: block.pageIndex,
        bbox: fragment?.bbox || block.bbox, text };
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

// `part` is `panel` for a figure image; a table or equation written as its
// crop image keeps its own part, so the figure pipeline never takes it as a
// panel and the layout planner never puts it in a grid. A panel's caption
// pieces are one per MinerU caption block, as the region resolver expects.
function imageUnit(block, body, assetPath, caption, type, part) {
    const panel = part === 'panel';
    const captions = panel && caption ? captionPieces(block) : [];
    const alt = panel ? captions.map(piece => piece.alt).join(' ') : caption ? escapeImageDescription(caption) : '';
    const text = `![${alt}](${assetPath})`;
    const bbox = body?.bbox || block.bbox;
    const pieces = [{
        key: body?.id || `${block.id}:body`, part, blockId: block.id, from: 0, to: text.length,
        pageIndex: block.pageIndex, bbox, text: '', ...(panel ? { assetPath, parentId: block.id } : {}),
    }];
    let offset = 2;
    for (const piece of captions) {
        pieces.push({
            key: piece.key, part: 'caption', blockId: block.id, from: offset, to: offset + piece.alt.length,
            pageIndex: block.pageIndex, bbox: piece.bbox, text: piece.text, parentId: block.id,
        });
        offset += piece.alt.length + 1;
    }
    const captionValue = panel ? captions.map(piece => piece.text).join(' ') : caption;
    return {
        block,
        kind: 'image',
        type,
        text,
        image: { from: 0, to: text.length },
        ...(alt ? { caption: { from: 2, to: 2 + alt.length, text: captionValue } } : {}),
        child: body,
        assetPath,
        panel,
        location: { pageIndex: block.pageIndex, bbox },
        fragments: [{ from: 0, to: text.length, fragment: { pageIndex: block.pageIndex, bbox } }],
        pieces,
        skipKey: pieces[0].key,
        captionKeys: captions.map(piece => piece.key),
        rebuild: nextCaption => imageUnit(block, body, assetPath, nextCaption, type, part),
    };
}

function captionPieces(block) {
    return captionChildren(block)
        .map(child => ({ key: child.id, bbox: child.bbox, text: childText(child) }))
        .filter(piece => piece.text)
        .map(piece => ({ ...piece, alt: escapeImageDescription(piece.text) }));
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
        pieces: [{ key: composite.id, part: 'composite', blockId: null, from: 0, to: text.length,
            pageIndex: composite.pageIndex, bbox: composite.bbox, text: '' }],
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
        .filter(unit => unit.panel && unit.child?.bbox)
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
    const pieces = [];
    for (const [index, unit] of units.entries()) {
        if (index > 0) markdown += separator(units[index - 1], unit);
        const from = markdown.length;
        markdown += unit.text;
        const to = markdown.length;
        if (unit.kind === 'marker' || unit.kind === 'directive') continue;
        const entry = sourceMapEntry(unit, from + (unit.sourceFrom || 0), to, from);
        if (entry) sourceMap.push(entry);
        recordBlockRange(blockRanges, unit, from, to);
        for (const piece of unit.pieces || []) {
            if (piece.to > piece.from) pieces.push({ ...piece, from: from + piece.from, to: from + piece.to });
        }
    }
    return { markdown, sourceMap, blockRanges, pieces };
}

// `from` is where the entry starts; fragment offsets are relative to the
// unit's own start.
function sourceMapEntry(unit, from, to, unitFrom = from) {
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
            markdownFrom: unitFrom + fragment.from,
            markdownTo: unitFrom + fragment.to,
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
