import {
    isZoteroAnnotationColor,
    MAX_PDF_ANNOTATION_TEXT_LENGTH,
} from '../core/pdf-annotation.js';

// Long passages can be accepted after a stable single match without making
// the user wait for every remaining PDF page to finish text extraction.
const FAST_UNIQUE_MATCH_LENGTH = 160;
const FAST_UNIQUE_SETTLE_TIME = 500;

export function createZoteroAnnotationActions(zotero, {
    locateText = null,
    delay = defaultDelay,
    now = () => Date.now(),
    searchTimeout = 15_000,
} = {}) {
    const textLocator = locateText || createZoteroPDFTextLocator(zotero, {
        delay,
        now,
        searchTimeout,
    });
    return {
        async createFromText(itemID, draft) {
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
            const located = validateLocatedText(
                await textLocator(itemID, text)
            );
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
                return normalizeCreatedAnnotation(existing, {
                    ...json,
                    key: existing.key,
                });
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
            return normalizeCreatedAnnotation(saved, json);
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
        && String(annotation.annotationComment || '') === draft.comment
        && String(annotation.annotationColor || '').toLowerCase() === draft.color
        && sameAnnotationPosition(
            annotation.annotationPosition,
            draft.position
        )
    )) || null;
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

function normalizeCreatedAnnotation(annotation, fallback) {
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
    delay,
    now,
    searchTimeout,
}) {
    return async (itemID, text) => {
        const timeout = Number.isFinite(searchTimeout)
            ? Math.max(1_000, Math.min(searchTimeout, 60_000))
            : 15_000;
        const readerContext = await readerForItem(zotero, itemID, {
            delay,
            now,
            timeout,
        });
        const { reader } = readerContext;
        try {
            return await locateTextInReader(reader, text, {
                delay,
                now,
                timeout,
            });
        }
        finally {
            try {
                readerContext.close?.();
            }
            catch (error) {
                zotero.logError?.(error);
            }
        }
    };
}

async function locateTextInReader(reader, text, { delay, now, timeout }) {
    await reader._initPromise;
    const internalReader = reader._internalReader;
    await internalReader?.initializedPromise;
    const view = internalReader?._primaryView;
    await view?.initializedPromise;
    if (!view || typeof view.setFindState !== 'function') {
        throw annotationSyncError(
            'MKTERO_PDF_READER_UNAVAILABLE',
            'Zotero PDF text search is unavailable'
        );
    }

    const previousFindState = view._findState || inactiveFindState();
    const readerFrame = reader._iframe;
    const previousDocShellState = readerFrame?.docShellIsActive;
    if (readerFrame && typeof previousDocShellState === 'boolean') {
        readerFrame.docShellIsActive = true;
    }
    let searchError = null;
    try {
        await view.setFindState({
            active: true,
            query: text,
            highlightAll: false,
            caseSensitive: false,
            entireWord: false,
            index: null,
            result: null,
        });
        const result = await waitForPDFTextResult(
            view,
            text,
            { delay, now, timeout }
        );
        if (!result) {
            throw annotationSyncError(
                'MKTERO_PDF_TEXT_SEARCH_TIMEOUT',
                'Timed out while locating text in the PDF'
            );
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
        return result.annotation;
    }
    catch (error) {
        searchError = error;
        throw error;
    }
    finally {
        try {
            await view.setFindState(previousFindState);
        }
        catch (error) {
            if (!searchError) throw error;
        }
        finally {
            if (readerFrame && typeof previousDocShellState === 'boolean') {
                readerFrame.docShellIsActive = previousDocShellState;
            }
        }
    }
}

async function readerForItem(zotero, itemID, waitOptions) {
    const findReader = () => zotero.Reader?._readers?.find(reader => (
        reader?.itemID === itemID
    ));
    let reader = findReader();
    let temporaryReader = null;
    if (!reader && typeof zotero.Reader?.open === 'function') {
        temporaryReader = await zotero.Reader.open(itemID, null, {
            openInBackground: true,
        });
        reader = temporaryReader;
    }
    reader ||= await waitForValue(findReader, waitOptions);
    if (!reader) {
        throw annotationSyncError(
            'MKTERO_PDF_READER_UNAVAILABLE',
            'Zotero PDF reader is unavailable'
        );
    }
    return {
        reader,
        close: temporaryReader === reader
            && typeof reader.close === 'function'
            ? () => reader.close()
            : null,
    };
}

async function waitForPDFTextResult(view, text, { delay, now, timeout }) {
    const startedAt = now();
    let stableMatch = null;
    let stableSince = null;
    while (now() - startedAt <= timeout) {
        const result = currentFindResult(view, text);
        if (result?.total > 1) return result;
        if (result && pdfSearchCompleted(view, text)) return result;
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

async function waitForValue(read, { delay, now, timeout }) {
    const startedAt = now();
    while (now() - startedAt <= timeout) {
        const value = read();
        if (value) return value;
        await delay(25);
    }
    return null;
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
