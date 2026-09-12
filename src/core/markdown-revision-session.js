import { GFM, parser } from '@lezer/markdown';
import { cloneFigureMap } from '../figures/figure-model.js';
import { mapFigureMapThroughEdits } from '../figures/figure-map-transforms.js';
import { mapChromeRanges } from '../markdown/chrome-ranges.js';
import {
    findDisplayMathMatches,
    findInlineMathMatches,
} from '../markdown/markdown-html.js';

const MARKDOWN_PARSER = parser.configure(GFM);
const REVISION_SCHEMA_VERSION = 1;
const MAX_CORRECTION_BYTES = 256 * 1024;
const CACHE_KEY_PATTERN = /^[a-f0-9]{64}$/;
const HEADING_PATTERN = /^ATXHeading[1-6]$/;
const ANNOTATION_PROTECTION_ERROR_CODE = 'MARKDOWN_ANNOTATION_PROTECTED';
const ANNOTATION_CONTEXT_LENGTH = 256;
const MAX_ANNOTATION_RANGE_CANDIDATES = 1_000;

export function collectMatchedAnnotationRanges(annotationOverlay) {
    return (annotationOverlay?.matched || []).flatMap(annotation => (
        Array.isArray(annotation?.ranges)
            ? annotation.ranges.flatMap((range, rangeIndex) => (
                Number.isSafeInteger(range?.from)
                && Number.isSafeInteger(range?.to)
                && range.from >= 0
                && range.to > range.from
                    ? [{
                        id: String(annotation.id || ''),
                        source: String(annotation.source || ''),
                        rangeIndex,
                        from: range.from,
                        to: range.to,
                    }]
                    : []
            ))
            : []
    )).filter(range => range.id);
}

export function protectEditableBlocksWithAnnotations(blocks, annotationRanges) {
    const ranges = Array.isArray(annotationRanges) ? annotationRanges : [];
    return (Array.isArray(blocks) ? blocks : []).map(block => {
        const protectedAnnotations = ranges.flatMap(range => {
            const from = Math.max(block.from, range.from);
            const to = Math.min(block.to, range.to);
            return to > from ? [{ from, to, kind: 'annotation' }] : [];
        });
        if (!protectedAnnotations.length) return block;
        return {
            ...block,
            protectedRanges: [
                ...(block.protectedRanges || []),
                ...protectedAnnotations,
            ].sort((left, right) => (
                left.from - right.from || left.to - right.to
            )),
        };
    });
}

export async function openMarkdownRevisionSession({
    baseDocument,
    store,
    now = Date.now,
}) {
    validateBaseDocument(baseDocument);
    if (!store?.load || !store?.save || !store?.delete) {
        throw new TypeError('A Markdown revision store is required');
    }
    const stored = await store.load(baseDocument.cacheKey);
    const revision = stored
        ? validateStoredRevision(stored, baseDocument.cacheKey)
        : createRevision(baseDocument);
    return new MarkdownRevisionSession({ revision, store, now });
}

export function createMarkdownRevisionSessionRegistry({
    openSession = openMarkdownRevisionSession,
} = {}) {
    if (typeof openSession !== 'function') {
        throw new TypeError('A Markdown revision session opener is required');
    }
    const entries = new Map();
    const pending = new Map();

    const close = async itemID => {
        pending.delete(itemID);
        const entry = entries.get(itemID);
        if (!entry) return;
        entries.delete(itemID);
        await entry.session.destroy();
    };

    const destroyAll = async () => {
        pending.clear();
        const active = [...entries.values()];
        entries.clear();
        await Promise.all(active.map(entry => entry.session.destroy()));
    };

    return {
        get(itemID) {
            return entries.get(itemID);
        },

        async open(itemID, baseDocument, options = {}) {
            await close(itemID);
            throwIfAborted(options.signal);
            const token = {};
            pending.set(itemID, token);
            let session;
            try {
                session = await openSession({
                    baseDocument,
                    ...options,
                });
                if (pending.get(itemID) !== token
                    || options.signal?.aborted) {
                    await session.destroy();
                    throw abortError(options.signal);
                }
                const entry = {
                    cacheKey: baseDocument.cacheKey,
                    session,
                };
                pending.delete(itemID);
                entries.set(itemID, entry);
                return entry;
            }
            catch (error) {
                if (pending.get(itemID) === token) pending.delete(itemID);
                throw error;
            }
        },

        close,
        destroyAll,
    };
}

