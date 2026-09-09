import './pdfjs-bootstrap-environment.js';
import {
    getDocument,
    GlobalWorkerOptions,
    version as PDFJS_VERSION,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
    WorkerMessageHandler,
} from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import {
    createDehyphenatedPdfAnnotationTextIndex,
} from '../markdown/pdf-annotation-text.js';
import { normalizePdfOutline } from './pdf-outline.js';
import {
    isLikelyNumericSuperscriptExponent,
    isNumericCitationContent,
} from '../markdown/text-normalization.js';

const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_PAGES = 10_000;
const MAX_PAGE_TEXT_LENGTH = 1_000_000;
const MAX_TOTAL_TEXT_LENGTH = 10_000_000;
const MAX_TEXT_ITEMS = 250_000;

export const PDF_TEXT_INDEX_PROFILE = `pdfjs-${PDFJS_VERSION}|text-v10`;

// Zotero's DOM-free plugin sandbox cannot dynamically import the packaged
// worker URL when PDF.js falls back to its in-process worker implementation.
globalThis.pdfjsWorker = { WorkerMessageHandler };

export function createPDFJSTextEngine({
    workerSrc = '',
    cMapUrl = '',
    standardFontDataUrl = '',
    wasmUrl = '',
    loadDocument = getDocument,
} = {}) {
    if (workerSrc) GlobalWorkerOptions.workerSrc = workerSrc;
    const loadingTasks = new Set();
    const destroyedTasks = new WeakSet();
    let active = true;
    const destroyLoadingTask = loadingTask => {
        if (!loadingTask || destroyedTasks.has(loadingTask)) {
            return Promise.resolve();
        }
        destroyedTasks.add(loadingTask);
        try {
            return Promise.resolve(loadingTask.destroy?.());
        }
        catch (error) {
            return Promise.reject(error);
        }
    };
    return {
        profile: PDF_TEXT_INDEX_PROFILE,
        async extract(fileData, { signal } = {}) {
            if (!active) throw indexUnavailableError();
            validatePDFData(fileData);
            throwIfAborted(signal);
            const pdfData = Uint8Array.from(fileData);
            throwIfAborted(signal);
            const loadingTask = loadDocument({
                data: pdfData,
                cMapUrl: cMapUrl || undefined,
                cMapPacked: true,
                standardFontDataUrl: standardFontDataUrl || undefined,
                wasmUrl: wasmUrl || undefined,
                useWorkerFetch: false,
                isOffscreenCanvasSupported: false,
                isImageDecoderSupported: false,
                useWasm: Boolean(wasmUrl),
                verbosity: 0,
            });
            if (!loadingTask || typeof loadingTask !== 'object') {
                throw new Error('PDF.js loading task is unavailable');
            }
            loadingTasks.add(loadingTask);
            const abort = () => { void destroyLoadingTask(loadingTask); };
            signal?.addEventListener?.('abort', abort, { once: true });
            try {
                const document = await loadingTask.promise;
                if (!Number.isSafeInteger(document.numPages)
                    || document.numPages < 1
                    || document.numPages > MAX_PAGES) {
                    throw new Error('PDF page count exceeds the index limit');
                }
                const pageLabels = await document.getPageLabels?.();
                const pages = [];
                let totalTextLength = 0;
                let totalItems = 0;
                for (let pageIndex = 0;
                    pageIndex < document.numPages;
                    pageIndex++) {
                    throwIfAborted(signal);
                    const page = await document.getPage(pageIndex + 1);
                    const viewport = page.getViewport({ scale: 1 });
                    const content = await page.getTextContent({
                        disableNormalization: true,
                        includeMarkedContent: false,
                    });
                    const contentItems = Array.isArray(content?.items)
                        ? content.items
                        : [];
                    if (contentItems.length > MAX_TEXT_ITEMS - totalItems) {
                        throw new Error('PDF text index exceeds the safety limit');
                    }
                    totalItems += contentItems.length;
                    const indexed = indexPageText(content);
                    totalTextLength += indexed.rawText.length;
                    if (indexed.rawText.length > MAX_PAGE_TEXT_LENGTH
                        || totalTextLength > MAX_TOTAL_TEXT_LENGTH
                        || totalItems > MAX_TEXT_ITEMS) {
                        throw new Error('PDF text index exceeds the safety limit');
                    }
                    pages.push({
                        pageIndex,
                        pageLabel: normalizePageLabel(
                            pageLabels?.[pageIndex],
                            pageIndex
                        ),
                        viewport: normalizeViewport(viewport),
                        rawText: indexed.rawText,
                        normalizedText: indexed.normalizedText,
                        items: indexed.items,
                        styles: normalizeStyles(content.styles),
                    });
                    page.cleanup?.();
                }
                let outline = [];
                try {
                    outline = normalizePdfOutline(await document.getOutline?.());
                }
                catch {
                    outline = [];
                }
                return {
                    profile: PDF_TEXT_INDEX_PROFILE,
                    pages,
                    outline,
                };
            }
            finally {
                signal?.removeEventListener?.('abort', abort);
                loadingTasks.delete(loadingTask);
                await destroyLoadingTask(loadingTask).catch(() => {});
            }
        },
        async dispose() {
            if (!active) return;
            active = false;
            const pending = [...loadingTasks];
            loadingTasks.clear();
            await Promise.allSettled(pending.map(destroyLoadingTask));
        },
    };
}

