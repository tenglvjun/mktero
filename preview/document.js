// Pure fixture logic for the browser preview: it splits the sample paper into
// blocks, lays them out on simulated PDF pages, and derives the source map,
// translation views and annotation overlay the reader expects. Text width is
// injected so tests can run this without a canvas.
import {
    collectMarkdownTranslationBlocks,
    createDocumentTranslationViews,
    validateTranslatedBlock,
} from '../src/markdown/markdown-translation-blocks.js';

export const PAGE_WIDTH = 612;
export const PAGE_HEIGHT = 792;
export const PAGE_MARGIN_X = 54;
export const PAGE_MARGIN_TOP = 64;
export const PAGE_MARGIN_BOTTOM = 62;
export const COLUMN_GAP = 18;
export const COLUMN_WIDTH = (PAGE_WIDTH - PAGE_MARGIN_X * 2 - COLUMN_GAP) / 2;
export const FULL_WIDTH = PAGE_WIDTH - PAGE_MARGIN_X * 2;

export const SERIF = '"Times New Roman", Times, "STIX Two Text", Georgia, serif';
export const MONO = 'Menlo, Consolas, "Liberation Mono", monospace';

// Font, size and spacing per block kind, in PDF points.
export const PAGE_STYLES = Object.freeze({
    title: { font: SERIF, size: 19, weight: 700, line: 23, before: 6, after: 10, align: 'center' },
    byline: { font: SERIF, size: 10.5, weight: 400, line: 14, before: 0, after: 3, align: 'center' },
    affiliation: { font: SERIF, size: 8.5, weight: 400, style: 'italic', line: 11, before: 0, after: 12, align: 'center' },
    abstractHeading: { font: SERIF, size: 10, weight: 700, line: 13, before: 0, after: 3, align: 'center' },
    abstract: { font: SERIF, size: 9.2, weight: 400, line: 12, before: 0, after: 14, align: 'justify', inset: 30 },
    heading: { font: SERIF, size: 10.5, weight: 700, line: 14, before: 9, after: 4, align: 'left' },
    subheading: { font: SERIF, size: 9.8, weight: 700, style: 'italic', line: 13, before: 6, after: 3, align: 'left' },
    paragraph: { font: SERIF, size: 9.6, weight: 400, line: 12.2, before: 0, after: 6, align: 'justify' },
    note: { font: SERIF, size: 8.6, weight: 400, style: 'italic', line: 11, before: 2, after: 6, align: 'left' },
    caption: { font: SERIF, size: 8.4, weight: 400, line: 10.6, before: 3, after: 8, align: 'justify' },
    reference: { font: SERIF, size: 8.2, weight: 400, line: 10.2, before: 0, after: 4, align: 'left', hanging: 12 },
    math: { font: SERIF, size: 10.5, weight: 400, style: 'italic', line: 14, before: 4, after: 8, align: 'center' },
    code: { font: MONO, size: 6.4, weight: 400, line: 8.4, before: 3, after: 9, align: 'left', padding: 6 },
    table: { font: SERIF, size: 8.2, weight: 400, line: 12.5, before: 2, after: 8, align: 'left' },
    figure: { before: 4, after: 2, aspect: 0.62 },
});

export const FIGURE_DATA = Object.freeze({
    categories: ['Single column', 'Two column', 'Floating figure', 'Full-width table', 'Mixed inset'],
    series: [
        { label: 'Recursive X-Y cut', color: '#c9cdd3', values: [3.1, 11.8, 19.6, 21.4, 27.9] },
        { label: 'Geometric rules', color: '#8fb3e8', values: [2.4, 7.2, 13.1, 14.6, 22.5] },
        { label: 'Ours', color: '#2f5fbf', values: [2.2, 4.1, 6.4, 7.3, 13.8] },
    ],
    maxValue: 30,
});

const FULL_WIDTH_KINDS = new Set([
    'title', 'byline', 'affiliation', 'abstractHeading', 'abstract',
]);

const LATEX_SYMBOLS = Object.freeze({
    '\\tau': 'τ',
    '\\phi': 'φ',
    '\\sigma': 'σ',
    '\\pi': 'π',
    '\\prec': '≺',
    '\\top': 'ᵀ',
    '\\left': '',
    '\\right': '',
});

