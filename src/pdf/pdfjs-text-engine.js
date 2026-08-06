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

const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_PAGES = 10_000;
const MAX_PAGE_TEXT_LENGTH = 1_000_000;
const MAX_TOTAL_TEXT_LENGTH = 10_000_000;
const MAX_TEXT_ITEMS = 250_000;

export const PDF_TEXT_INDEX_PROFILE = `pdfjs-${PDFJS_VERSION}|text-v3`;

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
                    const indexed = indexPageText(content);
                    totalTextLength += indexed.rawText.length;
                    totalItems += indexed.items.length;
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
                return {
                    profile: PDF_TEXT_INDEX_PROFILE,
                    pages,
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
    for (const value of content?.items || []) {
        if (typeof value?.str !== 'string') continue;
        const text = value.str;
        const normalized = normalizeTextItem(value, 0, 0);
        if (shouldInsertTextItemSpace(previous, normalized)) {
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
        };
    }
    const rawText = source.join('');
    return {
        rawText,
        normalizedText: createDehyphenatedPdfAnnotationTextIndex(rawText).text,
        items,
    };
}

function shouldInsertTextItemSpace(previous, current) {
    if (!previous
        || previous.hasEOL
        || previous.direction !== 'ltr'
        || current.direction !== 'ltr'
        || !isSpacedWordEdge(previous.text.at(-1), current.text[0])) {
        return false;
    }
    const previousDirection = textDirection(previous.transform);
    const currentDirection = textDirection(current.transform);
    if (!previousDirection || !currentDirection) return false;
    const alignment = previousDirection[0] * currentDirection[0]
        + previousDirection[1] * currentDirection[1];
    if (alignment < 0.995) return false;
    const deltaX = current.transform[4] - previous.transform[4];
    const deltaY = current.transform[5] - previous.transform[5];
    const along = deltaX * previousDirection[0]
        + deltaY * previousDirection[1];
    const across = Math.abs(
        -deltaX * previousDirection[1]
        + deltaY * previousDirection[0]
    );
    const fontHeight = Math.max(
        Math.hypot(previous.transform[2], previous.transform[3]),
        Math.hypot(current.transform[2], current.transform[3])
    );
    const gap = along - previous.width;
    return Number.isFinite(fontHeight)
        && fontHeight > 0
        && across <= fontHeight * 0.5
        && gap >= Math.max(1, fontHeight * 0.15)
        && gap <= fontHeight * 2;
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
        && /^[\p{L}\p{N}]$/u.test(current);
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
