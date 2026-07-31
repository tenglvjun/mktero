import {
    isZoteroAnnotationColor,
    MAX_PDF_ANNOTATION_TEXT_LENGTH,
} from '../core/pdf-annotation.js';
import {
    createDehyphenatedPdfAnnotationTextIndex,
    normalizePdfAnnotationText,
} from '../markdown/pdf-annotation-text.js';
import { findTextOccurrences } from '../markdown/text-normalization.js';

// Long passages can be accepted after a stable single match without making
// the user wait for every remaining PDF page to finish text extraction.
const FAST_UNIQUE_MATCH_LENGTH = 160;
const FAST_UNIQUE_SETTLE_TIME = 500;
const MAX_PDF_FALLBACK_PAGES = 10_000;
const MAX_PDF_FALLBACK_PAGE_TEXT_LENGTH = 1_000_000;
const MAX_PDF_FALLBACK_TOTAL_TEXT_LENGTH = 10_000_000;

export function createZoteroAnnotationActions(zotero, {
    locateText = null,
    cloneIntoReader = defaultCloneIntoReader,
    delay = defaultDelay,
    now = () => Date.now(),
    searchTimeout = 15_000,
} = {}) {
    const textLocator = locateText || createZoteroPDFTextLocator(zotero, {
        cloneIntoReader,
        delay,
        now,
        searchTimeout,
    });
    return {
        async createFromText(itemID, draft, context = null) {
            const reader = context?.reader || null;
            const text = String(draft?.text || '');
            const comment = String(draft?.comment || '');
            const color = String(draft?.color || '').toLowerCase();
            if (!text.trim()
                || text.length > MAX_PDF_ANNOTATION_TEXT_LENGTH
                || comment.length > MAX_PDF_ANNOTATION_TEXT_LENGTH) {
                throw new Error('Invalid PDF annotation text');
            }
            if (!isZoteroAnnotationColor(color)) {
                throw new Error('Unsupported PDF annotation color');
            }
            const attachment = zotero.Items.get(itemID);
            if (!attachment?.isPDFAttachment?.()) {
                throw new Error('PDF attachment is unavailable');
            }
            const locatedText = await textLocator(itemID, text, { reader });
            if (!locatedText) return { deferred: true };
            const located = validateLocatedText(locatedText);
            const json = {
                type: 'highlight',
                text: located.text,
                comment,
                color,
                pageLabel: located.pageLabel,
                sortIndex: located.sortIndex,
                position: located.position,
            };
            const existing = await findMatchingAnnotation(
                zotero,
                attachment,
                json
            );
            if (existing) {
                await updateMatchingAnnotation(zotero, existing, json);
                return normalizeCreatedAnnotation(existing, {
                    ...json,
                    key: existing.key,
                }, { reused: true });
            }
            json.key = zotero.DataObjectUtilities.generateKey();
            let saved;
            await withNotifierQueue(zotero, async notifierQueue => {
                saved = await zotero.Annotations.saveFromJSON(
                    attachment,
                    json,
                    { notifierQueue }
                );
            });
            return normalizeCreatedAnnotation(saved, json, { reused: false });
        },
        async changeColor(itemID, annotationID, color) {
            const normalizedColor = String(color || '').toLowerCase();
            if (!isZoteroAnnotationColor(normalizedColor)) {
                throw new Error('Unsupported PDF annotation color');
            }
            const annotation = editableAnnotation(
                zotero,
                itemID,
                annotationID
            );
            await saveAnnotationField(
                zotero,
                annotation,
                'annotationColor',
                normalizedColor
            );
        },
        async deleteAnnotation(itemID, annotationID) {
            const annotation = editableAnnotation(
                zotero,
                itemID,
                annotationID
            );
            await withNotifierQueue(zotero, async notifierQueue => {
                await annotation.eraseTx({ notifierQueue });
            });
        },
        async updateComment(itemID, annotationID, comment) {
            const normalizedComment = String(comment ?? '');
            if (normalizedComment.length > MAX_PDF_ANNOTATION_TEXT_LENGTH) {
                throw new Error(
                    'PDF annotation comment exceeds the safety limit'
                );
            }
            const annotation = editableAnnotation(
                zotero,
                itemID,
                annotationID
            );
            await saveAnnotationField(
                zotero,
                annotation,
                'annotationComment',
                normalizedComment
            );
        },
    };
}

