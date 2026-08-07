import {
    createDehyphenatedPdfAnnotationTextIndex,
    normalizePdfAnnotationText,
} from '../markdown/pdf-annotation-text.js';
import { findTextOccurrences } from '../markdown/text-normalization.js';
import { sha256Hex } from '../core/sha256.js';

const MAX_MATCHES = 10_000;

export class PDFAnnotationLocator {
    constructor({
        engine,
        cache = null,
        createAbortController = defaultCreateAbortController,
        createSourceHash,
        loadFile = null,
        measureText = defaultMeasureText,
        readerLocator = null,
        onError = () => {},
    }) {
        if (!engine?.extract) {
            throw new TypeError('A PDF text extraction engine is required');
        }
        if (typeof createSourceHash !== 'function') {
            throw new TypeError('A PDF source hash function is required');
        }
        if (typeof createAbortController !== 'function') {
            throw new TypeError('An AbortController provider is required');
        }
        this.engine = engine;
        this.cache = cache;
        this.createAbortController = createAbortController;
        this.createSourceHash = createSourceHash;
        this.loadFile = loadFile;
        this.measureText = measureText;
        this.readerLocator = readerLocator;
        this.onError = onError;
        this.items = new Map();
        this.inFlight = new Map();
        this.active = true;
    }

    async prepare(itemID, { fileData, signal } = {}) {
        this.#requireActive();
        throwIfAborted(signal);
        validateItemID(itemID);
        const sourceHash = await this.createSourceHash(fileData);
        this.#requireActive();
        throwIfAborted(signal);
        validateSourceHash(sourceHash);
        const cacheKey = await createPDFTextIndexCacheKey(
            sourceHash,
            this.engine.profile || 'pdf-text-index-v1'
        );
        this.#requireActive();
        throwIfAborted(signal);
        const current = this.items.get(itemID);
        if (current?.cacheKey === cacheKey && current.index) {
            return current.index;
        }
        this.items.set(itemID, { sourceHash, cacheKey, index: null });
        let task = this.inFlight.get(cacheKey);
        if (!task || task.controller.signal.aborted) {
            task = this.#createIndexTask(cacheKey, fileData);
            this.inFlight.set(cacheKey, task);
        }
        const index = await this.#consumeIndexTask(task, signal);
        if (!this.active) throw disposedError();
        if (this.items.get(itemID)?.cacheKey === cacheKey) {
            this.items.set(itemID, { sourceHash, cacheKey, index });
        }
        return index;
    }

    async locate(itemID, text, options = {}) {
        this.#requireActive();
        throwIfAborted(options.signal);
        validateItemID(itemID);
        let offlineError = null;
        let entry = this.items.get(itemID);
        if (!entry?.index && typeof this.loadFile === 'function') {
            try {
                const fileData = await this.loadFile(itemID);
                throwIfAborted(options.signal);
                await this.prepare(itemID, {
                    fileData,
                    signal: options.signal,
                });
                entry = this.items.get(itemID);
            }
            catch (error) {
                offlineError = normalizeOfflineIndexError(error);
            }
        }
        if (entry?.index) {
            throwIfAborted(options.signal);
            try {
                return locateInIndex(entry.index, text, {
                    pdfPageIndexHint: options.pdfPageIndexHint,
                    measureText: this.measureText,
                });
            }
            catch (error) {
                if (error?.code === 'MKTERO_PDF_TEXT_AMBIGUOUS'
                    || typeof this.readerLocator !== 'function') {
                    throw error;
                }
                offlineError = normalizeOfflineIndexError(error);
            }
        }
        if (typeof this.readerLocator === 'function') {
            const located = await this.readerLocator(itemID, text, options);
            throwIfAborted(options.signal);
            if (located) return { ...located, text: String(text || '') };
        }
        if (offlineError) throw offlineError;
        return null;
    }

    dispose() {
        if (!this.active) return;
        this.active = false;
        this.items.clear();
        for (const task of this.inFlight.values()) {
            task.controller.abort(disposedError());
        }
        this.inFlight.clear();
        this.engine.dispose?.();
    }

