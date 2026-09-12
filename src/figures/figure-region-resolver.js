import { FIGURE_LIMITS } from './figure-limits.js';
import { isValidNormalizedSourceBBox } from '../core/markdown-source-map.js';
import { parseAcademicFigureCaption } from '../markdown/markdown-figures.js';

const FOREIGN_TYPES = new Set(['heading', 'title', 'table', 'equation', 'formula', 'code', 'reference']);

export function resolveFigureCandidates(input, { limits: overrides, budget: sharedBudget } = {}) {
    const limits = { ...FIGURE_LIMITS, ...overrides };
    const budget = sharedBudget || { remaining: limits.maxComparisons };
    const pageBlocks = new Map();
    const pageInfo = new Map(input.pages.map(page => [page.pageIndex, page]));
    for (const block of input.blocks) {
        if (!pageBlocks.has(block.pageIndex)) pageBlocks.set(block.pageIndex, []);
        pageBlocks.get(block.pageIndex).push(block);
    }
    const output = [];
    for (const [pageIndex, blocks] of [...pageBlocks].sort(([a], [b]) => a - b)) {
        blocks.sort((a, b) => a.sourceOrdinal - b.sourceOrdinal || a.id.localeCompare(b.id));
        const panels = blocks.filter(isPanel);
        if (!panels.length) continue;
        if (output.length >= limits.maxFigures) break;
        if (budget.remaining <= 0) {
            output.push(preservedCandidate(panels[0], pageIndex, 'resource-limit'));
            break;
        }
        const groups = groupPanels(blocks, panels, limits, budget);
        const pageCandidates = [];
        for (const group of groups) {
            if (pageCandidates.length >= limits.maxFiguresPerPage
                || output.length + pageCandidates.length >= limits.maxFigures - 1) {
                pageCandidates.push(preservedCandidate(group.panels[0], pageIndex, 'resource-limit'));
                break;
            }
            pageCandidates.push(resolveGroup(group, blocks, pageInfo.get(pageIndex), limits, budget));
        }
        const owners = new Map();
        for (const candidate of pageCandidates) {
            for (const id of [...candidate.captionBlockIds, ...candidate.ownedTextBlockIds]) {
                const previous = owners.get(id);
                if (previous) {
                    preserve(previous, 'ambiguous-membership');
                    preserve(candidate, 'ambiguous-membership');
                }
                else owners.set(id, candidate);
            }
        }
        output.push(...pageCandidates);
    }
    if (budget.remaining < 0) {
        for (const candidate of output) preserve(candidate, 'resource-limit');
    }
    return output;
}

function groupPanels(blocks, panels, limits, budget) {
    const byID = new Map(blocks.map(block => [block.id, block]));
    const explicit = new Map();
    const remaining = [];
    for (const panel of panels) {
        const parent = byID.get(panel.parentId);
        if (parent?.bboxKind === 'group' && ['image', 'chart'].includes(parent.type)) {
            if (!explicit.has(parent.id)) explicit.set(parent.id, { panels: [], parent });
            explicit.get(parent.id).panels.push(panel);
        }
        else remaining.push(panel);
    }
    const groups = [...explicit.values()];
    const seen = new Set();
    for (const panel of remaining) {
        if (seen.has(panel.id)) continue;
        const members = [panel];
        seen.add(panel.id);
        for (let index = 0; index < members.length; index++) {
            for (const next of remaining) {
                if (seen.has(next.id)) continue;
                if (!consume(budget)) return [...groups, { panels: members, exhausted: true }];
                if (validBox(members[index].bbox) && validBox(next.bbox)
                    && adjacent(members[index].bbox, next.bbox, limits)) {
                    seen.add(next.id);
                    members.push(next);
                }
            }
        }
        groups.push({ panels: members, parent: null });
    }
    return groups;
}