class MarkdownRevisionSession {
    constructor({ revision, store, now }) {
        this.revision = revision;
        this.store = store;
        this.now = now;
        this.operationTail = Promise.resolve();
    }

    snapshot() {
        return materializeRevision(this.revision);
    }

    commit({
        blockID,
        replacementMarkdown,
        annotationRanges = [],
        mappedAnnotationRanges = [],
    }) {
        return this.#withOperation(async () => {
            const current = this.snapshot();
            const block = findRevisionBlock(this.revision, blockID);
            const replacement = validateReplacement(block, replacementMarkdown);
            const corrections = this.revision.corrections.filter(correction => (
                correction.blockID !== block.id
            ));
            if (replacement !== block.originalMarkdown) {
                corrections.push({
                    blockID: block.id,
                    originalMarkdown: block.originalMarkdown,
                    replacementMarkdown: replacement,
                    updatedAt: this.now(),
                });
            }
            const revision = {
                ...this.revision,
                corrections: sortCorrections(corrections, this.revision.blocks),
            };
            const snapshot = materializeRevision(revision);
            const annotationRangeMappings = mapAnnotationRanges({
                current,
                next: snapshot,
                annotationRanges,
                mappedAnnotationRanges,
            });
            await this.#persist(revision);
            this.revision = revision;
            return withAnnotationRangeMappings(
                snapshot,
                annotationRangeMappings
            );
        });
    }

    restore(blockID, { annotationRanges = [] } = {}) {
        return this.#withOperation(async () => {
            const current = this.snapshot();
            findRevisionBlock(this.revision, blockID);
            const revision = {
                ...this.revision,
                corrections: this.revision.corrections.filter(correction => (
                    correction.blockID !== blockID
                )),
            };
            const snapshot = materializeRevision(revision);
            const annotationRangeMappings = mapAnnotationRanges({
                current,
                next: snapshot,
                annotationRanges,
            });
            await this.#persist(revision);
            this.revision = revision;
            return withAnnotationRangeMappings(
                snapshot,
                annotationRangeMappings
            );
        });
    }

    restoreAll({ annotationRanges = [] } = {}) {
        return this.#withOperation(async () => {
            const current = this.snapshot();
            const revision = { ...this.revision, corrections: [] };
            const snapshot = materializeRevision(revision);
            const annotationRangeMappings = mapAnnotationRanges({
                current,
                next: snapshot,
                annotationRanges,
            });
            await this.#persist(revision);
            this.revision = revision;
            return withAnnotationRangeMappings(
                snapshot,
                annotationRangeMappings
            );
        });
    }

    async destroy() {
        await this.operationTail.catch(() => {});
    }

    async #persist(revision) {
        if (!revision.corrections.length) {
            await this.store.delete(revision.base.cacheKey);
            return;
        }
        await this.store.save(
            revision.base.cacheKey,
            cloneRevision(revision)
        );
    }

    #withOperation(operation) {
        const pending = this.operationTail.catch(() => {}).then(operation);
        this.operationTail = pending;
        return pending;
    }
}

function createRevision(baseDocument) {
    const base = cloneBaseDocument(baseDocument);
    return {
        schemaVersion: REVISION_SCHEMA_VERSION,
        base,
        blocks: collectEditableBlocks(base.markdown),
        corrections: [],
    };
}

function validateStoredRevision(value, cacheKey) {
    if (value?.schemaVersion !== REVISION_SCHEMA_VERSION
        || value.base?.cacheKey !== cacheKey
        || typeof value.base?.markdown !== 'string'
        || !Array.isArray(value.blocks)
        || !Array.isArray(value.corrections)) {
        throw new Error('Invalid saved Markdown revision');
    }
    const expectedBlocks = collectEditableBlocks(value.base.markdown);
    const legacyBlocks = expectedBlocks.filter(block => (
        !containsMath(block.originalMarkdown)
    ));
    const storedBlocksJSON = JSON.stringify(value.blocks);
    if (storedBlocksJSON !== JSON.stringify(expectedBlocks)
        && storedBlocksJSON !== JSON.stringify(legacyBlocks)) {
        throw new Error('Saved Markdown revision blocks do not match its base');
    }
    const storedBlockIDs = new Set(value.blocks.map(block => block.id));
    for (const correction of value.corrections) {
        if (!storedBlockIDs.has(correction?.blockID)
            || typeof correction.originalMarkdown !== 'string'
            || typeof correction.replacementMarkdown !== 'string') {
            throw new Error('Invalid saved Markdown correction');
        }
        const block = expectedBlocks.find(candidate => (
            candidate.id === correction.blockID
        ));
        if (correction.originalMarkdown !== block.originalMarkdown) {
            throw new Error('Saved Markdown correction has a stale base');
        }
        validateReplacement(block, correction.replacementMarkdown);
    }
    return cloneRevision({ ...value, blocks: expectedBlocks });
}

