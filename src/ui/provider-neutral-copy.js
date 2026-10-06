import { translateEnglish } from '../i18n/localization.js';
import { MKTERO_REQUEST_STAGES } from '../mktero/mktero-conversion-client.js';

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
    ['Sign in to Mktero before converting', 'error.mkteroSignInRequired'],
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
    ['MINERU_TASK_NOT_FOUND', 'error.taskUnavailable'],
    ['MINERU_LOCAL_ENDPOINT_INVALID', 'error.localEndpointInvalid'],
    ['MINERU_LOCAL_TIER_UNAVAILABLE', 'error.localTierUnavailable'],
    ['MINERU_LOCAL_API_KEY_INVALID', 'error.apiTokenInvalid'],
    ['MINERU_LOCAL_REQUEST_TIMEOUT', 'error.requestTimedOut'],
    ['MINERU_LOCAL_PARSE_TIMEOUT', 'error.parsingTimedOut'],
    ['MINERU_LOCAL_NETWORK_ERROR', 'error.networkFailed'],
    ['MINERU_LOCAL_HTTP_ERROR', 'error.requestFailed'],
    ['MINERU_LOCAL_INVALID_RESPONSE', 'error.invalidResponse'],
    ['MINERU_LOCAL_URL_REJECTED', 'error.invalidResponse'],
    ['MINERU_LOCAL_UPLOAD_UNAVAILABLE', 'error.uploadUnavailable'],
    ['MINERU_LOCAL_FILE_TOO_LARGE', 'error.resultTooLarge'],
    ['MINERU_LOCAL_ARCHIVE_TOO_LARGE', 'error.resultTooLarge'],
    ['MINERU_LOCAL_RESULT_MISSING', 'error.resultMissing'],
    ['MINERU_LOCAL_EMPTY_RESULT', 'error.emptyMarkdown'],
    ['MINERU_LOCAL_INVALID_RESULT', 'error.resultInvalid'],
    ['MINERU_LOCAL_PARSE_FAILED', 'error.localParseFailed'],
    ['MKTERO_SAVED_NOTE_CONFLICT', 'error.snapshotConflict'],
    ['MISTRAL_API_KEY_REQUIRED', 'error.apiTokenMissing'],
    ['MISTRAL_API_KEY_INVALID', 'error.apiTokenInvalid'],
    ['MISTRAL_REQUEST_TIMEOUT', 'error.requestTimedOut'],
    ['MISTRAL_NETWORK_ERROR', 'error.networkFailed'],
    ['MISTRAL_HTTP_ERROR', 'error.requestFailed'],
    ['MISTRAL_INVALID_RESPONSE', 'error.invalidResponse'],
    ['MISTRAL_INVALID_RESULT', 'error.resultInvalid'],
    ['MISTRAL_INPUT_TOO_LARGE', 'error.resultTooLarge'],
    ['MISTRAL_RESPONSE_TOO_LARGE', 'error.resultTooLarge'],
    ['MKTERO_SIGN_IN_REQUIRED', 'error.mkteroSignInRequired'],
    ['MKTERO_CONVERSION_FAILED', 'error.mkteroConversionFailed'],
    ['MKTERO_JOB_NOT_FOUND', 'error.mkteroJobUnavailable'],
    ['MKTERO_UNAVAILABLE', 'error.mkteroUnavailable'],
    ['MKTERO_UPLOAD_FAILED', 'error.mkteroUploadFailed'],
    ['MKTERO_DOWNLOAD_FAILED', 'error.mkteroDownloadFailed'],
    ['MKTERO_REQUEST_TIMEOUT', 'error.requestTimedOut'],
    ['MKTERO_PARSE_TIMEOUT', 'error.parsingTimedOut'],
    ['MKTERO_NETWORK_ERROR', 'error.networkFailed'],
    ['MKTERO_HTTP_ERROR', 'error.requestFailed'],
    ['MKTERO_INVALID_RESPONSE', 'error.invalidResponse'],
    ['MKTERO_ARCHIVE_TOO_LARGE', 'error.resultTooLarge'],
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
    [
        'The synced Markdown source is unavailable; showing the HTML snapshot.',
        'warning.syncedMarkdownUnavailable',
    ],
    [
        'Some synced Markdown images are unavailable.',
        'warning.syncedImagesUnavailable',
    ],
    [
        'The Zotero snapshot was modified outside Mktero.',
        'warning.snapshotModified',
    ],
]);

export function removeProviderBranding(message) {
    return String(message || '').replace(/\bMinerU\b/gi, 'PDF conversion service');
}

// A failed upload or download leg means the request never reached the API, so
// the generic "could not be reached" copy is misleading: the object store
// answered. Report the more specific cause when the client tagged the stage.
function stageMessageKey(error) {
    if (error?.code === 'MKTERO_NETWORK_ERROR') {
        return error.stage === MKTERO_REQUEST_STAGES.UPLOAD
            ? 'error.mkteroUploadUnreachable'
            : null;
    }
    if (error?.code === 'MKTERO_UPLOAD_FAILED') {
        return 'error.mkteroUploadRejected';
    }
    return null;
}

export function localizeConversionError(error, translate = translateEnglish) {
    const message = error instanceof Error ? error.message : String(error || '');
    if (/no extractable text/i.test(message)) {
        return translate('error.noExtractableText');
    }

    const messageKey = ERROR_MESSAGE_KEYS.get(message);
    if (messageKey) return translate(messageKey);

    const stageKey = stageMessageKey(error);
    if (stageKey) return translate(stageKey);

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