function resolveGroup(group, blocks, page, limits, budget) {
    const { panels, parent } = group;
    const anchor = parent || panels[0];
    const candidate = {
        ...preservedCandidate(anchor, anchor.pageIndex, 'missing-geometry'),
        panelBlockIds: panels.map(block => block.id),
        evidence: [parent ? 'explicit-parent' : 'same-page-geometry'],
    };
    if (group.exhausted || panels.length > limits.maxPanels) return preserve(candidate, 'resource-limit');
    if (page?.geometryReason) return preserve(candidate, page.geometryReason);
    if (!page || page.coordinateFrame !== 'display-cropbox'
        || panels.some(panel => panel.bboxKind !== 'visual-body' || !validBox(panel.bbox))) {
        return candidate;
    }
    if (!Number.isSafeInteger(anchor.sourceOrdinal)
        || panels.some(panel => !Number.isSafeInteger(panel.sourceOrdinal))) {
        return preserve(candidate, 'ambiguous-membership');
    }
    const panelBox = union(panels.map(block => block.bbox));
    if (parent && (!validBox(parent.bbox) || !contains(parent.bbox, panelBox))) {
        return preserve(candidate, 'ambiguous-membership');
    }
    const captions = [];
    for (const block of blocks) {
        if (!consume(budget)) return preserve(candidate, 'resource-limit');
        if (block.role !== 'caption') continue;
        if (parent ? block.parentId === parent.id
            : validBox(block.bbox) && captionNear(block.bbox, panelBox, limits)) {
            captions.push(block);
        }
    }
    if (captions.length > 1 || (!captions.length && !parent)) {
        return preserve(candidate, 'ambiguous-caption');
    }
    const caption = captions[0];
    candidate.captionBlockIds = caption ? [caption.id] : [];
    candidate.captionBBox = caption?.bbox || null;
    candidate.label = parseAcademicFigureCaption(caption?.text)?.label || null;
    if (caption && !validBox(caption.bbox)) return candidate;
    if (caption && intersectionArea(panelBox, caption.bbox) > 0) {
        return preserve(candidate, 'caption-overlap');
    }
    const members = new Set(panels.map(block => block.id));
    if (caption) members.add(caption.id);
    if (parent) members.add(parent.id);
    const owned = [];
    for (const block of blocks) {
        if (!consume(budget)) return preserve(candidate, 'resource-limit');
        if (members.has(block.id) || block.bboxKind === 'group') continue;
        const explicitText = parent && block.parentId === parent.id && block.role === 'figure-text';
        if (explicitText && !validBox(block.bbox)) return candidate;
        if (!validBox(block.bbox)) {
            const ordinalMin = Math.min(...panels.map(panel => panel.sourceOrdinal), caption?.sourceOrdinal ?? Infinity);
            const ordinalMax = Math.max(...panels.map(panel => panel.sourceOrdinal), caption?.sourceOrdinal ?? -Infinity);
            if (block.text && block.sourceOrdinal >= ordinalMin && block.sourceOrdinal <= ordinalMax) return candidate;
            continue;
        }
        if (explicitText && !contains(parent.bbox, block.bbox)) {
            return preserve(candidate, 'ambiguous-membership');
        }
        if (block.role === 'body' || FOREIGN_TYPES.has(block.type) || block.role === 'caption' || isPanel(block)) {
            continue;
        }
        if (explicitText || (block.type === 'text' && (
            panels.some(panel => consume(budget)
                && intersectionArea(panel.bbox, block.bbox) / area(block.bbox) >= limits.interiorTextRatio)
            || (contains(panelBox, block.bbox) && looksLikeGapLabel(block.text, limits))
        ))) {
            owned.push(block);
            members.add(block.id);
        }
    }
    const visualBox = union([...panels, ...owned].map(block => block.bbox));
    let paddedBox = padded(visualBox, limits.padding);
    for (const block of blocks) {
        if (!consume(budget)) return preserve(candidate, 'resource-limit');
        if (members.has(block.id) && block.id !== caption?.id) continue;
        if (block.bboxKind === 'group' || !validBox(block.bbox)) continue;
        if (intersectionArea(visualBox, block.bbox) > 0) {
            return preserve(candidate, block.role === 'caption' ? 'caption-overlap' : 'foreign-content-overlap');
        }
        if (intersectionArea(paddedBox, block.bbox) > 0) paddedBox = [...visualBox];
    }
    for (const block of [...panels, ...owned, ...captions]) {
        if (!block.sourceRanges?.length || block.rangeEvidence === 'unresolved') {
            return preserve(candidate, 'ambiguous-source-range');
        }
    }
    const ranges = [...panels, ...owned, ...captions].flatMap(block => block.sourceRanges)
        .sort((left, right) => left.from - right.from);
    if (ranges.some((range, index) => index > 0 && range.from < ranges[index - 1].to)) {
        return preserve(candidate, 'ambiguous-source-range');
    }
    candidate.ownedTextBlockIds = owned.map(block => block.id);
    candidate.visualBBox = paddedBox;
    candidate.evidence.push('exact-source-ranges');
    if (caption) candidate.evidence.push('separate-caption');
    candidate.decision = 'compose';
    candidate.reason = null;
    return candidate;
}