function materializeRevision(revision) {
    const corrections = new Map(revision.corrections.map(correction => [
        correction.blockID,
        correction,
    ]));
    const transforms = [];
    const editableBlocks = [];
    const chunks = [];
    let baseCursor = 0;
    let materializedLength = 0;
    for (const block of revision.blocks) {
        const prefix = revision.base.markdown.slice(baseCursor, block.baseFrom);
        chunks.push(prefix);
        materializedLength += prefix.length;
        const correction = corrections.get(block.id);
        const replacement = correction?.replacementMarkdown
            ?? block.originalMarkdown;
        const currentFrom = materializedLength;
        chunks.push(replacement);
        materializedLength += replacement.length;
        const protectedRanges = collectMathRanges(replacement).map(range => ({
            from: currentFrom + range.from,
            to: currentFrom + range.to,
        }));
        editableBlocks.push({
            id: block.id,
            type: block.type,
            from: currentFrom,
            to: materializedLength,
            originalMarkdown: block.originalMarkdown,
            markdown: replacement,
            corrected: Boolean(correction),
            ...(protectedRanges.length ? { protectedRanges } : {}),
        });
        if (correction) {
            transforms.push({
                from: block.baseFrom,
                to: block.baseTo,
                replacementLength: replacement.length,
            });
        }
        baseCursor = block.baseTo;
    }
    const suffix = revision.base.markdown.slice(baseCursor);
    chunks.push(suffix);
    const markdown = chunks.join('');
    const sourceMap = transformSourceMap(
        revision.base.sourceMap || [],
        transforms
    );
    const chromeRanges = mapChromeRanges(
        revision.base.chromeRanges || [],
        transforms,
        markdown.length
    );
    return {
        itemID: revision.base.itemID,
        cacheKey: revision.base.cacheKey,
        markdown,
        sourceMap,
        chromeRanges,
        ...(revision.base.figureMap ? {
            figureMap: mapFigureMapThroughEdits(revision.base.figureMap, transforms, markdown),
        } : {}),
        assets: cloneAssets(revision.base.assets || []),
        assetBasePath: revision.base.assetBasePath || '',
        extractedPages: revision.base.extractedPages ?? null,
        totalPages: revision.base.totalPages ?? null,
        editableBlocks,
        correctedBlockIDs: editableBlocks
            .filter(block => block.corrected)
            .map(block => block.id),
        correctionCount: revision.corrections.length,
        hasCorrections: revision.corrections.length > 0,
    };
}

function mapAnnotationRanges({
    current,
    next,
    annotationRanges,
    mappedAnnotationRanges = [],
}) {
    const ranges = normalizeAnnotationRanges(
        annotationRanges,
        current.markdown.length
    );
    if (!ranges.length) return [];
    const mappedHints = new Map(normalizeAnnotationRanges(
        mappedAnnotationRanges,
        next.markdown.length
    ).map(range => [annotationRangeKey(range), range]));
    const transforms = collectChangedBlockTransforms(current, next);
    return ranges.map(range => {
        const overlapping = transforms.filter(transform => rangesOverlap(
            range.from,
            range.to,
            transform.oldFrom,
            transform.oldTo
        ));
        let mapped;
        if (!overlapping.length) {
            mapped = {
                from: mapSnapshotPosition(range.from, 1, transforms),
                to: mapSnapshotPosition(range.to, -1, transforms),
            };
        }
        else {
            if (overlapping.some(transform => (
                transform.newTo === transform.newFrom
            ))) {
                throw annotationProtectionError();
            }
            const hint = mappedHints.get(annotationRangeKey(range));
            mapped = hint || findUnchangedAnnotationRange(
                current.markdown,
                next.markdown,
                range,
                overlapping,
                transforms
            );
        }
        if (!mapped
            || current.markdown.slice(range.from, range.to)
                !== next.markdown.slice(mapped.from, mapped.to)) {
            throw annotationProtectionError();
        }
        return {
            id: range.id,
            source: range.source,
            rangeIndex: range.rangeIndex,
            oldFrom: range.from,
            oldTo: range.to,
            from: mapped.from,
            to: mapped.to,
        };
    });
}

