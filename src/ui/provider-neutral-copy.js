import { translateEnglish } from '../i18n/localization.js';
import { MKTERO_REQUEST_STAGES } from '../mktero/mktero-conversion-client.js';
import {
    HOSTED_MINERU_MAX_PAGES,
    PDF_PAGE_LIMIT_ERROR_CODE,
} from '../core/pdf-page-limit.js';
import {
    MARKDOWN_ANNOTATIONS_SET_ASIDE_WARNING,
} from '../core/markdown-local-annotations.js';

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
    ['MKTERO_ACCOUNT_DISABLED', 'error.mkteroAccountDisabled'],
    ['MKTERO_CONVERSION_FAILED', 'error.mkteroConversionFailed'],
    ['MKTERO_JOB_NOT_FOUND', 'error.mkteroJobUnavailable'],
    ['MKTERO_UNAVAILABLE', 'error.mkteroUnavailable'],
    ['MKTERO_UPLOAD_FAILED', 'error.mkteroUploadFailed'],
    ['MKTERO_DOWNLOAD_FAILED', 'error.mkteroDownloadFailed'],
    ['MKTERO_REQUEST_TIMEOUT', 'error.requestTimedOut'],
    ['MKTERO_PARSE_TIMEOUT', 'error.parsingTimedOut'],
    ['MKTERO_NETWORK_ERROR', 'error.networkFailed'],
    ['MKTERO_HTTP_ERROR', 'error.mkteroRequestFailed'],
    ['MKTERO_INVALID_RESPONSE', 'error.invalidResponse'],
    ['MKTERO_ARCHIVE_TOO_LARGE', 'error.resultTooLarge'],
    ['LLM_CACHE_DISABLED', 'importLLM.cacheRequired'],
    ['LLM_CACHE_BUSY', 'importLLM.busy'],
    ['LLM_CACHE_IMPORT_BUSY', 'importLLM.busy'],
    ['LLM_CACHE_CHANGED', 'importLLM.changed'],
    ['LLM_CACHE_WRITING', 'importLLM.writing'],
    ['LLM_CACHE_UNSAFE_PATH', 'importLLM.unsafePath'],
    ['LLM_CACHE_RESOURCE_LIMIT', 'importLLM.resourceLimit'],
    ['LLM_CACHE_UNSUPPORTED_BBOX', 'importLLM.unsupportedBBox'],
    ['LLM_CACHE_UNSUPPORTED_FORMAT', 'importLLM.unsupportedFormat'],
    ['LLM_CACHE_UNSUPPORTED_GEOMETRY', 'importLLM.unsupportedGeometry'],
    ['LLM_CACHE_MISSING_IMAGE', 'importLLM.missingImage'],
    ['LLM_CACHE_INVALID_IMAGE', 'importLLM.invalidImage'],
    ['LLM_CACHE_AMBIGUOUS_FIGURE', 'importLLM.ambiguousFigure'],
    ['LLM_CACHE_INVALID_CROP', 'importLLM.invalidCrop'],
    ['LLM_CACHE_INVALID_SOURCE', 'importLLM.invalidSource'],
    ['LLM_CACHE_UNSUPPORTED_SOURCE', 'importLLM.unsupportedSource'],
    ['LLM_CACHE_ATTACHMENT_MISMATCH', 'importLLM.attachmentMismatch'],
    ['LLM_CACHE_PAGE_MISMATCH', 'importLLM.pageMismatch'],
    ['LLM_CACHE_IMPORT_INDEX_INVALID', 'importLLM.indexInvalid'],
    ['LLM_CACHE_IMPORT_INDEX_UNSUPPORTED', 'importLLM.indexUnsupported'],
    ['LLM_CACHE_IMPORT_INDEX_FULL', 'importLLM.indexFull'],
    ['LLM_CACHE_IMPORT_INDEX_WRITE_FAILED', 'importLLM.storageFailed'],
    ['LLM_CACHE_STORAGE_FAILED', 'importLLM.storageFailed'],
    ['LLM_CACHE_NO_DATA_DIRECTORY', 'importLLM.dataDirectoryUnavailable'],
    ['LLM_CACHE_NOT_FOUND', 'importLLM.unavailable'],
    ['LLM_CACHE_UNAVAILABLE', 'importLLM.localUnavailable'],
    ['LLM_CACHE_IMPORT_UNAVAILABLE', 'importLLM.importUnavailable'],
    ['LLM_CACHE_INVALID_ATTACHMENT', 'importLLM.invalidAttachment'],
    ['LLM_CACHE_INVALID_DOCUMENT', 'importLLM.invalidDocument'],
    ['LLM_CACHE_INVALID_JSON', 'importLLM.invalidJSON'],
    ['LLM_CACHE_INVALID_FILE', 'importLLM.invalidFile'],
    ['LLM_CACHE_INVALID_MANIFEST', 'importLLM.invalidManifest'],
    ['LLM_CACHE_INVALID_MARKDOWN', 'importLLM.invalidMarkdown'],
    ['LLM_CACHE_MISSING_MARKDOWN', 'importLLM.missingMarkdown'],
    ['LLM_CACHE_EMPTY', 'importLLM.empty'],
    ['LLM_CACHE_AMBIGUOUS_STRUCTURE', 'importLLM.ambiguousStructure'],
    ['LLM_CACHE_INVALID_STRUCTURE', 'importLLM.invalidStructure'],
]);