async function findMatchingAnnotation(zotero, attachment, draft) {
    if (typeof attachment.getAnnotations !== 'function') return null;
    await zotero.Items.loadDataTypes?.([attachment], ['childItems']);
    const annotations = attachment.getAnnotations(false);
    if (!Array.isArray(annotations) || annotations.length > 5_000) return null;
    await zotero.Items.loadDataTypes?.(
        annotations,
        ['annotation', 'annotationDeferred']
    );
    return annotations.find(annotation => (
        annotation?.annotationType === draft.type
        && annotation.annotationText === draft.text
        && annotation.isEditable?.() !== false
        && sameAnnotationPosition(
            annotation.annotationPosition,
            draft.position
        )
    )) || null;
}

async function updateMatchingAnnotation(zotero, annotation, draft) {
    const comment = String(annotation.annotationComment || '');
    const color = String(annotation.annotationColor || '').toLowerCase();
    if (comment === draft.comment && color === draft.color) return;
    const previousComment = annotation.annotationComment;
    const previousColor = annotation.annotationColor;
    try {
        await withNotifierQueue(zotero, async notifierQueue => {
            annotation.annotationComment = draft.comment;
            annotation.annotationColor = draft.color;
            await annotation.saveTx({
                skipDateModifiedUpdate: true,
                notifierQueue,
            });
        });
    }
    catch (error) {
        annotation.annotationComment = previousComment;
        annotation.annotationColor = previousColor;
        throw error;
    }
}

function sameAnnotationPosition(value, expected) {
    const position = parseAnnotationPosition(value, null);
    if (!position || position.pageIndex !== expected.pageIndex) return false;
    const rects = position.rects;
    return Array.isArray(rects)
        && rects.length === expected.rects.length
        && rects.every((rect, index) => (
            Array.isArray(rect)
            && rect.length === 4
            && rect.every((coordinate, coordinateIndex) => (
                coordinate === expected.rects[index][coordinateIndex]
            ))
        ));
}

function validateLocatedText(value) {
    const text = String(value?.text || '');
    const pageLabel = String(value?.pageLabel || '');
    const sortIndex = String(value?.sortIndex || '');
    const pageIndex = value?.position?.pageIndex;
    const rects = value?.position?.rects;
    if (!text.trim()
        || text.length > MAX_PDF_ANNOTATION_TEXT_LENGTH
        || pageLabel.length > 1_000
        || !sortIndex
        || sortIndex.length > 1_000
        || !Number.isInteger(pageIndex)
        || pageIndex < 0
        || !Array.isArray(rects)
        || !rects.length
        || rects.length > 10_000
        || !rects.every(validRect)) {
        throw new Error('Invalid located PDF annotation');
    }
    return {
        text,
        pageLabel,
        sortIndex,
        position: {
            pageIndex,
            rects: rects.map(rect => [...rect]),
        },
    };
}

function validRect(rect) {
    return Array.isArray(rect)
        && rect.length === 4
        && rect.every(value => (
            Number.isFinite(value) && Math.abs(value) <= 1_000_000
        ))
        && rect[2] > rect[0]
        && rect[3] > rect[1];
}

function normalizeCreatedAnnotation(annotation, fallback, { reused }) {
    const position = parseAnnotationPosition(
        annotation?.annotationPosition,
        fallback.position
    );
    return {
        id: String(annotation?.key || fallback.key),
        source: 'zotero',
        type: String(annotation?.annotationType || fallback.type),
        text: String(annotation?.annotationText || fallback.text),
        comment: String(annotation?.annotationComment ?? fallback.comment),
        color: String(annotation?.annotationColor || fallback.color).toLowerCase(),
        pageLabel: String(
            annotation?.annotationPageLabel ?? fallback.pageLabel
        ),
        pageIndex: position.pageIndex,
        sortIndex: String(
            annotation?.annotationSortIndex || fallback.sortIndex
        ),
        reused,
    };
}

function parseAnnotationPosition(value, fallback) {
    try {
        const position = typeof value === 'string' ? JSON.parse(value) : value;
        return position && Number.isInteger(position.pageIndex)
            ? position
            : fallback;
    }
    catch {
        return fallback;
    }
}

function createZoteroPDFTextLocator(zotero, {
    cloneIntoReader,
    delay,
    now,
    searchTimeout,
}) {
    return async (itemID, text, { reader: openedReader = null } = {}) => {
        const timeout = Number.isFinite(searchTimeout)
            ? Math.max(1_000, Math.min(searchTimeout, 60_000))
            : 15_000;
        const reader = readerForItem(zotero, itemID, openedReader);
        if (!reader) return null;
        return locateTextInReader(reader, text, {
            cloneIntoReader,
            delay,
            now,
            timeout,
        });
    };
}

