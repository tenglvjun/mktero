import { sha256Hex } from './sha256.js';
import { collectFigureImageNodes, normalizeFigureAssetPath } from '../figures/figure-model.js';
import { escapeImageDescription } from '../markdown/markdown-figures.js';
import { visibleMarkdownTextForRanges } from '../markdown/markdown-visible-text.js';

const HASH = /^[0-9a-f]{64}$/;
const MAX_MARKDOWN_BYTES = 8 * 1024 * 1024;
const MAX_FIGURES = 64;
const MAX_CAPTION_CHARACTERS = 8_192;
const MAX_CAPTION_TEXT = 65_536;
const MAX_PROOF_TEXT = 2_000_000;
const MAX_FRAGMENTS = 512;
const MAX_PANELS = 128;
const validatedMaps = new WeakMap();

// This is transient document evidence, never annotation data. The locator must
// still verify the complete caption against the PDF text and page geometry.
export async function createPDFCaptionEvidence({ markdown, sourceHash, figureMap } = {}, {
    hash = sha256Hex,
} = {}) {
    try {
        if (typeof markdown !== 'string' || markdown.length > MAX_MARKDOWN_BYTES
            || typeof sourceHash !== 'string' || !HASH.test(sourceHash)
            || !figureMap || typeof figureMap !== 'object'
            || figureMap.version !== 1 || typeof figureMap.markdownHash !== 'string'
            || !HASH.test(figureMap.markdownHash)
            || !Array.isArray(figureMap.figures) || !figureMap.figures.length
            || figureMap.figures.length > MAX_FIGURES) return null;
        const snapshot = snapshotFigures(figureMap.figures);
        const signature = JSON.stringify([figureMap.markdownHash, snapshot]);
        const previous = validatedMaps.get(figureMap);
        if (previous?.markdown === markdown && previous.sourceHash === sourceHash
            && previous.signature === signature && previous.hash === hash) {
            return previous.promise;
        }
        const bytes = new TextEncoder().encode(markdown);
        if (bytes.length > MAX_MARKDOWN_BYTES) return null;
        const markdownHash = figureMap.markdownHash;
        const promise = validateDocument(markdown, bytes, sourceHash, markdownHash, snapshot, hash)
            .catch(() => null);
        validatedMaps.set(figureMap, { markdown, sourceHash, signature, hash, promise });
        return promise;
    }
    catch {
        return null;
    }
}

async function validateDocument(markdown, bytes, sourceHash, markdownHash, figures, hash) {
    if (await hash(bytes) !== markdownHash) return null;
    const images = new Map(collectFigureImageNodes(markdown)
        .map(image => [`${image.from}:${image.to}`, image]));
    const captions = [];
    const anchors = new Set();
    let textLength = 0;
    for (const figure of figures) {
        const caption = validateCaption(markdown, figure, images);
        if (!caption) continue;
        const anchor = `${figure.render.range.from}:${figure.render.range.to}`;
        if (anchors.has(anchor)) return null;
        anchors.add(anchor);
        textLength += caption.text.length;
        if (textLength > MAX_CAPTION_TEXT) return null;
        captions.push(caption);
    }
    return captions.length
        ? Object.freeze({ sourceHash, markdownHash, captions: Object.freeze(captions) })
        : null;
}

