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

export class MarkdownLocalAnnotations {
    constructor({
        store,
        createID = createAnnotationID,
        onError = () => {},
    }) {
        if (!store?.get || !store?.put) {
            throw new TypeError('A Markdown annotation store is required');
        }
        this.store = store;
        this.createID = createID;
        this.onError = onError;
        this.operationTail = Promise.resolve();
    }

    async resolve(itemID, markdown) {
        if (typeof markdown !== 'string') {
            throw new TypeError('Markdown must be a string');
        }
        try {
            const annotations = normalizeCollection(await this.store.get(itemID));
            return resolveAnnotations(markdown, annotations);
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

    create(itemID, draft) {
        return this.#withOperation(async () => {
            const annotations = normalizeCollection(await this.store.get(itemID));
            if (annotations.length >= MAX_LOCAL_ANNOTATIONS) {
                throw new Error('Markdown annotation count exceeds the safety limit');
            }
            const annotation = normalizeAnnotation({
                ...draft,
                id: `mktero-${this.createID()}`,
                source: 'markdown',
                type: 'highlight',
            });
            validateAggregateBudget([...annotations, annotation]);
            await this.store.put(itemID, [...annotations, annotation]);
            return resolvedAnnotation(annotation, annotation.ranges[0]);
        });
    }

    update(itemID, annotationID, changes) {
        return this.#withOperation(async () => {
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
    }

    delete(itemID, annotationID) {
        return this.#withOperation(async () => {
            const annotations = normalizeCollection(await this.store.get(itemID));
            const targetID = String(annotationID || '');
            const updated = annotations.filter(annotation => (
                annotation.id !== targetID
            ));
            if (updated.length === annotations.length) {
                throw new Error('Markdown annotation is unavailable');
            }
            await this.store.put(itemID, updated);
        });
    }

    #reportError(error) {
        try {
            this.onError(error);
        }
        catch {
            // Annotation diagnostics must not make the Markdown view fail.
        }
    }

    async #withOperation(operation) {
        const previous = this.operationTail;
        const pending = previous.catch(() => {}).then(operation);
        this.operationTail = pending;
        try {
            return await pending;
        }
        finally {
            if (this.operationTail === pending) {
                this.operationTail = Promise.resolve();
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
    };
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