    #requireActive() {
        if (!this.active) throw disposedError();
    }

    #createIndexTask(cacheKey, fileData) {
        const controller = this.createAbortController();
        if (!controller?.signal || typeof controller.abort !== 'function') {
            throw new Error('AbortController is unavailable for PDF indexing');
        }
        const task = {
            controller,
            consumers: new Set(),
            promise: null,
            settled: false,
        };
        task.promise = this.#readOrCreateIndex(
            cacheKey,
            fileData,
            controller.signal
        ).finally(() => {
            task.settled = true;
            if (this.inFlight.get(cacheKey) === task) {
                this.inFlight.delete(cacheKey);
            }
        });
        return task;
    }

    async #consumeIndexTask(task, signal) {
        throwIfAborted(signal);
        const consumer = Symbol('pdf-index-consumer');
        task.consumers.add(consumer);
        let abort = null;
        let abortPromise = null;
        if (typeof signal?.addEventListener === 'function') {
            abortPromise = new Promise((_resolve, reject) => {
                abort = () => reject(abortReason(signal));
                signal.addEventListener('abort', abort, { once: true });
                if (signal.aborted) abort();
            });
        }
        try {
            const index = await (abortPromise
                ? Promise.race([task.promise, abortPromise])
                : task.promise);
            throwIfAborted(signal);
            return index;
        }
        finally {
            signal?.removeEventListener?.('abort', abort);
            task.consumers.delete(consumer);
            if (!task.settled && !task.consumers.size) {
                task.controller.abort(abortReason(signal));
            }
        }
    }

    async #readOrCreateIndex(cacheKey, fileData, signal) {
        throwIfAborted(signal);
        if (this.cache?.get) {
            try {
                const cached = await this.cache.get(cacheKey);
                this.#requireActive();
                throwIfAborted(signal);
                if (cached?.profile === this.engine.profile) return cached;
            }
            catch (error) {
                if (!this.active) throw disposedError();
                this.#reportError(error);
            }
        }
        this.#requireActive();
        throwIfAborted(signal);
        const index = await this.engine.extract(fileData, { signal });
        this.#requireActive();
        throwIfAborted(signal);
        if (this.cache?.put) {
            try {
                await this.cache.put(cacheKey, index);
            }
            catch (error) {
                this.#reportError(error);
            }
        }
        return index;
    }

    #reportError(error) {
        try {
            this.onError(error);
        }
        catch {
            // Index diagnostics must not prevent PDF annotation creation.
        }
    }
}

export async function createPDFTextIndexCacheKey(sourceHash, profile) {
    validateSourceHash(sourceHash);
    const descriptor = new TextEncoder().encode([
        'pdf-index-schema:1',
        `profile:${String(profile)}`,
        `source-sha256:${sourceHash}`,
    ].join('\n'));
    return sha256Hex(descriptor);
}

function locateInIndex(index, text, {
    pdfPageIndexHint,
    measureText,
}) {
    const selectedText = String(text || '');
    const target = normalizePdfAnnotationText(selectedText);
    if (!target) throw notFoundError();
    if (pdfPageIndexHint !== undefined
        && (!Number.isSafeInteger(pdfPageIndexHint)
            || pdfPageIndexHint < 0)) {
        throw new Error('Invalid PDF annotation page hint');
    }
    const pages = pdfPageIndexHint === undefined
        ? index.pages
        : index.pages.filter(page => page.pageIndex === pdfPageIndexHint);
    let match = null;
    for (const page of pages) {
        const occurrences = findTextOccurrences(
            page.normalizedText,
            target,
            MAX_MATCHES
        );
        if (occurrences.truncated || occurrences.offsets.length > 1) {
            throw ambiguousError();
        }
        if (!occurrences.offsets.length) continue;
        if (match) throw ambiguousError();
        match = {
            page,
            normalizedFrom: occurrences.offsets[0],
        };
    }
    if (!match) throw notFoundError();
    const normalized = createDehyphenatedPdfAnnotationTextIndex(
        match.page.rawText
    );
    const sourceRange = normalized.sourceRange(
        match.normalizedFrom,
        target.length
    );
    const rects = locateSourceRange(
        match.page,
        sourceRange,
        measureText
    );
    if (!rects.length) throw notFoundError();
    return {
        text: selectedText,
        pageLabel: match.page.pageLabel,
        sortIndex: createSortIndex(
            match.page,
            sourceRange.from,
            rects[0]
        ),
        position: {
            pageIndex: match.page.pageIndex,
            rects,
        },
    };
}