function validateCaption(markdown, figure, images) {
    const { provenance, render, visualBBox, captionBBox } = figure;
    if (!Number.isSafeInteger(figure.pageIndex) || figure.pageIndex < 0
        || figure.pageIndex >= 100_000
        // The stored PDF geometry belongs to the panel page. A caption on a
        // different page needs separate geometry before it can be evidence.
        || figure.captionPageIndex !== figure.pageIndex
        || !visualBBox || !captionBBox || overlaps(visualBBox, captionBBox)
        || provenance.coordinateFrame !== 'display-cropbox'
        || !validGeometry(provenance.pdfGeometry, provenance.rotation)
        || render.mode !== 'pdf-region' || !render.range
        || !figure.panels.length || !figure.memberBlockIds.length) return null;
    const image = images.get(`${render.range.from}:${render.range.to}`);
    if (!image?.standalone || !sameAsset(image.assetPath, render.assetPath)
        || !completeCaptionRanges(render.captionRanges, image.captionRange)) return null;
    const members = new Set(figure.memberBlockIds);
    if (members.size !== figure.memberBlockIds.length
        || figure.memberBlockIds.some(id => !id)
        || provenance.fragments.some(fragment => !fragment.blockId || !members.has(fragment.blockId)
            || typeof fragment.markdown !== 'string')) return null;
    const panelIDs = new Set();
    for (const panel of figure.panels) {
        if (!members.has(panel.blockId) || panelIDs.has(panel.blockId)
            || !panel.bbox || !contains(visualBBox, panel.bbox)) return null;
        panelIDs.add(panel.blockId);
        const fragments = provenance.fragments.filter(fragment => (
            fragment.role === 'panel' && fragment.blockId === panel.blockId
            && sameBox(fragment.bbox, panel.bbox)
        ));
        if (fragments.length !== 1 || !panelImageMatches(fragments[0].markdown, panel.originalAssetPath)) {
            return null;
        }
    }
    // A role or label alone does not authorize dropping text. Require one
    // independent fragment covering exactly the caption box and all its text.
    const fragments = provenance.fragments.filter(fragment => (
        fragment.role === 'caption' && sameBox(fragment.bbox, captionBBox)
        && members.has(fragment.blockId) && !panelIDs.has(fragment.blockId)
    ));
    if (fragments.length !== 1) return null;
    const fragment = fragments[0];
    if (provenance.fragments.some(other => other !== fragment
        && other.bbox && overlaps(other.bbox, captionBBox))) return null;
    const rawCaption = whitespace(image.caption);
    if (!rawCaption || rawCaption !== whitespace(fragment.markdown)
        && rawCaption !== whitespace(escapeImageDescription(fragment.markdown))) return null;
    const text = visibleMarkdownTextForRanges(markdown, render.captionRanges).trim();
    if (!text || text.length > MAX_CAPTION_CHARACTERS) return null;
    return Object.freeze({
        text,
        pageIndex: figure.pageIndex,
        captionBBox: Object.freeze([...captionBBox]),
        visualBBox: Object.freeze([...visualBBox]),
        coordinateFrame: 'display-cropbox',
        rotation: provenance.rotation,
        pdfGeometry: freezeGeometry(provenance.pdfGeometry),
    });
}

function completeCaptionRanges(ranges, captionRange) {
    if (!ranges.length) return false;
    let end = captionRange.from;
    for (const range of ranges) {
        if (!range || range.from !== end || range.to <= range.from || range.to > captionRange.to) return false;
        end = range.to;
    }
    return end === captionRange.to;
}

function panelImageMatches(markdown, assetPath) {
    const images = collectFigureImageNodes(markdown);
    return images.length === 1 && images[0].standalone
        && !markdown.slice(0, images[0].from).trim()
        && !markdown.slice(images[0].to).trim()
        && sameAsset(images[0].assetPath, assetPath);
}

function sameAsset(left, right) {
    try {
        return normalizeFigureAssetPath(left) === normalizeFigureAssetPath(right);
    }
    catch {
        return false;
    }
}

