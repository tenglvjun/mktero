// MinerU's precision API accepts at most 200 pages per file. The MinerU cloud
// provider and the hosted Mktero service both submit to it; a local MinerU
// service and Mistral OCR have their own limits and are not checked here.
export const HOSTED_MINERU_MAX_PAGES = 200;

export const PDF_PAGE_LIMIT_ERROR_CODE = 'PDF_PAGE_LIMIT_EXCEEDED';

export class PDFPageLimitError extends Error {
    constructor(pages, limit) {
        super(`The PDF has ${pages} pages; the conversion service accepts at most ${limit}`);
        this.name = 'PDFPageLimitError';
        this.code = PDF_PAGE_LIMIT_ERROR_CODE;
        this.pages = pages;
        this.limit = limit;
    }
}

/**
 * Returns a check that runs before a PDF is sent for conversion.
 *
 * The check only gives early feedback; it is not a security boundary. When
 * the page count cannot be read (an encrypted or damaged PDF, or no PDF.js),
 * the PDF is let through and the service decides.
 */
export function createPDFPageLimitGuard({
    countPages,
    maxPages = HOSTED_MINERU_MAX_PAGES,
    onError = () => {},
} = {}) {
    if (typeof countPages !== 'function') {
        throw new TypeError('A PDF page counter is required');
    }
    if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
        throw new TypeError('A positive PDF page limit is required');
    }
    return async function assertPDFPageLimit(fileData, { signal } = {}) {
        throwIfAborted(signal);
        let pages;
        try {
            pages = await countPages(fileData, { signal });
        }
        catch (error) {
            throwIfAborted(signal);
            if (error?.name === 'AbortError') throw error;
            reportError(onError, error);
            return;
        }
        throwIfAborted(signal);
        if (Number.isSafeInteger(pages) && pages > maxPages) {
            throw new PDFPageLimitError(pages, maxPages);
        }
    };
}

function reportError(onError, error) {
    try {
        onError(error);
    }
    catch {
        // Page-count diagnostics must not stop the conversion.
    }
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    if (signal.reason) throw signal.reason;
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
}