function normalizeAnnotationRanges(ranges, documentLength) {
    if (!Array.isArray(ranges)) return [];
    return ranges.flatMap(range => (
        String(range?.id || '')
        && Number.isSafeInteger(range?.rangeIndex)
        && range.rangeIndex >= 0
        && Number.isSafeInteger(range?.from)
        && Number.isSafeInteger(range?.to)
        && range.from >= 0
        && range.to > range.from
        && range.to <= documentLength
            ? [{
                id: String(range.id),
                source: String(range.source || ''),
                rangeIndex: range.rangeIndex,
                from: range.from,
                to: range.to,
            }]
            : []
    ));
}

function collectChangedBlockTransforms(current, next) {
    const nextBlocks = new Map(next.editableBlocks.map(block => [block.id, block]));
    return current.editableBlocks.flatMap(block => {
        const nextBlock = nextBlocks.get(block.id);
        if (!nextBlock || block.markdown === nextBlock.markdown) return [];
        return [{
            oldFrom: block.from,
            oldTo: block.to,
            newFrom: nextBlock.from,
            newTo: nextBlock.to,
        }];
    });
}

function mapSnapshotPosition(position, association, transforms) {
    let delta = 0;
    for (const transform of transforms) {
        if (position < transform.oldFrom
            || (position === transform.oldFrom && association < 0)) {
            return position + delta;
        }
        if (position > transform.oldTo
            || (position === transform.oldTo && association > 0)) {
            delta += (transform.newTo - transform.newFrom)
                - (transform.oldTo - transform.oldFrom);
            continue;
        }
        const relative = position - transform.oldFrom;
        return transform.newFrom + Math.min(
            relative,
            transform.newTo - transform.newFrom
        );
    }
    return position + delta;
}

function findUnchangedAnnotationRange(
    currentMarkdown,
    nextMarkdown,
    range,
    overlapping,
    transforms
) {
    const selected = currentMarkdown.slice(range.from, range.to);
    const searchFrom = overlapping.length === 1
        ? overlapping[0].newFrom
        : 0;
    const searchTo = overlapping.length === 1
        ? overlapping[0].newTo
        : nextMarkdown.length;
    const candidates = [];
    let offset = searchFrom;
    while (offset <= searchTo - selected.length
        && candidates.length <= MAX_ANNOTATION_RANGE_CANDIDATES) {
        const found = nextMarkdown.indexOf(selected, offset);
        if (found < 0 || found + selected.length > searchTo) break;
        candidates.push({ from: found, to: found + selected.length });
        offset = found + Math.max(1, selected.length);
    }
    if (!candidates.length
        || candidates.length > MAX_ANNOTATION_RANGE_CANDIDATES) {
        return null;
    }
    if (candidates.length === 1) return candidates[0];
    const oldPrefix = currentMarkdown.slice(
        Math.max(0, range.from - ANNOTATION_CONTEXT_LENGTH),
        range.from
    );
    const oldSuffix = currentMarkdown.slice(
        range.to,
        Math.min(currentMarkdown.length, range.to + ANNOTATION_CONTEXT_LENGTH)
    );
    const expectedFrom = mapSnapshotPosition(range.from, 1, transforms);
    const scored = candidates.map(candidate => ({
        ...candidate,
        score: commonSuffixLength(
            oldPrefix,
            nextMarkdown.slice(
                Math.max(searchFrom, candidate.from - ANNOTATION_CONTEXT_LENGTH),
                candidate.from
            )
        ) + commonPrefixLength(
            oldSuffix,
            nextMarkdown.slice(
                candidate.to,
                Math.min(searchTo, candidate.to + ANNOTATION_CONTEXT_LENGTH)
            )
        ),
        distance: Math.abs(candidate.from - expectedFrom),
    })).sort((left, right) => (
        right.score - left.score || left.distance - right.distance
    ));
    if (!scored[0].score || scored[0].score === scored[1].score) return null;
    return { from: scored[0].from, to: scored[0].to };
}

function commonPrefixLength(left, right) {
    const limit = Math.min(left.length, right.length);
    let index = 0;
    while (index < limit && left[index] === right[index]) index++;
    return index;
}

function commonSuffixLength(left, right) {
    const limit = Math.min(left.length, right.length);
    let length = 0;
    while (length < limit
        && left[left.length - length - 1] === right[right.length - length - 1]) {
        length++;
    }
    return length;
}

function annotationRangeKey(range) {
    return `${range.source}:${range.id}:${range.rangeIndex}`;
}

