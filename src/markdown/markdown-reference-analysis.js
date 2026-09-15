import { parser as markdownParser } from '@lezer/markdown';

// Roman numerals, plain numbers, supplementary "S2" and appendix "A1"/"B.12"
// labels share one identifier so references resolve in every section.
export const ACADEMIC_REFERENCE_IDENTIFIER_SOURCE =
    '(?:(?:[a-z]{1,2}[.．]?[\\p{Zs}\\t]*)?\\d{1,4}[a-z]?|[ivxlcdm]{1,12}[a-z]?)';

const IGNORED_REFERENCE_NODES = new Set([
    'InlineCode',
    'FencedCode',
    'CodeBlock',
    'Image',
    'Link',
    'Autolink',
    'URL',
    'HTMLBlock',
]);

export function analyzeMarkdownLabeledReferences(markdown, {
    objects,
    keyForObject,
    createTarget,
    referencePattern,
    referenceKeys = key => [key],
}) {
    const source = String(markdown || '');
    const candidates = objects.flatMap(object => {
        const key = keyForObject(object);
        return key ? [{ key, object }] : [];
    });
    const candidatesByKey = new Map();
    for (const candidate of candidates) {
        const matches = candidatesByKey.get(candidate.key) || [];
        matches.push(candidate);
        candidatesByKey.set(candidate.key, matches);
    }
    const targets = candidates.flatMap(candidate => (
        candidatesByKey.get(candidate.key)?.length === 1
            ? [createTarget(candidate.key, candidate.object, source)]
            : []
    ));
    const targetsByKey = new Map(targets.map(target => [target.key, target]));
    const ignoredRanges = [
        ...objects,
        ...ignoredReferenceRanges(source),
    ];
    const references = [];

    for (const match of source.matchAll(new RegExp(referencePattern))) {
        const key = normalizeReferenceIdentifier(match[1]);
        const target = resolveReferenceTarget(
            referenceKeys(key),
            candidatesByKey,
            targetsByKey
        );
        if (!target
            || ignoredRanges.some(range => rangeContains(range, match.index))) {
            continue;
        }
        references.push({
            from: match.index,
            to: match.index + match[0].length,
            targetId: target.id,
        });
    }

    return { targets, references };
}

function resolveReferenceTarget(keys, candidatesByKey, targetsByKey) {
    for (const key of keys) {
        if (!candidatesByKey.has(key)) continue;
        return targetsByKey.get(key) || null;
    }
    return null;
}

export function normalizeReferenceIdentifier(identifier) {
    return String(identifier || '').toLowerCase();
}

export function locateMarkdownTargetLabel(markdown, {
    label,
    caption,
    from,
    to,
    excludedRanges = [],
}) {
    const source = String(markdown || '');
    const targetLabel = String(label || '');
    if (!targetLabel
        || !Number.isSafeInteger(from)
        || !Number.isSafeInteger(to)
        || from < 0
        || to <= from
        || to > source.length) {
        return null;
    }
    const targetCaption = String(caption || '');
    const labelInCaption = targetCaption.indexOf(targetLabel);
    let captionCandidates = labelInCaption >= 0
        ? targetOccurrences(source, targetCaption, from, to, excludedRanges)
        : [];
    if (!captionCandidates.length && targetCaption) {
        const documentCandidates = targetOccurrences(
            source,
            targetCaption,
            0,
            source.length,
            excludedRanges
        );
        if (documentCandidates.length === 1) {
            captionCandidates = documentCandidates;
        }
    }
    const labelCandidates = captionCandidates.length
        ? captionCandidates.map(candidate => candidate + labelInCaption)
        : targetOccurrences(source, targetLabel, from, to, excludedRanges);
    if (!labelCandidates.length) return null;
    const labelFrom = labelCandidates.reduce((closest, candidate) => (
        targetBoundaryDistance(candidate, targetLabel.length, from, to)
            < targetBoundaryDistance(closest, targetLabel.length, from, to)
            ? candidate
            : closest
    ));
    return {
        from: labelFrom,
        to: labelFrom + targetLabel.length,
    };
}

function targetOccurrences(source, value, from, to, excludedRanges) {
    if (!value) return [];
    const occurrences = [];
    let cursor = from;
    while (cursor < to) {
        const occurrence = source.indexOf(value, cursor);
        if (occurrence < from || occurrence + value.length > to) break;
        if (!excludedRanges.some(range => (
            occurrence < range.to && occurrence + value.length > range.from
        ))) {
            occurrences.push(occurrence);
        }
        cursor = occurrence + Math.max(1, value.length);
    }
    return occurrences;
}

function targetBoundaryDistance(candidate, length, from, to) {
    return Math.min(
        Math.abs(candidate - from),
        Math.abs(to - candidate - length)
    );
}

function ignoredReferenceRanges(markdown) {
    const ranges = [];
    markdownParser.parse(markdown).iterate({
        enter(node) {
            if (!IGNORED_REFERENCE_NODES.has(node.name)) return undefined;
            ranges.push({ from: node.from, to: node.to });
            return false;
        },
    });
    return ranges;
}

function rangeContains(range, position) {
    return position >= range.from && position < range.to;
}