const SUBSCRIPTS = Object.freeze({ i: 'ᵢ', j: 'ⱼ', 0: '₀', 1: '₁', 2: '₂' });

// Split the fixture on blank lines. The sample paper keeps code and display
// math free of blank lines, so every part is one Markdown block.
export function segmentPaperMarkdown(markdown) {
    const segments = [];
    let cursor = 0;
    let afterAbstract = false;
    for (const part of String(markdown).split('\n\n')) {
        const from = cursor;
        const to = from + part.length;
        cursor = to + 2;
        const kind = classifySegment(part, segments, afterAbstract);
        if (kind === 'abstractHeading') afterAbstract = true;
        else if (kind === 'heading') afterAbstract = false;
        segments.push({ index: segments.length, from, to, markdown: part, kind });
    }
    return segments;
}

function classifySegment(part, previous, afterAbstract) {
    if (part.startsWith('# ')) return 'title';
    if (part === '## Abstract') return 'abstractHeading';
    if (part.startsWith('### ')) return 'subheading';
    if (part.startsWith('## ')) return 'heading';
    if (part.startsWith('```')) return 'code';
    if (part.startsWith('$$')) return 'math';
    if (part.startsWith('<table')) return 'table';
    if (part.startsWith('![')) return 'figure';
    if (/^(?:Table|Figure) \d+\./.test(part)) return 'caption';
    if (/^\[\d+\] /.test(part)) return 'reference';
    if (/^\*[^*].*\*$/s.test(part)) return 'note';
    if (afterAbstract) return 'abstract';
    if (previous.length === 1) return 'byline';
    if (previous.length === 2) return 'affiliation';
    return 'paragraph';
}

// Readable page text for a block: Markdown syntax removed, inline math turned
// into the Unicode a typeset PDF would show.
export function segmentPlainText(segment) {
    const source = segment.markdown;
    switch (segment.kind) {
    case 'title':
    case 'heading':
    case 'subheading':
        return source.replace(/^#+\s+/, '');
    case 'abstractHeading':
        return 'Abstract';
    case 'math':
        return latexToText(source.replace(/^\$\$|\$\$$/g, '').trim());
    case 'note':
        return inlineText(source.replace(/^\*|\*$/g, ''));
    default:
        return inlineText(source);
    }
}

export function inlineText(markdown) {
    return String(markdown)
        .replace(/\$([^$]+)\$/g, (_, math) => latexToText(math))
        .replace(/<sup>([^<]*)<\/sup>/g, (_, value) => superscript(value))
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}

export function latexToText(latex) {
    let text = String(latex);
    for (const [command, symbol] of Object.entries(LATEX_SYMBOLS)) {
        text = text.split(command).join(symbol);
    }
    return text
        .replace(/\\mathbf\{([^}]*)\}/g, '$1')
        .replace(/_([a-z0-9])/gi, (_, value) => SUBSCRIPTS[value] || value)
        .replace(/\^\{?ᵀ\}?/g, 'ᵀ')
        .replace(/[{}]/g, '')
        .replace(/\s*([=+()])\s*/g, ' $1 ')
        .replace(/\(\s+/g, '(')
        .replace(/\s+\)/g, ')')
        .replace(/\s+/g, ' ')
        .trim();
}

function superscript(value) {
    const digits = { 0: '⁰', 1: '¹', 2: '²', 3: '³', ',': '˒' };
    return [...String(value)].map(char => digits[char] || char).join('');
}

export function codeLines(segment) {
    return segment.markdown.split('\n').slice(1, -1);
}

export function tableRows(segment) {
    return [...segment.markdown.matchAll(/<tr>(.*?)<\/tr>/g)].map(row => (
        [...row[1].matchAll(/<td>(.*?)<\/td>/g)].map(cell => cell[1])
    ));
}

export function wrapText(text, width, measure) {
    const words = String(text).split(' ').filter(Boolean);
    const lines = [];
    let current = '';
    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (current && measure(candidate) > width) {
            lines.push(current);
            current = word;
        }
        else {
            current = candidate;
        }
    }
    if (current) lines.push(current);
    return lines;
}