function annotationProtectionError() {
    const error = new Error(
        'Annotated text cannot be changed until its annotation is deleted'
    );
    error.code = ANNOTATION_PROTECTION_ERROR_CODE;
    return error;
}

function withAnnotationRangeMappings(snapshot, mappings) {
    return mappings.length
        ? { ...snapshot, annotationRangeMappings: mappings }
        : snapshot;
}

function collectEditableBlocks(markdown) {
    const result = [];
    const tree = MARKDOWN_PARSER.parse(markdown);
    let ordinal = 0;
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
        const type = editableBlockType(node.name);
        if (!type) continue;
        const originalMarkdown = markdown.slice(node.from, node.to);
        const protectedMath = collectMathRanges(originalMarkdown);
        if (protectedMath.length
            && !hasEditableTextOutsideMath(originalMarkdown, protectedMath)) {
            continue;
        }
        const containsProtectedMath = protectedMath.length > 0;
        result.push({
            id: containsProtectedMath
                ? `formula-block-${node.from}-${node.to}-${type}`
                : `block-${ordinal}-${node.from}-${node.to}-${type}`,
            type,
            baseFrom: node.from,
            baseTo: node.to,
            originalMarkdown,
        });
        if (!containsProtectedMath) ordinal++;
    }
    return result;
}

function containsMath(markdown) {
    return findInlineMathMatches(markdown).length > 0
        || findDisplayMathMatches(markdown).length > 0;
}

function editableBlockType(nodeName) {
    if (nodeName === 'Paragraph') return 'paragraph';
    if (nodeName === 'Table') return 'table';
    if (HEADING_PATTERN.test(nodeName)) return 'heading';
    return null;
}

function validateReplacement(block, value) {
    const replacement = String(value ?? '').replace(/\r\n?/g, '\n');
    if (new TextEncoder().encode(replacement).length > MAX_CORRECTION_BYTES) {
        throw new Error('The Markdown correction exceeds its size limit');
    }
    const originalMath = collectMathRanges(block.originalMarkdown);
    const replacementMath = collectMathRanges(replacement);
    if (!originalMath.length && replacementMath.length) {
        throw new Error('Formulas cannot be added in correction mode');
    }
    if (originalMath.length !== replacementMath.length
        || originalMath.some((range, index) => (
            range.raw !== replacementMath[index].raw
        ))) {
        throw new Error('Formulas cannot be changed in correction mode');
    }
    if (!replacement.trim()) {
        if (block.type !== 'paragraph' && block.type !== 'heading') {
            throw new Error(
                'Only paragraphs and headings can be deleted in correction mode'
            );
        }
        return '';
    }
    const tree = MARKDOWN_PARSER.parse(replacement);
    const nodes = [];
    for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
        nodes.push(node);
    }
    if (nodes.length !== 1) {
        throw new Error('A correction must contain one editable block');
    }
    const replacementType = editableBlockType(nodes[0].name);
    if (!replacementType
        || (block.type === 'heading'
            ? replacementType !== 'heading'
            : replacementType !== block.type)) {
        throw new Error('A correction must preserve its editable block type');
    }
    let containsImage = false;
    let containsRawHTML = false;
    tree.iterate({
        enter(node) {
            if (node.name === 'Image') containsImage = true;
            if (node.name === 'HTMLBlock' || node.name === 'HTMLTag') {
                containsRawHTML = true;
            }
        },
    });
    if (containsImage) {
        throw new Error('Images cannot be added in correction mode');
    }
    if (containsRawHTML) {
        throw new Error('Raw HTML cannot be added in correction mode');
    }
    return replacement;
}

function collectMathRanges(markdown) {
    const matches = [
        ...findInlineMathMatches(markdown),
        ...findDisplayMathMatches(markdown),
    ].sort((left, right) => left.start - right.start || right.end - left.end);
    const result = [];
    for (const match of matches) {
        if (result.length && match.start < result.at(-1).to) continue;
        result.push({
            from: match.start,
            to: match.end,
            raw: match.raw,
        });
    }
    return result;
}

function hasEditableTextOutsideMath(markdown, ranges) {
    let cursor = 0;
    let outsideMath = '';
    for (const range of ranges) {
        outsideMath += markdown.slice(cursor, range.from);
        cursor = range.to;
    }
    outsideMath += markdown.slice(cursor);
    return /[\p{L}\p{N}]/u.test(outsideMath);
}

