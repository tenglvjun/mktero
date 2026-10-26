import {
    isPDFAnnotationUnavailableError,
    isZoteroAnnotationColor,
    leadingCodePoints,
    MAX_PDF_ANNOTATION_TEXT_LENGTH,
    MAX_PDF_ANNOTATION_TEXT_QUOTE_CONTEXT_CODE_POINTS,
    MAX_PDF_ANNOTATION_TEXT_QUOTE_CONTEXT_LENGTH,
    normalizePDFAnnotationTextQuote,
    trailingCodePoints,
} from './pdf-annotation.js';
import {
    createVisibleMarkdownTextIndex,
    expandMarkdownRangeToMathBoundaries,
    legacyVisibleMarkdownTextForRanges,
    unescapeImageMathText,
    visibleMarkdownTextForRanges,
} from '../markdown/markdown-visible-text.js';
import { findTextOccurrences } from '../markdown/text-normalization.js';
import {
    createPdfAnnotationTextIndex,
    normalizePdfAnnotationText,
} from '../markdown/pdf-annotation-text.js';
import {
    resolvePDFPageIndexHint,
    resolveSourceMapRegion,
} from './markdown-source-map.js';

const DEFAULT_ANNOTATION_COLOR = '#ffd400';
const MARKDOWN_ANNOTATION_CONTEXT_CODE_POINTS
    = MAX_PDF_ANNOTATION_TEXT_QUOTE_CONTEXT_CODE_POINTS;
const MAX_LOCAL_ANNOTATIONS = 5_000;
const MAX_TOTAL_ANNOTATION_TEXT_LENGTH = 2_000_000;
const MAX_TOTAL_ANNOTATION_CONTEXT_LENGTH = MAX_LOCAL_ANNOTATIONS
    * MAX_PDF_ANNOTATION_TEXT_QUOTE_CONTEXT_LENGTH
    * 2;
const MAX_MATCH_CANDIDATES = 10_000;
const MAX_MATCHABLE_MARKDOWN_LENGTH = 8 * 1024 * 1024;
const MAX_TOTAL_SOURCE_RANGE_LENGTH = 8 * 1024 * 1024;
const MAX_SOURCE_MAP_PAGE_HINT_WORK = 10_000_000;
const LOCAL_ANNOTATION_ID = /^mktero-[a-z0-9-]{1,128}$/i;
// A synchronized highlight leaves the local store, but a note editor or popup
// opened before that still holds the local id. Remember where it went for the
// rest of the session so those edits reach the PDF annotation.
const MAX_SYNCHRONIZED_ALIASES_PER_ITEM = 1_000;
const INVALID_STORE_ERROR_CODE = 'MARKDOWN_ANNOTATION_STORE_INVALID';
export const MARKDOWN_ANNOTATIONS_SET_ASIDE_WARNING
    = 'Saved local Markdown annotations could not be fully read. The original file was kept as a backup, and new annotations can be added.';
const SYNCHRONIZATION_FAILURE_REASONS = new Map([
    ['MKTERO_PDF_INDEX_UNAVAILABLE', 'pdf-index-unavailable'],
    ['MKTERO_PDF_TEXT_NOT_FOUND', 'text-not-found'],
    ['MKTERO_PDF_TEXT_AMBIGUOUS', 'text-ambiguous'],
    ['MKTERO_PDF_READER_UNAVAILABLE', 'reader-unavailable'],
    ['MKTERO_PDF_TEXT_SEARCH_TIMEOUT', 'search-timeout'],
]);

export function invalidMarkdownAnnotationStoreError(message, cause) {
    const error = new Error(
        message,
        cause === undefined ? undefined : { cause }
    );
    error.code = INVALID_STORE_ERROR_CODE;
    return error;
}

export function isInvalidMarkdownAnnotationStoreError(error) {
    return error?.code === INVALID_STORE_ERROR_CODE;
}

// Stored annotations keep at most this many ranges. A longer selection would
// be saved with its ranges cut short while its text stays whole, so a write
// refuses it instead. Reading an older, longer record stays tolerant.
// An HTML table selection keeps one range per cell, so a large table needs
// several hundred.
export const MAX_MARKDOWN_ANNOTATION_SEGMENTS = 512;
export const MARKDOWN_ANNOTATION_TOO_MANY_SEGMENTS
    = 'MKTERO_ANNOTATION_TOO_MANY_SEGMENTS';

export function assertMarkdownAnnotationSegmentLimit(ranges) {
    if (!Array.isArray(ranges)
        || ranges.filter(range => validRange(range)).length
            <= MAX_MARKDOWN_ANNOTATION_SEGMENTS) {
        return;
    }
    const error = new Error('Markdown annotation has too many segments');
    error.code = MARKDOWN_ANNOTATION_TOO_MANY_SEGMENTS;
    throw error;
}

export function isLocalMarkdownAnnotationID(annotationID) {
    return LOCAL_ANNOTATION_ID.test(String(annotationID || ''));
}

export class MarkdownLocalAnnotations {
    constructor({
        store,
        createID = createAnnotationID,
        createPDFAnnotation = null,
        deletePDFAnnotation = null,
        updatePDFAnnotationComment = null,
        changePDFAnnotationColor = null,
        // Told the Zotero annotation keys one synchronized highlight became,
        // when it crossed a page and became several.
        onPDFAnnotationGroup = () => {},
        // Told the Zotero annotation keys this layer deleted.
        onPDFAnnotationsDeleted = () => {},
        onError = () => {},
        onSynchronizationChange = () => {},
    }) {
        if (!store?.get || !store?.put) {
            throw new TypeError('A Markdown annotation store is required');
        }
        this.store = store;
        this.createID = createID;
        this.createPDFAnnotation = createPDFAnnotation;
        this.deletePDFAnnotation = deletePDFAnnotation;
        this.updatePDFAnnotationComment = updatePDFAnnotationComment;
        this.changePDFAnnotationColor = changePDFAnnotationColor;
        this.onPDFAnnotationGroup = onPDFAnnotationGroup;
        this.onPDFAnnotationsDeleted = onPDFAnnotationsDeleted;
        this.onError = onError;
        this.onSynchronizationChange = onSynchronizationChange;
        // itemID -> local id -> PDF annotation ids this extension created.
        this.ownedPDFAnnotations = new Map();
        // itemID -> local id -> PDF annotation ids it was synchronized into.
        this.synchronizedAliases = new Map();
        this.operationTails = new Map();
        this.synchronizationRequests = new Map();
        this.synchronizationContexts = new Map();
        this.synchronizationTasks = new Map();
        this.synchronizationFailures = new Map();
        this.blockedSynchronizations = new Map();
        this.setAsideItems = new Set();
        this.active = true;
    }

