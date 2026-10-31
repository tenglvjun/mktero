import { FIGURE_LIMITS } from '../../figures/figure-limits.js';
import { safeMinerULinkURL } from '../../markdown/markdown-links.js';
import { MINERU_LAYOUT_SCHEMA } from './result-bundle.js';

// MinerU 4.0 (self-hosted V1 API) writes `middle_json.json` in the DocVortex
// Middle JSON 2.0 protocol: `schema: "docvortex.middle"`, pages of typed
// blocks with bboxes normalized to [0, 1], natural language as structured
// inline spans, and `continues_prev` where MinerU joined a paragraph, a
// list, or a table across a page or column. This module projects it to the
// same layout the 3.x `pdf_info` reader produces (result-bundle.js), so one
// document pipeline reads both:
//
// - page sizes come from `extensions.docvortex_layout` (points), and boxes
//   are scaled to them; a page without a size uses a unit square, which the
//   figure step later finds does not match the PDF;
// - titles, text, references, equations, figures, tables, charts, code, and
//   algorithms map to their 3.x types; list and table-of-contents entries
//   become paragraphs of their own; page decoration and page footnotes are
//   discarded blocks, as in 3.x;
// - a paragraph that `continues_prev` is moved into the paragraph it
//   continues and leaves an emptied block with its box, exactly as 3.x
//   merges, so its fragment keeps its own page and box;
// - a short superscript or subscript becomes inline math (`^{1}`), the form
//   footnote marks take in 3.x results; adjacent text spans, which 4.0 splits
//   by style, are joined as printed;
// - a block or span of an unknown type that carries text is read as text.
//
// A list that `continues_prev` only says the list goes on; its first entry
// is an entry of its own unless it carries `continues_prev` itself. A
// continuation never crosses a heading, a display equation, or a table of
// contents, so the reading order stays as MinerU wrote it.
//
// The input is untrusted: every field is type-checked and bounded, unknown
// blocks are dropped and counted.
export const MINERU_MIDDLE_SCHEMA = 'docvortex.middle';
export const MINERU_MIDDLE_SCHEMA_VERSION = '2.0';

const MAX_TYPE_LENGTH = 64;
const MAX_META_LENGTH = 64;
const MAX_PATH_LENGTH = 1024;
const MAX_URL_LENGTH = 4096;
const MAX_CONTENT_LENGTH = 512 * 1024;
const MAX_NESTING = 8;
const MAX_SCRIPT_LENGTH = 12;
const SCRIPT_MARK = /^[\p{L}\p{N}*†‡§¶#°△,.\-–−+=\s]+$/u;
// Ordinal suffixes are raised in type, not marks: "4th" stays text.
const ORDINAL_SUFFIX = /^(?:st|nd|rd|th|er|e|re|ème|o|a)$/iu;
const DISCARDED_TYPES = new Set(['header', 'footer', 'page_number', 'aside_text', 'page_footnote']);
// A continued paragraph can follow its first part across these.
const FLOAT_TYPES = new Set(['image', 'table', 'chart', 'code']);
// A box a hair outside [0, 1] is rounding.
const BOX_EPSILON = 1e-6;
const VISUAL_CHILDREN = new Map([
    ['image', new Set(['image_body', 'image_caption', 'image_footnote'])],
    ['table', new Set(['table_body', 'table_caption', 'table_footnote'])],
    ['chart', new Set(['chart_body', 'chart_caption', 'chart_footnote'])],
    ['code', new Set(['code_body', 'algorithm_body', 'code_caption', 'code_footnote'])],
]);

export function isMinerUMiddleJSON(parsed) {
    return isObject(parsed) && parsed.schema === MINERU_MIDDLE_SCHEMA
        && parsed.schema_version === MINERU_MIDDLE_SCHEMA_VERSION && Array.isArray(parsed.pages);
}

export function projectMinerUMiddleJSON(parsed, {
    maxPages = FIGURE_LIMITS.maxPDFPages,
    maxBlocks = FIGURE_LIMITS.maxLayoutBlocks,
} = {}) {
    if (!isMinerUMiddleJSON(parsed) || parsed.pages.length > maxPages) return null;
    const diagnostics = {
        droppedPages: 0, droppedFields: 0, truncatedStrings: 0, droppedBlocks: 0,
        unsizedPages: 0, continuations: 0, unknownTypes: Object.create(null),
    };
    const context = { diagnostics, budget: { blocks: 0, maxBlocks }, lastText: null, lastReference: null };
    const sizes = pageSizes(parsed.extensions?.docvortex_layout);
    const pages = [];
    const seen = new Set();
    for (const raw of parsed.pages) {
        const pageIndex = raw?.page_idx;
        if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || seen.has(pageIndex) || !Array.isArray(raw.blocks)) {
            diagnostics.droppedPages++;
            continue;
        }
        seen.add(pageIndex);
        let pageSize = sizes.get(pageIndex);
        if (!pageSize) {
            // A nominal page size keeps box comparisons meaningful; the
            // figure step finds it does not match the PDF.
            pageSize = [1000, 1000];
            diagnostics.unsizedPages++;
        }
        pages.push({ pageIndex, pageSize, blocks: [], discarded: [], raw: raw.blocks });
    }
    pages.sort((left, right) => left.pageIndex - right.pageIndex);
    for (const page of pages) {
        context.page = page;
        for (const raw of page.raw) projectPageBlock(raw, context);
        delete page.raw;
    }
    const mineru = isObject(parsed.extensions?.mineru) ? parsed.extensions.mineru : {};
    return {
        schema: MINERU_LAYOUT_SCHEMA,
        backend: 'docvortex-middle-v2',
        version: metaString(parsed.metadata?.producer?.version),
        effort: metaString(mineru.tier),
        ocrEnabled: mineru.parse_mode === 'ocr' ? true : mineru.parse_mode === 'txt' ? false : null,
        pages,
        diagnostics,
    };
}