function indexPageText(content) {
    const source = [];
    const items = [];
    let sourceLength = 0;
    let previous = null;
    for (const value of orderPDFTextItems(content?.items || [])) {
        if (typeof value?.str !== 'string') continue;
        const text = value.str;
        const normalized = normalizeTextItem(value, 0, 0);
        const inlineNumericSuperscript = isInlineNumericSuperscript(
            previous,
            normalized
        );
        if (inlineNumericSuperscript
            || shouldInsertTextItemSpace(previous, normalized)) {
            source.push(' ');
            sourceLength++;
        }
        const sourceFrom = sourceLength;
        source.push(text);
        sourceLength += text.length;
        normalized.sourceFrom = sourceFrom;
        normalized.sourceTo = sourceLength;
        items.push(normalized);
        if (value.hasEOL) {
            source.push('\n');
            sourceLength++;
        }
        previous = {
            ...normalized,
            hasEOL: value.hasEOL === true,
            inlineNumericSuperscript,
        };
    }
    const rawText = source.join('');
    return {
        rawText,
        normalizedText: createDehyphenatedPdfAnnotationTextIndex(rawText).text,
        items,
    };
}

function orderPDFTextItems(values) {
    const ordered = [];
    let line = [];
    for (const value of values) {
        if (typeof value?.str !== 'string') continue;
        line.push(value);
        if (value.hasEOL === true) {
            appendPDFTextItems(ordered, orderPDFTextLine(line));
            line = [];
        }
    }
    if (line.length) appendPDFTextItems(ordered, orderPDFTextLine(line));
    return ordered;
}

function orderPDFTextLine(values) {
    const hasEOL = values.some(value => value.hasEOL === true);
    let visibleCount = 0;
    let candidateValue = null;
    for (const value of values) {
        if (!value.str.trim()) continue;
        visibleCount++;
        candidateValue = value;
    }
    if (!hasEOL
        || visibleCount < 3
        || !isMisplacedInlineCandidate(candidateValue.str)) {
        return values;
    }
    const entries = values.map((value, index) => ({
        value,
        index,
        normalized: normalizeTextItem(value, 0, 0),
    }));
    const visible = entries.filter(entry => entry.normalized.text.trim());
    const normalized = visible.map(entry => entry.normalized);
    if (!normalized.every(item => item.direction === 'ltr')) return values;
    const direction = textDirection(normalized[0].transform);
    const fontHeight = maximumTextItemFontHeight(normalized);
    if (!direction
        || !itemsShareVisualLine(normalized, direction, fontHeight)) {
        return values;
    }
    const candidate = visible.at(-1);
    const orderedVisible = visible.slice(0, -1);
    if (!itemsFollowContinuousInlineOrder(
        orderedVisible,
        direction,
        fontHeight
    )) {
        return values;
    }
    const insertionIndex = orderedVisible.findIndex(entry => (
        inlineTextItemPosition(entry.normalized, direction)
            > inlineTextItemPosition(candidate.normalized, direction)
    ));
    if (insertionIndex < 1
        || !candidateFillsExpectedGap(
            orderedVisible[insertionIndex - 1].normalized,
            candidate.normalized,
            orderedVisible[insertionIndex].normalized,
            direction,
            fontHeight
        )) {
        return values;
    }
    const left = orderedVisible[insertionIndex - 1];
    const right = orderedVisible[insertionIndex];
    const placeholders = entries.slice(left.index + 1, right.index);
    if (!placeholders.every(entry => isMisplacedWhitespacePlaceholder(
        entry.normalized,
        candidate.normalized,
        direction,
        fontHeight
    ))) {
        return values;
    }
    const placeholderSet = new Set(placeholders);
    const reordered = entries.filter(entry => (
        entry !== candidate && !placeholderSet.has(entry)
    ));
    const targetIndex = reordered.indexOf(right);
    reordered.splice(targetIndex, 0, candidate);
    return reordered.map((entry, index) => ({
        ...entry.value,
        hasEOL: hasEOL && index === reordered.length - 1,
    }));
}

