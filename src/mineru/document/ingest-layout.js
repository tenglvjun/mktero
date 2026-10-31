import { normalizeFigureAssetPath } from '../../figures/figure-model.js';
import { safeMinerULinkURL } from '../../markdown/markdown-links.js';
import { validateMinerULayout } from './result-bundle.js';
import {
    BLOCK_KIND,
    BLOCK_ROLE,
    DOCUMENT_IR_SCHEMA,
    MAX_IR_BLOCKS,
    unionBBox,
} from './ir.js';

const TYPE_KIND = new Map([
    ['title', BLOCK_KIND.TITLE],
    ['text', BLOCK_KIND.TEXT],
    ['index', BLOCK_KIND.TEXT],
    ['list', BLOCK_KIND.LIST],
    ['ref_text', BLOCK_KIND.REFERENCE],
    ['interline_equation', BLOCK_KIND.EQUATION],
    ['image', BLOCK_KIND.IMAGE],
    ['chart', BLOCK_KIND.CHART],
    ['table', BLOCK_KIND.TABLE],
    ['code', BLOCK_KIND.CODE],
]);
const MERGE_TOLERANCE = 0.5;

// Builds the document IR from a projected MinerU 3.x layout. MinerU already
// merges paragraphs across columns and pages by moving the continuation's
// lines into the first block and emptying the continuation (`lines_deleted`).
// Those lines keep the continuation's own bbox, so every moved line is
// returned to its original page and box here, as a separate fragment.
export function ingestMinerULayout(layout, { assets = [], assetBasePath = '' } = {}) {
    if (!validateMinerULayout(layout)) throw new TypeError('A projected MinerU layout is required');
    const pageSizes = new Map(layout.pages.map(page => [page.pageIndex, page.pageSize]));
    const context = {
        pageSizes,
        resolveAsset: createAssetResolver(assets, assetBasePath),
        deleted: collectDeletedBlocks(layout),
        diagnostics: {
            droppedBlocks: 0,
            mergedTables: 0,
            unknownTypes: {},
            unmatchedDeleted: 0,
            unresolvedAssets: 0,
            reorderedBands: [],
            joins: [],
            chromeFallbacks: [],
            equationNumbers: [],
            notePlacements: [],
        },
    };
    const blocks = [];
    const pages = [];
    for (const page of layout.pages) {
        const [width, height] = page.pageSize;
        pages.push({ pageIndex: page.pageIndex, width, height, geometry: 'block' });
        for (const [ordinal, raw] of page.blocks.entries()) {
            if (raw.linesDeleted && !raw.lines?.length) continue;
            if (isMergedTableContinuation(raw)) {
                attachTableContinuation(blocks, raw, page.pageIndex, ordinal, context);
                continue;
            }
            pushBlock(blocks, buildBlock(raw, page.pageIndex, ordinal, false, context), context);
        }
        for (const [ordinal, raw] of page.discarded.entries()) {
            pushBlock(blocks, buildBlock(raw, page.pageIndex, ordinal, true, context), context);
        }
    }
    context.diagnostics.unmatchedDeleted = context.deleted.filter(entry => !entry.consumed).length;
    markLineGeometry(pages, blocks);
    return {
        schema: DOCUMENT_IR_SCHEMA,
        source: {
            origin: 'layout',
            backend: layout.backend ?? null,
            version: layout.version ?? null,
            effort: layout.effort ?? null,
            ocrEnabled: layout.ocrEnabled ?? null,
        },
        pages,
        blocks,
        diagnostics: context.diagnostics,
    };
}

export function normalizePageBBox(bbox, pageSize) {
    if (!Array.isArray(bbox) || bbox.length !== 4 || !Array.isArray(pageSize)) return null;
    const [width, height] = pageSize;
    const output = [
        bbox[0] * 1000 / width,
        bbox[1] * 1000 / height,
        bbox[2] * 1000 / width,
        bbox[3] * 1000 / height,
    ].map(value => Math.round(Math.min(1000, Math.max(0, value)) * 1000) / 1000);
    return output.every(Number.isFinite) && output[0] < output[2] && output[1] < output[3]
        ? output
        : null;
}