function pageSizes(layout) {
    const sizes = new Map();
    if (!isObject(layout) || !Array.isArray(layout.pages)) return sizes;
    for (const page of layout.pages) {
        const width = page?.width_pt;
        const height = page?.height_pt;
        if (Number.isSafeInteger(page?.page_idx) && page.page_idx >= 0 && !sizes.has(page.page_idx)
            && Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
            sizes.set(page.page_idx, [width, height]);
        }
    }
    return sizes;
}

function projectPageBlock(raw, context) {
    const type = blockType(raw, context);
    if (!type) return;
    const bbox = pageBox(raw.bbox, context);
    if (DISCARDED_TYPES.has(type)) {
        const lines = inlineLines(raw.content, bbox, context);
        if (lines) push(context.page.discarded, withBox({ type, lines }, bbox), context);
        return;
    }
    switch (type) {
        case 'doc_title':
        case 'paragraph_title':
            projectTitle(raw, type, bbox, context);
            break;
        case 'text':
        case 'ref_text':
            projectText(raw, type, bbox, context);
            break;
        case 'list':
            projectList(raw, bbox, context, 0, raw.sub_type === 'ref_text' ? 'ref_text' : 'text');
            break;
        case 'index':
            projectIndex(raw, bbox, context, 0);
            break;
        case 'equation':
            projectEquation(raw, bbox, context);
            break;
        case 'image':
        case 'table':
        case 'chart':
        case 'code':
            projectVisual(raw, type, bbox, context);
            break;
        default:
            context.diagnostics.unknownTypes[type] = (context.diagnostics.unknownTypes[type] || 0) + 1;
            if (Array.isArray(raw.content)) projectText({ ...raw, continues_prev: false }, 'text', bbox, context);
            else context.diagnostics.droppedBlocks++;
    }
    if (type !== 'ref_text' && type !== 'list') context.lastReference = null;
    if (!['text', 'list', ...FLOAT_TYPES].includes(type)) context.lastText = null;
}

function projectTitle(raw, type, bbox, context) {
    const lines = inlineLines(raw.content, bbox, context);
    if (!lines) return dropBlock(context);
    const level = type === 'doc_title' ? 1 : integer(raw.level, 2, 6) ?? 2;
    push(context.page.blocks, withIndex(withBox({ type: 'title', level, lines }, bbox), raw, context), context);
}

