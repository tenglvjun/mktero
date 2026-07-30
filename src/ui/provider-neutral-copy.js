import { translateEnglish } from '../i18n/localization.js';

const ERROR_MESSAGE_KEYS = new Map([
    ['Only PDF attachments can be converted', 'error.onlyPdf'],
    ['The local PDF file is unavailable', 'error.localPdfUnavailable'],
    [
        'PDF text extraction is unavailable in this Zotero version',
        'error.textExtractionUnavailable',
    ],
    ['A MinerU API Token is required', 'error.apiTokenMissing'],
    ['MinerU did not return a file upload URL', 'error.uploadUnavailable'],
    ['MinerU returned an empty Markdown document', 'error.emptyMarkdown'],
    ['MinerU completed without a result archive', 'error.resultMissing'],
    ['MinerU parsing timed out', 'error.parsingTimedOut'],
]);

const ERROR_CODE_KEYS = new Map([
    ['MINERU_API_KEY_INVALID', 'error.apiTokenInvalid'],
    ['MINERU_REQUEST_TIMEOUT', 'error.requestTimedOut'],
    ['MINERU_NETWORK_ERROR', 'error.networkFailed'],
    ['MINERU_HTTP_ERROR', 'error.requestFailed'],
    ['MINERU_API_ERROR', 'error.requestFailed'],
    ['MINERU_TRANSIENT_API_ERROR', 'error.requestFailed'],
    ['MINERU_INVALID_RESPONSE', 'error.invalidResponse'],
    ['MINERU_ARCHIVE_TOO_LARGE', 'error.resultTooLarge'],
]);

const WARNING_MESSAGE_KEYS = new Map([
    [
        'The local Markdown cache is unavailable.',
        'warning.cacheUnavailable',
    ],
    [
        'The local Markdown cache could not be read.',
        'warning.cacheReadFailed',
    ],
    [
        'The Markdown result could not be saved to the local cache.',
        'warning.cacheSaveFailed',
    ],
    [
        'Zotero PDF annotations could not be loaded.',
        'warning.annotationsUnavailable',
    ],
    [
        'Local Markdown annotations could not be loaded.',
        'warning.localAnnotationsUnavailable',
    ],
    [
        'Some local Markdown annotations could not be synchronized to the PDF.',
        'warning.localAnnotationsSyncFailed',
    ],
]);

export function removeProviderBranding(message) {
    return String(message || '').replace(/\bMinerU\b/gi, 'PDF conversion service');
}

export function localizeConversionError(error, translate = translateEnglish) {
    const message = error instanceof Error ? error.message : String(error || '');
    if (/no extractable text/i.test(message)) {
        return translate('error.noExtractableText');
    }

    const messageKey = ERROR_MESSAGE_KEYS.get(message);
    if (messageKey) return translate(messageKey);

    const codeKey = ERROR_CODE_KEYS.get(error?.code);
    if (codeKey) return translate(codeKey);

    const parsingFailure = /^MinerU parsing failed:\s*(.+)$/i.exec(message);
    if (parsingFailure) {
        return translate('error.parsingFailed', { message: parsingFailure[1] });
    }
    if (/^(?:Unable to extract MinerU result|full\.md exceeds|MinerU image )/i
        .test(message)
        || /result archive does not contain full\.md/i.test(message)) {
        return translate('error.resultInvalid');
    }
    return translate('error.conversionFailed');
}

export function localizeConversionResult(result, translate = translateEnglish) {
    return {
        ...result,
        title: result.title === 'Untitled PDF'
            ? translate('document.untitled')
            : result.title,
        warnings: (result.warnings || []).map(warning => translate(
            WARNING_MESSAGE_KEYS.get(warning) || 'warning.conversionIssue'
        )),
    };
}
