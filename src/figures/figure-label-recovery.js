import { GFM, parser } from '@lezer/markdown';
import { isValidSourceMapEntry } from '../core/markdown-source-map.js';
import { mapChromeRanges } from '../markdown/chrome-ranges.js';
import { escapeImageDescription, parseAcademicFigureCaption, unescapeImageDescription } from '../markdown/markdown-figures.js';
import { FIGURE_LIMITS } from './figure-limits.js';
import { collectFigureImageNodes, normalizeFigureAssetPath, validateFigureCrop, validateFigureMap } from './figure-model.js';
import { mapFigureMapThroughEdits } from './figure-map-transforms.js';
import { finalizeFigureMap } from './figure-finalization.js';
import { createFigureAbortScope, throwIfFigureAborted, waitForFigureOperation } from './figure-async.js';

const MARKDOWN_PARSER = parser.configure(GFM);

export function normalizeFigurePanelLabel(value) {
    const text = String(value || '').normalize('NFKC').trim();
    const match = /^(?:\(([a-z])\)|([a-z])\.?)$/iu.exec(text);
    return match ? (match[1] || match[2]).toLowerCase() : null;
}

export function collectFigureLabelGroups(document) {
    const source = document?.markdown;
    if (document?.userEdited || typeof source !== 'string'
        || source.length > FIGURE_LIMITS.maxMarkdownBytes
        || !Array.isArray(document.assets) || document.assets.length > FIGURE_LIMITS.maxInputAssets
        || !Array.isArray(document.sourceMap)
        || document.sourceMap.length > FIGURE_LIMITS.maxLayoutBlocks
        || document.sourceMap.some(entry => !isValidSourceMapEntry(entry, source.length))
        || document.assets.some(asset => !asset || !ArrayBuffer.isView(asset.data)
            || asset.data.BYTES_PER_ELEMENT !== 1 || asset.data.byteLength > 25 * 1024 * 1024)) return [];
    const paragraphs = [];
    for (let node = MARKDOWN_PARSER.parse(source).topNode.firstChild; node; node = node.nextSibling) {
        if (node.name === 'Paragraph') paragraphs.push({ from: node.from, to: node.to });
        if (paragraphs.length > FIGURE_LIMITS.maxLayoutBlocks) return [];
    }
    const nodes = collectFigureImageNodes(source);
    if (nodes.length > FIGURE_LIMITS.maxInputAssets) return [];
    const assets = new Map();
    try {
        for (const asset of document.assets) {
            const path = normalizeFigureAssetPath(asset.path);
            if (assets.has(path)) return [];
            assets.set(path, asset);
        }
    }
    catch { return []; }
    const paths = new Map();
    const counts = new Map();
    for (const node of nodes) {
        try {
            const path = normalizeFigureAssetPath(node.assetPath, document.assetBasePath);
            paths.set(node, path);
            counts.set(path, (counts.get(path) || 0) + 1);
        }
        catch { /* Unsupported paths cannot provide local image evidence. */ }
    }
    const groups = [];
    let pending = [];
    let paragraphIndex = 0;
    let comparisons = 0;
    for (const node of nodes) {
        const start = Math.max(0, node.from - 256);
        const before = source.slice(start, node.from);
        const labelMatch = /(?:^|\n)( {0,3}[^\r\n]+)\r?\n(?:[ \t]*\r?\n)*[ \t]*$/u.exec(before);
        const rawLabel = labelMatch?.[1]?.trim();
        const label = normalizeFigurePanelLabel(rawLabel);
        const labelFrom = labelMatch ? start + labelMatch.index + (labelMatch[0].startsWith('\n') ? 1 : 0) : -1;
        while (paragraphs[paragraphIndex]?.to < labelFrom) paragraphIndex++;
        const containing = paragraphs[paragraphIndex];
        const paragraph = containing?.from <= labelFrom && containing.to >= labelFrom + rawLabel?.length
            ? containing : null;
        const ownLine = /^[ \t]*(?:\r?\n|$)/u.test(source.slice(node.to));
        const adjacent = pending.length && /^\s*$/u.test(source.slice(pending.at(-1).to, labelFrom));
        if (!adjacent) pending = [];
        if (!label || !paragraph || !ownLine
            || (!pending.length && paragraph.from !== labelFrom)
            || counts.get(paths.get(node)) !== 1) {
            pending = [];
            continue;
        }
        const asset = assets.get(paths.get(node));
        comparisons += document.sourceMap.length;
        if (comparisons > FIGURE_LIMITS.maxComparisons) return [];
        const mappings = document.sourceMap.filter(entry => isValidSourceMapEntry(entry, source.length)
            && ['image', 'chart'].includes(entry.type)
            && entry.markdownFrom <= node.from && entry.markdownTo >= node.to);
        if (!asset || !ArrayBuffer.isView(asset.data) || asset.data.BYTES_PER_ELEMENT !== 1
            || mappings.length !== 1 || mappings[0].locations.length !== 1) {
            pending = [];
            continue;
        }
        const location = mappings[0].locations[0];
        if (pending.some(panel => panel.label === label || panel.pageIndex !== location.pageIndex)) {
            pending = [];
            continue;
        }
        pending.push({ ...node, label, rawLabel, labelFrom, asset,
            pageIndex: location.pageIndex, bbox: [...location.bbox] });
        let caption = parseAcademicFigureCaption(unescapeImageDescription(node.caption));
        let to = node.to;
        if (!caption && !node.caption.trim()) {
            const next = /^[ \t]*\r?\n(?:[ \t]*\r?\n)?([^\r\n]+)/u.exec(source.slice(to));
            caption = next && parseAcademicFigureCaption(next[1]);
            if (caption) to += next[0].length;
        }
        if (!caption) {
            if (node.caption.trim() || pending.length >= FIGURE_LIMITS.maxPanels) pending = [];
            continue;
        }
        if (pending.length >= 2) {
            const from = pending[0].labelFrom;
            const crossing = document.sourceMap.some(entry => entry.markdownFrom < to && entry.markdownTo > from
                && (entry.markdownFrom < from || entry.markdownTo > to));
            if (!crossing && to - from <= FIGURE_LIMITS.maxFragmentLength) {
                groups.push({ from, to, caption, pageIndex: location.pageIndex, panels: pending });
            }
        }
        pending = [];
        if (groups.length >= FIGURE_LIMITS.maxFigures) break;
    }
    return groups;
}