// Lay the paper out on two-column pages. Each returned item is one rectangle
// on one page; a paragraph that crosses a column break yields two items that
// share a segment index.
export function layoutPaperPages(segments, { measure }) {
    if (typeof measure !== 'function') {
        throw new TypeError('A text measure function is required');
    }
    const pages = [{ index: 0, items: [] }];
    let page = pages[0];
    let y = PAGE_MARGIN_TOP;
    let column = -1;
    let columnTop = 0;
    const bottom = PAGE_HEIGHT - PAGE_MARGIN_BOTTOM;

    const newPage = () => {
        page = { index: pages.length, items: [] };
        pages.push(page);
        column = 0;
        columnTop = PAGE_MARGIN_TOP;
        y = columnTop;
    };
    const nextColumn = () => {
        if (column === 0) {
            column = 1;
            y = columnTop;
        }
        else {
            newPage();
        }
    };
    const columnX = () => PAGE_MARGIN_X + column * (COLUMN_WIDTH + COLUMN_GAP);

    for (const segment of segments) {
        const style = PAGE_STYLES[segment.kind] || PAGE_STYLES.paragraph;
        if (FULL_WIDTH_KINDS.has(segment.kind)) {
            const inset = style.inset || 0;
            const width = FULL_WIDTH - inset * 2;
            const fontMeasure = text => measure(text, style);
            const lines = wrapText(segmentPlainText(segment), width, fontMeasure);
            y += style.before;
            const height = lines.length * style.line;
            page.items.push({
                segment: segment.index,
                kind: segment.kind,
                x: PAGE_MARGIN_X + inset,
                y,
                width,
                height,
                lines,
            });
            y += height + style.after;
            continue;
        }
        if (column === -1) {
            page.rule = y - 6;
            column = 0;
            columnTop = y + 4;
            y = columnTop;
        }
        y += style.before;
        if (segment.kind === 'figure' || segment.kind === 'table'
            || segment.kind === 'code' || segment.kind === 'math') {
            const height = blockHeight(segment, style);
            if (y + height > bottom) {
                nextColumn();
            }
            page.items.push({
                segment: segment.index,
                kind: segment.kind,
                x: columnX(),
                y,
                width: COLUMN_WIDTH,
                height,
                lines: segment.kind === 'math' ? [segmentPlainText(segment)] : [],
            });
            y += height + style.after;
            continue;
        }
        const hanging = style.hanging || 0;
        const fontMeasure = text => measure(text, style);
        let lines = wrapText(
            segmentPlainText(segment),
            COLUMN_WIDTH - hanging,
            fontMeasure
        );
        // A heading must not sit alone at the bottom of a column.
        const keepWithNext = segment.kind === 'heading' || segment.kind === 'subheading'
            ? style.line * 3 : 0;
        if (y + style.line + keepWithNext > bottom) nextColumn();
        while (lines.length) {
            const room = Math.max(1, Math.floor((bottom - y) / style.line));
            const take = lines.slice(0, room);
            lines = lines.slice(room);
            page.items.push({
                segment: segment.index,
                kind: segment.kind,
                x: columnX(),
                y,
                width: COLUMN_WIDTH,
                height: take.length * style.line,
                lines: take,
                continued: lines.length > 0,
            });
            y += take.length * style.line;
            if (lines.length) nextColumn();
        }
        y += style.after;
    }
    return pages;
}

function blockHeight(segment, style) {
    if (segment.kind === 'figure') return COLUMN_WIDTH * style.aspect;
    if (segment.kind === 'table') return tableRows(segment).length * style.line + 6;
    if (segment.kind === 'code') return codeLines(segment).length * style.line + style.padding * 2;
    return style.line;
}

const SOURCE_TYPES = Object.freeze({
    figure: 'image',
    table: 'table',
    math: 'equation',
    code: 'code',
    title: 'title',
    heading: 'title',
    subheading: 'title',
    abstractHeading: 'title',
});

// One source-map entry per Markdown block, with a normalized 0..1000 box for
// every rectangle the block occupies on the simulated pages.
export function createPaperSourceMap(segments, pages) {
    const locations = new Map();
    for (const page of pages) {
        for (const item of page.items) {
            const list = locations.get(item.segment) || [];
            list.push({ pageIndex: page.index, bbox: normalizedBBox(item) });
            locations.set(item.segment, list);
        }
    }
    return segments
        .filter(segment => locations.has(segment.index))
        .map(segment => ({
            type: SOURCE_TYPES[segment.kind] || 'text',
            markdownFrom: segment.from,
            markdownTo: segment.to,
            locations: locations.get(segment.index),
        }));
}