function preservedCandidate(anchor, pageIndex, reason) {
    return {
        id: `fig-p${pageIndex}-b${anchor.sourceOrdinal ?? 0}`,
        pageIndex, label: null, captionBlockIds: [], panelBlockIds: [anchor.id],
        ownedTextBlockIds: [], visualBBox: null, captionBBox: null, evidence: [],
        decision: 'preserve', reason,
    };
}

function preserve(candidate, reason) {
    candidate.decision = 'preserve';
    candidate.reason = reason;
    return candidate;
}

function isPanel(block) {
    return block.bboxKind !== 'group' && (block.role === 'panel'
        || ['image', 'chart'].includes(block.type));
}

function validBox(box) {
    return isValidNormalizedSourceBBox(box) && box[2] > box[0] && box[3] > box[1];
}

function adjacent(a, b, limits) {
    const maxGap = Math.min(limits.panelMaxGap, Math.max(limits.panelMinGap,
        limits.panelGapFactor * Math.min(a[2] - a[0], a[3] - a[1], b[2] - b[0], b[3] - b[1])));
    return (overlap(a[0], a[2], b[0], b[2]) >= limits.panelProjectionOverlap
        && Math.max(0, Math.max(a[1], b[1]) - Math.min(a[3], b[3])) <= maxGap)
        || (overlap(a[1], a[3], b[1], b[3]) >= limits.panelProjectionOverlap
        && Math.max(0, Math.max(a[0], b[0]) - Math.min(a[2], b[2])) <= maxGap);
}

function captionNear(caption, box, limits) {
    const gap = caption[1] >= box[3] ? caption[1] - box[3] : box[1] - caption[3];
    return gap >= 0 && gap <= Math.min(limits.captionMaxGap,
        Math.max(limits.captionMinGap, limits.captionGapFactor * (box[3] - box[1])))
        && overlap(caption[0], caption[2], box[0], box[2]) >= limits.captionProjectionOverlap;
}

function looksLikeGapLabel(text, limits) {
    const value = String(text || '').trim();
    if (!value || [...value].length > limits.maxGapTextCodePoints
        || value.split(/\r?\n/u).length > limits.maxGapTextLines) return false;
    return /^\(?[a-z]\)?[.]?$/iu.test(value)
        || /^[\d\s.,+%()eE\-]+$/u.test(value)
        || /^(?:control|treatment|baseline|train(?:ing)?|test|validation|accuracy|loss|time|days?|seconds?|epochs?|probability|precision|recall|mean|median|count|frequency|value|intensity)(?:\s*\([^)]{1,60}\))?$/iu.test(value);
}

function overlap(a0, a1, b0, b1) {
    return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)) / Math.min(a1 - a0, b1 - b0);
}

function contains(a, b) {
    return a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3];
}

function area(box) { return (box[2] - box[0]) * (box[3] - box[1]); }

function intersectionArea(a, b) {
    return Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
        * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
}

function union(boxes) {
    return boxes.reduce((result, box) => [Math.min(result[0], box[0]),
        Math.min(result[1], box[1]), Math.max(result[2], box[2]), Math.max(result[3], box[3])],
    [1000, 1000, 0, 0]);
}

function padded(box, padding) {
    return [Math.max(0, box[0] - padding), Math.max(0, box[1] - padding),
        Math.min(1000, box[2] + padding), Math.min(1000, box[3] + padding)];
}

function consume(budget) { return --budget.remaining >= 0; }