function projectText(raw, type, bbox, context) {
    const lines = inlineLines(raw.content, bbox, context);
    if (!lines) return dropBlock(context);
    const previous = type === 'text' ? context.lastText : context.lastReference;
    const anchored = typeof raw.anchor === 'string' && raw.anchor.trim();
    // MinerU joined this paragraph to the one before it: the lines move there
    // and an emptied block keeps this box, as 3.x results carry it.
    if (raw.continues_prev === true && previous && !anchored && bbox) {
        previous.lines.push(...lines.map(line => ({ ...line, bbox: [...bbox] })));
        push(context.page.blocks, withIndex({ type, bbox, linesDeleted: true, lines: [] }, raw, context), context);
        context.diagnostics.continuations++;
        return;
    }
    const block = withIndex(withBox({ type, lines }, bbox), raw, context);
    push(context.page.blocks, block, context);
    if (type === 'text') context.lastText = block;
    else context.lastReference = block;
}

// Each list entry is a paragraph of its own: its own text, with the bullet
// or number MinerU kept. Nested lists are flattened in order.
function projectList(raw, bbox, context, depth, itemType) {
    if (!Array.isArray(raw.content) || depth > MAX_NESTING) return dropBlock(context);
    for (const child of raw.content) {
        const type = isObject(child) ? child.type : null;
        if (type === 'list') {
            blockType(child, context);
            projectList(child, pageBox(child.bbox, context) || bbox, context, depth + 1, itemType);
            continue;
        }
        if (type !== 'text' && type !== 'ref_text') {
            // Anything else inside a list (an equation, a figure) is read as
            // a block of its own, in place.
            projectPageBlock(child, context);
            continue;
        }
        blockType(child, context);
        const itemBox = pageBox(child.bbox, context) || bbox;
        projectText({ ...child, continues_prev: child.continues_prev === true }, type === 'ref_text' ? 'ref_text' : itemType,
            itemBox, context);
    }
}

// A table of contents: every entry is a line of text, never an outline
// heading of the paper.
function projectIndex(raw, bbox, context, depth) {
    if (!Array.isArray(raw.content) || depth > MAX_NESTING) return dropBlock(context);
    for (const child of raw.content) {
        const type = blockType(child, context);
        const childBox = pageBox(child?.bbox, context) || bbox;
        if (type === 'index') {
            projectIndex(child, childBox, context, depth + 1);
            continue;
        }
        if (!['text', 'doc_title', 'paragraph_title'].includes(type)) {
            context.diagnostics.droppedBlocks++;
            continue;
        }
        const lines = inlineLines(child.content, childBox, context);
        if (lines) push(context.page.blocks, withBox({ type: 'text', lines }, childBox), context);
    }
}

function projectEquation(raw, bbox, context) {
    const latex = boundedString(raw.content, MAX_CONTENT_LENGTH, context)?.trim() || '';
    const imagePath = boundedString(raw.image_path, MAX_PATH_LENGTH, context);
    if (latex) {
        const span = withBox({ type: 'interline_equation', content: latex, ...(imagePath ? { imagePath } : {}) }, bbox);
        push(context.page.blocks, withIndex(withBox({ type: 'interline_equation', lines: [withBox({ spans: [span] }, bbox)] }, bbox), raw, context), context);
        return;
    }
    // A display equation MinerU kept only as an image (Flash tiers) is
    // shown as that image.
    if (!imagePath) return dropBlock(context);
    const body = withBox({ type: 'image_body', lines: [withBox({ spans: [withBox({ type: 'image', imagePath }, bbox)] }, bbox)] }, bbox);
    push(context.page.blocks, withIndex(withBox({ type: 'image', blocks: [body] }, bbox), raw, context), context);
}

function projectVisual(raw, type, bbox, context) {
    if (!Array.isArray(raw.content)) return dropBlock(context);
    const allowed = VISUAL_CHILDREN.get(type);
    const children = [];
    for (const child of raw.content) {
        const childType = blockType(child, context);
        if (!allowed.has(childType)) {
            context.diagnostics.droppedFields++;
            continue;
        }
        const childBox = pageBox(child.bbox, context) || bbox;
        if (/_(?:caption|footnote)$/u.test(childType)) {
            const lines = inlineLines(child.content, childBox, context);
            if (lines) children.push(withBox({ type: childType, lines }, childBox));
            continue;
        }
        children.push(visualBody(child, childType, childBox, context));
    }
    if (!children.some(Boolean)) return dropBlock(context);
    const block = withIndex(withBox({ type, blocks: children.filter(Boolean) }, bbox), raw, context);
    const subType = boundedString(raw.sub_type, MAX_TYPE_LENGTH, context);
    if (subType) block.subType = subType;
    const guessLang = boundedString(raw.guess_lang, MAX_TYPE_LENGTH, context);
    if (guessLang) block.guessLang = guessLang;
    if (type === 'table' && raw.continues_prev === true) block.continuesPrev = true;
    push(context.page.blocks, block, context);
}