    async resolve(itemID, markdown, {
        retryFailed = false,
        sourceMap = null,
    } = {}) {
        if (typeof markdown !== 'string') {
            throw new TypeError('Markdown must be a string');
        }
        const resolution = await this.#withOperation(itemID, () => (
            this.#resolve(itemID, markdown, sourceMap)
        ));
        let { result } = resolution;
        const failures = this.synchronizationFailures.get(itemID);
        result = applySynchronizationStates(result, failures);
        const matchedIDs = result.matched.map(annotation => annotation.id);
        let retryIDs = retryFailed
            ? matchedIDs
            : matchedIDs.filter(id => !failures?.has(id));
        retryIDs = retryIDs.filter(id => (
            !resolution.blockedSynchronizationIDs.has(id)
        ));
        this.#requestSynchronization(itemID, retryIDs);
        if (this.setAsideItems.has(itemID)) {
            result.warning ||= MARKDOWN_ANNOTATIONS_SET_ASIDE_WARNING;
        }
        if ([...result.matched, ...result.unmatched]
            .some(annotation => failures?.has(annotation.id))) {
            result.warning ||= 'Some local Markdown annotations could not be synchronized to the PDF.';
        }
        return result;
    }

    async #resolve(itemID, markdown, sourceMap) {
        let annotations;
        let resolved;
        try {
            annotations = await this.#readCollection(itemID);
            resolved = resolveAnnotations(markdown, annotations);
        }
        catch (error) {
            this.#reportError(error);
            return {
                result: {
                    matched: [],
                    unmatched: [],
                    warning: 'Local Markdown annotations could not be loaded.',
                },
                blockedSynchronizationIDs: new Set(),
            };
        }
        const refreshed = refreshAnnotationAnchors(
            annotations,
            resolved.matched,
            sourceMap,
            markdown
        );
        const matchedIDs = resolved.matched.map(annotation => annotation.id);
        if (!refreshed.changed) {
            this.#clearSynchronizationBlocks(itemID, matchedIDs);
            return {
                result: resolved,
                blockedSynchronizationIDs: new Set(),
            };
        }
        const refreshedResult = {
            ...resolved,
            matched: resolved.matched.map(annotation => {
                const current = refreshed.byID.get(annotation.id);
                return applyRefreshedAnnotationAnchors(annotation, current);
            }),
        };
        try {
            validateAggregateBudget(refreshed.annotations);
            await this.store.put(itemID, refreshed.annotations);
        }
        catch (error) {
            this.#reportError(error);
            this.#clearSynchronizationBlocks(
                itemID,
                matchedIDs.filter(id => !refreshed.changedIDs.has(id))
            );
            this.#blockSynchronization(itemID, refreshed.changedIDs);
            return {
                result: refreshedResult,
                blockedSynchronizationIDs: refreshed.changedIDs,
            };
        }
        this.#clearSynchronizationBlocks(itemID, matchedIDs);
        return {
            result: refreshedResult,
            blockedSynchronizationIDs: new Set(),
        };
    }

    async create(itemID, draft) {
        const created = await this.#withOperation(itemID, async () => {
            assertMarkdownAnnotationSegmentLimit(draft?.ranges);
            const annotation = normalizeAnnotation({
                ...draft,
                id: `mktero-${this.createID()}`,
                source: 'markdown',
                type: 'highlight',
            });
            const annotations = await this.#readCollection(itemID);
            if (annotations.length >= MAX_LOCAL_ANNOTATIONS) {
                throw new Error('Markdown annotation count exceeds the safety limit');
            }
            validateAggregateBudget([...annotations, annotation]);
            await this.#writeUserChange(itemID, [...annotations, annotation]);
            return resolvedAnnotation(annotation, annotation.ranges);
        });
        this.#clearSynchronizationFailure(itemID, created.id);
        this.#clearSynchronizationBlocks(itemID, [created.id]);
        this.#requestSynchronization(itemID, [created.id]);
        return created;
    }

    // The PDF annotation ids a synchronized local highlight now lives in, or
    // null while it is still local (or was never synchronized).
    synchronizedAnnotationIDs(itemID, annotationID) {
        const alias = this.synchronizedAliases
            .get(itemID)
            ?.get(String(annotationID || ''));
        return alias ? [...alias.parts] : null;
    }

    // The parts of a synchronized highlight this extension created. A part it
    // reused is a highlight the user made in Zotero: a delete must not reach
    // it.
    #ownedSynchronizedIDs(itemID, annotationID) {
        const alias = this.synchronizedAliases
            .get(itemID)
            ?.get(String(annotationID || ''));
        return alias ? [...alias.owned] : [];
    }

    async update(itemID, annotationID, changes) {
        let redirect = null;
        const updated = await this.#withOperation(itemID, async () => {
            const annotations = await this.#readCollection(itemID);
            const targetID = String(annotationID || '');
            const index = annotations.findIndex(annotation => (
                annotation.id === targetID
            ));
            if (index < 0) {
                redirect = this.synchronizedAnnotationIDs(itemID, targetID);
                if (redirect) return null;
                throw new Error('Markdown annotation is unavailable');
            }
            assertMarkdownAnnotationSegmentLimit(changes?.ranges);
            const annotation = normalizeAnnotation({
                ...annotations[index],
                ...changes,
                id: targetID,
                source: 'markdown',
                type: 'highlight',
            });
            const updated = annotations.map((existing, annotationIndex) => (
                annotationIndex === index ? annotation : existing
            ));
            validateAggregateBudget(updated);
            await this.#writeUserChange(itemID, updated);
            return resolvedAnnotation(annotation, annotation.ranges);
        });
        if (redirect) {
            await this.#updateSynchronizedAnnotation(itemID, redirect, changes);
            return null;
        }
        this.#clearSynchronizationFailure(itemID, updated.id);
        this.#clearSynchronizationBlocks(itemID, [updated.id]);
        this.#requestSynchronization(itemID, [updated.id]);
        return updated;
    }

    // Resolves with the PDF annotation ids it deleted when the highlight had
    // already been synchronized into the PDF, and with nothing otherwise.
    async delete(itemID, annotationID) {
        const targetID = String(annotationID || '');
        let redirect = null;
        await this.#withOperation(itemID, async () => {
            const annotations = await this.#readCollection(itemID);
            const updated = annotations.filter(annotation => (
                annotation.id !== targetID
            ));
            if (updated.length === annotations.length) {
                redirect = this.synchronizedAnnotationIDs(itemID, targetID);
                if (redirect) return;
                throw new Error('Markdown annotation is unavailable');
            }
            await this.#writeUserChange(itemID, updated);
        });
        if (redirect) {
            if (typeof this.deletePDFAnnotation !== 'function') {
                throw new Error('PDF annotation deletion is unavailable');
            }
            const deleted = await this.#eachPart(
                this.#ownedSynchronizedIDs(itemID, targetID),
                id => this.deletePDFAnnotation(itemID, id)
            );
            this.synchronizedAliases.get(itemID)?.delete(targetID);
            this.#notifyHook(this.onPDFAnnotationsDeleted, itemID, deleted);
            return deleted;
        }
        this.#clearSynchronizationFailure(itemID, targetID);
        this.#clearSynchronizationBlocks(itemID, [targetID]);
    }

    // A note belongs to the first page part, as when the highlight was
    // created; a color covers every part.
    async #updateSynchronizedAnnotation(itemID, pdfAnnotationIDs, changes) {
        const hasComment = Object.hasOwn(changes || {}, 'comment');
        const hasColor = Object.hasOwn(changes || {}, 'color');
        if (hasComment) {
            if (typeof this.updatePDFAnnotationComment !== 'function') {
                throw new Error('PDF annotation comment changes are unavailable');
            }
            await this.updatePDFAnnotationComment(
                itemID,
                pdfAnnotationIDs[0],
                String(changes.comment ?? '')
            );
        }
        if (hasColor) {
            if (typeof this.changePDFAnnotationColor !== 'function') {
                throw new Error('PDF annotation color changes are unavailable');
            }
            await this.#eachPart(pdfAnnotationIDs, id => (
                this.changePDFAnnotationColor(itemID, id, changes.color)
            ));
        }
    }

    async remapRanges(itemID, mappings, markdown, { sourceMap = null } = {}) {
        if (typeof markdown !== 'string') {
            throw new TypeError('Markdown must be a string');
        }
        const normalizedMappings = normalizeRangeMappings(
            mappings,
            markdown.length
        );
        if (!normalizedMappings.size) return;
        await this.#withOperation(itemID, async () => {
            const annotations = await this.#readCollection(itemID);
            const updated = annotations.map(annotation => {
                const mapping = normalizedMappings.get(annotation.id);
                if (!mapping) return annotation;
                const ranges = annotation.ranges.map((range, index) => {
                    const next = mapping.get(index);
                    return next
                        ? { from: next.from, to: next.to }
                        : { from: range.from, to: range.to };
                });
                if (!markdownAnnotationRangeMatchesSource(
                    markdown,
                    ranges,
                    annotation.text
                )) {
                    throw new Error(
                        'Mapped Markdown annotation no longer matches its text'
                    );
                }
                return {
                    ...annotation,
                    ranges,
                };
            });
            const matched = updated.flatMap(annotation => (
                normalizedMappings.has(annotation.id)
                    ? [resolvedAnnotation(annotation, annotation.ranges)]
                    : []
            ));
            const refreshed = refreshAnnotationAnchors(
                updated,
                matched,
                sourceMap,
                markdown
            );
            validateAggregateBudget(refreshed.annotations);
            await this.store.put(itemID, refreshed.annotations);
        });
    }

    async synchronizePending(itemID, context = null) {
        const annotationIDs = await this.#withOperation(itemID, async () => (
            (await this.#readCollection(itemID))
                .map(annotation => annotation.id)
        ));
        this.#requestSynchronization(itemID, annotationIDs, context);
    }

    async retrySynchronization(itemID, annotationID, context = null) {
        const targetID = String(annotationID || '');
        await this.#withOperation(itemID, async () => {
            const annotations = await this.#readCollection(itemID);
            if (!annotations.some(annotation => annotation.id === targetID)) {
                throw new Error('Markdown annotation is unavailable');
            }
        });
        this.#clearSynchronizationFailure(itemID, targetID);
        this.#requestSynchronization(itemID, [targetID], context);
        return {
            id: targetID,
            synchronization: { status: 'pending' },
        };
    }

    dispose() {
        this.active = false;
        this.synchronizationRequests.clear();
        this.synchronizationContexts.clear();
        this.blockedSynchronizations.clear();
        this.setAsideItems.clear();
        this.ownedPDFAnnotations.clear();
        this.synchronizedAliases.clear();
    }

    // Callers hold the item's operation lock.
    async #readCollection(itemID) {
        let stored;
        try {
            stored = await this.store.get(itemID);
        }
        catch (error) {
            // A read failure may be temporary, so nothing is written over
            // annotations that could still be intact on disk.
            if (!isInvalidMarkdownAnnotationStoreError(error)) throw error;
            await this.#setAside(itemID, error);
            return [];
        }
        let normalized;
        try {
            normalized = normalizeStoredCollection(stored);
        }
        catch (error) {
            await this.#setAside(
                itemID,
                invalidMarkdownAnnotationStoreError(error.message, error)
            );
            return [];
        }
        if (!normalized.rejectedError) return normalized.annotations;
        // One damaged entry must not hide the others: the whole file is kept
        // as a backup and the entries that still validate are written back.
        await this.#setAside(itemID, invalidMarkdownAnnotationStoreError(
            normalized.rejectedError.message,
            normalized.rejectedError
        ));
        if (normalized.annotations.length) {
            await this.store.put(itemID, normalized.annotations);
        }
        return normalized.annotations;
    }

    // Damaged annotations are user data, so they are kept under another name
    // instead of being deleted. The item then takes new annotations.
    async #setAside(itemID, error) {
        if (typeof this.store.setAside !== 'function') throw error;
        try {
            await this.store.setAside(itemID);
        }
        catch (setAsideError) {
            this.#reportError(setAsideError);
            throw error;
        }
        this.#reportError(error);
        this.setAsideItems.add(itemID);
    }

    // Background writes (anchor refresh, remapping, synchronization) keep the
    // set-aside warning; it clears once the reader edits an annotation.
    async #writeUserChange(itemID, annotations) {
        await this.store.put(itemID, annotations);
        this.setAsideItems.delete(itemID);
    }

    #requestSynchronization(itemID, annotationIDs, context = null) {
        if (!this.active
            || typeof this.createPDFAnnotation !== 'function') {
            return;
        }
        const allowedIDs = annotationIDs.filter(annotationID => (
            !this.#isSynchronizationBlocked(itemID, annotationID)
        ));
        if (allowedIDs.length) {
            let requested = this.synchronizationRequests.get(itemID);
            if (!requested) {
                requested = new Set();
                this.synchronizationRequests.set(itemID, requested);
            }
            for (const annotationID of allowedIDs) {
                requested.add(annotationID);
            }
            if (context !== null) {
                this.synchronizationContexts.set(itemID, context);
            }
        }
        if (!this.synchronizationRequests.get(itemID)?.size) return;
        if (this.synchronizationTasks.has(itemID)) return;
        const task = this.#runSynchronization(itemID)
            .catch(error => this.#reportError(error))
            .finally(() => {
                if (this.synchronizationTasks.get(itemID) === task) {
                    this.synchronizationTasks.delete(itemID);
                }
                if (this.active
                    && this.synchronizationRequests.get(itemID)?.size) {
                    this.#requestSynchronization(itemID, []);
                }
            });
        this.synchronizationTasks.set(itemID, task);
    }

    async #runSynchronization(itemID) {
        while (this.active) {
            const requested = this.synchronizationRequests.get(itemID);
            if (!requested?.size) return;
            const annotationIDs = new Set(requested);
            this.synchronizationRequests.delete(itemID);
            const context = this.synchronizationContexts.get(itemID) || null;
            this.synchronizationContexts.delete(itemID);
            const annotations = await this.#withOperation(itemID, async () => (
                (await this.#readCollection(itemID))
                    .filter(annotation => annotationIDs.has(annotation.id))
            ));
            for (const annotation of annotations) {
                if (!this.active) return;
                if (this.#isSynchronizationBlocked(itemID, annotation.id)) {
                    continue;
                }
                await this.#synchronizeAnnotation(itemID, annotation, context);
            }
        }
    }

    async #synchronizeAnnotation(itemID, annotation, context) {
        try {
            const owned = this.ownedPDFAnnotations
                .get(itemID)
                ?.get(annotation.id);
            const saved = await this.createPDFAnnotation(itemID, {
                text: annotation.text,
                comment: annotation.comment,
                color: annotation.color,
                ranges: annotation.ranges,
                ...(owned?.size
                    ? { ownedAnnotationIDs: [...owned] }
                    : {}),
                ...(annotation.pdfPageIndexHint === undefined
                    ? {}
                    : { pdfPageIndexHint: annotation.pdfPageIndexHint }),
                ...(annotation.pdfRegion ? { pdfRegion: annotation.pdfRegion } : {}),
                ...(annotation.textQuote
                    ? { textQuote: annotation.textQuote }
                    : {}),
            }, context);
            if (saved?.deferred) return;
            this.#rememberOwnedAnnotations(
                itemID,
                annotation.id,
                createdPDFAnnotationIDs(saved)
            );
            const status = await this.#withOperation(itemID, async () => {
                const current = await this.#readCollection(itemID);
                const target = current.find(existing => (
                    existing.id === annotation.id
                ));
                if (!target) return 'deleted';
                if (!sameAnnotation(target, annotation)) return 'changed';
                await this.store.put(
                    itemID,
                    current.filter(existing => existing.id !== annotation.id)
                );
                // Recorded under the same lock as the removal, so an update
                // queued behind it finds either the record or the alias.
                this.#rememberSynchronizedAlias(
                    itemID,
                    annotation.id,
                    synchronizedPDFAnnotationIDs(saved),
                    this.#ownedIDs(itemID, annotation.id)
                );
                return 'removed';
            });
            this.#clearSynchronizationFailure(itemID, annotation.id);
            if (status === 'removed') {
                // Only the parts this extension created form the group, so a
                // grouped delete can never reach a highlight the user made.
                const owned = new Set(
                    this.#forgetOwnedAnnotations(itemID, annotation.id)
                );
                const parts = synchronizedPDFAnnotationIDs(saved)
                    .filter(id => owned.has(id));
                if (parts.length > 1) {
                    this.#notifyHook(this.onPDFAnnotationGroup, itemID, parts);
                }
                this.#clearSynchronizationBlocks(itemID, [annotation.id]);
                this.#notifySynchronizationChange(itemID);
            }
            else if (status === 'changed') {
                this.#requestSynchronization(
                    itemID,
                    [annotation.id],
                    context
                );
            }
            else {
                // The local draft was deleted while it synchronized. Remove
                // every PDF annotation this extension created for it, including
                // ones an earlier pass created and this pass only reused.
                const ownedIDs = this.#forgetOwnedAnnotations(
                    itemID,
                    annotation.id
                );
                if (typeof this.deletePDFAnnotation === 'function') {
                    const deleted = [];
                    for (const annotationID of ownedIDs) {
                        try {
                            await this.deletePDFAnnotation(itemID, annotationID);
                            deleted.push(annotationID);
                        }
                        catch (error) {
                            this.#reportError(error);
                        }
                    }
                    if (deleted.length) {
                        this.#notifyHook(
                            this.onPDFAnnotationsDeleted,
                            itemID,
                            deleted
                        );
                    }
                }
            }
        }
        catch (error) {
            let failures = this.synchronizationFailures.get(itemID);
            if (!failures) {
                failures = new Map();
                this.synchronizationFailures.set(itemID, failures);
            }
            const reason = synchronizationFailureReason(error);
            const changed = failures.get(annotation.id) !== reason;
            failures.set(annotation.id, reason);
            this.#reportError(error);
            if (changed) this.#notifySynchronizationChange(itemID);
        }
    }

    #rememberOwnedAnnotations(itemID, annotationID, pdfAnnotationIDs) {
        if (!pdfAnnotationIDs.length) return;
        let byLocalID = this.ownedPDFAnnotations.get(itemID);
        if (!byLocalID) {
            byLocalID = new Map();
            this.ownedPDFAnnotations.set(itemID, byLocalID);
        }
        let owned = byLocalID.get(annotationID);
        if (!owned) {
            owned = new Set();
            byLocalID.set(annotationID, owned);
        }
        for (const pdfAnnotationID of pdfAnnotationIDs) {
            owned.add(pdfAnnotationID);
        }
    }

    #ownedIDs(itemID, annotationID) {
        const owned = this.ownedPDFAnnotations.get(itemID)?.get(annotationID);
        return owned ? [...owned] : [];
    }

    #forgetOwnedAnnotations(itemID, annotationID) {
        const byLocalID = this.ownedPDFAnnotations.get(itemID);
        const owned = byLocalID?.get(annotationID);
        byLocalID?.delete(annotationID);
        if (byLocalID && !byLocalID.size) {
            this.ownedPDFAnnotations.delete(itemID);
        }
        return owned ? [...owned] : [];
    }

    #rememberSynchronizedAlias(itemID, annotationID, pdfAnnotationIDs, ownedIDs) {
        if (!pdfAnnotationIDs.length) return;
        let aliases = this.synchronizedAliases.get(itemID);
        if (!aliases) {
            aliases = new Map();
            this.synchronizedAliases.set(itemID, aliases);
        }
        const owned = new Set(ownedIDs);
        aliases.delete(annotationID);
        aliases.set(annotationID, Object.freeze({
            parts: Object.freeze([...pdfAnnotationIDs]),
            owned: Object.freeze(pdfAnnotationIDs.filter(id => owned.has(id))),
        }));
        while (aliases.size > MAX_SYNCHRONIZED_ALIASES_PER_ITEM) {
            aliases.delete(aliases.keys().next().value);
        }
    }

    #clearSynchronizationFailure(itemID, annotationID) {
        const failures = this.synchronizationFailures.get(itemID);
        failures?.delete(annotationID);
        if (!failures?.size) this.synchronizationFailures.delete(itemID);
    }

    #blockSynchronization(itemID, annotationIDs) {
        if (!annotationIDs.size) return;
        let blocked = this.blockedSynchronizations.get(itemID);
        if (!blocked) {
            blocked = new Set();
            this.blockedSynchronizations.set(itemID, blocked);
        }
        const requested = this.synchronizationRequests.get(itemID);
        for (const annotationID of annotationIDs) {
            blocked.add(annotationID);
            requested?.delete(annotationID);
        }
        if (!requested?.size) this.synchronizationRequests.delete(itemID);
    }

    #clearSynchronizationBlocks(itemID, annotationIDs) {
        const blocked = this.blockedSynchronizations.get(itemID);
        for (const annotationID of annotationIDs) {
            blocked?.delete(annotationID);
        }
        if (!blocked?.size) this.blockedSynchronizations.delete(itemID);
    }

    #isSynchronizationBlocked(itemID, annotationID) {
        return this.blockedSynchronizations.get(itemID)?.has(annotationID)
            || false;
    }

    #notifySynchronizationChange(itemID) {
        try {
            const pending = this.onSynchronizationChange(itemID);
            Promise.resolve(pending).catch(error => this.#reportError(error));
        }
        catch (error) {
            this.#reportError(error);
        }
    }

    // Runs the action on every part. A part that no longer exists (deleted in
    // the Zotero reader) is skipped; any other failure is raised after the
    // rest ran, so one part cannot stop the others. Resolves with the ids
    // the action reached.
    async #eachPart(pdfAnnotationIDs, action) {
        const reached = [];
        let failure = null;
        for (const id of pdfAnnotationIDs) {
            try {
                await action(id);
                reached.push(id);
            }
            catch (error) {
                if (isPDFAnnotationUnavailableError(error)) continue;
                failure ||= error;
            }
        }
        if (failure) throw failure;
        return reached;
    }

    #notifyHook(hook, itemID, annotationIDs) {
        try {
            const pending = hook(itemID, [...annotationIDs]);
            Promise.resolve(pending).catch(error => this.#reportError(error));
        }
        catch (error) {
            this.#reportError(error);
        }
    }

    #reportError(error) {
        try {
            this.onError(error);
        }
        catch {
            // Annotation diagnostics must not make the Markdown view fail.
        }
    }

    async #withOperation(itemID, operation) {
        const previous = this.operationTails.get(itemID) || Promise.resolve();
        const pending = previous.catch(() => {}).then(operation);
        this.operationTails.set(itemID, pending);
        try {
            return await pending;
        }
        finally {
            if (this.operationTails.get(itemID) === pending) {
                this.operationTails.delete(itemID);
            }
        }
    }
}

