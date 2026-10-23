import { FIGURE_LIMITS } from '../../figures/figure-limits.js';
import { parseAcademicFigureCaption } from '../../markdown/markdown-figures.js';
import { MINERU_FIGURE_LAYOUT_OPTIONS } from '../parser-profile.js';
import { BLOCK_ROLE, blockPlainText, unionBBox } from './ir.js';

// Figure-pipeline block type of each serialized piece. The region resolver
// treats headings, tables, equations, code, and references as foreign
// content that a figure never owns.
const PIECE_TYPES = {
    heading: 'heading',
    equation: 'equation',
    table: 'table',
    code: 'code',
    reference: 'reference',
    caption: 'caption',
    note: 'text',
    text: 'text',
};

// The figure pipeline's input for a serialized MinerU document. Every block
// carries the exact Markdown range the serializer wrote for it, so source
// binding only checks the ranges (`rangesExplicit`). Blocks are named by the
// serializer's piece keys, which lets a composed figure name the IR pieces it
// replaces when the document is written again.
export function createFigureInputFromIR(ir, serialized, bundle = {}) {
    const blocksByID = new Map(ir.blocks.map(block => [block.id, block]));
    const blocks = [];
    const groups = new Set();
    let ordinal = 0;
    const push = block => {
        if (blocks.length >= FIGURE_LIMITS.maxLayoutBlocks) return;
        blocks.push({ sourceOrdinal: ordinal++, ...block });
    };
    for (const piece of serialized.pieces) {
        if (piece.part === 'composite' || !Number.isSafeInteger(piece.pageIndex)) continue;
        const source = blocksByID.get(piece.blockId);
        const bbox = validBBox(piece.bbox);
        const range = [{ from: piece.from, to: piece.to }];
        if (piece.part === 'panel') {
            if (!groups.has(source.id)) {
                groups.add(source.id);
                push({
                    id: source.id, pageIndex: source.pageIndex, type: source.kind, role: 'unknown',
                    bboxKind: 'group', bbox: groupBBox(source), text: '',
                    sourceRanges: [], rangeEvidence: 'unresolved',
                });
            }
            push({
                id: piece.key, pageIndex: source.pageIndex, type: source.kind, role: 'panel',
                bboxKind: 'visual-body', bbox, assetPath: piece.assetPath, parentId: source.id, text: '',
                sourceRanges: range, rangeEvidence: 'explicit-range',
            });
            continue;
        }
        if (piece.part === 'caption' && piece.parentId) {
            push({
                id: piece.key, pageIndex: source.pageIndex, type: 'caption', role: 'caption',
                bboxKind: 'caption', bbox, parentId: piece.parentId, embeddedCaption: true,
                text: boundedText(piece.text), sourceRanges: range, rangeEvidence: 'explicit-range',
            });
            continue;
        }
        // A footnote MinerU grouped into an image is figure text of that
        // figure, as in MinerU's own block; the resolver decides by distance
        // whether the crop owns it. A body note attached later stays body.
        if (piece.part === 'note' && groups.has(source.id)) {
            push({
                id: piece.key, pageIndex: source.pageIndex, type: 'text', role: 'figure-text',
                bboxKind: 'text', bbox, parentId: source.id, text: boundedText(piece.text),
                sourceRanges: range, rangeEvidence: 'explicit-range',
            });
            continue;
        }
        // A table or code float is located by its body, as MinerU's own
        // block box is; its caption and notes never block a nearby figure.
        const foreignPart = piece.part === 'table' || piece.part === 'code';
        const located = !foreignPart || piece.key === `${source.id}:body`;
        // A paragraph stitched across a column, page, or float is prose: its
        // fragments mark where text is, but a figure can never consume them or
        // read them as the rest of its caption.
        const stitched = source.fragments.length > 1 && /#f\d+$/u.test(piece.key);
        push({
            id: piece.key, pageIndex: piece.pageIndex, type: PIECE_TYPES[piece.part] || 'text',
            role: pieceRole(piece), bboxKind: 'text', bbox: located ? bbox : null, text: boundedText(piece.text),
            sourceRanges: stitched ? [] : range, rangeEvidence: stitched ? 'unresolved' : 'explicit-range',
        });
    }
    // Labels inside a picture are not written to the Markdown. They still
    // belong to the figure area, so the resolver can own them; with no range
    // they are never removed from the text.
    for (const block of ir.blocks) {
        if (block.role !== BLOCK_ROLE.FLOAT_NOTE || block.attachedTo || !block.bbox) continue;
        push({
            id: `${block.id}#interior`, pageIndex: block.pageIndex, type: 'text', role: 'unknown',
            bboxKind: 'text', bbox: validBBox(block.bbox), text: boundedText(blockPlainText(block)),
            sourceRanges: [], rangeEvidence: 'unresolved',
        });
    }
    return {
        provider: 'mineru',
        rangesExplicit: true,
        markdown: serialized.markdown,
        assets: bundle.assets || [],
        assetBasePath: bundle.assetBasePath || '',
        pages: figurePages(ir),
        blocks,
        contentList: [],
        providerState: { mineruDocument: { ir } },
        extractedPages: bundle.extractedPages,
        totalPages: bundle.totalPages,
        warnings: Array.isArray(bundle.warnings) ? [...bundle.warnings] : [],
    };
}

