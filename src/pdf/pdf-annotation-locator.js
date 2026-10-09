import {
    createAbbreviationFoldedPdfAnnotationTextIndex,
    createDehyphenatedPdfAnnotationTextIndex,
    createHyphenFoldedPdfAnnotationTextIndex,
    createHyphenPreservingPdfAnnotationTextIndex,
    createPdfAnnotationTextIndex,
    normalizePdfAnnotationText,
} from '../markdown/pdf-annotation-text.js';
import { findTextOccurrences } from '../markdown/text-normalization.js';
import { isValidNormalizedSourceBBox } from '../core/markdown-source-map.js';
import { sha256Hex } from '../core/sha256.js';
import {
    leadingCodePoints,
    MAX_PDF_ANNOTATION_TEXT_QUOTE_CONTEXT_CODE_POINTS,
    normalizePDFAnnotationTextQuote,
    trailingCodePoints,
} from '../core/pdf-annotation.js';

const MAX_MATCHES = 10_000;
const MIN_GLYPH_FALLBACK_TEXT_LENGTH = 32;
const MIN_TEXT_QUOTE_CONTEXT_MATCH_LENGTH = 12;
const MIN_PROSE_FRAGMENT_LENGTH = 12;
const MAX_MISENCODED_CITATION_GAP = 32;
const MIN_PAGE_BREAK_MATCH_LENGTH = 24;
const MIN_PAGE_BREAK_PART_LENGTH = 12;
const PAGE_BREAK_ANCHOR_LENGTH = 12;
// The journal watermark sits in the last stretch of the page, so a part that
// stopped there marks a page break rather than a mismatch.
const PAGE_BREAK_CHROME_WINDOW = 240;
const MAX_PAGE_BREAK_PAGE_DISTANCE = 3;
const MAX_PAGE_BREAK_STARTS = 16;
const MIN_DIFF_MATCH_LENGTH = 48;
const MAX_DIFF_MATCH_LENGTH = 1_000;
const DIFF_ANCHOR_LENGTH = 24;
const MAX_DIFF_EDIT_RATIO = 0.04;
const MAX_DIFF_EDITS = 12;
const MAX_DIFF_CANDIDATES = 200;
const MAX_DIFF_LONG_CANDIDATES = 8;
const DIFF_LONG_TEXT_LENGTH = 400;
const MIN_REPEATED_PAGE_HEADER_LENGTH = 20;
const MISENCODED_PLUS_MINUS = /§(?=\d)/gu;
const PLUS_MINUS_NUMBER = /±(?=\d)/u;
const MISENCODED_MAPSTO = /\s*7\s*→/gu;
const MAPSTO_TEXT = /↦/u;

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
                    pdfRegion: options.pdfRegion,
                    textQuote: options.textQuote,
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

    async locateTextQuote(itemID, text, options = {}) {
        this.#requireActive();
        throwIfAborted(options.signal);
        validateItemID(itemID);
        const sourceOffset = parseSortIndexSourceOffset(
            options.sortIndex,
            options.pdfPageIndexHint
        );
        if (sourceOffset === null) return null;
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
                this.#reportError(error);
                return null;
            }
        }
        if (!entry?.index) return null;
        throwIfAborted(options.signal);
        return locateTextQuoteInIndex(entry.index, text, {
            pdfPageIndexHint: options.pdfPageIndexHint,
            sourceOffset,
        });
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
    pdfRegion,
    textQuote,
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
    const quote = normalizePDFAnnotationTextQuote(textQuote);
    // A paragraph can span pages, so the hint may name its first page while
    // the selected text sits on a later one. Retry without the hint when the
    // hinted page yields nothing.
    const attempts = pages === index.pages
        ? [{ pages, hint: pdfPageIndexHint }]
        : [{ pages, hint: pdfPageIndexHint }, { pages: index.pages, hint: undefined }];
    let located = null;
    for (const attempt of attempts) {
        located = findMatchWithTextStrategies(attempt.pages, target, quote);
        if (!located) {
            located = findCrossPageMatch(
                index.pages,
                target,
                quote,
                attempt.hint
            );
        }
        if (!located
            && target.length >= MIN_GLYPH_FALLBACK_TEXT_LENGTH
            && PLUS_MINUS_NUMBER.test(target)) {
            located = findMatchWithTextStrategies(
                attempt.pages,
                target,
                quote,
                normalizedText => normalizedText.replace(
                    MISENCODED_PLUS_MINUS,
                    '±'
                )
            );
            if (!located) {
                located = findCrossPageMatch(
                    index.pages,
                    target,
                    quote,
                    attempt.hint,
                    normalizedText => normalizedText.replace(
                        MISENCODED_PLUS_MINUS,
                        '±'
                    )
                );
            }
        }
        if (!located
            && target.length >= MIN_GLYPH_FALLBACK_TEXT_LENGTH
            && MAPSTO_TEXT.test(target)) {
            located = findMatchWithTextStrategies(
                attempt.pages,
                target,
                quote,
                normalizedText => normalizedText.replace(MISENCODED_MAPSTO, '↦')
            );
            if (!located) {
                located = findCrossPageMatch(
                    index.pages,
                    target,
                    quote,
                    attempt.hint,
                    normalizedText => normalizedText.replace(MISENCODED_MAPSTO, '↦')
                );
            }
        }
        if (located) break;
    }
    if (!located) {
        // A paragraph can continue several pages later, so this fallback always
        // searches the whole document instead of the hinted page.
        located = findPageBreakMatch(index.pages, target, value => value);
    }
    if (!located) {
        const regionLocated = locatePDFRegion(index, pdfRegion, selectedText);
        if (regionLocated) return regionLocated;
        throw notFoundError();
    }
    if (located.segments) {
        const segments = locateCrossPageSegments(
            located.segments,
            measureText
        );
        if (!segments || segments.length < 2) throw notFoundError();
        return {
            text: selectedText,
            pageLabel: segments[0].pageLabel,
            sortIndex: segments[0].sortIndex,
            position: segments[0].position,
            segments,
        };
    }
    const { match, sourceRange } = located;
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