// The PDF annotation ids a synchronization pass created, as opposed to
// existing ones it matched and reused.
function createdPDFAnnotationIDs(saved) {
    if (!saved || typeof saved !== 'object') return [];
    if (Array.isArray(saved.createdAnnotationIDs)) {
        return saved.createdAnnotationIDs.map(String).filter(Boolean);
    }
    if (saved.reused) return [];
    if (Array.isArray(saved.annotationIDs)) {
        return saved.annotationIDs.map(String).filter(Boolean);
    }
    return saved.id ? [String(saved.id)] : [];
}

// Every PDF annotation id a synchronized highlight is now made of, primary
// part first.
function synchronizedPDFAnnotationIDs(saved) {
    if (!saved || typeof saved !== 'object') return [];
    if (Array.isArray(saved.annotationIDs) && saved.annotationIDs.length) {
        return saved.annotationIDs.map(String).filter(Boolean);
    }
    return saved.id ? [String(saved.id)] : [];
}

export function mergeAnnotationOverlays(...overlays) {
    return overlays.reduce((merged, overlay) => ({
        matched: [...merged.matched, ...(overlay?.matched || [])],
        unmatched: [...merged.unmatched, ...(overlay?.unmatched || [])],
    }), { matched: [], unmatched: [] });
}

function resolveAnnotations(markdown, annotations) {
    if (markdown.length > MAX_MATCHABLE_MARKDOWN_LENGTH) {
        throw new Error('Markdown exceeds the local annotation matching limit');
    }
    const matched = [];
    const unmatched = [];
    const indexes = { markdown, visible: null, normalized: null };
    for (const annotation of annotations) {
        const expandedRanges = annotation.ranges.map(range => (
            expandMarkdownRangeToMathBoundaries(markdown, range)
        ));
        if (markdownAnnotationRangeMatchesSource(
            markdown,
            expandedRanges,
            annotation.text
        )) {
            matched.push(resolvedAnnotation(annotation, expandedRanges));
            continue;
        }
        let result = locateAnnotationText(indexes, annotation, annotation.text);
        // A caption highlight saved before the reader undid an image
        // description's doubled backslash still reads "\\Delta". Its text
        // is also tried as the reader now reads it, and the two must not land
        // in different places.
        const legacyText = unescapeImageMathText(annotation.text);
        if (!result.ambiguous && legacyText !== annotation.text) {
            result = pickLocatedText(
                result,
                locateAnnotationText(indexes, annotation, legacyText)
            );
        }
        if (result.range) {
            matched.push(resolvedAnnotation(annotation, result.range));
            continue;
        }
        unmatched.push({
            ...annotation,
            reason: result.ambiguous ? 'ambiguous' : 'not-found',
        });
    }
    return { matched, unmatched };
}