export class FigureLabelRecoveryService {
    constructor({ openPDF, hash, limits, ...abortOptions }) {
        if (typeof openPDF !== 'function' || typeof hash !== 'function') {
            throw new TypeError('Figure PDF rendering and hashing are required');
        }
        this.openPDF = openPDF;
        this.hash = hash;
        this.limits = { ...FIGURE_LIMITS, ...limits };
        this.abortOptions = abortOptions;
    }

    async recover(document, { fileData, signal, onProgress } = {}) {
        throwIfFigureAborted(signal);
        const groups = collectFigureLabelGroups(document);
        if (!groups.length) return document;
        const scope = createFigureAbortScope([signal], {
            ...this.abortOptions, timeoutMs: this.limits.documentTimeoutMs,
        });
        let session;
        const completed = [];
        let bytes = (document.assets || []).reduce((sum, asset) => sum + asset.data.byteLength, 0);
        let generated = 0;
        try {
            const opening = Promise.resolve(this.openPDF(fileData, { signal: scope.signal })).then(async value => {
                if (scope.signal.aborted) await value.close();
                throwIfFigureAborted(scope.signal);
                return value;
            });
            session = await waitForFigureOperation(opening, scope.signal);
            for (const group of groups) {
                throwIfFigureAborted(scope.signal);
                if (completed.length + document.assets.length >= this.limits.maxAssets) break;
                onProgress?.(97);
                const foreignLocations = document.sourceMap.filter(entry => entry.markdownTo <= group.from
                    || entry.markdownFrom >= group.to).flatMap(entry => entry.locations || [])
                    .filter(location => location.pageIndex === group.pageIndex);
                try {
                    const result = await waitForFigureOperation(session.recoverImageGroup({
                        pageIndex: group.pageIndex, caption: group.caption,
                        panels: group.panels.map(panel => ({ bbox: panel.bbox, label: panel.label, asset: panel.asset })),
                        foreignLocations,
                    }, { signal: scope.signal }), scope.signal);
                    if (!result) continue;
                    validateFigureCrop(result.crop, this.limits);
                    if (bytes + result.crop.data.byteLength > this.limits.maxTotalAssetBytes
                        || generated + result.crop.data.byteLength > this.limits.maxGeneratedBytes) break;
                    const digest = await waitForFigureOperation(this.hash(result.crop.data), scope.signal);
                    if (!/^[a-f0-9]{64}$/u.test(digest)) continue;
                    const id = `fig-p${group.pageIndex}-brecovered-${group.from}`;
                    const assetPath = `generated/figures/${id}-${digest.slice(0, 16)}.png`;
                    const resolvedPath = normalizeFigureAssetPath(assetPath, document.assetBasePath);
                    if (document.assets.some(asset => normalizeFigureAssetPath(asset.path) === resolvedPath)) continue;
                    completed.push({ group, result, id, assetPath });
                    bytes += result.crop.data.byteLength;
                    generated += result.crop.data.byteLength;
                }
                catch {
                    throwIfFigureAborted(scope.signal);
                }
            }
            throwIfFigureAborted(signal);
            return completed.length ? await applyRecoveries(document, completed, this.hash, signal) : document;
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

async function applyRecoveries(document, completed, hash, signal) {
    const edits = completed.map(({ group, assetPath }) => ({
        from: group.from, to: group.to,
        replacement: `![${escapeImageDescription(group.caption.text)}](${assetPath})`,
    }));
    let markdown = '';
    let from = 0;
    for (const edit of edits) {
        markdown += document.markdown.slice(from, edit.from) + edit.replacement;
        from = edit.to;
    }
    markdown += document.markdown.slice(from);
    const transforms = edits.map(edit => ({ ...edit, replacementLength: edit.replacement.length }));
    const offset = value => value + edits.filter(edit => edit.to <= value)
        .reduce((sum, edit) => sum + edit.replacement.length - (edit.to - edit.from), 0);
    const sourceMap = document.sourceMap.filter(entry => !edits.some(edit => (
        entry.markdownFrom < edit.to && entry.markdownTo > edit.from
    ))).map(entry => ({ ...entry, markdownFrom: offset(entry.markdownFrom), markdownTo: offset(entry.markdownTo),
        ...(entry.locationRanges ? { locationRanges: entry.locationRanges.map(range => ({
            ...range, markdownFrom: offset(range.markdownFrom), markdownTo: offset(range.markdownTo),
        })) } : {}) }));
    const blueprints = completed.map(({ group, result, id, assetPath }) => {
        const panels = group.panels.map((panel, index) => ({ blockId: `${id}:panel-${index}`,
            label: panel.label, bbox: panel.bbox.map((value, axis) => axis < 2
                ? Math.max(value, result.bbox[axis]) : Math.min(value, result.bbox[axis])),
            originalAssetPath: panel.assetPath }));
        return { id, label: group.caption.label, pageIndex: group.pageIndex,
            visualBBox: [...result.bbox], captionBBox: result.captionBBox ? [...result.captionBBox] : null,
            panels, memberBlockIds: [id, ...panels.map(panel => panel.blockId)],
            renderAssetPath: assetPath, renderCaption: escapeImageDescription(group.caption.text),
            width: result.crop.width, height: result.crop.height,
            provenance: { coordinateFrame: 'display-cropbox', rotation: result.rotation,
                evidence: ['pdf-image-container', 'separate-pdf-caption', 'verified-panel-pixels'],
                fragments: [{ blockId: id, role: 'figure-text', bbox: [...result.bbox],
                    markdown: document.markdown.slice(group.from, group.to) }] } };
    });
    const assets = [...document.assets, ...completed.map(({ result, assetPath }) => ({
        path: normalizeFigureAssetPath(assetPath, document.assetBasePath),
        data: result.crop.data, mimeType: 'image/png',
    }))];
    const prepared = { ...document, markdown, sourceMap, assets,
        chromeRanges: mapChromeRanges(document.chromeRanges, transforms, markdown.length) };
    const result = await finalizeFigureMap(prepared, blueprints, {
        hash, signal, preserved: document.figureMap?.preserved || [],
    });
    if (document.figureMap) {
        const previous = mapFigureMapThroughEdits(document.figureMap, transforms, markdown);
        result.figureMap.figures.push(...previous.figures);
        result.figureMap.figures.sort((a, b) => a.render.range.from - b.render.range.from);
    }
    validateFigureMap(result.figureMap, result);
    return result;
}
