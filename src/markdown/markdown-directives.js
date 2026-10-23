import { GFM, parser as markdownParser } from '@lezer/markdown';

// Structural directives Mktero writes into reading Markdown as HTML
// comments. Each must be a whole top-level comment block, so the same text
// inside code, a paragraph, or escaped OCR text is never a directive.
//
//   <!-- mktero-note: footnote -->      followed by a blockquote: a note
//   <!-- mktero-section: article-info -->
//   …                                   a collapsible section
//   <!-- /mktero-section -->
export const NOTE_KINDS = Object.freeze(['footnote', 'table', 'figure', 'code']);
export const SECTION_KINDS = Object.freeze(['article-info', 'author-biographies', 'reporting-summary']);
// The localization key of each section's label.
export const SECTION_LABEL_KEYS = Object.freeze({
    'article-info': 'markdown.section.articleInfo',
    'author-biographies': 'markdown.section.authorBiographies',
    'reporting-summary': 'markdown.section.reportingSummary',
});

const PARSER = markdownParser.configure(GFM);
const OPEN = /^<!--\s*mktero-(note|section):\s*([a-z-]{1,32})\s*-->$/u;
const CLOSE = /^<!--\s*\/mktero-section\s*-->$/u;

export function noteDirective(kind) {
    if (!NOTE_KINDS.includes(kind)) throw new TypeError(`Unknown note kind ${kind}`);
    return `<!-- mktero-note: ${kind} -->`;
}

export function sectionOpenDirective(kind) {
    if (!SECTION_KINDS.includes(kind)) throw new TypeError(`Unknown section kind ${kind}`);
    return `<!-- mktero-section: ${kind} -->`;
}

export const SECTION_CLOSE_DIRECTIVE = '<!-- /mktero-section -->';

// The directive in one comment's source text, or null.
export function parseMarkdownDirective(source) {
    const text = String(source || '').trim();
    if (CLOSE.test(text)) return { type: 'section-close' };
    const match = text.match(OPEN);
    if (!match) return null;
    const [, type, kind] = match;
    if (type === 'note') return NOTE_KINDS.includes(kind) ? { type: 'note', kind } : null;
    return SECTION_KINDS.includes(kind) ? { type: 'section-open', kind } : null;
}

// Every top-level directive of a document with its offsets. A note directive
// is valid only directly before a blockquote; `quote` is that blockquote's
// range. Sections pair an opening directive with the next closing one; an
// unpaired or nested directive is not a section (its content then reads as
// ordinary text).
export function findMarkdownDirectives(markdown, tree = PARSER.parse(String(markdown || ''))) {
    const source = String(markdown || '');
    const notes = [];
    const sections = [];
    const directives = [];
    let open = null;
    let previous = null;
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
        if (previous?.directive?.type === 'note' && node.name === 'Blockquote') {
            notes.push({ ...previous.range, kind: previous.directive.kind, quote: { from: node.from, to: node.to } });
        }
        previous = null;
        if (node.name !== 'CommentBlock') continue;
        const directive = parseMarkdownDirective(source.slice(node.from, node.to));
        if (!directive) continue;
        const range = { from: node.from, to: node.to };
        directives.push({ ...range, ...directive });
        if (directive.type === 'note') previous = { directive, range };
        else if (directive.type === 'section-open') open = open ? null : { kind: directive.kind, open: range };
        else if (open) {
            sections.push({ kind: open.kind, from: open.open.from, to: node.to, open: open.open, close: range,
                content: { from: open.open.to, to: node.from } });
            open = null;
        }
    }
    return { notes, sections, directives };
}

// Offset ranges of every section's content, for callers that exclude a
// section from an index (the outline lists no heading inside a section).
export function markdownSectionRanges(markdown, tree) {
    return findMarkdownDirectives(markdown, tree).sections.map(section => ({ from: section.from, to: section.to }));
}