// Either reading may be the one the highlight was made on, so a place only
// one of them finds is kept when the other finds no place at all.
function pickLocatedText(saved, legacy) {
    if (saved.ambiguous || legacy.ambiguous) return { range: null, ambiguous: true };
    if (saved.range && legacy.range) {
        return saved.range.from === legacy.range.from
            && saved.range.to === legacy.range.to
            ? saved
            : { range: null, ambiguous: true };
    }
    return saved.range ? saved : legacy;
}

// Finds a moved annotation by its text, exact first and then as PDF text.
function locateAnnotationText(indexes, annotation, text) {
    const { markdown } = indexes;
    indexes.visible ||= createVisibleMarkdownTextIndex(markdown, [], {
        imageMath: true,
    });
    const visibleIndex = indexes.visible;
    const candidates = findTextOccurrences(
        visibleIndex.text,
        text,
        MAX_MATCH_CANDIDATES
    );
    let ambiguous = candidates.truncated || candidates.offsets.length > 1;
    if (!candidates.truncated && candidates.offsets.length > 1) {
        const selected = selectOffsetByTextQuote(
            visibleIndex.text,
            candidates.offsets,
            text.length,
            annotation.textQuote
        );
        if (selected !== null) {
            return {
                range: expandMarkdownRangeToMathBoundaries(
                    markdown,
                    visibleIndex.sourceRange(selected, text.length)
                ),
            };
        }
    }
    if (!candidates.truncated && candidates.offsets.length === 1) {
        return {
            range: expandMarkdownRangeToMathBoundaries(
                markdown,
                visibleIndex.sourceRange(candidates.offsets[0], text.length)
            ),
        };
    }
    const normalizedText = normalizePdfAnnotationText(text);
    if (!candidates.truncated
        && !candidates.offsets.length
        && normalizedText) {
        indexes.normalized ||= createPdfAnnotationTextIndex(
            visibleIndex.text,
            offset => visibleIndex.sourceOffsetAt(offset)
        );
        const normalizedCandidates = findTextOccurrences(
            indexes.normalized.text,
            normalizedText,
            MAX_MATCH_CANDIDATES
        );
        if (!normalizedCandidates.truncated
            && normalizedCandidates.offsets.length === 1) {
            return {
                range: expandMarkdownRangeToMathBoundaries(
                    markdown,
                    indexes.normalized.sourceRange(
                        normalizedCandidates.offsets[0],
                        normalizedText.length
                    )
                ),
            };
        }
        ambiguous = normalizedCandidates.truncated
            || normalizedCandidates.offsets.length > 1;
    }
    return { range: null, ambiguous };
}