function appendPDFTextItems(target, values) {
    for (const value of values) target.push(value);
}

function itemsShareVisualLine(items, direction, fontHeight) {
    const origin = items[0].transform;
    return items.every(item => {
        const itemDirection = textDirection(item.transform);
        if (!itemDirection || direction[0] * itemDirection[0]
            + direction[1] * itemDirection[1] < 0.995) {
            return false;
        }
        const deltaX = item.transform[4] - origin[4];
        const deltaY = item.transform[5] - origin[5];
        const across = Math.abs(
            -deltaX * direction[1] + deltaY * direction[0]
        );
        return across <= fontHeight * 0.5;
    });
}

function itemsFollowContinuousInlineOrder(entries, direction, fontHeight) {
    return entries.slice(1).every((entry, index) => {
        const previous = entries[index];
        const position = inlineTextItemPosition(entry.normalized, direction);
        const previousPosition = inlineTextItemPosition(
            previous.normalized,
            direction
        );
        return position >= previousPosition
            && position - previousPosition - previous.normalized.width
                <= fontHeight * 1.25;
    });
}

function candidateFillsExpectedGap(
    left,
    candidate,
    right,
    direction,
    fontHeight
) {
    if (isStandaloneLigature(candidate.text)) {
        return ligatureFillsWordGap(
            left,
            candidate,
            right,
            direction,
            fontHeight
        );
    }
    return numericPrefixFillsGap(
        left,
        candidate,
        right,
        direction,
        fontHeight
    );
}

function ligatureFillsWordGap(left, candidate, right, direction, fontHeight) {
    if (!isWordCharacter(left.text.at(-1))
        || !isWordCharacter(right.text[0])) {
        return false;
    }
    const metrics = inlineCandidateGapMetrics(
        left,
        candidate,
        right,
        direction,
        fontHeight
    );
    return Boolean(metrics
        && Math.abs(metrics.candidateStart - metrics.leftEnd)
            <= metrics.tolerance
        && Math.abs(metrics.rightStart - metrics.candidateEnd)
            <= metrics.tolerance);
}

function numericPrefixFillsGap(left, candidate, right, direction, fontHeight) {
    if (!isNumericPrefixSymbol(candidate.text)
        || !isWordCharacter(left.text.at(-1))
        || !/^\d$/u.test(right.text[0])) {
        return false;
    }
    const metrics = inlineCandidateGapMetrics(
        left,
        candidate,
        right,
        direction,
        fontHeight
    );
    return Boolean(metrics
        && metrics.candidateStart >= metrics.leftEnd
        && metrics.candidateStart - metrics.leftEnd <= metrics.tolerance
        && Math.abs(metrics.rightStart - metrics.candidateEnd)
            <= metrics.tolerance);
}

function inlineCandidateGapMetrics(
    left,
    candidate,
    right,
    direction,
    fontHeight
) {
    if (candidate.width <= 0) return null;
    const candidateStart = inlineTextItemPosition(candidate, direction);
    return {
        candidateEnd: candidateStart + candidate.width,
        candidateStart,
        leftEnd: inlineTextItemPosition(left, direction) + left.width,
        rightStart: inlineTextItemPosition(right, direction),
        tolerance: Math.max(1, fontHeight * 0.5),
    };
}