function transformSourceMap(sourceMap, transforms) {
    return sourceMap.map(entry => {
        const corrected = transforms.some(transform => rangesOverlap(
            entry.markdownFrom,
            entry.markdownTo,
            transform.from,
            transform.to
        ));
        const transformed = {
            ...entry,
            markdownFrom: mapPosition(
                entry.markdownFrom,
                corrected ? -1 : 1,
                transforms
            ),
            markdownTo: mapPosition(
                entry.markdownTo,
                corrected ? 1 : -1,
                transforms
            ),
            locations: (entry.locations || []).map(location => ({
                ...location,
                bbox: [...location.bbox],
            })),
        };
        if (corrected) {
            delete transformed.locationRanges;
            transformed.corrected = true;
        }
        else if (Array.isArray(entry.locationRanges)) {
            transformed.locationRanges = entry.locationRanges.map(range => ({
                markdownFrom: mapPosition(range.markdownFrom, 1, transforms),
                markdownTo: mapPosition(range.markdownTo, -1, transforms),
                location: {
                    ...range.location,
                    bbox: [...range.location.bbox],
                },
            }));
        }
        return transformed;
    }).filter(entry => entry.markdownTo > entry.markdownFrom);
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError(signal);
}

function abortError(signal) {
    if (signal?.reason) return signal.reason;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}

function mapPosition(position, association, transforms) {
    let delta = 0;
    for (const transform of transforms) {
        const replacementFrom = transform.from + delta;
        const replacementTo = replacementFrom + transform.replacementLength;
        if (position < transform.from
            || (position === transform.from && association < 0)) {
            return position + delta;
        }
        if (position > transform.to
            || (position === transform.to && association > 0)) {
            delta += transform.replacementLength - (transform.to - transform.from);
            continue;
        }
        return association < 0 ? replacementFrom : replacementTo;
    }
    return position + delta;
}

function rangesOverlap(leftFrom, leftTo, rightFrom, rightTo) {
    return leftFrom < rightTo && leftTo > rightFrom;
}

function findRevisionBlock(revision, blockID) {
    const block = revision.blocks.find(candidate => candidate.id === blockID);
    if (!block) throw new Error('The Markdown correction block is unavailable');
    return block;
}

function sortCorrections(corrections, blocks) {
    const order = new Map(blocks.map((block, index) => [block.id, index]));
    return corrections.sort((left, right) => (
        order.get(left.blockID) - order.get(right.blockID)
    ));
}

function validateBaseDocument(value) {
    if (!value || typeof value.markdown !== 'string') {
        throw new TypeError('A base Markdown document is required');
    }
    if (!CACHE_KEY_PATTERN.test(value.cacheKey || '')) {
        throw new TypeError('A base Markdown cache key is required');
    }
    if (value.sourceMap !== undefined && !Array.isArray(value.sourceMap)) {
        throw new TypeError('The base Markdown source map must be an array');
    }
    if (value.chromeRanges !== undefined && !Array.isArray(value.chromeRanges)) {
        throw new TypeError('The base Markdown chrome ranges must be an array');
    }
}

function cloneRevision(revision) {
    return {
        schemaVersion: revision.schemaVersion,
        base: cloneBaseDocument(revision.base),
        blocks: revision.blocks.map(block => ({ ...block })),
        corrections: revision.corrections.map(correction => ({ ...correction })),
    };
}

function cloneBaseDocument(document) {
    return {
        itemID: document.itemID,
        cacheKey: document.cacheKey,
        ...(document.figureMap ? { figureMap: cloneFigureMap(document.figureMap) } : {}),
        markdown: document.markdown,
        sourceMap: (document.sourceMap || []).map(entry => cloneSourceMapEntry(entry)),
        chromeRanges: (document.chromeRanges || []).map(range => ({
            from: range.from,
            to: range.to,
        })),
        assets: cloneAssets(document.assets || []),
        assetBasePath: String(document.assetBasePath || ''),
        extractedPages: document.extractedPages ?? null,
        totalPages: document.totalPages ?? null,
    };
}

function cloneSourceMapEntry(entry) {
    return {
        ...entry,
        locations: (entry.locations || []).map(location => ({
            ...location,
            bbox: [...location.bbox],
        })),
        ...(Array.isArray(entry.locationRanges) ? {
            locationRanges: entry.locationRanges.map(range => ({
                ...range,
                location: {
                    ...range.location,
                    bbox: [...range.location.bbox],
                },
            })),
        } : {}),
    };
}

function cloneAssets(assets) {
    return assets.map(asset => ({
        ...asset,
        data: asset.data?.slice ? asset.data.slice() : asset.data,
    }));
}
