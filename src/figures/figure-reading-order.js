import { GFM, parser } from '@lezer/markdown';
import { isValidSourceMapEntry, isValidNormalizedSourceBBox } from '../core/markdown-source-map.js';
import { normalizeFigureLayouts } from '../markdown/figure-layout-normalizer.js';
import { findAcademicFigures, parseAcademicFigureCaption, parseFigureLayoutMarker, unescapeImageDescription } from '../markdown/markdown-figures.js';
import { mapChromeRanges } from '../markdown/chrome-ranges.js';
import { collectFigureImageNodes, normalizeFigureAssetPath, validateFigureMap } from './figure-model.js';
import { mapFigureMapThroughEdits } from './figure-map-transforms.js';
import { FIGURE_LIMITS } from './figure-limits.js';
import { createFigureAbortScope, throwIfFigureAborted, waitForFigureOperation } from './figure-async.js';

const MARKDOWN_PARSER = parser.configure(GFM);
const MAX_TITLE_LENGTH = 512;

export function collectFigureReadingOrderGroups(document, limits = FIGURE_LIMITS) {
    const source = document?.markdown;
    if (document?.userEdited || typeof source !== 'string' || source.length > limits.maxMarkdownBytes
        || !Array.isArray(document.sourceMap) || document.sourceMap.length > limits.maxLayoutBlocks
        || document.sourceMap.some(entry => !isValidSourceMapEntry(entry, source.length))
        || !Array.isArray(document.assets) || document.assets.length > limits.maxInputAssets) return [];
    try { if (document.figureMap) validateFigureMap(document.figureMap, document); }
    catch { return []; }
    const images = collectFigureImageNodes(source);
    if (images.length > limits.maxInputAssets) return [];
    const assets = new Map();
    const paths = new Map();
    const counts = new Map();
    try {
        for (const asset of document.assets) {
            const path = normalizeFigureAssetPath(asset?.path);
            if (assets.has(path) || !ArrayBuffer.isView(asset.data) || asset.data.BYTES_PER_ELEMENT !== 1
                || asset.data.byteLength > 25 * 1024 * 1024) return [];
            assets.set(path, asset);
        }
        for (const image of images) {
            try {
                const path = normalizeFigureAssetPath(image.assetPath, document.assetBasePath);
                paths.set(image, path);
                counts.set(path, (counts.get(path) || 0) + 1);
            }
            catch { /* Nonlocal images cannot establish a figure's source. */ }
        }
    }
    catch { return []; }
    let comparisons = 0;
    const groups = [];
    let panels = [];
    let title = null;
    let markers = 0;
    const reset = () => { panels = []; title = null; markers = 0; };
    const finish = caption => {
        if (title && panels.length > 1 && panels.at(-1).from > title.to
            && panels.every(panel => panel.pageIndex === panels[0].pageIndex)) {
            const from = panels[0].from;
            const to = caption.to;
            const pieces = [...panels, title, ...(caption.embedded ? [] : [caption])];
            const pageIndex = panels[0].pageIndex;
            // Source maps may assign a whole image-and-caption paragraph to the image.
            const combinedMapping = !caption.embedded && caption.paragraphFrom === panels.at(-1).from
                ? document.sourceMap.find(entry => ['image', 'chart'].includes(entry.type)
                    && entry.markdownFrom === panels.at(-1).from && entry.markdownTo === caption.to
                    && !entry.locationRanges?.length) : null;
            const conflict = document.sourceMap.some(entry => entry.markdownFrom < to && entry.markdownTo > from
                && (entry !== combinedMapping
                    && !pieces.some(piece => entry.markdownFrom >= piece.from && entry.markdownTo <= piece.to)
                    || entry.locations.some(location => location.pageIndex !== pageIndex)));
            const restored = document.figureMap?.figures?.some(figure => (
                figure.render.range.from < to && figure.render.range.to > from
            ));
            const hidden = Array.isArray(document.chromeRanges)
                && document.chromeRanges.some(range => range?.from < to && range?.to > from);
            if (!conflict && !restored && !hidden && to - from <= limits.maxFragmentLength) {
                groups.push({ from, to, title, caption, panels, pageIndex, combinedMapping });
            }
        }
        reset();
    };
    for (const token of figureTokens(source, images, limits)) {
        if (token.kind === 'image') {
            comparisons += document.sourceMap.length;
            if (comparisons > limits.maxComparisons) return [];
            const image = token.image;
            const path = paths.get(image);
            const mappings = document.sourceMap.filter(entry => ['image', 'chart'].includes(entry.type)
                && entry.markdownFrom <= image.from && entry.markdownTo >= image.to);
            const asset = assets.get(path);
            if (counts.get(path) !== 1 || !asset || mappings.length !== 1
                || mappings[0].locations.length !== 1 || panels.length >= limits.maxPanels) {
                reset();
                continue;
            }
            const caption = parseAcademicFigureCaption(unescapeImageDescription(image.caption));
            if (image.caption.trim() && !caption) { reset(); continue; }
            const location = mappings[0].locations[0];
            panels.push({ ...image, asset, bbox: [...location.bbox], pageIndex: location.pageIndex });
            if (caption) finish({ ...caption, from: image.captionRange.from, to: image.to, embedded: true });
        }
        else if (token.kind === 'caption') finish(token);
        else if (token.kind === 'title' && panels.length && !title) title = token;
        else if (token.kind === 'marker' && panels.length && ++markers === 1) continue;
        else reset();
        if (groups.length >= limits.maxFigures) break;
    }
    return groups;
}