export function createAssetResolver(assets, basePath = '') {
    const paths = new Set();
    for (const asset of assets || []) {
        try {
            paths.add(normalizeFigureAssetPath(asset?.path));
        }
        catch {
            // Unsupported archive paths cannot be referenced.
        }
    }
    let base = '';
    try {
        base = basePath ? normalizeFigureAssetPath(basePath) : '';
    }
    catch {
        base = '';
    }
    return imagePath => {
        if (typeof imagePath !== 'string' || !imagePath) return null;
        const found = new Set();
        for (const candidate of [imagePath, `images/${imagePath}`]) {
            try {
                const resolved = normalizeFigureAssetPath(candidate, base);
                if (paths.has(resolved)) found.add(resolved);
            }
            catch {
                // Unsafe paths never resolve.
            }
        }
        if (found.size !== 1) return null;
        const resolved = [...found][0];
        return base && resolved.startsWith(`${base}/`) ? resolved.slice(base.length + 1) : resolved;
    };
}

function pushBlock(blocks, block, context) {
    if (!block) {
        context.diagnostics.droppedBlocks++;
        return;
    }
    if (blocks.length >= MAX_IR_BLOCKS) throw new Error('MinerU document IR exceeds the block limit');
    blocks.push(block);
}

// MinerU merges a table continued on the next page into the first table and
// empties the continuation's body. The continuation's box becomes another
// fragment of the merged table so it can be located on both pages.
function isMergedTableContinuation(raw) {
    return raw.type === 'table' && Array.isArray(raw.blocks) && raw.blocks.length > 0
        && raw.blocks.some(child => child.type === 'table_body')
        && raw.blocks.every(child => child.linesDeleted && !child.lines?.length);
}

function attachTableContinuation(blocks, raw, pageIndex, ordinal, context) {
    const bbox = normalizePageBBox(raw.bbox, context.pageSizes.get(pageIndex));
    const host = blocks.findLast(block => block.kind === BLOCK_KIND.TABLE && block.pageIndex < pageIndex);
    if (!host || !bbox) {
        context.diagnostics.droppedBlocks++;
        return;
    }
    host.fragments.push({ pageIndex, bbox, lines: [], sourceId: `p${pageIndex}-${ordinal}` });
    host.absorbed.push(`p${pageIndex}-${ordinal}`);
    context.diagnostics.mergedTables++;
}

function collectDeletedBlocks(layout) {
    const deleted = [];
    for (const page of layout.pages) {
        for (const [ordinal, raw] of page.blocks.entries()) {
            if (raw.linesDeleted && !raw.lines?.length && raw.bbox) {
                deleted.push({ pageIndex: page.pageIndex, ordinal, bbox: raw.bbox, consumed: false });
            }
        }
    }
    return deleted;
}

function buildBlock(raw, pageIndex, ordinal, discarded, context) {
    const pageSize = context.pageSizes.get(pageIndex);
    const id = discarded ? `p${pageIndex}-d${ordinal}` : `p${pageIndex}-${ordinal}`;
    const type = typeof raw.type === 'string' ? raw.type : '';
    let kind = discarded ? BLOCK_KIND.DISCARDED : TYPE_KIND.get(type);
    if (kind === BLOCK_KIND.CODE && raw.subType === 'algorithm') kind = BLOCK_KIND.ALGORITHM;
    const block = {
        id,
        kind: kind || BLOCK_KIND.TEXT,
        mineruType: type || 'unknown',
        role: BLOCK_ROLE.BODY,
        pageIndex,
        sourceOrdinal: ordinal,
        bbox: normalizePageBBox(raw.bbox, pageSize),
        fragments: [],
        children: [],
        mergedFrom: [],
        absorbed: [],
        ...(raw.index !== undefined ? { mineruIndex: raw.index } : {}),
        ...(raw.level !== undefined ? { mineruLevel: raw.level } : {}),
    };
    if (!kind) context.diagnostics.unknownTypes[block.mineruType] = (context.diagnostics.unknownTypes[block.mineruType] || 0) + 1;
    if (discarded) {
        block.role = type === 'page_footnote' ? BLOCK_ROLE.PAGE_NOTE : BLOCK_ROLE.CHROME;
        block.fragments = simpleFragments(raw, pageIndex, context);
        return block.fragments.length ? block : null;
    }
    switch (block.kind) {
        case BLOCK_KIND.EQUATION:
            return buildEquation(block, raw, context);
        case BLOCK_KIND.IMAGE:
        case BLOCK_KIND.CHART:
        case BLOCK_KIND.TABLE:
        case BLOCK_KIND.CODE:
        case BLOCK_KIND.ALGORITHM:
            return buildFloat(block, raw, context);
        default:
            block.role = block.kind === BLOCK_KIND.TITLE ? BLOCK_ROLE.HEADING
                : block.kind === BLOCK_KIND.REFERENCE ? BLOCK_ROLE.REFERENCE
                    : BLOCK_ROLE.BODY;
            block.fragments = raw.blocks && !raw.lines?.length
                ? raw.blocks.flatMap(child => simpleFragments(child, pageIndex, context))
                : recoverFragments(raw, block, context);
            if (!block.fragments.length) return null;
            block.bbox ||= unionBBox(block.fragments.filter(fragment => fragment.pageIndex === pageIndex)
                .map(fragment => fragment.bbox));
            return block;
    }
}

