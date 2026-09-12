import { FIGURE_LIMITS } from './figure-limits.js';
import {
    assertFigureJSONBudget, collectFigureImageNodes, normalizeFigureAssetDestination,
    normalizeFigureAssetPath,
    validateFigureCrop, validateFigureInput,
} from './figure-model.js';
import { escapeImageDescription } from '../markdown/markdown-figures.js';

export function composeFigureDraft(input, completed, { limits: overrides } = {}) {
    const limits = { ...FIGURE_LIMITS, ...overrides };
    validateFigureInput(input);
    const blocksByID = new Map(input.blocks.map(block => [block.id, block]));
    const pagesByIndex = new Map(input.pages.map(page => [page.pageIndex, page]));
    const paths = new Set(input.assets.map(asset => normalizeFigureAssetPath(asset.path)));
    const preserved = [];
    const plans = [];
    const images = collectFigureImageNodes(input.markdown);
    let generatedBytes = 0;
    const originalBytes = input.assets.reduce((total, asset) => total + asset.data.byteLength, 0);
    for (const entry of completed) {
        const candidate = entry.candidate;
        try {
            const plan = createPlan(input, entry, blocksByID, pagesByIndex, images, limits);
            if (paths.has(plan.asset.path)) throw transactionError('ambiguous-source-range');
            if (input.assets.length + plans.length + 1 > limits.maxAssets
                || originalBytes + generatedBytes + plan.asset.data.byteLength > limits.maxTotalAssetBytes
                || generatedBytes + plan.asset.data.byteLength > limits.maxGeneratedBytes
                || plans.length >= limits.maxFigures) throw transactionError('resource-limit');
            assertFigureJSONBudget({ blueprints: [...plans.map(value => value.blueprint), plan.blueprint] }, {
                maxBytes: Math.max(0, limits.maxMapBytes - (plans.length + 1) * 512),
            });
            paths.add(plan.asset.path);
            generatedBytes += plan.asset.data.byteLength;
            plans.push(plan);
        }
        catch (error) {
            preserved.push({ id: candidate.id, pageIndex: candidate.pageIndex,
                reason: error.preserveReason || (error.code === 'FIGURE_RESOURCE_LIMIT'
                    ? 'resource-limit' : 'render-failed') });
        }
    }
    const consumedRanges = plans.flatMap(plan => plan.edits.map(edit => ({ ...edit, plan })))
        .sort((left, right) => left.from - right.from || right.to - left.to);
    const conflicts = new Set();
    let furthest = null;
    for (const range of consumedRanges) {
        if (furthest && range.from < furthest.to) {
            conflicts.add(range.plan);
            conflicts.add(furthest.plan);
        }
        if (!furthest || range.to > furthest.to) furthest = range;
    }
    for (const plan of conflicts) preserved.push({ id: plan.blueprint.id,
        pageIndex: plan.blueprint.pageIndex, reason: 'ambiguous-source-range' });
    const accepted = plans.filter(plan => !conflicts.has(plan));
    if (!accepted.length) return { input, blueprints: [], preserved };
    const edits = accepted.flatMap(plan => plan.edits).sort((left, right) => left.from - right.from);
    const parts = [];
    let offset = 0;
    for (const edit of edits) {
        parts.push(input.markdown.slice(offset, edit.from), edit.replacement);
        offset = edit.to;
    }
    parts.push(input.markdown.slice(offset));
    const markdown = parts.join('');
    const consumedIDs = new Set(accepted.flatMap(plan => plan.blueprint.memberBlockIds));
    const blocks = input.blocks.filter(block => !consumedIDs.has(block.id)).map(block => ({
        ...block,
        sourceRanges: (block.sourceRanges || []).map(range => ({
            from: mapPoint(range.from, edits, -1), to: mapPoint(range.to, edits, 1),
        })),
    }));
    for (const plan of accepted) {
        const from = mapPoint(plan.anchor.from, edits, -1);
        blocks.push({ ...plan.block, sourceRanges: [{ from, to: from + plan.replacement.length }] });
    }
    const pages = input.pages.map(page => ({
        ...page,
        markdownRange: page.markdownRange ? {
            from: mapPoint(page.markdownRange.from, edits, -1),
            to: mapPoint(page.markdownRange.to, edits, 1),
        } : null,
    }));
    return {
        input: {
            ...input, markdown, blocks, pages,
            assets: [...input.assets, ...accepted.map(plan => plan.asset)],
            contentList: blocks.filter(block => block.bboxKind !== 'group').map(contentRecord),
        },
        blueprints: accepted.map(plan => plan.blueprint), preserved,
    };
}