function locateSourceRange(page, sourceRange, measureText) {
    const rects = [];
    for (const item of page.items) {
        const from = Math.max(sourceRange.from, item.sourceFrom);
        const to = Math.min(sourceRange.to, item.sourceTo);
        if (to <= from || !item.text) continue;
        const itemFrom = from - item.sourceFrom;
        const itemTo = to - item.sourceFrom;
        const rect = textItemRangeToPDFRect(page, item, {
            from: itemFrom,
            to: itemTo,
        }, measureText);
        if (rect) rects.push(rect);
    }
    return mergeLineRects(rects);
}

function textItemRangeToPDFRect(page, item, range, measureText) {
    const style = page.styles[item.fontName] || {};
    const tx = transform(page.viewport.transform, item.transform);
    let angle = Math.atan2(tx[1], tx[0]);
    if (style.vertical) angle += Math.PI / 2;
    const fontHeight = Math.hypot(tx[2], tx[3]);
    if (!Number.isFinite(fontHeight) || fontHeight <= 0) return null;
    const ascent = Number.isFinite(style.ascent)
        ? style.ascent
        : Number.isFinite(style.descent)
            ? 1 + style.descent
            : 0.8;
    const fontAscent = fontHeight * ascent;
    const left = angle === 0
        ? tx[4]
        : tx[4] + fontAscent * Math.sin(angle);
    const top = angle === 0
        ? tx[5] - fontAscent
        : tx[5] - fontAscent * Math.cos(angle);
    const advance = style.vertical ? item.height : item.width;
    if (!Number.isFinite(advance) || advance <= 0) return null;
    let fromRatio = textOffsetRatio(item.text, range.from, style, measureText);
    let toRatio = textOffsetRatio(item.text, range.to, style, measureText);
    if (item.direction === 'rtl') {
        [fromRatio, toRatio] = [1 - toRatio, 1 - fromRatio];
    }
    const horizontal = [Math.cos(angle), Math.sin(angle)];
    const vertical = [-Math.sin(angle), Math.cos(angle)];
    const corners = [
        viewportPoint(left, top, horizontal, vertical, advance * fromRatio, 0),
        viewportPoint(left, top, horizontal, vertical, advance * toRatio, 0),
        viewportPoint(
            left,
            top,
            horizontal,
            vertical,
            advance * toRatio,
            fontHeight
        ),
        viewportPoint(
            left,
            top,
            horizontal,
            vertical,
            advance * fromRatio,
            fontHeight
        ),
    ].map(point => inverseTransformPoint(
        page.viewport.transform,
        point
    ));
    if (!corners.every(point => point.every(Number.isFinite))) return null;
    const xs = corners.map(point => point[0]);
    const ys = corners.map(point => point[1]);
    const rect = [
        Math.min(...xs),
        Math.min(...ys),
        Math.max(...xs),
        Math.max(...ys),
    ];
    return rect[2] > rect[0] && rect[3] > rect[1] ? rect : null;
}

function textOffsetRatio(text, offset, style, measureText) {
    if (offset <= 0) return 0;
    if (offset >= text.length) return 1;
    const total = measureText({
        text,
        fontFamily: style.fontFamily || 'sans-serif',
    });
    const prefix = measureText({
        text: text.slice(0, offset),
        fontFamily: style.fontFamily || 'sans-serif',
    });
    if (Number.isFinite(total) && total > 0 && Number.isFinite(prefix)) {
        return Math.max(0, Math.min(1, prefix / total));
    }
    return offset / text.length;
}

