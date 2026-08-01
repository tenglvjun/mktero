import {
    isZoteroAnnotationColor,
    MAX_PDF_ANNOTATION_TEXT_LENGTH,
} from './pdf-annotation.js';
import { createVisibleMarkdownTextIndex } from '../markdown/markdown-visible-text.js';
import { findTextOccurrences } from '../markdown/text-normalization.js';
import {
    createPdfAnnotationTextIndex,
    normalizePdfAnnotationText,
} from '../markdown/pdf-annotation-text.js';

const DEFAULT_ANNOTATION_COLOR = '#ffd400';
const MAX_LOCAL_ANNOTATIONS = 5_000;
const MAX_TOTAL_ANNOTATION_TEXT_LENGTH = 2_000_000;
const MAX_MATCH_CANDIDATES = 10_000;
const MAX_MATCHABLE_MARKDOWN_LENGTH = 8 * 1024 * 1024;
const MAX_TOTAL_SOURCE_RANGE_LENGTH = 8 * 1024 * 1024;
const LOCAL_ANNOTATION_ID = /^mktero-[a-z0-9-]{1,128}$/i;
const SYNCHRONIZATION_FAILURE_REASONS = new Map([
    ['MKTERO_PDF_TEXT_NOT_FOUND', 'text-not-found'],
    ['MKTERO_PDF_TEXT_AMBIGUOUS', 'text-ambiguous'],
    ['MKTERO_PDF_READER_UNAVAILABLE', 'reader-unavailable'],
    ['MKTERO_PDF_TEXT_SEARCH_TIMEOUT', 'search-timeout'],
]);

