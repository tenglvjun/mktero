export const MISTRAL_OCR_MODEL_ID = 'mistral-ocr-4-1';

export const MISTRAL_OCR_REQUEST_OPTIONS = Object.freeze({
    include_blocks: true,
    include_image_base64: true,
    table_format: 'markdown',
});

// Keep every behavior that affects the extracted document in the cache identity.
export const MISTRAL_PARSER_PROFILE_ID = JSON.stringify({
    provider: 'mistral',
    model: MISTRAL_OCR_MODEL_ID,
    request: MISTRAL_OCR_REQUEST_OPTIONS,
    headerFooter: 'separate-v1',
    resultAdapter: 'mistral-ocr-result-v4',
    sourceMap: 'pixel-bbox-0-1000-v1',
});