function inlineTextItemPosition(item, direction) {
    return item.transform[4] * direction[0]
        + item.transform[5] * direction[1];
}

function isMisplacedWhitespacePlaceholder(
    item,
    candidate,
    direction,
    fontHeight
) {
    return !item.text.trim()
        && item.width > fontHeight * 2
        && Math.abs(
            inlineTextItemPosition(item, direction)
                - inlineTextItemPosition(candidate, direction)
        ) <= fontHeight * 0.5;
}

function isStandaloneLigature(text) {
    return /^[\uFB00-\uFB06]$/u.test(text);
}

function isNumericPrefixSymbol(text) {
    return /^[§±<>≤≥]$/u.test(text);
}

function isMisplacedInlineCandidate(text) {
    return isStandaloneLigature(text) || isNumericPrefixSymbol(text);
}

function isWordCharacter(character) {
    return Boolean(character)
        && !isCJKCharacter(character)
        && /^[\p{L}\p{N}]$/u.test(character);
}

function maximumTextItemFontHeight(items) {
    let maximum = 0;
    for (const item of items) {
        maximum = Math.max(maximum, Math.hypot(
            item.transform[2],
            item.transform[3]
        ));
    }
    return maximum;
}

function shouldInsertTextItemSpace(previous, current) {
    if (!previous
        || previous.hasEOL
        || previous.direction !== 'ltr'
        || current.direction !== 'ltr'
        || !isSpacedWordEdge(previous.text.at(-1), current.text[0])) {
        return false;
    }
    const metrics = textItemSpacingMetrics(previous, current);
    if (!metrics) return false;
    if (previous.inlineNumericSuperscript
        && returnsFromInlineNumericSuperscript(metrics)) {
        return true;
    }
    return metrics.across <= metrics.fontHeight * 0.5
        && metrics.gap >= Math.max(1, metrics.fontHeight * 0.15)
        && metrics.gap <= metrics.fontHeight * 2;
}

function isInlineNumericSuperscript(previous, current) {
    const citationText = current?.text.trim();
    if (!previous
        || previous.hasEOL
        || previous.direction !== 'ltr'
        || current.direction !== 'ltr'
        || current.text.length > 512
        || !citationText
        || !isNumericCitationContent(citationText)
        || !/[\p{L}\p{N})\]}.!?]$/u.test(previous.text)
        || (isLikelyNumericSuperscriptExponent(
            previous.text,
            previous.text.length,
            citationText
        ) && !(endsWithShortProseWord(previous.text)
            && /\s$/u.test(current.text)))) {
        return false;
    }
    const metrics = textItemSpacingMetrics(previous, current);
    return Boolean(metrics
        && metrics.currentFontHeight <= metrics.previousFontHeight * 0.85
        && metrics.rise >= metrics.currentFontHeight * 0.2
        && metrics.rise <= metrics.previousFontHeight
        && metrics.gap >= -metrics.previousFontHeight * 0.25
        && metrics.gap <= metrics.previousFontHeight * 1.5);
}

function endsWithShortProseWord(text) {
    return /(?:^|\s)(?:as|at|by|in|is|of|on|or|to)$/iu.test(text);
}

function returnsFromInlineNumericSuperscript(metrics) {
    return metrics.currentFontHeight >= metrics.previousFontHeight * 1.15
        && metrics.rise <= -metrics.previousFontHeight * 0.2
        && metrics.rise >= -metrics.currentFontHeight
        && metrics.gap >= -metrics.currentFontHeight * 0.25
        && metrics.gap <= metrics.currentFontHeight * 1.5;
}