function selectOffsetByTextQuote(text, offsets, length, quote) {
    const prefix = normalizeVisibleText(quote?.prefix || '');
    const suffix = normalizeVisibleText(quote?.suffix || '');
    if (!prefix && !suffix) return null;
    const prefixWindow = Math.max(prefix.length * 4, 64);
    const suffixWindow = Math.max(suffix.length * 4, 64);
    const scores = offsets.map(offset => {
        const before = normalizeVisibleText(text.slice(
            Math.max(0, offset - prefixWindow),
            offset
        ));
        const after = normalizeVisibleText(text.slice(
            offset + length,
            Math.min(text.length, offset + length + suffixWindow)
        ));
        return (prefix && before.endsWith(prefix) ? prefix.length : 0)
            + (suffix && after.startsWith(suffix) ? suffix.length : 0);
    });
    let best = 0;
    let bestIndex = -1;
    let runnerUp = 0;
    for (const [index, score] of scores.entries()) {
        if (score > best) {
            runnerUp = best;
            best = score;
            bestIndex = index;
        }
        else if (score > runnerUp) {
            runnerUp = score;
        }
    }
    return best > 0 && best > runnerUp ? offsets[bestIndex] : null;
}

export function markdownAnnotationRangeMatchesSource(markdown, rangeOrRanges, text) {
    const source = String(markdown || '');
    const ranges = Array.isArray(rangeOrRanges)
        ? rangeOrRanges
        : rangeOrRanges
            ? [rangeOrRanges]
            : [];
    if (!ranges.length
        || ranges.some(range => !validRange(range, source.length))) {
        return false;
    }
    const normalized = normalizeVisibleText(text);
    if (normalizeVisibleText(visibleMarkdownTextForRanges(source, ranges))
        === normalized) {
        return true;
    }
    // Ranges saved by the slice re-parser still carry its leaked markers.
    return normalizeVisibleText(
        legacyVisibleMarkdownTextForRanges(source, ranges)
    ) === normalized;
}