// Display equations rarely survive the PDF text layer intact, so when every
// text strategy fails, fall back to the OCR region recorded for the block the
// selection covers.
function locatePDFRegion(index, region, text) {
    if (!region
        || !Number.isSafeInteger(region.pageIndex)
        || region.pageIndex < 0
        || !isValidNormalizedSourceBBox(region.bbox)) {
        return null;
    }
    const page = index.pages.find(candidate => (
        candidate.pageIndex === region.pageIndex
    ));
    if (!page) return null;
    const rect = normalizedBBoxToPageRect(page, region.bbox);
    if (!rect) return null;
    return {
        text,
        pageLabel: page.pageLabel,
        sortIndex: createSortIndex(page, 0, rect),
        position: {
            pageIndex: page.pageIndex,
            rects: [rect],
        },
    };
}

function normalizedBBoxToPageRect(page, bbox) {
    const viewport = page?.viewport;
    if (!isValidNormalizedSourceBBox(bbox)
        || !Array.isArray(viewport?.transform)
        || !Number.isFinite(viewport.width)
        || viewport.width <= 0
        || !Number.isFinite(viewport.height)
        || viewport.height <= 0) {
        return null;
    }
    const left = bbox[0] * viewport.width / 1000;
    const top = bbox[1] * viewport.height / 1000;
    const right = bbox[2] * viewport.width / 1000;
    const bottom = bbox[3] * viewport.height / 1000;
    const corners = [
        [left, top],
        [right, top],
        [right, bottom],
        [left, bottom],
    ].map(point => inverseTransformPoint(viewport.transform, point));
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

function findMatchWithTextStrategies(
    pages,
    target,
    textQuote,
    transformText = value => value
) {
    for (const strategy of basicTextMatchStrategies()) {
        const normalizedTextQuote = mapTextQuote(textQuote, value => (
            transformText(strategy.createSourceIndex(value).text.trim())
        ));
        const match = findUniqueIndexMatch(
            pages,
            target,
            page => transformText(strategy.normalizedTextForPage(page)),
            normalizedTextQuote
        );
        if (match) {
            const sourceIndex = strategy.createSourceIndex(match.page.rawText);
            return {
                match,
                sourceRange: sourceIndex.sourceRange(
                    match.normalizedFrom,
                    target.length
                ),
            };
        }
    }
    return findLineEndHyphenVariantMatch(
        pages,
        target,
        textQuote,
        transformText
    ) || findAbbreviationSpacingMatch(
        pages,
        target,
        textQuote,
        transformText
    ) || findMisencodedCitationMatch(
        pages,
        target,
        textQuote,
        transformText
    ) || findBoundedDiffMatch(
        pages,
        target,
        textQuote,
        transformText
    );
}

// A paragraph can continue on a later page: an intervening full-page figure and
// the journal watermark keep the two halves from ever appearing as one string.
// Splitting the selection at a word boundary and matching both halves keeps the
// passage locatable as a per-page highlight.
function findPageBreakMatch(pages, target) {
    if (target.length < MIN_PAGE_BREAK_MATCH_LENGTH) return null;
    for (const strategy of basicTextMatchStrategies()) {
        const texts = pages.map(page => strategy.normalizedTextForPage(page));
        const parts = pageBreakSegments(pages, texts, target);
        if (!parts) continue;
        const firstPage = pages[parts[0].pageIndex];
        const sourceIndex = strategy.createSourceIndex(firstPage.rawText);
        return {
            segments: [{
                page: firstPage,
                sourceRange: sourceIndex.sourceRange(
                    parts[0].at,
                    parts[0].length
                ),
            }, parts[1]],
        };
    }
    return null;
}

function pageBreakSegments(pages, texts, target) {
    const starts = pageBreakStartCandidates(texts, target);
    if (!starts) return null;
    const walks = [];
    for (const start of starts) {
        const parts = walkPageBreakSegments(pages, texts, target, start);
        if (parts) walks.push(parts);
    }
    return walks.length === 1 ? walks[0] : null;
}

// The opening words are short enough to repeat across a paper, so every
// candidate start is walked and only a unique complete path is accepted.
function pageBreakStartCandidates(texts, target) {
    const anchor = target.slice(0, PAGE_BREAK_ANCHOR_LENGTH);
    const starts = [];
    for (let index = 0; index < texts.length; index += 1) {
        const at = texts[index].indexOf(anchor);
        if (at < 0) continue;
        if (texts[index].indexOf(anchor, at + 1) >= 0) continue;
        starts.push({ pageIndex: index, at });
        if (starts.length > MAX_PAGE_BREAK_STARTS) return null;
    }
    return starts.length ? starts : null;
}

// The opening part is aligned exactly; when it stops inside the page's last
// stretch (the watermark), the rest of the passage is looked up a page or two
// later with the same tolerant matching used elsewhere.
function walkPageBreakSegments(pages, texts, target, start) {
    const text = texts[start.pageIndex];
    const firstLength = commonPrefixLength(text.slice(start.at), target);
    if (firstLength < Math.min(MIN_PAGE_BREAK_PART_LENGTH, target.length)) {
        return null;
    }
    if (firstLength >= target.length) return null;
    if (text.length - (start.at + firstLength) > PAGE_BREAK_CHROME_WINDOW) {
        return null;
    }
    const remainder = target.slice(firstLength).replace(/^\s+/u, '');
    const from = start.pageIndex + 1;
    const tail = pages.slice(from, from + MAX_PAGE_BREAK_PAGE_DISTANCE);
    if (!tail.length) return null;
    const second = findRemainderSegment(tail, remainder);
    if (!second) return null;
    return [
        { pageIndex: start.pageIndex, at: start.at, length: firstLength },
        second,
    ];
}

function findRemainderSegment(tail, remainder) {
    if (!remainder) return null;
    for (const strategy of basicTextMatchStrategies()) {
        const matches = [];
        for (const page of tail) {
            const occurrences = findTextOccurrences(
                strategy.normalizedTextForPage(page),
                remainder,
                MAX_MATCHES
            );
            if (occurrences.truncated || occurrences.offsets.length > 1) {
                return null;
            }
            if (!occurrences.offsets.length) continue;
            const sourceIndex = strategy.createSourceIndex(page.rawText);
            matches.push({
                page,
                sourceRange: sourceIndex.sourceRange(
                    occurrences.offsets[0],
                    remainder.length
                ),
            });
        }
        if (matches.length === 1) return matches[0];
        if (matches.length > 1) return null;
    }
    // A mangled citation or hyphen inside the rest still matches tolerantly.
    const tolerant = findBoundedDiffMatch(tail, remainder, null, value => value);
    return tolerant
        ? { page: tolerant.match.page, sourceRange: tolerant.sourceRange }
        : null;
}

// The PDF text layer mangles math glyphs (for example "q(t)=0" becomes
// "q(?)=0" and "t<=N" becomes "t <,N"). Anchoring on the surrounding prose and
// allowing a small edit budget keeps such a passage locatable without turning
// the lookup into an unconstrained fuzzy search.
function findBoundedDiffMatch(pages, target, textQuote, transformText) {
    if (target.length < MIN_DIFF_MATCH_LENGTH
        || target.length > MAX_DIFF_MATCH_LENGTH) {
        return null;
    }
    const maxEdits = Math.max(2, Math.min(
        MAX_DIFF_EDITS,
        Math.floor(target.length * MAX_DIFF_EDIT_RATIO)
    ));
    for (const strategy of basicTextMatchStrategies()) {
        const normalizedTextQuote = mapTextQuote(textQuote, value => (
            transformText(strategy.createSourceIndex(value).text.trim())
        ));
        const candidates = [];
        let overflowed = false;
        for (const page of pages) {
            const normalizedText = transformText(
                strategy.normalizedTextForPage(page)
            );
            const found = diffCandidates(
                normalizedText,
                target,
                maxEdits
            );
            if (found === null) {
                overflowed = true;
                break;
            }
            for (const candidate of found) {
                candidates.push({
                    page,
                    normalizedFrom: candidate.from,
                    normalizedText,
                    normalizedLength: candidate.to - candidate.from,
                    distance: candidate.distance,
                });
            }
        }
        if (overflowed || !candidates.length) continue;
        const best = Math.min(...candidates.map(item => item.distance));
        const winners = candidates.filter(item => item.distance === best);
        const match = winners.length === 1
            ? winners[0]
            : findUniqueContextualMatch(
                winners,
                target.length,
                normalizedTextQuote
            );
        if (!match) continue;
        const sourceIndex = strategy.createSourceIndex(match.page.rawText);
        return {
            match,
            sourceRange: sourceIndex.sourceRange(
                match.normalizedFrom,
                match.normalizedLength
            ),
        };
    }
    return null;
}

// The mangled span can sit anywhere in the selection, so the anchor is the
// first slice of the target that the page actually contains.
function diffAnchorOffset(text, target) {
    const last = target.length - DIFF_ANCHOR_LENGTH;
    if (last < 0) return -1;
    const offsets = last === 0
        ? [0]
        : [
            0,
            Math.round(last / 4),
            Math.round(last / 2),
            Math.round((last * 3) / 4),
            last,
        ];
    for (const offset of offsets) {
        const anchor = target.slice(offset, offset + DIFF_ANCHOR_LENGTH);
        if (text.includes(anchor)) return offset;
    }
    return -1;
}

function diffCandidates(text, target, maxEdits) {
    const anchorOffset = diffAnchorOffset(text, target);
    if (anchorOffset < 0) return [];
    const candidateLimit = target.length > DIFF_LONG_TEXT_LENGTH
        ? MAX_DIFF_LONG_CANDIDATES
        : MAX_DIFF_CANDIDATES;
    const anchor = target.slice(
        anchorOffset,
        anchorOffset + DIFF_ANCHOR_LENGTH
    );
    const occurrences = findTextOccurrences(text, anchor, MAX_MATCHES);
    if (occurrences.truncated) return null;
    const candidates = [];
    for (const position of occurrences.offsets) {
        const windowFrom = Math.max(
            0,
            position - anchorOffset - maxEdits
        );
        // The window must cover the whole target from the anchor occurrence:
        // trimming it by the anchor offset again made mid-target anchors
        // (used whenever the selection head carries a glyph mismatch) end
        // short of the selection tail, so the alignment could never fit.
        const windowTo = Math.min(
            text.length,
            position - anchorOffset + target.length + maxEdits
        );
        const aligned = alignedDiffSpan(
            target,
            text.slice(windowFrom, windowTo),
            maxEdits
        );
        if (!aligned) continue;
        candidates.push({
            from: windowFrom + aligned.from,
            to: windowFrom + aligned.to,
            distance: aligned.distance,
        });
        if (candidates.length > candidateLimit) return null;
    }
    return candidates;
}

// Semi-global alignment: the search window is padded on both sides, so the
// window edges are skipped for free and the traceback reports exactly which
// page characters the selection covers.
function alignedDiffSpan(target, windowText, limit) {
    const targetLength = target.length;
    const windowLength = windowText.length;
    if (targetLength > windowLength) return null;
    const rows = [];
    for (let row = 0; row <= targetLength; row += 1) {
        rows.push(new Uint16Array(windowLength + 1));
    }
    for (let row = 1; row <= targetLength; row += 1) {
        rows[row][0] = Math.min(row, limit + 1);
        for (let column = 1; column <= windowLength; column += 1) {
            const cost = target[row - 1] === windowText[column - 1] ? 0 : 1;
            rows[row][column] = Math.min(
                rows[row - 1][column] + 1,
                rows[row][column - 1] + 1,
                rows[row - 1][column - 1] + cost,
                limit + 1
            );
        }
    }
    let best = limit + 1;
    let end = -1;
    for (let column = 1; column <= windowLength; column += 1) {
        const value = rows[targetLength][column];
        if (value < best) {
            best = value;
            end = column;
        }
    }
    if (end < 0) return null;
    let row = targetLength;
    let column = end;
    let start = 0;
    while (row > 0) {
        const cost = target[row - 1] === windowText[column - 1] ? 0 : 1;
        if (column > 0
            && rows[row][column] === rows[row - 1][column - 1] + cost) {
            row -= 1;
            column -= 1;
            start = column;
            continue;
        }
        if (rows[row][column] === rows[row - 1][column] + 1) {
            row -= 1;
            continue;
        }
        if (column > 0
            && rows[row][column] === rows[row][column - 1] + 1) {
            column -= 1;
            continue;
        }
        return null;
    }
    if (end <= start) return null;
    return { distance: best, from: start, to: end };
}

function findAbbreviationSpacingMatch(
    pages,
    target,
    textQuote,
    transformText
) {
    for (const strategy of basicTextMatchStrategies()) {
        const foldedTargetIndex = (
            createAbbreviationFoldedPdfAnnotationTextIndex(
                strategy.normalizedTextForPage({ rawText: target })
            )
        );
        const foldedTarget = foldedTargetIndex.trimmedText;
        if (!foldedTarget) continue;
        const normalizedTextQuote = mapTextQuote(textQuote, value => (
            transformText(
                createAbbreviationFoldedPdfAnnotationTextIndex(
                    strategy.createSourceIndex(value).text
                ).text.trim()
            )
        ));
        const matches = [];
        for (const page of pages) {
            const sourceIndex = createAbbreviationFoldedPdfAnnotationTextIndex(
                strategy.normalizedTextForPage(page)
            );
            const normalizedText = transformText(sourceIndex.text);
            const occurrences = findTextOccurrences(
                normalizedText,
                foldedTarget,
                MAX_MATCHES
            );
            if (occurrences.truncated) throw ambiguousError();
            for (const normalizedFrom of occurrences.offsets) {
                matches.push({
                    page,
                    normalizedFrom,
                    normalizedText,
                    sourceIndex,
                });
                if (matches.length > MAX_MATCHES) throw ambiguousError();
            }
        }
        const match = selectUniqueIndexMatch(
            matches,
            foldedTarget.length,
            normalizedTextQuote
        );
        if (!match) continue;
        const sourceRange = match.sourceIndex.sourceRange(
            match.normalizedFrom,
            foldedTarget.length
        );
        const trimmedRange = foldedTargetIndex.trimmedSourceRange();
        return {
            match,
            sourceRange: {
                from: sourceRange.from,
                to: sourceRange.from
                    + trimmedRange.to
                    - trimmedRange.from,
            },
        };
    }
    return null;
}

function findMisencodedCitationMatch(
    pages,
    target,
    textQuote,
    transformText
) {
    const fragments = proseFragmentsAroundCitations(target);
    if (!fragments) return null;
    for (const strategy of basicTextMatchStrategies()) {
        const normalizedTextQuote = mapTextQuote(textQuote, value => (
            transformText(strategy.createSourceIndex(value).text.trim())
        ));
        const matches = [];
        for (const page of pages) {
            const normalizedText = transformText(
                strategy.normalizedTextForPage(page)
            );
            for (const span of misencodedCitationSpans(
                normalizedText,
                fragments
            )) {
                matches.push({
                    page,
                    normalizedFrom: span.from,
                    normalizedText,
                    normalizedLength: span.to - span.from,
                });
                if (matches.length > MAX_MATCHES) throw ambiguousError();
            }
        }
        const match = selectUniqueIndexMatch(
            matches,
            fragments.join('').length,
            normalizedTextQuote
        );
        if (!match) continue;
        const sourceIndex = strategy.createSourceIndex(match.page.rawText);
        return {
            match,
            sourceRange: sourceIndex.sourceRange(
                match.normalizedFrom,
                match.normalizedLength
            ),
        };
    }
    return null;
}

function proseFragmentsAroundCitations(target) {
    const pattern = /(^|\s)(?:\d+(?:\s*[-,]\s*\d+)*|[\[\(]\d+(?:\s*[-,]\s*\d+)*[\]\)])(?=\s|[,.;:]|$)/gu;
    const fragments = [];
    let from = 0;
    for (const match of target.matchAll(pattern)) {
        const prose = target.slice(from, match.index).trim();
        if (prose) fragments.push(prose);
        from = match.index + match[0].length;
    }
    const tail = target.slice(from).trim();
    if (tail) fragments.push(tail);
    if (fragments.length < 2
        || fragments.join('').length === target.trim().length
        || fragments.some(fragment => (
            fragment.length < MIN_PROSE_FRAGMENT_LENGTH
        ))) {
        return null;
    }
    return fragments;
}

function misencodedCitationSpans(text, fragments) {
    const spans = [];
    const occurrences = findTextOccurrences(
        text,
        fragments[0],
        MAX_MATCHES
    );
    if (occurrences.truncated) throw ambiguousError();
    for (const start of occurrences.offsets) {
        let cursor = start + fragments[0].length;
        let valid = true;
        for (let index = 1; index < fragments.length; index += 1) {
            const fragment = fragments[index];
            const gap = text.slice(
                cursor,
                cursor + MAX_MISENCODED_CITATION_GAP + fragment.length
            );
            const found = gap.indexOf(fragment);
            if (found < 0
                || found > MAX_MISENCODED_CITATION_GAP
                || /\p{L}/u.test(gap.slice(0, found))) {
                valid = false;
                break;
            }
            cursor += found + fragment.length;
        }
        if (valid) spans.push({ from: start, to: cursor });
    }
    return spans;
}

function findCrossPageMatch(
    pages,
    target,
    textQuote,
    pdfPageIndexHint,
    transformText = value => value
) {
    for (const strategy of basicTextMatchStrategies()) {
        const sequence = createCrossPageSequence(
            pages,
            strategy,
            transformText
        );
        const occurrences = findTextOccurrences(
            sequence.text,
            target,
            MAX_MATCHES
        );
        if (occurrences.truncated) throw ambiguousError();
        const matches = [];
        for (const normalizedFrom of occurrences.offsets) {
            const startPart = findCrossPagePart(
                sequence.parts,
                normalizedFrom
            );
            if (!startPart
                || (pdfPageIndexHint !== undefined
                    && startPart.page.pageIndex !== pdfPageIndexHint)) {
                continue;
            }
            const segments = crossPageSourceSegments(
                sequence,
                normalizedFrom,
                target.length
            );
            if (segments.length < 2
                || !segmentsAreAdjacent(segments)) {
                continue;
            }
            matches.push({
                normalizedFrom,
                normalizedText: sequence.text,
                page: startPart.page,
                segments,
            });
            if (matches.length > MAX_MATCHES) throw ambiguousError();
        }
        const match = selectUniqueIndexMatch(
            matches,
            target.length,
            mapTextQuote(textQuote, value => transformText(
                strategy.createSourceIndex(value).text.trim()
            ))
        );
        if (match) return match;
    }
    return null;
}

function createCrossPageSequence(
    pages,
    strategy,
    transformText
) {
    const parts = [];
    const output = [];
    let offset = 0;
    for (const [pageIndex, page] of pages.entries()) {
        const sourceIndex = strategy.createSourceIndex(page.rawText);
        const normalizedText = transformText(
            strategy.normalizedTextForPage(page)
        );
        const contentRange = crossPageContentRange(
            pages,
            pageIndex,
            normalizedText
        );
        const text = normalizedText.slice(
            contentRange.from,
            contentRange.to
        );
        if (!text) continue;
        if (output.length) {
            output.push(' ');
            offset++;
        }
        const from = offset;
        output.push(text);
        offset += text.length;
        parts.push({
            from,
            page,
            normalizedFrom: contentRange.from,
            to: offset,
            sourceIndex,
        });
    }
    return { parts, text: output.join('') };
}

function crossPageContentRange(
    pages,
    pageIndex,
    normalizedText
) {
    let from = 0;
    let to = normalizedText.length;
    if (pageIndex > 0
        && hasRepeatedPageHeader(
            pages[pageIndex - 1],
            pages[pageIndex],
            normalizedText
        )) {
        const header = firstNonEmptyPageItem(pages[pageIndex]);
        const normalizedHeader = sourceIndexForText(header.text);
        from = normalizedText.indexOf(normalizedHeader);
        if (from < 0) from = 0;
        else from += normalizedHeader.length;
    }
    const pageNumber = trailingPageNumberStart(
        pages[pageIndex],
        normalizedText
    );
    if (pageNumber !== null) to = Math.min(to, pageNumber);
    while (from < to && /^\s$/u.test(normalizedText[from])) from++;
    while (to > from && /^\s$/u.test(normalizedText[to - 1])) to--;
    return { from, to };
}

function hasRepeatedPageHeader(
    previousPage,
    page,
    normalizedText
) {
    const previousHeader = firstNonEmptyPageItem(previousPage);
    const header = firstNonEmptyPageItem(page);
    if (!previousHeader
        || !header
        || previousHeader.sourceFrom !== 0
        || header.sourceFrom !== 0
        || previousHeader.text !== header.text
        || header.text.trim().length < MIN_REPEATED_PAGE_HEADER_LENGTH) {
        return false;
    }
    const normalizedHeader = sourceIndexForText(header.text);
    return normalizedHeader.length > 0
        && normalizedText.startsWith(normalizedHeader);
}

function firstNonEmptyPageItem(page) {
    return page?.items?.find(item => (
        typeof item?.text === 'string' && item.text.trim()
    )) || null;
}

function sourceIndexForText(text) {
    return String(text).trim();
}

function trailingPageNumberStart(page, normalizedText) {
    const item = [...(page?.items || [])].reverse().find(value => (
        typeof value?.text === 'string' && value.text.trim()
    ));
    if (!item || item.text.trim() !== String(page.pageIndex + 1)) {
        return null;
    }
    const normalizedNumber = String(item.text).trim();
    const end = normalizedText.trimEnd().length;
    const start = end - normalizedNumber.length;
    return start >= 0 && normalizedText.slice(start, end) === normalizedNumber
        ? start
        : null;
}

function segmentsAreAdjacent(segments) {
    return segments.every((segment, index) => index === 0
        || segment.page.pageIndex === segments[index - 1].page.pageIndex + 1);
}

function findCrossPagePart(parts, offset) {
    let low = 0;
    let high = parts.length - 1;
    while (low <= high) {
        const middle = low + Math.floor((high - low) / 2);
        const part = parts[middle];
        if (offset < part.from) high = middle - 1;
        else if (offset >= part.to) low = middle + 1;
        else return part;
    }
    return null;
}

function crossPageSourceSegments(
    sequence,
    normalizedFrom,
    targetLength
) {
    const normalizedTo = normalizedFrom + targetLength;
    const segments = [];
    for (const part of sequence.parts) {
        const from = Math.max(normalizedFrom, part.from);
        const to = Math.min(normalizedTo, part.to);
        if (to <= from) continue;
        const sourceRange = part.sourceIndex.sourceRange(
            part.normalizedFrom + from - part.from,
            to - from
        );
        segments.push({ page: part.page, sourceRange });
    }
    return segments;
}

function locateCrossPageSegments(segments, measureText) {
    const located = segments.map(({ page, sourceRange }) => {
        const rects = locateSourceRange(page, sourceRange, measureText);
        if (!rects.length) return null;
        const text = page.rawText.slice(sourceRange.from, sourceRange.to);
        if (!text.trim()) return null;
        return {
            text,
            pageLabel: page.pageLabel,
            sortIndex: createSortIndex(
                page,
                sourceRange.from,
                rects[0]
            ),
            position: {
                pageIndex: page.pageIndex,
                rects,
            },
        };
    });
    return located.every(Boolean) ? located : null;
}

function locateTextQuoteInIndex(index, text, {
    pdfPageIndexHint,
    sourceOffset,
}) {
    const target = normalizePdfAnnotationText(String(text || ''));
    if (!target) return null;
    const page = index.pages.find(candidate => (
        candidate.pageIndex === pdfPageIndexHint
    ));
    if (!page) return null;
    for (const strategy of basicTextMatchStrategies()) {
        const normalizedText = strategy.normalizedTextForPage(page);
        const occurrences = findTextOccurrences(
            normalizedText,
            target,
            MAX_MATCHES
        );
        if (occurrences.truncated) return null;
        const sourceIndex = strategy.createSourceIndex(page.rawText);
        const matchingOffsets = occurrences.offsets.filter(normalizedFrom => (
            sourceIndex.sourceRange(normalizedFrom, target.length).from
                === sourceOffset
        ));
        if (matchingOffsets.length !== 1) continue;
        const normalizedFrom = matchingOffsets[0];
        return normalizePDFAnnotationTextQuote({
            prefix: trailingCodePoints(
                normalizedText,
                MAX_PDF_ANNOTATION_TEXT_QUOTE_CONTEXT_CODE_POINTS,
                normalizedFrom
            ),
            suffix: leadingCodePoints(
                normalizedText,
                MAX_PDF_ANNOTATION_TEXT_QUOTE_CONTEXT_CODE_POINTS,
                normalizedFrom + target.length
            ),
        });
    }
    let variants;
    try {
        variants = collectLineEndHyphenVariantMatches(
            [page],
            target,
            value => value
        );
    }
    catch (error) {
        if (error?.code === 'MKTERO_PDF_TEXT_AMBIGUOUS') return null;
        throw error;
    }
    const matching = variants.matches.filter(match => (
        match.sourceRange.from === sourceOffset
    ));
    if (matching.length !== 1) return null;
    const match = matching[0];
    return normalizePDFAnnotationTextQuote({
        prefix: trailingCodePoints(
            match.normalizedText,
            MAX_PDF_ANNOTATION_TEXT_QUOTE_CONTEXT_CODE_POINTS,
            match.normalizedFrom
        ),
        suffix: leadingCodePoints(
            match.normalizedText,
            MAX_PDF_ANNOTATION_TEXT_QUOTE_CONTEXT_CODE_POINTS,
            match.normalizedFrom + variants.targetLength
        ),
    });
}

function basicTextMatchStrategies() {
    return [
        {
            createSourceIndex: createDehyphenatedPdfAnnotationTextIndex,
            normalizedTextForPage: page => page.normalizedText,
        },
        {
            createSourceIndex: createHyphenPreservingPdfAnnotationTextIndex,
            normalizedTextForPage: page => (
                createHyphenPreservingPdfAnnotationTextIndex(
                    page.rawText
                ).text
            ),
        },
    ];
}

function findLineEndHyphenVariantMatch(
    pages,
    target,
    textQuote,
    transformText
) {
    const foldedTextQuote = mapTextQuote(textQuote, value => (
        transformText(
            createHyphenFoldedPdfAnnotationTextIndex(value).text.trim()
        )
    ));
    const variants = collectLineEndHyphenVariantMatches(
        pages,
        target,
        transformText
    );
    if (!variants.targetLength) return null;
    const match = selectUniqueIndexMatch(
        variants.matches,
        variants.targetLength,
        foldedTextQuote
    );
    return match ? { match, sourceRange: match.sourceRange } : null;
}

function collectLineEndHyphenVariantMatches(
    pages,
    target,
    transformText
) {
    // Folding finds candidates; exact alignment below keeps ordinary hyphens
    // significant and resolves each PDF line-end hyphen independently.
    const foldedTarget = createHyphenFoldedPdfAnnotationTextIndex(target).text;
    if (!foldedTarget) return { matches: [], targetLength: 0 };
    const matches = [];
    for (const page of pages) {
        const sourceIndex = createHyphenFoldedPdfAnnotationTextIndex(
            page.rawText
        );
        const normalizedSourceIndex = createPdfAnnotationTextIndex(
            page.rawText
        );
        const normalizedText = transformText(sourceIndex.text);
        const occurrences = findTextOccurrences(
            normalizedText,
            foldedTarget,
            MAX_MATCHES
        );
        if (occurrences.truncated) throw ambiguousError();
        for (const normalizedFrom of occurrences.offsets) {
            const sourceRange = sourceIndex.sourceRange(
                normalizedFrom,
                foldedTarget.length
            );
            if (!matchesLineEndHyphenVariants(
                normalizedSourceIndex,
                sourceRange,
                target,
                transformText
            )) {
                continue;
            }
            matches.push({
                page,
                normalizedFrom,
                normalizedText,
                sourceRange,
            });
            if (matches.length > MAX_MATCHES) throw ambiguousError();
        }
    }
    return {
        matches,
        targetLength: foldedTarget.length,
    };
}

function matchesLineEndHyphenVariants(
    sourceIndex,
    sourceRange,
    target,
    transformText
) {
    const normalizedRange = sourceIndex.normalizedRangeForSourceRange(
        sourceRange.from,
        sourceRange.to
    );
    const source = transformText(sourceIndex.text.slice(
        normalizedRange.from,
        normalizedRange.to
    ));
    let sourceOffset = 0;
    let targetOffset = 0;
    while (sourceOffset < source.length && targetOffset < target.length) {
        if (isLineEndHyphenAt(source, sourceOffset)) {
            if (target[targetOffset] === '-') targetOffset++;
            sourceOffset += 2;
            continue;
        }
        if (source[sourceOffset] !== target[targetOffset]) return false;
        sourceOffset++;
        targetOffset++;
    }
    return sourceOffset === source.length && targetOffset === target.length;
}

function isLineEndHyphenAt(text, offset) {
    return text[offset] === '-'
        && text[offset + 1] === ' '
        && isLetterCodePoint(codePointBefore(text, offset))
        && isLetterCodePoint(codePointAt(text, offset + 2));
}

function codePointBefore(text, offset) {
    if (offset <= 0) return '';
    const low = text.charCodeAt(offset - 1);
    const from = offset > 1 && low >= 0xDC00 && low <= 0xDFFF
        ? offset - 2
        : offset - 1;
    return codePointAt(text, from);
}

function codePointAt(text, offset) {
    if (offset < 0 || offset >= text.length) return '';
    return String.fromCodePoint(text.codePointAt(offset));
}

function isLetterCodePoint(character) {
    return /^\p{L}$/u.test(character);
}

function findUniqueIndexMatch(
    pages,
    target,
    normalizedTextForPage,
    textQuote
) {
    const matches = [];
    for (const page of pages) {
        const normalizedText = normalizedTextForPage(page);
        const occurrences = findTextOccurrences(
            normalizedText,
            target,
            MAX_MATCHES
        );
        if (occurrences.truncated) throw ambiguousError();
        for (const normalizedFrom of occurrences.offsets) {
            matches.push({
                page,
                normalizedFrom,
                normalizedText,
            });
            if (matches.length > MAX_MATCHES) throw ambiguousError();
        }
    }
    return selectUniqueIndexMatch(matches, target.length, textQuote);
}

function selectUniqueIndexMatch(matches, targetLength, textQuote) {
    if (matches.length <= 1) return matches[0] || null;
    const contextualMatch = findUniqueContextualMatch(
        matches,
        targetLength,
        textQuote
    );
    if (!contextualMatch) throw ambiguousError();
    return contextualMatch;
}

function findUniqueContextualMatch(matches, targetLength, textQuote) {
    if (!textQuote) return null;
    const prefixThreshold = Math.min(
        textQuote.prefix.length,
        MIN_TEXT_QUOTE_CONTEXT_MATCH_LENGTH
    );
    const suffixThreshold = Math.min(
        textQuote.suffix.length,
        MIN_TEXT_QUOTE_CONTEXT_MATCH_LENGTH
    );
    const scored = [];
    for (const match of matches) {
        const before = match.normalizedText
            .slice(0, match.normalizedFrom)
            .trimEnd();
        const after = match.normalizedText
            .slice(match.normalizedFrom + targetLength)
            .trimStart();
        const prefixScore = textQuote.prefix
            ? commonSuffixLength(before, textQuote.prefix)
            : 0;
        const suffixScore = textQuote.suffix
            ? commonPrefixLength(after, textQuote.suffix)
            : 0;
        if (prefixScore < prefixThreshold || suffixScore < suffixThreshold) {
            continue;
        }
        scored.push({ match, score: prefixScore + suffixScore });
    }
    if (!scored.length) return null;
    scored.sort((left, right) => right.score - left.score);
    if (scored.length > 1 && scored[1].score === scored[0].score) return null;
    return scored[0].match;
}

function commonPrefixLength(left, right) {
    const limit = Math.min(left.length, right.length);
    let index = 0;
    while (index < limit && left[index] === right[index]) index++;
    return index;
}

function commonSuffixLength(left, right) {
    const limit = Math.min(left.length, right.length);
    let index = 0;
    while (index < limit
        && left[left.length - 1 - index] === right[right.length - 1 - index]) {
        index++;
    }
    return index;
}

function mapTextQuote(textQuote, transformText) {
    if (!textQuote) return null;
    const prefix = transformText(textQuote.prefix);
    const suffix = transformText(textQuote.suffix);
    return prefix || suffix ? { prefix, suffix } : null;
}

function parseSortIndexSourceOffset(value, pageIndex) {
    if (!Number.isInteger(pageIndex) || pageIndex < 0) return null;
    const match = /^(\d{5})\|(\d{6})\|\d{5}$/u.exec(String(value || ''));
    if (!match || Number(match[1]) !== pageIndex) return null;
    return Number(match[2]);
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