function textItemSpacingMetrics(previous, current) {
    const previousDirection = textDirection(previous.transform);
    const currentDirection = textDirection(current.transform);
    if (!previousDirection || !currentDirection) return null;
    const alignment = previousDirection[0] * currentDirection[0]
        + previousDirection[1] * currentDirection[1];
    if (alignment < 0.995) return null;
    const deltaX = current.transform[4] - previous.transform[4];
    const deltaY = current.transform[5] - previous.transform[5];
    const along = deltaX * previousDirection[0]
        + deltaY * previousDirection[1];
    const across = Math.abs(
        -deltaX * previousDirection[1]
        + deltaY * previousDirection[0]
    );
    const previousFontHeight = Math.hypot(
        previous.transform[2],
        previous.transform[3]
    );
    const currentFontHeight = Math.hypot(
        current.transform[2],
        current.transform[3]
    );
    if (!Number.isFinite(previousFontHeight)
        || previousFontHeight <= 0
        || !Number.isFinite(currentFontHeight)
        || currentFontHeight <= 0) {
        return null;
    }
    const fontHeight = Math.max(previousFontHeight, currentFontHeight);
    const rise = (deltaX * previous.transform[2]
        + deltaY * previous.transform[3]) / previousFontHeight;
    const gap = along - previous.width;
    return {
        across,
        currentFontHeight,
        fontHeight,
        gap,
        previousFontHeight,
        rise,
    };
}

function textDirection(transform) {
    const length = Math.hypot(transform[0], transform[1]);
    return Number.isFinite(length) && length > 0
        ? [transform[0] / length, transform[1] / length]
        : null;
}

function isSpacedWordEdge(previous, current) {
    if (!previous || !current
        || isCJKCharacter(previous)
        || isCJKCharacter(current)) {
        return false;
    }
    return /^[\p{L}\p{N}]$/u.test(previous)
        && (/^[\p{L}\p{N}]$/u.test(current)
            || /^[§±<>≤≥]$/u.test(current));
}

function isCJKCharacter(character) {
    return /^(?:\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul})$/u
        .test(character);
}

function normalizeTextItem(item, sourceFrom, sourceTo) {
    const transform = Array.from(item.transform || []);
    if (transform.length !== 6 || !transform.every(Number.isFinite)
        || !Number.isFinite(item.width)
        || !Number.isFinite(item.height)
        || item.width < 0
        || item.height < 0
        || typeof item.fontName !== 'string'
        || item.fontName.length > 512) {
        throw new Error('PDF text item geometry is invalid');
    }
    return {
        text: item.str,
        direction: item.dir === 'rtl' ? 'rtl' : 'ltr',
        width: item.width,
        height: item.height,
        transform,
        fontName: item.fontName,
        sourceFrom,
        sourceTo,
    };
}

function normalizeStyles(styles) {
    const normalized = {};
    for (const [fontName, style] of Object.entries(styles || {})) {
        if (fontName.length > 512) continue;
        normalized[fontName] = {
            fontFamily: typeof style?.fontFamily === 'string'
                ? style.fontFamily.slice(0, 512)
                : 'sans-serif',
            ascent: Number.isFinite(style?.ascent) ? style.ascent : null,
            descent: Number.isFinite(style?.descent) ? style.descent : null,
            vertical: style?.vertical === true,
        };
    }
    return normalized;
}

function normalizeViewport(viewport) {
    const transform = Array.from(viewport?.transform || []);
    if (transform.length !== 6
        || !transform.every(Number.isFinite)
        || !Number.isFinite(viewport?.width)
        || !Number.isFinite(viewport?.height)
        || viewport.width <= 0
        || viewport.height <= 0) {
        throw new Error('PDF viewport geometry is invalid');
    }
    return {
        transform,
        width: viewport.width,
        height: viewport.height,
    };
}

function normalizePageLabel(value, pageIndex) {
    const label = String(value || pageIndex + 1);
    return label.length <= 1_000 ? label : String(pageIndex + 1);
}

function validatePDFData(fileData) {
    if (!ArrayBuffer.isView(fileData)
        || fileData.BYTES_PER_ELEMENT !== 1
        || fileData.length !== fileData.byteLength
        || !fileData.length
        || fileData.length > MAX_PDF_BYTES) {
        throw new TypeError('PDF data is unavailable or exceeds the safety limit');
    }
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    if (signal.reason) throw signal.reason;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
}

function indexUnavailableError() {
    const error = new Error('PDF text index engine is unavailable');
    error.code = 'MKTERO_PDF_INDEX_UNAVAILABLE';
    return error;
}