function visualBody(child, type, bbox, context) {
    const imagePath = boundedString(child.image_path, MAX_PATH_LENGTH, context);
    if (type === 'code_body') {
        const code = boundedString(child.content, MAX_CONTENT_LENGTH, context) || '';
        if (!code.trim()) return null;
        return withBox({ type, lines: code.split('\n').map(line => ({ spans: [{ type: 'text', content: line }] })) }, bbox);
    }
    if (type === 'algorithm_body') {
        const lines = algorithmLines(child.content, context);
        return lines.length ? withBox({ type, lines }, bbox) : null;
    }
    const content = boundedString(child.content, MAX_CONTENT_LENGTH, context) || '';
    const span = withBox({ type: type === 'table_body' ? 'table' : type === 'chart_body' ? 'chart' : 'image' }, bbox);
    if (imagePath) span.imagePath = imagePath;
    if (type === 'table_body' && /<table[\s>]/iu.test(content)) span.html = content;
    if (type === 'chart_body' && content.trim()) span.content = content;
    if (!span.imagePath && !span.html && !span.content) return null;
    return withBox({ type, lines: [withBox({ spans: [span] }, bbox)] }, bbox);
}

// An algorithm's spans, split into its printed lines.
function algorithmLines(content, context) {
    const spans = inlineSpans(content, context, 0);
    const lines = [{ spans: [] }];
    for (const span of spans) {
        if (span.type !== 'text') {
            lines.at(-1).spans.push(span);
            continue;
        }
        span.content.split('\n').forEach((part, index) => {
            if (index) lines.push({ spans: [] });
            if (part) {
                const split = { ...span, type: 'text', content: part };
                if (span.exactSpacing) withExactSpacing(split);
                lines.at(-1).spans.push(split);
            }
        });
    }
    return lines.filter(line => line.spans.length);
}

// One line of 3.x spans for a block's inline content, or null when it has
// no text.
function inlineLines(content, bbox, context) {
    const spans = inlineSpans(content, context, 0);
    if (!spans.some(span => String(span.content || '').trim())) return null;
    return [withBox({ spans }, bbox)];
}

// 3.x spans for 4.0 inline content. 4.0 splits text where its style
// changes, with the printed spacing in the text, so neighbouring text is
// joined as it is; only math stands apart.
function inlineSpans(content, context, depth = 0) {
    const output = [];
    for (const span of rawSpans(content, context, depth)) {
        const last = output.at(-1);
        if (span.type === 'text' && last?.type === 'text'
            && (span.linkURL === last.linkURL || !String(span.content).trim())) {
            last.content += span.content;
        }
        else output.push(span);
    }
    return output;
}

function rawSpans(content, context, depth, inheritedLinkURL = null) {
    const output = [];
    if (!Array.isArray(content) || depth > 1) return output;
    for (const raw of content) {
        if (!isObject(raw)) {
            context.diagnostics.droppedFields++;
            continue;
        }
        const hasOwnLinkURL = Object.prototype.hasOwnProperty.call(raw, 'url');
        let ownLinkURL = inheritedLinkURL;
        if (hasOwnLinkURL) {
            const rawLinkURL = boundedURL(raw.url, MAX_URL_LENGTH, context);
            ownLinkURL = rawLinkURL ? safeMinerULinkURL(rawLinkURL) : null;
        }
        if (raw.type === 'hyperlink') {
            output.push(...rawSpans(raw.content, context, depth + 1, ownLinkURL));
            continue;
        }
        const value = boundedString(raw.content, MAX_CONTENT_LENGTH, context);
        if (typeof value !== 'string' || !value) {
            if (raw.content !== undefined && typeof raw.content !== 'string') context.diagnostics.droppedFields++;
            continue;
        }
        if (raw.type === 'equation_inline') {
            output.push({ type: 'inline_equation', content: value,
                ...(ownLinkURL ? { linkURL: ownLinkURL } : {}) });
        }
        else if (raw.type === 'text') {
            const span = withExactSpacing(textSpan(value, raw.styles));
            if (ownLinkURL) span.linkURL = ownLinkURL;
            output.push(span);
        }
        else {
            // Inline code, and inline content of a kind this reader does not
            // know, keep their text.
            if (raw.type !== 'code_inline') context.diagnostics.droppedFields++;
            output.push(withExactSpacing({ type: 'text', content: value,
                ...(ownLinkURL ? { linkURL: ownLinkURL } : {}) }));
        }
    }
    return output;
}

