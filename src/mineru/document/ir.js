export const DOCUMENT_IR_SCHEMA = 'mktero-mineru-ir-v1';

export const BLOCK_KIND = Object.freeze({
    TITLE: 'title',
    TEXT: 'text',
    LIST: 'list',
    REFERENCE: 'reference',
    EQUATION: 'equation',
    IMAGE: 'image',
    CHART: 'chart',
    TABLE: 'table',
    CODE: 'code',
    ALGORITHM: 'algorithm',
    DISCARDED: 'discarded',
});

export const BLOCK_ROLE = Object.freeze({
    BODY: 'body',
    HEADING: 'heading',
    FLOAT: 'float',
    CAPTION: 'caption',
    FLOAT_NOTE: 'float-note',
    PAGE_NOTE: 'page-note',
    REFERENCE: 'reference',
    FRONT_MATTER: 'front-matter',
    BACK_MATTER: 'back-matter',
    CHROME: 'chrome',
});

export const FLOAT_KINDS = new Set([
    BLOCK_KIND.IMAGE,
    BLOCK_KIND.CHART,
    BLOCK_KIND.TABLE,
    BLOCK_KIND.CODE,
    BLOCK_KIND.ALGORITHM,
]);

export const TEXT_KINDS = new Set([
    BLOCK_KIND.TITLE,
    BLOCK_KIND.TEXT,
    BLOCK_KIND.LIST,
    BLOCK_KIND.REFERENCE,
]);

export const MAX_IR_BLOCKS = 100_000;

export function isFloatBlock(block) {
    return FLOAT_KINDS.has(block?.kind);
}

export function isTextBlock(block) {
    return TEXT_KINDS.has(block?.kind);
}

// Text of a span list: text spans are trimmed and joined with single spaces,
// inline math is wrapped in `$`. MinerU writes full.md the same way.
export function spansText(spans, { math = true } = {}) {
    const parts = [];
    for (const span of spans || []) {
        if (span.type === 'math') {
            const content = String(span.content || '').trim();
            if (content) parts.push(math ? `$${content}$` : content);
        }
        else if (span.type === 'text') {
            const content = String(span.content || '').replace(/\s+/gu, ' ').trim();
            if (content) parts.push(content);
        }
    }
    return parts.join(' ');
}

export function fragmentText(fragment, options) {
    return (fragment?.lines || [])
        .map(line => spansText(line.spans, options))
        .filter(Boolean)
        .join(' ');
}

export function blockPlainText(block) {
    return (block?.fragments || [])
        .map(fragment => fragmentText(fragment, { math: false }))
        .filter(Boolean)
        .join(' ');
}

export function childText(block, kind) {
    return (block?.children || [])
        .filter(child => child.kind === kind)
        .map(child => (child.fragments || []).map(fragment => fragmentText(fragment)).filter(Boolean).join(' '))
        .filter(Boolean);
}

export function unionBBox(boxes) {
    let output = null;
    for (const bbox of boxes) {
        if (!bbox) continue;
        output = output
            ? [
                Math.min(output[0], bbox[0]),
                Math.min(output[1], bbox[1]),
                Math.max(output[2], bbox[2]),
                Math.max(output[3], bbox[3]),
            ]
            : [...bbox];
    }
    return output;
}

export function validateDocumentIR(ir) {
    if (ir?.schema !== DOCUMENT_IR_SCHEMA || !Array.isArray(ir.pages) || !Array.isArray(ir.blocks)) {
        throw new TypeError('Invalid MinerU document IR');
    }
    if (ir.blocks.length > MAX_IR_BLOCKS) throw new Error('MinerU document IR exceeds the block limit');
    const ids = new Set();
    for (const block of ir.blocks) {
        if (typeof block?.id !== 'string' || !block.id || ids.has(block.id)) {
            throw new TypeError('MinerU document IR block ids must be unique');
        }
        ids.add(block.id);
        if (!Object.values(BLOCK_KIND).includes(block.kind) || !Object.values(BLOCK_ROLE).includes(block.role)) {
            throw new TypeError('Invalid MinerU document IR block');
        }
    }
    return ir;
}
