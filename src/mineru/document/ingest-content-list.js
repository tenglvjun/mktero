import { createAssetResolver } from './ingest-layout.js';
import { BLOCK_KIND, BLOCK_ROLE, DOCUMENT_IR_SCHEMA, MAX_IR_BLOCKS } from './ir.js';

const DISCARDED_TYPES = new Set(['header', 'footer', 'page_number', 'aside_text', 'page_footnote']);
const INLINE_MATH = /(?<!\$)\$(?!\$)([^$\n]+?)(?<!\\)\$(?!\$)/gu;

// Fallback when a result has no layout JSON. The flat content list has one
// normalized (0-1000) box per block and no merge records, so every block is
// a single fragment and every page uses block geometry.
export function ingestMinerUContentList(contentList, { assets = [], assetBasePath = '' } = {}) {
    if (!Array.isArray(contentList)) throw new TypeError('A MinerU content list is required');
    if (contentList.length > MAX_IR_BLOCKS) throw new Error('MinerU document IR exceeds the block limit');
    const resolveAsset = createAssetResolver(assets, assetBasePath);
    const ordinals = new Map();
    const blocks = [];
    const diagnostics = {
        droppedBlocks: 0, unknownTypes: {}, unmatchedDeleted: 0, unresolvedAssets: 0,
        reorderedBands: [], joins: [], chromeFallbacks: [],
    };
    for (const entry of contentList) {
        const pageIndex = entry?.pageIndex;
        if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
            diagnostics.droppedBlocks++;
            continue;
        }
        const ordinal = ordinals.get(pageIndex) || 0;
        ordinals.set(pageIndex, ordinal + 1);
        const block = buildBlock(entry, pageIndex, ordinal, resolveAsset, diagnostics);
        if (block) blocks.push(block);
        else diagnostics.droppedBlocks++;
    }
    const pages = [...ordinals.keys()].sort((left, right) => left - right)
        .map(pageIndex => ({ pageIndex, width: 1000, height: 1000, geometry: 'block' }));
    return {
        schema: DOCUMENT_IR_SCHEMA,
        source: { origin: 'content-list', backend: null, version: null, effort: null, ocrEnabled: null },
        pages,
        blocks,
        diagnostics,
    };
}

export function parseInlineMathSpans(text) {
    const spans = [];
    let index = 0;
    for (const match of String(text || '').matchAll(INLINE_MATH)) {
        if (match.index > index) spans.push({ type: 'text', content: text.slice(index, match.index) });
        spans.push({ type: 'math', content: match[1].trim() });
        index = match.index + match[0].length;
    }
    if (index < String(text || '').length) spans.push({ type: 'text', content: text.slice(index) });
    return spans.filter(span => span.content.trim());
}

function buildBlock(entry, pageIndex, ordinal, resolveAsset, diagnostics) {
    const bbox = Array.isArray(entry.bbox) ? [...entry.bbox] : null;
    const id = `p${pageIndex}-c${ordinal}`;
    const base = {
        id, pageIndex, sourceOrdinal: ordinal, bbox,
        mineruType: entry.type, children: [], mergedFrom: [], absorbed: [],
    };
    const fragment = text => {
        const spans = parseInlineMathSpans(text);
        return spans.length ? [{ pageIndex, bbox, lines: [{ bbox, spans }] }] : [];
    };
    if (DISCARDED_TYPES.has(entry.type)) {
        const fragments = fragment(entry.text);
        return fragments.length ? {
            ...base, kind: BLOCK_KIND.DISCARDED,
            role: entry.type === 'page_footnote' ? BLOCK_ROLE.PAGE_NOTE : BLOCK_ROLE.CHROME,
            fragments,
        } : null;
    }
    switch (entry.type) {
        case 'text':
        case 'ref_text':
        case 'list': {
            const fragments = fragment(entry.text);
            if (!fragments.length) return null;
            const title = entry.type === 'text' && Number.isSafeInteger(entry.textLevel) && entry.textLevel > 0;
            return {
                ...base,
                kind: title ? BLOCK_KIND.TITLE : entry.type === 'ref_text' ? BLOCK_KIND.REFERENCE
                    : entry.type === 'list' ? BLOCK_KIND.LIST : BLOCK_KIND.TEXT,
                role: title ? BLOCK_ROLE.HEADING : entry.type === 'ref_text' ? BLOCK_ROLE.REFERENCE : BLOCK_ROLE.BODY,
                ...(title ? { mineruLevel: entry.textLevel } : {}),
                fragments,
            };
        }
        case 'equation': {
            const latex = String(entry.text || '').trim().replace(/^\$\$\s*/u, '').replace(/\s*\$\$$/u, '').trim();
            if (!latex) return null;
            return {
                ...base, kind: BLOCK_KIND.EQUATION, role: BLOCK_ROLE.BODY, latex,
                fragments: bbox ? [{ pageIndex, bbox, lines: [] }] : [],
            };
        }
        case 'image':
        case 'chart':
        case 'table':
        case 'code': {
            const kind = entry.type === 'code' && entry.subType === 'algorithm' ? BLOCK_KIND.ALGORITHM
                : entry.type === 'code' ? BLOCK_KIND.CODE : entry.type;
            const children = [];
            const assetPath = entry.assetPath ? resolveAsset(entry.assetPath) : null;
            if (entry.assetPath && !assetPath) diagnostics.unresolvedAssets++;
            if (kind === BLOCK_KIND.CODE || kind === BLOCK_KIND.ALGORITHM) {
                const code = unwrapAlgorithm(String(entry.text || ''));
                if (code) children.push({ id: `${id}:body0`, kind: 'body', pageIndex, bbox, code });
            }
            else {
                const body = { id: `${id}:body0`, kind: 'body', pageIndex, bbox };
                if (assetPath) body.assetPath = assetPath;
                if (entry.type === 'table' && /^\s*<table\b/iu.test(entry.text || '')) body.html = entry.text;
                if (entry.type === 'chart' && entry.text) body.data = entry.text;
                if (body.assetPath || body.html || body.data) children.push(body);
            }
            for (const [index, caption] of (entry.captions || []).entries()) {
                const fragments = fragment(caption);
                if (fragments.length) children.push({ id: `${id}:caption${index}`, kind: 'caption', pageIndex, bbox, fragments });
            }
            if (!children.length) return null;
            return {
                ...base, kind, role: BLOCK_ROLE.FLOAT, children,
                fragments: bbox ? [{ pageIndex, bbox, lines: [] }] : [],
            };
        }
        default: {
            diagnostics.unknownTypes[entry.type] = (diagnostics.unknownTypes[entry.type] || 0) + 1;
            const fragments = fragment(entry.text);
            return fragments.length
                ? { ...base, kind: BLOCK_KIND.TEXT, role: BLOCK_ROLE.BODY, fragments }
                : null;
        }
    }
}

// The flat list wraps algorithms in MinerU's display container; the
// serializer adds its own, so only the content is kept.
function unwrapAlgorithm(code) {
    const match = /^\s*<div\b[^>]*\bmineru-algorithm\b[^>]*>\n?([\s\S]*?)\n?<\/div>\s*$/iu.exec(code);
    return (match ? match[1] : code).replace(/\s+$/u, '');
}