export const MARKDOWN_REVISION_WARNINGS = Object.freeze({
    discarded: 'Saved corrections for this document could not be read, so the original recognition result is shown. Your next saved correction replaces them.',
    unavailable: 'Saved corrections could not be read, so the original recognition result is shown. Corrections are unavailable until the document is reopened.',
});

const WARNING_MESSAGE_KEYS = new Map([
    ['LLM_CACHE_SOURCE_MISSING', 'importLLM.warningSourceMissing'],
    ['LLM_CACHE_SOURCE_LEGACY', 'importLLM.warningSourceLegacy'],
    ['LLM_CACHE_SOURCE_INCOMPLETE', 'importLLM.warningSourceIncomplete'],
    ['LLM_CACHE_CROPS_STALE', 'importLLM.warningCropsStale'],
    ['LLM_CACHE_IMPORTED_CROPS', 'importLLM.warningImportedCrops'],
    ['LLM_CACHE_LOCAL_CROPS', 'importLLM.warningLocalCrops'],
    [MARKDOWN_REVISION_WARNINGS.discarded, 'warning.correctionsDiscarded'],
    [MARKDOWN_REVISION_WARNINGS.unavailable, 'warning.correctionsUnavailable'],
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
        MARKDOWN_ANNOTATIONS_SET_ASIDE_WARNING,
        'warning.localAnnotationsSetAside',
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

// An upload talks to storage, not to the account API. Tell the user whether
// to retry or to check the network. Do not mention bucket policy or CORS;
// those are not something the user can change.
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

// The local check knows the page count. A hosted job the service rejected
// for its page count (a PDF the local check could not read) knows only the
// limit.
const SERVICE_PAGE_LIMIT_CODE = 'MINERU_PAGE_LIMIT_EXCEEDED';

function pageLimitMessage(error, translate) {
    if (error?.code === PDF_PAGE_LIMIT_ERROR_CODE) {
        const limit = positiveInteger(error.limit) ?? HOSTED_MINERU_MAX_PAGES;
        const pages = positiveInteger(error.pages);
        return pages
            ? translate('error.pageLimitExceeded', { pages, limit })
            : translate('error.servicePageLimitExceeded', { limit });
    }
    if (error?.errorCode === SERVICE_PAGE_LIMIT_CODE) {
        return translate('error.servicePageLimitExceeded', {
            limit: HOSTED_MINERU_MAX_PAGES,
        });
    }
    return null;
}

function positiveInteger(value) {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function localizeConversionError(error, translate = translateEnglish) {
    if (typeof error?.code === 'string' && error.code.startsWith('LLM_CACHE_')) {
        return translate(ERROR_CODE_KEYS.get(error.code) || 'importLLM.failed');
    }
    const message = error instanceof Error ? error.message : String(error || '');
    if (/no extractable text/i.test(message)) {
        return translate('error.noExtractableText');
    }

    const pageLimit = pageLimitMessage(error, translate);
    if (pageLimit) return pageLimit;

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