async function locateTextInReader(reader, text, options) {
    const readerFrame = reader?._iframe;
    const previousDocShellState = readerFrame?.docShellIsActive;
    if (readerFrame && typeof previousDocShellState === 'boolean') {
        readerFrame.docShellIsActive = true;
    }
    try {
        return await locateTextInActiveReader(reader, text, options);
    }
    finally {
        if (readerFrame && typeof previousDocShellState === 'boolean') {
            readerFrame.docShellIsActive = previousDocShellState;
        }
    }
}

async function locateTextInActiveReader(reader, text, {
    cloneIntoReader,
    delay,
    now,
    timeout,
}) {
    const waitOptions = { delay, now, timeout };
    await waitForReaderPromise(reader._initPromise, waitOptions);
    const internalReader = reader._internalReader;
    const view = internalReader?._primaryView;
    await waitForReaderPromise(view?.initializedPromise, waitOptions);
    if (!view || typeof view.setFindState !== 'function') {
        throw annotationSyncError(
            'MKTERO_PDF_READER_UNAVAILABLE',
            'Zotero PDF text search is unavailable'
        );
    }

    const previousFindState = view._findState || inactiveFindState();
    let searchError = null;
    try {
        await setReaderFindState(view, reader, {
            active: true,
            query: text,
            highlightAll: false,
            caseSensitive: false,
            entireWord: false,
            index: null,
            result: null,
        }, cloneIntoReader);
        let result = await waitForPDFTextResult(
            view,
            text,
            { delay, now, timeout, allowNormalizedFallback: true }
        );
        let usedNormalizedQuery = false;
        if (!result) {
            throw annotationSyncError(
                'MKTERO_PDF_TEXT_SEARCH_TIMEOUT',
                'Timed out while locating text in the PDF'
            );
        }
        if (!result.total) {
            const fallback = result.normalizedFallback
                || findNormalizedPDFSearchQuery(view, text);
            if (fallback.ambiguous) {
                throw annotationSyncError(
                    'MKTERO_PDF_TEXT_AMBIGUOUS',
                    'Selected Markdown text occurs more than once in the PDF'
                );
            }
            if (fallback.query) {
                usedNormalizedQuery = true;
                await setReaderFindState(view, reader, {
                    active: true,
                    query: fallback.query,
                    highlightAll: false,
                    caseSensitive: false,
                    entireWord: false,
                    index: null,
                    result: null,
                }, cloneIntoReader);
                result = await waitForPDFTextResult(
                    view,
                    fallback.query,
                    { delay, now, timeout }
                );
                if (!result) {
                    throw annotationSyncError(
                        'MKTERO_PDF_TEXT_SEARCH_TIMEOUT',
                        'Timed out while locating text in the PDF'
                    );
                }
            }
        }
        if (!result.total) {
            throw annotationSyncError(
                'MKTERO_PDF_TEXT_NOT_FOUND',
                'Selected Markdown text was not found in the PDF'
            );
        }
        if (result.total !== 1) {
            throw annotationSyncError(
                'MKTERO_PDF_TEXT_AMBIGUOUS',
                'Selected Markdown text occurs more than once in the PDF'
            );
        }
        return usedNormalizedQuery
            ? { ...result.annotation, text }
            : result.annotation;
    }
    catch (error) {
        searchError = error;
        throw error;
    }
    finally {
        try {
            await setReaderFindState(
                view,
                reader,
                previousFindState,
                cloneIntoReader
            );
        }
        catch (error) {
            if (!searchError) throw error;
        }
    }
}

async function setReaderFindState(view, reader, state, cloneIntoReader) {
    const readerState = cloneIntoReader(state, reader?._iframeWindow);
    await view.setFindState(readerState);
}

function defaultCloneIntoReader(value, target) {
    if (!target
        || typeof Components === 'undefined'
        || typeof Components.utils?.cloneInto !== 'function') {
        return value;
    }
    return Components.utils.cloneInto(value, target);
}