function figureTokens(source, images, limits) {
    const tokens = [];
    let imageIndex = 0;
    let nodes = 0;
    for (let node = MARKDOWN_PARSER.parse(source).topNode.firstChild; node; node = node.nextSibling) {
        if (++nodes > limits.maxLayoutBlocks) return [];
        if (node.name === 'CommentBlock' && parseFigureLayoutMarker(source.slice(node.from, node.to))) {
            tokens.push({ kind: 'marker', from: node.from, to: node.to });
            continue;
        }
        if (node.name !== 'Paragraph' && !/^ATXHeading[1-6]$/u.test(node.name)) {
            tokens.push({ kind: 'boundary' });
            continue;
        }
        while (images[imageIndex]?.from < node.from) imageIndex++;
        let cursor = node.from;
        const parts = [];
        while (images[imageIndex]?.from < node.to) {
            const image = images[imageIndex++];
            if (source.slice(cursor, image.from).trim()
                || !/^[ \t]*(?:\r?\n|$)/u.test(source.slice(image.to, node.to + 1))) {
                parts.push({ kind: 'boundary' });
                cursor = node.to;
                break;
            }
            parts.push({ kind: 'image', image });
            cursor = image.to;
        }
        while (cursor < node.to && /\s/u.test(source[cursor])) cursor++;
        if (cursor < node.to) {
            const raw = source.slice(cursor, node.to);
            const caption = parseAcademicFigureCaption(raw);
            if (caption) parts.push({ kind: 'caption', ...caption, from: cursor, to: node.to,
                paragraphFrom: node.from });
            else {
                const plain = !node.firstChild || /^ATXHeading[1-6]$/u.test(node.name)
                    && node.firstChild.name === 'HeaderMark' && !node.firstChild.nextSibling;
                const text = raw.replace(/^#{1,6}[ \t]+/u, '').replace(/[ \t]+#+[ \t]*$/u, '').trim();
                parts.push(plain && !parts.length && text.length >= 8 && text.length <= MAX_TITLE_LENGTH
                    ? { kind: 'title', from: cursor, to: node.to, text } : { kind: 'boundary' });
            }
        }
        tokens.push(...parts);
    }
    return tokens;
}

export class FigureReadingOrderService {
    constructor({ openPDF, hash, limits, ...abortOptions }) {
        if (typeof openPDF !== 'function' || typeof hash !== 'function') {
            throw new TypeError('PDF verification and hashing are required');
        }
        this.openPDF = openPDF;
        this.hash = hash;
        this.limits = { ...FIGURE_LIMITS, ...limits };
        this.abortOptions = abortOptions;
    }

    async recover(document, { fileData, signal, onProgress } = {}) {
        throwIfFigureAborted(signal);
        const groups = collectFigureReadingOrderGroups(document, this.limits);
        if (!groups.length) return document;
        const scope = createFigureAbortScope([signal], { ...this.abortOptions, timeoutMs: this.limits.documentTimeoutMs });
        let session;
        try {
            const opening = Promise.resolve(this.openPDF(fileData, { signal: scope.signal })).then(async value => {
                if (scope.signal.aborted) await value.close();
                throwIfFigureAborted(scope.signal);
                return value;
            });
            session = await waitForFigureOperation(opening, scope.signal);
            const edits = [];
            for (const group of groups) {
                throwIfFigureAborted(scope.signal);
                onProgress?.(98);
                try {
                    const evidence = await waitForFigureOperation(session.verifyFigureOrder({
                        pageIndex: group.pageIndex, title: group.title.text, caption: group.caption,
                        panels: group.panels.map(panel => ({ bbox: panel.bbox, asset: panel.asset })),
                        foreignLocations: document.sourceMap.filter(entry => entry.markdownTo <= group.from
                            || entry.markdownFrom >= group.to).flatMap(entry => entry.locations)
                            .filter(location => location.pageIndex === group.pageIndex),
                    }, { signal: scope.signal }), scope.signal);
                    if (!validEvidence(evidence)) continue;
                    edits.push(reorderedGroup(document.markdown, group, evidence));
                }
                catch { throwIfFigureAborted(scope.signal); }
            }
            throwIfFigureAborted(scope.signal);
            return edits.length ? await applyReadingOrder(document, edits, this.hash, scope.signal) : document;
        }
        catch {
            throwIfFigureAborted(signal);
            return document;
        }
        finally {
            if (session) await session.close().catch(() => {});
            scope.dispose();
        }
    }
}

function reorderedGroup(source, group, evidence) {
    const ending = source.includes('\r\n') ? '\r\n' : '\n';
    const separator = ending + ending;
    const title = source.slice(group.title.from, group.title.to);
    const caption = group.caption.embedded ? '' : source.slice(group.caption.from, group.caption.to);
    const images = group.panels.map(panel => source.slice(panel.from, panel.to)).join(separator);
    const replacement = title + separator + normalizeFigureLayouts(images + (caption ? separator + caption : ''),
        group.panels.map(panel => ({ assetPath: panel.assetPath, pageIndex: group.pageIndex, bbox: panel.bbox })));
    const reordered = collectFigureImageNodes(replacement);
    const figures = findAcademicFigures(replacement);
    if (figures.length !== 1 || figures[0].images.length !== group.panels.length) {
        throw new Error('Figure membership changed while reordering');
    }
    const pieces = group.panels.map(panel => {
        const matches = reordered.filter(image => image.assetPath === panel.assetPath);
        if (matches.length !== 1 || source.slice(panel.from, panel.to) !== replacement.slice(matches[0].from, matches[0].to)) {
            throw new Error('Figure image changed while reordering');
        }
        return { from: panel.from, to: panel.to, target: matches[0].from };
    });
    pieces.push({ from: group.title.from, to: group.title.to, target: 0 });
    if (caption) pieces.push({ from: group.caption.from, to: group.caption.to, target: replacement.length - caption.length });
    return { from: group.from, to: group.to, replacement, pieces, group, evidence,
        replacementLength: replacement.length };
}

async function applyReadingOrder(document, edits, hash, signal) {
    let markdown = '';
    let cursor = 0;
    for (const edit of edits) {
        markdown += document.markdown.slice(cursor, edit.from);
        edit.target = markdown.length;
        markdown += edit.replacement;
        cursor = edit.to;
    }
    markdown += document.markdown.slice(cursor);
    const outsideOffset = value => value + edits.filter(edit => edit.to <= value)
        .reduce((sum, edit) => sum + edit.replacementLength - (edit.to - edit.from), 0);
    const sourceMap = document.sourceMap.map(entry => {
        const edit = edits.find(edit => entry.markdownFrom < edit.to && entry.markdownTo > edit.from);
        if (entry === edit?.group.combinedMapping) entry = { ...entry, markdownTo: edit.group.panels.at(-1).to };
        const piece = edit?.pieces.find(piece => entry.markdownFrom >= piece.from && entry.markdownTo <= piece.to);
        const delta = edit ? edit.target + piece.target - piece.from : outsideOffset(entry.markdownFrom) - entry.markdownFrom;
        return { ...entry, markdownFrom: entry.markdownFrom + delta, markdownTo: entry.markdownTo + delta,
            ...(entry.locationRanges ? { locationRanges: entry.locationRanges.map(range => ({
                ...range, markdownFrom: range.markdownFrom + delta, markdownTo: range.markdownTo + delta,
            })) } : {}) };
    });
    for (const edit of edits) {
        const targets = [{ from: edit.target, to: edit.target + edit.group.title.to - edit.group.title.from,
            bbox: edit.evidence.titleBBox }];
        if (!edit.group.caption.embedded) {
            targets.push({ from: edit.target + edit.pieces.at(-1).target, to: edit.target + edit.replacementLength,
                bbox: edit.evidence.captionBBox });
        }
        for (const target of targets) {
            if (sourceMap.some(entry => entry.markdownFrom < target.to && entry.markdownTo > target.from)) continue;
            sourceMap.push({ type: 'text', markdownFrom: target.from, markdownTo: target.to,
                locations: [{ pageIndex: edit.group.pageIndex, bbox: [...target.bbox] }] });
        }
    }
    sourceMap.sort((a, b) => a.markdownFrom - b.markdownFrom);
    if (sourceMap.some(entry => !isValidSourceMapEntry(entry, markdown.length))) throw new Error('Figure source map is invalid');
    const figureMap = mapFigureMapThroughEdits(document.figureMap, edits, markdown);
    const result = { ...document, markdown, sourceMap,
        chromeRanges: mapChromeRanges(document.chromeRanges, edits, markdown.length), figureMap };
    if (figureMap || document.markdownHash) {
        const digest = await waitForFigureOperation(hash(new TextEncoder().encode(markdown)), signal);
        if (figureMap) figureMap.markdownHash = digest;
        if (document.markdownHash) result.markdownHash = digest;
    }
    if (figureMap) validateFigureMap(figureMap, result);
    throwIfFigureAborted(signal);
    return result;
}

function validEvidence(value) {
    return [value?.titleBBox, value?.captionBBox].every(box => isValidNormalizedSourceBBox(box)
        && box[0] < box[2] && box[1] < box[3]);
}
