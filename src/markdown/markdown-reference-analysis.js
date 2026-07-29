import { parser as markdownParser } from '@lezer/markdown';

export const ACADEMIC_REFERENCE_IDENTIFIER_SOURCE =
    '(?:s?\\d{1,4}[a-z]?|[ivxlcdm]{1,12}[a-z]?)';

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
            ? [createTarget(candidate.key, candidate.object)]
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