export function createMarkdownAnnotationTextQuote(
    markdown,
    rangeOrRanges,
    chromeRanges = []
) {
    const source = String(markdown || '');
    const ranges = Array.isArray(rangeOrRanges)
        ? rangeOrRanges
        : rangeOrRanges
            ? [rangeOrRanges]
            : [];
    if (!ranges.length
        || ranges.some(range => !validRange(range, source.length))) {
        return null;
    }
    const visible = createVisibleMarkdownTextIndex(source, chromeRanges, {
        imageMath: true,
    });
    return createTextQuoteFromVisibleIndex({
        from: ranges[0].from,
        to: ranges.at(-1).to,
    }, visible);
}

function createTextQuoteFromVisibleIndex(range, visible) {
    const visibleFrom = visible.visibleOffsetAt(range.from);
    const visibleTo = visible.visibleOffsetAt(range.to);
    const textQuote = normalizePDFAnnotationTextQuote({
        prefix: trailingCodePoints(
            visible.text,
            MARKDOWN_ANNOTATION_CONTEXT_CODE_POINTS,
            visibleFrom
        ),
        suffix: leadingCodePoints(
            visible.text,
            MARKDOWN_ANNOTATION_CONTEXT_CODE_POINTS,
            visibleTo
        ),
    });
    return textQuote;
}