function findNormalizedPDFSearchQuery(view, text, tracker = null) {
    const pages = view?._findController?._pageContents;
    if (tracker?.status === 'ambiguous') {
        return { query: null, ambiguous: true, unavailable: false };
    }
    if (tracker?.status === 'unavailable') {
        return { query: null, ambiguous: false, unavailable: true };
    }
    if (!Array.isArray(pages)) {
        return { query: null, ambiguous: false, unavailable: false };
    }
    if (pages.length > MAX_PDF_FALLBACK_PAGES) {
        if (tracker) tracker.status = 'unavailable';
        return { query: null, ambiguous: false, unavailable: true };
    }
    const target = tracker?.target ?? normalizePdfAnnotationText(text);
    if (!target) {
        return { query: null, ambiguous: false, unavailable: false };
    }
    let totalTextLength = tracker?.totalTextLength || 0;
    let query = tracker?.query || null;
    let matchCount = tracker?.matchCount || 0;
    const firstPageIndex = tracker?.nextPageIndex || 0;
    for (let pageIndex = firstPageIndex;
        pageIndex < pages.length;
        pageIndex++) {
        const page = pages[pageIndex];
        if (page == null) {
            if (tracker) break;
            continue;
        }
        if (typeof page !== 'string'
            || page.length > MAX_PDF_FALLBACK_PAGE_TEXT_LENGTH) {
            if (tracker) tracker.status = 'unavailable';
            return { query: null, ambiguous: false, unavailable: true };
        }
        totalTextLength += page.length;
        if (totalTextLength > MAX_PDF_FALLBACK_TOTAL_TEXT_LENGTH) {
            if (tracker) tracker.status = 'unavailable';
            return { query: null, ambiguous: false, unavailable: true };
        }
        const pageMatch = findNormalizedTextOnPDFPage(page, text, target);
        if (pageMatch.ambiguous) {
            if (tracker) tracker.status = 'ambiguous';
            return { query: null, ambiguous: true, unavailable: false };
        }
        if (pageMatch.matched) {
            matchCount++;
            if (matchCount > 1) {
                if (tracker) tracker.status = 'ambiguous';
                return { query: null, ambiguous: true, unavailable: false };
            }
            query = pageMatch.query || query;
        }
        if (tracker) {
            tracker.nextPageIndex = pageIndex + 1;
            tracker.totalTextLength = totalTextLength;
            tracker.query = query;
            tracker.matchCount = matchCount;
        }
    }
    return { query, ambiguous: false, unavailable: false };
}

function findNormalizedTextOnPDFPage(page, text, target) {
    const index = createDehyphenatedPdfAnnotationTextIndex(page);
    const occurrences = findTextOccurrences(index.text, target, 2);
    if (occurrences.truncated || occurrences.offsets.length > 1) {
        return { matched: false, query: null, ambiguous: true };
    }
    if (!occurrences.offsets.length) {
        return { matched: false, query: null, ambiguous: false };
    }
    const range = index.sourceRange(occurrences.offsets[0], target.length);
    const candidate = page.slice(range.from, range.to);
    return {
        matched: true,
        query: candidate && candidate !== text ? candidate : null,
        ambiguous: false,
    };
}

function createNormalizedPDFSearchTracker(text) {
    // Zotero fills _pageContents sequentially. Preserve progress so polling a
    // slow or oversized document does not normalize earlier pages repeatedly.
    return {
        target: normalizePdfAnnotationText(text),
        nextPageIndex: 0,
        totalTextLength: 0,
        query: null,
        matchCount: 0,
        status: 'active',
    };
}

function readerForItem(zotero, itemID, openedReader) {
    if (openedReader?.itemID === itemID) return openedReader;
    return zotero.Reader?._readers?.find(reader => (
        reader?.itemID === itemID
    )) || null;
}

async function waitForPDFTextResult(view, text, {
    delay,
    now,
    timeout,
    allowNormalizedFallback = false,
}) {
    const startedAt = now();
    let stableMatch = null;
    let stableSince = null;
    let stableNormalizedQuery = null;
    let stableNormalizedSince = null;
    const normalizedFallbackTracker = allowNormalizedFallback
        ? createNormalizedPDFSearchTracker(text)
        : null;
    while (now() - startedAt <= timeout) {
        const result = currentFindResult(view, text);
        if (result?.total > 1) return result;
        if (result && pdfSearchCompleted(view, text)) return result;
        if (normalizedFallbackTracker) {
            const normalizedFallback = findNormalizedPDFSearchQuery(
                view,
                text,
                normalizedFallbackTracker
            );
            if (normalizedFallback.ambiguous) {
                return {
                    ...(result || { total: 0 }),
                    normalizedFallback,
                };
            }
            if (normalizedFallback.unavailable) {
                stableNormalizedQuery = null;
                stableNormalizedSince = null;
            }
            else if (normalizedFallback.query) {
                if (normalizedFallback.query !== stableNormalizedQuery) {
                    stableNormalizedQuery = normalizedFallback.query;
                    stableNormalizedSince = now();
                }
                if (pdfPageTextExtractionCompleted(view)
                    || (isStrongUniqueMatch(text)
                        && now() - stableNormalizedSince
                            >= FAST_UNIQUE_SETTLE_TIME)) {
                    return {
                        ...(result || { total: 0 }),
                        normalizedFallback,
                    };
                }
            }
        }
        if (result?.total === 1
            && result.annotation
            && isStrongUniqueMatch(text)) {
            const match = annotationMatchKey(result.annotation);
            if (match !== stableMatch) {
                stableMatch = match;
                stableSince = now();
            }
            if (now() - stableSince >= FAST_UNIQUE_SETTLE_TIME) {
                return result;
            }
        }
        else {
            stableMatch = null;
            stableSince = null;
        }
        await delay(25);
    }
    return null;
}