// A note attached to a float is reading text, not part of the picture: as a
// `body` block it is never consumed into a composed figure. Other text keeps
// the role the region resolver expects from MinerU paragraphs.
function pieceRole(piece) {
    if (piece.part === 'note' || piece.part === 'table' || piece.part === 'code' || piece.part === 'equation') {
        return 'body';
    }
    return parseAcademicFigureCaption(piece.text) ? 'caption' : 'unknown';
}

function figurePages(ir) {
    const supported = ir.source?.origin === 'layout'
        && MINERU_FIGURE_LAYOUT_OPTIONS.backends.includes(ir.source.backend)
        && MINERU_FIGURE_LAYOUT_OPTIONS.versions.includes(ir.source.version);
    return ir.pages.map(page => {
        if (ir.source?.origin !== 'layout') {
            return { pageIndex: page.pageIndex, coordinateFrame: 'unknown', rotation: null,
                geometryEvidence: 'content-list-only', markdownRange: null };
        }
        return {
            pageIndex: page.pageIndex, width: page.width, height: page.height,
            unit: MINERU_FIGURE_LAYOUT_OPTIONS.unit, dpi: null,
            coordinateFrame: supported ? 'display-cropbox' : 'unknown', rotation: null,
            ...(supported ? {} : { geometryReason: 'unsupported-layout-schema' }),
            geometryEvidence: 'mineru-layout-v2', markdownRange: null,
        };
    });
}

// MinerU's own float box, as the region resolver measures figure groups by
// it; widened only when it does not contain its image bodies.
function groupBBox(block) {
    const bodies = block.children.filter(child => child.kind === 'body').map(child => child.bbox).filter(Boolean);
    const own = validBBox(block.bbox);
    const panels = unionBBox(bodies);
    if (own && (!panels || panels[0] >= own[0] && panels[1] >= own[1] && panels[2] <= own[2] && panels[3] <= own[3])) {
        return own;
    }
    return validBBox(unionBBox([block.bbox, ...bodies]));
}

function validBBox(bbox) {
    return Array.isArray(bbox) && bbox.length === 4 && bbox.every(Number.isFinite)
        && bbox[0] >= 0 && bbox[1] >= 0 && bbox[2] <= 1000 && bbox[3] <= 1000
        && bbox[2] > bbox[0] && bbox[3] > bbox[1]
        ? [...bbox]
        : null;
}

function boundedText(text) {
    return String(text || '').slice(0, FIGURE_LIMITS.maxFragmentLength);
}