function resolvedAnnotation(annotation, rangeOrRanges) {
    const ranges = (Array.isArray(rangeOrRanges)
        ? rangeOrRanges
        : [rangeOrRanges]
    ).map(range => ({ from: range.from, to: range.to }));
    return {
        ...annotation,
        matchKind: 'local',
        ranges,
        sortIndex: String(ranges[0].from).padStart(12, '0'),
        synchronization: { status: 'pending' },
    };
}

function applySynchronizationStates(result, failures) {
    const applyState = annotation => {
        const reason = failures?.get(annotation.id);
        return {
            ...annotation,
            synchronization: reason
                ? { status: 'failed', reason }
                : { status: 'pending' },
        };
    };
    return {
        ...result,
        matched: result.matched.map(applyState),
        unmatched: result.unmatched.map(applyState),
    };
}

function synchronizationFailureReason(error) {
    return SYNCHRONIZATION_FAILURE_REASONS.get(error?.code) || 'unknown';
}

function sameAnnotation(left, right) {
    return left.id === right.id
        && left.text === right.text
        && left.comment === right.comment
        && left.color === right.color
        && left.pdfPageIndexHint === right.pdfPageIndexHint
        && samePDFRegion(left.pdfRegion, right.pdfRegion)
        && sameTextQuote(left.textQuote, right.textQuote)
        && sameStoredRanges(left.ranges, right.ranges);
}

function sameTextQuote(left, right) {
    return left?.prefix === right?.prefix && left?.suffix === right?.suffix;
}

// Entries are validated one at a time so one damaged annotation does not
// hide the rest. The collection as a whole must still fit the budgets.
function normalizeStoredCollection(value) {
    if (!Array.isArray(value) || value.length > MAX_LOCAL_ANNOTATIONS) {
        throw new Error('Invalid Markdown annotation collection');
    }
    const annotations = [];
    let rejectedError = null;
    for (const entry of value) {
        try {
            annotations.push(normalizeAnnotation(entry));
        }
        catch (error) {
            rejectedError ||= error;
        }
    }
    validateAggregateBudget(annotations);
    return { annotations, rejectedError };
}

function normalizeAnnotation(value) {
    const id = String(value?.id || '');
    const text = String(value?.text || '');
    const comment = String(value?.comment || '');
    const color = String(value?.color || DEFAULT_ANNOTATION_COLOR).toLowerCase();
    const ranges = normalizeAnnotationRanges(value?.ranges);
    const pdfPageIndexHint = value?.pdfPageIndexHint;
    const pdfRegion = normalizePDFRegion(value?.pdfRegion);
    let textQuote;
    try {
        textQuote = normalizePDFAnnotationTextQuote(value?.textQuote);
    }
    catch {
        throw new Error('Invalid Markdown annotation');
    }
    if (!LOCAL_ANNOTATION_ID.test(id)
        || value?.source !== 'markdown'
        || value?.type !== 'highlight'
        || !text.trim()
        || text.length > MAX_PDF_ANNOTATION_TEXT_LENGTH
        || comment.length > MAX_PDF_ANNOTATION_TEXT_LENGTH
        || !isZoteroAnnotationColor(color)
        || (pdfPageIndexHint !== undefined
            && (!Number.isSafeInteger(pdfPageIndexHint)
                || pdfPageIndexHint < 0))
        || (value?.pdfRegion !== undefined && !pdfRegion)
        || !ranges.length) {
        throw new Error('Invalid Markdown annotation');
    }
    return {
        id,
        source: 'markdown',
        type: 'highlight',
        text,
        comment,
        color,
        ranges,
        ...(pdfPageIndexHint === undefined ? {} : { pdfPageIndexHint }),
        ...(pdfRegion ? { pdfRegion } : {}),
        ...(textQuote ? { textQuote } : {}),
    };
}

function normalizePDFRegion(value) {
    if (value === undefined || value === null) return null;
    const pageIndex = value?.pageIndex;
    const bbox = value?.bbox;
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) return null;
    if (!Array.isArray(bbox) || bbox.length !== 4) return null;
    if (!bbox.every(coordinate => (
        Number.isFinite(coordinate)
        && coordinate >= 0
        && coordinate <= 1000
    ))) {
        return null;
    }
    if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) return null;
    return { pageIndex, bbox: [...bbox] };
}

function samePDFRegion(left, right) {
    if (!left || !right) return !left === !right;
    return left.pageIndex === right.pageIndex
        && left.bbox.every((value, index) => value === right.bbox[index]);
}

function normalizeAnnotationRanges(ranges) {
    if (!Array.isArray(ranges) || !validRange(ranges[0])) return [];
    const normalized = [];
    for (const range of ranges) {
        if (!validRange(range)) continue;
        normalized.push({ from: range.from, to: range.to });
        if (normalized.length === MAX_MARKDOWN_ANNOTATION_SEGMENTS) break;
    }
    return normalized;
}

function sameStoredRanges(left, right) {
    return Array.isArray(left)
        && Array.isArray(right)
        && left.length === right.length
        && left.every((range, index) => (
            range.from === right[index].from && range.to === right[index].to
        ));
}

