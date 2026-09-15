import { FIGURE_LIMITS } from './figure-limits.js';
import { isValidNormalizedSourceBBox } from '../core/markdown-source-map.js';
import {
    parseAcademicFigureCaption,
    parseLooseAcademicFigureCaption,
} from '../markdown/markdown-figures.js';

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
            if (!explicit.has(parent.id)) {
                explicit.set(parent.id, { panels: [], parents: [parent],
                    label: figureGroupLabel(blocks, parent.id) });
            }
            explicit.get(parent.id).panels.push(panel);
        }
        else remaining.push(panel);
    }
    const groups = mergeAdjacentExplicitGroups([...explicit.values()], limits, budget);
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
    return absorbUnmeasuredPanels(groups, panels, budget);
}

function absorbUnmeasuredPanels(groups, panels, budget) {
    const unmeasured = panels.filter(panel => !validBox(panel.bbox));
    if (!unmeasured.length) return groups;
    for (const panel of unmeasured) {
        const own = groups.find(group => group.panels.includes(panel));
        if (!own || own.parents?.length) continue;
        if (!consume(budget)) return groups.map(group => ({ ...group, exhausted: true }));
        let best = null;
        for (const group of groups) {
            if (group === own) continue;
            if (!group.panels.some(member => validBox(member.bbox))) continue;
            const distance = Math.min(...group.panels.map(
                member => Math.abs(member.sourceOrdinal - panel.sourceOrdinal)
            ));
            if (!best || distance < best.distance) best = { group, distance };
        }
        if (!best) continue;
        own.panels = own.panels.filter(member => member !== panel);
        best.group.panels.push(panel);
    }
    return groups.filter(group => group.panels.length);
}

function mergeAdjacentExplicitGroups(groups, limits, budget) {
    const merged = [];
    const used = new Set();
    for (const group of groups) {
        if (used.has(group)) continue;
        used.add(group);
        const members = [group];
        let label = group.label || null;
        let box = groupBox(group);
        let changed = true;
        while (changed && box) {
            changed = false;
            for (const other of groups) {
                if (used.has(other)) continue;
                if (!consume(budget)) {
                    return [...merged, {
                        panels: members.flatMap(member => member.panels),
                        parents: members.flatMap(member => member.parents),
                        label,
                        exhausted: true,
                    }];
                }
                // Two groups that claim different "Fig. N" labels are separate
                // figures even when their panels are geometrically adjacent.
                if (label && other.label && !sameFigureLabel(label, other.label)) continue;
                const otherBox = groupBox(other);
                if (!otherBox || !adjacent(box, otherBox, limits)) continue;
                used.add(other);
                members.push(other);
                if (!label) label = other.label || null;
                box = groupBox({ panels: members.flatMap(member => member.panels) });
                changed = true;
            }
        }
        merged.push(members.length === 1 ? group : {
            panels: members.flatMap(member => member.panels),
            parents: members.flatMap(member => member.parents),
            label,
        });
    }
    return merged;
}

function figureGroupLabel(blocks, parentId) {
    for (const block of blocks) {
        if (block.parentId !== parentId || block.role !== 'caption') continue;
        const label = parseAcademicFigureCaption(block.text)?.label
            || parseLooseAcademicFigureCaption(block.text)?.label;
        if (label) return label;
    }
    return null;
}

function sameFigureLabel(left, right) {
    const normalize = value => String(value || '').toLowerCase().replace(/\s+/gu, ' ').trim();
    return normalize(left) === normalize(right);
}

function groupBox(group) {
    if (group.panels.some(panel => !validBox(panel.bbox))) return null;
    return union(group.panels.map(panel => panel.bbox));
}