export class MarkdownLocalAnnotations {
    constructor({
        store,
        createID = createAnnotationID,
        createPDFAnnotation = null,
        deletePDFAnnotation = null,
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
        this.onError = onError;
        this.onSynchronizationChange = onSynchronizationChange;
        this.operationTails = new Map();
        this.synchronizationRequests = new Map();
        this.synchronizationContexts = new Map();
        this.synchronizationTasks = new Map();
        this.synchronizationFailures = new Map();
        this.active = true;
    }

    async resolve(itemID, markdown, { retryFailed = false } = {}) {
        if (typeof markdown !== 'string') {
            throw new TypeError('Markdown must be a string');
        }
        let result = await this.#withOperation(itemID, () => (
            this.#resolve(itemID, markdown)
        ));
        const failures = this.synchronizationFailures.get(itemID);
        result = applySynchronizationStates(result, failures);
        const matchedIDs = result.matched.map(annotation => annotation.id);
        const retryIDs = retryFailed
            ? matchedIDs
            : matchedIDs.filter(id => !failures?.has(id));
        this.#requestSynchronization(itemID, retryIDs);
        if ([...result.matched, ...result.unmatched]
            .some(annotation => failures?.has(annotation.id))) {
            result.warning ||= 'Some local Markdown annotations could not be synchronized to the PDF.';
        }
        return result;
    }

    async #resolve(itemID, markdown) {
        try {
            const annotations = normalizeCollection(await this.store.get(itemID));
            const resolved = resolveAnnotations(markdown, annotations);
            return resolved;
        }
        catch (error) {
            this.#reportError(error);
            return {
                matched: [],
                unmatched: [],
                warning: 'Local Markdown annotations could not be loaded.',
            };
        }
    }

    async create(itemID, draft) {
        const created = await this.#withOperation(itemID, async () => {
            const annotation = normalizeAnnotation({
                ...draft,
                id: `mktero-${this.createID()}`,
                source: 'markdown',
                type: 'highlight',
            });
            const annotations = normalizeCollection(await this.store.get(itemID));
            if (annotations.length >= MAX_LOCAL_ANNOTATIONS) {
                throw new Error('Markdown annotation count exceeds the safety limit');
            }
            validateAggregateBudget([...annotations, annotation]);
            await this.store.put(itemID, [...annotations, annotation]);
            return resolvedAnnotation(annotation, annotation.ranges[0]);
        });
        this.#clearSynchronizationFailure(itemID, created.id);
        this.#requestSynchronization(itemID, [created.id]);
        return created;
    }

    async update(itemID, annotationID, changes) {
        const updated = await this.#withOperation(itemID, async () => {
            const annotations = normalizeCollection(await this.store.get(itemID));
            const targetID = String(annotationID || '');
            const index = annotations.findIndex(annotation => (
                annotation.id === targetID
            ));
            if (index < 0) throw new Error('Markdown annotation is unavailable');
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
            await this.store.put(itemID, updated);
            return resolvedAnnotation(annotation, annotation.ranges[0]);
        });
        this.#clearSynchronizationFailure(itemID, updated.id);
        this.#requestSynchronization(itemID, [updated.id]);
        return updated;
    }

    async delete(itemID, annotationID) {
        const targetID = String(annotationID || '');
        await this.#withOperation(itemID, async () => {
            const annotations = normalizeCollection(
                await this.store.get(itemID)
            );
            const updated = annotations.filter(annotation => (
                annotation.id !== targetID
            ));
            if (updated.length === annotations.length) {
                throw new Error('Markdown annotation is unavailable');
            }
            await this.store.put(itemID, updated);
        });
        this.#clearSynchronizationFailure(itemID, targetID);
    }

    async synchronizePending(itemID, context = null) {
        const annotationIDs = await this.#withOperation(itemID, async () => (
            normalizeCollection(await this.store.get(itemID))
                .map(annotation => annotation.id)
        ));
        this.#requestSynchronization(itemID, annotationIDs, context);
    }

    async retrySynchronization(itemID, annotationID, context = null) {
        const targetID = String(annotationID || '');
        await this.#withOperation(itemID, async () => {
            const annotations = normalizeCollection(await this.store.get(itemID));
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
    }

    #requestSynchronization(itemID, annotationIDs, context = null) {
        if (!this.active
            || typeof this.createPDFAnnotation !== 'function') {
            return;
        }
        if (annotationIDs.length) {
            let requested = this.synchronizationRequests.get(itemID);
            if (!requested) {
                requested = new Set();
                this.synchronizationRequests.set(itemID, requested);
            }
            for (const annotationID of annotationIDs) {
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
                normalizeCollection(await this.store.get(itemID))
                    .filter(annotation => annotationIDs.has(annotation.id))
            ));
            for (const annotation of annotations) {
                if (!this.active) return;
                await this.#synchronizeAnnotation(itemID, annotation, context);
            }
        }
    }

    async #synchronizeAnnotation(itemID, annotation, context) {
        try {
            const saved = await this.createPDFAnnotation(itemID, {
                text: annotation.text,
                comment: annotation.comment,
                color: annotation.color,
                ranges: annotation.ranges,
            }, context);
            if (saved?.deferred) return;
            const status = await this.#withOperation(itemID, async () => {
                const current = normalizeCollection(
                    await this.store.get(itemID)
                );
                const target = current.find(existing => (
                    existing.id === annotation.id
                ));
                if (!target) return 'deleted';
                if (!sameAnnotation(target, annotation)) return 'changed';
                await this.store.put(
                    itemID,
                    current.filter(existing => existing.id !== annotation.id)
                );
                return 'removed';
            });
            this.#clearSynchronizationFailure(itemID, annotation.id);
            if (status === 'removed') {
                this.#notifySynchronizationChange(itemID);
            }
            else if (status === 'changed') {
                this.#requestSynchronization(
                    itemID,
                    [annotation.id],
                    context
                );
            }
            else if (!saved?.reused
                && typeof this.deletePDFAnnotation === 'function') {
                try {
                    await this.deletePDFAnnotation(itemID, saved.id);
                }
                catch (error) {
                    this.#reportError(error);
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

    #clearSynchronizationFailure(itemID, annotationID) {
        const failures = this.synchronizationFailures.get(itemID);
        failures?.delete(annotationID);
        if (!failures?.size) this.synchronizationFailures.delete(itemID);
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
    let visibleIndex = null;
    let normalizedIndex = null;
    for (const annotation of annotations) {
        const savedRange = annotation.ranges[0];
        if (sourceRangeMatches(markdown, savedRange, annotation.text)) {
            matched.push(resolvedAnnotation(annotation, savedRange));
            continue;
        }
        visibleIndex ||= createVisibleMarkdownTextIndex(markdown);
        const candidates = findTextOccurrences(
            visibleIndex.text,
            annotation.text,
            MAX_MATCH_CANDIDATES
        );
        let ambiguous = candidates.truncated || candidates.offsets.length > 1;
        if (!candidates.truncated && candidates.offsets.length === 1) {
            matched.push(resolvedAnnotation(
                annotation,
                visibleIndex.sourceRange(
                    candidates.offsets[0],
                    annotation.text.length
                )
            ));
            continue;
        }
        const normalizedText = normalizePdfAnnotationText(annotation.text);
        if (!candidates.truncated
            && !candidates.offsets.length
            && normalizedText) {
            normalizedIndex ||= createPdfAnnotationTextIndex(
                visibleIndex.text,
                offset => visibleIndex.sourceOffsetAt(offset)
            );
            const normalizedCandidates = findTextOccurrences(
                normalizedIndex.text,
                normalizedText,
                MAX_MATCH_CANDIDATES
            );
            if (!normalizedCandidates.truncated
                && normalizedCandidates.offsets.length === 1) {
                matched.push(resolvedAnnotation(
                    annotation,
                    normalizedIndex.sourceRange(
                        normalizedCandidates.offsets[0],
                        normalizedText.length
                    )
                ));
                continue;
            }
            ambiguous = normalizedCandidates.truncated
                || normalizedCandidates.offsets.length > 1;
        }
        unmatched.push({
            ...annotation,
            reason: ambiguous ? 'ambiguous' : 'not-found',
        });
    }
    return { matched, unmatched };
}

function sourceRangeMatches(markdown, range, text) {
    if (!validRange(range, markdown.length)) return false;
    const visible = createVisibleMarkdownTextIndex(
        markdown.slice(range.from, range.to)
    ).text;
    return normalizeVisibleText(visible) === normalizeVisibleText(text);
}

function resolvedAnnotation(annotation, range) {
    return {
        ...annotation,
        matchKind: 'local',
        ranges: [{ from: range.from, to: range.to }],
        sortIndex: String(range.from).padStart(12, '0'),
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
        && left.ranges[0].from === right.ranges[0].from
        && left.ranges[0].to === right.ranges[0].to;
}

function normalizeCollection(value) {
    if (!Array.isArray(value) || value.length > MAX_LOCAL_ANNOTATIONS) {
        throw new Error('Invalid Markdown annotation collection');
    }
    const annotations = value.map(normalizeAnnotation);
    validateAggregateBudget(annotations);
    return annotations;
}

function normalizeAnnotation(value) {
    const id = String(value?.id || '');
    const text = String(value?.text || '');
    const comment = String(value?.comment || '');
    const color = String(value?.color || DEFAULT_ANNOTATION_COLOR).toLowerCase();
    const range = value?.ranges?.[0];
    if (!LOCAL_ANNOTATION_ID.test(id)
        || value?.source !== 'markdown'
        || value?.type !== 'highlight'
        || !text.trim()
        || text.length > MAX_PDF_ANNOTATION_TEXT_LENGTH
        || comment.length > MAX_PDF_ANNOTATION_TEXT_LENGTH
        || !isZoteroAnnotationColor(color)
        || !validRange(range)) {
        throw new Error('Invalid Markdown annotation');
    }
    return {
        id,
        source: 'markdown',
        type: 'highlight',
        text,
        comment,
        color,
        ranges: [{ from: range.from, to: range.to }],
    };
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
        length + annotation.text.length + annotation.comment.length
    ), 0);
    if (total > MAX_TOTAL_ANNOTATION_TEXT_LENGTH) {
        throw new Error('Markdown annotation text exceeds the safety limit');
    }
    const sourceLength = annotations.reduce((length, annotation) => (
        length + annotation.ranges[0].to - annotation.ranges[0].from
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