// A footnote mark or an index printed raised or lowered is math in 3.x
// results ("$^{1}$"); longer raised text stays text.
function textSpan(value, styles) {
    const list = Array.isArray(styles) ? styles : [];
    const script = list.includes('superscript') ? '^' : list.includes('subscript') ? '_' : null;
    const trimmed = value.trim();
    if (script && trimmed && trimmed.length <= MAX_SCRIPT_LENGTH && SCRIPT_MARK.test(trimmed)
        && !(script === '^' && ORDINAL_SUFFIX.test(trimmed))) {
        return { type: 'inline_equation', content: `${script}{${escapeTeX(trimmed)}}` };
    }
    return { type: 'text', content: value };
}

// TeX special characters as literal text, a backslash included.
function escapeTeX(text) {
    return text.replace(/[\\#%&_{}$^~]/gu, character => (
        character === '\\' ? '\\backslash{}' : character === '^' || character === '~' ? `\\${character}{}` : `\\${character}`
    ));
}

function withExactSpacing(span) {
    Object.defineProperty(span, 'exactSpacing', { value: true, enumerable: false });
    return span;
}

function blockType(raw, context) {
    if (!isObject(raw)) {
        context.diagnostics.droppedFields++;
        return null;
    }
    if (++context.budget.blocks > context.budget.maxBlocks) throw new Error('MinerU middle JSON exceeds the block limit');
    const type = boundedString(raw.type, MAX_TYPE_LENGTH, context);
    if (!type) context.diagnostics.droppedFields++;
    return type || null;
}

// A [0, 1] box in the page's own units.
function pageBox(value, context) {
    if (value === undefined || value === null) return null;
    if (!Array.isArray(value) || value.length !== 4
        || !value.every(item => Number.isFinite(item) && item >= -BOX_EPSILON && item <= 1 + BOX_EPSILON)) {
        context.diagnostics.droppedFields++;
        return null;
    }
    const clamped = value.map(item => Math.min(1, Math.max(0, item)));
    if (clamped[2] <= clamped[0] || clamped[3] <= clamped[1]) {
        context.diagnostics.droppedFields++;
        return null;
    }
    const [width, height] = context.page.pageSize;
    return [clamped[0] * width, clamped[1] * height, clamped[2] * width, clamped[3] * height];
}

function withBox(target, bbox) {
    if (bbox) target.bbox = [...bbox];
    return target;
}

function withIndex(target, raw, context) {
    const index = integer(raw?.index, 0, 1_000_000);
    if (index !== null) target.index = index;
    else if (raw?.index !== undefined && raw.index !== null) context.diagnostics.droppedFields++;
    return target;
}

function push(list, block) {
    list.push(block);
    return block;
}

function dropBlock(context) {
    context.diagnostics.droppedBlocks++;
}

function integer(value, min, max) {
    return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

function boundedURL(value, maxLength, context) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') {
        context.diagnostics.droppedFields++;
        return null;
    }
    if (value.length > maxLength) {
        context.diagnostics.droppedFields++;
        return null;
    }
    return value;
}

function boundedString(value, maxLength, context) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') {
        context.diagnostics.droppedFields++;
        return null;
    }
    if (value.length > maxLength) {
        context.diagnostics.truncatedStrings++;
        return value.slice(0, maxLength);
    }
    return value;
}

function metaString(value) {
    return typeof value === 'string' ? value.slice(0, MAX_META_LENGTH) : null;
}

function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