export function normalizedBBox(item) {
    const pad = 2;
    const round = value => Math.round(Math.max(0, Math.min(1000, value)) * 10) / 10;
    return [
        round((item.x - pad) / PAGE_WIDTH * 1000),
        round((item.y - pad) / PAGE_HEIGHT * 1000),
        round((item.x + item.width + pad) / PAGE_WIDTH * 1000),
        round((item.y + item.height + pad) / PAGE_HEIGHT * 1000),
    ];
}

// Pair the hand-written translations with the reader's translatable blocks.
// Keys are the English block text a translation starts with. A block without a
// key keeps its own text (author names, for example); a translation that
// fails the reader's own validation is reported and the block falls back too.
export function createPaperTranslation(markdown, translationsByPrefix) {
    const blocks = collectMarkdownTranslationBlocks(markdown);
    const translations = [];
    const missing = [];
    const invalid = [];
    for (const block of blocks) {
        if (!block.translatable) continue;
        const entry = [...translationsByPrefix].find(([prefix]) => (
            block.markdown.startsWith(prefix)
        ));
        let requestMarkdown = block.requestMarkdown;
        if (entry) {
            try {
                requestMarkdown = toPlaceholderMarkdown(block, entry[1]);
                validateTranslatedBlock(block, requestMarkdown);
            }
            catch (error) {
                invalid.push({ id: block.id, message: error.message });
                requestMarkdown = block.requestMarkdown;
            }
        }
        else if (!isIdentityBlock(block)) {
            missing.push(block.id);
        }
        translations.push({ id: block.id, markdown: requestMarkdown });
    }
    const views = createDocumentTranslationViews(markdown, blocks, translations);
    return { blocks, translations, views, missing, invalid };
}

// Byline-style blocks are left in the source language on purpose.
function isIdentityBlock(block) {
    return /<sup>/.test(block.markdown);
}

// Translations are written with the real Markdown of protected fragments
// (math, citations, caption labels). The reader expects the placeholder form
// it sends to a provider, in the same order.
export function toPlaceholderMarkdown(block, translatedMarkdown) {
    let result = '';
    let rest = String(translatedMarkdown);
    for (const fragment of block.protectedFragments || []) {
        const index = rest.indexOf(fragment.markdown);
        if (index < 0) {
            throw new Error(`Translation lost protected fragment ${fragment.markdown}`);
        }
        result += rest.slice(0, index) + fragment.placeholder;
        rest = rest.slice(index + fragment.markdown.length);
    }
    return result + rest;
}

// Matched Zotero PDF annotations for the given Markdown, located by exact
// text. Page indexes come from the simulated layout.
export function createPaperAnnotationOverlay(markdown, annotations, sourceMap) {
    const matched = [];
    const unmatched = [];
    for (const annotation of annotations) {
        const from = markdown.indexOf(annotation.text);
        if (from < 0) {
            unmatched.push({ ...annotationFields(annotation, null), reason: 'not-found' });
            continue;
        }
        const to = from + annotation.text.length;
        const entry = sourceMap.find(candidate => (
            from >= candidate.markdownFrom && to <= candidate.markdownTo
        ));
        const pageIndex = entry?.locations?.[0]?.pageIndex ?? null;
        matched.push({
            ...annotationFields(annotation, pageIndex),
            sortIndex: `${String(pageIndex ?? 0).padStart(5, '0')}|${String(from).padStart(6, '0')}|00000`,
            matchKind: 'exact',
            ranges: [{ from, to }],
        });
    }
    return { matched, unmatched };
}

function annotationFields(annotation, pageIndex) {
    return {
        id: annotation.id,
        type: annotation.type,
        text: annotation.text,
        comment: annotation.comment || '',
        color: annotation.color,
        pageIndex,
        pageLabel: pageIndex === null ? '' : String(pageIndex + 1),
        sortIndex: '00000|000000|00000',
    };
}