function createPlan(input, { candidate, crop, assetPath }, blocksByID, pagesByIndex, images, limits) {
    if (candidate.decision !== 'compose') throw transactionError('ambiguous-membership');
    validateFigureCrop(crop, limits);
    const destination = normalizeFigureAssetDestination(assetPath, input.assetBasePath);
    const path = normalizeFigureAssetPath(destination, input.assetBasePath);
    const ids = [...candidate.panelBlockIds, ...candidate.ownedTextBlockIds, ...candidate.captionBlockIds];
    if (new Set(ids).size !== ids.length || !candidate.panelBlockIds.length) {
        throw transactionError('ambiguous-membership');
    }
    const members = ids.map(id => blocksByID.get(id));
    for (const block of members) {
        if (!block || block.pageIndex !== candidate.pageIndex
            || !block.sourceRanges?.length || block.rangeEvidence === 'unresolved') {
            throw transactionError('ambiguous-source-range');
        }
        if (block.role !== 'caption' && (!contains(candidate.visualBBox, block.bbox)
            || ['body'].includes(block.role) || ['table', 'code', 'heading', 'equation'].includes(block.type))) {
            throw transactionError('foreign-content-overlap');
        }
        if (candidate.panelBlockIds.includes(block.id) && !images.some(image => (
            image.standalone && image.from === block.sourceRanges[0].from
            && image.to === block.sourceRanges[0].to
            && normalizeFigureAssetPath(image.assetPath, input.assetBasePath)
                === normalizeFigureAssetPath(block.assetPath, input.assetBasePath)
        ))) throw transactionError('ambiguous-source-range');
    }
    const caption = members.find(block => candidate.captionBlockIds.includes(block.id));
    const captionText = caption ? caption.sourceRanges.map(range => (
        input.markdown.slice(range.from, range.to)
    )).join(' ').replace(/\s*\r?\n\s*/gu, ' ').trim() : '';
    if (captionText.length > limits.maxCaptionLength) throw transactionError('resource-limit');
    const renderCaption = escapeImageDescription(captionText);
    const replacement = `![${renderCaption}](${destination})`;
    const anchorBlock = caption || members.find(block => candidate.panelBlockIds.includes(block.id));
    const anchor = anchorBlock.sourceRanges[0];
    const fragments = members.flatMap(block => block.sourceRanges.map(range => ({
        from: range.from,
        blockId: block.id, role: block.role, bbox: block.bbox ? [...block.bbox] : null,
        markdown: input.markdown.slice(range.from, range.to),
    }))).sort((left, right) => left.from - right.from).map(({ from, ...fragment }) => fragment);
    if (fragments.some(fragment => fragment.markdown.length > limits.maxFragmentLength)) {
        throw transactionError('resource-limit');
    }
    const page = pagesByIndex.get(candidate.pageIndex);
    const panels = candidate.panelBlockIds.map(id => {
        const block = blocksByID.get(id);
        const labels = members.filter(member => candidate.ownedTextBlockIds.includes(member.id)
            && contains(block.bbox, member.bbox) && /^\(?[a-z]\)?[.]?$/iu.test(member.text?.trim() || ''));
        const label = labels.length === 1 ? labels[0].text.trim().replace(/[().]/gu, '').toLowerCase() : null;
        return { blockId: id, label: block.panelLabel || label,
            bbox: [...block.bbox], originalAssetPath: block.assetPath };
    });
    const blueprint = {
        id: candidate.id, label: candidate.label, pageIndex: candidate.pageIndex,
        visualBBox: [...candidate.visualBBox], captionBBox: candidate.captionBBox ? [...candidate.captionBBox] : null,
        memberBlockIds: ids, panels, renderAssetPath: destination, renderCaption,
        width: crop.width, height: crop.height,
        provenance: {
            coordinateFrame: page.coordinateFrame, rotation: page.rotation,
            evidence: [...candidate.evidence], fragments,
            ...(page.sourceGeometry ? { sourceGeometry: JSON.parse(JSON.stringify(page.sourceGeometry)) } : {}),
            ...(page.pdfGeometry ? { pdfGeometry: JSON.parse(JSON.stringify(page.pdfGeometry)) } : {}),
        },
    };
    return {
        blueprint, anchor, replacement,
        asset: { path, mimeType: 'image/png', data: crop.data },
        edits: members.flatMap(block => block.sourceRanges.map(range => {
            let to = range.to;
            if (range !== anchor) {
                while (to < input.markdown.length && /[ \t\r\n]/u.test(input.markdown[to])) to++;
            }
            return { from: range.from, to, replacement: range === anchor ? replacement : '' };
        })),
        block: {
            id: `${candidate.id}:composite`, sourceOrdinal: anchorBlock.sourceOrdinal,
            type: 'image', role: 'panel', bboxKind: 'visual-body',
            pageIndex: candidate.pageIndex, bbox: [...candidate.visualBBox],
            assetPath: destination, figureId: candidate.id, captionText,
            captionBBox: candidate.captionBBox ? [...candidate.captionBBox] : null,
            rangeEvidence: 'explicit-range',
        },
    };
}

function contentRecord(block) {
    return {
        type: block.type, pageIndex: block.pageIndex, bbox: block.bbox ? [...block.bbox] : null,
        ...(block.text ? { text: block.text } : {}),
        ...(block.assetPath ? { assetPath: block.assetPath } : {}),
        ...(block.figureId ? { figureId: block.figureId, captionText: block.captionText,
            captionBBox: block.captionBBox } : {}),
    };
}

function mapPoint(offset, edits, association) {
    let delta = 0;
    for (const edit of edits) {
        if (offset < edit.from || (offset === edit.from && association < 0)) break;
        if (offset < edit.to) return edit.from + delta + (association > 0 ? edit.replacement.length : 0);
        delta += edit.replacement.length - (edit.to - edit.from);
    }
    return offset + delta;
}

function contains(outer, inner) {
    return Array.isArray(outer) && Array.isArray(inner)
        && inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}

function transactionError(reason) {
    const error = new Error('Figure transaction could not preserve its source contract');
    error.preserveReason = reason;
    return error;
}