function normalizeRangeMappings(mappings, documentLength) {
    const normalized = new Map();
    for (const mapping of Array.isArray(mappings) ? mappings : []) {
        if (mapping?.source !== 'markdown'
            || !LOCAL_ANNOTATION_ID.test(String(mapping?.id || ''))
            || !Number.isSafeInteger(mapping.rangeIndex)
            || mapping.rangeIndex < 0
            || mapping.rangeIndex >= MAX_MARKDOWN_ANNOTATION_SEGMENTS
            || !validRange(mapping, documentLength)) {
            continue;
        }
        const id = String(mapping.id);
        let ranges = normalized.get(id);
        if (!ranges) {
            ranges = new Map();
            normalized.set(id, ranges);
        }
        ranges.set(mapping.rangeIndex, {
            from: mapping.from,
            to: mapping.to,
        });
    }
    return normalized;
}

function refreshAnnotationAnchors(
    annotations,
    matched,
    sourceMap,
    markdown
) {
    const matchedRanges = new Map(matched.map(annotation => (
        [annotation.id, annotation.ranges]
    )));
    const visible = matchedRanges.size
        ? createVisibleMarkdownTextIndex(markdown, [], { imageMath: true })
        : null;
    let remainingWork = MAX_SOURCE_MAP_PAGE_HINT_WORK;
    let changed = false;
    const changedIDs = new Set();
    const updated = annotations.map(annotation => {
        const ranges = matchedRanges.get(annotation.id);
        if (!ranges?.length) return annotation;
        const storedRanges = ranges.map(range => ({
            from: range.from,
            to: range.to,
        }));
        const primary = storedRanges[0];
        let refreshed = refreshAnnotationTextQuote(
            {
                ...annotation,
                ranges: storedRanges,
            },
            {
                from: primary.from,
                to: storedRanges.at(-1).to,
            },
            visible
        );
        if (!sameStoredRanges(annotation.ranges, storedRanges)) {
            changed = true;
            changedIDs.add(annotation.id);
        }
        if (!sameTextQuote(annotation.textQuote, refreshed.textQuote)) {
            changed = true;
            changedIDs.add(annotation.id);
        }
        if (!Array.isArray(sourceMap)) return refreshed;
        if (remainingWork < sourceMap.length) {
            if (refreshed.pdfPageIndexHint === undefined
                && refreshed.pdfRegion === undefined) {
                return refreshed;
            }
            changed = true;
            changedIDs.add(annotation.id);
            return annotationWithoutPDFAnchors(refreshed);
        }
        remainingWork -= sourceMap.length;
        const pdfPageIndexHint = resolvePDFPageIndexHint(
            sourceMap,
            primary,
            markdown.length
        );
        const pdfRegion = resolveSourceMapRegion(
            sourceMap,
            primary,
            markdown.length
        );
        const currentHint = refreshed.pdfPageIndexHint ?? null;
        if (pdfPageIndexHint === currentHint
            && samePDFRegion(refreshed.pdfRegion, pdfRegion)) {
            return refreshed;
        }
        changed = true;
        changedIDs.add(annotation.id);
        const withoutAnchors = annotationWithoutPDFAnchors(refreshed);
        refreshed = {
            ...withoutAnchors,
            ...(pdfPageIndexHint === null ? {} : { pdfPageIndexHint }),
            ...(pdfRegion ? { pdfRegion } : {}),
        };
        return refreshed;
    });
    return {
        annotations: updated,
        byID: new Map(updated.map(annotation => (
            [annotation.id, annotation]
        ))),
        changed,
        changedIDs,
    };
}

function refreshAnnotationTextQuote(annotation, range, visible) {
    const withoutQuote = annotationWithoutTextQuote(annotation);
    const textQuote = createTextQuoteFromVisibleIndex(range, visible);
    return textQuote ? { ...withoutQuote, textQuote } : withoutQuote;
}

function applyRefreshedAnnotationAnchors(annotation, current) {
    const withoutAnchors = annotationWithoutTextQuote(
        annotationWithoutPDFAnchors(annotation)
    );
    return {
        ...withoutAnchors,
        ...(current?.pdfPageIndexHint === undefined
            ? {}
            : { pdfPageIndexHint: current.pdfPageIndexHint }),
        ...(current?.pdfRegion ? { pdfRegion: current.pdfRegion } : {}),
        ...(current?.textQuote ? { textQuote: current.textQuote } : {}),
    };
}

function annotationWithoutPDFAnchors(annotation) {
    const {
        pdfPageIndexHint: _staleHint,
        pdfRegion: _staleRegion,
        ...withoutAnchors
    } = annotation;
    return withoutAnchors;
}

function annotationWithoutTextQuote(annotation) {
    const { textQuote: _staleQuote, ...withoutQuote } = annotation;
    return withoutQuote;
}

function validRange(range, documentLength = Number.MAX_SAFE_INTEGER) {
    return Number.isInteger(range?.from)
        && Number.isInteger(range?.to)
        && range.from >= 0
        && range.to > range.from
        && range.to <= documentLength;
}

function validateAggregateBudget(annotations) {
    const total = annotations.reduce((length, annotation) => (
        length
        + annotation.text.length
        + annotation.comment.length
    ), 0);
    if (total > MAX_TOTAL_ANNOTATION_TEXT_LENGTH) {
        throw new Error('Markdown annotation text exceeds the safety limit');
    }
    const contextLength = annotations.reduce((length, annotation) => (
        length
        + (annotation.textQuote?.prefix.length || 0)
        + (annotation.textQuote?.suffix.length || 0)
    ), 0);
    if (contextLength > MAX_TOTAL_ANNOTATION_CONTEXT_LENGTH) {
        throw new Error('Markdown annotation context exceeds the safety limit');
    }
    const sourceLength = annotations.reduce((length, annotation) => (
        length + annotation.ranges.reduce(
            (rangeLength, range) => rangeLength + range.to - range.from,
            0
        )
    ), 0);
    if (sourceLength > MAX_TOTAL_SOURCE_RANGE_LENGTH) {
        throw new Error('Markdown annotation ranges exceed the safety limit');
    }
}

function normalizeVisibleText(value) {
    return String(value || '').replace(/\s+/gu, ' ').trim();
}

function createAnnotationID() {
    return globalThis.crypto?.randomUUID?.()
        || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