function pdfPageTextExtractionCompleted(view) {
    const controller = view?._findController;
    const extraction = controller?._extractTextPromises;
    const pages = controller?._pageContents;
    if (!Array.isArray(extraction)
        || !extraction.length
        || !Array.isArray(pages)) {
        return false;
    }
    for (let index = 0; index < extraction.length; index++) {
        if (typeof pages[index] !== 'string') return false;
    }
    return true;
}

function currentFindResult(view, text) {
    const state = view?._findState;
    if (!state?.active || state.query !== text || !state.result) return null;
    const result = state.result;
    if (!Number.isInteger(result.total) || result.total < 0) return null;
    if (result.total === 1 && !result.annotation) return null;
    return result;
}

function isStrongUniqueMatch(text) {
    return String(text || '').replace(/\s+/gu, ' ').trim().length
        >= FAST_UNIQUE_MATCH_LENGTH;
}

function annotationMatchKey(annotation) {
    return JSON.stringify({
        text: annotation?.text,
        pageLabel: annotation?.pageLabel,
        sortIndex: annotation?.sortIndex,
        position: annotation?.position,
    });
}

function pdfSearchCompleted(view, text) {
    const controller = view?._findController;
    const pending = controller?._pendingFindMatches;
    return controller?.state?.query === text
        && controller._dirtyMatch === false
        && !controller._findTimeout
        && Number.isInteger(pending?.size)
        && pending.size === 0;
}

async function waitForReaderPromise(promise, { delay, now, timeout }) {
    let state = 'pending';
    let value;
    let failure;
    Promise.resolve(promise).then(
        result => {
            state = 'fulfilled';
            value = result;
        },
        error => {
            state = 'rejected';
            failure = error;
        }
    );
    await Promise.resolve();
    const startedAt = now();
    while (state === 'pending' && now() - startedAt <= timeout) {
        await delay(25);
    }
    if (state === 'pending') {
        throw annotationSyncError(
            'MKTERO_PDF_READER_UNAVAILABLE',
            'Zotero PDF reader initialization timed out'
        );
    }
    if (state === 'rejected') throw failure;
    return value;
}

function inactiveFindState() {
    return {
        active: false,
        query: '',
        highlightAll: true,
        caseSensitive: false,
        entireWord: false,
        index: null,
        result: null,
    };
}

function annotationSyncError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function defaultDelay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function saveAnnotationField(zotero, annotation, field, value) {
    const previousValue = annotation[field];
    try {
        await withNotifierQueue(zotero, async notifierQueue => {
            annotation[field] = value;
            await annotation.saveTx({
                skipDateModifiedUpdate: true,
                notifierQueue,
            });
        });
    }
    catch (error) {
        annotation[field] = previousValue;
        throw error;
    }
}

function editableAnnotation(zotero, itemID, annotationID) {
    const attachment = zotero.Items.get(itemID);
    const key = String(annotationID || '');
    const annotation = attachment && key
        ? zotero.Items.getByLibraryAndKey(attachment.libraryID, key)
        : null;
    if (!annotation?.isAnnotation?.()
        || annotation.parentID !== attachment.id
        || !annotation.isEditable?.()) {
        throw new Error('PDF annotation is unavailable or read-only');
    }
    return annotation;
}

async function withNotifierQueue(zotero, action) {
    const notifierQueue = new zotero.Notifier.Queue();
    try {
        await action(notifierQueue);
    }
    finally {
        await zotero.Notifier.commit(notifierQueue);
    }
}