// Splits a merged block back into the fragments MinerU joined. The first
// line always belongs to the block itself; a later line starts a new
// fragment when its bbox equals an emptied continuation block later in the
// document, and the earliest unused such block wins.
function recoverFragments(raw, block, context) {
    const fragments = [];
    let current = { pageIndex: block.pageIndex, sourceId: block.id, ownBox: null, lines: [] };
    fragments.push(current);
    for (const [lineIndex, line] of (raw.lines || []).entries()) {
        if (lineIndex > 0 && line.bbox) {
            const match = context.deleted.find(entry => (
                !entry.consumed
                && (entry.pageIndex > block.pageIndex
                    || entry.pageIndex === block.pageIndex && entry.ordinal > block.sourceOrdinal)
                && sameBox(entry.bbox, line.bbox)
            ));
            if (match) {
                match.consumed = true;
                const sourceId = `p${match.pageIndex}-${match.ordinal}`;
                block.absorbed.push(sourceId);
                current = {
                    pageIndex: match.pageIndex,
                    sourceId,
                    ownBox: normalizePageBBox(match.bbox, context.pageSizes.get(match.pageIndex)),
                    lines: [],
                };
                fragments.push(current);
            }
        }
        const pageSize = context.pageSizes.get(current.pageIndex);
        const spans = convertSpans(line.spans);
        if (!spans.length) continue;
        current.lines.push({ bbox: normalizePageBBox(line.bbox, pageSize), spans });
    }
    return fragments
        .filter(fragment => fragment.lines.length)
        .map(fragment => ({
            pageIndex: fragment.pageIndex,
            bbox: fragment.ownBox
                || unionBBox(fragment.lines.map(line => line.bbox))
                || block.bbox,
            sourceId: fragment.sourceId,
            lines: fragment.lines,
        }));
}

function simpleFragments(raw, pageIndex, context) {
    const pageSize = context.pageSizes.get(pageIndex);
    const lines = [];
    for (const line of raw.lines || []) {
        const spans = convertSpans(line.spans);
        if (spans.length) lines.push({ bbox: normalizePageBBox(line.bbox, pageSize), spans });
    }
    if (!lines.length) return [];
    return [{
        pageIndex,
        bbox: normalizePageBBox(raw.bbox, pageSize) || unionBBox(lines.map(line => line.bbox)),
        lines,
    }];
}

function buildEquation(block, raw, context) {
    const latex = [];
    let imagePath = null;
    for (const line of raw.lines || []) {
        for (const span of line.spans || []) {
            if (typeof span.content === 'string' && span.content.trim()) latex.push(span.content.trim());
            if (!imagePath && typeof span.imagePath === 'string') imagePath = span.imagePath;
        }
    }
    if (!latex.length && typeof raw.content === 'string' && raw.content.trim()) latex.push(raw.content.trim());
    if (!latex.length) return null;
    block.role = BLOCK_ROLE.BODY;
    block.latex = latex.join('\n');
    const assetPath = resolveAsset(imagePath, context);
    if (assetPath) block.assetPath = assetPath;
    block.fragments = block.bbox ? [{ pageIndex: block.pageIndex, bbox: block.bbox, lines: [] }] : [];
    return block;
}