function snapshotFigures(figures) {
    const budget = { captions: 0, total: 0 };
    const text = (value, limit = 1_024, caption = false) => {
        if (typeof value !== 'string') return null;
        budget.total += value.length;
        if (caption) budget.captions += value.length;
        if (value.length > limit || budget.total > MAX_PROOF_TEXT
            || budget.captions > MAX_CAPTION_TEXT) throw new Error('Caption evidence budget exceeded');
        return value;
    };
    const array = (value, limit) => {
        if (!Array.isArray(value)) return [];
        if (value.length > limit) throw new Error('Caption evidence count exceeded');
        return value;
    };
    return figures.map(figure => {
        const provenance = figure?.provenance;
        const render = figure?.render;
        const geometry = provenance?.pdfGeometry;
        return {
            pageIndex: finiteNumber(figure?.pageIndex),
            captionPageIndex: figure?.captionPageIndex === undefined
                ? finiteNumber(figure?.pageIndex) : finiteNumber(figure.captionPageIndex),
            visualBBox: copyBox(figure?.visualBBox),
            captionBBox: copyBox(figure?.captionBBox),
            memberBlockIds: array(figure?.memberBlockIds, MAX_FRAGMENTS).map(id => text(id, 256)),
            panels: array(figure?.panels, MAX_PANELS).map(panel => ({
                blockId: text(panel?.blockId, 256), bbox: copyBox(panel?.bbox),
                originalAssetPath: text(panel?.originalAssetPath),
            })),
            provenance: {
                coordinateFrame: text(provenance?.coordinateFrame, 64),
                rotation: finiteNumber(provenance?.rotation),
                pdfGeometry: geometry ? {
                    width: finiteNumber(geometry.width), height: finiteNumber(geometry.height),
                    rotation: finiteNumber(geometry.rotation), userUnit: finiteNumber(geometry.userUnit),
                    viewBox: copyNumbers(geometry.viewBox, 4),
                    mediaBox: geometry.mediaBox == null ? null : copyNumbers(geometry.mediaBox, 4),
                    viewportTransform: copyNumbers(geometry.viewportTransform, 6),
                } : null,
                fragments: array(provenance?.fragments, MAX_FRAGMENTS).map(fragment => ({
                    blockId: text(fragment?.blockId, 256), role: text(fragment?.role, 64),
                    bbox: copyBox(fragment?.bbox),
                    markdown: text(fragment?.markdown,
                        fragment?.role === 'caption' ? MAX_CAPTION_CHARACTERS : MAX_CAPTION_TEXT,
                        fragment?.role === 'caption'),
                })),
            },
            render: {
                mode: text(render?.mode, 64), assetPath: text(render?.assetPath),
                range: copyRange(render?.range),
                captionRanges: array(render?.captionRanges, MAX_FRAGMENTS).map(copyRange),
            },
        };
    });
}

function copyRange(range) {
    return Number.isSafeInteger(range?.from) && Number.isSafeInteger(range?.to)
        && range.from >= 0 && range.to > range.from ? { from: range.from, to: range.to } : null;
}

function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function copyNumbers(value, length) {
    return Array.isArray(value) && value.length === length && value.every(Number.isFinite)
        ? [...value] : null;
}

function copyBox(value) {
    const box = copyNumbers(value, 4);
    return box && box[0] >= 0 && box[1] >= 0 && box[2] <= 1_000 && box[3] <= 1_000
        && box[2] > box[0] && box[3] > box[1] ? box : null;
}

function contains(outer, inner) {
    return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}

function sameBox(left, right) {
    return left && right && left.every((value, index) => value === right[index]);
}

function overlaps(left, right) {
    return left[0] < right[2] && left[2] > right[0] && left[1] < right[3] && left[3] > right[1];
}

function validGeometry(geometry, rotation) {
    if (!geometry || ![0, 90, 180, 270].includes(rotation) || geometry.rotation !== rotation
        || !(geometry.width > 0 && geometry.height > 0 && geometry.userUnit > 0)
        || !geometry.viewBox || !geometry.viewportTransform) return false;
    const box = geometry.viewBox;
    const transform = geometry.viewportTransform;
    const width = (rotation % 180 ? box[3] - box[1] : box[2] - box[0]) * geometry.userUnit;
    const height = (rotation % 180 ? box[2] - box[0] : box[3] - box[1]) * geometry.userUnit;
    const [x0, y0, x1, y1] = box;
    const scale = geometry.userUnit;
    const expected = {
        0: [scale, 0, 0, -scale, -x0 * scale, y1 * scale],
        90: [0, scale, scale, 0, -y0 * scale, -x0 * scale],
        180: [-scale, 0, 0, scale, x1 * scale, -y0 * scale],
        270: [0, -scale, -scale, 0, y1 * scale, x1 * scale],
    };
    const close = (left, right) => Math.abs(left - right) <= 1e-6 * Math.max(1, Math.abs(right));
    return box[2] > box[0] && box[3] > box[1]
        && close(geometry.width, width) && close(geometry.height, height)
        && expected[rotation].every((value, index) => close(transform[index], value));
}

function freezeGeometry(geometry) {
    return Object.freeze({
        ...geometry,
        viewBox: Object.freeze([...geometry.viewBox]),
        mediaBox: geometry.mediaBox ? Object.freeze([...geometry.mediaBox]) : null,
        viewportTransform: Object.freeze([...geometry.viewportTransform]),
    });
}

function whitespace(text) {
    return String(text || '').replace(/\s+/gu, ' ').trim();
}