function resolveGroup(group, blocks, page, limits, budget) {
    const { panels } = group;
    const parents = group.parents || (group.parent ? [group.parent] : []);
    const parent = parents[0] || null;
    const anchor = parent || panels[0];
    const candidate = {
        ...preservedCandidate(anchor, anchor.pageIndex, 'missing-geometry'),
        panelBlockIds: panels.map(block => block.id),
        evidence: [parents.length ? 'explicit-parent' : 'same-page-geometry'],
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
    // Labels and internal text frequently sit a few units outside the tight
    // panel union; own them within a small padded band instead of treating
    // them as foreign content that forces the whole figure to preserve.
    const labelBox = padded(panelBox, limits.ownedTextPadding);
    // Figure-text children (for example a shared legend attached to one
    // panel) extend the figure band even when they sit above the panels.
    const bandBox = union([
        ...panels,
        ...blocks.filter(block => block.role === 'figure-text'
            && parents.some(parentBlock => block.parentId === parentBlock.id)
            && validBox(block.bbox)),
    ].map(block => block.bbox));
    for (const parentBlock of parents) {
        const parentPanels = panels.filter(panel => panel.parentId === parentBlock.id);
        if (!validBox(parentBlock.bbox)
            || !contains(parentBlock.bbox, union(parentPanels.map(panel => panel.bbox)))) {
            return preserve(candidate, 'ambiguous-membership');
        }
    }
    const explicitCaptions = [];
    const nearbyCaptions = [];
    for (const block of blocks) {
        if (!consume(budget)) return preserve(candidate, 'resource-limit');
        if (block.role !== 'caption' && !isLooseFigureCaption(block.text)) continue;
        if (parents.some(parentBlock => block.parentId === parentBlock.id)) {
            explicitCaptions.push(block);
        }
        else if (validBox(block.bbox) && captionNear(block.bbox, panelBox, limits)) {
            nearbyCaptions.push(block);
        }
    }
    let captions;
    let mergedContinuation = false;
    if (explicitCaptions.length) {
        const labeled = explicitCaptions.filter(block => isFigureCaptionText(block.text));
        if (labeled.length === 1) {
            const parts = explicitCaptions.filter(block => block.id !== labeled[0].id
                && !looksLikeGapLabel(block.text, limits)
                && captionContinues(labeled[0], block, limits));
            captions = orderCaptionParts([labeled[0], ...parts]);
            mergedContinuation = parts.length > 0;
        }
        else if (labeled.length) {
            captions = labeled;
        }
        else {
            // MinerU sometimes records a panel label as the only explicit
            // caption while the real academic caption is a sibling block
            // further below the figure.
            const sibling = academicCaptionBelow(blocks, panels, panelBox, limits);
            captions = sibling ? [sibling] : explicitCaptions;
        }
    }
    else {
        captions = nearbyCaptions.filter(block => !hasForeignPanelClaim(block, panels, blocks, limits));
    }
    if (captions.length > 1 && !mergedContinuation) {
        return preserve(candidate, 'ambiguous-caption');
    }
    if (!captions.length && !parents.length) {
        return preserve(candidate, 'ambiguous-caption');
    }
    const caption = captions[0];
    candidate.captionBlockIds = captions.map(part => part.id);
    candidate.captionBBox = captions.length ? union(captions.map(part => part.bbox)) : null;
    candidate.label = parseAcademicFigureCaption(caption?.text)?.label
        || parseLooseAcademicFigureCaption(caption?.text)?.label || null;
    if (captions.some(part => !validBox(part.bbox))) return candidate;
    if (caption && intersectionArea(panelBox, caption.bbox) > 0) {
        return preserve(candidate, 'caption-overlap');
    }
    const members = new Set(panels.map(block => block.id));
    for (const part of captions) members.add(part.id);
    for (const parentBlock of parents) members.add(parentBlock.id);
    const owned = [];
    // Legend rows and panel letters between the panels and a lower caption are
    // part of the figure area; owning them extends the PDF crop over content
    // MinerU failed to detect as an image (for example a second panel).
    const gapBlocks = figureGapBlocks(blocks, panels, caption, limits);
    const gapIDs = new Set(gapBlocks.map(block => block.id));
    for (const block of blocks) {
        if (!consume(budget)) return preserve(candidate, 'resource-limit');
        if (members.has(block.id) || block.bboxKind === 'group') continue;
        if (gapIDs.has(block.id)) {
            owned.push(block);
            members.add(block.id);
            continue;
        }
        const owner = parents.find(parentBlock => block.parentId === parentBlock.id);
        const explicitText = owner && block.role === 'figure-text';
        const explicitLabel = owner && block.role === 'caption' && block.id !== caption?.id
            && looksLikeGapLabel(block.text, limits);
        if ((explicitText || explicitLabel) && !validBox(block.bbox)) return candidate;
        if (!validBox(block.bbox)) {
            const ordinalMin = Math.min(...panels.map(panel => panel.sourceOrdinal), caption?.sourceOrdinal ?? Infinity);
            const ordinalMax = Math.max(...panels.map(panel => panel.sourceOrdinal), caption?.sourceOrdinal ?? -Infinity);
            if (block.text && block.sourceOrdinal >= ordinalMin && block.sourceOrdinal <= ordinalMax) return candidate;
            continue;
        }
        if (explicitText && !contains(panelBox, block.bbox)
            && intersectionArea(panelBox, block.bbox) === 0
            && !captionNear(block.bbox, panelBox, limits)) {
            return preserve(candidate, 'ambiguous-membership');
        }
        if (explicitLabel && !contains(labelBox, block.bbox)
            && !captionNear(block.bbox, owner.bbox, limits)) {
            continue;
        }
        if (block.role === 'body' || FOREIGN_TYPES.has(block.type) || isPanel(block)) {
            continue;
        }
        const inBandText = block.id !== caption?.id
            && !isFigureCaptionText(block.text)
            && isInBandAnnotationText(block, bandBox, captions, limits);
        if (block.role === 'caption' && !explicitLabel && !inBandText) {
            continue;
        }
        if (explicitText || explicitLabel || inBandText || (block.type === 'text' && (
            panels.some(panel => consume(budget)
                && intersectionArea(panel.bbox, block.bbox) / area(block.bbox) >= limits.interiorTextRatio)
            || (contains(labelBox, block.bbox) && looksLikeGapLabel(block.text, limits))
        ))) {
            owned.push(block);
            members.add(block.id);
        }
    }
    const visualBox = union([...panels, ...owned].map(block => block.bbox));
    let paddedBox = padded(visualBox, limits.padding);
    if (captions.some(part => intersectionArea(visualBox, part.bbox) > 0)) {
        return preserve(candidate, 'caption-overlap');
    }
    for (const block of blocks) {
        if (!consume(budget)) return preserve(candidate, 'resource-limit');
        if (members.has(block.id)) continue;
        if (block.bboxKind === 'group' || !validBox(block.bbox)) continue;
        if (intersectionArea(visualBox, block.bbox) > 0) {
            return preserve(candidate, block.role === 'caption' ? 'caption-overlap' : 'foreign-content-overlap');
        }
        if (intersectionArea(paddedBox, block.bbox) > 0) paddedBox = [...visualBox];
    }
    for (const block of [...panels, ...captions]) {
        if (!block.sourceRanges?.length || block.rangeEvidence === 'unresolved') {
            return preserve(candidate, 'ambiguous-source-range');
        }
    }
    const consumedOwned = owned.filter(block => block.sourceRanges?.length
        && block.rangeEvidence !== 'unresolved');
    // A caption can live inside a panel's image range when MinerU attached it
    // as the image description; nested ranges are unambiguous and the
    // transaction collapses them into one edit.
    const ranges = [...panels, ...consumedOwned, ...captions].flatMap(block => block.sourceRanges)
        .sort((left, right) => left.from - right.from || right.to - left.to);
    let outerRange = null;
    for (const range of ranges) {
        if (outerRange && range.from < outerRange.to) {
            if (range.from >= outerRange.from && range.to <= outerRange.to) continue;
            return preserve(candidate, 'ambiguous-source-range');
        }
        outerRange = range;
    }
    candidate.ownedTextBlockIds = consumedOwned.map(block => block.id);
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

export function captionNear(caption, box, limits) {
    const gap = caption[1] >= box[3] ? caption[1] - box[3] : box[1] - caption[3];
    return gap >= 0 && gap <= Math.min(limits.captionMaxGap,
        Math.max(limits.captionMinGap, limits.captionGapFactor * (box[3] - box[1])))
        && overlap(caption[0], caption[2], box[0], box[2]) >= limits.captionProjectionOverlap;
}

const GAP_PROSE_END_PATTERN = /[.!?。！？](?:["'’”)\]]|\s|$)/u;
const MAX_FIGURE_GAP_CODE_POINTS = 2_000;

function figureGapBlocks(blocks, panels, caption, limits) {
    if (!caption || !validBox(caption.bbox)) return [];
    const panelBox = union(panels.map(panel => panel.bbox));
    const gap = [];
    let codePoints = 0;
    for (const block of blocks) {
        if (block.id === caption.id) continue;
        if (block.pageIndex !== panels[0].pageIndex || !validBox(block.bbox)) continue;
        if (block.bbox[3] > caption.bbox[1] || block.bbox[1] < panelBox[3]) continue;
        if (overlap(block.bbox[0], block.bbox[2], panelBox[0], panelBox[2])
            < limits.captionProjectionOverlap) continue;
        if (block.role !== undefined && block.role !== 'unknown') continue;
        if (block.type !== 'text' && block.type !== 'caption') continue;
        if (!block.sourceRanges?.length || block.rangeEvidence === 'unresolved') return [];
        const text = String(block.text || '');
        if (!text.trim() || GAP_PROSE_END_PATTERN.test(text)) return [];
        codePoints += [...text].length;
        if (codePoints > MAX_FIGURE_GAP_CODE_POINTS) return [];
        gap.push(block);
    }
    return gap;
}

// A sibling academic caption below the panel union can replace panel labels
// that MinerU attached as explicit captions. Only resolved blocks qualify so a
// missing Markdown range cannot turn a composed figure into a preserved one.
function academicCaptionBelow(blocks, panels, panelBox, limits) {
    const ordinalMin = Math.max(...panels.map(panel => panel.sourceOrdinal));
    const candidates = blocks.filter(block => (
        block.role === 'caption'
        && isFigureCaptionText(block.text)
        && block.sourceRanges?.length
        && validBox(block.bbox)
        && block.sourceOrdinal > ordinalMin
        && block.bbox[1] >= panelBox[3]
        && overlap(block.bbox[0], block.bbox[2], panelBox[0], panelBox[2])
            >= limits.captionProjectionOverlap
    ));
    return candidates.length === 1 ? candidates[0] : null;
}

function hasForeignPanelClaim(caption, panels, blocks, limits) {
    return blocks.some(block => isPanel(block) && !panels.includes(block)
        && block.pageIndex === caption.pageIndex && validBox(block.bbox)
        && captionNear(caption.bbox, block.bbox, limits));
}

export function isLooseFigureCaption(text) {
    return Boolean(parseLooseAcademicFigureCaption(text));
}

function isFigureCaptionText(text) {
    return Boolean(parseAcademicFigureCaption(text)) || isLooseFigureCaption(text);
}

function captionContinues(primary, block, limits) {
    if (!validBox(primary.bbox) || !validBox(block.bbox)) return false;
    if (overlap(primary.bbox[1], primary.bbox[3], block.bbox[1], block.bbox[3])
        < limits.captionProjectionOverlap) return false;
    const gap = Math.max(0, Math.max(primary.bbox[0], block.bbox[0])
        - Math.min(primary.bbox[2], block.bbox[2]));
    const span = Math.max(primary.bbox[2] - primary.bbox[0], block.bbox[2] - block.bbox[0]);
    return gap <= Math.max(limits.captionMinGap, limits.captionGapFactor * span);
}

function orderCaptionParts(parts) {
    return parts.slice().sort((left, right) => (
        left.bbox[1] - right.bbox[1]
        || left.bbox[0] - right.bbox[0]
        || left.sourceOrdinal - right.sourceOrdinal));
}

function isInBandAnnotationText(block, panelBox, captions, limits) {
    const value = String(block.text || '').trim();
    // Panel sub-captions legitimately run longer than axis annotations and
    // still belong to the figure image.
    const codePointLimit = block.role === 'caption'
        ? Math.max(limits.ownedTextCodePoints, limits.ownedCaptionTextCodePoints)
        : limits.ownedTextCodePoints;
    if (!value || [...value].length > codePointLimit) return false;
    if (value.split(/\r?\n/u).length > limits.maxGapTextLines) return false;
    // Panel sub-captions such as "(c) Routing and failure isolation." sit a
    // few units below their panel, beyond the generic in-band tolerance.
    const padding = block.role === 'caption'
        ? Math.max(limits.ownedTextPadding, limits.captionMinGap)
        : limits.ownedTextPadding;
    if (!contains(padded(panelBox, padding), block.bbox)) return false;
    return captions.every(part => !validBox(part.bbox)
        || intersectionArea(part.bbox, block.bbox) === 0);
}

export function looksLikeGapLabel(text, limits) {
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