function buildFloat(block, raw, context) {
    const pageSize = context.pageSizes.get(block.pageIndex);
    block.role = BLOCK_ROLE.FLOAT;
    if (typeof raw.guessLang === 'string') block.codeLanguage = raw.guessLang;
    if (typeof raw.subType === 'string') block.subType = raw.subType;
    // MinerU 4.0 marks a table it found continued from the previous page.
    if (raw.continuesPrev === true && block.kind === BLOCK_KIND.TABLE) block.continuesPrev = true;
    const counts = { body: 0, caption: 0, footnote: 0 };
    const children = Array.isArray(raw.blocks) ? raw.blocks : [raw];
    for (const child of children) {
        const childType = typeof child.type === 'string' ? child.type : '';
        const kind = /_caption$/.test(childType) ? 'caption'
            : /_footnote$/.test(childType) ? 'footnote'
                : 'body';
        const bbox = normalizePageBBox(child.bbox, pageSize);
        if (kind !== 'body') {
            const fragments = simpleFragments(child, block.pageIndex, context);
            if (fragments.length) {
                block.children.push({ id: `${block.id}:${kind}${counts[kind]++}`, kind, pageIndex: block.pageIndex, bbox, fragments });
            }
            continue;
        }
        if (block.kind === BLOCK_KIND.CODE || block.kind === BLOCK_KIND.ALGORITHM) {
            const code = codeText(child);
            if (code) block.children.push({ id: `${block.id}:body${counts.body++}`, kind, pageIndex: block.pageIndex, bbox, code });
            continue;
        }
        for (const line of child.lines || []) {
            for (const span of line.spans || []) {
                const output = { id: `${block.id}:body${counts.body}`, kind, pageIndex: block.pageIndex,
                    bbox: normalizePageBBox(span.bbox, pageSize) || bbox };
                if (typeof span.html === 'string' && span.html.trim()) output.html = span.html;
                if (typeof span.imagePath === 'string') {
                    const assetPath = resolveAsset(span.imagePath, context);
                    if (assetPath) output.assetPath = assetPath;
                }
                if (span.type === 'chart' && typeof span.content === 'string' && span.content.trim()) {
                    output.data = span.content;
                }
                if (output.html || output.assetPath || output.data) {
                    block.children.push(output);
                    counts.body++;
                }
            }
        }
    }
    if (!block.children.length) return null;
    block.bbox ||= unionBBox(block.children.map(child => child.bbox));
    block.fragments = block.bbox ? [{ pageIndex: block.pageIndex, bbox: block.bbox, lines: [] }] : [];
    return block;
}

function codeText(child) {
    const lines = [];
    for (const line of child.lines || []) {
        lines.push((line.spans || []).map(span => {
            if (typeof span.content !== 'string') return '';
            return span.type === 'inline_equation' ? `$${span.content.trim()}$` : span.content;
        }).join(''));
    }
    return lines.join('\n').replace(/\s+$/u, '');
}

function convertSpans(spans) {
    const output = [];
    for (const span of spans || []) {
        if (typeof span.content !== 'string') continue;
        if (!span.content.trim() && !span.exactSpacing) continue;
        const linkURL = safeMinerULinkURL(span.linkURL);
        if (span.type === 'text' || span.type === 'hyperlink') {
            output.push({
                type: 'text',
                content: span.content,
                ...(linkURL ? { linkURL } : {}),
                ...(span.exactSpacing ? { exactSpacing: true } : {}),
            });
        }
        else if (span.type === 'inline_equation' || span.type === 'interline_equation') {
            output.push({
                type: 'math',
                content: span.content.trim(),
                ...(linkURL ? { linkURL } : {}),
                ...(span.exactSpacing ? { exactSpacing: true } : {}),
            });
        }
    }
    return output;
}

function resolveAsset(imagePath, context) {
    if (!imagePath) return null;
    const resolved = context.resolveAsset(imagePath);
    if (!resolved) context.diagnostics.unresolvedAssets++;
    return resolved;
}

function sameBox(left, right) {
    return Array.isArray(left) && Array.isArray(right)
        && left.every((value, index) => Math.abs(value - right[index]) <= MERGE_TOLERANCE);
}

// A page has line geometry when a block that MinerU did not merge still
// holds several lines with distinct boxes. Hosted results only report one
// box per original block, so they stay at block geometry.
function markLineGeometry(pages, blocks) {
    const linePages = new Set();
    for (const block of blocks) {
        if (block.absorbed.length) continue;
        for (const fragment of block.fragments) {
            if (fragment.lines.length < 2) continue;
            const boxes = new Set(fragment.lines.map(line => line.bbox?.join(',')));
            if (boxes.size > 1 && !boxes.has(undefined)) linePages.add(fragment.pageIndex);
        }
    }
    for (const page of pages) {
        if (linePages.has(page.pageIndex)) page.geometry = 'line';
    }
}