function transform(left, right) {
    return [
        left[0] * right[0] + left[2] * right[1],
        left[1] * right[0] + left[3] * right[1],
        left[0] * right[2] + left[2] * right[3],
        left[1] * right[2] + left[3] * right[3],
        left[0] * right[4] + left[2] * right[5] + left[4],
        left[1] * right[4] + left[3] * right[5] + left[5],
    ];
}

function viewportPoint(left, top, horizontal, vertical, along, down) {
    return [
        left + horizontal[0] * along + vertical[0] * down,
        top + horizontal[1] * along + vertical[1] * down,
    ];
}

function inverseTransformPoint(value, point) {
    const determinant = value[0] * value[3] - value[1] * value[2];
    if (!Number.isFinite(determinant) || determinant === 0) {
        return [NaN, NaN];
    }
    const x = point[0] - value[4];
    const y = point[1] - value[5];
    return [
        (value[3] * x - value[2] * y) / determinant,
        (-value[1] * x + value[0] * y) / determinant,
    ];
}

function mergeLineRects(rects) {
    const merged = [];
    for (const rect of rects) {
        const previous = merged.at(-1);
        const sameLine = previous
            && Math.abs(previous[1] - rect[1]) <= 1
            && Math.abs(previous[3] - rect[3]) <= 1
            && rect[0] - previous[2] <= 2;
        if (sameLine) {
            previous[0] = Math.min(previous[0], rect[0]);
            previous[1] = Math.min(previous[1], rect[1]);
            previous[2] = Math.max(previous[2], rect[2]);
            previous[3] = Math.max(previous[3], rect[3]);
        }
        else {
            merged.push([...rect]);
        }
    }
    return merged;
}

function createSortIndex(page, sourceOffset, rect) {
    const pageIndex = formatSortIndexPart(page.pageIndex, 5);
    const offset = formatSortIndexPart(sourceOffset, 6);
    const top = formatSortIndexPart(
        page.viewport.height - rect[3],
        5
    );
    return `${pageIndex}|${offset}|${top}`;
}

function formatSortIndexPart(value, width) {
    const maximum = (10 ** width) - 1;
    const integer = Math.min(
        maximum,
        Math.max(0, Math.floor(value))
    );
    return String(integer).padStart(width, '0');
}

function defaultMeasureText({ text }) {
    return [...String(text)].length;
}

function validateItemID(itemID) {
    if (!Number.isSafeInteger(itemID) || itemID <= 0) {
        throw new TypeError('A PDF item ID is required');
    }
}

function validateSourceHash(value) {
    if (!/^[a-f0-9]{64}$/.test(String(value))) {
        throw new TypeError('A PDF source SHA-256 hash is required');
    }
}

function notFoundError() {
    return annotationError(
        'MKTERO_PDF_TEXT_NOT_FOUND',
        'Selected Markdown text was not found in the PDF'
    );
}

function ambiguousError() {
    return annotationError(
        'MKTERO_PDF_TEXT_AMBIGUOUS',
        'Selected Markdown text occurs multiple times in the PDF'
    );
}

function normalizeOfflineIndexError(error) {
    if (error?.code === 'MKTERO_PDF_INDEX_UNAVAILABLE'
        || error?.code === 'MKTERO_PDF_TEXT_NOT_FOUND'
        || error?.code === 'MKTERO_PDF_TEXT_AMBIGUOUS'
        || error?.name === 'AbortError') {
        return error;
    }
    return annotationError(
        'MKTERO_PDF_INDEX_UNAVAILABLE',
        'The local PDF text index is unavailable'
    );
}

function annotationError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function disposedError() {
    const error = new Error('PDF annotation locator is disposed');
    error.code = 'MKTERO_PDF_INDEX_UNAVAILABLE';
    return error;
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    throw abortReason(signal);
}

function abortReason(signal) {
    if (signal?.reason) return signal.reason;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}

function defaultCreateAbortController() {
    if (typeof globalThis.AbortController !== 'function') {
        throw new Error('AbortController is unavailable for PDF indexing');
    }
    return new globalThis.AbortController();
}
